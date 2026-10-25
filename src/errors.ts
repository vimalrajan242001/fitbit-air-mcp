export type HealthErrorKind = 'missing_scope' | 'not_linked' | 'login_due' | 'no_token' | 'http';

export class HealthCallError extends Error {
  readonly kind: HealthErrorKind;
  readonly status: number | undefined;

  constructor(kind: HealthErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'HealthCallError';
    this.kind = kind;
    this.status = status;
  }
}

export type Missing = {
  date?: string;
  series?: string;
  reason: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

export function sanitizeText(text: string, secrets: string[]): string {
  let cleaned = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    cleaned = cleaned.split(secret).join('[redacted]');
  }
  return cleaned.slice(0, 300);
}
