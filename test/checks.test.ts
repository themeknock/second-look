import { describe, expect, it } from 'vitest';
import { checkBooking, checkKbFact, checkPrice, checkPromise, checkTransfer, runVerdict } from '../src/checks';
import { extractClaimsWithRules } from '../src/extract';
import { AgentRunSchema, type AgentEvent, type AgentRun, type CheckedClaim, type Claim } from '../src/schema';

const T = (n: number) => `2026-09-20T10:${String(n).padStart(2, '0')}:00Z`;

function makeRun(partial: {
  turns: Array<{ role: 'user' | 'assistant'; text: string; at: number }>;
  events: Array<Partial<AgentEvent> & { at: number; type: string }>;
  ended?: boolean;
}): AgentRun {
  const events: AgentEvent[] = partial.events.map(({ at, ...rest }) => ({ ts: T(at), ...rest } as AgentEvent));
  if (partial.ended !== false) events.push({ ts: T(59), type: 'call.ended' });
  return AgentRunSchema.parse({
    run_id: 'call_test',
    agent: 'dispatch-voice',
    started_at: T(0),
    ended_at: partial.ended === false ? undefined : T(59),
    transcript: partial.turns.map((t, i) => ({ i, role: t.role, text: t.text, ts: T(t.at) })),
    events,
    ground_truth: { catalogue_version: '2026-09-01' },
  });
}

const claim = (kind: Claim['kind'], turn_index: number, text: string, normalized: Record<string, unknown>): Claim => ({
  kind,
  turn_index,
  text,
  normalized,
});

describe('booking checker', () => {
  const booked = (slot: string, status = 'confirmed'): Array<Partial<AgentEvent> & { at: number; type: string }> => [
    { at: 1, type: 'tool.called', name: 'book', args: { slot } },
    { at: 2, type: 'tool.result', name: 'book', result: { booking_id: 'bk_1', slot, status } },
  ];

  it('SUPPORTED when a confirmed booking with the exact slot exists before the claim', () => {
    const run = makeRun({
      turns: [{ role: 'assistant', text: 'You are booked for September 22 at 3pm.', at: 5 }],
      events: booked('2026-09-22T15:00'),
    });
    const result = checkBooking(run, claim('booking', 0, 'You are booked for September 22 at 3pm.', { action: 'book', slot: '2026-09-22T15:00' }));
    expect(result.verdict).toBe('SUPPORTED');
    expect(result.evidence.event_index).toBe(1);
    expect(result.evidence.checked).toContain('2026-09-22T15:00');
  });

  it('CONTRADICTED when the stated slot is not the booked slot, and names the nearest confirmed slot', () => {
    const run = makeRun({
      turns: [{ role: 'assistant', text: 'You are booked for September 22 at 4:30pm.', at: 5 }],
      events: booked('2026-09-22T15:00'),
    });
    const result = checkBooking(run, claim('booking', 0, 'x', { action: 'book', slot: '2026-09-22T16:30' }));
    expect(result.verdict).toBe('CONTRADICTED');
    expect(result.evidence.reason).toContain('2026-09-22T15:00');
  });

  it('CONTRADICTED when the booking tool ran only AFTER the agent announced it', () => {
    const run = makeRun({
      turns: [{ role: 'assistant', text: 'You are booked.', at: 1 }],
      events: [
        { at: 4, type: 'tool.called', name: 'book', args: { slot: '2026-09-22T15:00' } },
        { at: 5, type: 'tool.result', name: 'book', result: { slot: '2026-09-22T15:00', status: 'confirmed' } },
      ],
    });
    const result = checkBooking(run, claim('booking', 0, 'x', { action: 'book', slot: '2026-09-22T15:00' }));
    expect(result.verdict).toBe('CONTRADICTED');
  });

  it('UNVERIFIABLE, never CONTRADICTED, when the run used no booking tool at all', () => {
    const run = makeRun({
      turns: [{ role: 'assistant', text: 'You are booked for September 22 at 3pm.', at: 5 }],
      events: [{ at: 1, type: 'tool.called', name: 'kb_lookup', args: { topic: 'hours' } }],
    });
    const result = checkBooking(run, claim('booking', 0, 'x', { action: 'book', slot: '2026-09-22T15:00' }));
    expect(result.verdict).toBe('UNVERIFIABLE');
    expect(result.evidence.reason).toContain('no book/reschedule/cancel tool');
  });

  it('matches a cancellation against a cancelled status, not a confirmed one', () => {
    const run = makeRun({
      turns: [{ role: 'assistant', text: 'I have cancelled it.', at: 5 }],
      events: [
        { at: 1, type: 'tool.called', name: 'cancel', args: { slot: '2026-09-22T15:00' } },
        { at: 2, type: 'tool.result', name: 'cancel', result: { slot: '2026-09-22T15:00', status: 'cancelled' } },
      ],
    });
    expect(checkBooking(run, claim('booking', 0, 'x', { action: 'cancel', slot: '2026-09-22T15:00' })).verdict).toBe('SUPPORTED');
    expect(checkBooking(run, claim('booking', 0, 'x', { action: 'book', slot: '2026-09-22T15:00' })).verdict).toBe('CONTRADICTED');
  });
});

