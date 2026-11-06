import { test, assert, memoryStorage } from './harness.js';
import {
  parseMoney,
  formatMoney,
  formatRate,
  centsToInput,
  validateDraft,
  summarize,
  groupByDay,
  filterTxs,
  dayLabel,
  todayISO,
  toCSV,
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
} from '../js/logic.js';
import { LocalStore, CloudStore } from '../js/store.js';
import { addDays, daysBetween, balanceSeries, categoryBreakdown, purchaseHistory, coupleComparison } from '../js/analytics.js';
import { SupabaseRest } from '../js/supabase.js';
import { achievementsFor, newAchievements, nextMilestone } from '../js/achievements.js';

// ---------- conquistas

const achTx = (author, kind, usd, extra = {}) => ({
  author, kind, amount_cents: usd * 100, currency: 'USD', brl_cents: kind === 'buy' ? usd * 540 : null,
  category: kind === 'buy' ? 'cambio' : kind === 'income' ? 'salario' : 'alimentacao', occurred_on: '2026-11-01', ...extra,
});

test('conquistas: marcos de saldo a cada US$ 500, primeira compra e primeiro salário', () => {
  const txs = [achTx('gustavo', 'buy', 1200), achTx('gustavo', 'expense', 150), achTx('gustavo', 'income', 10)];
  const ids = achievementsFor(txs, 'gustavo').map((a) => a.id);
  // saldo 1200 - 150 + 10 = 1060 -> marcos 500 e 1000
  assert.deepEqual(ids, ['first-buy', 'first-income', 'balance-50000', 'balance-100000']);
  assert.deepEqual(achievementsFor([], 'gustavo'), []);
});

test('conquistas: casal a cada US$ 1.000 (só com registros dos dois)', () => {
  const txs = [achTx('gustavo', 'buy', 1200), achTx('manuela', 'buy', 900)];
  const couple = achievementsFor(txs, 'gustavo').filter((a) => a.type === 'couple').map((a) => a.cents);
  assert.deepEqual(couple, [100000, 200000]);
  assert.equal(achievementsFor([achTx('gustavo', 'buy', 3000)], 'gustavo').some((a) => a.type === 'couple'), false);
});

test('conquistas: comemora só o novo e só o maior marco de cada tipo', () => {
  const before = achievementsFor([achTx('gustavo', 'buy', 400)], 'gustavo').map((a) => a.id); // first-buy
  const after = achievementsFor([achTx('gustavo', 'buy', 400), achTx('gustavo', 'buy', 1200)], 'gustavo'); // 1600
  const fresh = newAchievements(after, before);
  assert.deepEqual(fresh.map((a) => a.id), ['balance-150000']);
  assert.deepEqual(newAchievements(after, after.map((a) => a.id)), []); // nada repetido
  // saldo caiu e voltou: já comemorado, não repete
  assert.deepEqual(newAchievements(after, [...before, 'balance-50000', 'balance-100000', 'balance-150000']), []);
});

test('conquistas: próxima meta e progresso', () => {
  assert.deepEqual(nextMilestone(78660), { target: 100000, missing: 21340, progress: 0.5732 });
  assert.deepEqual(nextMilestone(100000), { target: 150000, missing: 50000, progress: 0 });
  assert.equal(nextMilestone(-1000).target, 50000);
});

const norm = (s) => s.replace(/ | /g, ' ');

// ---------- parseMoney

