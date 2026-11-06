// Banco local por projeto e instalação. Uma transação grava o lançamento e a fila juntos.
export class OfflineDatabase {
  constructor(name) {
    this.name = name;
    this.opening = null;
  }

  async open() {
    if (!globalThis.indexedDB) throw new Error('Este navegador não permite salvar dados offline.');
    this.opening ||= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('accounts');
      request.onerror = () => reject(new Error('Não foi possível abrir o armazenamento offline do aparelho.'));
      request.onblocked = () => reject(new Error('Feche outras abas deste aplicativo e tente novamente.'));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); this.opening = null; };
        resolve(db);
      };
    }).catch((e) => { this.opening = null; throw e; });
    return this.opening;
  }

  async read(userId) {
    return this.transaction(userId);
  }

  async change(userId, update) {
    return this.transaction(userId, update);
  }

  async transaction(userId, update) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('accounts', update ? 'readwrite' : 'readonly');
      const store = tx.objectStore('accounts');
      const request = store.get(userId);
      let account;
      let failure;
      request.onsuccess = () => {
        account = request.result || { rows: [], pending: [], lastSync: null, initialized: false };
        if (!update) return;
        try {
          update(account); // Deve ser síncrono: não manter uma transação IDB aberta durante fetch.
          store.put(account, userId);
        } catch (e) {
          failure = e;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(account);
      tx.onabort = tx.onerror = () => reject(failure || new Error('Não foi possível salvar no aparelho. Verifique o espaço disponível e tente novamente.'));
    });
  }
}
