/**
 * The rejected alternative, implemented honestly so it can be measured: one LLM call
 * over the whole run - transcript, events and catalogue - asked to say whether the
 * assistant was correct. This is the baseline the architecture claims to beat. It gets
 * the same evidence the deterministic checkers get; anything less would be a straw man.
 */
import { catalogue } from './catalogue';
import { addUsage, ZERO_USAGE, type LlmClient, type LlmUsage } from './llm';
import type { AgentRun, RunVerdict } from './schema';

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    every_statement_correct: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['every_statement_correct', 'reason'],
  additionalProperties: false,
} as const;

const JUDGE_SYSTEM = `You are reviewing one call handled by an AI assistant for Northgate Home Services.

You are given the full transcript, the full event log of every tool the assistant called and what each returned, and the company's catalogue.

Question: was every statement the assistant made to the customer correct, given the events and the catalogue?

Answer true only if all of it holds up. Answer false if anything the assistant told the customer is contradicted by the evidence. Give one short sentence of reason.`;

export interface JudgeResult {
  verdict: RunVerdict;
  reason: string;
  usage: LlmUsage;
}

export function createLlmJudge(client: LlmClient) {
  const catalogueBlock = JSON.stringify(
    {
      services: catalogue.services.map((s) => ({ key: s.key, label: s.label, price: s.price })),
      hours: catalogue.hours,
      service_area_postcodes: catalogue.service_area_postcodes,
      address: catalogue.address,
    },
    null,
    0,
  );

  return {
    async judge(run: AgentRun): Promise<JudgeResult> {
      const user = [
        `Catalogue: ${catalogueBlock}`,
        '',
        'Transcript:',
        ...run.transcript.map((t) => `[${t.i}] ${t.role}: ${t.text}`),
        '',
        'Events:',
        ...run.events.map((e, i) => `[${i}] ${e.ts} ${e.type} ${e.name ?? ''} ${JSON.stringify(e.result ?? e.args ?? {})}`),
      ].join('\n');

      const { data, usage } = await client.json<{ every_statement_correct: boolean; reason: string }>({
        system: JUDGE_SYSTEM,
        user,
        schema: JUDGE_SCHEMA as unknown as Record<string, unknown>,
        schema_name: 'judgement',
        max_tokens: 1500,
      });

      return {
        verdict: data.every_statement_correct ? 'PASS' : 'FAIL',
        reason: data.reason,
        usage: addUsage({ ...ZERO_USAGE }, usage),
      };
    },
  };
}
