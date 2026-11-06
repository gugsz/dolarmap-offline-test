// Camada de dados. Mesma interface para os dois modos:
//  - CloudStore: Supabase (login real, dados sincronizados entre os dois celulares)
//  - LocalStore: localStorage (modo de teste, sem senha, dados só neste aparelho)
import { SupabaseRest, ApiError } from './supabase.js?v=20261106offline1';
import { OfflineStore } from './offline-store.js?v=20261106offline1';

const FIELDS = ['kind', 'amount_cents', 'currency', 'brl_cents', 'category', 'note', 'occurred_on'];
const pick = (v) => Object.fromEntries(FIELDS.map((k) => [k, v[k] ?? null]));

export function createStore(config, storage = globalThis.localStorage) {
  const configured = Boolean(config.supabaseUrl && config.supabaseAnonKey);
  return configured ? new OfflineStore(new CloudStore(config, storage)) : new LocalStore(config, storage);
}

function emailFor(config, username) {
  const p = config.users.find((u) => u.username === username.toLowerCase());
  return (p?.email || `${username}@${config.emailDomain}`).toLowerCase();
}

/** Converte o e-mail (ou a parte antes do @, que o servidor grava em "author") no username do app. */
function usernameFromEmail(config, emailOrPrefix) {
  const v = String(emailOrPrefix || '').toLowerCase();
  const prefix = v.split('@')[0];
  const match = config.users.find((u) => {
    const e = emailFor(config, u.username);
    return e === v || e.split('@')[0] === prefix;
  });
  return match ? match.username : prefix;
}

function profileFor(config, username) {
  const p = config.users.find((u) => u.username === username);
  return p ? { ...p } : { username, name: username.charAt(0).toUpperCase() + username.slice(1) };
}

export class CloudStore {
  mode = 'cloud';
  requiresPassword = true;

  constructor(config, storage) {
    this.config = config;
    this.api = new SupabaseRest(config.supabaseUrl, config.supabaseAnonKey, storage);
  }

