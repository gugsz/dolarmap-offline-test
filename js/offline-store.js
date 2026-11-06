import { OfflineDatabase } from './offline-db.js?v=20261106offline4';
import { ApiError } from './supabase.js?v=20261106offline4';

const FIELDS = ['kind', 'amount_cents', 'currency', 'brl_cents', 'category', 'note', 'occurred_on'];
const valuesOf = (row) => Object.fromEntries(FIELDS.map((key) => [key, row[key] ?? null]));
const sameValues = (a, b) => FIELDS.every((key) => (a[key] ?? null) === (b[key] ?? null));
const temporary = (e) => e.code === 'network' || e.code === 'request_timeout'
  || [408, 409, 429].includes(e.status) || e.status >= 500;
const mergeRows = (account) => {
  const rows = new Map(account.rows.map((row) => [row.id, row]));
  for (const pending of account.pending) rows.set(pending.row.id, { ...pending.row, pending: true });
  return [...rows.values()];
};

export class OfflineStore {
  mode = 'cloud';
  requiresPassword = true;

  constructor(cloud, { database, online } = {}) {
    this.cloud = cloud;
    const scope = new URL('../', import.meta.url).pathname;
    this.db = database || new OfflineDatabase(`dolarmap.offline.v1:${cloud.api.url}:${scope}`);
    this.online = online || (() => globalThis.navigator?.onLine !== false);
    this.user = null;
    this.syncing = null;
    this.onStatusChange = null;
    this.status = { pending: 0, syncing: false, offline: !this.online(), error: '', lastSync: null, cached: false };
  }

  async notify(account) {
    if (!this.user) return;
    account ||= await this.db.read(this.user.id);
    this.status = {
      ...this.status, pending: account.pending.length, lastSync: account.lastSync,
      cached: account.initialized,
    };
    this.onStatusChange?.(this.status);
  }

  requireUser() {
    if (!this.user) throw new ApiError('Entre na sua conta para continuar.', { status: 401, code: 'session_expired' });
    return this.user;
  }

  async restoreSession() {
    this.user = await this.cloud.restoreSession();
    if (this.user) {
      // Uma falha no IndexedDB deve aparecer na tela de dados, sem apagar o login.
      try { await this.notify(); } catch (e) { this.status.error = e.message; }
    }
    return this.user;
  }

  async signIn(username, password) {
    if (!this.online()) throw new ApiError('Para entrar na conta pela primeira vez, conecte-se à internet.');
    this.user = await this.cloud.signIn(username, password);
    this.status.error = '';
    return this.user;
  }

  async signOut() {
    if (this.syncing) await this.syncing.catch(() => {});
    await this.cloud.signOut();
    this.user = null;
    // Não apagar pendências: só a mesma conta poderá recuperá-las e enviá-las.
    this.status = { pending: 0, syncing: false, offline: !this.online(), error: '', lastSync: null, cached: false };
  }

  async list() {
    const user = this.requireUser();
    if (this.online()) await this.sync();
    else this.status.offline = true;
    const account = await this.db.read(user.id);
    await this.notify(account);
    return mergeRows(account);
  }

  async create(value) {
    const user = this.requireUser();
    const row = {
      ...valuesOf(value), id: crypto.randomUUID(), user_id: user.id,
      author: user.username, created_at: new Date().toISOString(),
    };
    const account = await this.db.change(user.id, (data) => {
      data.pending.push({ row, attempted: false, error: '' });
    });
    await this.notify(account);
    return { ...row, pending: true };
  }

  async update(id, value) {
    const user = this.requireUser();
    let local = false;
    let result;
    const account = await this.db.change(user.id, (data) => {
      const pending = data.pending.find((item) => item.row.id === id);
      if (!pending) return;
      if (pending.attempted) throw new ApiError('Sincronize este registro antes de editá-lo: um envio anterior ainda precisa ser confirmado.');
      pending.row = { ...pending.row, ...valuesOf(value) };
      pending.error = '';
      local = true;
      result = { ...pending.row, pending: true };
    });
    if (local) { await this.notify(account); return result; }
    if (!this.online()) throw new ApiError('Conecte-se à internet para editar um registro já sincronizado. Novos lançamentos podem ser feitos offline.');
    const row = await this.cloud.update(id, value);
    await this.notify(await this.db.change(user.id, (data) => {
      data.rows = data.rows.filter((item) => item.id !== id).concat(row);
    }));
    return row;
  }

