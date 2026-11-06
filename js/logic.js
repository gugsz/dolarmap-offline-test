// Regras de negócio puras (sem DOM, sem rede) — testadas em tests/logic.spec.js.
// Valores monetários são SEMPRE inteiros em centavos para evitar erros de ponto flutuante.

export const KINDS = {
  expense: { id: 'expense', label: 'Gasto' },
  buy: { id: 'buy', label: 'Compra de US$' },
  income: { id: 'income', label: 'Entrada' },
};

export const EXPENSE_CATEGORIES = [
  { id: 'alimentacao', label: 'Alimentação', icon: '🍔' },
  { id: 'mercado', label: 'Mercado', icon: '🛒' },
  { id: 'transporte', label: 'Transporte', icon: '🚌' },
  { id: 'moradia', label: 'Moradia', icon: '🏠' },
  // Ordem = posição na grade 4×4: gastos do dia a dia em cima, preparação/administrativos embaixo.
  { id: 'compras', label: 'Compras', icon: '🛍️' },
  { id: 'lazer', label: 'Lazer', icon: '🎡' },
  { id: 'celular', label: 'Celular', icon: '📱' },
  { id: 'presentes', label: 'Presentes', icon: '🎁' },
  { id: 'saude', label: 'Saúde', icon: '💊' },
  { id: 'seguro', label: 'Seguro', icon: '🛡️' },
  { id: 'visto', label: 'Visto', icon: '🛂' },
  { id: 'passaporte', label: 'Passaporte', icon: '📘' },
  { id: 'passagem', label: 'Passagem', icon: '✈️' },
  { id: 'programa', label: 'Programa', icon: '📋' },
  { id: 'taxas', label: 'Taxas e docs', icon: '🧾' },
  { id: 'outros', label: 'Outros', icon: '📦' }, // sempre por último (canto da grade 4×4)
];

export const INCOME_CATEGORIES = [
  { id: 'salario', label: 'Salário', icon: '💼' },
  { id: 'gorjeta', label: 'Gorjeta', icon: '🪙' },
  { id: 'reembolso', label: 'Reembolso', icon: '↩️' },
  { id: 'outras_entradas', label: 'Outras', icon: '💵' },
];

export const BUY_CATEGORY = { id: 'cambio', label: 'Câmbio', icon: '💱' };

const ALL_CATEGORIES = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES, BUY_CATEGORY];

export function categoryInfo(id) {
  return ALL_CATEGORIES.find((c) => c.id === id) || { id, label: 'Outros', icon: '📦' };
}

export function categoriesFor(kind) {
  if (kind === 'expense') return EXPENSE_CATEGORIES;
  if (kind === 'income') return INCOME_CATEGORIES;
  return [BUY_CATEGORY];
}

export const MAX_CENTS = 100_000_000; // 1 milhão
export const MAX_NOTE = 120;

/**
 * Converte texto digitado em centavos (inteiro). Aceita "6,70", "6.70", "1.234,56",
 * "1,234.56", "US$ 6,70", "R$1.000". Retorna null se inválido.
 */
