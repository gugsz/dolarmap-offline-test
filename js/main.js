import { CONFIG } from './config.js?v=20261106offline4';
import { createStore } from './store.js?v=20261106offline4';
import { prepareOffline } from './offline.js?v=20261106offline4';
import {
  KINDS,
  BUY_CATEGORY,
  categoriesFor,
  categoryInfo,
  centsToInput,
  dayLabel,
  filterTxs,
  formatMoney,
  formatRate,
  groupByDay,
  parseMoney,
  rateOf,
  sortTxs,
  summarize,
  toCSV,
  todayISO,
  validateDraft,
} from './logic.js?v=20261106offline4';
import { balanceSeries, categoryBreakdown, coupleComparison, purchaseHistory } from './analytics.js?v=20261106offline4';
import { COUPLE_STEP, PERSONAL_STEP, achievementsFor, newAchievements, nextMilestone, topPerType } from './achievements.js?v=20261106offline4';

// ---------------------------------------------------------------- estado

const app = document.getElementById('app');
// Testes automáticos (tests/preview.html e tests/e2e.html) forçam o modo local — só em localhost,
// para nunca tocar nos dados reais do Supabase.
const devLocal = (() => {
  try {
    return ['localhost', '127.0.0.1'].includes(location.hostname) && sessionStorage.getItem('dolarmap.dev.local') === '1';
  } catch {
    return false;
  }
})();

const offlineDisabled = new URLSearchParams(location.search).has('offline-desativado');
let offlineAssets = devLocal ? 'test' : offlineDisabled ? 'disabled' : 'preparing';
let offlineAssetError = '';

const state = {
  store: createStore(devLocal ? { ...CONFIG, supabaseUrl: '', supabaseAnonKey: '' } : CONFIG),
  anRange: 30, // período do gráfico de evolução do saldo (7, 30 ou 90 dias)
  user: null,
  txs: [],
  loading: false,
  loadError: null,
  tab: 'home',
  scope: readPref('dolarmap.scope', 'me'),
  filter: 'all',
  query: '',
  theme: readPref('dolarmap.theme', 'system'),
  loginPick: null,
  loginBusy: false,
  loginError: '',
  enter: true, // anima a entrada da tela no próximo render (troca de aba, login)
  flashId: null, // registro recém-salvo: destaca a linha por um instante
  heroShown: {}, // último saldo exibido por visão (me/couple), para animar a contagem
  avatars: {}, // { username: dataURL } — fotos de perfil (preenchido logo abaixo, do cache)
  photoBusy: false,
};
if (state.store.status) state.store.onStatusChange = () => updateOfflinePanel();
try {
  state.avatars = JSON.parse(localStorage.getItem('dolarmap.avatars.v1') || '{}');
} catch {
  /* sem cache */
}

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}
function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignorado */
  }
}

// ---------------------------------------------------------------- utilidades

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const profile = (username) =>
  CONFIG.users.find((u) => u.username === username) || { username, name: username || '?', color: '#8E8E93' };

const otherUser = () => CONFIG.users.find((u) => u.username !== state.user?.username);

function avatar(username, cls = '') {
  const p = profile(username);
  const photo = state.avatars[username];
  if (photo) return `<span class="avatar has-photo ${cls}" style="background:${esc(p.color)}" aria-hidden="true"><img src="${esc(photo)}" alt="" /></span>`;
  return `<span class="avatar ${cls}" style="background:${esc(p.color)}" aria-hidden="true">${esc(p.name.charAt(0))}</span>`;
}

// ---------------------------------------------------------------- fotos de perfil 📸

const AVATAR_CACHE = 'dolarmap.avatars.v1'; // cópia local: fotos aparecem na hora (e na tela de login)

function setAvatars(map) {
  const next = { ...map };
  if (JSON.stringify(next) === JSON.stringify(state.avatars)) return false;
  state.avatars = next;
  writePref(AVATAR_CACHE, JSON.stringify(next));
  return true;
}

async function loadAvatars() {
  if (!state.user || !state.store.listProfiles) return;
  try {
    if (setAvatars(await state.store.listProfiles())) render();
  } catch {
    /* tabela ainda não criada ou sem internet: fica com a cópia local */
  }
}

/** Lê o arquivo escolhido como imagem (data: URL — permitido pela CSP do site). */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('Não foi possível ler essa imagem. Tente outra foto.'));
    const reader = new FileReader();
    reader.onerror = fail;
    reader.onload = () => {
      const img = new Image();
      img.onerror = fail;
      img.onload = () => resolve(img);
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/** Recorta o quadrado (sx, sy, side) da imagem original e reduz para 320×320 JPEG (~30 KB). */
function cropToAvatar(img, sx, sy, side) {
  const size = 320;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
  let q = 0.85;
  let data = c.toDataURL('image/jpeg', q);
  while (data.length > 150000 && q > 0.4) data = c.toDataURL('image/jpeg', (q -= 0.15));
  return data;
}

/**
 * Editor de recorte: arrastar move, pinça (ou o controle deslizante / roda do mouse) dá zoom.
 * Resolve com a foto pronta (data URL) ou null se cancelar.
 */
function openCropper(img) {
  return new Promise((resolve) => {
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const el = document.createElement('div');
    el.className = 'cropper';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'crop-title');
    el.innerHTML = `
      <div class="crop-head">
        <button type="button" class="text-btn" data-crop="cancel">Cancelar</button>
        <h2 id="crop-title">Ajustar foto</h2>
        <button type="button" class="text-btn bold" data-crop="ok">Usar foto</button>
      </div>
      <div class="crop-stage" aria-label="Arraste para posicionar. Use dois dedos para dar zoom.">
        <img src="${img.src}" alt="" draggable="false" />
        <div class="crop-mask" aria-hidden="true"></div>
      </div>
      <p class="crop-hint">Arraste para centralizar · pinça para zoom</p>
      <label class="crop-zoom"><span aria-hidden="true">−</span>
        <input type="range" min="1" max="4" step="0.01" value="1" aria-label="Zoom" />
        <span aria-hidden="true">+</span></label>
      <button type="button" class="btn crop-ok" data-crop="ok">Usar foto</button>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));

    const stage = el.querySelector('.crop-stage');
    const pic = stage.querySelector('img');
    const slider = el.querySelector('input[type=range]');
    let S = stage.clientWidth; // lado do quadrado visível (px)
    let base = Math.max(S / W, S / H); // escala que "cobre" o quadrado
    let zoom = 1;
    let x = (S - W * base) / 2; // canto superior esquerdo da imagem dentro do quadrado
    let y = (S - H * base) / 2;

    const clamp = () => {
      const k = base * zoom;
      x = Math.min(0, Math.max(S - W * k, x));
      y = Math.min(0, Math.max(S - H * k, y));
    };
    const draw = () => {
      clamp();
      const k = base * zoom;
      pic.style.width = `${W * k}px`;
      pic.style.height = `${H * k}px`;
      pic.style.transform = `translate(${x}px, ${y}px)`;
      slider.value = String(zoom);
    };
    // Zoom mantendo fixo o ponto (cx, cy) do quadrado — o que está sob os dedos não "foge".
    const zoomTo = (z, cx = S / 2, cy = S / 2) => {
      z = Math.min(4, Math.max(1, z));
      const k0 = base * zoom;
      const k1 = base * z;
      x = cx - ((cx - x) / k0) * k1;
      y = cy - ((cy - y) / k0) * k1;
      zoom = z;
      draw();
    };
    draw();

    const pointers = new Map();
    let pinch = null;
    const local = (e) => {
      const r = stage.getBoundingClientRect();
      return { px: e.clientX - r.left, py: e.clientY - r.top };
    };
    stage.addEventListener('pointerdown', (e) => {
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {
        /* alguns navegadores recusam a captura; o arrasto funciona igual */
      }
      pointers.set(e.pointerId, local(e));
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.px - b.px, a.py - b.py), z: zoom };
      }
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      const now = local(e);
      pointers.set(e.pointerId, now);
      if (pointers.size === 1) {
        x += now.px - prev.px;
        y += now.py - prev.py;
        draw();
      } else if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.px - b.px, a.py - b.py);
        // move junto com o centro dos dedos e aplica o zoom em volta dele
        x += (now.px - prev.px) / 2;
        y += (now.py - prev.py) / 2;
        zoomTo(pinch.z * (d / pinch.d), (a.px + b.px) / 2, (a.py + b.py) / 2);
      }
    });
    const up = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
    };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = local(e);
        zoomTo(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), p.px, p.py);
      },
      { passive: false },
    );
    stage.addEventListener('dblclick', () => zoomTo(zoom > 1.5 ? 1 : 2));
    slider.addEventListener('input', () => zoomTo(Number(slider.value)));
    const onResize = () => {
      const S2 = stage.clientWidth;
      if (!S2 || S2 === S) return;
      x *= S2 / S;
      y *= S2 / S;
      S = S2;
      base = Math.max(S / W, S / H);
      draw();
    };
    window.addEventListener('resize', onResize);

    const finish = (ok) => {
      window.removeEventListener('resize', onResize);
      let result = null;
      if (ok) {
        const k = base * zoom;
        const side = Math.min(S / k, W, H);
        result = cropToAvatar(img, Math.max(0, -x / k), Math.max(0, -y / k), side);
      }
      el.classList.remove('in');
      setTimeout(() => el.remove(), reduceMotion() ? 0 : 250);
      resolve(result);
    };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-crop]');
      if (b) finish(b.dataset.crop === 'ok');
    });
    el.addEventListener('keydown', (e) => e.key === 'Escape' && finish(false));
    el.querySelector('.crop-ok').focus({ preventScroll: true });
  });
}

async function changePhoto(file) {
  if (!file || state.photoBusy) return;
  if (!/^image\//.test(file.type || 'image/')) return toast('Escolha uma imagem.', { error: true });
  let data;
  try {
    data = await openCropper(await loadImage(file));
  } catch (e) {
    return toast(e.message || 'Não foi possível abrir a foto.', { error: true });
  }
  if (!data) return; // cancelou
  state.photoBusy = true;
  render();
  try {
    await state.store.saveAvatar(data);
    setAvatars({ ...state.avatars, [state.user.username]: data });
    toast('Foto atualizada ✓');
  } catch (e) {
    toast(e.message || 'Não foi possível salvar a foto.', { error: true });
  } finally {
    state.photoBusy = false;
    render();
  }
}

async function removePhoto() {
  if (!confirm('Remover sua foto de perfil?')) return;
  state.photoBusy = true;
  render();
  try {
    await state.store.saveAvatar(null);
    setAvatars({ ...state.avatars, [state.user.username]: null });
    toast('Foto removida');
  } catch (e) {
    toast(e.message || 'Não foi possível remover a foto.', { error: true });
  } finally {
    state.photoBusy = false;
    render();
  }
}

/** Foto em tela cheia (toque em qualquer lugar fecha). */
function viewPhoto(username) {
  const photo = state.avatars[username];
  if (!photo) return;
  const p = profile(username);
  const el = document.createElement('div');
  el.className = 'photo-viewer';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', `Foto de ${p.name}`);
  el.innerHTML = `<img src="${esc(photo)}" alt="Foto de ${esc(p.name)}" /><p>${esc(p.name)}</p><button type="button" class="btn small">Fechar</button>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  el.querySelector('button').focus({ preventScroll: true });
  const close = () => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), reduceMotion() ? 0 : 250);
  };
  el.addEventListener('click', close);
  el.addEventListener('keydown', (e) => e.key === 'Escape' && close());
}

