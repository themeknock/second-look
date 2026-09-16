import type { AgentEvent, AgentRun, CheckedClaim, Claim, Evidence } from '../schema';
import { isBefore } from '../time';

export interface IndexedEvent {
  event: AgentEvent;
  index: number;
}

export function indexedEvents(run: AgentRun): IndexedEvent[] {
  return run.events.map((event, index) => ({ event, index }));
}

export function turnTs(run: AgentRun, turnIndex: number): string {
  const byField = run.transcript.find((t) => t.i === turnIndex);
  if (byField) return byField.ts;
  return run.transcript[turnIndex]?.ts ?? run.started_at;
}

/**
 * The extractor quotes the assistant's sentence verbatim but sometimes reports the wrong
 * turn number. The quote is evidence; the number is bookkeeping. Anchor on the quote.
 */
export function anchorTurn(run: AgentRun, claim: Claim): { index: number; ts: string } {
  const needle = claim.text.trim().toLowerCase();
  if (needle.length > 8) {
    const matches = run.transcript.filter((t) => t.role === 'assistant' && t.text.toLowerCase().includes(needle));
    if (matches.length === 1) return { index: matches[0].i, ts: matches[0].ts };
    if (matches.length > 1) {
      const best = matches.reduce((a, b) =>
        Math.abs(a.i - claim.turn_index) <= Math.abs(b.i - claim.turn_index) ? a : b,
      );
      return { index: best.i, ts: best.ts };
    }
  }
  return { index: claim.turn_index, ts: turnTs(run, claim.turn_index) };
}

export function eventsBefore(run: AgentRun, ts: string): IndexedEvent[] {
  return indexedEvents(run).filter(({ event }) => isBefore(event.ts, ts));
}

export function eventsAfter(run: AgentRun, ts: string): IndexedEvent[] {
  return indexedEvents(run).filter(({ event }) => !isBefore(event.ts, ts));
}

/** A run that ended is a run whose silence means something. */
export function runIsComplete(run: AgentRun): boolean {
  return run.events.some((e) => e.type === 'call.ended') || Boolean(run.ended_at);
}

export function resultObject(event: AgentEvent): Record<string, unknown> {
  return (event.result ?? {}) as Record<string, unknown>;
}

export function argsObject(event: AgentEvent): Record<string, unknown> {
  return (event.args ?? {}) as Record<string, unknown>;
}

export function nameMatches(event: AgentEvent, names: string[]): boolean {
  const n = (event.name ?? '').toLowerCase();
  return names.some((candidate) => n === candidate || n.startsWith(`${candidate}_`) || n.endsWith(`_${candidate}`));
}

function evidence(partial: Partial<Evidence> & { checked: string }): Evidence {
  return {
    checked: partial.checked,
    event_index: partial.event_index ?? null,
    catalogue_key: partial.catalogue_key ?? null,
    reason: partial.reason ?? null,
  };
}

export function supported(claim: Claim, checker: string, ev: Partial<Evidence> & { checked: string }): CheckedClaim {
  return { ...claim, verdict: 'SUPPORTED', checker, evidence: evidence(ev), risk: null };
}

export function contradicted(claim: Claim, checker: string, ev: Partial<Evidence> & { checked: string }): CheckedClaim {
  return { ...claim, verdict: 'CONTRADICTED', checker, evidence: evidence(ev), risk: null };
}

/**
 * Absence of evidence is not evidence of lying. When the run never used the tool
 * the claim is about, the honest verdict is UNVERIFIABLE.
 */
export function unverifiable(claim: Claim, checker: string, reason: string): CheckedClaim {
  return {
    ...claim,
    verdict: 'UNVERIFIABLE',
    checker,
    evidence: evidence({ checked: 'nothing in this run could confirm or deny it', reason }),
    risk: null,
  };
}
