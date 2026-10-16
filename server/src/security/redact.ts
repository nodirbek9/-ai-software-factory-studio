const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /((?:api[_-]?key|token|secret|password|passwd)\s*[=:]\s*)["']?[^\s"']{6,}/gi,
];

const knownSecrets = new Set<string>();

/** Registers literal secret values (e.g. configured API keys) so they are always masked. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6) knownSecrets.add(value);
}

export function redact(text: string): string {
  let result = text;
  for (const secret of knownSecrets) result = result.split(secret).join('[REDACTED]');
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, prefix?: string) =>
      typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}[REDACTED]` : '[REDACTED]');
  }
  return result;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  }
  return value;
}
