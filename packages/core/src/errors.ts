export const ERROR_CODES = [
  'INVALID_INPUT',
  'NOT_FOUND',
  'RATE_LIMITED',
  'DAILY_QUOTA_EXHAUSTED',
  'RECONNECT_REQUIRED',
  'SCOPE_NOT_GRANTED',
  'UPSTREAM_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ToolErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    retry_after_s?: number;
    hint?: string;
  };
}

export interface ConnectorErrorOptions {
  retryable?: boolean;
  retryAfterS?: number;
  hint?: string;
  cause?: unknown;
}

const DEFAULT_RETRYABLE: Record<ErrorCode, boolean> = {
  INVALID_INPUT: false,
  NOT_FOUND: false,
  RATE_LIMITED: true,
  DAILY_QUOTA_EXHAUSTED: false,
  RECONNECT_REQUIRED: false,
  SCOPE_NOT_GRANTED: false,
  UPSTREAM_ERROR: true,
};

/**
 * The only error type that may cross into an agent-visible result. `message` and `hint` must be safe to show
 * to an LLM: no tokens, URLs with credentials, stack traces or raw upstream bodies.
 */
export class ConnectorError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAfterS: number | undefined;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, opts: ConnectorErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ConnectorError';
    this.code = code;
    this.retryable = opts.retryable ?? DEFAULT_RETRYABLE[code];
    this.retryAfterS = opts.retryAfterS;
    this.hint = opts.hint;
  }

  toBody(): ToolErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.retryAfterS === undefined ? {} : { retry_after_s: this.retryAfterS }),
        ...(this.hint === undefined ? {} : { hint: this.hint }),
      },
    };
  }
}

export function isConnectorError(e: unknown): e is ConnectorError {
  return e instanceof ConnectorError;
}

/**
 * Classified upstream failure that the governor may retry. Thrown by connector clients (never shown to agents);
 * the governor converts exhausted retries into a ConnectorError.
 */
export type UpstreamFailure =
  | { kind: 'rate_limit_minute' } // Zoho 429 code 44 — org blocked
  | { kind: 'rate_limit_daily' } // Zoho 429 code 45 — never retried
  | { kind: 'concurrency' } // Zoho 429 code 1070
  | { kind: 'server'; status: number } // 5xx
  | { kind: 'timeout' }
  | { kind: 'network' };

export class UpstreamError extends Error {
  readonly failure: UpstreamFailure;
  /** Seconds from a Retry-After header, if the upstream sent one. */
  readonly retryAfterS: number | undefined;

  constructor(failure: UpstreamFailure, message: string, retryAfterS?: number) {
    super(message);
    this.name = 'UpstreamError';
    this.failure = failure;
    this.retryAfterS = retryAfterS;
  }
}

export function isUpstreamError(e: unknown): e is UpstreamError {
  return e instanceof UpstreamError;
}
