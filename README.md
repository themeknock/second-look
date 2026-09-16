# Second Look

**An agent that reads what your AI agent told the user, and checks every claim against what
actually happened.** "You're booked for Tuesday at 3" only counts if there is a booking for
Tuesday at 3.

> Sessions 1-2 of 4. The pipeline and its eval are built and measured; the Worker and the
> dashboard come next. This README is replaced in session 4 with the full version.

Try it in 30 seconds:

```
git clone https://github.com/themeknock/second-look && cd second-look && npm i && npm test
# -> runs 200 synthetic agent runs through the pipeline and prints precision/recall per failure class
```

## What runs today

```
seed/generate.ts   deterministic synthetic runs (PRNG seed 20260916), failures injected into the
                   TRANSCRIPT and never the events, so the evidence stays true and the words drift
src/extract.ts     claim extraction - a rules version and an LLM version behind one interface
src/checks/*       one deterministic checker per claim kind, each verdict carrying the event index
                   or catalogue key it was checked against
src/triage.ts      UNVERIFIABLE claims get a risk rating, never a truth rating
src/review.ts      extract -> check -> triage -> run verdict
src/judge.ts       the rejected alternative, built honestly so it can be measured
test/eval.test.ts  the three-arm ablation, writes docs/eval-report.json
```

The measured comparison lives in [docs/eval-report.md](docs/eval-report.md), generated from
`docs/eval-report.json` by `npm run report`. Short version: asking one model "was this call
correct?" scores 39% precision on the same data the shipped pipeline scores 100% on, and misses
every second "I'm transferring you" that never happened - because a model checks what is in
front of it, and nobody is checking what is missing.

**The decision I'd defend:** the LLM is never asked whether the agent was right. It extracts
claims; code checks them against tool logs and a catalogue. Absence of a relevant tool call is
UNVERIFIABLE, never CONTRADICTED - absence of evidence is not evidence of lying.

## The data is synthetic and says so

200 generated runs of a fictional home-services agent for a fictional company, Northgate Home
Services. Fictional callers, +1555 numbers, a committed catalogue as ground truth. 140 clean runs
and 60 carrying exactly one injected failure, 15 each of `booking_phantom`, `price_wrong`,
`transfer_promised_not_done`, `kb_fact_wrong`. No real client transcript will ever be in this repo.

## Honest limits

- It only works on agents whose actions leave structured evidence. An agent that only chats gives
  it nothing to check against, and every claim comes back UNVERIFIABLE.
- Every number in this README comes from `docs/eval-report.json`, written by `npm test` on the
  date recorded inside it. Nothing here is typed by hand.
- The `rules_only` row is a ceiling, not a forecast: that extractor was written against the same
  templates that generated the transcripts. The LLM row is the honest one.
- The extractor is measured, not trusted. It missed one claim out of sixty labelled failures and
  that miss is in the report, because a claim nobody extracts is a claim nobody checks.
- The model used for the published numbers is named in the report. The Anthropic path in
  `src/llm.ts` is the spec's pinned default; these numbers were produced on a cheaper model.
