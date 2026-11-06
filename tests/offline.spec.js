import { test, assert } from './harness.js';
import { OfflineDatabase } from '../js/offline-db.js?v=20261106offline2';
import { OfflineStore } from '../js/offline-store.js?v=20261106offline2';
import { ApiError } from '../js/supabase.js?v=20261106offline2';

const user = { id: 'offline-test-u1', username: 'gustavo', name: 'Gustavo' };
const other = { id: 'offline-test-u2', username: 'manuela', name: 'Manuela' };
const draft = { kind: 'expense', amount_cents: 1200, currency: 'USD', brl_cents: null, category: 'alimentacao', note: 'Almoço offline', occurred_on: '2026-11-06' };
const networkError = () => new ApiError('Sem conexão', { code: 'network' });
const clone = (value) => structuredClone(value);

function fixture() {
  let online = false;
  const db = new OfflineDatabase(`dolarmap-test-${crypto.randomUUID()}`);
  const cloud = {
    api: { url: 'https://offline-test.supabase.co' },
    user, rows: [], creates: 0, listCalls: 0, rejectCreate: null, loseResponse: false,
    async restoreSession() { return this.user; },
    async signIn() { return this.user; },
    async signOut() {},
    async list() { this.listCalls++; return clone(this.rows); },
    async create(value, { id }) {
      this.creates++;
      if (this.rejectCreate) throw this.rejectCreate;
      if (this.rows.some((row) => row.id === id)) throw new ApiError('Duplicado', { status: 409, code: '23505' });
      const row = { ...clone(value), id, user_id: this.user.id, author: this.user.username };
      this.rows.push(row);
      if (this.loseResponse) { this.loseResponse = false; throw networkError(); }
      return clone(row);
    },
    async findTransaction(id) { return clone(this.rows.find((row) => row.id === id) || null); },
    async update() { throw new Error('Não deveria editar remotamente neste teste'); },
    async remove() { throw new Error('Não deveria apagar remotamente neste teste'); },
  };
  const makeStore = () => { const store = new OfflineStore(cloud, { database: db, online: () => online }); store.user = cloud.user; return store; };
  const store = makeStore();
  return {
    db, cloud, store, makeStore, connect: () => { online = true; }, disconnect: () => { online = false; },
    async close() {
      const database = await db.open();
      database.close();
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(db.name);
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
      });
    },
  };
}

function offlineTest(name, fn) {
  test(`Offline: ${name}`, async () => {
    const f = fixture();
    try { await fn(f); } finally { await f.close(); }
  });
}

offlineTest('grava no IndexedDB antes de confirmar o lançamento e restaura ao reabrir', async (f) => {
  const row = await f.store.create(draft);
  assert.equal(row.pending, true);
  assert.equal(f.cloud.creates, 0);
  const reopened = f.makeStore();
  assert.equal((await reopened.restoreSession()).id, user.id);
  const rows = await reopened.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, row.id);
  assert.equal(rows[0].amount_cents, 1200);
});

offlineTest('baixa o extrato e consulta a cópia com internet desligada', async (f) => {
  f.cloud.rows = [{ ...draft, id: 'server-1', user_id: other.id, author: 'manuela' }];
  f.connect();
  assert.equal((await f.store.list()).length, 1);
  f.disconnect();
  const rows = await f.makeStore().list();
  assert.equal(rows[0].id, 'server-1');
  assert.equal(f.cloud.listCalls, 1);
});

offlineTest('envia com UUID fixo, remove a pendência e não duplica na próxima sincronização', async (f) => {
  const row = await f.store.create(draft);
  f.connect();
  await f.store.sync();
  await f.store.sync();
  assert.equal(f.cloud.rows.length, 1);
  assert.equal(f.cloud.rows[0].id, row.id);
  assert.equal(f.cloud.creates, 1);
  assert.equal((await f.db.read(user.id)).pending.length, 0);
  assert.equal((await f.store.list())[0].pending, undefined);
});

offlineTest('resposta perdida depois de gravar no servidor é reconciliada sem duplicação', async (f) => {
  await f.store.create(draft);
  f.connect();
  f.cloud.loseResponse = true;
  await f.store.sync();
  assert.equal(f.cloud.rows.length, 1);
  assert.equal((await f.db.read(user.id)).pending.length, 1);
  await f.makeStore().sync();
  assert.equal(f.cloud.rows.length, 1);
  assert.equal((await f.db.read(user.id)).pending.length, 0);
});

offlineTest('não descarta uma pendência se o mesmo UUID existir com outros dados', async (f) => {
  const row = await f.store.create(draft);
  f.cloud.rows.push({ ...row, amount_cents: 9999 });
  f.connect();
  await f.store.sync();
  assert.equal((await f.db.read(user.id)).pending.length, 1);
  assert.ok(f.store.status.error.includes('outros dados'));
  assert.equal((await f.store.list()).find((item) => item.id === row.id).amount_cents, 1200);
});

