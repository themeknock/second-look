/**
 * README.md is generated from docs/eval-report.json so that no number in it is ever typed
 * by hand. Change the prose here; run `npm run readme` to rebuild.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const report = JSON.parse(readFileSync(join(root, 'docs', 'eval-report.json'), 'utf8'));
const pct = (n: number) => `${Math.round(n * 100)}%`;

const pipeline = report.rows['llm_extract+checks'] ?? report.rows['rules_only'];
const judge = report.rows['llm_judge_only'];
const cleanRuns = report.runs - report.labelled_failures;

const lines = `# Second Look

**An agent that reads what your AI agent told the user, and checks every claim against what
actually happened.** "You're booked for Tuesday at 3" only counts if there is a booking for
Tuesday at 3.

I built this because most of the code I ship is written by an agent, and in one week I found six
bugs I had already approved. None of them threw. They ran, they looked right, and the answer was
wrong. That class of failure does not show up in logs or in a "rate this conversation" score. It
shows up when you check the claim against the evidence.

![Second Look in 20 seconds](docs/demo.gif)

Try it in 30 seconds:

    git clone https://github.com/themeknock/second-look && cd second-look && npm i && npm test
    # -> runs ${report.runs} synthetic agent runs through the pipeline and prints precision/recall per failure class

Live dashboard (synthetic runs, labelled): **https://review.themeknock.net**

**The decision I'd defend:** the LLM is never asked whether the agent was right. It extracts
claims; code checks them against tool logs and a catalogue. On the same ${report.runs} runs, that
pipeline scores **${pct(pipeline.precision)} precision / ${pct(pipeline.recall)} recall**, while a
single LLM asked "was this call correct?" — handed the same transcript, the same event log and the
same catalogue — scores **${pct(judge.precision)} / ${pct(judge.recall)}**. It fails
${judge.confusion.fp} of ${cleanRuns} good calls, and every one of its ${judge.confusion.fn} misses
is the same class: the agent said "I'm putting you through" and no transfer ever happened. A model
checks what is in front of it. Nobody is checking what is missing.

**Honest limits:** it only works for agents whose actions leave structured evidence; the seed data
is synthetic and says so; the claim extractor's own precision and recall are published, not
assumed — it missed ${pipeline.confusion.fn} of ${report.labelled_failures} and that is in the
report too.

---

## How it works

![architecture](docs/architecture.svg)

Four steps, and the order is the whole design:

1. **Extract** — an LLM reads only the assistant's turns and answers one question: *what did the
   agent claim?* It never sees the tool results, so it cannot be tempted to rule on truth.
2. **Check** — deterministic code compares each claim against the event log and the catalogue.
   A booking is SUPPORTED only if a booking tool returned that exact slot, confirmed, before the
   agent said it.
3. **Triage** — claims that nothing could confirm or deny go back to the model for a *risk* rating,
   never a truth rating. High risk sends the run to a human.
4. **Verdict** — any CONTRADICTED claim fails the run. Absence of evidence is never a lie.

The rejected alternative was LLM-as-judge over the whole transcript. It is implemented in
\`src/judge.ts\` and measured in the table above rather than dismissed in a sentence.

## The ingest schema

Any agent that leaves structured evidence can export to this shape (\`src/schema.ts\`, zod):

\`\`\`json
{
  "run_id": "call_01J8...",
  "agent": "dispatch-voice",
  "started_at": "2026-09-22T14:58:01Z",
  "transcript": [{ "i": 3, "role": "assistant", "text": "Done, you're booked for Tuesday at 3pm.", "ts": "..." }],
  "events": [
    { "ts": "...", "type": "tool.called", "name": "book", "args": { "slot": "2026-09-22T15:00" } },
    { "ts": "...", "type": "tool.result", "name": "book", "result": { "slot": "2026-09-22T15:00", "status": "confirmed" } }
  ]
}
\`\`\`

A run without \`events[]\` is refused with *"nothing to check against"*. Ingest is idempotent on
\`run_id\`: the same body again is a no-op, a different body under the same id is a 409.

## The eval

[\`docs/eval-report.md\`](docs/eval-report.md) — three arms, per-class recall, cost per run, and a
section on where each arm goes wrong with the judge's own words quoted. Regenerate with
\`npm test && npm run report\`. Last run: **${report.run_at.slice(0, 10)}** on
\`${report.provider}/${report.model}\`.

| arm | precision | recall | $/run |
|---|---|---|---|
| rules extractor + checks | ${pct(report.rows['rules_only'].precision)} | ${pct(report.rows['rules_only'].recall)} | $0.00000 |
| **LLM extraction + checks** | **${pct(pipeline.precision)}** | **${pct(pipeline.recall)}** | $${pipeline.cost_usd_per_run.toFixed(5)} |
| LLM-judge-only | ${pct(judge.precision)} | ${pct(judge.recall)} | $${judge.cost_usd_per_run.toFixed(5)} |

## The data is synthetic and says so

${report.runs} generated runs of a fictional home-services agent for a fictional company, Northgate
Home Services. Fictional callers, +1555 numbers, a committed catalogue as ground truth.
${cleanRuns} clean runs and ${report.labelled_failures} carrying exactly one injected failure each,
15 apiece of \`booking_phantom\`, \`price_wrong\`, \`transfer_promised_not_done\`, \`kb_fact_wrong\`.
Failures are injected by editing the **transcript and never the events**, so the evidence stays
true and the agent's words drift away from it — which is the real failure shape. No real client
transcript will ever be in this repo.

## Running it

\`\`\`
npm i && npm test                      # the eval (Node 20+, an LLM key in .dev.vars)
npm run report                         # regenerate docs/eval-report.md from the JSON
npx wrangler dev --port 8787           # the Worker locally (wrangler needs Node 22+)
BASE=https://your-instance npx tsx scripts/ingest-seed.ts --review
\`\`\`

Stack: Cloudflare Workers, Hono, D1, zod, vitest. The published numbers were produced on
\`${report.model}\` through OpenRouter; the Anthropic path in \`src/llm.ts\` is selected with
\`LLM_PROVIDER=anthropic\`.

## Related

[playwright-sentinel](https://github.com/themeknock/playwright-sentinel) — the same idea one level
down: checking what a page actually rendered instead of what an agent actually did.
`;

writeFileSync(join(root, 'README.md'), lines);
console.log(`wrote README.md from docs/eval-report.json (eval run ${report.run_at})`);
