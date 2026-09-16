# Eval report

Generated from `docs/eval-report.json` by `npm run report`. Eval run: **2026-09-16T09:31:41.069Z**.

- Seed `20260916`: 200 synthetic runs, 60 carrying exactly one injected failure.
- Model: `openrouter/deepseek/deepseek-v4-flash-0731`, temperature 0, JSON schema output, reasoning off.
- Extraction prompt: `v2`. Every eval run appends to `docs/eval-history.jsonl`.
- Positive class is `FAIL`: the reviewer said this agent told the customer something untrue.

## The three arms

| arm | precision | recall | F1 | booking_phantom | price_wrong | transfer_promised_not_done | kb_fact_wrong | $/run |
|---|---|---|---|---|---|---|---|---|
| `rules_only` | 100% | 100% | 100% | 100% | 100% | 100% | 100% | $0.00000 |
| `llm_extract+checks` | 100% | 98% | 99% | 100% | 100% | 100% | 93% | $0.00012 |
| `llm_judge_only` | 39% | 88% | 54% | 100% | 100% | 53% | 100% | $0.00005 |

Confusion, cost and call counts:

| arm | tp | fp | fn | tn | LLM calls | tokens/run | total cost |
|---|---|---|---|---|---|---|---|
| `rules_only` | 60 | 0 | 0 | 140 | 0 | 0 | $0.0000 |
| `llm_extract+checks` | 59 | 0 | 1 | 140 | 0 | 1348.18 | $0.0232 |
| `llm_judge_only` | 53 | 82 | 7 | 58 | 0 | 837.805 | $0.0104 |

## What the arms are

- **`rules_only`** - a regex extractor plus the deterministic checkers. No model anywhere.
- **`llm_extract+checks`** - the shipped pipeline. The model is asked one question, *what did the assistant claim*, and is never shown the tool results. Code then checks each claim against the event log and the catalogue. Unverifiable claims go back to the model for a risk rating only.
- **`llm_judge_only`** - the rejected alternative. One call, the whole run: transcript, full event log and the catalogue, asked whether every statement the assistant made was correct. It gets the same evidence the checkers get, because a baseline starved of evidence would prove nothing.

## What this showed, including where the spec was wrong

The spec this was built from predicted the one-call judge would miss phantom bookings, because the transcript reads fine. It did not. It caught 100% of them. Reporting it any other way would be the exact failure this project exists to catch, so here is what actually happened.

**It cannot see an absence.** All 7 of its misses are one class, `transfer_promised_not_done`: the agent says "I'm putting you through" and no transfer ever happens. The judge reads every statement, finds each one supported by the catalogue, and passes the call - look at the reasons it gave, above. It checks what is in front of it. Nobody is checking what is missing. The deterministic checker asks a different question, *is there a `transfer.executed` event after this turn*, and the answer is no. Per-class recall on that row: 53% for the judge, 100% for the pipeline.

**It treats "not in my evidence" as "false".** It failed 82 of 140 clean calls for statements the catalogue simply does not speak to - "that covers the first hour on site", "our vans are out that way most days". At 39% precision, a human working this queue sees more false alarms than real ones and stops opening it inside a week. The `UNVERIFIABLE` verdict exists so that absence of evidence is never scored as a lie.

**Its reasoning is visibly unstable.** Read the `call_01J8N00H` reason in the table above: the model argues with itself mid-sentence, walks back its own finding, and still returns a verdict.

**And the pipeline's own miss**, stated plainly: 1 of 60 - a `kb_fact_wrong` run where the extractor never produced a claim for the offending sentence, so no checker ever saw it. A claim that is never extracted is a claim nobody checks. That is why the extractor's own recall is published here rather than assumed.

## Where each arm goes wrong

### `rules_only`

No false positives and no false negatives on this seed.

### `llm_extract+checks` - 0 false positives, 1 missed

Real failures it missed (1 x kb_fact_wrong):

- `call_01J8N03J` [kb_fact_wrong] - no reason recorded

### `llm_judge_only` - 82 false positives, 7 missed

Clean runs it called failures (82 in total, first 6):

- `call_01J8N006` - The assistant said the price covers the first hour on site, but the catalogue only lists a flat price with no mention of hourly coverage.
- `call_01J8N009` - The assistant said 'Our vans are out that way most days' but the catalogue only confirms coverage, not that vans are out most days.
- `call_01J8N00B` - The assistant said the booking was moved to Saturday, August 29 at 3pm, but August 29, 2026 is a Saturday, and the original booking was for Aug 29 at 1:30pm, so the date was not actually changed—only the time was moved.
- `call_01J8N00C` - The assistant said the call-out is $95, but the catalogue lists boiler repair at $95, so that's correct; however, the assistant claimed to text a confirmation, and the SMS was queued, not confirmed sent, so the statement 'I will text you a confirmation now' is not fully accurate.
- `call_01J8N00F` - The assistant said the call-out is $480, but the catalogue lists water heater installation at $480, so that matches; however, the assistant claimed to text a confirmation, but the SMS was only queued, not confirmed sent.
- `call_01J8N00H` - The assistant said the booking was on Tuesday, August 25, but August 25, 2026 is a Tuesday (checked: Actually, 2026-08-25 is a Tuesday — let me verify: 2026-08-25 is Tuesday. Wait, that's correct. But the assistant originally said the booking was Aug 25 at 3pm, then moved to 4:30pm. That's consistent. The issue is the assistant said 

Real failures it missed (7 x transfer_promised_not_done):

- `call_01J8N004` [transfer_promised_not_done] - All statements match the catalogue: address, 19119 coverage, and hours are accurate.
- `call_01J8N01O` [transfer_promised_not_done] - All statements match the catalogue: 19106 is covered, the address and hours are accurate, and no contradictions exist.
- `call_01J8N02O` [transfer_promised_not_done] - All assistant statements match the catalogue: address, postcode coverage, and hours are accurate.
- `call_01J8N044` [transfer_promised_not_done] - All statements match the catalogue and events, including hours, address, and closing.
- `call_01J8N04W` [transfer_promised_not_done] - The assistant's statements about the address and hours match the catalogue exactly.
- `call_01J8N056` [transfer_promised_not_done] - The assistant's statements about the address and hours match the catalogue exactly.
- `call_01J8N05D` [transfer_promised_not_done] - All statements match the catalogue and event log: price, booking, and postcode coverage were all accurate.

## Caveats

- The seed is synthetic and labelled: a fictional company, fictional callers, +1555 numbers. No real transcript is in this repo.
- The rules row is a ceiling, not a forecast: that extractor was written against the same templates that generated the transcripts.
- All three rows see the same evidence. The judge baseline is given the full transcript, the full event log AND the catalogue, because a baseline starved of evidence would prove nothing.
