import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runChecks, runVerdict } from '../src/checks';
import { loadDevVars } from '../src/dev-vars';
import { fileCache } from '../src/llm-cache-node';
import { pool } from '../src/pool';
import { createLlmExtractor, EXTRACT_PROMPT_VERSION, extractClaimsWithRules } from '../src/extract';
import { createLlmJudge } from '../src/judge';
import { addUsage, createLlmClient, ZERO_USAGE, type LlmUsage } from '../src/llm';
import { reviewRun } from '../src/review';
import { round, score } from '../src/score';
import type { AgentRun, CheckedClaim, RunVerdict } from '../src/schema';
import { createLlmTriager } from '../src/triage';
import { FAILURE_CLASSES, SEED_VERSION, type FailureClass } from '../seed/spec';
import { loadLabels, loadSeedRuns } from '../seed/load';

loadDevVars();

interface Outcome {
  run_id: string;
  predicted: RunVerdict;
  actual: FailureClass | null;
  claims: CheckedClaim[];
  note?: string;
}

interface Row {
  key: string;
  label: string;
  outcomes: Outcome[];
  usage: LlmUsage;
}

function summarise(row: Row, runCount: number) {
  const s = score(row.outcomes.map((o) => ({ predicted: o.predicted, actualFail: o.actual !== null })));
  const per_class: Record<string, number> = {};
  for (const failure of FAILURE_CLASSES) {
    const subset = row.outcomes.filter((o) => o.actual === failure);
    per_class[failure] = subset.length === 0 ? 0 : round(subset.filter((o) => o.predicted === 'FAIL').length / subset.length);
  }
  const falsePositives = row.outcomes.filter((o) => o.actual === null && o.predicted === 'FAIL');
  const falseNegatives = row.outcomes.filter((o) => o.actual !== null && o.predicted !== 'FAIL');
  const fn_by_class: Record<string, number> = {};
  for (const o of falseNegatives) fn_by_class[o.actual as string] = (fn_by_class[o.actual as string] ?? 0) + 1;

  return {
    label: row.label,
    precision: round(s.precision),
    recall: round(s.recall),
    f1: round(s.f1),
    confusion: { tp: s.tp, fp: s.fp, fn: s.fn, tn: s.tn },
    per_class,
    llm_calls: row.usage.calls,
    cache_hits: row.usage.cache_hits,
    tokens_per_run: round((row.usage.input_tokens + row.usage.output_tokens) / runCount),
    cost_usd_per_run: Math.round((row.usage.cost_usd / runCount) * 1e6) / 1e6,
    cost_usd_total: Math.round(row.usage.cost_usd * 1e4) / 1e4,
    fn_by_class,
    false_positive_examples: falsePositives.slice(0, 6).map((o) => ({
      run_id: o.run_id,
      why: o.note ?? o.claims.find((c) => c.verdict === 'CONTRADICTED')?.evidence.reason ?? null,
    })),
    false_negative_examples: falseNegatives.slice(0, 8).map((o) => ({
      run_id: o.run_id,
      injected: o.actual,
      why: o.note ?? null,
    })),
  };
}