describe('price checker', () => {
  const run = makeRun({
    turns: [{ role: 'assistant', text: 'The boiler repair call-out is $95.', at: 5 }],
    events: [{ at: 1, type: 'tool.called', name: 'kb_lookup', args: {} }],
  });

  it('SUPPORTED against the catalogue and names the catalogue key', () => {
    const result = checkPrice(run, claim('price', 0, 'x', { amount: 95, service: 'boiler_repair' }));
    expect(result.verdict).toBe('SUPPORTED');
    expect(result.evidence.catalogue_key).toBe('boiler_repair');
  });

  it('CONTRADICTED when the amount differs from the catalogue', () => {
    const result = checkPrice(run, claim('price', 0, 'x', { amount: 120, service: 'boiler_repair' }));
    expect(result.verdict).toBe('CONTRADICTED');
    expect(result.evidence.reason).toContain('$95');
  });

  it('prefers a get_price tool result over the catalogue', () => {
    const withTool = makeRun({
      turns: [{ role: 'assistant', text: 'That is $150 with the parts.', at: 5 }],
      events: [{ at: 1, type: 'tool.result', name: 'get_price', result: { service: 'boiler_repair', amount: 150 } }],
    });
    const result = checkPrice(withTool, claim('price', 0, 'x', { amount: 150, service: 'boiler_repair' }));
    expect(result.verdict).toBe('SUPPORTED');
    expect(result.evidence.event_index).toBe(0);
  });

  it('UNVERIFIABLE when no service is named and the run has no price tool', () => {
    const result = checkPrice(run, claim('price', 0, 'x', { amount: 95, service: null }));
    expect(result.verdict).toBe('UNVERIFIABLE');
  });
});

describe('transfer checker', () => {
  it('SUPPORTED when transfer.executed follows the claim', () => {
    const run = makeRun({
      turns: [{ role: 'assistant', text: 'Putting you through now.', at: 5 }],
      events: [
        { at: 6, type: 'transfer.promised' },
        { at: 7, type: 'transfer.executed' },
      ],
    });
    expect(checkTransfer(run, claim('transfer', 0, 'x', { to: 'office' })).verdict).toBe('SUPPORTED');
  });

  it('CONTRADICTED when the call ended with no transfer - said transferring, did not', () => {
    const run = makeRun({
      turns: [{ role: 'assistant', text: 'Putting you through now.', at: 5 }],
      events: [{ at: 6, type: 'transfer.promised' }],
    });
    const result = checkTransfer(run, claim('transfer', 0, 'x', { to: 'office' }));
    expect(result.verdict).toBe('CONTRADICTED');
    expect(result.evidence.reason).toContain('never executed');
  });

  it('UNVERIFIABLE when the run never ended, so a later transfer cannot be ruled out', () => {
    const run = makeRun({
      turns: [{ role: 'assistant', text: 'Putting you through now.', at: 5 }],
      events: [{ at: 1, type: 'call.started' }],
      ended: false,
    });
    expect(checkTransfer(run, claim('transfer', 0, 'x', { to: 'office' })).verdict).toBe('UNVERIFIABLE');
  });
});

describe('kb checker', () => {
  const run = makeRun({ turns: [{ role: 'assistant', text: 'x', at: 5 }], events: [{ at: 1, type: 'call.started' }] });

  it('checks hours against the catalogue', () => {
    expect(checkKbFact(run, claim('kb_fact', 0, 'x', { fact: 'hours', open: '08:00', close: '18:00' })).verdict).toBe('SUPPORTED');
    expect(checkKbFact(run, claim('kb_fact', 0, 'x', { fact: 'hours', open: '08:00', close: '20:00' })).verdict).toBe('CONTRADICTED');
  });

  it('checks the service area against the postcode list', () => {
    expect(checkKbFact(run, claim('kb_fact', 0, 'x', { fact: 'service_area', postcode: '19103' })).verdict).toBe('SUPPORTED');
    const bad = checkKbFact(run, claim('kb_fact', 0, 'x', { fact: 'service_area', postcode: '19151' }));
    expect(bad.verdict).toBe('CONTRADICTED');
    expect(bad.evidence.catalogue_key).toBe('service_area_postcodes');
  });

  it('checks the address', () => {
    expect(checkKbFact(run, claim('kb_fact', 0, 'x', { fact: 'address', value: '412 Northgate Way, Suite 7' })).verdict).toBe('SUPPORTED');
    expect(checkKbFact(run, claim('kb_fact', 0, 'x', { fact: 'address', value: '9 Elm Street' })).verdict).toBe('CONTRADICTED');
  });

  it('UNVERIFIABLE for a fact the catalogue does not cover', () => {
    expect(checkKbFact(run, claim('kb_fact', 0, 'x', { fact: 'refund_policy' })).verdict).toBe('UNVERIFIABLE');
  });
});

