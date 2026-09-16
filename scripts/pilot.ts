/** A 3-run smoke test before spending anything on the full eval. */
import { runChecks, runVerdict } from '../src/checks';
import { createLlmExtractor } from '../src/extract';
import { createLlmClient } from '../src/llm';
import { fileCache } from '../src/llm-cache-node';
import { loadDevVars } from '../src/dev-vars';
import { loadLabels, loadSeedRuns } from '../seed/load';

async function main() {
  loadDevVars();
  const client = createLlmClient(process.env, fileCache);
  if (!client) throw new Error('no LLM key found');
  console.log(`provider=${client.provider} model=${client.model}\n`);

  const runs = loadSeedRuns();
  const labels = loadLabels();
  const sample = [
    runs.find((r) => labels[r.run_id].failure === 'booking_phantom')!,
    runs.find((r) => labels[r.run_id].failure === null)!,
    runs.find((r) => labels[r.run_id].failure === 'transfer_promised_not_done')!,
  ];

  const extractor = createLlmExtractor(client);
  for (const run of sample) {
    const { claims, usage } = await extractor.extractWithUsage(run);
    const checked = runChecks(run, claims);
    console.log(`--- ${run.run_id}  label=${labels[run.run_id].failure ?? 'clean'}  verdict=${runVerdict(checked)}  (${usage.input_tokens}in/${usage.output_tokens}out $${usage.cost_usd.toFixed(5)})`);
    for (const c of checked) {
      console.log(`    ${c.verdict.padEnd(13)} ${c.kind.padEnd(8)} ${JSON.stringify(c.normalized)}`);
      console.log(`      "${c.text}"`);
      console.log(`      checked: ${c.evidence.checked}${c.evidence.reason ? ` | ${c.evidence.reason}` : ''}`);
    }
  }
  console.log(`\ntotal so far: $${extractor.usage.cost_usd.toFixed(5)} over ${extractor.usage.calls} calls`);
}
main();
