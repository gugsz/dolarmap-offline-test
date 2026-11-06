// Mini framework de testes que roda no navegador (tests/run.html) e no Node (node tests/run-node.mjs).
const cases = [];

export function test(name, fn) {
  cases.push({ name, fn });
}

export const assert = {
  equal(actual, expected, msg = '') {
    if (!Object.is(actual, expected)) {
      throw new Error(`${msg} esperado ${JSON.stringify(expected)}, recebido ${JSON.stringify(actual)}`);
    }
  },
  deepEqual(actual, expected, msg = '') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${msg} esperado ${b}, recebido ${a}`);
  },
  ok(value, msg = 'esperado verdadeiro') {
    if (!value) throw new Error(msg);
  },
  async rejects(promise, check, msg = 'esperava erro') {
    try {
      await promise;
    } catch (e) {
      if (check) check(e);
      return;
    }
    throw new Error(msg);
  },
};

export async function run() {
  const results = [];
  for (const c of cases) {
    try {
      await c.fn();
      results.push({ name: c.name, ok: true });
    } catch (e) {
      results.push({ name: c.name, ok: false, error: e.message });
    }
  }
  return results;
}

export function memoryStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}
