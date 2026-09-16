import type { AgentRun, Claim, ClaimKind, Extractor } from './schema';
import { serviceFromText } from './catalogue';
import { parseClock, parseDateTime, yearOf } from './time';

/**
 * Session 1 extractor: rules only, so the deterministic layer can be measured on
 * its own before an LLM is anywhere near it. Session 2 replaces this with Claude
 * behind the same `Extractor` interface.
 *
 * The extractor answers exactly one question: WHAT DID THE AGENT CLAIM?
 * It never decides whether the claim was right.
 */

export const MAX_CLAIMS_PER_RUN = 20;

/**
 * Bumped whenever the extraction prompt changes, so an eval report says which prompt
 * produced its numbers. v1 -> v2: the model was reading availability offers ("I can get
 * someone to you on Thursday at 3:30") as completed bookings, 28 times across 140 clean
 * runs. docs/eval-report.prompt-v1.json is that run, kept as the before picture.
 */
export const EXTRACT_PROMPT_VERSION = 'v2';

const BOOKING_RE =
  /\b(?:(?:you'?re|you are|that'?s|it'?s) (?:booked|all set|confirmed|cancell?ed)|(?:i'?ve|i have|we'?ve|we have) (?:booked|moved|rescheduled|shifted|cancell?ed)|booked you in|your appointment is (?:now )?(?:set|confirmed|cancell?ed))\b/i;
const CANCEL_RE = /\bcancel(?:l)?ed\b/i;
const RESCHEDULE_RE = /\b(moved|rescheduled|shifted)\b/i;

const TRANSFER_RE =
  /\b(transferring you|i'?ll transfer you|i'?m transferring|putting you through|put you through|connecting you (?:to|with)|i'?ll connect you|get(?:ting)? you (?:over )?to (?:the office|a colleague|dispatch|someone))\b/i;

const PROMISE_RE =
  /\b(?:(?:i|we)(?:'ll| will|'m| am|'ve| have)?\s+(?:text|send|email|texting|sending|emailing|texted|sent|emailed))\b/i;

const PRICE_RE = /\$\s?(\d+(?:\.\d{1,2})?)/;

const HOURS_RE =
  /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\s*(?:to|-|–|until|till|through)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i;
const DAYS_RE = /\b(monday|mon)\s*(?:to|-|–|through|thru)\s*(saturday|sat|friday|fri|sunday|sun)\b/i;
const POSTCODE_RE = /\b(\d{5})\b/;
const AREA_RE = /\b(cover|covers|service|serve|servicing|come out to|work in|operate in)\b/i;
const ADDRESS_RE = /\b(\d{2,5}\s+[A-Z][A-Za-z]+\s+(?:Way|Street|St|Road|Rd|Avenue|Ave|Lane|Drive)(?:,\s*(?:Suite|Unit|Ste)\s*\d+)?)/;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function push(out: Claim[], kind: ClaimKind, turn_index: number, text: string, normalized: Record<string, unknown>): void {
  if (out.length >= MAX_CLAIMS_PER_RUN) return;
  out.push({ kind, turn_index, text, normalized });
}

export function extractClaimsWithRules(run: AgentRun): Claim[] {
  const year = yearOf(run.started_at);
  const claims: Claim[] = [];

  for (const turn of run.transcript) {
    if (turn.role !== 'assistant') continue;
    const turnService = serviceFromText(turn.text);

    for (const sentence of sentences(turn.text)) {
      // booking
      if (BOOKING_RE.test(sentence)) {
        const slot = parseDateTime(sentence, year);
        const action = CANCEL_RE.test(sentence) ? 'cancel' : RESCHEDULE_RE.test(sentence) ? 'reschedule' : 'book';
        const service = serviceFromText(sentence) ?? turnService;
        push(claims, 'booking', turn.i, sentence, {
          action,
          slot,
          service: service ? service.key : null,
        });
      }

      // price
      const priceMatch = PRICE_RE.exec(sentence);
      if (priceMatch) {
        const service = serviceFromText(sentence) ?? turnService;
        push(claims, 'price', turn.i, sentence, {
          amount: Number(priceMatch[1]),
          service: service ? service.key : null,
        });
      }

      // transfer
      if (TRANSFER_RE.test(sentence)) {
        push(claims, 'transfer', turn.i, sentence, { to: /office/i.test(sentence) ? 'office' : 'human' });
      }

      // promise (an action the agent committed to taking)
      if (PROMISE_RE.test(sentence)) {
        const channel = /email/i.test(sentence) ? 'email' : /text|sms/i.test(sentence) ? 'sms' : 'message';
        push(claims, 'promise', turn.i, sentence, { channel, what: /confirm/i.test(sentence) ? 'confirmation' : 'message' });
      }

      // kb facts: hours / service area / address
      const hours = HOURS_RE.exec(sentence);
      if (hours) {
        const days = DAYS_RE.exec(sentence);
        push(claims, 'kb_fact', turn.i, sentence, {
          fact: 'hours',
          open: parseClock(hours[1], hours[2], hours[3]),
          close: parseClock(hours[4], hours[5], hours[6]),
          days: days ? `${days[1]} to ${days[2]}` : null,
        });
      }
      const postcode = POSTCODE_RE.exec(sentence);
      if (postcode && AREA_RE.test(sentence)) {
        push(claims, 'kb_fact', turn.i, sentence, { fact: 'service_area', postcode: postcode[1] });
      }
      const address = ADDRESS_RE.exec(sentence);
      if (address) {
        push(claims, 'kb_fact', turn.i, sentence, { fact: 'address', value: address[1] });
      }
    }
  }

  return claims.slice(0, MAX_CLAIMS_PER_RUN);
}

export const rulesExtractor: Extractor = {
  name: 'rules',
  async extract(run: AgentRun): Promise<Claim[]> {
    return extractClaimsWithRules(run);
  },
};

/* ---------------------------------------------------------------------------
 * LLM extractor (session 2). Same interface, same output shape.
 * The model is asked exactly one question: WHAT DID THE ASSISTANT CLAIM?
 * It is never shown the tool results, so it cannot be tempted to rule on truth.
 * ------------------------------------------------------------------------- */

import { catalogue } from './catalogue';
import { addUsage, ZERO_USAGE, type LlmClient, type LlmUsage } from './llm';

const NORMALIZED_FIELDS = ['action', 'slot', 'service', 'amount', 'fact', 'open', 'close', 'postcode', 'value', 'channel', 'to'] as const;

const CLAIMS_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          turn_index: { type: 'integer' },
          kind: { type: 'string', enum: ['booking', 'price', 'transfer', 'kb_fact', 'promise', 'other'] },
          text: { type: 'string' },
          normalized: {
            type: 'object',
            properties: {
              action: { type: ['string', 'null'] },
              slot: { type: ['string', 'null'] },
              service: { type: ['string', 'null'] },
              amount: { type: ['number', 'null'] },
              fact: { type: ['string', 'null'] },
              open: { type: ['string', 'null'] },
              close: { type: ['string', 'null'] },
              postcode: { type: ['string', 'null'] },
              value: { type: ['string', 'null'] },
              channel: { type: ['string', 'null'] },
              to: { type: ['string', 'null'] },
            },
            required: [...NORMALIZED_FIELDS],
            additionalProperties: false,
          },
        },
        required: ['turn_index', 'kind', 'text', 'normalized'],
        additionalProperties: false,
      },
    },
  },
  required: ['claims'],
  additionalProperties: false,
} as const;