test('parseMoney: formatos brasileiros e americanos', () => {
  const cases = {
    '6,70': 670,
    '6.70': 670,
    '6,7': 670,
    '6': 600,
    ',5': 50,
    '0,99': 99,
    '1.234,56': 123456,
    '1,234.56': 123456,
    '1.000': 100000,
    '1.000.000': 100000000,
    '2500': 250000,
    'US$ 6,70': 670,
    'R$1.000,00': 100000,
    '$12.5': 1250,
    ' 7,00 ': 700,
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(parseMoney(input), expected, `"${input}":`);
});

test('parseMoney: entradas inválidas retornam null', () => {
  for (const input of ['', '   ', 'abc', '6,705', '-5', '1.2.3', '1,2,3', '6,70,1', null, undefined, '1.00.000']) {
    assert.equal(parseMoney(input), null, `"${input}":`);
  }
});

test('parseMoney: sem erro de ponto flutuante', () => {
  assert.equal(parseMoney('0,29'), 29);
  assert.equal(parseMoney('1,15'), 115);
  assert.equal(parseMoney('4,35'), 435);
});

// ---------- formatação

test('formatMoney em US$ e R$ (pt-BR)', () => {
  assert.equal(norm(formatMoney(670, 'USD')), 'US$ 6,70');
  assert.equal(norm(formatMoney(123456, 'BRL')), 'R$ 1.234,56');
  assert.equal(norm(formatMoney(-670, 'USD')), '−US$ 6,70');
  assert.equal(norm(formatMoney(670, 'USD', { signed: true })), '+US$ 6,70');
  assert.equal(norm(formatMoney(0, 'USD', { signed: true })), 'US$ 0,00');
});

test('formatRate e centsToInput', () => {
  assert.equal(formatRate(5.4321), 'R$ 5,4321');
  assert.equal(formatRate(5.5), 'R$ 5,50');
  assert.equal(formatRate(null), '—');
  assert.equal(centsToInput(670), '6,70');
  assert.equal(centsToInput(100000), '1000,00');
  assert.equal(parseMoney(centsToInput(123456)), 123456, 'ida e volta');
});

// ---------- validação

const base = { kind: 'expense', amount: '6,70', currency: 'USD', brl: '', category: 'alimentacao', note: 'biscoito', date: '2026-11-05' };

test('validateDraft: gasto rápido de US$ 6,70', () => {
  const r = validateDraft(base);
  assert.ok(r.ok);
  assert.deepEqual(r.value, {
    kind: 'expense',
    amount_cents: 670,
    currency: 'USD',
    brl_cents: null,
    category: 'alimentacao',
    note: 'biscoito',
    occurred_on: '2026-11-05',
  });
});

test('validateDraft: erros de valor, categoria, data e descrição', () => {
  assert.ok(validateDraft({ ...base, amount: '' }).errors.amount);
  assert.ok(validateDraft({ ...base, amount: '0' }).errors.amount);
  assert.ok(validateDraft({ ...base, amount: '2.000.000,00' }).errors.amount, 'limite');
  assert.ok(validateDraft({ ...base, category: 'salario' }).errors.category, 'categoria de entrada em gasto');
  assert.ok(validateDraft({ ...base, date: '2026-02-30' }).errors.date);
  assert.ok(validateDraft({ ...base, note: 'x'.repeat(121) }).errors.note);
  assert.ok(validateDraft({ ...base, kind: 'outro' }).errors.kind);
});

test('validateDraft: compra de dólar exige valor em reais e força USD/câmbio', () => {
  const missing = validateDraft({ ...base, kind: 'buy', amount: '500', brl: '' });
  assert.ok(missing.errors.brl);
  const r = validateDraft({ ...base, kind: 'buy', amount: '500', brl: '2.715,00', currency: 'BRL', category: 'x' });
  assert.ok(r.ok);
  assert.equal(r.value.currency, 'USD');
  assert.equal(r.value.category, 'cambio');
  assert.equal(r.value.brl_cents, 271500);
});

test('validateDraft: entrada é sempre em USD; gasto pode ser em R$', () => {
  const inc = validateDraft({ ...base, kind: 'income', category: 'salario', currency: 'BRL' });
  assert.equal(inc.value.currency, 'USD');
  const brl = validateDraft({ ...base, category: 'visto', currency: 'BRL', amount: '1.200,00' });
  assert.equal(brl.value.currency, 'BRL');
  assert.equal(brl.value.amount_cents, 120000);
});

// ---------- resumo

const T = (o) => ({ id: Math.random().toString(36).slice(2), author: 'gustavo', created_at: '2026-11-01T10:00:00Z', note: '', brl_cents: null, currency: 'USD', ...o });
const sample = [
  T({ kind: 'buy', amount_cents: 50000, brl_cents: 270000, category: 'cambio', occurred_on: '2026-10-01' }), // 500 @ 5,40
  T({ kind: 'buy', amount_cents: 50000, brl_cents: 280000, category: 'cambio', occurred_on: '2026-10-15' }), // 500 @ 5,60
  T({ kind: 'expense', amount_cents: 670, category: 'alimentacao', occurred_on: '2026-11-05' }),
  T({ kind: 'expense', amount_cents: 120000, currency: 'BRL', category: 'visto', occurred_on: '2026-09-01' }),
  T({ kind: 'income', amount_cents: 80000, category: 'salario', occurred_on: '2026-11-05', author: 'manuela' }),
];

test('summarize: saldo, cotação média e custos', () => {
  const s = summarize(sample);
  assert.equal(s.usdBought, 100000);
  assert.equal(s.brlPaid, 550000);
  assert.equal(s.avgRate, 5.5);
  assert.equal(s.usdSpent, 670);
  assert.equal(s.brlSpent, 120000);
  assert.equal(s.usdIncome, 80000);
  assert.equal(s.balanceUsd, 100000 + 80000 - 670);
  assert.equal(s.balanceBrlEstimate, Math.round(179330 * 5.5));
  assert.equal(s.totalCostBrlEstimate, 120000 + Math.round(670 * 5.5));
  assert.equal(s.categories[0].id, 'visto', 'maior categoria primeiro');
  assert.equal(s.categories[0].share, 1);
});

test('summarize: lista vazia e sem compras', () => {
  const s = summarize([]);
  assert.equal(s.balanceUsd, 0);
  assert.equal(s.avgRate, null);
  assert.equal(s.balanceBrlEstimate, null);
  const s2 = summarize([T({ kind: 'expense', amount_cents: 500, category: 'mercado', occurred_on: '2026-11-01' })]);
  assert.equal(s2.balanceUsd, -500, 'saldo negativo permitido (gastou mais do que registrou)');
  assert.equal(s2.totalCostBrlEstimate, null);
});

// ---------- listagem

test('groupByDay ordena do mais recente e soma gastos em US$ do dia', () => {
  const g = groupByDay(sample);
  assert.deepEqual(g.map((x) => x.date), ['2026-11-05', '2026-10-15', '2026-10-01', '2026-09-01']);
  assert.equal(g[0].items.length, 2);
  assert.equal(g[0].usdOut, 670);
});

test('filterTxs por tipo, pessoa e busca sem acento', () => {
  assert.equal(filterTxs(sample, { kind: 'buy' }).length, 2);
  assert.equal(filterTxs(sample, { owner: 'manuela' }).length, 1);
  assert.equal(filterTxs(sample, { query: 'alimentacao' }).length, 1, 'acento ignorado');
  assert.equal(filterTxs(sample, { query: 'VISTO' }).length, 1);
  assert.equal(filterTxs(sample, { query: 'nada' }).length, 0);
});

test('dayLabel: Hoje, Ontem e data', () => {
  assert.equal(dayLabel('2026-11-05', '2026-11-05'), 'Hoje');
  assert.equal(dayLabel('2026-11-04', '2026-11-05'), 'Ontem');
  assert.equal(dayLabel('2026-10-31', '2026-11-01'), 'Ontem', 'virada de mês');
  assert.ok(/3/.test(dayLabel('2026-11-03', '2026-11-05')));
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(todayISO()));
});

