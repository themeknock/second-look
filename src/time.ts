const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

export const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function monthIndex(name: string): number {
  const lower = name.toLowerCase().replace(/\./g, '');
  const i = MONTHS.findIndex((m) => m.startsWith(lower.slice(0, 3)) && lower.length >= 3);
  return i;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function to24h(hour: number, minute: number, meridiem: string): { h: number; m: number } {
  let h = hour % 12;
  if (meridiem.toLowerCase().startsWith('p')) h += 12;
  return { h, m: minute };
}

/** "Tuesday, September 22 at 3pm" / "Sep 22 at 3:00pm" -> "2026-09-22T15:00". */
export function parseDateTime(text: string, yearHint: number): string | null {
  const re =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i;
  const m = re.exec(text);
  if (!m) return null;
  const mi = monthIndex(m[1]);
  if (mi < 0) return null;
  const day = Number(m[2]);
  const { h, m: min } = to24h(Number(m[3]), m[4] ? Number(m[4]) : 0, m[5]);
  return `${yearHint}-${pad(mi + 1)}-${pad(day)}T${pad(h)}:${pad(min)}`;
}

/** "8am" / "6:30 pm" -> "08:00" / "18:30". */
export function parseClock(hour: string, minute: string | undefined, meridiem: string): string {
  const { h, m } = to24h(Number(hour), minute ? Number(minute) : 0, meridiem);
  return `${pad(h)}:${pad(m)}`;
}

export function yearOf(iso: string): number {
  const y = Number(iso.slice(0, 4));
  return Number.isFinite(y) ? y : new Date().getUTCFullYear();
}

/** Both ISO-ish; string compare is correct for a shared format, Date is the fallback. */
export function isBefore(a: string, b: string): boolean {
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (Number.isFinite(da) && Number.isFinite(db)) return da < db;
  return a < b;
}

export function isAfter(a: string, b: string): boolean {
  return isBefore(b, a);
}

export function humanSlot(slot: string, style: 'long' | 'short'): string {
  const [date, time] = slot.split('T');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = (time ?? '00:00').split(':').map(Number);
  const meridiem = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const clock = mi === 0 ? `${h12}${meridiem}` : `${h12}:${pad(mi)}${meridiem}`;
  const month = style === 'long' ? MONTH_LONG[mo - 1] : MONTH_SHORT[mo - 1];
  const weekday = DAY_LONG[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return style === 'long'
    ? `${weekday}, ${month} ${d} at ${clock}`
    : `${month} ${d} at ${clock}`;
}

export function addMinutesIso(ts: string, minutes: number): string {
  return new Date(Date.parse(ts) + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
