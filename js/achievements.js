// Conquistas: marcos que disparam a comemoração em tela cheia.
// Funções puras (testáveis); quem guarda o que já foi comemorado é o main.js (localStorage).

import { summarize } from './logic.js?v=20261106offline1';

/** Saldo pessoal comemora a cada US$ 500; o saldo do casal, a cada US$ 1.000 (em centavos). */
export const PERSONAL_STEP = 50000;
export const COUPLE_STEP = 100000;

const ORDER = ['balance', 'couple', 'first-buy', 'first-income'];

/** Todas as conquistas que o usuário já tem hoje, com base nos registros. */
export function achievementsFor(txs, username, { couple = true } = {}) {
  const mine = txs.filter((t) => t.author === username);
  const list = [];
  if (mine.some((t) => t.kind === 'buy')) list.push({ id: 'first-buy', type: 'first-buy' });
  if (mine.some((t) => t.kind === 'income')) list.push({ id: 'first-income', type: 'first-income' });

  const bal = summarize(mine).balanceUsd;
  for (let v = PERSONAL_STEP; v <= bal; v += PERSONAL_STEP) list.push({ id: `balance-${v}`, type: 'balance', cents: v });

  if (couple && txs.some((t) => t.author !== username)) {
    const cb = summarize(txs).balanceUsd;
    for (let v = COUPLE_STEP; v <= cb; v += COUPLE_STEP) list.push({ id: `couple-${v}`, type: 'couple', cents: v });
  }
  return list;
}

/**
 * Conquistas novas (ainda não comemoradas). Se vários marcos do mesmo tipo forem
 * alcançados de uma vez (ex.: compra que leva de US$ 400 a US$ 1.600), comemora só o maior.
 */
export function newAchievements(current, seenIds, { max = 2 } = {}) {
  const seen = new Set(seenIds);
  const best = new Map();
  for (const a of current) {
    if (seen.has(a.id)) continue;
    const b = best.get(a.type);
    if (!b || (a.cents || 0) > (b.cents || 0)) best.set(a.type, a);
  }
  return ORDER.map((t) => best.get(t))
    .filter(Boolean)
    .slice(0, max);
}

/** Próximo marco do saldo (para a barrinha de progresso no cartão de saldo). */
export function nextMilestone(balanceCents, step = PERSONAL_STEP) {
  const prev = Math.max(0, Math.floor(balanceCents / step) * step);
  const target = prev + step;
  const progress = Math.min(1, Math.max(0, (balanceCents - prev) / step));
  return { target, missing: target - balanceCents, progress };
}

/** Maior conquista de cada tipo (para a lista em Ajustes). */
export function topPerType(list) {
  const best = new Map();
  for (const a of list) {
    const b = best.get(a.type);
    if (!b || (a.cents || 0) > (b.cents || 0)) best.set(a.type, a);
  }
  return ORDER.map((t) => best.get(t)).filter(Boolean);
}