let toastTimer;
function toast(msg, { error = false } = {}) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function visibleTxs() {
  return state.scope === 'me' ? state.txs.filter((t) => t.author === state.user.username) : state.txs;
}

const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 13h3v7H4zM10.5 8h3v12h-3zM17 4h3v16h-3z"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  analytics: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12A9 9 0 1 1 12 3v9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z" fill="currentColor"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
};

// ---------------------------------------------------------------- tema

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  metas.forEach((m) => {
    const isDarkMeta = m.media.includes('dark');
    const color = theme === 'dark' ? '#000000' : theme === 'light' ? '#F2F2F7' : isDarkMeta ? '#000000' : '#F2F2F7';
    m.setAttribute('content', color);
  });
}

// ---------------------------------------------------------------- dados

let dataLoading = false;
async function loadData({ silent = false } = {}) {
  if (dataLoading) return;
  dataLoading = true;
  if (!silent) state.loading = true;
  state.loadError = null;
  render();
  try {
    state.txs = sortTxs(await state.store.list());
    setTimeout(checkAchievements, 0); // ex.: o outro registrou algo e o casal bateu um marco
    setTimeout(checkNotes, 0); // cartinha nova? 💌
    setTimeout(loadAvatars, 0); // fotos de perfil (a outra pessoa pode ter trocado)
  } catch (e) {
    if (e.code === 'session_expired' || e.status === 401) return handleSessionExpired();
    state.loadError = e.message || 'Não foi possível carregar os dados.';
  } finally {
    dataLoading = false;
    state.loading = false;
    if (!silent) state.enter = true; // conteúdo chegou: entra com a animação
    render();
  }
}

/** Ao sair da conta: nada da pessoa anterior (comemoração, cartinha, formulário) fica na tela. */
function resetOverlays() {
  celebrationQueue.length = 0;
  celebrateEl?.remove();
  celebrateEl = null;
  shownNotes.clear();
  if (loveSheet?.open) loveSheet.close();
  if (sheet?.open) finishClose();
  document.body.style.overflow = '';
}

async function handleSessionExpired() {
  resetOverlays();
  await state.store.signOut();
  state.user = null;
  state.txs = [];
  state.loginError = 'Sua sessão expirou. Entre novamente.';
  render();
}

// ---------------------------------------------------------------- telas

