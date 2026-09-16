import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runChecks, runVerdict } from '../src/checks';
import { extractClaimsWithRules } from '../src/extract';
import { round, score } from '../src/score';
import type { CheckedClaim, RunVerdict } from '../src/schema';
import { FAILURE_CLASSES, SEED_VERSION, type FailureClass } from '../seed/spec';
import { loadLabels, loadSeedRuns } from '../seed/load';

interface Row {
  run_id: string;
  predicted: RunVerdict;
  actual: FailureClass | null;
  claims: CheckedClaim[];
}

describe('eval: rules extractor + deterministic checks over the seed', () => {
  it('scores the pipeline against the labels and writes docs/eval-report.json', () => {
    const runs = loadSeedRuns();
    const labels = loadLabels();
    expect(runs.length).toBe(200);
    expect(Object.values(labels).filter((l) => l.failure).length).toBe(60);

    const rows: Row[] = runs.map((run) => {
      const claims = runChecks(run, extractClaimsWithRules(run));
      return {
        run_id: run.run_id,
        predicted: runVerdict(claims),
        actual: labels[run.run_id]?.failure ?? null,
        claims,
      };
    });

    const scores = score(rows.map((r) => ({ predicted: r.predicted, actualFail: r.actual !== null })));

    const perClass: Record<string, { labelled: number; caught: number; recall: number }> = {};
    for (const failure of FAILURE_CLASSES) {
      const subset = rows.filter((r) => r.actual === failure);
      const caught = subset.filter((r) => r.predicted === 'FAIL').length;
      perClass[failure] = {
        labelled: subset.length,
        caught,
        recall: subset.length === 0 ? 0 : round(caught / subset.length),
      };
    }

    const falsePositives = rows
      .filter((r) => r.actual === null && r.predicted === 'FAIL')
      .map((r) => ({
        run_id: r.run_id,
        claims: r.claims
          .filter((c) => c.verdict === 'CONTRADICTED')
          .map((c) => ({ kind: c.kind, text: c.text, reason: c.evidence.reason })),
      }));
    const missed = rows.filter((r) => r.actual !== null && r.predicted !== 'FAIL').map((r) => ({ run_id: r.run_id, actual: r.actual }));

    const claimCount = rows.reduce((n, r) => n + r.claims.length, 0);
    const byVerdict = rows
      .flatMap((r) => r.claims)
      .reduce<Record<string, number>>((acc, c) => {
        acc[c.verdict] = (acc[c.verdict] ?? 0) + 1;
        return acc;
      }, {});

    const byKind = rows
      .flatMap((r) => r.claims)
      .reduce<Record<string, number>>((acc, c) => {
        acc[c.kind] = (acc[c.kind] ?? 0) + 1;
        return acc;
      }, {});

    // Stated plainly, because a table of 100%s is a claim like any other and this
    // one is checked against nothing but itself.
    const caveats = [
      'The seed transcripts are generated from templates and the rules extractor was written against those templates, so its recall here is a ceiling, not a forecast. Session 2 runs the same seed through an LLM extractor and an LLM-judge-only baseline; that ablation is the honest comparison.',
      'The seed produced no UNVERIFIABLE claims, so the triage path is exercised by unit tests only.',
      'Synthetic data throughout: fictional company, fictional callers, +1555 numbers. No real transcript is in this repo.',
    ];

    const report = {
      run_at: new Date().toISOString(),
      seed_version: SEED_VERSION,
      extractor: 'rules',
      triage: 'none',
      runs: rows.length,
      labelled_failures: rows.filter((r) => r.actual !== null).length,
      claims_extracted: claimCount,
      claims_by_verdict: byVerdict,
      claims_by_kind: byKind,
      precision: round(scores.precision),
      recall: round(scores.recall),
      f1: round(scores.f1),
      confusion: { tp: scores.tp, fp: scores.fp, fn: scores.fn, tn: scores.tn },
      per_class: perClass,
      false_positives: falsePositives,
      missed,
      caveats,
    };

    mkdirSync(join(process.cwd(), 'docs'), { recursive: true });
    writeFileSync(join(process.cwd(), 'docs', 'eval-report.json'), JSON.stringify(report, null, 2) + '\n');

    const pct = (n: number) => `${(n * 100).toFixed(1)}%`.padStart(7);
    const lines: string[] = [];
    lines.push('');
    lines.push(`Second Look - eval  (seed ${SEED_VERSION}, extractor: rules, ${rows.length} runs, ${claimCount} claims)`);
    lines.push('');
    lines.push('  run-level FAIL detection      precision   recall       f1');
    lines.push(`                              ${pct(scores.precision)}  ${pct(scores.recall)}  ${pct(scores.f1)}`);
    lines.push(`  confusion: tp=${scores.tp} fp=${scores.fp} fn=${scores.fn} tn=${scores.tn}`);
    lines.push('');
    lines.push('  failure class                 labelled   caught   recall');
    for (const failure of FAILURE_CLASSES) {
      const c = perClass[failure];
      lines.push(`  ${failure.padEnd(28)}${String(c.labelled).padStart(8)}${String(c.caught).padStart(9)}${pct(c.recall)}`);
    }
    lines.push('');
    lines.push(`  claim verdicts: ${Object.entries(byVerdict).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    lines.push(`  caveat: ${caveats[0]}`);
    lines.push('');
    lines.push(`  wrote docs/eval-report.json`);
    lines.push('');
    console.log(lines.join('\n'));

    // Honest floors: the deterministic layer alone must catch nearly everything it
    // is supposed to catch, and must not cry wolf on clean runs.
    expect(scores.recall).toBeGreaterThanOrEqual(0.9);
    expect(scores.precision).toBeGreaterThanOrEqual(0.9);
    for (const failure of FAILURE_CLASSES) {
      expect(perClass[failure].recall).toBeGreaterThanOrEqual(0.8);
    }
  });
});
