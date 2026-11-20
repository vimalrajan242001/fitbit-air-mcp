const FORBIDDEN_KEYS = new Set([
  'macAddress',
  'mac_address',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'clientSecret',
  'client_secret',
  'clientId',
  'client_id',
  'idToken',
  'id_token',
  'authorization',
  'codeVerifier',
  'code_verifier',
]);

/** Drops credential and hardware-address keys before a tool result is returned. */
export function redact<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => walk(entry));
  if (!value || typeof value !== 'object') return value;
  const cleaned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    cleaned[key] = walk(entry);
  }
  return cleaned;
}

export function textResult(value: unknown): { content: [{ type: 'text'; text: string }] } {
  return {
    content: [{ type: 'text', text: JSON.stringify(redact(value), null, 2) }],
  };
}