function offlinePanelContents() {
  const status = state.store.status;
  if (!status) return '';
  const offline = navigator.onLine === false || status.offline;
  let title = offline ? 'Sem conexão — usando dados deste aparelho' : 'Dados atualizados';
  if (status.syncing) title = 'Sincronizando seus registros…';
  else if (status.pending) title = `${status.pending} registro(s) pendente(s) de sincronização`;
  else if (status.error && !offline) title = 'A sincronização precisa de atenção';
  let detail = status.lastSync
    ? `Última atualização: ${new Date(status.lastSync).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}.`
    : 'Ainda não foi baixada uma cópia completa dos registros.';
  if (offline || status.pending) detail += ' O outro celular recebe seus lançamentos depois da sincronização.';
  if (!state.user) { title = 'Versão de teste offline'; detail = 'Entre com internet uma vez para guardar seus dados neste aparelho.'; }
  const assets = offlineAssets === 'ready' ? 'Aplicativo preparado para abrir sem internet.'
    : offlineAssets === 'preparing' ? 'Preparando a abertura sem internet…'
    : offlineAssets === 'disabled' ? 'Abertura offline desativada. Você pode publicar a versão anterior agora.'
    : `Abertura offline ainda não preparada. ${offlineAssetError}`;
  const indicator = status.syncing ? 'syncing' : status.pending ? 'pending' : offline ? 'offline' : status.error ? 'error' : 'ready';
  const indicatorPath = indicator === 'ready'
    ? '<circle cx="12" cy="12" r="8.5"/><path d="m8 12 2.5 2.5L16 9"/>'
    : indicator === 'offline'
      ? '<circle cx="12" cy="12" r="8.5"/><path d="m6 18 12-12"/>'
      : '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5M12 16h.01"/>';
  return `<div class="group">
      <button type="button" class="row offline-sync-row" data-action="sync"
        aria-busy="${status.syncing ? 'true' : 'false'}" aria-describedby="offline-detail offline-assets"
        ${!state.user || navigator.onLine === false || status.syncing ? 'disabled' : ''}>
        <span class="offline-sync-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 4v5h-5M4 20v-5h5M5.1 8a7.5 7.5 0 0 1 12.4-2L20 9M4 15l2.5 3A7.5 7.5 0 0 0 18.9 16"/>
          </svg>
        </span>
        <span class="main"><span class="title">${status.syncing ? 'Sincronizando…' : 'Sincronizar agora'}</span><span class="subtitle">${esc(title)}</span></span>
        <span class="offline-sync-state" data-status="${indicator}" aria-hidden="true">
          ${status.syncing ? '<span class="spinner"></span>' : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${indicatorPath}</svg>`}
        </span>
      </button>
      ${offlineAssets === 'failed' ? '<button type="button" class="row plain link" data-action="prepare-offline">Preparar offline</button>' : ''}
    </div>
    <p class="offline-caption"><span id="offline-detail">${esc(detail)}</span>
      <span id="offline-assets" data-offline-assets="${esc(offlineAssets)}">${esc(assets)}</span>
      ${status.error && state.user ? `<span class="error-text">${esc(status.error)}</span>` : ''}
    </p>`;
}

function offlinePanel() {
  if (!state.store.status) return '';
  return `<section id="offline-status" class="offline-status" aria-live="polite" aria-label="Conexão e sincronização">${offlinePanelContents()}</section>`;
}

function updateOfflinePanel() {
  const panel = document.getElementById('offline-status');
  if (panel) panel.innerHTML = offlinePanelContents();
}

async function setupOffline() {
  if (devLocal || offlineDisabled) return;
  offlineAssets = 'preparing';
  updateOfflinePanel();
  try { await prepareOffline(); offlineAssets = 'ready'; offlineAssetError = ''; }
  catch (e) { offlineAssets = 'failed'; offlineAssetError = e.message; }
  updateOfflinePanel();
}

function render() {
  const enter = state.enter;
  state.enter = false;
  if (!state.user) {
    app.innerHTML = renderLogin(enter);
    return;
  }
  const y = window.scrollY;
  const tabs = { home: renderHome, list: renderList, analytics: renderAnalytics, settings: renderSettings };
  app.innerHTML = `
    <main class="screen${enter ? ' enter' : ''}" id="main">${tabs[state.tab]()}</main>
    <nav class="tabbar${enter ? ' enter' : ''}" aria-label="Navegação">
      <div class="tabbar-inner">
        ${tabButton('home', 'Resumo')}
        ${tabButton('list', 'Extrato')}
        <button class="tab-add" data-action="add" aria-label="Adicionar registro">
          <span class="bubble">${ICONS.plus}</span><span>Adicionar</span>
        </button>
        ${tabButton('analytics', 'Análises')}
        ${tabButton('settings', 'Ajustes')}
      </div>
    </nav>`;
  window.scrollTo(0, y);
  animateHero();
}

/** Saldo "rolando" até o valor novo (ao entrar no app e depois de salvar algo). */
let heroAnim = 0;
function animateHero() {
  const el = app.querySelector('.hero [data-count-to]');
  if (!el) return;
  const to = Number(el.dataset.countTo);
  const key = state.scope;
  const from = state.heroShown[key] ?? 0;
  state.heroShown[key] = to;
  const token = ++heroAnim;
  if (from === to || reduceMotion()) {
    el.textContent = formatMoney(to, 'USD');
    return;
  }
  const t0 = performance.now();
  const dur = Math.min(900, 350 + Math.abs(to - from) / 400);
  const step = (now) => {
    if (token !== heroAnim || !el.isConnected) return;
    const k = Math.min(1, (now - t0) / dur);
    const ease = 1 - Math.pow(1 - k, 3);
    el.textContent = formatMoney(Math.round(from + (to - from) * ease), 'USD');
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function tabButton(id, label) {
  return `<button data-action="tab" data-tab="${id}" ${state.tab === id ? 'aria-current="page"' : ''}>${ICONS[id]}<span>${label}</span></button>`;
}

function renderLogin(enter = false) {
  const needsPass = state.store.requiresPassword;
  const people = CONFIG.users
    .map(
      (u) => `
      <button type="button" class="person" role="radio" aria-checked="${state.loginPick === u.username}" data-action="pick" data-user="${u.username}">
        <span class="check" aria-hidden="true">✓</span>${avatar(u.username, 'lg')}<span>${esc(u.name)}</span>
      </button>`,
    )
    .join('');
  return `
    <form class="login${enter ? ' enter' : ''}" id="login-form" novalidate>
      <img class="logo" src="icons/icon-180.png" alt="" width="84" height="84" />
      <h1>DolarMap</h1>
      <p class="tagline">Os dólares da viagem, sempre à mão.</p>
      <div class="people-pick" role="radiogroup" aria-label="Quem é você?">${people}</div>
      ${
        needsPass
          ? `<label class="field"><span>Senha</span>
              <input class="input" id="password" type="password" autocomplete="current-password" required
                placeholder="Sua senha" ${state.loginPick ? '' : 'disabled'} /></label>`
          : `<div class="banner warn" style="margin:0 0 14px">⚠️ <span class="grow">Modo local: sem senha e os dados ficam só neste aparelho. Veja o README para ativar a sincronização.</span></div>`
      }
      <p class="error-text" role="alert">${esc(state.loginError)}</p>
      <button class="btn" type="submit" ${!state.loginPick || state.loginBusy ? 'disabled' : ''}>
        ${state.loginBusy ? '<span class="spinner" aria-hidden="true"></span> Entrando…' : 'Entrar'}
      </button>
      <p class="foot">Feito para Gustavo e Manuela ✈️ Work and Travel</p>
    </form>`;
}

function scopeControl() {
  const other = otherUser();
  return `
    <div class="segmented" role="group" aria-label="Mostrar dados de">
      <button data-action="scope" data-scope="me" aria-pressed="${state.scope === 'me'}">Meus</button>
      <button data-action="scope" data-scope="couple" aria-pressed="${state.scope === 'couple'}">Casal${other ? ` (com ${esc(other.name)})` : ''}</button>
    </div>`;
}

function loadingOrError() {
  if (state.loading && !state.txs.length) {
    return `<div class="state" role="status"><div class="spinner" style="margin:0 auto" aria-hidden="true"></div><p style="margin-top:12px">Carregando…</p></div>`;
  }
  if (state.loadError) {
    return `<div class="banner error" role="alert"><span aria-hidden="true">⚠️</span><span class="grow">${esc(state.loadError)}</span>
      <button class="btn small" data-action="retry">Tentar de novo</button></div>`;
  }
  return '';
}

function renderHome() {
  const txs = visibleTxs();
  const s = summarize(txs);
  const first = state.user.name;
  let people = '';
  if (state.scope === 'couple') {
    people = `<div class="people">${CONFIG.users
      .map((u) => {
        const b = summarize(state.txs.filter((t) => t.author === u.username)).balanceUsd;
        return `<span class="chip num">${avatar(u.username, 'xs')}${esc(u.name)}: ${formatMoney(b, 'USD')}</span>`;
      })
      .join('')}</div>`;
  }

  const head = `
    <header class="large-title">
      <div><div class="sub">Olá, ${esc(first)} 👋</div><h1>Resumo</h1></div>
      <button type="button" class="avatar-btn" data-action="tab" data-tab="settings" aria-label="Ajustes e foto de perfil">${avatar(state.user.username, 'md')}</button>
    </header>`;

  const status = loadingOrError();
  if (state.loading && !state.txs.length) return head + status;

  const hero = `
    <section class="hero" aria-label="Saldo">
      <div class="label">${state.scope === 'couple' ? 'Saldo do casal em dólar' : 'Meu saldo em dólar'}</div>
      <div class="value rounded num"><span class="sr-only">${formatMoney(s.balanceUsd, 'USD')}</span><span aria-hidden="true" data-count-to="${s.balanceUsd}">${formatMoney(state.heroShown[state.scope] ?? 0, 'USD')}</span></div>
      <div class="hint num">${
        s.balanceBrlEstimate != null
          ? `≈ ${formatMoney(s.balanceBrlEstimate, 'BRL')} pela cotação média`
          : 'Registre uma compra de dólar para ver a cotação média'
      }</div>
      ${people}
      ${milestoneBar(s.balanceUsd)}
    </section>`;

  const stats = `
    <div class="stats">
      <div class="stat"><div class="k">💱 Dólares comprados</div><div class="v num">${formatMoney(s.usdBought, 'USD')}</div></div>
      <div class="stat"><div class="k">🇧🇷 Investido em reais</div><div class="v num">${formatMoney(s.brlPaid, 'BRL')}</div></div>
      <div class="stat"><div class="k">📈 Cotação média</div><div class="v num">${formatRate(s.avgRate)}</div></div>
      <div class="stat"><div class="k">🛍️ Gastos em dólar</div><div class="v num">${formatMoney(s.usdSpent, 'USD')}</div></div>
      <div class="stat"><div class="k">📋 Gastos em reais</div><div class="v num">${formatMoney(s.brlSpent, 'BRL')}</div></div>
      <div class="stat"><div class="k">💼 Entradas em dólar</div><div class="v num">${formatMoney(s.usdIncome, 'USD')}</div></div>
      ${
        s.totalCostBrlEstimate != null
          ? `<div class="stat wide"><div class="k">🧮 Custo total da viagem até agora (estimado em R$)</div><div class="v num">${formatMoney(s.totalCostBrlEstimate, 'BRL')}</div></div>`
          : ''
      }
    </div>`;

  if (!txs.length) {
    return `${head}${scopeControl()}${status}${hero}
      <div class="state">
        <span class="emoji" aria-hidden="true">🧳</span>
        <h3>Vamos começar?</h3>
        <p>Registre os dólares que você já comprou e os gastos da preparação (visto, passaporte, passagem…).</p>
        <div style="display:grid;gap:10px;max-width:320px;margin:0 auto">
          <button class="btn" data-action="add" data-kind="buy">Registrar compra de dólar</button>
          <button class="btn secondary" data-action="add" data-kind="expense" data-currency="BRL">Registrar gasto da preparação</button>
        </div>
      </div>`;
  }

  const cats = s.categories.length
    ? `<h2 class="section-title">Gastos por categoria</h2>
       <div class="group">${s.categories
         .slice(0, 8)
         .map((c) => {
           const info = categoryInfo(c.id);
           const parts = [];
           if (c.usd) parts.push(formatMoney(c.usd, 'USD'));
           if (c.brl) parts.push(formatMoney(c.brl, 'BRL'));
           return `<div class="row"><span class="icon" aria-hidden="true">${info.icon}</span>
             <div class="main"><div class="title">${esc(info.label)}</div>
               <div class="cat-bar" aria-hidden="true"><span style="width:${Math.max(4, Math.round(c.share * 100))}%"></span></div></div>
             <div class="amount num">${parts.join('<small>')}${parts.length > 1 ? '</small>' : ''}</div></div>`;
         })
         .join('')}</div>`
    : '';

  const recent = txs.slice(0, 5).map(txRow).join('');
  return `${head}${scopeControl()}${status}${hero}${stats}${cats}
    <h2 class="section-title">Recentes <button data-action="tab" data-tab="list">Ver tudo</button></h2>
    <div class="group">${recent}</div>`;
}

/** Barrinha "Próxima conquista" no cartão de saldo. */
function milestoneBar(balance) {
  if (balance <= 0) return '';
  const couple = state.scope === 'couple';
  const m = nextMilestone(balance, couple ? COUPLE_STEP : PERSONAL_STEP);
  return `<div class="milestone" aria-label="Próxima conquista: ${formatMoney(m.target, 'USD')}, faltam ${formatMoney(m.missing, 'USD')}">
      <div class="milestone-top" aria-hidden="true"><span>🏆 Próxima meta: <strong class="num">${formatMoney(m.target, 'USD').replace(/,00$/, '')}</strong></span><span class="num">faltam ${formatMoney(m.missing, 'USD')}</span></div>
      <div class="milestone-bar" aria-hidden="true"><span style="--p:${(m.progress * 100).toFixed(1)}%"></span></div>
    </div>`;
}

function txRow(t) {
  const info = categoryInfo(t.category);
  const title = t.note || (t.kind === 'buy' ? 'Compra de dólar' : info.label);
  const subtitleParts = [];
  if (state.scope === 'couple') subtitleParts.push(esc(profile(t.author).name));
  if (t.note && t.kind !== 'buy') subtitleParts.push(esc(info.label));
  if (t.kind === 'buy') subtitleParts.push(`Cotação ${formatRate(rateOf(t.amount_cents, t.brl_cents))}`);
  if (state.tab !== 'list') subtitleParts.push(esc(dayLabel(t.occurred_on)));
  if (t.pending) subtitleParts.push('<span class="pending-label">Pendente de sincronização</span>');

  let amount;
  if (t.kind === 'expense') {
    amount = `<span class="num">${formatMoney(-t.amount_cents, t.currency)}</span>`;
  } else if (t.kind === 'buy') {
    amount = `<span class="num pos">${formatMoney(t.amount_cents, 'USD', { signed: true })}</span><small class="num">${formatMoney(t.brl_cents, 'BRL')}</small>`;
  } else {
    amount = `<span class="num pos">${formatMoney(t.amount_cents, 'USD', { signed: true })}</span>`;
  }

  const label = `${KINDS[t.kind].label}: ${title}, ${t.kind === 'expense' ? formatMoney(t.amount_cents, t.currency) : formatMoney(t.amount_cents, 'USD')}`;
  return `<button class="row${t.id === state.flashId ? ' flash' : ''}" data-action="edit" data-id="${esc(t.id)}" aria-label="${esc(label)}">
    <span class="icon" aria-hidden="true">${info.icon}</span>
    <div class="main"><div class="title">${esc(title)}</div>${subtitleParts.length ? `<div class="subtitle">${subtitleParts.join(' · ')}</div>` : ''}</div>
    <div class="amount">${amount}</div>
  </button>`;
}

function renderList() {
  const filters = [
    ['all', 'Tudo'],
    ['expense', 'Gastos'],
    ['buy', 'Compras'],
    ['income', 'Entradas'],
  ];
  return `
    <header class="large-title"><div><h1>Extrato</h1></div></header>
    ${scopeControl()}
    <div class="search"><input type="search" id="search" placeholder="Buscar (ex.: mercado)" value="${esc(state.query)}"
      aria-label="Buscar registros" autocomplete="off" enterkeyhint="search" /></div>
    <div class="segmented" role="group" aria-label="Filtrar por tipo">
      ${filters.map(([id, l]) => `<button data-action="filter" data-filter="${id}" aria-pressed="${state.filter === id}">${l}</button>`).join('')}
    </div>
    <div id="list-body">${listBody()}</div>`;
}

function listBody() {
  const base = visibleTxs();
  const txs = filterTxs(base, { kind: state.filter, query: state.query });
  const groups = groupByDay(txs);

  let body;
  const status = loadingOrError();
  if (state.loading && !state.txs.length) body = '';
  else if (!base.length) {
    body = `<div class="state"><span class="emoji" aria-hidden="true">🗒️</span><h3>Nada registrado ainda</h3>
      <p>Toque em <strong>Adicionar</strong> para registrar seu primeiro gasto ou compra de dólar.</p></div>`;
  } else if (!txs.length) {
    body = `<div class="state"><span class="emoji" aria-hidden="true">🔍</span><h3>Nenhum resultado</h3>
      <p>${state.query ? `Nada encontrado para “${esc(state.query)}”.` : 'Nenhum registro deste tipo.'}</p>
      <button class="btn small secondary" data-action="clear-filters">Limpar filtros</button></div>`;
  } else {
    body = groups
      .map(
        (g) => `
      <h2 class="day-header"><span>${esc(dayLabel(g.date))}</span>${g.usdOut ? `<span class="num">${formatMoney(-g.usdOut, 'USD')}</span>` : ''}</h2>
      <div class="group">${g.items.map(txRow).join('')}</div>`,
      )
      .join('');
  }
  return status + body;
}

// ---------------------------------------------------------------- análises

const shortDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const pct = (x) => (x > 0 && x < 0.005 ? '<1%' : `${Math.round(x * 100)}%`);
const FMT = {
  usd: (c) => formatMoney(c, 'USD'),
  brl: (c) => formatMoney(c, 'BRL'),
  rate: (r) => formatRate(r),
};

function card(title, body, { note = '', id = '' } = {}) {
  return `<section class="an-section"${id ? ` id="${id}"` : ''}>
    <h2 class="section-title">${title}</h2>
    <div class="an-card">${body}</div>
    ${note ? `<p class="an-note">${note}</p>` : ''}
  </section>`;
}

function hbar(share, color = '') {
  return `<div class="cat-bar" aria-hidden="true"><span style="width:${share > 0 ? Math.max(2, Math.round(share * 100)) : 0}%${color ? `;background:${esc(color)}` : ''}"></span></div>`;
}

function dataTable(head, rows) {
  return `<details class="data-table"><summary>Ver dados em tabela</summary>
    <table><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`;
}

// Gráfico de linha/pontos em SVG. Interação (tocar/arrastar) em onChartPointer().
const charts = new Map();

/** Passo "redondo" (1, 2, 2,5 ou 5 × 10^k) para as linhas de grade. */
function niceStep(range, count) {
  const raw = range / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}

function lineChart({ id, labels, series, fmtY, fmtAxis = fmtY, height = 180, zero = false, minStep = 0, ariaLabel }) {
  const W = Math.max(260, Math.min(window.innerWidth || 390, 560) - 64);
  const H = height;
  const padT = 18;
  const padB = 24;
  const n = labels.length;
  const all = series.flatMap((s) => s.values);
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (zero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (hi === lo) hi = lo + Math.max(minStep, Math.abs(lo) * 0.1 || 1);
  const step = Math.max(minStep, niceStep(hi - lo, 2));
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  if (hi === lo) hi = lo + step;
  const ticks = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(t);

  const xs = labels.map((_, i) => (n === 1 ? W / 2 : 6 + (i * (W - 12)) / (n - 1)));
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);

  const grid = ticks
    .map(
      (t) => `<line class="grid" x1="0" x2="${W}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>
      <text class="ylab" x="2" y="${(y(t) - 4).toFixed(1)}">${esc(fmtAxis(t))}</text>`,
    )
    .join('');
  const zeroLine = zero && lo < 0 ? `<line class="zero" x1="0" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>` : '';

  const marks = series
    .map((s) => {
      const pts = s.values.map((v, i) => `${xs[i].toFixed(1)},${y(v).toFixed(1)}`);
      if (s.kind === 'dots') {
        return s.values
          .map((v, i) => `<circle class="pt ${s.cls}" cx="${xs[i].toFixed(1)}" cy="${y(v).toFixed(1)}" r="4.5"/>`)
          .join('');
      }
      const base = y(zero ? Math.max(lo, 0) : lo).toFixed(1);
      const area = s.area ? `<path class="area ${s.cls}" d="M${xs[0].toFixed(1)},${base} L${pts.join(' L')} L${xs[n - 1].toFixed(1)},${base} Z"/>` : '';
      const line = n > 1 ? `<polyline class="ln ${s.cls}" points="${pts.join(' ')}"/>` : '';
      const end = `<circle class="pt ${s.cls}" cx="${xs[n - 1].toFixed(1)}" cy="${y(s.values[n - 1]).toFixed(1)}" r="4"/>`;
      return area + line + end;
    })
    .join('');

  const xIdx = n > 2 ? [0, Math.floor((n - 1) / 2), n - 1] : n === 2 ? [0, 1] : [0];
  const xl = xIdx
    .map((i, k) => {
      const anchor = xIdx.length === 1 ? 'middle' : k === 0 ? 'start' : k === xIdx.length - 1 ? 'end' : 'middle';
      return `<text class="xlab" x="${xs[i].toFixed(1)}" y="${H - 6}" text-anchor="${anchor}">${esc(labels[i])}</text>`;
    })
    .join('');

  charts.set(id, { xs, labels, series: series.map((s) => ({ ...s, ys: s.values.map(y) })), fmtY, W });
  return `<div class="chart" data-chart="${id}" role="img" aria-label="${esc(ariaLabel)}">
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
      ${grid}${zeroLine}${marks}${xl}
      <g class="crosshair" hidden><line class="ch-line" y1="${padT}" y2="${H - padB}"/>
        ${series.map((s) => `<circle class="ch-dot ${s.cls}" r="5.5"/>`).join('')}</g>
    </svg>
    <div class="tip" hidden></div>
  </div>`;
}

function onChartPointer(e) {
  const el = e.target.closest?.('[data-chart]');
  if (!el) return;
  const c = charts.get(el.dataset.chart);
  if (!c) return;
  const svg = el.querySelector('svg');
  const x = e.clientX - svg.getBoundingClientRect().left;
  let i = 0;
  for (let k = 1; k < c.xs.length; k++) if (Math.abs(c.xs[k] - x) < Math.abs(c.xs[i] - x)) i = k;
  const g = el.querySelector('.crosshair');
  g.hidden = false;
  const line = g.querySelector('.ch-line');
  line.setAttribute('x1', c.xs[i]);
  line.setAttribute('x2', c.xs[i]);
  g.querySelectorAll('.ch-dot').forEach((d, k) => {
    d.setAttribute('cx', c.xs[i]);
    d.setAttribute('cy', c.series[k].ys[i]);
  });
  const tip = el.querySelector('.tip');
  tip.innerHTML = `<strong>${esc(c.labels[i])}</strong>${c.series
    .map((s) => `<span><i class="key ${s.cls}${s.kind === 'dots' ? ' dot' : ''}"></i>${esc(s.label)}: <b class="num">${esc(c.fmtY(s.values[i]))}</b></span>`)
    .join('')}`;
  tip.hidden = false;
  const tw = tip.offsetWidth;
  tip.style.left = `${Math.min(Math.max(0, c.xs[i] - tw / 2), c.W - tw)}px`;
}

function hideChartTip(e) {
  const el = e.target.closest?.('[data-chart]');
  if (!el || el.contains(e.relatedTarget) || e.pointerType === 'touch') return;
  el.querySelector('.crosshair').hidden = true;
  el.querySelector('.tip').hidden = true;
}

function renderAnalytics() {
  const txs = visibleTxs();
  const head = `<header class="large-title"><div><h1>Análises</h1></div></header>`;
  const status = loadingOrError();
  if (state.loading && !state.txs.length) return head + status;
  charts.clear();
  const today = todayISO();
  const parts = [head, scopeControl(), status];

  if (!txs.length) {
    parts.push(`<div class="state"><span class="emoji" aria-hidden="true">📊</span><h3>Ainda sem dados para analisar</h3>
      <p>Registre compras de dólar e gastos. As análises aparecem aqui automaticamente.</p>
      <button class="btn small" data-action="add">Adicionar registro</button></div>`);
  } else {
    parts.push(sectionBalance(txs, today), sectionDistribution(txs), sectionPurchases(txs));
  }
  parts.push(sectionCouple());
  return parts.join('');
}

// 1. Evolução do saldo
function sectionBalance(txs, today) {
  const days = state.anRange;
  const bs = balanceSeries(txs, today, days);
  const ranges = [7, 30, 90]
    .map((d) => `<button data-action="range" data-range="${d}" aria-pressed="${d === days}">${d} dias</button>`)
    .join('');
  const changeCls = bs.change > 0 ? 'pos' : bs.change < 0 ? 'neg' : '';
  const chart = lineChart({
    id: 'balance',
    labels: bs.points.map((p) => shortDate(p.date)),
    series: [{ label: 'Saldo', values: bs.points.map((p) => p.value), cls: 's1', area: true }],
    fmtY: (v) => formatMoney(Math.round(v), 'USD'),
    fmtAxis: (v) => 'US$ ' + Math.round(v / 100).toLocaleString('pt-BR'),
    minStep: 100, // nunca menos que US$ 1 entre as linhas
    zero: true,
    ariaLabel: `Saldo em dólar nos últimos ${days} dias: de ${FMT.usd(bs.opening)} para ${FMT.usd(bs.current)}`,
  });
  const changed = bs.points.filter((p, i) => i === 0 || p.value !== bs.points[i - 1].value || i === bs.points.length - 1);
  return card(
    'Evolução do saldo',
    `<div class="segmented inset" role="group" aria-label="Período">${ranges}</div>
     <div class="an-kpis">
       <div><div class="k">Saldo hoje</div><div class="v num">${FMT.usd(bs.current)}</div></div>
       <div><div class="k">Variação em ${days} dias</div><div class="v num ${changeCls}">${formatMoney(bs.change, 'USD', { signed: true })}</div></div>
     </div>
     ${chart}
     ${dataTable(['Dia', 'Saldo'], changed.map((p) => [shortDate(p.date), `<span class="num">${FMT.usd(p.value)}</span>`]))}`,
    {
      id: 'an-balance',
      note: 'Saldo em dólar no fim de cada dia: compras de dólar e entradas somam, gastos em dólar subtraem. Toque ou arraste no gráfico para ver cada dia.',
    },
  );
}

// 2. Distribuição dos gastos
function sectionDistribution(txs) {
  const cb = categoryBreakdown(txs);
  if (!cb.rows.length) {
    return card('Distribuição dos gastos', `<p class="muted" style="margin:0">Nenhum gasto registrado ainda.</p>`);
  }
  const max = cb.rows[0].total || cb.rows[0].usd || 1;
  const rows = cb.rows
    .map((r) => {
      const detail = cb.converted
        ? [FMT.brl(r.total), r.usd ? `${FMT.usd(r.usd)} em dólar${r.brl ? ` + ${FMT.brl(r.brl)}` : ''}` : '']
        : [r.usd ? FMT.usd(r.usd) : '', r.brl ? FMT.brl(r.brl) : ''];
      detail.push(`${r.count} ${r.count === 1 ? 'registro' : 'registros'}`);
      return `<div class="an-row">
        <span class="icon" aria-hidden="true">${r.icon}</span>
        <div class="main">
          <div class="an-row-top"><span>${esc(r.label)}</span><strong class="num">${pct(r.pct)}</strong></div>
          ${hbar((cb.converted ? r.total : r.total || r.usd) / max)}
          <div class="subtitle num">${detail.filter(Boolean).join(' · ')}</div>
        </div>
      </div>`;
    })
    .join('');
  const total = cb.converted
    ? `<div class="k">Total gasto (em reais)</div><div class="an-big num">≈ ${FMT.brl(cb.total)}</div>
       <div class="muted num" style="font-size:.85rem">${FMT.usd(cb.usdSpent)} em dólar + ${FMT.brl(cb.brlSpent)} em reais</div>`
    : `<div class="k">Total gasto</div><div class="an-big num">${FMT.usd(cb.usdSpent)} + ${FMT.brl(cb.brlSpent)}</div>`;
  return card('Distribuição dos gastos', `${total}<div class="an-divider"></div>${rows}`, {
    note: cb.converted
      ? `Para comparar tudo na mesma moeda, os gastos em dólar são convertidos pela sua cotação média (${FMT.rate(cb.rate)}).`
      : 'Registre uma compra de dólar para que os gastos em US$ e R$ sejam comparados na mesma moeda.',
  });
}

// 3. Histórico das compras de dólares
function sectionPurchases(txs) {
  const ph = purchaseHistory(txs);
  if (!ph) {
    return card(
      'Histórico das compras de dólar',
      `<p class="muted" style="margin:0 0 12px">Nenhuma compra de dólar registrada ainda.</p>
       <button class="btn small" data-action="add" data-kind="buy">Registrar compra</button>`,
    );
  }
  const chart =
    ph.count > 1
      ? `<div class="legend" aria-hidden="true"><span><i class="key s1"></i>Cotação média acumulada</span><span><i class="key s2 dot"></i>Cotação de cada compra</span></div>
         ${lineChart({
           id: 'rates',
           labels: ph.rows.map((r) => shortDate(r.occurred_on)),
           series: [
             { label: 'Média acumulada', values: ph.rows.map((r) => r.avgAfter), cls: 's1' },
             { label: 'Compra', values: ph.rows.map((r) => r.rate), cls: 's2', kind: 'dots' },
           ],
           fmtY: (v) => formatRate(Math.round(v * 10000) / 10000),
           fmtAxis: (v) => 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
           minStep: 0.01,
           height: 170,
           ariaLabel: `Cotação de ${ph.count} compras de dólar; média final ${FMT.rate(ph.avgRate)}`,
         })}`
      : '';
  const list = [...ph.rows]
    .reverse()
    .map((r) => {
      const diff = r.vsAvg;
      const diffText =
        Math.abs(diff) < 0.00005
          ? 'igual à média'
          : `${FMT.rate(Math.abs(diff))} ${diff > 0 ? 'acima' : 'abaixo'} da média`;
      return `<div class="an-row plain"><div class="main">
          <div class="an-row-top"><span>${shortDate(r.occurred_on)}${r.note ? ` · ${esc(r.note)}` : ''}${state.scope === 'couple' ? ` · ${esc(profile(r.author).name)}` : ''}</span>
            <strong class="num">${FMT.rate(r.rate)}</strong></div>
          <div class="an-row-top subtitle num"><span>${FMT.usd(r.amount_cents)} por ${FMT.brl(r.brl_cents)}</span>
            <span>${r === ph.best && ph.count > 1 ? '🏆 melhor' : diffText}</span></div>
        </div></div>`;
    })
    .join('');
  return card(
    'Histórico das compras de dólar',
    `<div class="an-kpis three">
       <div><div class="k">Média</div><div class="v num">${FMT.rate(ph.avgRate)}</div></div>
       <div><div class="k">Melhor</div><div class="v num">${FMT.rate(ph.best.rate)}</div></div>
       <div><div class="k">Pior</div><div class="v num">${FMT.rate(ph.worst.rate)}</div></div>
     </div>
     ${
       ph.count > 1 && ph.extraVsBest > 0
         ? `<p class="an-text">Se todas as ${ph.count} compras tivessem sido na melhor cotação, você teria pago <strong class="num">${FMT.brl(ph.extraVsBest)}</strong> a menos.</p>`
         : ''
     }
     ${chart}
     <div class="an-divider"></div>${list}`,
    {
      note:
        ph.count > 1
          ? 'A linha mostra como sua cotação média foi mudando a cada compra. Os pontos são a cotação de cada compra.'
          : 'Com duas ou mais compras aparece o gráfico da evolução da cotação média.',
    },
  );
}

// 4. Comparativo do casal (sempre os dois, independente de Meus/Casal)
function sectionCouple() {
  const people = coupleComparison(state.txs, CONFIG.users);
  if (!state.txs.length) return '';
  const metrics = [
    ['Saldo atual em dólar', 'balance', FMT.usd],
    ['Dólares comprados', 'bought', FMT.usd],
    ['Investido em reais', 'brlPaid', FMT.brl],
    ['Gastos em dólar', 'usdSpent', FMT.usd],
    ['Gastos em reais', 'brlSpent', FMT.brl],
  ];
  const blocks = metrics
    .map(([label, key, fmt]) => {
      const max = Math.max(1, ...people.map((p) => Math.max(0, p[key])));
      return `<div class="cmp">
        <div class="k">${label}</div>
        ${people
          .map(
            (p) => `<div class="cmp-row">
              <span class="cmp-name">${esc(p.name)}</span>
              <div class="cmp-bar">${hbar(Math.max(0, p[key]) / max, p.color)}</div>
              <span class="num cmp-val">${fmt(p[key])}</span>
            </div>`,
          )
          .join('')}
      </div>`;
    })
    .join('');
  const rated = people.filter((p) => p.avgRate != null);
  let rateText = '';
  if (rated.length === people.length && people.length === 2) {
    const [a, b] = people;
    const cheaper = a.avgRate < b.avgRate ? a : b.avgRate < a.avgRate ? b : null;
    rateText = `<p class="an-text">Cotação média: ${esc(a.name)} <strong class="num">${FMT.rate(a.avgRate)}</strong> · ${esc(b.name)} <strong class="num">${FMT.rate(b.avgRate)}</strong>.
      ${cheaper ? `${esc(cheaper.name)} comprou dólar mais barato.` : 'Os dois pagaram a mesma cotação média.'}</p>`;
  }
  const legend = `<div class="legend" aria-hidden="true">${people.map((p) => `<span><i class="key" style="background:${esc(p.color)}"></i>${esc(p.name)}</span>`).join('')}</div>`;
  return card(`Comparativo do casal`, legend + blocks + rateText, {
    note: 'Este comparativo sempre mostra os dois, mesmo na visão "Meus".',
  });
}

/** "Nós dois": as fotos do casal lado a lado (toque para ver grande). */
function coupleSection() {
  if (CONFIG.users.length < 2) return '';
  return `<h2 class="section-title">Nós dois</h2>
    <div class="group couple-card">${CONFIG.users
      .map((u) => {
        const has = !!state.avatars[u.username];
        return `<button type="button" class="couple-person" ${has ? `data-action="view-photo" data-user="${u.username}"` : 'disabled'}
          aria-label="${esc(u.name)}${has ? ' — ver foto' : ' — sem foto ainda'}">
          ${avatar(u.username, 'xl')}<span class="couple-name">${esc(u.name)}${u.username === state.user.username ? ' <small>(você)</small>' : ''}</span>
          ${has ? '' : '<span class="couple-empty">sem foto ainda</span>'}
        </button>`;
      })
      .join('<span class="couple-heart" aria-hidden="true">❤️</span>')}</div>`;
}

function renderSettings() {
  const cloud = state.store.mode === 'cloud';
  const themes = [
    ['system', 'Automático'],
    ['light', 'Claro'],
    ['dark', 'Escuro'],
  ];
  return `
    <header class="large-title"><div><h1>Ajustes</h1></div></header>
    <div class="group">
      <div class="row profile-row">
        <label for="photo-input" class="avatar-edit${state.photoBusy ? ' busy' : ''}" aria-label="Alterar minha foto de perfil">
          ${avatar(state.user.username, 'lg')}<span class="cam" aria-hidden="true">📷</span>
        </label>
        <div class="main"><div class="title" style="font-size:1.2rem;font-weight:600">${esc(state.user.name)}</div>
        <div class="subtitle">${cloud ? '☁️ Conta com sincronização' : '📱 Modo local — só neste aparelho'}</div>
        <div class="photo-actions">
          <label for="photo-input" class="link-btn">${state.photoBusy ? 'Salvando…' : state.avatars[state.user.username] ? 'Alterar foto' : 'Adicionar foto'}</label>
          ${state.avatars[state.user.username] && !state.photoBusy ? '<button type="button" class="link-btn danger" data-action="remove-photo">Remover</button>' : ''}
        </div></div>
      </div>
      <input type="file" id="photo-input" accept="image/*" hidden ${state.photoBusy ? 'disabled' : ''} />
    </div>
    ${coupleSection()}
    ${
      cloud
        ? ''
        : `<div class="banner warn" style="margin-top:12px">⚠️ <span class="grow">No modo local os dados não sincronizam com o outro celular e podem ser perdidos se o Safari limpar os dados do site. Configure o Supabase (README) antes da viagem.</span></div>`
    }

    ${achievementsSection()}
    ${state.store.status ? `<h2 class="section-title">Sincronização</h2>${offlinePanel()}` : ''}

    <h2 class="section-title">Aparência</h2>
    <div class="segmented" role="radiogroup" aria-label="Tema">
      ${themes.map(([id, l]) => `<button role="radio" data-action="theme" data-theme="${id}" aria-checked="${state.theme === id}">${l}</button>`).join('')}
    </div>

    <h2 class="section-title">Dados</h2>
    <div class="group">
      <button class="row plain link" data-action="export">Exportar planilha (CSV)<span class="chev" aria-hidden="true" style="margin-left:auto">›</span></button>
      <button class="row plain link" data-action="retry">Atualizar dados<span class="chev" aria-hidden="true" style="margin-left:auto">›</span></button>
    </div>

    <h2 class="section-title">Instalar no iPhone</h2>
    <div class="group">
      <ol class="install-steps">
        <li>Abra o DolarMap no <strong>Safari</strong>.</li>
        <li>Toque em <strong>Compartilhar</strong> (quadrado com seta).</li>
        <li>Escolha <strong>Adicionar à Tela de Início</strong>.</li>
      </ol>
    </div>

    <h2 class="section-title">Conta</h2>
    <div class="group">
      <button class="row plain destructive" data-action="logout">Sair</button>
    </div>
    <button type="button" class="readonly-note secret-link" data-action="secret">DolarMap Offline · Versão de teste · ${state.txs.length} registro(s)</button>`;
}

// ---------------------------------------------------------------- formulário (sheet)

let sheet;
let draft;
let editing = null;

function ensureSheet() {
  if (sheet) return sheet;
  sheet = document.createElement('dialog');
  sheet.className = 'sheet';
  sheet.setAttribute('aria-labelledby', 'sheet-title');
  document.body.appendChild(sheet);
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) closeSheet(); // toque no fundo escuro
  });
  sheet.addEventListener('click', onSheetClick);
  sheet.addEventListener('input', onSheetInput);
  sheet.addEventListener('submit', (e) => {
    e.preventDefault();
    saveDraft();
  });
  sheet.addEventListener('close', () => {
    document.body.style.overflow = '';
    sheet.classList.remove('kb');
    showNextCelebration(); // conquista que esperava o formulário fechar
  });
  // Esc / gesto de voltar: fecha com a mesma animação.
  sheet.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeSheet();
  });
  setupKeyboardAvoidance(sheet);
  return sheet;
}

/**
 * No iOS o teclado não encolhe a página: ele cobre a parte de baixo. Medimos a área
 * realmente visível (visualViewport) e encaixamos o sheet nela, para que data e
 * Salvar continuem alcançáveis rolando o formulário.
 */
function setupKeyboardAvoidance(sheet) {
  const vv = window.visualViewport;
  const isTextField = (el) =>
    el && el.matches?.('input:not([type=date]):not([type=button]):not([type=submit]), textarea');

  const fit = () => {
    if (!vv || !sheet.open) return;
    const hidden = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    if (hidden > 80) {
      sheet.style.setProperty('--kb-bottom', `${Math.round(hidden)}px`);
      sheet.style.setProperty('--vv-h', `${Math.round(vv.height)}px`);
      sheet.classList.add('kb');
    } else {
      sheet.classList.remove('kb');
    }
  };
  if (vv) {
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
  }

  // Ao focar um campo, garante que ele fique visível acima do teclado (depois da animação).
  sheet.addEventListener('focusin', (e) => {
    if (!isTextField(e.target)) return;
    setTimeout(() => {
      fit();
      e.target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 320);
  });

  // O teclado numérico do iPhone não tem "OK": tocar fora de um campo de texto fecha o teclado.
  sheet.addEventListener('pointerdown', (e) => {
    const active = document.activeElement;
    // Botões ficam de fora: fechar o teclado no meio do toque mexeria o layout sob o dedo.
    if (isTextField(active) && !e.target.closest?.('input, textarea, select, button, label, a')) active.blur();
  });
}

let lastExpenseCategory = 'alimentacao';

function openSheet({ tx = null, kind = 'expense', currency = 'USD' } = {}) {
  ensureSheet();
  if (closeTimer) finishClose(); // abriu de novo durante a animação de fechar
  if (sheet.open) return;
  editing = tx;
  draft = tx
    ? {
        kind: tx.kind,
        amount: centsToInput(tx.amount_cents),
        currency: tx.currency,
        brl: tx.brl_cents ? centsToInput(tx.brl_cents) : '',
        category: tx.category,
        note: tx.note || '',
        date: tx.occurred_on,
      }
    : {
        kind,
        amount: '',
        currency,
        brl: '',
        category: kind === 'income' ? 'salario' : kind === 'buy' ? BUY_CATEGORY.id : currency === 'BRL' ? 'visto' : lastExpenseCategory,
        note: '',
        date: todayISO(),
      };
  renderSheet();
  sheet.showModal();
  document.body.style.overflow = 'hidden';
  // Foco imediato no valor: o teclado numérico abre na hora (precisa ser síncrono ao toque no iOS).
  if (!tx || isMine(tx)) sheet.querySelector('#amount')?.focus();
}

// Fecha deslizando para baixo (como no iOS) e só então fecha o <dialog> de fato.
let closeTimer = null;
function closeSheet() {
  if (!sheet?.open || closeTimer) return;
  if (reduceMotion()) return sheet.close();
  sheet.classList.add('closing');
  closeTimer = setTimeout(finishClose, 220);
}
function finishClose() {
  clearTimeout(closeTimer);
  closeTimer = null;
  sheet.classList.remove('closing');
  if (sheet.open) sheet.close();
}

const isMine = (tx) => tx.author === state.user.username;

function renderSheet(errors = {}, busy = false) {
  const ro = editing && !isMine(editing);
  const d = draft;
  const isBuy = d.kind === 'buy';
  const cats = categoriesFor(d.kind);
  const curLabel = d.currency === 'BRL' ? 'R$' : 'US$';
  const title = editing ? (ro ? 'Detalhes' : 'Editar registro') : 'Novo registro';
  const dis = ro ? 'disabled' : '';

  sheet.innerHTML = `
    <form novalidate>
      <div class="sheet-head">
        <button type="button" class="text-btn" data-action="close">${ro ? 'Fechar' : 'Cancelar'}</button>
        <h2 id="sheet-title">${title}</h2>
        <div class="right">${ro ? '' : `<button type="submit" class="text-btn bold" ${busy ? 'disabled' : ''}>Salvar</button>`}</div>
      </div>
      <div class="sheet-body">
        ${
          editing
            ? ''
            : `<div class="segmented" role="radiogroup" aria-label="Tipo de registro">
          ${Object.values(KINDS)
            .map((k) => `<button type="button" role="radio" data-action="kind" data-kind="${k.id}" aria-checked="${d.kind === k.id}">${k.label}</button>`)
            .join('')}
        </div>`
        }

        <div class="amount-box">
          <div class="cap" id="amount-cap">${isBuy ? 'Quantos dólares você comprou?' : d.kind === 'income' ? 'Quanto você recebeu?' : 'Quanto custou?'}</div>
          <div class="amount-line">
            ${
              d.kind === 'expense'
                ? `<button type="button" class="cur-btn" data-action="currency" ${dis} aria-label="Moeda: ${d.currency === 'BRL' ? 'reais' : 'dólares'}. Toque para trocar.">${curLabel}</button>`
                : `<span class="cur-btn static" aria-hidden="true">US$</span>`
            }
            <input class="amount-input rounded num" id="amount" name="amount" inputmode="decimal" autocomplete="off"
              placeholder="0,00" value="${esc(d.amount)}" aria-labelledby="amount-cap" aria-describedby="amount-err" ${dis} />
          </div>
          <div class="error-text" id="amount-err" role="alert">${esc(errors.amount || '')}</div>
        </div>

        ${
          isBuy
            ? `<div class="amount-box">
          <div class="cap" id="brl-cap">Quanto você pagou em reais?</div>
          <div class="amount-line">
            <span class="cur-btn static" aria-hidden="true">R$</span>
            <input class="amount-input rounded num" id="brl" name="brl" inputmode="decimal" autocomplete="off" placeholder="0,00"
              value="${esc(d.brl)}" aria-labelledby="brl-cap" aria-describedby="brl-err rate-hint" ${dis} />
          </div>
          <div class="hint num" id="rate-hint">${rateHint()}</div>
          <div class="error-text" id="brl-err" role="alert">${esc(errors.brl || '')}</div>
        </div>`
            : `<h3 class="section-title" id="cat-label">Categoria</h3>
        <div class="cats" role="radiogroup" aria-labelledby="cat-label">
          ${cats
            .map(
              (c) => `<button type="button" class="cat" role="radio" data-action="cat" data-cat="${c.id}" aria-checked="${d.category === c.id}" ${dis}>
                <span class="e" aria-hidden="true">${c.icon}</span>${esc(c.label)}</button>`,
            )
            .join('')}
        </div>
        <div class="error-text" style="margin:6px 20px 0" role="alert">${esc(errors.category || '')}</div>`
        }

        <h3 class="section-title">Detalhes</h3>
        <div class="group">
          <div class="form-row"><label for="note">Descrição</label>
            <input id="note" name="note" maxlength="120" placeholder="${isBuy ? 'Ex.: casa de câmbio' : 'Ex.: biscoito'}" value="${esc(d.note)}" autocomplete="off" enterkeyhint="done" ${dis} /></div>
          <div class="form-row"><label for="date">Data</label>
            <input id="date" name="date" type="date" value="${esc(d.date)}" required ${dis} /></div>
          ${editing && state.scope === 'couple' ? `<div class="form-row"><label>Quem</label><span style="margin-left:auto" class="muted">${esc(profile(editing.author).name)}</span></div>` : ''}
        </div>
        <div class="error-text" style="margin:6px 20px 0" role="alert">${esc(errors.note || errors.date || errors.form || '')}</div>

        ${
          ro
            ? `<p class="readonly-note">Registro de ${esc(profile(editing.author).name)} — só ${esc(profile(editing.author).name)} pode editar.</p>`
            : `<div class="sheet-actions">
          <button type="submit" class="btn" ${busy ? 'disabled' : ''}>${busy ? '<span class="spinner" aria-hidden="true"></span> Salvando…' : 'Salvar'}</button>
          ${editing ? `<button type="button" class="btn danger" data-action="delete" ${busy ? 'disabled' : ''}>Apagar registro</button>` : ''}
        </div>`
        }
      </div>
    </form>`;
}

function rateHint() {
  const usd = parseMoney(draft.amount);
  const brl = parseMoney(draft.brl);
  const r = rateOf(usd, brl);
  return r ? `Cotação: ${formatRate(r)} por dólar` : 'A cotação é calculada automaticamente.';
}

function onSheetClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const a = el.dataset.action;
  if (a === 'close') closeSheet();
  else if (a === 'kind') {
    syncDraftFromInputs();
    const kind = el.dataset.kind;
    if (kind === draft.kind) return;
    draft.kind = kind;
    draft.category = kind === 'income' ? 'salario' : kind === 'buy' ? BUY_CATEGORY.id : lastExpenseCategory;
    if (kind !== 'expense') draft.currency = 'USD';
    renderSheet();
    sheet.querySelector('#amount')?.focus();
  } else if (a === 'currency') {
    draft.currency = draft.currency === 'USD' ? 'BRL' : 'USD';
    el.textContent = draft.currency === 'BRL' ? 'R$' : 'US$';
    el.setAttribute('aria-label', `Moeda: ${draft.currency === 'BRL' ? 'reais' : 'dólares'}. Toque para trocar.`);
  } else if (a === 'cat') {
    draft.category = el.dataset.cat;
    sheet.querySelectorAll('[data-action="cat"]').forEach((b) => b.setAttribute('aria-checked', String(b === el)));
  } else if (a === 'delete') deleteEditing();
}

function onSheetInput(e) {
  const { name, value } = e.target;
  if (name in draft) draft[name] = value;
  if (name === 'amount' || name === 'brl') {
    const hint = sheet.querySelector('#rate-hint');
    if (hint) hint.textContent = rateHint();
  }
}

function syncDraftFromInputs() {
  sheet.querySelectorAll('input[name]').forEach((i) => (draft[i.name] = i.value));
}

let saving = false;
async function saveDraft() {
  if (saving || (editing && !isMine(editing))) return;
  syncDraftFromInputs();
  const { ok, errors, value } = validateDraft(draft);
  if (!ok) {
    renderSheet(errors);
    const firstBad = errors.amount ? '#amount' : errors.brl ? '#brl' : errors.note ? '#note' : errors.date ? '#date' : null;
    if (firstBad) sheet.querySelector(firstBad)?.focus();
    return;
  }
  saving = true;
  renderSheet({}, true);
  try {
    if (editing) {
      const row = await state.store.update(editing.id, value);
      state.txs = sortTxs(state.txs.map((t) => (t.id === row.id ? row : t)));
      state.flashId = row.id;
      toast(row.pending ? 'Alterações salvas neste aparelho — pendentes de sincronização' : 'Alterações salvas ✓');
    } else {
      const row = await state.store.create(value);
      state.txs = sortTxs([row, ...state.txs]);
      state.flashId = row.id;
      if (value.kind === 'expense' && value.currency === 'USD') lastExpenseCategory = value.category;
      toast(row.pending ? 'Registro salvo neste aparelho — pendente de sincronização' : value.kind === 'expense' ? `Gasto de ${formatMoney(value.amount_cents, value.currency)} salvo ✓` : 'Registro salvo ✓');
    }
    saving = false;
    closeSheet();
    render();
    state.flashId = null; // o destaque vale só para este render
    checkAchievements();
    if (state.store.sync && navigator.onLine !== false) void loadData({ silent: true });
  } catch (err) {
    saving = false;
    if (err.code === 'session_expired') {
      closeSheet();
      return handleSessionExpired();
    }
    renderSheet({ form: `${err.message || 'Não foi possível salvar.'} Seus dados continuam aqui — tente de novo.` });
  }
}

async function deleteEditing() {
  if (!editing || !confirm('Apagar este registro? Essa ação não pode ser desfeita.')) return;
  renderSheet({}, true);
  try {
    await state.store.remove(editing.id);
    state.txs = state.txs.filter((t) => t.id !== editing.id);
    closeSheet();
    render();
    toast('Registro apagado');
    forgetLostAchievements();
  } catch (err) {
    renderSheet({ form: err.message || 'Não foi possível apagar.' });
  }
}

// ---------------------------------------------------------------- conquistas

const achKey = () => `dolarmap.achievements.v1.${state.user.username}`;

function readSeen() {
  try {
    const raw = localStorage.getItem(achKey());
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Compara as conquistas atuais com as já comemoradas neste aparelho.
 * Na primeira vez (ou em aparelho novo) só registra, sem comemorar o passado.
 */
function checkAchievements() {
  if (!state.user) return;
  const current = achievementsFor(state.txs, state.user.username, { couple: CONFIG.users.length > 1 });
  const seen = readSeen();
  const fresh = seen ? newAchievements(current, seen) : [];
  writePref(achKey(), JSON.stringify([...new Set([...(seen || []), ...current.map((a) => a.id)])]));
  if (!fresh.length) return;
  celebrationQueue.push(...fresh);
  setTimeout(showNextCelebration, 450);
}

/**
 * Apagar um registro é "desfazer": marcos que deixaram de existir voltam a poder ser
 * comemorados (ex.: compra de teste apagada). Gastar dinheiro não faz isso — só apagar.
 */
function forgetLostAchievements() {
  const seen = readSeen();
  if (!seen) return;
  const now = new Set(achievementsFor(state.txs, state.user.username, { couple: CONFIG.users.length > 1 }).map((a) => a.id));
  writePref(achKey(), JSON.stringify(seen.filter((id) => now.has(id))));
}

function achievementCopy(a) {
  const other = otherUser();
  const k = (a.cents || 0) / 100;
  const personalLines = {
    500: 'Meio caminho pro primeiro mil! 🚀',
    1000: 'Mil doletas! A viagem tá ficando real. 🇺🇸',
    1500: 'Tá voando! Já dá pra muita aventura. ✈️',
    2000: 'Dois mil! Cofrinho americano de respeito. 🐷',
    3000: 'Três mil! Que planejamento, hein? 📈',
    5000: 'Cinco mil dólares! Lenda do câmbio. 👑',
  };
  const fallback = ['Mais um degrau rumo aos EUA! 🗽', 'Cada dólar conta — e você tá contando bem! 💪', 'Orgulho desse saldo! 🌟'];
  switch (a.type) {
    case 'balance':
      return {
        icon: '🏆',
        kicker: 'Você atingiu',
        value: formatMoney(a.cents, 'USD').replace(/,00$/, ''),
        countTo: a.cents,
        line: personalLines[k] || fallback[(k / 500) % fallback.length],
        foot: 'Seu saldo em dólar chegou lá!',
      };
    case 'couple':
      return {
        icon: '💑',
        kicker: 'Juntos, vocês atingiram',
        value: formatMoney(a.cents, 'USD').replace(/,00$/, ''),
        countTo: a.cents,
        line: `${esc(state.user.name)} + ${esc(other?.name || '')} = time imbatível! 💙❤️`,
        foot: 'Saldo do casal em dólar',
      };
    case 'first-buy':
      return { icon: '💵', kicker: 'Conquista desbloqueada', title: 'Primeira compra de dólar!', line: 'O primeiro passo da viagem está dado. ✈️' };
    case 'first-income':
      return { icon: '💼', kicker: 'Conquista desbloqueada', title: 'Primeiro salário em dólar!', line: 'Work and Travel de verdade! Bora! 🇺🇸' };
    default:
      return { icon: '⭐', kicker: 'Conquista', title: 'Muito bem!', line: '' };
  }
}

const celebrationQueue = [];
let celebrateEl = null;

function showNextCelebration() {
  if (celebrateEl || !celebrationQueue.length || sheet?.open || loveSheet?.open) return; // espera o formulário fechar
  celebrate(celebrationQueue.shift());
}

function celebrate(a) {
  if (a.type === 'letter') return showLetter(a.note);
  const c = achievementCopy(a);
  const colors = ['#34C759', '#FFD60A', '#0A84FF', '#FF375F', '#FF9F0A', '#BF5AF2'];
  const confetti = reduceMotion()
    ? ''
    : Array.from({ length: 70 }, (_, i) => {
        const bill = i % 9 === 0;
        const style = [
          `--x:${(Math.random() * 100).toFixed(1)}vw`,
          `--drift:${(Math.random() * 30 - 15).toFixed(1)}vw`,
          `--rot:${Math.round(Math.random() * 720 - 360)}deg`,
          `--d:${(Math.random() * 0.9).toFixed(2)}s`,
          `--t:${(2.4 + Math.random() * 1.8).toFixed(2)}s`,
          bill ? '' : `background:${colors[i % colors.length]}`,
        ].join(';');
        return bill ? `<i class="bill" style="${style}">💵</i>` : `<i style="${style}"></i>`;
      }).join('');

  const el = document.createElement('div');
  el.className = 'celebrate';
  el.setAttribute('role', 'alertdialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'cel-title');
  el.innerHTML = `
    <div class="cel-confetti" aria-hidden="true">${confetti}</div>
    <div class="cel-card">
      <div class="cel-medal" aria-hidden="true"><span class="cel-rays"></span><span class="cel-icon">${c.icon}</span></div>
      <p class="cel-kicker">${c.kicker}</p>
      ${
        c.value
          ? `<h2 class="cel-value num" id="cel-title"><span class="sr-only">${c.value}</span><span aria-hidden="true" data-cel-to="${c.countTo}">US$ 0</span><span class="cel-bang" aria-hidden="true">!</span></h2>`
          : `<h2 class="cel-title" id="cel-title">${c.title}</h2>`
      }
      <p class="cel-line">${c.line}</p>
      ${c.foot ? `<p class="cel-foot">${c.foot}</p>` : ''}
      <button type="button" class="btn cel-ok" data-cel="ok">Bora! 🎉</button>
    </div>`;
  document.body.appendChild(el);
  celebrateEl = el;
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => el.classList.add('in'));
  el.querySelector('.cel-ok').focus({ preventScroll: true });

  // Número da conquista sobe de 0 até o valor.
  const num = el.querySelector('[data-cel-to]');
  if (num) {
    const to = Number(num.dataset.celTo);
    const fmt = (v) => formatMoney(v, 'USD').replace(/,\d\d$/, '');
    if (reduceMotion()) num.textContent = fmt(to);
    else {
      const t0 = performance.now() + 350;
      const step = (now) => {
        if (!num.isConnected) return;
        const k = Math.min(1, Math.max(0, (now - t0) / 1100));
        num.textContent = fmt(Math.round((to * (1 - Math.pow(1 - k, 4))) / 100) * 100);
        if (k < 1) requestAnimationFrame(step);
        else num.parentElement.classList.add('done');
      };
      requestAnimationFrame(step);
    }
  }

  const dismiss = () => {
    if (el.classList.contains('out')) return;
    el.classList.add('out');
    setTimeout(
      () => {
        el.remove();
        celebrateEl = null;
        if (!sheet?.open) document.body.style.overflow = '';
        showNextCelebration();
      },
      reduceMotion() ? 0 : 260,
    );
  };
  el.addEventListener('click', (e) => {
    // Toque no botão ou fora do cartão fecha; dentro do cartão, não (evita fechar sem querer).
    if (e.target.closest('[data-cel="ok"]') || !e.target.closest('.cel-card')) dismiss();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dismiss();
    if (e.key === 'Tab') e.preventDefault(); // único botão: mantém o foco no alerta
  });
}

// ---------------------------------------------------------------- cartinha secreta 💌

const shownNotes = new Set(); // não mostra a mesma cartinha duas vezes na mesma sessão

async function checkNotes() {
  if (!state.user || !state.store.inbox) return;
  try {
    const me = state.user.username;
    const notes = await state.store.inbox(me);
    if (state.user?.username !== me) return; // trocou de conta enquanto buscava
    const fresh = notes.filter((n) => !shownNotes.has(n.id));
    if (!fresh.length) return;
    fresh.forEach((n) => shownNotes.add(n.id));
    // Cartinha tem prioridade sobre as conquistas na fila.
    celebrationQueue.unshift(...fresh.map((note) => ({ type: 'letter', note })));
    setTimeout(showNextCelebration, 500);
  } catch {
    /* tabela ainda não criada ou sem internet: tenta de novo depois, sem incomodar */
  }
}

// Enquanto o app está aberto, olha a caixa de cartinhas de tempos em tempos.
setInterval(() => {
  if (document.visibilityState === 'visible') checkNotes();
}, 30000);

let loveSheet;
let sentCache = [];

function openLoveSheet() {
  const to = otherUser();
  if (!to) return;
  if (!loveSheet) {
    loveSheet = document.createElement('dialog');
    loveSheet.className = 'sheet love-sheet';
    loveSheet.setAttribute('aria-labelledby', 'love-title');
    document.body.appendChild(loveSheet);
    setupKeyboardAvoidance(loveSheet);
    loveSheet.addEventListener('click', (e) => {
      if (e.target === loveSheet || e.target.closest('[data-love="close"]')) loveSheet.close();
    });
    loveSheet.addEventListener('input', (e) => {
      if (e.target.id !== 'love-msg') return;
      loveSheet.querySelector('#love-count').textContent = `${e.target.value.length}/600`;
      loveSheet.querySelector('#love-send').disabled = !e.target.value.trim();
    });
    loveSheet.addEventListener('submit', (e) => {
      e.preventDefault();
      sendLoveNote();
    });
    loveSheet.addEventListener('close', () => {
      document.body.style.overflow = '';
      loveSheet.classList.remove('kb');
      showNextCelebration();
    });
  }
  loveSheet.innerHTML = `
    <form novalidate>
      <div class="sheet-head">
        <button type="button" class="text-btn" data-love="close">Fechar</button>
        <h2 id="love-title">Cartinha secreta</h2>
        <div class="right"></div>
      </div>
      <div class="sheet-body">
        <div class="love-hero" aria-hidden="true">💌</div>
        <p class="love-intro">Escreva uma mensagem para <strong>${esc(to.name)}</strong>. Ela vai abrir como uma cartinha na tela ${
          to.username === 'manuela' ? 'dela' : 'dele'
        } assim que ${to.username === 'manuela' ? 'ela' : 'ele'} usar ou abrir o app.</p>
        <div class="love-field">
          <textarea id="love-msg" maxlength="600" rows="7" autofocus placeholder="Para ${esc(to.name)}…" aria-label="Mensagem para ${esc(to.name)}"></textarea>
          <div class="love-meta"><span>De: ${esc(state.user.name)} ❤️</span><span id="love-count">0/600</span></div>
        </div>
        <p class="error-text" id="love-err" role="alert"></p>
        <div class="sheet-actions"><button type="submit" class="btn love-btn" id="love-send" disabled>Enviar cartinha 💌</button></div>
        <div id="love-sent">${sentList()}</div>
      </div>
    </form>`;
  loveSheet.showModal();
  document.body.style.overflow = 'hidden';
  state.store
    .sentNotes?.(state.user.username)
    .then((rows) => {
      sentCache = rows;
      const box = loveSheet.querySelector('#love-sent');
      if (box) box.innerHTML = sentList();
    })
    .catch(() => {});
}

function sentList() {
  if (!sentCache.length) return '';
  const fmt = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `<h2 class="section-title">Últimas enviadas</h2><div class="group">${sentCache
    .map(
      (n) => `<div class="row"><div class="main"><div class="title love-preview">${esc(n.message)}</div>
        <div class="subtitle">${fmt(n.created_at)} · ${n.opened_at ? `💖 Aberta ${fmt(n.opened_at)}` : '✉️ Ainda não aberta'}</div></div></div>`,
    )
    .join('')}</div>`;
}

let sendingNote = false;
async function sendLoveNote() {
  const ta = loveSheet.querySelector('#love-msg');
  const msg = ta.value.trim();
  const err = loveSheet.querySelector('#love-err');
  const btn = loveSheet.querySelector('#love-send');
  if (!msg || sendingNote) return;
  if (typeof state.store.sendNote !== 'function') {
    // Navegador misturou arquivos novos com antigos do cache.
    err.textContent = 'O app está com uma versão antiga guardada. Feche esta aba e abra o app de novo.';
    return;
  }
  sendingNote = true;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Enviando…';
  err.textContent = '';
  try {
    const note = await state.store.sendNote(otherUser().username, msg);
    loveSheet.close();
    toast(`Cartinha enviada para ${otherUser().name} 💌`);
    // Modo teste: abre a cartinha na minha tela também.
    if (CONFIG.loveNoteEchoToSender) {
      celebrationQueue.unshift({ type: 'letter', note: { ...note, from: state.user.username, to: otherUser().username, echo: true } });
      setTimeout(showNextCelebration, 600);
    }
  } catch (e) {
    err.textContent = e.message || 'Não foi possível enviar. Tente de novo.';
    btn.disabled = false;
    btn.textContent = 'Enviar cartinha 💌';
  } finally {
    sendingNote = false;
  }
}

/** Cartinha: envelope com selo de coração → toque → aba abre, papel sobe e vira a carta. */
function showLetter(note) {
  const from = profile(note.from);
  const to = profile(note.to);
  const hearts = reduceMotion()
    ? ''
    : Array.from({ length: 18 }, () => {
        const style = [
          `--x:${(Math.random() * 100).toFixed(1)}vw`,
          `--s:${(0.7 + Math.random() * 1.1).toFixed(2)}`,
          `--d:${(Math.random() * 6).toFixed(2)}s`,
          `--t:${(5 + Math.random() * 4).toFixed(2)}s`,
          `--drift:${(Math.random() * 40 - 20).toFixed(0)}px`,
        ].join(';');
        return `<i style="${style}">${Math.random() < 0.7 ? '❤' : '♡'}</i>`;
      }).join('');
  const when = new Date(note.created_at || Date.now()).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' });

  const el = document.createElement('div');
  el.className = 'letter';
  el.setAttribute('role', 'alertdialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', `Cartinha de ${from.name}`);
  el.innerHTML = `
    <div class="letter-hearts" aria-hidden="true">${hearts}</div>
    <div class="letter-stage">
      <p class="letter-kicker">Você recebeu uma cartinha 💌</p>
      <button type="button" class="envelope" data-letter="open" aria-label="Abrir a cartinha de ${esc(from.name)}">
        <span class="env-back"></span>
        <span class="env-paper"><span></span><span></span><span></span></span>
        <span class="env-front"></span>
        <span class="env-flap"></span>
        <span class="env-seal">❤</span>
      </button>
      <p class="letter-hint">De: <strong>${esc(from.name)}</strong> · toque para abrir</p>
    </div>
    <div class="letter-card" role="document">
      <p class="lc-to">Para ${esc(to.name)},</p>
      <div class="lc-msg">${esc(note.message)}</div>
      <p class="lc-from">Com carinho, ${esc(from.name)}&nbsp;❤️</p>
      <p class="lc-date">${when}${note.echo ? ' · modo teste (só você está vendo esta cópia)' : ''}</p>
      <button type="button" class="btn love-btn" data-letter="close">Fechar ❤️</button>
    </div>`;
  document.body.appendChild(el);
  celebrateEl = el;
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => el.classList.add('in'));
  el.querySelector('.envelope').focus({ preventScroll: true });

  let opened = false;
  const open = () => {
    if (opened) return;
    opened = true;
    el.classList.add('opening');
    setTimeout(() => {
      el.classList.add('reading');
      el.querySelector('[data-letter="close"]').focus({ preventScroll: true });
    }, reduceMotion() ? 0 : 1300);
    // Marca como aberta (o remetente vê "💖 Aberta"). A cópia de teste não conta.
    if (!note.echo) state.store.markNoteOpened?.(note.id).catch(() => {});
  };
  const close = () => {
    if (el.classList.contains('out')) return;
    el.classList.add('out');
    setTimeout(
      () => {
        el.remove();
        celebrateEl = null;
        if (!sheet?.open) document.body.style.overflow = '';
        showNextCelebration();
      },
      reduceMotion() ? 0 : 350,
    );
  };
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-letter="open"]')) open();
    else if (e.target.closest('[data-letter="close"]')) close();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && opened) close();
  });
}

function achievementsSection() {
  const all = achievementsFor(state.txs, state.user.username, { couple: CONFIG.users.length > 1 });
  const top = topPerType(all);
  const rows = top.length
    ? top
        .map((a) => {
          const c = achievementCopy(a);
          const title = {
            balance: `Saldo de ${c.value}`,
            couple: `Casal: ${c.value}`,
            'first-buy': '1ª compra de dólar',
            'first-income': '1º salário em dólar',
          }[a.type] || c.title;
          return `<button class="row plain link" data-action="replay-ach" data-ach="${esc(a.id)}">
            <span class="icon" aria-hidden="true">${c.icon}</span>
            <div class="main"><div class="title">${esc(title)}</div></div>
            <span class="chev" aria-hidden="true" style="margin-left:auto">Rever ›</span></button>`;
        })
        .join('')
    : `<div class="row"><span class="icon" aria-hidden="true">🔒</span><div class="main"><div class="title">Nenhuma ainda</div>
        <div class="subtitle">Compre dólares e chegue a US$ 500 para a primeira comemoração.</div></div></div>`;
  return `<h2 class="section-title">Conquistas</h2><div class="group">${rows}</div>`;
}

// ---------------------------------------------------------------- exportação

async function exportCSV() {
  const csv = '﻿' + toCSV(visibleTxs());
  const name = `dolarmap-${todayISO()}.csv`;
  const file = new File([csv], name, { type: 'text/csv' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'DolarMap' });
      return;
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- eventos

app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'pick') {
    e.preventDefault();
    state.loginPick = el.dataset.user;
    state.loginError = '';
    // Atualiza só a seleção para não perder o teclado/campo.
    app.querySelectorAll('.person').forEach((p) => p.setAttribute('aria-checked', String(p === el)));
    const pass = app.querySelector('#password');
    app.querySelector('.login .btn').disabled = false;
    if (pass) {
      pass.disabled = false;
      pass.focus();
    }
  } else if (a === 'tab') {
    if (state.tab !== el.dataset.tab) state.enter = true;
    state.tab = el.dataset.tab;
    render();
    window.scrollTo(0, 0);
  } else if (a === 'range') {
    state.anRange = Number(el.dataset.range);
    render();
  } else if (a === 'scope') {
    state.scope = el.dataset.scope;
    writePref('dolarmap.scope', state.scope);
    render();
  } else if (a === 'filter') {
    state.filter = el.dataset.filter;
    render();
  } else if (a === 'clear-filters') {
    state.filter = 'all';
    state.query = '';
    render();
  } else if (a === 'add') {
    openSheet({ kind: el.dataset.kind || 'expense', currency: el.dataset.currency || 'USD' });
  } else if (a === 'edit') {
    const tx = state.txs.find((t) => t.id === el.dataset.id);
    if (tx) openSheet({ tx });
  } else if (a === 'retry') {
    loadData();
  } else if (a === 'sync') {
    loadData({ silent: true });
  } else if (a === 'prepare-offline') {
    setupOffline();
  } else if (a === 'theme') {
    state.theme = el.dataset.theme;
    writePref('dolarmap.theme', state.theme);
    applyTheme(state.theme);
    render();
  } else if (a === 'remove-photo') {
    removePhoto();
  } else if (a === 'view-photo') {
    viewPhoto(el.dataset.user);
  } else if (a === 'secret') {
    openLoveSheet();
  } else if (a === 'replay-ach') {
    const ach = achievementsFor(state.txs, state.user.username).find((x) => x.id === el.dataset.ach);
    if (ach && !celebrateEl) celebrate(ach);
  } else if (a === 'export') {
    exportCSV().catch(() => toast('Não foi possível exportar.', { error: true }));
  } else if (a === 'logout') {
    const pending = state.store.status?.pending || 0;
    if (!confirm(pending
      ? `Há ${pending} registro(s) pendente(s) neste aparelho. Eles ficam guardados para esta conta, mas você precisará de internet para entrar novamente. Sair mesmo assim?`
      : 'Sair da sua conta neste aparelho?')) return;
    await state.store.signOut();
    state.user = null;
    state.txs = [];
    resetOverlays();
    state.tab = 'home';
    state.loginPick = null;
    state.heroShown = {};
    state.enter = true;
    render();
  }
});

app.addEventListener('submit', async (e) => {
  if (e.target.id !== 'login-form') return;
  e.preventDefault();
  if (!state.loginPick || state.loginBusy) return;
  const password = app.querySelector('#password')?.value || '';
  state.loginBusy = true;
  state.loginError = '';
  render();
  try {
    state.user = await state.store.signIn(state.loginPick, password);
    state.loginBusy = false;
    state.tab = 'home';
    state.enter = true;
    await loadData();
  } catch (err) {
    state.loginBusy = false;
    state.loginError = err.message || 'Não foi possível entrar.';
    render();
    app.querySelector('.login .field')?.classList.add('shake'); // "não" do iOS: balança o campo
    app.querySelector('#password')?.focus();
  }
});

// Gráficos: tocar/arrastar mostra o valor do ponto mais próximo.
app.addEventListener('pointermove', onChartPointer);
app.addEventListener('pointerdown', onChartPointer);
app.addEventListener('pointerout', hideChartTip);

app.addEventListener('change', (e) => {
  if (e.target.id !== 'photo-input') return;
  changePhoto(e.target.files?.[0]);
  e.target.value = '';
});

let searchTimer;
app.addEventListener('input', (e) => {
  if (e.target.id !== 'search') return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = e.target.value;
    // Atualiza só a lista: o campo de busca (e o teclado) continuam intactos.
    const body = app.querySelector('#list-body');
    if (body) body.innerHTML = listBody();
  }, 150);
});

// Ao voltar para o app (ex.: reabrir pelo ícone), busca o que o outro registrou.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.user && !sheet?.open) loadData({ silent: true });
});

window.addEventListener('offline', () => {
  if (state.store.status) state.store.status.offline = true;
  updateOfflinePanel();
});
window.addEventListener('online', () => {
  if (state.store.status) state.store.status.offline = false;
  updateOfflinePanel();
  if (offlineAssets !== 'ready') void setupOffline();
  if (state.user) void loadData({ silent: true });
});
setInterval(() => {
  if (state.store.sync && state.user && navigator.onLine !== false && document.visibilityState === 'visible' && !sheet?.open) {
    void loadData({ silent: true });
  }
}, 30000);

// ---------------------------------------------------------------- início

async function start() {
  applyTheme(state.theme);
  try {
    state.user = await state.store.restoreSession();
  } catch {
    state.user = null;
  }
  if (state.user) await loadData();
  else render();
}

start();
void setupOffline();
