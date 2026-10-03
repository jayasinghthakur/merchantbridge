import { createHash } from 'node:crypto';
import type { Page } from '@mb/core';
import {
  ConnectorError,
  MAX_RESULT_TOKENS,
  createToolFactory,
  decodeCursor,
  encodeCursor,
  estimateTokens,
  isConnectorError,
} from '@mb/core';
import { z } from 'zod';
import type { ZohoApi } from '../client';
import { isoDate } from '../mappers';
import type { UpstreamSalesOrder } from '../upstream';
import { envelopes, parseUpstream } from '../upstream';

export const defineTool = createToolFactory<ZohoApi>();

export const ITEMS_TTL_MS = 60_000;
export const ORG_TTL_MS = 300_000;
export const READ_ONLY = 'Read-only: cannot create, change or delete anything in Zoho.';

// ---------- input building blocks ----------

const ID_RE = /^[0-9A-Za-z_-]{1,64}$/;

export const idInput = (what: string) =>
  z
    .string()
    .regex(ID_RE, `${what} must be an id exactly as returned by another tool`)
    .describe(`${what}, exactly as returned by another tool.`);

export const limitInput = z
  .number()
  .int()
  .min(1)
  .max(100)
  .default(20)
  .describe(
    'Maximum results to return (1-100, default 20). A page may hold fewer to stay within the result ' +
      'size limit; keep following next_cursor while has_more is true.',
  );

export const cursorInput = z
  .string()
  .min(1)
  .max(512)
  .optional()
  .describe(
    'next_cursor from the previous call of this tool with the same filters; omit for the first page.',
  );

export const dateInput = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
    .refine((s) => {
      // Date.parse rolls 2026-02-30 over to March, so compare the round-trip instead.
      const t = Date.parse(`${s}T00:00:00Z`);
      return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
    }, 'not a real calendar date')
    .describe(`${what} (YYYY-MM-DD, inclusive).`);

export const searchText = (what: string) => z.string().trim().min(1).max(100).describe(what);

/** Exactly-one-of guard for get_* tools that accept an id or a human-readable number. */
export function exactlyOne<K extends string>(keys: readonly K[]) {
  return (v: Partial<Record<K, unknown>>): boolean =>
    keys.filter((k) => v[k] !== undefined).length === 1;
}

// ---------- pagination ----------