test('toCSV com ; e aspas escapadas', () => {
  const csv = toCSV([T({ kind: 'expense', amount_cents: 670, category: 'alimentacao', note: 'biscoito; "bom"', occurred_on: '2026-11-05' })]);
  const [head, row] = csv.split('\n');
  assert.ok(head.startsWith('data;pessoa;tipo'));
  assert.equal(row, '2026-11-05;gustavo;Gasto;Alimentação;"biscoito; ""bom""";USD;6,70;');
});

// ---------- Análises

test('analytics: addDays e daysBetween atravessam meses', () => {
  assert.equal(addDays('2026-10-30', 3), '2026-11-02');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(daysBetween('2026-10-30', '2026-11-02'), 3);
});

test('analytics: evolução do saldo dia a dia, com saldo de abertura', () => {
  const txs = [
    T({ kind: 'buy', amount_cents: 50000, brl_cents: 270000, category: 'cambio', occurred_on: '2026-10-01' }), // antes do período
    T({ kind: 'expense', amount_cents: 1000, category: 'mercado', occurred_on: '2026-11-03' }),
    T({ kind: 'expense', amount_cents: 99999, currency: 'BRL', category: 'visto', occurred_on: '2026-11-03' }), // R$ não mexe
    T({ kind: 'income', amount_cents: 2000, category: 'salario', occurred_on: '2026-11-05' }),
    T({ kind: 'expense', amount_cents: 500, category: 'mercado', occurred_on: '2026-11-09' }), // futuro: ignorado
  ];
  const bs = balanceSeries(txs, '2026-11-05', 7);
  assert.equal(bs.points.length, 7);
  assert.equal(bs.points[0].date, '2026-10-30');
  assert.equal(bs.opening, 50000);
  assert.deepEqual(
    bs.points.map((p) => p.value),
    [50000, 50000, 50000, 50000, 49000, 49000, 51000],
  );
  assert.equal(bs.current, 51000);
  assert.equal(bs.change, 1000);
  assert.equal(bs.min, 49000);
  const empty = balanceSeries([], '2026-11-05', 30);
  assert.equal(empty.points.length, 30);
  assert.equal(empty.current, 0);
});

