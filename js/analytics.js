// Cálculos da aba Análises (funções puras, testadas em tests/logic.spec.js).
import { summarize, todayISO, rateOf, categoryInfo, sortTxs } from './logic.js?v=20261106offline1';

const DAY = 86400000;

function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function daysBetween(aISO, bISO) {
  return Math.round((parseISO(bISO) - parseISO(aISO)) / DAY);
}

export function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return todayISO(d);
}

/** Efeito de um registro no saldo em dólar. */
function usdDelta(t) {
  if (t.kind === 'buy' || t.kind === 'income') return t.amount_cents;
  if (t.kind === 'expense' && t.currency === 'USD') return -t.amount_cents;
  return 0;
}

/**
 * Evolução do saldo em US$: um ponto por dia (saldo ao fim do dia), nos últimos `days` dias.
 * O primeiro ponto já inclui tudo o que aconteceu antes do período.
 */
export function balanceSeries(txs, today = todayISO(), days = 30) {
  const start = addDays(today, -(days - 1));
  let running = 0;
  const perDay = new Map();
  for (const t of txs) {
    const d = usdDelta(t);
    if (!d || t.occurred_on > today) continue;
    if (t.occurred_on < start) running += d;
    else perDay.set(t.occurred_on, (perDay.get(t.occurred_on) || 0) + d);
  }
  const opening = running;
  const points = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    running += perDay.get(date) || 0;
    points.push({ date, value: running });
  }
  const values = points.map((p) => p.value);
  return {
    points,
    opening,
    current: running,
    change: running - opening,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/** Distribuição do custo por categoria, em R$ equivalentes (US$ convertidos pela cotação média). */
export function categoryBreakdown(txs) {
  const s = summarize(txs);
  const rate = s.avgRate;
  const rows = s.categories.map((c) => {
    const total = c.brl + (rate != null ? Math.round(c.usd * rate) : 0);
    const info = categoryInfo(c.id);
    return { id: c.id, label: info.label, icon: info.icon, usd: c.usd, brl: c.brl, total, count: c.count };
  });
  rows.sort((a, b) => b.total - a.total || b.usd - a.usd);
  const sum = rows.reduce((acc, r) => acc + r.total, 0);
  rows.forEach((r) => (r.pct = sum ? r.total / sum : 0));
  return { rows, total: sum, converted: rate != null, rate, usdSpent: s.usdSpent, brlSpent: s.brlSpent };
}

/**
 * Histórico das compras de dólar, em ordem cronológica, com a cotação média acumulada
 * após cada compra e a diferença da compra em relação à média final.
 */
export function purchaseHistory(txs) {
  const buys = sortTxs(txs.filter((t) => t.kind === 'buy' && t.amount_cents > 0 && t.brl_cents > 0)).reverse();
  if (!buys.length) return null;
  let usd = 0;
  let brl = 0;
  const rows = buys.map((b) => {
    usd += b.amount_cents;
    brl += b.brl_cents;
    return { ...b, rate: rateOf(b.amount_cents, b.brl_cents), avgAfter: brl / usd, usdTotal: usd, brlTotal: brl };
  });
  const avgRate = brl / usd;
  rows.forEach((r) => (r.vsAvg = r.rate - avgRate));
  const best = rows.reduce((a, b) => (b.rate < a.rate ? b : a));
  const worst = rows.reduce((a, b) => (b.rate > a.rate ? b : a));
  return {
    rows,
    count: rows.length,
    usd,
    brl,
    avgRate,
    best,
    worst,
    // Quanto teria pago a menos se todas as compras tivessem sido na melhor cotação.
    extraVsBest: brl - Math.round(usd * best.rate),
  };
}

/** Números de cada pessoa para o comparativo do casal. */
export function coupleComparison(txs, users) {
  return users.map((u) => {
    const s = summarize(txs.filter((t) => t.author === u.username));
    return {
      ...u,
      bought: s.usdBought,
      brlPaid: s.brlPaid,
      avgRate: s.avgRate,
      usdSpent: s.usdSpent,
      brlSpent: s.brlSpent,
      income: s.usdIncome,
      balance: s.balanceUsd,
    };
  });
}