/** Short, stable fingerprint of a tool's filters, so a cursor cannot be replayed against a different query. */
export function fingerprint(filters: Record<string, unknown>): string {
  const stable = JSON.stringify(Object.entries(filters).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(stable).digest('base64url').slice(0, 12);
}

const mismatch = (): ConnectorError =>
  new ConnectorError('INVALID_INPUT', 'The cursor belongs to a different query.', {
    hint: 'Pass next_cursor only with the same filters it was returned for, or omit it to start over.',
  });

/** Rows of one result get this many tokens; the rest of MAX_RESULT_TOKENS is headroom for meta/page/scan. */
export const ROWS_TOKEN_BUDGET = MAX_RESULT_TOKENS - 1_000;

/**
 * How many leading rows fit the token budget (at least one, so paging always progresses). Long names at
 * limit 100 would otherwise push a page past MAX_RESULT_TOKENS and the whole call would fail.
 */
export function rowsWithinBudget(rows: readonly unknown[], budget = ROWS_TOKEN_BUDGET): number {
  let used = 0;
  for (const [i, row] of rows.entries()) {
    used += estimateTokens(row) + 1; // +1 covers the separating comma
    if (used > budget) return Math.max(1, i);
  }
  return rows.length;
}

export interface UpstreamPage {
  page: number;
  perPage: number;
  /** Rows of `page` already returned, when an earlier call trimmed the page to the token budget. */
  skip: number;
  fp: string;
}

const isCount = (v: unknown, min: number): v is number =>
  Number.isInteger(v) && (v as number) >= min;

export function readPageCursor(
  cursor: string | undefined,
  limit: number,
  fp: string,
): UpstreamPage {
  if (cursor === undefined) return { page: 1, perPage: limit, skip: 0, fp };
  const c = decodeCursor<{ p?: unknown; n?: unknown; s?: unknown; f?: unknown }>(cursor);
  if (c.f !== fp) throw mismatch();
  const skip = c.s ?? 0;
  if (!isCount(c.p, 1) || !isCount(c.n, 1) || c.n > 100 || !isCount(skip, 0) || skip >= c.n)
    throw mismatch();
  return { page: c.p, perPage: c.n, skip, fp };
}

export function upstreamPage(state: UpstreamPage, hasMore: boolean): Page {
  return {
    has_more: hasMore,
    next_cursor: hasMore
      ? encodeCursor({ p: state.page + 1, n: state.perPage, f: state.fp })
      : null,
  };
}

/**
 * The rows of one upstream page that this call returns: those after `state.skip` that fit the token budget.
 * When the page is trimmed, the next cursor resumes inside the same upstream page.
 */
export function pageRows<T>(
  state: UpstreamPage,
  rows: readonly T[],
  upstreamHasMore: boolean,
): { rows: T[]; page: Page } {
  const rest = rows.slice(state.skip);
  const taken = rest.slice(0, rowsWithinBudget(rest));
  const returned = state.skip + taken.length;
  if (returned < rows.length) {
    const next = { p: state.page, n: state.perPage, s: returned, f: state.fp };
    return { rows: taken, page: { has_more: true, next_cursor: encodeCursor(next) } };
  }
  return { rows: taken, page: upstreamPage(state, upstreamHasMore) };
}

/** For results computed client-side (bounded scans): the cursor is an offset into the filtered list. */
export function readOffsetCursor(cursor: string | undefined, fp: string): number {
  if (cursor === undefined) return 0;
  const c = decodeCursor<{ o?: unknown; f?: unknown }>(cursor);
  if (c.f !== fp || !isCount(c.o, 0)) throw mismatch();
  return c.o;
}

/** `returned` is how many rows this call returned (≤ limit when trimmed to the token budget). */
export function offsetPage(offset: number, returned: number, total: number, fp: string): Page {
  const hasMore = offset + returned < total;
  return {
    has_more: hasMore,
    next_cursor: hasMore ? encodeCursor({ o: offset + returned, f: fp }) : null,
  };
}

// ---------- shared upstream reads ----------

export async function orgCurrency(client: ZohoApi): Promise<string | null> {
  const res = await client.get(`organizations/${client.organizationId}`, undefined, {
    cacheTtlMs: ORG_TTL_MS,
  });
  return parseUpstream(envelopes.organization, res.body).organization.currency_code;
}

/** Re-labels a generic NOT_FOUND with a message naming what was looked up (ids are validated safe tokens). */
export async function namedNotFound<T>(work: Promise<T>, message: string): Promise<T> {
  try {
    return await work;
  } catch (e) {
    if (isConnectorError(e) && e.code === 'NOT_FOUND') {
      throw new ConnectorError('NOT_FOUND', message, { hint: e.hint });
    }
    throw e;
  }
}

/**
 * Bounded scan for endpoints without documented filters: the first 3 pages × 200 = 600 records Zoho returns.
 * salesorders.yml documents no sort parameter (only page/per_page) and no default order, so "the first 600" are
 * the most recent only if Zoho lists newest first (UNVERIFIED, probe P-16): every scan checks the order it got.
 */
export const SCAN_MAX_PAGES = 3;
export const SCAN_PAGE_SIZE = 200;

export interface SalesOrderScan {
  rows: UpstreamSalesOrder[];
  /** True when the scan reached the last upstream page (no further records left unchecked). */
  complete: boolean;
  /** True when the scanned rows' dates never increase, across page boundaries (i.e. they came newest first). */
  orderVerified: boolean;
}

/** True when the ISO dates never increase (newest first); rows without a readable date are skipped. */
export function datesNonIncreasing(dates: readonly (string | null)[]): boolean {
  let previous: string | null = null;
  for (const raw of dates) {
    const day = isoDate(raw);
    if (day === null) continue;
    if (previous !== null && day > previous) return false;
    previous = day;
  }
  return true;
}

export async function scanSalesOrders(
  client: ZohoApi,
  query: Record<string, string>,
  stop?: (batch: UpstreamSalesOrder[]) => boolean,
): Promise<SalesOrderScan> {
  const rows: UpstreamSalesOrder[] = [];
  const done = (complete: boolean): SalesOrderScan => ({
    rows,
    complete,
    orderVerified: datesNonIncreasing(rows.map((r) => r.date)),
  });
  for (let page = 1; page <= SCAN_MAX_PAGES; page++) {
    const res = await client.get('salesorders', { ...query, page, per_page: SCAN_PAGE_SIZE });
    const body = parseUpstream(envelopes.salesorders, res.body);
    rows.push(...body.salesorders);
    if (!body.page_context.has_more_page) return done(true);
    if (stop?.(body.salesorders)) return done(false);
  }
  return done(false);
}
