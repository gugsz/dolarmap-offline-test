// Executa os mesmos testes no Node 18+:  node tests/run-node.mjs
import { run } from './harness.js';
import './logic.spec.js';

const results = await run();
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ' — ' + r.error}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} testes passaram`);
process.exit(failed ? 1 : 0);
