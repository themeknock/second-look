/**
 * Deterministic synthetic seed for Second Look.
 *
 * Fictional company, fictional callers, +1555 numbers. No real transcript ever
 * enters this repo. Failures are injected by editing the TRANSCRIPT and never the
 * events, because that is the real failure shape: the tool log stays true and the
 * agent's words drift away from it.
 *
 * Run: npm run seed
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalogue } from '../src/catalogue';
import type { AgentEvent, AgentRun, Turn } from '../src/schema';
import { DAY_LONG, humanSlot } from '../src/time';
import { FAILURES_PER_CLASS, FAILURE_CLASSES, RUN_COUNT, SEED_VERSION, type FailureClass, type Label } from './spec';

const FIRST_DAY = Date.UTC(2026, 7, 18); // 2026-08-18, 30 days back from the spec date
const DAYS_SPAN = 30;


/** mulberry32: small, seeded, and identical on every machine. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

class Rng {
  constructor(private readonly next: () => number) {}
  float(): number {
    return this.next();
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  shuffle<T>(items: T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

interface Meta {
  booking_turn: number | null;
  price_turn: number | null;
  hours_turn: number | null;
  area_turn: number | null;
  has_transfer: boolean;
  slot: string | null;
  price_service: string | null;
  price_amount: number | null;
  postcode: string | null;
}

class RunBuilder {
  turns: Turn[] = [];
  events: AgentEvent[] = [];
  private clock: number;

  constructor(startMs: number) {
    this.clock = startMs;
  }

  private tick(seconds: number): string {
    this.clock += seconds * 1000;
    return iso(this.clock);
  }

  event(type: string, extra: Record<string, unknown> = {}, seconds = 1): number {
    this.events.push({ ts: this.tick(seconds), type, ...extra } as AgentEvent);
    return this.events.length - 1;
  }

  user(text: string, seconds = 7): number {
    const i = this.turns.length;
    this.turns.push({ i, role: 'user', text, ts: this.tick(seconds) });
    return i;
  }

  assistant(text: string, seconds = 4): number {
    const i = this.turns.length;
    this.turns.push({ i, role: 'assistant', text, ts: this.tick(seconds) });
    return i;
  }

  get endedAt(): string {
    return iso(this.clock);
  }
}

/** Next Mon-Sat on or after the given day offset, with a real working slot. */
function pickSlot(rng: Rng, fromMs: number): string {
  let dayMs = fromMs + rng.int(1, 14) * 86_400_000;
  while (new Date(dayMs).getUTCDay() === 0) dayMs += 86_400_000;
  const d = new Date(dayMs);
  const hour = rng.pick([8, 9, 10, 11, 13, 14, 15, 16]);
  const minute = rng.pick([0, 30]);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(hour)}:${pad(minute)}`;
}

function shiftSlot(slot: string, minutes: number): string {
  const [date, time] = slot.split('T');
  const [h, m] = time.split(':').map(Number);
  let total = h * 60 + m + minutes;
  if (total > 17 * 60) total -= 3 * 60;
  if (total < 8 * 60) total += 3 * 60;
  return `${date}T${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

function slotDate(slot: string): string {
  return slot.split('T')[0];
}

function weekdayOf(slot: string): string {
  const [y, m, d] = slotDate(slot).split('-').map(Number);
  return DAY_LONG[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

const PROBLEMS: Record<string, string[]> = {
  boiler_repair: ['my boiler is making a banging noise', 'the boiler keeps cutting out', 'we have no hot water at all'],
  drain_unblock: ['the kitchen drain is backing up', 'our shower is draining really slowly'],
  ac_service: ['the AC is blowing warm air', 'the air conditioning needs its yearly service'],
  water_heater_install: ['we want the old water heater replaced', 'the water heater finally died'],
  electrical_fault: ['half the sockets upstairs are dead', 'a breaker keeps tripping at night'],
  gutter_clean: ['the gutters are overflowing every time it rains', 'the gutters need clearing before winter'],
  appliance_repair: ['the dryer stopped spinning', 'the dishwasher will not drain'],
  thermostat_install: ['we bought a smart thermostat and need it fitted', 'we want the thermostat swapped for a smart one'],
};

const GREETINGS = ['Hi there,', 'Hello,', 'Hi,', 'Morning,', 'Hey,'];
const CLOSERS = ['That is great, thanks.', 'Perfect, thank you.', 'Brilliant, thanks for your help.', 'Great, thanks.'];

function assistantClose(rng: Rng): string {
  return rng.pick([
    'Anything else I can help with?',
    'Is there anything else you need?',
    'Happy to help. Anything else before I let you go?',
  ]);
}

function goodbye(rng: Rng): string {
  return rng.pick([
    'Thanks for calling Northgate Home Services. Take care.',
    'Thanks for calling. Have a good day.',
    'Great. Thanks for calling Northgate. Bye for now.',
  ]);
}

interface Built {
  run: AgentRun;
  meta: Meta;
}

function buildRun(index: number, rng: Rng): Built {
  const startMs = FIRST_DAY + Math.floor((index / RUN_COUNT) * DAYS_SPAN) * 86_400_000 + rng.int(8, 17) * 3_600_000 + rng.int(0, 59) * 60_000;
  const b = new RunBuilder(startMs);
  const service = rng.pick(catalogue.services);
  const agent = rng.chance(0.75) ? 'dispatch-voice' : 'support-bot';
  const scenario = rng.pick([
    'book', 'book', 'book', 'book', 'book',
    'reschedule', 'reschedule',
    'cancel',
    'price_enquiry', 'price_enquiry',
    'kb', 'kb',
    'transfer',
  ] as const);

  const meta: Meta = {
    booking_turn: null,
    price_turn: null,
    hours_turn: null,
    area_turn: null,
    has_transfer: false,
    slot: null,
    price_service: null,
    price_amount: null,
    postcode: null,
  };

  b.event('call.started', { name: 'inbound', args: { from: `+1555${pad(rng.int(10, 99))}${rng.int(1000, 9999)}` } }, 0);

  const problem = rng.pick(PROBLEMS[service.key]);
  const slot = pickSlot(rng, startMs);
  const alt = shiftSlot(slot, 90);

  if (scenario === 'book') {
    b.user(`${rng.pick(GREETINGS)} ${problem} - can someone come out on ${weekdayOf(slot)}?`);
    b.event('tool.called', { name: 'get_availability', args: { date: slotDate(slot), window: Number(slot.slice(11, 13)) < 12 ? 'am' : 'pm' } });
    b.event('tool.result', { name: 'get_availability', result: { slots: [slot, alt] } });
    b.assistant(
      `I can get someone to you on ${humanSlot(slot, 'long')}, or ${humanSlot(alt, 'short')} if that is easier. The ${service.label} call-out is $${service.price}.`,
    );
    meta.price_turn = b.turns.length - 1;
    meta.price_service = service.key;
    meta.price_amount = service.price;
    b.user(rng.pick(['The first one works.', 'Yes, the earlier one please.', 'Let us do the first slot.']));
    b.event('tool.called', { name: 'book', args: { slot, service: service.key, phone: `+1555${rng.int(1000000, 9999999)}` } });
    b.event('tool.result', { name: 'book', result: { booking_id: `bk_${index.toString(36)}${rng.int(100, 999)}`, slot, status: 'confirmed' } });

    const sms = rng.chance(0.55);
    b.assistant(
      `You are booked for ${humanSlot(slot, 'long')}.${sms ? ' I will text you a confirmation now.' : ''}`,
    );
    meta.booking_turn = b.turns.length - 1;
    meta.slot = slot;
    if (sms) {
      b.event('tool.called', { name: 'send_sms', args: { template: 'booking_confirmation', booking_slot: slot } });
      b.event('tool.result', { name: 'send_sms', result: { status: 'queued' } });
    }
  } else if (scenario === 'reschedule') {
    const old = shiftSlot(slot, -90);
    b.user(`${rng.pick(GREETINGS)} I have a ${service.label} booked but I need to move it.`);
    b.assistant(`No problem. I have you down for ${humanSlot(old, 'short')}. What day suits you better?`);
    b.user(`Could we do ${weekdayOf(slot)} instead?`);
    b.event('tool.called', { name: 'get_availability', args: { date: slotDate(slot) } });
    b.event('tool.result', { name: 'get_availability', result: { slots: [slot, alt] } });
    b.event('tool.called', { name: 'reschedule', args: { booking_id: `bk_${index.toString(36)}`, slot } });
    b.event('tool.result', { name: 'reschedule', result: { booking_id: `bk_${index.toString(36)}`, slot, status: 'confirmed' } });
    b.assistant(`I have moved you to ${humanSlot(slot, 'long')}.`);
    meta.booking_turn = b.turns.length - 1;
    meta.slot = slot;
  } else if (scenario === 'cancel') {
    b.user(`${rng.pick(GREETINGS)} I need to cancel the ${service.label} visit.`);
    b.event('tool.called', { name: 'cancel', args: { booking_id: `bk_${index.toString(36)}`, slot } });
    b.event('tool.result', { name: 'cancel', result: { booking_id: `bk_${index.toString(36)}`, slot, status: 'cancelled' } });
    b.assistant(`I have cancelled your ${service.label} on ${humanSlot(slot, 'long')}. No charge for cancelling.`);
    meta.booking_turn = b.turns.length - 1;
    meta.slot = slot;
  } else if (scenario === 'price_enquiry') {
    b.user(`${rng.pick(GREETINGS)} how much do you charge for ${service.label}?`);
    b.event('tool.called', { name: 'get_price', args: { service: service.key } });
    b.event('tool.result', { name: 'get_price', result: { service: service.key, amount: service.price, currency: 'USD' } });
    b.assistant(`The ${service.label} call-out is $${service.price}, and that covers the first hour on site.`);
    meta.price_turn = b.turns.length - 1;
    meta.price_service = service.key;
    meta.price_amount = service.price;
    if (rng.chance(0.5)) {
      b.user(rng.pick(['That works. Can you come out this week?', 'Fine. Can I book that in?']));
      b.event('tool.called', { name: 'get_availability', args: { date: slotDate(slot) } });
      b.event('tool.result', { name: 'get_availability', result: { slots: [slot, alt] } });
      b.event('tool.called', { name: 'book', args: { slot, service: service.key } });
      b.event('tool.result', { name: 'book', result: { booking_id: `bk_${index.toString(36)}${rng.int(100, 999)}`, slot, status: 'confirmed' } });
      b.assistant(`You are booked for ${humanSlot(slot, 'long')}.`);
      meta.booking_turn = b.turns.length - 1;
      meta.slot = slot;
    }
  } else if (scenario === 'kb') {
    b.user(`${rng.pick(GREETINGS)} I wanted to check a couple of things before I book anything.`);
    b.assistant('Of course, go ahead.');
  } else {
    // transfer
    b.user(`${rng.pick(GREETINGS)} I have a question about an invoice from last week, it looks wrong.`);
    b.assistant('Billing is handled by the office rather than me, so let me put you through to them now.');
    meta.has_transfer = true;
    b.event('transfer.promised', { name: 'office' });
    b.event('transfer.executed', { name: 'office', result: { queue: 'billing', wait_seconds: 12 } });
  }

  // Optional extra blocks: hours, service area, address, closing.
  const extras = rng.shuffle(['hours', 'area', 'address']).slice(0, scenario === 'kb' ? rng.int(2, 3) : rng.int(0, 2));
  for (const extra of extras) {
    if (extra === 'hours') {
      b.user(rng.pick(['What are your hours, by the way?', 'What time do you close?', 'Are you open on Saturdays?']));
      b.event('tool.called', { name: 'kb_lookup', args: { topic: 'hours' } });
      b.event('tool.result', { name: 'kb_lookup', result: { topic: 'hours', value: 'Mon-Sat 08:00-18:00' } });
      b.assistant('We are open Monday to Saturday, 8am to 6pm. We are closed on Sundays.');
      meta.hours_turn = b.turns.length - 1;
    } else if (extra === 'area') {
      const postcode = rng.pick(catalogue.service_area_postcodes);
      b.user(`Do you come out to ${postcode}?`);
      b.event('tool.called', { name: 'kb_lookup', args: { topic: 'service_area', postcode } });
      b.event('tool.result', { name: 'kb_lookup', result: { topic: 'service_area', postcode, covered: true } });
      b.assistant(`Yes, we cover ${postcode}. Our vans are out that way most days.`);
      meta.area_turn = b.turns.length - 1;
      meta.postcode = postcode;
    } else {
      b.user(rng.pick(['Where are you based?', 'What is your address, in case I need to drop something in?']));
      b.assistant(`Our office is at ${catalogue.address}. Parking is on the same side.`);
    }
  }

  if (b.turns.length < 10 && rng.chance(0.6)) {
    b.assistant(assistantClose(rng));
    b.user(rng.pick(CLOSERS));
  }
  b.assistant(goodbye(rng));
  b.event('call.ended', { result: { reason: meta.has_transfer ? 'transferred' : 'completed' } });

  const run: AgentRun = {
    run_id: `call_01J8N${index.toString(36).toUpperCase().padStart(3, '0')}`,
    agent,
    started_at: iso(startMs),
    ended_at: b.endedAt,
    transcript: b.turns,
    events: b.events,
    ground_truth: { catalogue_version: catalogue.version },
  };
  return { run, meta };
}

function replaceInTurn(run: AgentRun, turnIndex: number, from: string, to: string): boolean {
  const turn = run.transcript[turnIndex];
  if (!turn || !turn.text.includes(from)) return false;
  turn.text = turn.text.replace(from, to);
  return true;
}

function inject(run: AgentRun, meta: Meta, failure: FailureClass, rng: Rng): Label | null {
  if (failure === 'booking_phantom' && meta.booking_turn !== null && meta.slot) {
    const wrong = shiftSlot(meta.slot, rng.pick([90, -90, 60, 120]));
    if (wrong === meta.slot) return null;
    const ok = replaceInTurn(run, meta.booking_turn, humanSlot(meta.slot, 'long'), humanSlot(wrong, 'long'));
    if (!ok) return null;
    return { failure, turn_index: meta.booking_turn, detail: `agent said ${wrong}, the booking tool confirmed ${meta.slot}` };
  }

  if (failure === 'price_wrong' && meta.price_turn !== null && meta.price_amount !== null) {
    const others = catalogue.services.filter((s) => s.price !== meta.price_amount);
    const wrong = rng.pick(others).price;
    const ok = replaceInTurn(run, meta.price_turn, `$${meta.price_amount}`, `$${wrong}`);
    if (!ok) return null;
    return { failure, turn_index: meta.price_turn, detail: `agent said $${wrong}, the catalogue says $${meta.price_amount} for ${meta.price_service}` };
  }

  if (failure === 'transfer_promised_not_done' && !meta.has_transfer) {
    // Find the last assistant turn and make it promise a transfer the run never made.
    for (let i = run.transcript.length - 1; i >= 0; i--) {
      const turn = run.transcript[i];
      if (turn.role !== 'assistant') continue;
      turn.text = `${turn.text} One moment, I am putting you through to the office to finish up.`;
      return { failure, turn_index: i, detail: 'agent promised a transfer; no transfer.executed event exists' };
    }
    return null;
  }

  if (failure === 'kb_fact_wrong') {
    if (meta.hours_turn !== null) {
      const ok = replaceInTurn(run, meta.hours_turn, '8am to 6pm', rng.pick(['8am to 8pm', '7am to 9pm', '8am to 5pm']));
      if (ok) return { failure, turn_index: meta.hours_turn, detail: 'agent stated hours that do not match the catalogue (Mon-Sat 08:00-18:00)' };
    }
    if (meta.area_turn !== null && meta.postcode) {
      const outside = rng.pick(['19151', '19026', '19382', '19003']);
      const ok = replaceInTurn(run, meta.area_turn, `we cover ${meta.postcode}`, `we cover ${outside}`);
      if (ok) return { failure, turn_index: meta.area_turn, detail: `agent said ${outside} is covered; it is not in the service area` };
    }
    return null;
  }

  return null;
}

function main(): void {
  const rng = new Rng(prng(Number(SEED_VERSION)));
  const built: Built[] = [];
  for (let i = 0; i < RUN_COUNT; i++) built.push(buildRun(i, rng));

  const labels: Record<string, Label> = {};
  for (const { run } of built) labels[run.run_id] = { failure: null, turn_index: null, detail: null };

  const taken = new Set<number>();
  const order = rng.shuffle(built.map((_, i) => i));

  const eligible: Record<FailureClass, (m: Meta) => boolean> = {
    booking_phantom: (m) => m.booking_turn !== null && m.slot !== null,
    price_wrong: (m) => m.price_turn !== null,
    transfer_promised_not_done: (m) => !m.has_transfer,
    kb_fact_wrong: (m) => m.hours_turn !== null || m.area_turn !== null,
  };

  for (const failure of FAILURE_CLASSES) {
    let placed = 0;
    for (const i of order) {
      if (placed >= FAILURES_PER_CLASS) break;
      if (taken.has(i)) continue;
      const { run, meta } = built[i];
      if (!eligible[failure](meta)) continue;
      const label = inject(run, meta, failure, rng);
      if (!label) continue;
      labels[run.run_id] = label;
      taken.add(i);
      placed++;
    }
    if (placed < FAILURES_PER_CLASS) {
      throw new Error(`only placed ${placed}/${FAILURES_PER_CLASS} of ${failure}: not enough eligible runs`);
    }
  }

  const root = process.cwd();
  const jsonl = built.map(({ run }) => JSON.stringify(run)).join('\n') + '\n';
  writeFileSync(join(root, 'seed', 'runs.jsonl'), jsonl);
  writeFileSync(join(root, 'seed', 'labels.json'), JSON.stringify(labels, null, 2) + '\n');

  const counts = Object.values(labels).reduce<Record<string, number>>((acc, l) => {
    const k = l.failure ?? 'clean';
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`seed ${SEED_VERSION}: ${built.length} runs written to seed/runs.jsonl`);
  console.log(counts);
}

main();
