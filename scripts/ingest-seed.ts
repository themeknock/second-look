/**
 * Posts seed/runs.jsonl to a running instance and asks it to review each one.
 *
 * Usage: BASE=https://review.themeknock.net npx tsx scripts/ingest-seed.ts [--review]
 * The key is read from .dev.vars and never printed.
 */
import { loadDevVars } from '../src/dev-vars';
import { pool } from '../src/pool';
import { loadSeedRuns } from '../seed/load';

loadDevVars();

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const KEY = process.env.INGEST_KEY ?? '';
const REVIEW = process.argv.includes('--review');

async function main() {
  if (!KEY) throw new Error('INGEST_KEY is not set (put it in .dev.vars)');
  const runs = loadSeedRuns();
  const counts: Record<string, number> = {};

  const ingested = await pool(runs, 6, async (run) => {
    const res = await fetch(`${BASE}/ingest?seed=1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(run),
    });
    const body = (await res.json()) as { status?: string; error?: string };
    const key = `${res.status} ${body.status ?? body.error ?? ''}`.trim();
    counts[key] = (counts[key] ?? 0) + 1;
    return { run_id: run.run_id, ok: res.status === 201 || res.status === 200 };
  });

  console.log(`ingested ${ingested.length} runs into ${BASE}`);
  console.log(counts);

  if (!REVIEW) {
    console.log('skipped review (pass --review to run the pipeline on every run now; the cron does 25 per 10 min otherwise)');
    return;
  }

  let done = 0;
  const verdicts: Record<string, number> = {};
  await pool(runs, 4, async (run) => {
    const res = await fetch(`${BASE}/review/${run.run_id}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}` },
    });
    const body = (await res.json()) as { verdict?: string; error?: string };
    const key = body.verdict ?? `${res.status} ${body.error ?? 'error'}`;
    verdicts[key] = (verdicts[key] ?? 0) + 1;
    done++;
    if (done % 25 === 0) console.log(`  reviewed ${done}/${runs.length}`);
  });
  console.log('verdicts:', verdicts);
}

main();
