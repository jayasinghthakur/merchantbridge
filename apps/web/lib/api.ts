import type {
  ApiErrorResponse,
  ExplorerCallRequest,
  ExplorerCallResponse,
  StatusResponse,
  ToolsResponse,
} from '@mb/core/http';
import { API_ROUTES } from '@mb/core/http';
import type { PlaygroundRequest, TraceEvent } from '@mb/core/telemetry';
import { API_BASE_URL } from './config';
import { SseParser } from './sse';

export type ApiErrorKind = 'timeout' | 'network' | 'http' | 'parse' | 'aborted';

/** Every failure of the API client surfaces as this type, so UI code can switch on `kind` / `code`. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  /** Server error code from an ApiErrorResponse body, when present. */
  readonly code: string | null;
  readonly retryAfterS: number | null;

  constructor(
    kind: ApiErrorKind,
    message: string,
    opts: { status?: number; code?: string; retryAfterS?: number } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
    this.retryAfterS = opts.retryAfterS ?? null;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

const DEFAULT_TIMEOUT_MS = 10_000;

interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Combines the caller's signal with a timeout, remembering which one fired. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const arm = (ms: number) =>
    setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
  let timer = arm(timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    /** Restarts the timer (used as an idle timeout while a stream is flowing). */
    touch(ms: number) {
      clearTimeout(timer);
      timer = arm(ms);
    },
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function isApiErrorBody(v: unknown): v is ApiErrorResponse {
  if (typeof v !== 'object' || v === null) return false;
  const err = (v as { error?: unknown }).error;
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string' &&
    typeof (err as { message?: unknown }).message === 'string'
  );
}

async function errorFromResponse(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON error page (proxy, platform); fall through to a generic message.
  }
  const header = Number(res.headers.get('retry-after'));
  const headerRetry = Number.isFinite(header) && header > 0 ? header : undefined;
  if (isApiErrorBody(body)) {
    return new ApiError('http', body.error.message, {
      status: res.status,
      code: body.error.code,
      retryAfterS: body.error.retry_after_s ?? headerRetry,
    });
  }
  return new ApiError('http', `The API answered ${res.status} ${res.statusText}`.trim(), {
    status: res.status,
    retryAfterS: headerRetry,
  });
}

function translateFetchError(e: unknown, timedOut: boolean, callerSignal?: AbortSignal): ApiError {
  if (isApiError(e)) return e;
  if (timedOut) return new ApiError('timeout', 'The API did not answer in time.');
  if (callerSignal?.aborted) return new ApiError('aborted', 'Request cancelled.');
  return new ApiError('network', 'Could not reach the MerchantBridge API.');
}

async function requestJson<T>(
  path: string,
  init: RequestInit,
  opts: RequestOptions = {},
): Promise<T> {
  const t = withTimeout(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl(path), {
      ...init,
      headers: { accept: 'application/json', ...init.headers },
      signal: t.signal,
    });
    if (!res.ok) throw await errorFromResponse(res);
    try {
      return (await res.json()) as T;
    } catch {
      throw new ApiError('parse', 'The API returned a response that is not valid JSON.', {
        status: res.status,
      });
    }
  } catch (e) {
    throw translateFetchError(e, t.timedOut(), opts.signal);
  } finally {
    t.cleanup();
  }
}

export function getStatus(opts?: RequestOptions): Promise<StatusResponse> {
  return requestJson<StatusResponse>(API_ROUTES.status, { method: 'GET' }, opts);
}

export function getTools(opts?: RequestOptions): Promise<ToolsResponse> {
  return requestJson<ToolsResponse>(API_ROUTES.tools, { method: 'GET' }, opts);
}

export function callExplorer(
  req: ExplorerCallRequest,
  opts?: RequestOptions,
): Promise<ExplorerCallResponse> {
  return requestJson<ExplorerCallResponse>(
    API_ROUTES.explorerCall,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) },
    { timeoutMs: 30_000, ...opts },
  );
}