test('analytics: distribuição por categoria em R$ equivalentes', () => {
  const cb = categoryBreakdown(sample);
  assert.equal(cb.rows[0].id, 'visto');
  assert.equal(cb.rows[1].total, Math.round(670 * 5.5));
  assert.equal(cb.total, 120000 + Math.round(670 * 5.5));
  assert.ok(Math.abs(cb.rows.reduce((s, r) => s + r.pct, 0) - 1) < 1e-9, 'percentuais somam 100%');
  assert.ok(cb.converted);
});

test('analytics: histórico de compras com média acumulada', () => {
  const ph = purchaseHistory(sample);
  assert.equal(ph.count, 2);
  assert.deepEqual(ph.rows.map((r) => r.occurred_on), ['2026-10-01', '2026-10-15'], 'ordem cronológica');
  assert.equal(ph.rows[0].avgAfter, 5.4);
  assert.equal(ph.rows[1].avgAfter, 5.5);
  assert.equal(ph.avgRate, 5.5);
  assert.equal(ph.best.rate, 5.4);
  assert.equal(ph.worst.rate, 5.6);
  assert.ok(Math.abs(ph.rows[0].vsAvg - -0.1) < 1e-9);
  assert.equal(ph.extraVsBest, 550000 - 540000);
  assert.equal(purchaseHistory([]), null);
});

test('analytics: comparativo do casal', () => {
  const users = [
    { username: 'gustavo', name: 'Gustavo' },
    { username: 'manuela', name: 'Manuela' },
  ];
  const [g, m] = coupleComparison(sample, users);
  assert.equal(g.bought, 100000);
  assert.equal(g.balance, 100000 - 670);
  assert.equal(g.brlSpent, 120000);
  assert.equal(m.income, 80000);
  assert.equal(m.balance, 80000);
  assert.equal(m.avgRate, null);
});

test('categorias: 16 de gasto e 4 de entrada (grade 4×4 sem sobras), "Outros" por último', () => {
  assert.equal(EXPENSE_CATEGORIES.length % 4, 0);
  assert.equal(INCOME_CATEGORIES.length % 4, 0);
  assert.equal(EXPENSE_CATEGORIES.at(-1).id, 'outros');
  assert.equal(new Set(EXPENSE_CATEGORIES.map((c) => c.id)).size, EXPENSE_CATEGORIES.length, 'ids únicos');
});

// ---------- LocalStore

const cfg = { supabaseUrl: '', supabaseAnonKey: '', emailDomain: 'x.app', users: [{ username: 'gustavo', name: 'Gustavo' }, { username: 'manuela', name: 'Manuela' }] };

test('LocalStore: login, CRUD e só edita o próprio registro', async () => {
  const storage = memoryStorage();
  const s = new LocalStore(cfg, storage);
  assert.equal(await s.restoreSession(), null);
  const g = await s.signIn('gustavo');
  assert.equal(g.name, 'Gustavo');
  const row = await s.create(validateDraft(base).value);
  assert.equal(row.author, 'gustavo');
  assert.equal((await s.list()).length, 1);
  const upd = await s.update(row.id, { ...validateDraft(base).value, amount_cents: 700 });
  assert.equal(upd.amount_cents, 700);

  await s.signOut();
  await s.signIn('manuela');
  await assert.rejects(s.update(row.id, validateDraft(base).value), (e) => assert.ok(/próprios/.test(e.message)));
  await assert.rejects(s.remove(row.id));
  await s.signOut();
  await s.signIn('gustavo');
  await s.remove(row.id);
  assert.equal((await s.list()).length, 0);
});

// ---------- Cliente Supabase (fetch simulado)

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const { status = 200, body = null } = (await handler(url, init, calls.length)) || {};
    return { ok: status >= 200 && status < 300, status, text: async () => (body == null ? '' : JSON.stringify(body)) };
  };
  fn.calls = calls;
  return fn;
}

