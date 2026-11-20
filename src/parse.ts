/** Readers for untrusted JSON from Google. Each returns undefined instead of guessing. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A safe integer, or an integer string (the API sends int64 as a string). */
export function readInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

/** A finite number, or a plain decimal string. */
export function readFinite(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Copies an allowlist of numeric fields: `ints` must be integers, `numbers` any finite value. Unreadable fields are left out. */
export function pickNumbers<K extends string>(
  source: Record<string, unknown>,
  fields: { ints: readonly K[]; numbers: readonly K[] },
): Partial<Record<K, number>> {
  const picked: Partial<Record<K, number>> = {};
  for (const key of fields.ints) {
    const value = readInt(source[key]);
    if (value !== undefined) picked[key] = value;
  }
  for (const key of fields.numbers) {
    const value = readFinite(source[key]);
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}

/** Parses a response body as JSON. An empty body is `{}`; anything unparsable throws `onInvalid()`. */
export async function readJsonBody(response: Response, onInvalid: () => Error): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw onInvalid();
  }
}