describe('promise checker', () => {
  it('SUPPORTED when send_sms is called after the promise', () => {
    const run = makeRun({
      turns: [{ role: 'assistant', text: 'I will text you a confirmation.', at: 5 }],
      events: [{ at: 6, type: 'tool.called', name: 'send_sms', args: {} }],
    });
    expect(checkPromise(run, claim('promise', 0, 'x', { channel: 'sms' })).verdict).toBe('SUPPORTED');
  });

  it('CONTRADICTED when the run finished and nothing was sent', () => {
    const run = makeRun({
      turns: [{ role: 'assistant', text: 'I will text you a confirmation.', at: 5 }],
      events: [{ at: 1, type: 'call.started' }],
    });
    expect(checkPromise(run, claim('promise', 0, 'x', { channel: 'sms' })).verdict).toBe('CONTRADICTED');
  });

  it('does not count a send that happened BEFORE the promise', () => {
    const run = makeRun({
      turns: [{ role: 'assistant', text: 'I will text you a confirmation.', at: 5 }],
      events: [{ at: 2, type: 'tool.called', name: 'send_sms', args: {} }],
    });
    expect(checkPromise(run, claim('promise', 0, 'x', { channel: 'sms' })).verdict).toBe('CONTRADICTED');
  });
});

describe('run verdict', () => {
  const c = (verdict: CheckedClaim['verdict'], risk: CheckedClaim['risk'] = null): CheckedClaim => ({
    ...claim('other', 0, 'x', {}),
    verdict,
    risk,
    checker: 'test',
    evidence: { checked: 'x', event_index: null, catalogue_key: null, reason: null },
  });

  it('any CONTRADICTED is a FAIL', () => {
    expect(runVerdict([c('SUPPORTED'), c('CONTRADICTED')])).toBe('FAIL');
  });
  it('a high-risk UNVERIFIABLE goes to a human', () => {
    expect(runVerdict([c('SUPPORTED'), c('UNVERIFIABLE', 'high')])).toBe('NEEDS_HUMAN');
  });
  it('low-risk unknowns still pass', () => {
    expect(runVerdict([c('SUPPORTED'), c('UNVERIFIABLE', 'low')])).toBe('PASS');
  });
});

describe('rules extractor', () => {
  it('reads a confirmation as a booking claim with a normalized slot', () => {
    const run = makeRun({
      turns: [{ role: 'assistant', text: 'You are booked for Tuesday, September 22 at 3pm. I will text you a confirmation now.', at: 5 }],
      events: [{ at: 1, type: 'call.started' }],
    });
    const claims = extractClaimsWithRules(run);
    const booking = claims.find((c) => c.kind === 'booking');
    expect(booking?.normalized.slot).toBe('2026-09-22T15:00');
    expect(claims.some((c) => c.kind === 'promise')).toBe(true);
  });

  it('does not treat an offer as a booking', () => {
    const run = makeRun({
      turns: [{ role: 'assistant', text: 'I can get someone to you on Tuesday, September 22 at 3pm. Shall I book it?', at: 5 }],
      events: [{ at: 1, type: 'call.started' }],
    });
    expect(extractClaimsWithRules(run).some((c) => c.kind === 'booking')).toBe(false);
  });

  it('ignores user turns entirely', () => {
    const run = makeRun({
      turns: [{ role: 'user', text: 'You said I am booked for September 22 at 3pm and it costs $95.', at: 5 }],
      events: [{ at: 1, type: 'call.started' }],
    });
    expect(extractClaimsWithRules(run)).toHaveLength(0);
  });
});

describe('ingest schema', () => {
  it('refuses a run with no events - nothing to check against', () => {
    const bad = {
      run_id: 'call_x',
      agent: 'a',
      started_at: T(0),
      transcript: [{ i: 0, role: 'assistant', text: 'hi', ts: T(1) }],
      events: [],
    };
    expect(AgentRunSchema.safeParse(bad).success).toBe(false);
  });

  it('stores an unknown event type instead of rejecting the run', () => {
    const run = makeRun({
      turns: [{ role: 'assistant', text: 'hi', at: 5 }],
      events: [{ at: 1, type: 'vendor.weird_thing', name: 'x' }],
    });
    expect(run.events[0].type).toBe('vendor.weird_thing');
  });
});
