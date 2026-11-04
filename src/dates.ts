import { isRecord } from './parse.js';

export type CivilParts = { year: number; month: number; day: number };

/** Inclusive civil date range, both ends YYYY-MM-DD. */
export type DateRange = { start: string; end: string };

/** A documented TimeInterval: UTC instants plus the optional local offsets. */
export type Interval = { startTime: string; endTime: string; startUtcOffset?: string; endUtcOffset?: string };

export type CivilDateTime = {
  date: CivilParts;
  time: { hours: number; minutes: number; seconds: number; nanos: number };
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseCivilDate(iso: string): CivilParts {
  const match = DATE_RE.exec(iso);
  if (!match) {
    throw new Error('Dates must be YYYY-MM-DD.');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    throw new Error('Date is not a real calendar day.');
  }
  return { year, month, day };
}

export function formatCivilDate(parts: CivilParts): string {
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}

export function addCivilDays(iso: string, days: number): string {
  const { year, month, day } = parseCivilDate(iso);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

export function inclusiveDayCount(start: string, end: string): number {
  const startParts = parseCivilDate(start);
  const endParts = parseCivilDate(end);
  const startMs = Date.UTC(startParts.year, startParts.month - 1, startParts.day);
  const endMs = Date.UTC(endParts.year, endParts.month - 1, endParts.day);
  return Math.round((endMs - startMs) / 86_400_000) + 1;
}

export function eachCivilDate(start: string, end: string): string[] {
  const count = inclusiveDayCount(start, end);
  if (count < 1) {
    throw new Error('The end date is before the start date.');
  }
  return Array.from({ length: count }, (_, index) => addCivilDays(start, index));
}

/** The earlier of two YYYY-MM-DD dates. */
function minDate(left: string, right: string): string {
  return left < right ? left : right;
}

/** Consecutive slices of at most `size` days from `start`; the last one ends at `end`. */
export function chunkRange(start: string, end: string, size: number): DateRange[] {
  const chunks: DateRange[] = [];
  for (let chunkStart = start; chunkStart <= end; chunkStart = addCivilDays(chunkStart, size)) {
    chunks.push({ start: chunkStart, end: minDate(addCivilDays(chunkStart, size - 1), end) });
  }
  return chunks;
}

/** Closed-open civil range: start inclusive, end exclusive at the next local midnight. */
export function closedOpenRange(start: string, endInclusive: string): { start: CivilDateTime; end: CivilDateTime } {
  const midnight = { hours: 0, minutes: 0, seconds: 0, nanos: 0 };
  return {
    start: { date: parseCivilDate(start), time: midnight },
    end: { date: parseCivilDate(addCivilDays(endInclusive, 1)), time: midnight },
  };
}

export function assertRange(start: string, end: string, maxDays: number): void {
  const days = inclusiveDayCount(start, end);
  if (days < 1) {
    throw new Error('The end date is before the start date.');
  }
  if (days > maxDays) {
    throw new Error(`This range is ${days} days. This read covers at most ${maxDays} days.`);
  }
}

/** Civil calendar date in an IANA time zone. */
export function civilToday(timeZone: string, now: Date): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
  } catch {
    throw new Error('Account time zone could not be applied.');
  }
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) {
    throw new Error('Account time zone could not be applied.');
  }
  return `${year}-${month}-${day}`;
}

/** Civil date from a documented civil time, else from the UTC time plus its offset. */
export function civilDateOf(civil: unknown, time: unknown, utcOffset: unknown): string | null {
  const date = isRecord(civil) && isRecord(civil.date) ? civil.date : undefined;
  if (typeof date?.year === 'number' && typeof date.month === 'number' && typeof date.day === 'number') {
    return formatCivilDate({ year: date.year, month: date.month, day: date.day });
  }
  if (typeof time !== 'string') return null;
  const shifted = new Date(Date.parse(time) + (parseDurationSeconds(utcOffset) ?? 0) * 1000);
  return Number.isNaN(shifted.getTime()) ? null : shifted.toISOString().slice(0, 10);
}

/** Google duration strings such as `0s` or `-14400s`. */
export function parseDurationSeconds(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(-?\d+(?:\.\d+)?)s$/.exec(value.trim());
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Copies the documented interval fields, or null when either time is not a string. */
export function readInterval(value: Record<string, unknown>): Interval | null {
  const { startTime, endTime, startUtcOffset, endUtcOffset } = value;
  if (typeof startTime !== 'string' || typeof endTime !== 'string') return null;
  return {
    startTime,
    endTime,
    ...(typeof startUtcOffset === 'string' ? { startUtcOffset } : {}),
    ...(typeof endUtcOffset === 'string' ? { endUtcOffset } : {}),
  };
}

/** Whole minutes from start to end, or null when a time is unreadable or the interval runs backwards. */
export function intervalMinutes(interval: Interval): number | null {
  const startMs = Date.parse(interval.startTime);
  const endMs = Date.parse(interval.endTime);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) return null;
  return Math.round((endMs - startMs) / 60_000);
}