  async remove(id) {
    const user = this.requireUser();
    let local = false;
    const account = await this.db.change(user.id, (data) => {
      const pending = data.pending.find((item) => item.row.id === id);
      if (!pending) return;
      if (pending.attempted) throw new ApiError('Sincronize este registro antes de apagá-lo: um envio anterior ainda precisa ser confirmado.');
      data.pending = data.pending.filter((item) => item.row.id !== id);
      local = true;
    });
    if (local) { await this.notify(account); return; }
    if (!this.online()) throw new ApiError('Conecte-se à internet para apagar um registro já sincronizado.');
    await this.cloud.remove(id);
    await this.notify(await this.db.change(user.id, (data) => {
      data.rows = data.rows.filter((item) => item.id !== id);
    }));
  }

  async sync() {
    if (this.syncing) return this.syncing;
    const user = this.requireUser();
    const execute = () => this.syncAccount(user);
    this.syncing = (globalThis.navigator?.locks
      ? navigator.locks.request(`dolarmap-sync:${this.db.name}:${user.id}`, execute)
      : execute()).finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async syncAccount(user) {
    if (!this.online()) { this.status.offline = true; await this.notify(); return; }
    this.status.syncing = true;
    this.status.error = '';
    await this.notify();
    try {
      // O snapshot é relido depois de obter o lock entre abas. Novos lançamentos ficam para a próxima passagem.
      const account = await this.db.read(user.id);
      for (const entry of account.pending) {
        if (!this.online()) break;
        let sent;
        await this.db.change(user.id, (data) => {
          const item = data.pending.find((candidate) => candidate.row.id === entry.row.id);
          if (item) { item.attempted = true; sent = { ...item.row }; }
        });
        if (!sent) continue;
        try {
          let confirmed;
          try {
            confirmed = await this.cloud.create(sent, { id: sent.id });
          } catch (e) {
            // Se o servidor salvou e a resposta se perdeu, o mesmo UUID evita uma segunda inserção.
            if (e.code !== '23505' && e.status !== 409) throw e;
            confirmed = await this.cloud.findTransaction(sent.id);
            if (!confirmed || confirmed.user_id !== user.id || !sameValues(confirmed, sent)) {
              throw new ApiError('O registro já existe no servidor com outros dados. A cópia pendente foi preservada.');
            }
          }
          if (!confirmed || confirmed.id !== sent.id || confirmed.user_id !== user.id) {
            throw new ApiError('O envio não pôde ser confirmado. O lançamento continua salvo neste aparelho.');
          }
          await this.db.change(user.id, (data) => {
            data.rows = data.rows.filter((row) => row.id !== confirmed.id).concat(confirmed);
            data.pending = data.pending.filter((item) => item.row.id !== confirmed.id);
          });
        } catch (e) {
          await this.db.change(user.id, (data) => {
            const item = data.pending.find((candidate) => candidate.row.id === sent.id);
            if (item) {
              item.error = e.message;
              // Uma rejeição explícita de validação permite corrigir o lançamento local.
              if ([400, 422].includes(e.status) && e.code !== 'request_timeout') item.attempted = false;
            }
          });
          if (e.code === 'session_expired' || e.status === 401 || temporary(e)) throw e;
          this.status.error = `Há um lançamento que não pôde ser enviado: ${e.message}`;
        }
      }
      if (!this.online()) { this.status.offline = true; return; }
      const rows = await this.cloud.list();
      await this.db.change(user.id, (data) => {
        data.rows = rows;
        data.lastSync = new Date().toISOString();
        data.initialized = true;
      });
      this.status.offline = false;
    } catch (e) {
      if (e.code === 'session_expired' || e.status === 401) throw e;
      this.status.offline = temporary(e) || !this.online();
      this.status.error = this.status.offline
        ? 'Sem conexão com o servidor. Seus lançamentos ficam salvos neste aparelho.'
        : e.message;
    } finally {
      this.status.syncing = false;
      await this.notify();
    }
  }

  // Cartinhas e alterações de foto seguem online; o cache de fotos existente continua disponível.
  onlineOnly(method, ...args) {
    if (!this.online()) return Promise.reject(new ApiError('Esta ação precisa de internet. Os lançamentos financeiros funcionam offline.'));
    return this.cloud[method](...args);
  }
  listProfiles(...args) { return this.onlineOnly('listProfiles', ...args); }
  saveAvatar(...args) { return this.onlineOnly('saveAvatar', ...args); }
  sendNote(...args) { return this.onlineOnly('sendNote', ...args); }
  inbox(...args) { return this.onlineOnly('inbox', ...args); }
  sentNotes(...args) { return this.onlineOnly('sentNotes', ...args); }
  markNoteOpened(...args) { return this.onlineOnly('markNoteOpened', ...args); }
}
