import { AgentRunSchema, type AgentRun } from './schema';
import type { Env } from './env';

export type IngestOutcome =
  | { status: 'created'; run_id: string }
  | { status: 'unchanged'; run_id: string }
  | { status: 'conflict'; run_id: string }
  | { status: 'schema'; issues: unknown };

/**
 * Idempotent on run_id: the same body again is a no-op, a different body under the same id
 * is a 409 rather than a silent overwrite. An exporter that retries on a timeout must not
 * be able to quietly rewrite history.
 */
export async function ingestRun(env: Env, body: unknown, opts: { isSeed?: boolean } = {}): Promise<IngestOutcome> {
  const parsed = AgentRunSchema.safeParse(body);
  if (!parsed.success) return { status: 'schema', issues: parsed.error.issues };

  const run: AgentRun = parsed.data;
  const raw = JSON.stringify(run);

  const existing = await env.DB.prepare('SELECT raw FROM runs WHERE run_id = ?').bind(run.run_id).first<{ raw: string }>();
  if (existing) {
    return existing.raw === raw ? { status: 'unchanged', run_id: run.run_id } : { status: 'conflict', run_id: run.run_id };
  }

  await env.DB.prepare(
    'INSERT INTO runs (run_id, agent, started_at, ended_at, raw, status, is_seed) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(run.run_id, run.agent, run.started_at, run.ended_at ?? null, raw, 'pending', opts.isSeed ? 1 : 0)
    .run();

  return { status: 'created', run_id: run.run_id };
}