offlineTest('edição e cancelamento de um lançamento ainda não enviado funcionam sem internet', async (f) => {
  const row = await f.store.create(draft);
  const edited = await f.store.update(row.id, { ...draft, amount_cents: 1500 });
  assert.equal(edited.amount_cents, 1500);
  assert.equal((await f.store.list())[0].amount_cents, 1500);
  await f.store.remove(row.id);
  assert.equal((await f.store.list()).length, 0);
  assert.equal(f.cloud.creates, 0);
});

offlineTest('um envio com resultado incerto precisa ser confirmado antes de editar ou apagar', async (f) => {
  const row = await f.store.create(draft);
  f.connect();
  f.cloud.rejectCreate = networkError();
  await f.store.sync();
  f.disconnect();
  await assert.rejects(f.store.update(row.id, draft), (e) => assert.ok(e.message.includes('confirmado')));
  await assert.rejects(f.store.remove(row.id), (e) => assert.ok(e.message.includes('confirmado')));
  assert.equal((await f.db.read(user.id)).pending.length, 1);
});

offlineTest('rejeição de validação preserva o registro e permite corrigir e reenviar', async (f) => {
  const row = await f.store.create(draft);
  f.cloud.rejectCreate = new ApiError('Valor inválido', { status: 400, code: '23514' });
  f.connect();
  await f.store.sync();
  assert.equal(f.store.status.pending, 1);
  await f.store.update(row.id, { ...draft, amount_cents: 1300 });
  f.cloud.rejectCreate = null;
  await f.store.sync();
  assert.equal(f.cloud.rows[0].amount_cents, 1300);
  assert.equal(f.store.status.pending, 0);
});

offlineTest('falha de autenticação preserva a fila para novo login da mesma conta', async (f) => {
  await f.store.create(draft);
  f.cloud.rejectCreate = new ApiError('Entre novamente', { status: 401, code: 'session_expired' });
  f.connect();
  await assert.rejects(f.store.list(), (e) => assert.equal(e.code, 'session_expired'));
  assert.equal((await f.db.read(user.id)).pending.length, 1);
  await f.store.signOut();
  f.cloud.rejectCreate = null;
  await f.store.signIn('gustavo', 'teste');
  await f.store.sync();
  assert.equal(f.cloud.rows.length, 1);
});

offlineTest('trocar de conta não mostra nem envia a fila da outra pessoa', async (f) => {
  await f.store.create(draft);
  await f.store.signOut();
  f.cloud.user = other;
  const second = f.makeStore();
  assert.equal((await second.list()).length, 0);
  f.connect();
  await second.sync();
  assert.equal(f.cloud.creates, 0);
  assert.equal((await f.db.read(user.id)).pending.length, 1);
});

offlineTest('vinte gravações concorrentes em duas instâncias não perdem lançamentos', async (f) => {
  const second = f.makeStore();
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? second : f.store).create({ ...draft, note: `Registro ${i}` })));
  const data = await f.db.read(user.id);
  assert.equal(data.pending.length, 20);
  assert.equal(new Set(data.pending.map((item) => item.row.id)).size, 20);
});

offlineTest('sincronização concorrente em duas abas não envia duas vezes', async (f) => {
  await f.store.create(draft);
  const second = f.makeStore();
  f.connect();
  await Promise.all([f.store.sync(), second.sync()]);
  assert.equal(f.cloud.creates, 1);
  assert.equal((await f.db.read(user.id)).pending.length, 0);
});

offlineTest('edição e exclusão de registros sincronizados exigem internet', async (f) => {
  await assert.rejects(f.store.update('server-1', draft), (e) => assert.ok(e.message.includes('internet')));
  await assert.rejects(f.store.remove('server-1'), (e) => assert.ok(e.message.includes('internet')));
});

offlineTest('primeiro login offline não é permitido', async (f) => {
  await assert.rejects(f.store.signIn('gustavo', 'teste'), (e) => assert.ok(e.message.includes('internet')));
});

offlineTest('falha de armazenamento não confirma um salvamento inexistente', async (f) => {
  const real = f.db.change;
  f.db.change = async () => { throw new Error('Armazenamento cheio'); };
  await assert.rejects(f.store.create(draft), (e) => assert.ok(e.message.includes('cheio')));
  f.db.change = real;
  assert.equal((await f.db.read(user.id)).pending.length, 0);
});

offlineTest('atualizar o extrato remove registros apagados no servidor sem perder pendências locais', async (f) => {
  f.cloud.rows = [{ ...draft, id: 'deleted-later', user_id: other.id, author: other.username }];
  f.connect();
  await f.store.list();
  f.disconnect();
  const local = await f.store.create(draft);
  f.cloud.rows = [];
  f.cloud.rejectCreate = new ApiError('Inválido', { status: 400 });
  f.connect();
  const rows = await f.store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, local.id);
  assert.equal(rows[0].pending, true);
});