const TRACE_TYPES = new Set<TraceEvent['type']>([
  'session',
  'assistant_text',
  'tool_call',
  'tool_result',
  'done',
  'error',
]);

/** Parses one SSE data payload; returns null for anything that is not a known TraceEvent. */
export function parseTraceEvent(data: string): TraceEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const type = (v as { type?: unknown }).type;
  if (typeof type !== 'string' || !TRACE_TYPES.has(type as TraceEvent['type'])) return null;
  return v as TraceEvent;
}

export interface StreamOptions {
  signal?: AbortSignal;
  onEvent: (event: TraceEvent) => void;
  /** Time allowed for the response headers. */
  connectTimeoutMs?: number;
  /** Max silence between chunks; the server sends a ':' heartbeat every 15 s. */
  idleTimeoutMs?: number;
}

/**
 * POSTs a PlaygroundRequest and dispatches each `data: <TraceEvent JSON>` frame. EventSource cannot POST, so this
 * reads the body with fetch + ReadableStream. Resolves when the stream ends; rejects with ApiError on failure.
 * Non-2xx responses with an ApiErrorResponse body are converted into a synthetic `error` TraceEvent so the UI has
 * one error path (PLAYGROUND_DISABLED, RATE_LIMITED, BUDGET_EXHAUSTED...).
 */
export async function streamPlayground(req: PlaygroundRequest, opts: StreamOptions): Promise<void> {
  const connectMs = opts.connectTimeoutMs ?? 20_000;
  const idleMs = opts.idleTimeoutMs ?? 45_000;
  const t = withTimeout(opts.signal, connectMs);
  try {
    const res = await fetch(apiUrl(API_ROUTES.playground), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(req),
      signal: t.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      const err = await errorFromResponse(res);
      const code = toTraceErrorCode(err.code, res.status);
      opts.onEvent({
        type: 'error',
        code,
        message: err.message,
        ...(err.retryAfterS === null ? {} : { retry_after_s: err.retryAfterS }),
      });
      return;
    }
    if (!res.body) throw new ApiError('parse', 'The API returned an empty stream.');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    const dispatch = (payloads: string[]) => {
      for (const p of payloads) {
        const ev = parseTraceEvent(p);
        if (ev) opts.onEvent(ev);
      }
    };
    t.touch(idleMs);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      t.touch(idleMs);
      dispatch(parser.push(decoder.decode(value, { stream: true })));
    }
    dispatch(parser.push(decoder.decode()));
    dispatch(parser.flush());
  } catch (e) {
    throw translateFetchError(e, t.timedOut(), opts.signal);
  } finally {
    t.cleanup();
  }
}

type TraceErrorCode = Extract<TraceEvent, { type: 'error' }>['code'];

const TRACE_ERROR_CODES: readonly TraceErrorCode[] = [
  'PLAYGROUND_DISABLED',
  'RATE_LIMITED',
  'BUDGET_EXHAUSTED',
  'BAD_REQUEST',
  'INTERNAL',
];

function toTraceErrorCode(code: string | null, status: number): TraceErrorCode {
  if (code && (TRACE_ERROR_CODES as readonly string[]).includes(code))
    return code as TraceErrorCode;
  if (status === 429) return 'RATE_LIMITED';
  if (status === 400 || status === 403 || status === 422) return 'BAD_REQUEST';
  return 'INTERNAL';
}

export function describeApiError(e: unknown): string {
  if (!isApiError(e)) return 'Something went wrong.';
  switch (e.kind) {
    case 'timeout':
      return 'The API took too long to answer. Try again in a moment.';
    case 'network':
      return 'Could not reach the MerchantBridge API. It may be restarting; try again shortly.';
    case 'parse':
      return 'The API sent a response this page could not read.';
    case 'aborted':
      return 'Request cancelled.';
    case 'http':
      return e.message;
  }
}
