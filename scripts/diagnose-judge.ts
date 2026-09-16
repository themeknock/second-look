/** Why does the one-call judge flag clean runs, and what does it miss? Cache-only, free. */
import { loadDevVars } from '../src/dev-vars';
import { fileCache } from '../src/llm-cache-node';
import { pool } from '../src/pool';
import { createLlmExtractor } from '../src/extract';
import { createLlmJudge } from '../src/judge';
import { createLlmClient } from '../src/llm';
import { reviewRun } from '../src/review';
import { createLlmTriager } from '../src/triage';
import { loadLabels, loadSeedRuns } from '../seed/load';
loadDevVars();

async function main() {
  const client = createLlmClient(process.env, fileCache)!;
  const runs = loadSeedRuns();
  const labels = loadLabels();
  const judge = createLlmJudge(client);

  const verdicts = await pool(runs, 8, (run) => judge.judge(run));
  const fp = runs.map((r, i) => ({ r, v: verdicts[i] })).filter(({ r, v }) => labels[r.run_id].failure === null && v.verdict === 'FAIL');
  const fn = runs.map((r, i) => ({ r, v: verdicts[i] })).filter(({ r, v }) => labels[r.run_id].failure !== null && v.verdict !== 'FAIL');

  console.log(`JUDGE-ONLY: ${fp.length} clean runs flagged as failures. Reasons:\n`);
  for (const { r, v } of fp.slice(0, 12)) console.log(`  ${r.run_id}: ${v.reason}`);
  console.log(`\nJUDGE-ONLY: ${fn.length} real failures missed:\n`);
  for (const { r, v } of fn) console.log(`  ${r.run_id} [${labels[r.run_id].failure}]: ${v.reason}`);

  // And the shipped pipeline's two errors.
  const extractor = createLlmExtractor(client);
  const triager = createLlmTriager(client);
  const results = await pool(runs, 8, (run) => reviewRun(run, { extractor, triager }));
  console.log('\nPIPELINE errors:\n');
  results.forEach((res, i) => {
    const run = runs[i];
    const label = labels[run.run_id];
    const wrong = (label.failure === null) === (res.verdict === 'FAIL');
    if (!wrong) return;
    console.log(`  ${run.run_id} label=${label.failure ?? 'clean'} verdict=${res.verdict}`);
    if (label.detail) console.log(`    injected: ${label.detail}`);
    for (const c of res.claims) {
      if (c.verdict === 'SUPPORTED') continue;
      console.log(`    ${c.verdict} ${c.kind} "${c.text}" ${JSON.stringify(c.normalized)}`);
      console.log(`      ${c.evidence.checked} | ${c.evidence.reason ?? ''}`);
    }
  });
}
main();