  #userFromSession(s) {
    if (!s?.user?.email) return null;
    const username = usernameFromEmail(this.config, s.user.email);
    return { id: s.user.id, ...profileFor(this.config, username) };
  }

  // O servidor grava em "author" a parte do e-mail antes do @; o app trabalha com o username.
  #fromServer = (row) => (row ? { ...row, author: usernameFromEmail(this.config, row.author) } : row);

  async restoreSession() {
    return this.#userFromSession(await this.api.getSession());
  }

  async signIn(username, password) {
    if (!password) throw new ApiError('Digite sua senha.');
    return this.#userFromSession(await this.api.signIn(emailFor(this.config, username), password));
  }

  signOut() {
    return this.api.signOut();
  }

  async list() {
    const rows = await this.api.rest('/transactions?select=*&order=occurred_on.desc,created_at.desc&limit=5000');
    return (rows || []).map(this.#fromServer);
  }

  async create(value, { id } = {}) {
    const rows = await this.api.rest('/transactions', {
      method: 'POST',
      body: { ...pick(value), ...(id ? { id } : {}) },
      headers: { Prefer: 'return=representation' },
    });
    return this.#fromServer(rows[0]);
  }

  async findTransaction(id) {
    const rows = await this.api.rest(`/transactions?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
    return this.#fromServer(rows?.[0]) || null;
  }

  async update(id, value) {
    const rows = await this.api.rest(`/transactions?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: pick(value),
      headers: { Prefer: 'return=representation' },
    });
    if (!rows?.length) throw new ApiError('Você só pode editar seus próprios registros.');
    return this.#fromServer(rows[0]);
  }

  async remove(id) {
    const rows = await this.api.rest(`/transactions?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' },
    });
    if (!rows?.length) throw new ApiError('Você só pode apagar seus próprios registros.');
  }

  // ---- cartinhas 💌 (tabela love_notes, ver supabase/cartinhas.sql)

  #prefix = (username) => emailFor(this.config, username).split('@')[0];
  #noteFromServer = (n) =>
    n ? { ...n, from: usernameFromEmail(this.config, n.sender_author), to: usernameFromEmail(this.config, n.recipient) } : n;

  async sendNote(toUsername, message) {
    try {
      const rows = await this.api.rest('/love_notes', {
        method: 'POST',
        body: { recipient: this.#prefix(toUsername), message },
        headers: { Prefer: 'return=representation' },
      });
      return this.#noteFromServer(rows[0]);
    } catch (e) {
      if (e.status === 404 || e.code === 'PGRST205' || e.code === '42P01')
        throw new ApiError('A caixa de cartinhas ainda não foi criada no Supabase (rode supabase/cartinhas.sql).');
      throw e;
    }
  }

  /** Cartinhas para mim ainda não abertas. */
  async inbox(username) {
    const rows = await this.api.rest(
      `/love_notes?select=*&recipient=eq.${encodeURIComponent(this.#prefix(username))}&opened_at=is.null&order=created_at.asc&limit=10`,
    );
    return (rows || []).map(this.#noteFromServer);
  }

  async sentNotes(username) {
    const rows = await this.api.rest(
      `/love_notes?select=*&sender_author=eq.${encodeURIComponent(this.#prefix(username))}&order=created_at.desc&limit=5`,
    );
    return (rows || []).map(this.#noteFromServer);
  }

  async markNoteOpened(id) {
    await this.api.rest(`/love_notes?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { opened_at: new Date().toISOString() },
      headers: { Prefer: 'return=minimal' },
    });
  }

  // ---- fotos de perfil 📸 (tabela profiles, ver supabase/perfis.sql)

  /** { username: dataURL } dos dois. */
  async listProfiles() {
    const rows = await this.api.rest('/profiles?select=username,avatar');
    const out = {};
    for (const r of rows || []) out[usernameFromEmail(this.config, r.username)] = r.avatar || null;
    return out;
  }

  /** Salva (ou remove, com null) a minha foto. */
  async saveAvatar(dataUrl) {
    const session = await this.api.getSession();
    const uid = session?.user?.id;
    try {
      const rows = await this.api.rest(`/profiles?user_id=eq.${encodeURIComponent(uid)}`, {
        method: 'PATCH',
        body: { avatar: dataUrl },
        headers: { Prefer: 'return=representation' },
      });
      if (rows?.length) return;
      await this.api.rest('/profiles', { method: 'POST', body: { avatar: dataUrl }, headers: { Prefer: 'return=minimal' } });
    } catch (e) {
      if (e.status === 404 || e.code === 'PGRST205' || e.code === '42P01')
        throw new ApiError('As fotos ainda não foram ativadas no Supabase (rode supabase/perfis.sql).');
      throw e;
    }
  }
}

const LOCAL_DATA = 'dolarmap.local.data.v1';
const LOCAL_USER = 'dolarmap.local.user.v1';
const LOCAL_NOTES = 'dolarmap.local.notes.v1';
const LOCAL_PROFILES = 'dolarmap.local.profiles.v1';

export class LocalStore {
  mode = 'local';
  requiresPassword = false;

  constructor(config, storage) {
    this.config = config;
    this.storage = storage;
  }

  #read() {
    try {
      return JSON.parse(this.storage.getItem(LOCAL_DATA) || '[]');
    } catch {
      return [];
    }
  }

  #write(rows) {
    try {
      this.storage.setItem(LOCAL_DATA, JSON.stringify(rows));
    } catch {
      throw new ApiError('Não foi possível salvar neste aparelho (armazenamento cheio ou bloqueado).');
    }
  }

  async restoreSession() {
    const u = this.storage.getItem(LOCAL_USER);
    return u ? { id: `local-${u}`, ...profileFor(this.config, u) } : null;
  }

  async signIn(username) {
    this.storage.setItem(LOCAL_USER, username);
    return this.restoreSession();
  }

  async signOut() {
    this.storage.removeItem(LOCAL_USER);
  }

  async list() {
    return this.#read();
  }

  async create(value) {
    const user = await this.restoreSession();
    const row = {
      id: globalThis.crypto?.randomUUID?.() || String(Date.now() + Math.random()),
      user_id: user.id,
      author: user.username,
      created_at: new Date().toISOString(),
      ...pick(value),
    };
    this.#write([row, ...this.#read()]);
    return row;
  }

  async update(id, value) {
    const user = await this.restoreSession();
    const rows = this.#read();
    const i = rows.findIndex((r) => r.id === id && r.user_id === user.id);
    if (i < 0) throw new ApiError('Você só pode editar seus próprios registros.');
    rows[i] = { ...rows[i], ...pick(value) };
    this.#write(rows);
    return rows[i];
  }

  async remove(id) {
    const user = await this.restoreSession();
    const rows = this.#read();
    const next = rows.filter((r) => !(r.id === id && r.user_id === user.id));
    if (next.length === rows.length) throw new ApiError('Você só pode apagar seus próprios registros.');
    this.#write(next);
  }

  // ---- cartinhas 💌 (modo local: ficam neste navegador)

  #notes() {
    try {
      return JSON.parse(this.storage.getItem(LOCAL_NOTES) || '[]');
    } catch {
      return [];
    }
  }

  async sendNote(toUsername, message) {
    const user = await this.restoreSession();
    const note = {
      id: globalThis.crypto?.randomUUID?.() || String(Date.now() + Math.random()),
      from: user.username,
      to: toUsername,
      message,
      created_at: new Date().toISOString(),
      opened_at: null,
    };
    this.storage.setItem(LOCAL_NOTES, JSON.stringify([...this.#notes(), note]));
    return note;
  }

  async inbox(username) {
    return this.#notes().filter((n) => n.to === username && !n.opened_at);
  }

  async sentNotes(username) {
    return this.#notes()
      .filter((n) => n.from === username)
      .reverse()
      .slice(0, 5);
  }

  async listProfiles() {
    try {
      return JSON.parse(this.storage.getItem(LOCAL_PROFILES) || '{}');
    } catch {
      return {};
    }
  }

  async saveAvatar(dataUrl) {
    const user = await this.restoreSession();
    const all = await this.listProfiles();
    all[user.username] = dataUrl;
    try {
      this.storage.setItem(LOCAL_PROFILES, JSON.stringify(all));
    } catch {
      throw new ApiError('Não foi possível salvar a foto neste aparelho (armazenamento cheio).');
    }
  }

  async markNoteOpened(id) {
    const all = this.#notes().map((n) => (n.id === id && !n.opened_at ? { ...n, opened_at: new Date().toISOString() } : n));
    this.storage.setItem(LOCAL_NOTES, JSON.stringify(all));
  }
}
