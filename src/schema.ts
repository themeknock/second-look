import { z } from 'zod';

/**
 * The ingest contract. Other agents export to this shape; everything downstream
 * (checkers, review, dashboard) reads only what is defined here.
 */

export const KNOWN_EVENT_TYPES = [
  'tool.called',
  'tool.result',
  'transfer.promised',
  'transfer.forced',
  'transfer.executed',
  'barge_in',
  'call.started',
  'call.ended',
  'stt.final',
  'tts.started',
  'llm.turn',
  'custom',
] as const;

export type KnownEventType = (typeof KNOWN_EVENT_TYPES)[number];

/** Unknown event types are stored as-is and ignored by the checkers. */
export const EventTypeSchema = z.string().min(1);

export const TurnSchema = z.object({
  i: z.number().int().nonnegative(),
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string(),
  ts: z.string().min(1),
});

export const EventSchema = z
  .object({
    ts: z.string().min(1),
    type: EventTypeSchema,
    name: z.string().optional(),
    args: z.unknown().optional(),
    result: z.unknown().optional(),
  })
  .passthrough();

export const AgentRunSchema = z.object({
  run_id: z.string().min(1),
  agent: z.string().min(1),
  started_at: z.string().min(1),
  ended_at: z.string().min(1).optional(),
  transcript: z.array(TurnSchema).min(1),
  // "nothing to check against" is a 400, not a pass: a run without events is refused.
  events: z.array(EventSchema).min(1),
  ground_truth: z
    .object({ catalogue_version: z.string().min(1) })
    .passthrough()
    .optional(),
});

export const ClaimKindSchema = z.enum([
  'booking',
  'price',
  'transfer',
  'kb_fact',
  'promise',
  'other',
]);

export const VerdictSchema = z.enum(['SUPPORTED', 'CONTRADICTED', 'UNVERIFIABLE']);
export const RunVerdictSchema = z.enum(['PASS', 'FAIL', 'NEEDS_HUMAN']);
export const RiskSchema = z.enum(['low', 'med', 'high']);

/** What the agent said. Produced by the extractor; it carries no opinion on correctness. */
export const ClaimSchema = z.object({
  turn_index: z.number().int().nonnegative(),
  kind: ClaimKindSchema,
  text: z.string().min(1),
  normalized: z.record(z.unknown()),
});

/**
 * Why a verdict was reached. A SUPPORTED or CONTRADICTED verdict must name the
 * event index or the catalogue key it was checked against - never just a vibe.
 */
export const EvidenceSchema = z.object({
  checked: z.string().min(1),
  event_index: z.number().int().nonnegative().nullable(),
  catalogue_key: z.string().nullable(),
  reason: z.string().nullable(),
});

export const CheckedClaimSchema = ClaimSchema.extend({
  verdict: VerdictSchema,
  evidence: EvidenceSchema,
  checker: z.string().min(1),
  risk: RiskSchema.nullable().default(null),
});

export type Turn = z.infer<typeof TurnSchema>;
export type AgentEvent = z.infer<typeof EventSchema>;
export type AgentRun = z.infer<typeof AgentRunSchema>;
export type ClaimKind = z.infer<typeof ClaimKindSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
export type RunVerdict = z.infer<typeof RunVerdictSchema>;
export type Risk = z.infer<typeof RiskSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type CheckedClaim = z.infer<typeof CheckedClaimSchema>;

export interface CatalogueService {
  key: string;
  label: string;
  aliases: string[];
  price: number;
}

export interface Catalogue {
  version: string;
  company: string;
  services: CatalogueService[];
  hours: { open: string; close: string; days: string; text: string; sunday: string };
  service_area_postcodes: string[];
  address: string;
  phone: string;
}

/** Every extractor (rules now, Claude next) implements this. */
export interface Extractor {
  name: string;
  extract(run: AgentRun): Promise<Claim[]>;
}
