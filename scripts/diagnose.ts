/** Why did the pipeline call a clean run a failure? Runs off the LLM cache, so it is free. */
import { loadDevVars } from '../src/dev-vars';
import { fileCache } from '../src/llm-cache-node';
import { pool } from '../src/pool';
import { createLlmExtractor } from '../src/extract';
import { createLlmClient } from '../src/llm';
import { reviewRun } from '../src/review';
import { createLlmTriager } from '../src/triage';
import { loadLabels, loadSeedRuns } from '../seed/load';
loadDevVars();

async function main() {
  const client = createLlmClient(process.env, fileCache)!;
  const runs = loadSeedRuns();
  const labels = loadLabels();
  const extractor = createLlmExtractor(client);
  const triager = createLlmTriager(client);

  const results = await pool(runs, 8, (run) => reviewRun(run, { extractor, triager }));
  const buckets = new Map<string, { count: number; samples: string[] }>();

  results.forEach((res, i) => {
    const run = runs[i];
    if (labels[run.run_id].failure !== null) return;
    for (const c of res.claims) {
      if (c.verdict !== 'CONTRADICTED') continue;
      const key = `${c.kind} :: ${c.checker} :: ${(c.evidence.reason ?? c.evidence.checked).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d/g, '<slot>').replace(/\$\d+/g, '$N').replace(/\d{5}/g, '<code>')}`;
      const b = buckets.get(key) ?? { count: 0, samples: [] };
      b.count++;
      if (b.samples.length < 2) b.samples.push(`${run.run_id} "${c.text}" -> ${JSON.stringify(c.normalized)}`);
      buckets.set(key, b);
    }
  });

  const sorted = [...buckets.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log(`false-positive CONTRADICTED claims on clean runs, grouped:\n`);
  for (const [key, b] of sorted) {
    console.log(`[${b.count}] ${key}`);
    for (const s of b.samples) console.log(`      ${s}`);
  }
  console.log(`\nspend on this diagnostic: $${extractor.usage.cost_usd.toFixed(5)} (${extractor.usage.calls} live calls, ${extractor.usage.cache_hits} cached)`);
}
main();
