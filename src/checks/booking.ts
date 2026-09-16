import type { AgentRun, CheckedClaim, Claim } from '../schema';
import {
  argsObject,
  contradicted,
  eventsBefore,
  indexedEvents,
  nameMatches,
  resultObject,
  supported,
  turnTs,
  unverifiable,
} from './util';

export const BOOKING_TOOLS = ['book', 'reschedule', 'cancel'];

const STATUS_FOR_ACTION: Record<string, string[]> = {
  book: ['confirmed'],
  reschedule: ['confirmed', 'rescheduled'],
  cancel: ['cancelled', 'canceled'],
};

/**
 * "You're booked for Tuesday at 3" is SUPPORTED only if a booking tool returned
 * that exact slot, confirmed, before the agent said it. Exact slot match: a
 * booking an hour and a half off is the whole failure class we exist to catch.
 */
export function checkBooking(run: AgentRun, claim: Claim): CheckedClaim {
  const checker = 'booking';
  const anyBookingTool = indexedEvents(run).filter(
    ({ event }) =>
      (event.type === 'tool.called' || event.type === 'tool.result') && nameMatches(event, BOOKING_TOOLS),
  );
  if (anyBookingTool.length === 0) {
    return unverifiable(claim, checker, 'no book/reschedule/cancel tool was called in this run');
  }

  const slot = typeof claim.normalized.slot === 'string' ? claim.normalized.slot : null;
  if (!slot) {
    return unverifiable(claim, checker, 'the claim did not state a date and time to check');
  }

  const action = typeof claim.normalized.action === 'string' ? claim.normalized.action : 'book';
  const wanted = STATUS_FOR_ACTION[action] ?? ['confirmed'];
  const ts = turnTs(run, claim.turn_index);

  const results = eventsBefore(run, ts).filter(
    ({ event }) => event.type === 'tool.result' && nameMatches(event, BOOKING_TOOLS),
  );

  const match = results.find(({ event }) => {
    const r = resultObject(event);
    return String(r.slot ?? '') === slot && wanted.includes(String(r.status ?? '').toLowerCase());
  });

  if (match) {
    const r = resultObject(match.event);
    return supported(claim, checker, {
      checked: `tool.result ${match.event.name} -> slot ${r.slot} status ${r.status}`,
      event_index: match.index,
    });
  }

  const nearest = [...results].reverse().find(({ event }) => {
    const r = resultObject(event);
    return wanted.includes(String(r.status ?? '').toLowerCase()) && typeof r.slot === 'string';
  });

  if (nearest) {
    const r = resultObject(nearest.event);
    return contradicted(claim, checker, {
      checked: `no ${action} tool.result with slot ${slot} before turn ${claim.turn_index}`,
      event_index: nearest.index,
      reason: `nearest confirmed slot was ${r.slot}`,
    });
  }

  const attempted = anyBookingTool.find(({ event }) => event.type === 'tool.called');
  return contradicted(claim, checker, {
    checked: `no ${action} tool.result with slot ${slot} before turn ${claim.turn_index}`,
    event_index: attempted ? attempted.index : null,
    reason: attempted
      ? `${attempted.event.name} was called with ${JSON.stringify(argsObject(attempted.event).slot ?? null)} but returned no matching confirmation`
      : 'no confirmed booking result exists before this turn',
  });
}
