/** Small descriptive statistics for trend summaries. */

/** `median` and `typicalRange` are left out when there are no values. */
export type Distribution = { median?: number; typicalRange?: [number, number]; daysWithData: number };

/** Linear-interpolated percentile of a non-empty list. */
export function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

/** Median and middle half (25th to 75th percentile), rounded. */
export function describe(values: number[]): Distribution {
  if (values.length === 0) return { daysWithData: 0 };
  return {
    median: Math.round(percentile(values, 0.5)),
    typicalRange: [Math.round(percentile(values, 0.25)), Math.round(percentile(values, 0.75))],
    daysWithData: values.length,
  };
}

export function present(values: Array<number | undefined>): number[] {
  return values.filter((value): value is number => value !== undefined);
}

export function total(values: Array<number | undefined>): number {
  return present(values).reduce((sum, value) => sum + value, 0);
}

export function mean(values: number[]): number | undefined {
  return values.length > 0 ? total(values) / values.length : undefined;
}

export function roundOrUndefined(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value);
}
