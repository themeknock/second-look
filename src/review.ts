/**
 * The pipeline, B6, in order:
 *   1. extract claims   (LLM - what did the agent SAY)
 *   2. check claims     (code - what does the EVIDENCE say)
 *   3. triage unknowns  (LLM - how much does not knowing cost)
 *   4. run verdict
 *
 * Step 1 never sees the evidence and step 2 never sees the model. That separation is
 * the whole design: the LLM is not allowed to have an opinion about correctness.
 */
import { runChecks, runVerdict } from './checks';
import { addUsage, ZERO_USAGE, type LlmUsage } from './llm';
import type { AgentRun, CheckedClaim, Claim, Extractor, RunVerdict } from './schema';
import { noTriage, type Triager } from './triage';

export interface ReviewResult {
  run_id: string;
  verdict: RunVerdict;
  claims: CheckedClaim[];
  usage: LlmUsage;
  truncated: boolean;
}

export const MAX_TURNS = 200;

export async function reviewRun(
  run: AgentRun,
  options: { extractor: Extractor; triager?: Triager },
): Promise<ReviewResult> {
  const triager = options.triager ?? noTriage;
  const truncated = run.transcript.length > MAX_TURNS;
  const scoped: AgentRun = truncated ? { ...run, transcript: run.transcript.slice(-MAX_TURNS) } : run;

  let usage = { ...ZERO_USAGE };

  const withUsage = options.extractor as Extractor & {
    extractWithUsage?: (run: AgentRun) => Promise<{ claims: Claim[]; usage: LlmUsage }>;
  };
  let extracted: Claim[];
  if (typeof withUsage.extractWithUsage === 'function') {
    const result = await withUsage.extractWithUsage(scoped);
    extracted = result.claims;
    usage = addUsage(usage, result.usage);
  } else {
    extracted = await options.extractor.extract(scoped);
  }

  const checked = runChecks(scoped, extracted);
  const triaged = await triager.triage(scoped, checked);
  usage = addUsage(usage, triaged.usage);

  return {
    run_id: run.run_id,
    verdict: runVerdict(triaged.claims),
    claims: triaged.claims,
    usage,
    truncated,
  };
}
