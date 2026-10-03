/**
 * Errors from an OpenAI-compatible Chat Completions provider (Groq, Gemini's OpenAI endpoint, OpenRouter,
 * Ollama, …). Messages never carry the API key: bodies are scrubbed and auth failures keep no body at all.
 */

export type LlmErrorKind =
  /** HTTP error response from the provider. */
  | 'http'
  /** No response: DNS, connection reset, timeout. */
  | 'network'
  /** 2xx with a body that is not a usable chat completion. */
  | 'bad_response';

/** Key-shaped tokens (sk-…, sk-ant-…, gsk_…, sk-or-…, AIza…) and bearer values are replaced before keeping text. */
const KEYLIKE_RE =
  /\b(?:sk|gsk|rk|pk|sk-ant|sk-or|xai)[-_][A-Za-z0-9_*.-]{6,}|\bAIza[A-Za-z0-9_-]{10,}/g;
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi;

export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s.length >= 6) out = out.split(s).join('[redacted]');
  return out.replace(KEYLIKE_RE, '[redacted]').replace(BEARER_RE, '$1 [redacted]');
}

export class LlmProviderError extends Error {
  override readonly name = 'LlmProviderError';
  readonly kind: LlmErrorKind;
  /** HTTP status, or 0 when there was no response. */
  readonly status: number;
  readonly headers: Headers;
  /** Scrubbed, truncated response body (empty for 401/403). */
  readonly body: string;

  constructor(init: {
    kind: LlmErrorKind;
    status?: number;
    headers?: Headers;
    body?: string;
    message: string;
    cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.kind = init.kind;
    this.status = init.status ?? 0;
    this.headers = init.headers ?? new Headers();
    this.body = init.body ?? '';
  }
}

/** "7.66s", "2m59.56s", "1h2m3s", "120ms", "6m0s" (OpenAI/Groq x-ratelimit-reset-*) → seconds. */
export function parseResetDuration(raw: string | null): number | null {
  if (!raw) return null;
  const v = raw.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = '';
  for (const m of v.matchAll(re)) {
    const n = Number(m[1]);
    const unit = m[2];
    total += unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : unit === 's' ? n : n / 1000;
    matched += m[0];
  }
  return matched === v && matched !== '' ? total : null;
}

/** Seconds to wait before retrying, from Retry-After or the x-ratelimit-reset-* headers. */
export function retryAfterSeconds(headers: Headers): number | null {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const n = Number(retryAfter);
    if (Number.isFinite(n) && n >= 0) return n;
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, (at - Date.now()) / 1000);
  }
  const tokens = parseResetDuration(headers.get('x-ratelimit-reset-tokens'));
  const requests = parseResetDuration(headers.get('x-ratelimit-reset-requests'));
  // Prefer the window that is actually exhausted; otherwise the sooner one.
  const exhausted = [
    headers.get('x-ratelimit-remaining-tokens') === '0' ? tokens : null,
    headers.get('x-ratelimit-remaining-requests') === '0' ? requests : null,
  ].filter((x): x is number => x !== null);
  if (exhausted.length > 0) return Math.max(...exhausted);
  const any = [tokens, requests].filter((x): x is number => x !== null);
  return any.length > 0 ? Math.min(...any) : null;
}

/**
 * Seconds to wait from the body when no header says: Groq's "Please try again in 7.66s." / "in 1m30.5s." and
 * Gemini's RetryInfo `"retryDelay": "17s"`.
 */
export function retryAfterFromBody(body: string): number | null {
  const groq = /try again in ((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/i.exec(body);
  if (groq?.[1]) return parseResetDuration(groq[1]);
  const gemini = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return gemini?.[1] ? Number(gemini[1]) : null;
}

/** Retry-After / x-ratelimit-reset-* headers, else the hint in the (scrubbed) body. */
export function llmRetryAfterSeconds(e: LlmProviderError): number | null {
  return retryAfterSeconds(e.headers) ?? retryAfterFromBody(e.body);
}

// Deliberately no bare "billing": Groq's per-minute 429 links to /settings/billing ("Need more tokens? Upgrade…").
const QUOTA_RE =
  /insufficient[_ ]quota|exceeded your current quota|quota (?:has been )?exceeded|out of credits|insufficient credits|\bper day\b|PerDay|\((?:TPD|RPD)\)|daily limit/i;
// Gemini says "You exceeded your current quota" for per-minute limits too; its quota id then names the minute.
const PER_MINUTE_RE = /per[ _-]?minute|PerMinute|\((?:TPM|RPM)\)/i;

/**
 * The provider's free quota or credits are used up (per day, or no credits), as opposed to a short per-minute
 * rate limit, which stays RATE_LIMITED with a retry_after_s.
 */
export function isQuotaExhausted(e: LlmProviderError): boolean {
  if (e.kind !== 'http') return false;
  if (e.status === 402) return true;
  if (e.status !== 429 && e.status !== 403 && e.status !== 400) return false;
  return QUOTA_RE.test(e.body) && !PER_MINUTE_RE.test(e.body);
}

export function isAuthRejected(e: LlmProviderError): boolean {
  return e.kind === 'http' && (e.status === 401 || e.status === 403) && !isQuotaExhausted(e);
}
