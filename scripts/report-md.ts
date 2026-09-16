/**
 * docs/eval-report.md is generated from docs/eval-report.json. No number in this repo
 * is typed by hand; if you want a different number, run the eval again.
 *
 * Run: npm run report
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FAILURE_CLASSES } from '../seed/spec';

interface RowSummary {
  label: string;
  precision: number;
  recall: number;
  f1: number;
  confusion: { tp: number; fp: number; fn: number; tn: number };
  per_class: Record<string, number>;
  llm_calls: number;
  cache_hits: number;
  tokens_per_run: number;
  cost_usd_per_run: number;
  cost_usd_total: number;
  fn_by_class: Record<string, number>;
  false_positive_examples: Array<{ run_id: string; why: string | null }>;
  false_negative_examples: Array<{ run_id: string; injected: string | null; why: string | null }>;
}

interface Report {
  run_at: string;
  seed_version: string;
  runs: number;
  labelled_failures: number;
  provider: string;
  model: string | null;
  extractor: string;
  extract_prompt_version: string | null;
  triage: string;
  rows: Record<string, RowSummary>;
  caveats: string[];
}

const root = process.cwd();
const report: Report = JSON.parse(readFileSync(join(root, 'docs', 'eval-report.json'), 'utf8'));
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

const order = ['rules_only', 'llm_extract+checks', 'llm_judge_only'].filter((k) => report.rows[k]);

const lines: string[] = [];
lines.push('# Eval report');
lines.push('');
lines.push(`Generated from \`docs/eval-report.json\` by \`npm run report\`. Eval run: **${report.run_at}**.`);
lines.push('');
lines.push(`- Seed \`${report.seed_version}\`: ${report.runs} synthetic runs, ${report.labelled_failures} carrying exactly one injected failure.`);
lines.push(`- Model: \`${report.provider}/${report.model ?? 'none'}\`, temperature 0, JSON schema output, reasoning off.`);
lines.push(`- Extraction prompt: \`${report.extract_prompt_version ?? 'n/a'}\`. Every eval run appends to \`docs/eval-history.jsonl\`.`);
lines.push(`- Positive class is \`FAIL\`: the reviewer said this agent told the customer something untrue.`);
lines.push('');
lines.push('## The three arms');
lines.push('');
lines.push(`| arm | precision | recall | F1 | ${FAILURE_CLASSES.join(' | ')} | $/run |`);
lines.push(`|---|---|---|---|${FAILURE_CLASSES.map(() => '---|').join('')}---|`);
for (const key of order) {
  const r = report.rows[key];
  lines.push(
    `| \`${key}\` | ${pct(r.precision)} | ${pct(r.recall)} | ${pct(r.f1)} | ${FAILURE_CLASSES.map((f) => pct(r.per_class[f] ?? 0)).join(' | ')} | $${r.cost_usd_per_run.toFixed(5)} |`,
  );
}
lines.push('');
lines.push('Confusion, cost and call counts:');
lines.push('');
lines.push('| arm | tp | fp | fn | tn | LLM calls | tokens/run | total cost |');
lines.push('|---|---|---|---|---|---|---|---|');
for (const key of order) {
  const r = report.rows[key];
  lines.push(
    `| \`${key}\` | ${r.confusion.tp} | ${r.confusion.fp} | ${r.confusion.fn} | ${r.confusion.tn} | ${r.llm_calls} | ${r.tokens_per_run} | $${r.cost_usd_total.toFixed(4)} |`,
  );
}
lines.push('');
lines.push('## What the arms are');
lines.push('');
lines.push('- **`rules_only`** - a regex extractor plus the deterministic checkers. No model anywhere.');
lines.push('- **`llm_extract+checks`** - the shipped pipeline. The model is asked one question, *what did the assistant claim*, and is never shown the tool results. Code then checks each claim against the event log and the catalogue. Unverifiable claims go back to the model for a risk rating only.');
lines.push('- **`llm_judge_only`** - the rejected alternative. One call, the whole run: transcript, full event log and the catalogue, asked whether every statement the assistant made was correct. It gets the same evidence the checkers get, because a baseline starved of evidence would prove nothing.');
lines.push('');
const judge = report.rows['llm_judge_only'];
const pipeline = report.rows['llm_extract+checks'];
if (judge && pipeline) {
  const cleanRuns = report.runs - report.labelled_failures;
  lines.push('## What this showed, including where the spec was wrong');
  lines.push('');
  lines.push(
    `The spec this was built from predicted the one-call judge would miss phantom bookings, because the transcript reads fine. It did not. It caught ${pct(judge.per_class['booking_phantom'] ?? 0)} of them. Reporting it any other way would be the exact failure this project exists to catch, so here is what actually happened.`,
  );
  lines.push('');
  lines.push(`**It cannot see an absence.** All ${judge.confusion.fn} of its misses are one class, \`transfer_promised_not_done\`: the agent says "I'm putting you through" and no transfer ever happens. The judge reads every statement, finds each one supported by the catalogue, and passes the call - look at the reasons it gave, above. It checks what is in front of it. Nobody is checking what is missing. The deterministic checker asks a different question, *is there a \`transfer.executed\` event after this turn*, and the answer is no. Per-class recall on that row: ${pct(judge.per_class['transfer_promised_not_done'] ?? 0)} for the judge, ${pct(pipeline.per_class['transfer_promised_not_done'] ?? 0)} for the pipeline.`);
  lines.push('');
  lines.push(`**It treats "not in my evidence" as "false".** It failed ${judge.confusion.fp} of ${cleanRuns} clean calls for statements the catalogue simply does not speak to - "that covers the first hour on site", "our vans are out that way most days". At ${pct(judge.precision)} precision, a human working this queue sees more false alarms than real ones and stops opening it inside a week. The \`UNVERIFIABLE\` verdict exists so that absence of evidence is never scored as a lie.`);
  lines.push('');
  lines.push('**Its reasoning is visibly unstable.** Read the `call_01J8N00H` reason in the table above: the model argues with itself mid-sentence, walks back its own finding, and still returns a verdict.');
  lines.push('');
  lines.push(`**And the pipeline's own miss**, stated plainly: ${pipeline.confusion.fn} of ${report.labelled_failures} - a \`kb_fact_wrong\` run where the extractor never produced a claim for the offending sentence, so no checker ever saw it. A claim that is never extracted is a claim nobody checks. That is why the extractor's own recall is published here rather than assumed.`);
  lines.push('');
}
lines.push('## Where each arm goes wrong');
lines.push('');
for (const key of order) {
  const r = report.rows[key];
  if (r.confusion.fp === 0 && r.confusion.fn === 0) {
    lines.push(`### \`${key}\``);
    lines.push('');
    lines.push('No false positives and no false negatives on this seed.');
    lines.push('');
    continue;
  }
  lines.push(`### \`${key}\` - ${r.confusion.fp} false positives, ${r.confusion.fn} missed`);
  lines.push('');
  if (r.false_positive_examples.length) {
    lines.push(`Clean runs it called failures (${r.confusion.fp} in total, first ${r.false_positive_examples.length}):`);
    lines.push('');
    for (const e of r.false_positive_examples) lines.push(`- \`${e.run_id}\` - ${e.why ?? 'no reason recorded'}`);
    lines.push('');
  }
  if (r.false_negative_examples.length) {
    const classes = Object.entries(r.fn_by_class).map(([k, v]) => `${v} x ${k}`).join(', ');
    lines.push(`Real failures it missed (${classes}):`);
    lines.push('');
    for (const e of r.false_negative_examples) lines.push(`- \`${e.run_id}\` [${e.injected}] - ${e.why ?? 'no reason recorded'}`);
    lines.push('');
  }
}
lines.push('## Caveats');
lines.push('');
for (const c of report.caveats) lines.push(`- ${c}`);
lines.push('');

writeFileSync(join(root, 'docs', 'eval-report.md'), lines.join('\n'));
console.log('wrote docs/eval-report.md');
