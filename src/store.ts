import type { Env } from './env';
import { runChecks, runVerdict } from './checks';
import { createLlmExtractor, extractClaimsWithRules, rulesExtractor } from './extract';
import { createLlmClient } from './llm';
import { reviewRun } from './review';
import { AgentRunSchema, type AgentRun, type CheckedClaim, type RunVerdict } from './schema';
import { createLlmTriager, noTriage } from './triage';
import { recomputeDailyMetrics } from './metrics';

export const LEASE_MINUTES = 5;

export interface RunRow {
  run_id: string;
  agent: string;
  started_at: string;
  ended_at: string | null;
  raw: string;
  status: string;
  verdict: string | null;
  reviewed_at: string | null;
  last_error: string | null;
  lease_until: string | null;
  is_seed: number;
  ingested_at: string;
}

export function parseRun(row: RunRow): AgentRun {
  return AgentRunSchema.parse(JSON.parse(row.raw));
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Takes a 5-minute lease on a run so the cron and a manual /review cannot both work it.
 * Returns false if somebody else holds a live lease.
 */
export async function takeLease(env: Env, runId: string): Promise<boolean> {
  const leaseUntil = new Date(Date.now() + LEASE_MINUTES * 60_000).toISOString();
  const result = await env.DB.prepare(
    `UPDATE runs SET status = 'reviewing', lease_until = ?
     WHERE run_id = ? AND (status != 'reviewing' OR lease_until IS NULL OR lease_until < ?)`,
  )
    .bind(leaseUntil, runId, nowIso())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function releaseLease(env: Env, runId: string, status: string): Promise<void> {
  await env.DB.prepare('UPDATE runs SET status = ?, lease_until = NULL WHERE run_id = ?').bind(status, runId).run();
}

/**
 * Runs the pipeline and persists it. The LLM being down is never the ingester's problem:
 * the run goes back to pending with last_error and the next cron tick tries again.
 */
export async function reviewAndStore(
  env: Env,
  row: RunRow,
): Promise<{ verdict: RunVerdict; claims: CheckedClaim[] } | { error: string }> {
  const run = parseRun(row);
  const client = createLlmClient(env as unknown as Record<string, string | undefined>);
  const extractor = client ? createLlmExtractor(client) : rulesExtractor;
  const triager = client ? createLlmTriager(client) : noTriage;

  let verdict: RunVerdict;
  let claims: CheckedClaim[];
  try {
    const result = await reviewRun(run, { extractor, triager });
    verdict = result.verdict;
    claims = result.claims;
  } catch (err) {
    const message = (err as Error).message.slice(0, 400);
    await env.DB.prepare("UPDATE runs SET status = 'pending', lease_until = NULL, last_error = ? WHERE run_id = ?")
      .bind(message, run.run_id)
      .run();
    return { error: message };
  }

  const status = verdict === 'NEEDS_HUMAN' ? 'needs_human' : 'reviewed';
  const statements: D1PreparedStatement[] = [
    env.DB.prepare('DELETE FROM claims WHERE run_id = ?').bind(run.run_id),
  ];
  for (const claim of claims) {
    statements.push(
      env.DB.prepare(
        'INSERT INTO claims (run_id, turn_index, kind, text, normalized, verdict, evidence, checker, risk) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        run.run_id,
        claim.turn_index,
        claim.kind,
        claim.text,
        JSON.stringify(claim.normalized),
        claim.verdict,
        JSON.stringify(claim.evidence),
        claim.checker,
        claim.risk ?? null,
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      'UPDATE runs SET status = ?, verdict = ?, reviewed_at = ?, lease_until = NULL, last_error = NULL WHERE run_id = ?',
    ).bind(status, verdict, nowIso(), run.run_id),
  );
  await env.DB.batch(statements);
  await recomputeDailyMetrics(env, row.agent, row.started_at.slice(0, 10));

  return { verdict, claims };
}

/** Picks up pending runs plus any whose lease has expired - a crashed review is not lost. */
export async function claimPendingRuns(env: Env, limit: number): Promise<RunRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM runs
     WHERE status = 'pending' OR (status = 'reviewing' AND (lease_until IS NULL OR lease_until < ?))
     ORDER BY ingested_at ASC LIMIT ?`,
  )
    .bind(nowIso(), limit)
    .all<RunRow>();
  return results ?? [];
}