async function withFetch(f, run) {
  const orig = globalThis.fetch;
  globalThis.fetch = f;
  try {
    return await run();
  } finally {
    globalThis.fetch = orig;
  }
}

const tokenBody = (n) => ({
  access_token: `at${n}`,
  refresh_token: `rt${n}`,
  expires_in: 3600,
  user: { id: 'u1', email: 'gustavo@x.app' },
});

test('CloudStore: login converte nome em e-mail e não manda Authorization sem sessão', async () => {
  const f = fakeFetch(() => ({ body: tokenBody(1) }));
  await withFetch(f, async () => {
    const store = new CloudStore({ ...cfg, supabaseUrl: 'https://p.supabase.co/', supabaseAnonKey: 'k' }, memoryStorage());
    const user = await store.signIn('Gustavo', 'segredo');
    assert.equal(user.username, 'gustavo');
    assert.equal(user.name, 'Gustavo');
    const call = f.calls[0];
    assert.equal(call.url, 'https://p.supabase.co/auth/v1/token?grant_type=password');
    assert.deepEqual(JSON.parse(call.init.body), { email: 'gustavo@x.app', password: 'segredo' });
    assert.equal(call.init.headers.apikey, 'k');
    assert.equal(call.init.headers.Authorization, undefined);
  });
});

test('CloudStore: e-mail personalizado no login e autor convertido para o nome do app', async () => {
  const cfgEmail = {
    ...cfg,
    supabaseUrl: 'https://p.supabase.co',
    supabaseAnonKey: 'k',
    users: [
      { username: 'gustavo', name: 'Gustavo', email: 'gustavinhongarcia@gmail.com' },
      { username: 'manuela', name: 'Manuela', email: 'ManuelaContreiras2006@gmail.com' },
    ],
  };
  const f = fakeFetch((url) => {
    if (url.includes('/auth/')) return { body: { ...tokenBody(1), user: { id: 'u1', email: 'manuelacontreiras2006@gmail.com' } } };
    if (url.includes('/rest/')) return { body: [{ id: 'a', author: 'gustavinhongarcia' }, { id: 'b', author: 'manuelacontreiras2006' }] };
  });
  await withFetch(f, async () => {
    const store = new CloudStore(cfgEmail, memoryStorage());
    const user = await store.signIn('manuela', 'x');
    assert.equal(JSON.parse(f.calls[0].init.body).email, 'manuelacontreiras2006@gmail.com');
    assert.equal(user.username, 'manuela');
    assert.equal(user.name, 'Manuela');
    const rows = await store.list();
    assert.deepEqual(rows.map((r) => r.author), ['gustavo', 'manuela']);
    assert.equal((await store.restoreSession()).username, 'manuela', 'sessão restaurada reconhece o e-mail');
  });
});

test('Supabase: senha errada vira mensagem amigável', async () => {
  const f = fakeFetch(() => ({ status: 400, body: { error_code: 'invalid_credentials', msg: 'Invalid login credentials' } }));
  await withFetch(f, async () => {
    const api = new SupabaseRest('https://p.supabase.co', 'k', memoryStorage());
    await assert.rejects(api.signIn('a@b.c', 'x'), (e) => assert.equal(e.message, 'Usuário ou senha incorretos.'));
  });
});

test('Supabase: falta de internet vira mensagem amigável', async () => {
  const f = async () => {
    throw new TypeError('Failed to fetch');
  };
  await withFetch(f, async () => {
    const api = new SupabaseRest('https://p.supabase.co', 'k', memoryStorage());
    await assert.rejects(api.signIn('a@b.c', 'x'), (e) => assert.equal(e.code, 'network'));
  });
});

test('Supabase: token expirado é renovado e a chamada é repetida (401 -> refresh -> ok)', async () => {
  const f = fakeFetch((url, init, n) => {
    if (url.includes('grant_type=password')) return { body: tokenBody(1) };
    if (url.includes('grant_type=refresh_token')) return { body: tokenBody(2) };
    if (init.headers.Authorization === 'Bearer at1') return { status: 401, body: { message: 'JWT expired' } };
    return { body: [{ id: 'x' }] };
  });
  await withFetch(f, async () => {
    const storage = memoryStorage();
    const api = new SupabaseRest('https://p.supabase.co', 'k', storage);
    await api.signIn('a@b.c', 'x');
    const rows = await api.rest('/transactions');
    assert.deepEqual(rows, [{ id: 'x' }]);
    assert.equal(api.session.access_token, 'at2');
    assert.ok(storage.getItem('dolarmap.offline.session.v1').includes('rt2'), 'sessão persistida');
  });
});

