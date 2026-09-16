import type { AgentRun, CheckedClaim, Claim } from '../schema';
import { isBefore } from '../time';
import {
  anchorTurn,
  argsObject,
  contradicted,
  indexedEvents,
  nameMatches,
  resultObject,
  supported,
  unverifiable,
  type IndexedEvent,
} from './util';

export const BOOKING_TOOLS = ['book', 'reschedule', 'cancel'];

const STATUS_FOR_ACTION: Record<string, string[]> = {
  book: ['confirmed'],
  reschedule: ['confirmed', 'rescheduled'],
  cancel: ['cancelled', 'canceled'],
};

/**
 * "You're booked for Tuesday at 3" is SUPPORTED only if a booking tool returned that exact
 * slot, confirmed, before the agent said it. Exact match: a booking an hour and a half off
 * is the whole failure class this exists to catch.
 *
 * Three things are deliberately NOT contradictions:
 *  - the run never used a booking tool          -> nothing to check against
 *  - every booking call happens after the claim -> the claim is about a booking made before
 *    this call ("I have you down for Tuesday"), and this run's log cannot speak to it
 *  - the claim named no date and time           -> nothing to compare
 */
export function checkBooking(run: AgentRun, claim: Claim): CheckedClaim {
  const checker = 'booking';
  const bookingEvents = indexedEvents(run).filter(
    ({ event }) =>
      (event.type === 'tool.called' || event.type === 'tool.result') && nameMatches(event, BOOKING_TOOLS),
  );
  if (bookingEvents.length === 0) {
    return unverifiable(claim, checker, 'no book/reschedule/cancel tool was called in this run');
  }

  const slot = typeof claim.normalized.slot === 'string' ? claim.normalized.slot : null;
  if (!slot) {
    return unverifiable(claim, checker, 'the claim did not state a date and time to check');
  }

  const action = typeof claim.normalized.action === 'string' ? claim.normalized.action : 'book';
  const wanted = STATUS_FOR_ACTION[action] ?? ['confirmed'];
  const anchor = anchorTurn(run, claim);

  const matches = (e: IndexedEvent) => {
    const r = resultObject(e.event);
    return (
      e.event.type === 'tool.result' &&
      nameMatches(e.event, BOOKING_TOOLS) &&
      String(r.slot ?? '') === slot &&
      wanted.includes(String(r.status ?? '').toLowerCase())
    );
  };

  const confirmedBefore = bookingEvents.find((e) => matches(e) && isBefore(e.event.ts, anchor.ts));
  if (confirmedBefore) {
    const r = resultObject(confirmedBefore.event);
    return supported(claim, checker, {
      checked: `tool.result ${confirmedBefore.event.name} -> slot ${r.slot} status ${r.status}`,
      event_index: confirmedBefore.index,
    });
  }

  const confirmedAfter = bookingEvents.find(matches);
  if (confirmedAfter) {
    return contradicted(claim, checker, {
      checked: `tool.result ${confirmedAfter.event.name} -> slot ${slot}, but at ${confirmedAfter.event.ts}`,
      event_index: confirmedAfter.index,
      reason: `the agent told the customer this was done at turn ${anchor.index}, before the booking tool confirmed it`,
    });
  }

  if (!bookingEvents.some(({ event }) => isBefore(event.ts, anchor.ts))) {
    return unverifiable(
      claim,
      checker,
      'every booking tool call in this run happens after the claim, so this run holds no evidence either way',
    );
  }

  const nearest = [...bookingEvents]
    .reverse()
    .find(({ event }) => event.type === 'tool.result' && wanted.includes(String(resultObject(event).status ?? '').toLowerCase()));

  if (nearest) {
    const r = resultObject(nearest.event);
    return contradicted(claim, checker, {
      checked: `no ${action} tool.result with slot ${slot} before turn ${anchor.index}`,
      event_index: nearest.index,
      reason: `nearest confirmed slot was ${r.slot}`,
    });
  }

  const attempted = bookingEvents.find(({ event }) => event.type === 'tool.called');
  return contradicted(claim, checker, {
    checked: `no ${action} tool.result with slot ${slot} before turn ${anchor.index}`,
    event_index: attempted ? attempted.index : null,
    reason: attempted
      ? `${attempted.event.name} was called with ${JSON.stringify(argsObject(attempted.event).slot ?? null)} and returned no matching confirmation`
      : 'no confirmed booking result exists in this run',
  });
}