export function parseMoney(input) {
  if (input == null) return null;
  let s = String(input).trim().replace(/\s| /g, '').replace(/^(US\$|R\$|\$)/i, '');
  if (s === '' || !/^[0-9.,]+$/.test(s)) return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let intPart;
  let decPart = '';

  if (lastComma >= 0 && lastDot >= 0) {
    // O separador que aparece por último é o decimal.
    const decSep = lastComma > lastDot ? ',' : '.';
    const thouSep = decSep === ',' ? '.' : ',';
    const idx = s.lastIndexOf(decSep);
    intPart = s.slice(0, idx);
    decPart = s.slice(idx + 1);
    if (intPart.includes(decSep)) return null;
    if (!validThousands(intPart, thouSep)) return null;
    intPart = intPart.split(thouSep).join('');
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.';
    const parts = s.split(sep);
    if (parts.length > 2) {
      // "1.000.000" -> separador de milhar
      if (!validThousands(s, sep)) return null;
      intPart = parts.join('');
    } else if (sep === '.' && parts[1].length === 3) {
      // "1.000" -> mil (padrão brasileiro). "6.70" -> decimal.
      intPart = parts.join('');
    } else {
      intPart = parts[0];
      decPart = parts[1];
    }
  } else {
    intPart = s;
  }

  if (intPart === '') intPart = '0';
  if (!/^\d+$/.test(intPart) || !/^\d{0,2}$/.test(decPart)) return null;
  const cents = Number(intPart) * 100 + Number((decPart + '00').slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

function validThousands(s, sep) {
  if (!s.includes(sep)) return /^\d*$/.test(s);
  const groups = s.split(sep);
  return /^\d{1,3}$/.test(groups[0]) && groups.slice(1).every((g) => /^\d{3}$/.test(g));
}

const fmtCache = {};
export function formatMoney(cents, currency = 'USD', { signed = false } = {}) {
  const key = currency;
  fmtCache[key] ||= new Intl.NumberFormat('pt-BR', { style: 'currency', currency });
  const value = Math.abs(cents) / 100;
  const text = fmtCache[key].format(value);
  if (!signed || cents === 0) return cents < 0 ? `−${text}` : text;
  return cents < 0 ? `−${text}` : `+${text}`;
}

/** Cotação (R$ por US$) formatada com 4 casas: "R$ 5,4321". */
export function formatRate(rate) {
  if (rate == null || !Number.isFinite(rate)) return '—';
  return 'R$ ' + rate.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/** Centavos -> texto editável "6,70". */
export function centsToInput(cents) {
  if (cents == null) return '';
  const s = (cents / 100).toFixed(2).replace('.', ',');
  return s;
}

export function rateOf(usdCents, brlCents) {
  if (!usdCents || !brlCents) return null;
  return brlCents / usdCents;
}

/** Data local de hoje no formato YYYY-MM-DD. */
export function todayISO(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isValidISODate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/**
 * Valida o rascunho vindo do formulário. Campos de texto (amount, brl) são strings digitadas.
 * Retorna { ok, errors, value } — value no formato persistido.
 */
export function validateDraft(draft) {
  const errors = {};
  const kind = draft.kind;
  if (!KINDS[kind]) errors.kind = 'Escolha o tipo de registro.';

  const amount = parseMoney(draft.amount);
  if (amount == null) errors.amount = 'Digite um valor válido, ex.: 6,70';
  else if (amount <= 0) errors.amount = 'O valor precisa ser maior que zero.';
  else if (amount > MAX_CENTS) errors.amount = 'Valor muito alto.';

  let currency = 'USD';
  if (kind === 'expense') {
    currency = draft.currency === 'BRL' ? 'BRL' : 'USD';
  }

  let brl = null;
  if (kind === 'buy') {
    brl = parseMoney(draft.brl);
    if (brl == null || brl <= 0) errors.brl = 'Informe quanto você pagou em reais.';
    else if (brl > MAX_CENTS) errors.brl = 'Valor muito alto.';
  }

  let category = draft.category;
  if (kind === 'buy') category = BUY_CATEGORY.id;
  else if (KINDS[kind] && !categoriesFor(kind).some((c) => c.id === category)) {
    errors.category = 'Escolha uma categoria.';
  }

  const note = String(draft.note || '').trim();
  if (note.length > MAX_NOTE) errors.note = `Máximo de ${MAX_NOTE} caracteres.`;

  if (!isValidISODate(draft.date)) errors.date = 'Data inválida.';

  const ok = Object.keys(errors).length === 0;
  return {
    ok,
    errors,
    value: ok
      ? { kind, amount_cents: amount, currency, brl_cents: brl, category, note, occurred_on: draft.date }
      : null,
  };
}

/** Resumo financeiro de uma lista de registros. */
export function summarize(txs) {
  let usdBought = 0;
  let brlPaid = 0;
  let usdIncome = 0;
  let usdSpent = 0;
  let brlSpent = 0;
  const cats = new Map();

  for (const t of txs) {
    if (t.kind === 'buy') {
      usdBought += t.amount_cents;
      brlPaid += t.brl_cents || 0;
    } else if (t.kind === 'income') {
      usdIncome += t.amount_cents;
    } else if (t.kind === 'expense') {
      const c = cats.get(t.category) || { id: t.category, usd: 0, brl: 0, count: 0 };
      if (t.currency === 'BRL') {
        brlSpent += t.amount_cents;
        c.brl += t.amount_cents;
      } else {
        usdSpent += t.amount_cents;
        c.usd += t.amount_cents;
      }
      c.count += 1;
      cats.set(t.category, c);
    }
  }

  const avgRate = rateOf(usdBought, brlPaid);
  const weightRate = avgRate ?? 1;
  const categories = [...cats.values()]
    .map((c) => ({ ...c, weight: c.brl + c.usd * weightRate }))
    .sort((a, b) => b.weight - a.weight);
  const maxWeight = categories.length ? categories[0].weight : 0;
  categories.forEach((c) => (c.share = maxWeight ? c.weight / maxWeight : 0));

  const balanceUsd = usdBought + usdIncome - usdSpent;
  return {
    usdBought,
    brlPaid,
    usdIncome,
    usdSpent,
    brlSpent,
    avgRate,
    balanceUsd,
    // Valor estimado do saldo em reais, usando a cotação média de compra.
    balanceBrlEstimate: avgRate != null ? Math.round(balanceUsd * avgRate) : null,
    // Custo total estimado: gastos em R$ + gastos em US$ convertidos pela cotação média.
    totalCostBrlEstimate: avgRate != null ? brlSpent + Math.round(usdSpent * avgRate) : null,
    categories,
    count: txs.length,
  };
}

/** Ordena do mais recente para o mais antigo. */
export function sortTxs(txs) {
  return [...txs].sort(
    (a, b) =>
      (b.occurred_on || '').localeCompare(a.occurred_on || '') ||
      (b.created_at || '').localeCompare(a.created_at || ''),
  );
}

/** Agrupa por dia (lista já ordenada ou não). */
export function groupByDay(txs) {
  const groups = [];
  let current = null;
  for (const t of sortTxs(txs)) {
    if (!current || current.date !== t.occurred_on) {
      current = { date: t.occurred_on, items: [], usdOut: 0 };
      groups.push(current);
    }
    current.items.push(t);
    if (t.kind === 'expense' && t.currency === 'USD') current.usdOut += t.amount_cents;
  }
  return groups;
}

export function filterTxs(txs, { kind = 'all', query = '', owner = null } = {}) {
  const q = normalize(query);
  return txs.filter((t) => {
    if (kind !== 'all' && t.kind !== kind) return false;
    if (owner && t.author !== owner) return false;
    if (q) {
      const hay = normalize(`${t.note || ''} ${categoryInfo(t.category).label}`);
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function normalize(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

const WEEKDAY_FMT = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' });

export function dayLabel(iso, today = todayISO()) {
  if (iso === today) return 'Hoje';
  const [y, m, d] = today.split('-').map(Number);
  const yesterday = todayISO(new Date(y, m - 1, d - 1));
  if (iso === yesterday) return 'Ontem';
  const [yy, mm, dd] = iso.split('-').map(Number);
  const label = WEEKDAY_FMT.format(new Date(yy, mm - 1, dd)).replace(/\./g, '');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Exporta registros para CSV (separador ";" para abrir direto no Excel/Numbers pt-BR). */
export function toCSV(txs) {
  const header = ['data', 'pessoa', 'tipo', 'categoria', 'descricao', 'moeda', 'valor', 'pago_em_reais'];
  const num = (c) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
  const cell = (v) => {
    const s = String(v ?? '');
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = sortTxs(txs).map((t) =>
    [
      t.occurred_on,
      t.author || '',
      KINDS[t.kind]?.label || t.kind,
      categoryInfo(t.category).label,
      t.note || '',
      t.currency,
      num(t.amount_cents),
      t.kind === 'buy' ? num(t.brl_cents) : '',
    ]
      .map(cell)
      .join(';'),
  );
  return [header.join(';'), ...rows].join('\n');
}