const EXTRACT_SYSTEM = `You read one side of a phone conversation: what an AI assistant said to a customer of Northgate Home Services.

Your only job is to list the factual claims the assistant made. You are NOT shown what actually happened and you must not guess whether a claim is true. Another system checks that against evidence.

A claim is a statement of fact or a commitment the assistant made to the customer.
NOT claims: questions, offers and suggestions ("I can do Tuesday at 3, shall I book it?", "I have a slot at 4"), greetings, small talk, statements about what the customer said.

Kinds and how to fill "normalized" (every unused field must be null):
- booking  - the assistant states an appointment IS booked, moved or cancelled.
             action: "book" | "reschedule" | "cancel"
             slot: the stated date and time as "YYYY-MM-DDTHH:MM" (24h), resolved against the call date
             service: a service key from the list, if one is named
- price    - the assistant states a dollar amount. amount: the number. service: the service key if named.
- transfer - the assistant states it is transferring or putting the caller through. to: who.
             "I'm putting you through", "let me put you through", "I'll transfer you now" are all
             transfer claims: the assistant is telling the customer this is happening.
- kb_fact  - the assistant states a fact about the business:
             opening hours  -> fact: "hours", open and close as "HH:MM" 24h
             a covered area -> fact: "service_area", postcode: the 5-digit code
             the address    -> fact: "address", value: the address as stated
- promise  - the assistant commits to sending something. channel: "sms" | "email". value: what.
- other    - any other factual statement.

Worked example. Assistant turn:
  "I can get someone to you on Thursday, August 20 at 3:30pm, or Aug 20 at 5pm if that is easier. The boiler repair call-out is $95."
That turn contains exactly ONE claim: the price. "I can get someone to you on ..." is an offer of availability. Nothing has been booked. Do not emit a booking claim for it.

A booking claim requires the assistant to say the appointment IS done: "you are booked", "I have moved you to", "I have cancelled". Anything phrased as availability, a suggestion, or a question is not a booking claim.

Rules: quote the assistant's own sentence in "text". turn_index is the [i=N] number of the turn it came from. One claim per statement. At most 20 claims.`;

