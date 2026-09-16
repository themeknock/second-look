/**
 * Triage, step 3 of the pipeline. Only UNVERIFIABLE claims reach the model, and it is
 * still not asked whether the claim is true - only how much it would cost to be wrong,
 * so a human knows which unknowns are worth their time.
 */
import type { AgentRun, CheckedClaim, Risk } from './schema';
import { addUsage, ZERO_USAGE, type LlmClient, type LlmUsage } from './llm';

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    risk: { type: 'string', enum: ['low', 'med', 'high'] },
    reason: { type: 'string' },
  },
  required: ['risk', 'reason'],
  additionalProperties: false,
} as const;

const TRIAGE_SYSTEM = `An AI assistant said something to a customer that could not be checked against any evidence in the call: no tool call or catalogue entry covers it.

You are NOT deciding whether it was true. You are deciding how much it matters that nobody knows.

high - if this was wrong the customer is left with a false expectation that costs money or a missed visit (a booking, a price, a commitment to send something, a promise someone will call).
med  - a factual statement about the business a customer might act on, but the cost of being wrong is small.
low  - pleasantries, restatements of what the customer said, vague or hedged statements.

One short sentence for "reason", in plain language a dispatcher would use.`;

export interface TriageResult {
  risk: Risk;
  reason: string;
}

export interface Triager {
  triage(run: AgentRun, claims: CheckedClaim[]): Promise<{ claims: CheckedClaim[]; usage: LlmUsage }>;
}

/** Session 1 behaviour: no model, no risk assigned, nothing escalated. */
export const noTriage: Triager = {
  async triage(_run: AgentRun, claims: CheckedClaim[]) {
    return { claims, usage: { ...ZERO_USAGE } };
  },
};

export function createLlmTriager(client: LlmClient): Triager {
  return {
    async triage(run: AgentRun, claims: CheckedClaim[]) {
      let usage = { ...ZERO_USAGE };
      const out: CheckedClaim[] = [];
      for (const claim of claims) {
        if (claim.verdict !== 'UNVERIFIABLE') {
          out.push(claim);
          continue;
        }
        const toolNames = [...new Set(run.events.filter((e) => e.type === 'tool.called').map((e) => e.name ?? '?'))];
        const user = [
          `What the assistant said: "${claim.text}"`,
          `Kind: ${claim.kind}`,
          `Why it could not be checked: ${claim.evidence.reason ?? 'no evidence covers it'}`,
          `Tools this call actually used: ${toolNames.length ? toolNames.join(', ') : 'none'}`,
        ].join('\n');

        const { data, usage: u } = await client.json<TriageResult>({
          system: TRIAGE_SYSTEM,
          user,
          schema: TRIAGE_SCHEMA as unknown as Record<string, unknown>,
          schema_name: 'triage',
          max_tokens: 1200,
        });
        usage = addUsage(usage, u);
        out.push({
          ...claim,
          risk: data.risk,
          checker: 'llm_triage',
          evidence: { ...claim.evidence, reason: `${claim.evidence.reason ?? ''} (triage: ${data.reason})`.trim() },
        });
      }
      return { claims: out, usage };
    },
  };
}
