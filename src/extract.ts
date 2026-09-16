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