test('Supabase: reabrir depois de 90 dias renova a sessão salva sem pedir senha', async () => {
  const storage = memoryStorage({
    'dolarmap.offline.session.v1': JSON.stringify({ ...tokenBody(1), expires_at: Math.floor(Date.now() / 1000) - 90 * 86400 }),
  });
  const f = fakeFetch(() => ({ body: tokenBody(2) }));
  await withFetch(f, async () => {
    const api = new SupabaseRest('https://p.supabase.co', 'k', storage);
    assert.equal((await api.getSession()).access_token, 'at2');
    assert.ok(f.calls[0].url.endsWith('grant_type=refresh_token'));
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { refresh_token: 'rt1' });
    const reopened = new SupabaseRest('https://p.supabase.co', 'k', storage);
    assert.equal((await reopened.getSession()).refresh_token, 'rt2');
    assert.equal(f.calls.length, 1);
  });
});

for (const status of [0, 408, 409, 429, 500, 503]) {
  test(`Supabase: falha temporária ${status} preserva o login e permite tentar novamente`, async () => {
    const saved = JSON.stringify({ ...tokenBody(1), expires_at: 0 });
    const storage = memoryStorage({ 'dolarmap.offline.session.v1': saved });
    let recovered = false;
    const f = fakeFetch((url) => {
      if (!url.includes('grant_type=refresh_token')) return { body: [{ id: 'x' }] };
      if (recovered) return { body: tokenBody(2) };
      if (status === 0) throw new TypeError('Failed to fetch');
      return { status, body: { message: 'Temporarily unavailable' } };
    });
    await withFetch(f, async () => {
      const api = new SupabaseRest('https://p.supabase.co', 'k', storage);
      assert.equal((await api.getSession()).user.id, 'u1', 'lembra a conta ao reabrir');
      assert.equal(storage.getItem('dolarmap.offline.session.v1'), saved);
      await assert.rejects(api.rest('/transactions'), (e) => {
        assert.ok(e.code !== 'session_expired');
        assert.equal(e.status, status);
      });
      assert.ok(f.calls.every((c) => c.url.includes('grant_type=refresh_token')), 'não usa token vencido na API');
      assert.equal(storage.getItem('dolarmap.offline.session.v1'), saved);
      recovered = true;
      assert.deepEqual(await api.rest('/transactions'), [{ id: 'x' }]);
      assert.equal(api.session.refresh_token, 'rt2');
    });
  });
}

test('Supabase: refresh recusado limpa a sessão (volta para o login)', async () => {
  const f = fakeFetch((url) => {
    if (url.includes('grant_type=refresh_token')) return { status: 400, body: { msg: 'Invalid Refresh Token' } };
    return { status: 401, body: {} };
  });
  await withFetch(f, async () => {
    const storage = memoryStorage({
      'dolarmap.offline.session.v1': JSON.stringify({ access_token: 'old', refresh_token: 'r', expires_at: 0, user: { id: 'u', email: 'g@x' } }),
    });
    const store = new CloudStore({ ...cfg, supabaseUrl: 'https://p.supabase.co', supabaseAnonKey: 'k' }, storage);
    assert.equal(await store.restoreSession(), null);
    assert.equal(storage.getItem('dolarmap.offline.session.v1'), null);
  });
});

test('CloudStore.update sem linhas retornadas (registro de outra pessoa) gera erro claro', async () => {
  const f = fakeFetch((url) => (url.includes('/auth/') ? { body: tokenBody(1) } : { body: [] }));
  await withFetch(f, async () => {
    const store = new CloudStore({ ...cfg, supabaseUrl: 'https://p.supabase.co', supabaseAnonKey: 'k' }, memoryStorage());
    await store.signIn('gustavo', 'x');
    await assert.rejects(store.update('abc', validateDraft(base).value), (e) => assert.ok(/próprios/.test(e.message)));
    const patch = f.calls[1];
    assert.equal(patch.init.method, 'PATCH');
    assert.ok(patch.url.endsWith('/rest/v1/transactions?id=eq.abc'));
    assert.ok(!('author' in JSON.parse(patch.init.body)), 'não envia campos controlados pelo servidor');
  });
});
