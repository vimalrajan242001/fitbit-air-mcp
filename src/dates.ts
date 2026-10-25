export type CivilParts = { year: number; month: number; day: number };

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
  const dates: string[] = [];
  for (let index = 0; index < count; index += 1) {
    dates.push(addCivilDays(start, index));
  }
  return dates;
}

/** Closed-open civil range: start inclusive, end exclusive at the next local midnight. */
export function closedOpenRange(start: string, endInclusive: string): { start: CivilDateTime; end: CivilDateTime } {
  const midnight = { hours: 0, minutes: 0, seconds: 0, nanos: 0 };
  return {
    start: { date: parseCivilDate(start), time: midnight },
    end: { date: parseCivilDate(addCivilDays(endInclusive, 1)), time: midnight },
  };
}

export function assertActivityRange(start: string, end: string, maxDays: number): void {
  const days = inclusiveDayCount(start, end);
  if (days < 1) {
    throw new Error('The end date is before the start date.');
  }
  if (days > maxDays) {
    throw new Error(`This range is ${days} days. Activity reads cover at most ${maxDays} days.`);
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

/** Google duration strings such as `0s` or `-14400s`. */
export function parseDurationSeconds(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(-?\d+(?:\.\d+)?)s$/.exec(value.trim());
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

export function readFinite(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