describe('eval: does checking claims against evidence beat asking a model if the call went well', () => {
  it(
    'scores every arm of the ablation against the labels and writes docs/eval-report.json',
    async () => {
      const runs = loadSeedRuns();
      const labels = loadLabels();
      expect(runs.length).toBe(200);
      expect(Object.values(labels).filter((l) => l.failure).length).toBe(60);

      const actual = (run: AgentRun) => labels[run.run_id]?.failure ?? null;
      const rows: Row[] = [];

      // Row 1 - rules_only: no model anywhere in the loop.
      rows.push({
        key: 'rules_only',
        label: 'rules extractor + deterministic checks',
        usage: { ...ZERO_USAGE },
        outcomes: runs.map((run) => {
          const claims = runChecks(run, extractClaimsWithRules(run));
          return { run_id: run.run_id, predicted: runVerdict(claims), actual: actual(run), claims };
        }),
      });

      const client = createLlmClient(process.env, fileCache);

      if (client) {
        // Row 2 - the real pipeline: LLM says what was claimed, code says whether it holds.
        const extractor = createLlmExtractor(client);
        const triager = createLlmTriager(client);
        let usage2 = { ...ZERO_USAGE };
        const outcomes2 = await pool(runs, 6, async (run) => {
          const result = await reviewRun(run, { extractor, triager });
          usage2 = addUsage(usage2, result.usage);
          return { run_id: run.run_id, predicted: result.verdict, actual: actual(run), claims: result.claims };
        });
        rows.push({ key: 'llm_extract+checks', label: `LLM extraction + deterministic checks (${client.model})`, outcomes: outcomes2, usage: usage2 });

        // Row 3 - the rejected alternative: one model call over the whole run, asked to rule.
        const judge = createLlmJudge(client);
        let usage3 = { ...ZERO_USAGE };
        const outcomes3 = await pool(runs, 6, async (run) => {
          const result = await judge.judge(run);
          usage3 = addUsage(usage3, result.usage);
          return { run_id: run.run_id, predicted: result.verdict, actual: actual(run), claims: [], note: result.reason };
        });
        rows.push({ key: 'llm_judge_only', label: `LLM-judge-only baseline (${client.model})`, outcomes: outcomes3, usage: usage3 });
      }

      const summaries = Object.fromEntries(rows.map((r) => [r.key, summarise(r, runs.length)]));
      const production = summaries['llm_extract+checks'] ?? summaries['rules_only'];
      const extractorName = client ? `llm:${client.model}` : 'rules';

      const caveats = [
        'The seed is synthetic and labelled: a fictional company, fictional callers, +1555 numbers. No real transcript is in this repo.',
        'The rules row is a ceiling, not a forecast: that extractor was written against the same templates that generated the transcripts.',
        'All three rows see the same evidence. The judge baseline is given the full transcript, the full event log AND the catalogue, because a baseline starved of evidence would prove nothing.',
      ];

      const report = {
        run_at: new Date().toISOString(),
        seed_version: SEED_VERSION,
        runs: runs.length,
        labelled_failures: runs.filter((r) => actual(r) !== null).length,
        provider: client?.provider ?? 'none',
        model: client?.model ?? null,
        extractor: extractorName,
        extract_prompt_version: client ? EXTRACT_PROMPT_VERSION : null,
        triage: client ? 'llm' : 'none',
        precision: production.precision,
        recall: production.recall,
        f1: production.f1,
        cost_usd_per_run: production.cost_usd_per_run,
        rows: summaries,
        caveats,
      };

      mkdirSync(join(process.cwd(), 'docs'), { recursive: true });
      writeFileSync(join(process.cwd(), 'docs', 'eval-report.json'), JSON.stringify(report, null, 2) + '\n');
      // Every run appends one line, so a later number can always be compared with an
      // earlier one without anybody retyping either.
      appendFileSync(
        join(process.cwd(), 'docs', 'eval-history.jsonl'),
        JSON.stringify({
          run_at: report.run_at,
          model: report.model,
          extract_prompt_version: report.extract_prompt_version,
          rows: Object.fromEntries(Object.entries(summaries).map(([k, v]) => [k, { precision: v.precision, recall: v.recall, f1: v.f1, per_class: v.per_class }])),
        }) + '\n',
      );

      const pct = (n: number) => `${(n * 100).toFixed(0)}%`.padStart(6);
      const out: string[] = [''];
      out.push(`Second Look - ablation   seed ${SEED_VERSION} - ${runs.length} runs, ${report.labelled_failures} with one injected failure each`);
      out.push(client ? `model: ${client.provider}/${client.model}, temperature 0` : 'no LLM key set: rules row only');
      out.push('');
      out.push(`  ${'arm'.padEnd(34)}${'prec'.padStart(6)}${'recall'.padStart(7)}${'f1'.padStart(6)}   ${FAILURE_CLASSES.map((f) => f.slice(0, 9).padStart(10)).join('')}   ${'$/run'.padStart(8)}`);
      for (const r of rows) {
        const s = summaries[r.key];
        out.push(
          `  ${r.key.padEnd(34)}${pct(s.precision)}${pct(s.recall)}${pct(s.f1)}   ${FAILURE_CLASSES.map((f) => pct(s.per_class[f]).padStart(10)).join('')}   ${('$' + s.cost_usd_per_run.toFixed(5)).padStart(8)}`,
        );
      }
      out.push('');
      out.push(`  classes: ${FAILURE_CLASSES.join('  ')}`);
      for (const r of rows) {
        const s = summaries[r.key];
        out.push(`  ${r.key}: tp=${s.confusion.tp} fp=${s.confusion.fp} fn=${s.confusion.fn} tn=${s.confusion.tn}  calls=${s.llm_calls} cached=${s.cache_hits}  total=$${s.cost_usd_total}`);
      }
      out.push('');
      out.push('  wrote docs/eval-report.json');
      out.push('');
      console.log(out.join('\n'));

      // Floors for the deterministic layer only. Nothing here asserts which arm wins:
      // the comparison is the finding, and tuning a baseline to lose would be fraud.
      const rules = summaries['rules_only'];
      expect(rules.recall).toBeGreaterThanOrEqual(0.9);
      expect(rules.precision).toBeGreaterThanOrEqual(0.9);
      for (const row of rows) expect(row.outcomes.length).toBe(runs.length);
      if (client) {
        expect(summaries['llm_extract+checks']).toBeDefined();
        expect(summaries['llm_judge_only']).toBeDefined();
        expect(report.cost_usd_per_run).toBeGreaterThan(0);
      }
    },
    900_000,
  );
});
