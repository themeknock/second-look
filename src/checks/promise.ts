import type { AgentRun, CheckedClaim, Claim } from '../schema';
import { anchorTurn, contradicted, eventsAfter, nameMatches, runIsComplete, supported, turnTs, unverifiable } from './util';

const CHANNEL_TOOLS: Record<string, string[]> = {
  sms: ['send_sms', 'send_text', 'sms'],
  email: ['send_email', 'email'],
  message: ['send_sms', 'send_text', 'send_email', 'sms', 'email'],
};

/** "I'll text you the confirmation" needs a send_sms call after the agent said it. */
export function checkPromise(run: AgentRun, claim: Claim): CheckedClaim {
  const checker = 'promise';
  const channel = String(claim.normalized.channel ?? 'message');
  const tools = CHANNEL_TOOLS[channel] ?? CHANNEL_TOOLS.message;
  const anchor = anchorTurn(run, claim);
  const ts = anchor.ts;

  const called = eventsAfter(run, ts).find(
    ({ event }) => event.type === 'tool.called' && nameMatches(event, tools),
  );
  if (called) {
    return supported(claim, checker, {
      checked: `tool.called ${called.event.name} at ${called.event.ts}`,
      event_index: called.index,
    });
  }

  if (!runIsComplete(run)) {
    return unverifiable(claim, checker, 'the run has no call.ended event, so a later send cannot be ruled out');
  }

  return contradicted(claim, checker, {
    checked: `no ${tools.join('/')} tool.called after turn ${anchor.index}`,
    event_index: null,
    reason: 'the run finished without the promised message being sent',
  });
}
