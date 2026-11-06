// Cliente mínimo para Supabase Auth (GoTrue) + REST (PostgREST), sem dependências.
// Docs: https://supabase.com/docs/guides/api  e  https://supabase.com/docs/reference/auth

export class ApiError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const SESSION_KEY = 'dolarmap.offline.session.v1';

// Falhas temporárias não invalidam o token de renovação salvo no aparelho.
const temporaryAuthError = (e) => e.code === 'network' || e.code === 'request_timeout'
  || [408, 409, 429].includes(e.status) || e.status >= 500;

export class SupabaseRest {
  constructor(url, anonKey, storage = globalThis.localStorage) {
    this.url = url.replace(/\/+$/, '');
    this.key = anonKey;
    this.storage = storage;
    this.session = this.#load();
    this.refreshing = null;
  }

  #load() {
    try {
      return JSON.parse(this.storage.getItem(SESSION_KEY) || 'null');
    } catch {
      return null;
    }
  }

  #save(session) {
    this.session = session;
    try {
      if (session) this.storage.setItem(SESSION_KEY, JSON.stringify(session));
      else this.storage.removeItem(SESSION_KEY);
    } catch {
      /* armazenamento indisponível: sessão fica só em memória */
    }
  }

  async #fetch(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const h = { apikey: this.key, 'Content-Type': 'application/json', ...headers };
    if (auth && this.session?.access_token) h.Authorization = `Bearer ${this.session.access_token}`;
    let res;
    let text;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      res = await fetch(this.url + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
      text = await res.text();
    } catch {
      throw new ApiError('Sem conexão com o servidor. Verifique sua internet e tente de novo.', { code: 'network' });
    } finally { clearTimeout(timeout); }
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const code = data?.error_code || data?.code || data?.error || '';
      const msg = data?.msg || data?.message || data?.error_description || `Erro ${res.status}`;
      throw new ApiError(msg, { status: res.status, code: String(code) });
    }
    return data;
  }

  #storeTokenResponse(data) {
    const now = Math.floor(Date.now() / 1000);
    this.#save({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at || now + (data.expires_in || 3600),
      user: { id: data.user?.id, email: data.user?.email },
    });
    return this.session;
  }

  async signIn(email, password) {
    try {
      const data = await this.#fetch('/auth/v1/token?grant_type=password', {
        method: 'POST',
        auth: false,
        body: { email, password },
      });
      return this.#storeTokenResponse(data);
    } catch (e) {
      if (e.status === 400 || e.status === 401) {
        throw new ApiError('Usuário ou senha incorretos.', { status: e.status, code: 'invalid_credentials' });
      }
      if (e.status === 429) throw new ApiError('Muitas tentativas. Aguarde um minuto e tente de novo.', e);
      throw e;
    }
  }

  async refresh() {
    if (!this.session?.refresh_token) {
      this.#save(null);
      throw new ApiError('Sua sessão expirou. Entre novamente.', { status: 401, code: 'session_expired' });
    }
    this.refreshing ||= this.#fetch('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      auth: false,
      body: { refresh_token: this.session.refresh_token },
    })
      .then((d) => this.#storeTokenResponse(d))
      .catch((e) => {
        if (temporaryAuthError(e)) throw e;
        this.#save(null);
        throw new ApiError('Sua sessão expirou. Entre novamente.', { status: 401, code: 'session_expired' });
      })
      .finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /** Renova a sessão; permite lembrar a conta durante falhas temporárias ao reabrir. */
  async getSession({ allowStale = true } = {}) {
    if (!this.session) return null;
    const now = Math.floor(Date.now() / 1000);
    if (this.session.expires_at - 60 <= now) {
      try {
        await this.refresh();
      } catch (e) {
        if (e.code === 'session_expired') return null;
        // Reabre o app com a conta lembrada, mas requisições aguardam um token válido.
        if (allowStale) return this.session;
        throw e;
      }
    }
    return this.session;
  }

  async signOut() {
    const had = this.session;
    this.#save(null);
    if (had?.access_token) {
      try {
        await fetch(this.url + '/auth/v1/logout', {
          method: 'POST',
          headers: { apikey: this.key, Authorization: `Bearer ${had.access_token}` },
        });
      } catch {
        /* sessão local já foi apagada */
      }
    }
  }

  /** Chamada REST autenticada; renova o token uma vez em caso de 401. */
  async rest(path, opts = {}) {
    await this.getSession({ allowStale: false });
    try {
      return await this.#fetch('/rest/v1' + path, opts);
    } catch (e) {
      if (e.status === 401 && this.session?.refresh_token) {
        await this.refresh();
        return this.#fetch('/rest/v1' + path, opts);
      }
      throw e;
    }
  }
}
