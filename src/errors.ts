import { isRecord } from './parse.js';

export type HealthErrorKind = 'missing_scope' | 'not_linked' | 'login_due' | 'no_token' | 'http';

/** Kinds that mean the account needs login or linking, so every later call would fail the same way. */
const AUTH_STOP_KINDS: ReadonlySet<HealthErrorKind> = new Set(['not_linked', 'no_token', 'login_due']);

/** An expected Health API or token failure. Its message is safe to show the model. */
export class HealthCallError extends Error {
  readonly kind: HealthErrorKind;
  readonly status: number | undefined;

  constructor(kind: HealthErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'HealthCallError';
    this.kind = kind;
    this.status = status;
  }

  get stopsAllReads(): boolean {
    return AUTH_STOP_KINDS.has(this.kind);
  }
}

/** A gap in a result: a whole series (no date), a whole day (no series), or one series on one day. */
export type Missing = {
  date?: string;
  series?: string;
  reason: string;
};

/** Returns an expected HealthCallError and rethrows anything else, so bugs are never reported as missing data. */
export function expectHealthError(error: unknown): HealthCallError {
  if (error instanceof HealthCallError) return error;
  throw error;
}

/** The message of an Error, or `fallback` for anything else that was thrown. */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** OAuth and Health error payloads use different shapes. This reads either reason. */
export function findReason(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const error = body.error;
  if (typeof error === 'string') return error;
  if (!isRecord(error)) return undefined;
  const details = error.details;
  if (!Array.isArray(details)) return undefined;
  for (const detail of details) {
    if (isRecord(detail) && typeof detail.reason === 'string') return detail.reason;
  }
  return undefined;
}

export function errorStatusName(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  return typeof body.error.status === 'string' ? body.error.status : undefined;
}

/** Replaces each known secret with [redacted] and caps the length, before text can reach a log or the model. */
export function sanitizeText(text: string, secrets: string[]): string {
  let cleaned = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    cleaned = cleaned.split(secret).join('[redacted]');
  }
  return cleaned.slice(0, 300);
}
