import type { AgentRun, CheckedClaim, Claim } from '../schema';
import { anchorTurn, contradicted, eventsAfter, indexedEvents, runIsComplete, supported, turnTs, unverifiable } from './util';

/**
 * "I'm putting you through" is the promise. The evidence is a transfer.executed
 * event after it. A completed run with no such event means the caller was left
 * on the line - the "said transferring, didn't" class.
 */
export function checkTransfer(run: AgentRun, claim: Claim): CheckedClaim {
  const checker = 'transfer';
  const anchor = anchorTurn(run, claim);
  const ts = anchor.ts;

  const executed = eventsAfter(run, ts).find(({ event }) => event.type === 'transfer.executed');
  if (executed) {
    return supported(claim, checker, {
      checked: `transfer.executed at ${executed.event.ts}`,
      event_index: executed.index,
    });
  }

  if (!runIsComplete(run)) {
    return unverifiable(claim, checker, 'the run has no call.ended event, so a later transfer cannot be ruled out');
  }

  const promised = indexedEvents(run).find(({ event }) => event.type === 'transfer.promised');
  const ended = indexedEvents(run).find(({ event }) => event.type === 'call.ended');
  return contradicted(claim, checker, {
    checked: `no transfer.executed event after turn ${anchor.index}`,
    event_index: promised ? promised.index : ended ? ended.index : null,
    reason: promised
      ? 'transfer.promised is present but the transfer was never executed'
      : 'the call ended without a transfer',
  });
}
