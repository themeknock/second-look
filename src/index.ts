import { Hono } from 'hono';
import { bearerAuth } from './auth';
import type { Env } from './env';
import { ingestRun } from './ingest';
import { judgeBlock, readMetrics, recomputeDailyMetrics } from './metrics';
import { renderDashboard } from './page';
import { pool } from './pool';
import { claimPendingRuns, parseRun, releaseLease, reviewAndStore, takeLease, type RunRow } from './store';

const app = new Hono<{ Bindings: Env }>();

/* ---------- public ---------- */

app.get('/', async (c) => {
  const agent = c.req.query('agent') ?? undefined;
  const metrics = await readMetrics(c.env, { agent, days: 30 });

  // The queue is what a human still has to look at: anything failed or escalated, with the
  // ones already decided sinking to the bottom.
  const { results: queueRows } = await c.env.DB.prepare(
    `SELECT run_id, agent, started_at, status, verdict, raw FROM runs
     WHERE verdict IN ('FAIL','NEEDS_HUMAN') ${agent ? 'AND agent = ?' : ''}
     ORDER BY (status = 'human_done') ASC, (verdict = 'FAIL') DESC, started_at DESC LIMIT 12`,
  )
    .bind(...(agent ? [agent] : []))
    .all<{ run_id: string; agent: string; started_at: string; status: string; verdict: string; raw: string }>();

  const rows = queueRows ?? [];
  const ids = rows.map((r) => r.run_id);
  const placeholders = ids.map(() => '?').join(',');

  const claimsByRun = new Map<string, any[]>();
  const humanByRun = new Map<string, any>();
  if (ids.length) {
    const { results: claims } = await c.env.DB.prepare(
      `SELECT * FROM claims WHERE run_id IN (${placeholders}) ORDER BY turn_index, id`,
    )
      .bind(...ids)
      .all<any>();
    for (const claim of claims ?? []) {
      const list = claimsByRun.get(claim.run_id) ?? [];
      list.push({ ...claim, normalized: JSON.parse(claim.normalized), evidence: JSON.parse(claim.evidence) });
      claimsByRun.set(claim.run_id, list);
    }
    const { results: humans } = await c.env.DB.prepare(
      `SELECT * FROM human_reviews WHERE run_id IN (${placeholders})`,
    )
      .bind(...ids)
      .all<any>();
    for (const h of humans ?? []) humanByRun.set(h.run_id, h);
  }

  const queue = rows.map((row) => {
    const run = JSON.parse(row.raw);
    return {
      run_id: row.run_id,
      agent: row.agent,
      started_at: row.started_at,
      status: row.status,
      verdict: row.verdict,
      transcript: run.transcript,
      claims: claimsByRun.get(row.run_id) ?? [],
      human: humanByRun.get(row.run_id) ?? null,
    };
  });

  return c.html(renderDashboard({ metrics, queue, agent }));
});

app.get('/metrics', async (c) => {
  const days = Number(c.req.query('days') ?? 30);
  return c.json(await readMetrics(c.env, { agent: c.req.query('agent') ?? undefined, days }));
});

/** A seed run is public so the eval is inspectable. A real run needs the key. */
app.get('/runs/:run_id/public', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM runs WHERE run_id = ?').bind(c.req.param('run_id')).first<RunRow>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (!row.is_seed) return c.json({ error: 'unauthorized', detail: 'only seed runs are public' }, 401);
  return c.json(await runDetail(c.env, row));
});

/* ---------- authenticated ---------- */

app.use('/ingest', bearerAuth());
app.use('/review/*', bearerAuth());
app.use('/runs', bearerAuth());
app.use('/runs/:run_id', bearerAuth());
app.use('/runs/:run_id/human', async (c, next) => {
  // A seed run is labelled synthetic data and its whole point is to be clicked through by a
  // stranger. A real run needs the key, always.
  const row = await c.env.DB.prepare('SELECT is_seed FROM runs WHERE run_id = ?')
    .bind(c.req.param('run_id'))
    .first<{ is_seed: number }>();
  if (row?.is_seed) return next();
  return bearerAuth()(c, next);
});

app.post('/ingest', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'schema', issues: [{ message: 'body is not JSON' }] }, 400);
  }
  const outcome = await ingestRun(c.env, body, { isSeed: c.req.query('seed') === '1' });
  switch (outcome.status) {
    case 'created':
      return c.json({ run_id: outcome.run_id, status: 'pending' }, 201);
    case 'unchanged':
      return c.json({ run_id: outcome.run_id, status: 'unchanged' }, 200);
    case 'conflict':
      return c.json({ error: 'conflict', detail: 'this run_id already exists with a different body' }, 409);
    default: {
      const issues = outcome.issues as Array<{ path?: unknown[] }>;
      const noEvents = issues.some((i) => Array.isArray(i.path) && i.path[0] === 'events');
      return c.json(
        {
          error: 'schema',
          detail: noEvents ? 'nothing to check against: a run must carry its events[]' : 'the run does not match the ingest schema',
          issues,
        },
        400,
      );
    }
  }
});