function assistantTurnsBlock(run: AgentRun): string {
  return run.transcript
    .filter((t) => t.role === 'assistant')
    .map((t) => `[i=${t.i}] ${t.text}`)
    .join('\n');
}

function stripNulls(normalized: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(normalized ?? {})) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

export interface LlmExtractor extends Extractor {
  usage: LlmUsage;
  extractWithUsage(run: AgentRun): Promise<{ claims: Claim[]; usage: LlmUsage }>;
}

export function createLlmExtractor(client: LlmClient): LlmExtractor {
  const serviceList = catalogue.services.map((s) => `${s.key} (${s.label})`).join(', ');
  const self: LlmExtractor = {
    name: `llm:${client.model}`,
    usage: { ...ZERO_USAGE },
    async extractWithUsage(run: AgentRun) {
      const user = [
        `Call date: ${run.started_at} (use this to resolve weekdays and times; the year is ${yearOf(run.started_at)}).`,
        `Service keys: ${serviceList}.`,
        '',
        'Assistant turns:',
        assistantTurnsBlock(run),
      ].join('\n');

      const { data, usage } = await client.json<{ claims: Array<Claim & { normalized: Record<string, unknown> }> }>({
        system: EXTRACT_SYSTEM,
        user,
        schema: CLAIMS_SCHEMA as unknown as Record<string, unknown>,
        schema_name: 'claims',
        max_tokens: 2000,
      });

      const claims = (data.claims ?? [])
        .slice(0, MAX_CLAIMS_PER_RUN)
        .map((c) => ({
          turn_index: Number(c.turn_index) || 0,
          kind: c.kind,
          text: String(c.text ?? ''),
          normalized: stripNulls(c.normalized),
        }))
        .filter((c) => c.text.length > 0);

      self.usage = addUsage(self.usage, usage);
      return { claims, usage };
    },
    async extract(run: AgentRun) {
      return (await self.extractWithUsage(run)).claims;
    },
  };
  return self;
}
