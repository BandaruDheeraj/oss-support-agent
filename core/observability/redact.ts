/**
 * Redaction layer.
 */

const KNOWN_SECRET_NAMES = [
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'ARIZE_API_KEY',
  'BRAINTRUST_API_KEY',
  'WEBHOOK_SECRET',
  'HITL_SIGNING_KEY',
  'GOOGLE_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
];

const KEY_SHAPES: RegExp[] = [
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /ghs_[A-Za-z0-9]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bre_[A-Za-z0-9_-]{20,}/g,
  /whsec_[A-Za-z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /ya29\.[0-9A-Za-z_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

const URL_WITH_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi;
const HEADER_LINE = /\b(authorization|x-api-key|x-token|cookie|set-cookie)\s*:\s*([^\r\n]+)/gi;

function namedSecretRegex(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b\\s*[=:]\\s*"?([^"\\s,;]+)"?`, 'g');
}

const KNOWN_SECRET_REGEXES: RegExp[] = KNOWN_SECRET_NAMES.map(namedSecretRegex);

let _denylistCache: string[] | null = null;
function denylistFromEnv(): string[] {
  if (_denylistCache !== null) return _denylistCache;
  const raw = process.env.REDACT_DENY;
  _denylistCache = !raw ? [] : raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return _denylistCache;
}

const cache = new Map<string, string>();
function placeholderFor(category: string, original: string): string {
  const key = `${category}:${original}`;
  let placeholder = cache.get(key);
  if (placeholder) return placeholder;
  const idx = cache.size + 1;
  placeholder = `<REDACTED:${category}:${idx}>`;
  cache.set(key, placeholder);
  return placeholder;
}

export function redactString(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  let out = input;
  out = out.replace(URL_WITH_USERINFO, (_, scheme) => `${scheme}<REDACTED:URL_CRED>@`);
  out = out.replace(HEADER_LINE, (_m, name) => `${name}: <REDACTED:HEADER>`);
  for (let i = 0; i < KNOWN_SECRET_NAMES.length; i++) {
    out = out.replace(KNOWN_SECRET_REGEXES[i], (_match: string, value: string) => {
      return _match.replace(value, placeholderFor(KNOWN_SECRET_NAMES[i], value));
    });
  }
  for (const re of KEY_SHAPES) {
    out = out.replace(re, (m) => placeholderFor('KEY', m));
  }
  const denylist = denylistFromEnv();
  for (const term of denylist) {
    if (term.length < 4) continue;
    const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(safe, 'g'), placeholderFor('DENY', term));
  }
  return out;
}

export function redactValue<T>(v: T): T {
  if (v == null) return v;
  if (typeof v === 'string') return redactString(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => redactValue(x)) as unknown as T;
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const looksSensitive = /token|secret|key|password|authorization|api[_-]?key/i.test(k);
      if (looksSensitive && typeof val === 'string') {
        out[k] = val.length === 0 ? val : placeholderFor('FIELD', val);
      } else {
        out[k] = redactValue(val);
      }
    }
    return out as unknown as T;
  }
  return v;
}

export function _resetRedactCache(): void {
  cache.clear();
  _denylistCache = null;
}