app.post('/review/:run_id', async (c) => {
  const runId = c.req.param('run_id');
  const row = await c.env.DB.prepare('SELECT * FROM runs WHERE run_id = ?').bind(runId).first<RunRow>();
  if (!row) return c.json({ error: 'not_found' }, 404);

  if (!(await takeLease(c.env, runId))) {
    return c.json({ error: 'conflict', detail: 'this run is already being reviewed' }, 409);
  }
  const result = await reviewAndStore(c.env, row);
  if ('error' in result) {
    return c.json({ error: 'llm', detail: result.error, status: 'pending' }, 503);
  }
  return c.json({ run_id: runId, verdict: result.verdict, claims: result.claims });
});

app.get('/runs', async (c) => {
  const status = c.req.query('status');
  const agent = c.req.query('agent');
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (status) {
    where.push('status = ?');
    binds.push(status);
  }
  if (agent) {
    where.push('agent = ?');
    binds.push(agent);
  }
  const sql = `SELECT run_id, agent, started_at, ended_at, status, verdict, reviewed_at, last_error
               FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY started_at DESC LIMIT ?`;
  const { results } = await c.env.DB.prepare(sql)
    .bind(...binds, limit)
    .all();
  return c.json({ runs: results ?? [] });
});

app.get('/runs/:run_id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM runs WHERE run_id = ?').bind(c.req.param('run_id')).first<RunRow>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(await runDetail(c.env, row));
});

/** The click that closes the loop. A human decision is never overwritten by a re-review. */
app.post('/runs/:run_id/human', async (c) => {
  const runId = c.req.param('run_id');
  let body: { decision?: string; note?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'schema', issues: [{ message: 'body is not JSON' }] }, 400);
  }
  const decision = body.decision ?? '';
  if (!['agree', 'override_pass', 'override_fail'].includes(decision)) {
    return c.json({ error: 'schema', issues: [{ message: 'decision must be agree | override_pass | override_fail' }] }, 400);
  }
  const row = await c.env.DB.prepare('SELECT * FROM runs WHERE run_id = ?').bind(runId).first<RunRow>();
  if (!row) return c.json({ error: 'not_found' }, 404);

  const reviewedAt = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO human_reviews (run_id, decision, note, reviewed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET decision = excluded.decision, note = excluded.note, reviewed_at = excluded.reviewed_at`,
    ).bind(runId, decision, body.note ?? null, reviewedAt),
    c.env.DB.prepare("UPDATE runs SET status = 'human_done' WHERE run_id = ?").bind(runId),
  ]);
  await recomputeDailyMetrics(c.env, row.agent, row.started_at.slice(0, 10));

  return c.json({ run_id: runId, status: 'human_done', decision, reviewed_at: reviewedAt });
});

async function runDetail(env: Env, row: RunRow) {
  const claims = await env.DB.prepare('SELECT * FROM claims WHERE run_id = ? ORDER BY turn_index, id').bind(row.run_id).all();
  const human = await env.DB.prepare('SELECT * FROM human_reviews WHERE run_id = ?').bind(row.run_id).first();
  return {
    run: {
      run_id: row.run_id,
      agent: row.agent,
      started_at: row.started_at,
      ended_at: row.ended_at,
      status: row.status,
      verdict: row.verdict,
      reviewed_at: row.reviewed_at,
      last_error: row.last_error,
      transcript: parseRun(row).transcript,
      events: parseRun(row).events,
    },
    claims: (claims.results ?? []).map((c: any) => ({
      ...c,
      normalized: JSON.parse(c.normalized),
      evidence: JSON.parse(c.evidence),
    })),
    human_review: human ?? null,
    judge: judgeBlock(),
  };
}

app.notFound((c) => c.json({ error: 'not_found' }, 404));
app.onError((err, c) => c.json({ error: 'server', detail: err.message }, 500));

export default {
  fetch: app.fetch,

  /** Every 10 minutes: take a lease on a sample of un-reviewed runs and work them. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const size = Math.max(1, Number(env.CRON_SAMPLE_SIZE ?? 25));
        const rows = await claimPendingRuns(env, size);
        const leased: RunRow[] = [];
        for (const row of rows) if (await takeLease(env, row.run_id)) leased.push(row);

        await pool(leased, 3, async (row) => {
          try {
            await reviewAndStore(env, row);
          } catch (err) {
            await releaseLease(env, row.run_id, 'pending');
          }
        });
      })(),
    );
  },
};
