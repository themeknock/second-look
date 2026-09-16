/** Seed constants with no side effects, so tests can import them without regenerating. */
export const SEED_VERSION = '20260916';
export const RUN_COUNT = 200;
export const FAILURES_PER_CLASS = 15;

export const FAILURE_CLASSES = [
  'booking_phantom',
  'price_wrong',
  'transfer_promised_not_done',
  'kb_fact_wrong',
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export interface Label {
  failure: FailureClass | null;
  turn_index: number | null;
  detail: string | null;
}
