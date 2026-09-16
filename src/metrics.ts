import evalReport from '../docs/eval-report.json';
import type { Env } from './env';

/**
 * daily_metrics is recomputed from the claims table rather than incremented, so a human
 * override or a re-review can never leave the dashboard disagreeing with the rows.
 */
export async function recomputeDailyMetrics(env: Env, agent: string, day: string): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT r.run_id, r.verdict, h.decision
     FROM runs r LEFT JOIN human_reviews h ON h.run_id = r.run_id
     WHERE r.agent = ? AND substr(r.started_at, 1, 10) = ? AND r.verdict IS NOT NULL`,
  )
    .bind(agent, day)
    .all<{ run_id: string; verdict: string; decision: string | null }>();

  const rows = results ?? [];
  const effective = (r: { verdict: string; decision: string | null }) =>
    r.decision === 'override_pass' ? 'PASS' : r.decision === 'override_fail' ? 'FAIL' : r.verdict;

  const fail = rows.filter((r) => effective(r) === 'FAIL').length;
  const needsHuman = rows.filter((r) => effective(r) === 'NEEDS_HUMAN').length;

  const failedIds = rows.filter((r) => effective(r) === 'FAIL').map((r) => r.run_id);
  const byKind: Record<string, number> = {};
  if (failedIds.length) {
    const placeholders = failedIds.map(() => '?').join(',');
    const { results: kinds } = await env.DB.prepare(
      `SELECT kind, COUNT(*) AS n FROM claims WHERE verdict = 'CONTRADICTED' AND run_id IN (${placeholders}) GROUP BY kind`,
    )
      .bind(...failedIds)
      .all<{ kind: string; n: number }>();
    for (const k of kinds ?? []) byKind[k.kind] = k.n;
  }

  await env.DB.prepare(
    `INSERT INTO daily_metrics (day, agent, runs, fail, needs_human, contradicted_by_kind)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(day, agent) DO UPDATE SET runs = excluded.runs, fail = excluded.fail,
       needs_human = excluded.needs_human, contradicted_by_kind = excluded.contradicted_by_kind`,
  )
    .bind(day, agent, rows.length, fail, needsHuman, JSON.stringify(byKind))
    .run();
}

export interface MetricsQuery {
  agent?: string;
  days?: number;
}

/**
 * The judge block is the reviewer's own score, read from the eval report bundled at build.
 * A tool that grades other agents has to publish its own grade.
 */
export function judgeBlock() {
  const report = evalReport as Record<string, any>;
  return {
    precision: report.precision,
    recall: report.recall,
    f1: report.f1,
    model: report.model,
    extractor: report.extractor,
    seed_version: report.seed_version,
    measured_at: report.run_at,
    from: 'docs/eval-report.json',
    status: 'ok' as const,
  };
}

export async function readMetrics(env: Env, query: MetricsQuery) {
  const days = Math.min(Math.max(query.days ?? 30, 1), 365);
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const sql = query.agent
    ? `SELECT day, agent, runs, fail, needs_human, contradicted_by_kind FROM daily_metrics WHERE day >= ? AND agent = ? ORDER BY day ASC`
    : `SELECT day, agent, runs, fail, needs_human, contradicted_by_kind FROM daily_metrics WHERE day >= ? ORDER BY day ASC`;
  const stmt = query.agent ? env.DB.prepare(sql).bind(since, query.agent) : env.DB.prepare(sql).bind(since);
  const { results } = await stmt.all<{
    day: string;
    agent: string;
    runs: number;
    fail: number;
    needs_human: number;
    contradicted_by_kind: string;
  }>();

  const byDay = new Map<string, { day: string; runs: number; fail: number; needs_human: number; contradicted_by_kind: Record<string, number> }>();
  for (const row of results ?? []) {
    const entry = byDay.get(row.day) ?? { day: row.day, runs: 0, fail: 0, needs_human: 0, contradicted_by_kind: {} };
    entry.runs += row.runs;
    entry.fail += row.fail;
    entry.needs_human += row.needs_human;
    for (const [kind, n] of Object.entries(JSON.parse(row.contradicted_by_kind) as Record<string, number>)) {
      entry.contradicted_by_kind[kind] = (entry.contradicted_by_kind[kind] ?? 0) + n;
    }
    byDay.set(row.day, entry);
  }

  const daysOut = [...byDay.values()];
  const totals = daysOut.reduce(
    (acc, d) => {
      acc.runs += d.runs;
      acc.fail += d.fail;
      acc.needs_human += d.needs_human;
      for (const [kind, n] of Object.entries(d.contradicted_by_kind)) acc.contradicted_by_kind[kind] = (acc.contradicted_by_kind[kind] ?? 0) + n;
      return acc;
    },
    { runs: 0, fail: 0, needs_human: 0, contradicted_by_kind: {} as Record<string, number> },
  );

  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE status IN ('pending','reviewing')").first<{ n: number }>();
  const agents = await env.DB.prepare('SELECT DISTINCT agent FROM runs ORDER BY agent').all<{ agent: string }>();

  return {
    days: daysOut,
    totals: { ...totals, pass: totals.runs - totals.fail - totals.needs_human, pending: pending?.n ?? 0 },
    agents: (agents.results ?? []).map((a) => a.agent),
    judge: judgeBlock(),
  };
}
