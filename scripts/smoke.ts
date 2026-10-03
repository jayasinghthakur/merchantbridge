// Human-run probes against a real Zoho Inventory org through the DEV OAuth client: `! pnpm smoke`.
// Never run by Claude Code, tests or CI (the PreToolUse guard blocks it). Every probe is a GET; the only other
// request is one token refresh. Prints a sanitized markdown table and writes docs/adr/smoke-results.md, whose
// observations go into ADR-0001. Probe ids (P-n) refer to docs/notes/zoho.md section 9.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_PATH = resolve(ROOT, 'docs/adr/smoke-results.md');
/** ~85 requests/min at most: Zoho blocks the whole org at 100/min (code 44). */
const REQUEST_GAP_MS = 700;
const TIMEOUT_MS = 15_000;
const PAGE = '200';

/** Accounts server per data center (docs/vendor/zoho/accounts/acc_oauth_multi-dc.txt). */
const ACCOUNTS_SERVERS: Readonly<Record<string, string>> = {
  us: 'https://accounts.zoho.com',
  eu: 'https://accounts.zoho.eu',
  in: 'https://accounts.zoho.in',
  au: 'https://accounts.zoho.com.au',
  jp: 'https://accounts.zoho.jp',
  ca: 'https://accounts.zohocloud.ca',
  sa: 'https://accounts.zoho.sa',
  uk: 'https://accounts.zoho.uk',
};
// UNVERIFIED (P-1): the serverinfo JSON shape is not vendored; the probe records it.
const SERVERINFO_URL = 'https://accounts.zoho.com/oauth/serverinfo';
const RAZORPAY_ID = /\b(pay|order|rfnd)_[A-Za-z0-9]{6,}/;

type Json = Record<string, unknown>;
type Params = Record<string, string>;
type Predicate = (row: Json) => boolean;

interface Config {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  dc: string;
  orgId: string;
}

interface HttpResult {
  /** 0 when no HTTP response arrived (network error or timeout). */
  status: number;
  /** Zoho body `code` (0 = success), when the body has one. */
  code: number | null;
  body: Json | null;
  headers: Headers | null;
  error: string | null;
}

interface ListResult extends HttpResult {
  key: string | null;
  records: Json[];
  pageContext: Json | null;
  hasMore: boolean | null;
}

interface Row {
  probe: string;
  status: number | null;
  code: number | null;
  verdict: string;
}

interface Ctx {
  origin: URL;
  token: string;
  orgId: string;
}

// ---------- redaction ----------

const secrets = new Set<string>();

function remember(value: string): void {
  if (value.length >= 4) secrets.add(value);
}

/** Applied to everything printed or written: known secret values, token-shaped strings, emails. */
function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('[redacted]');
  return out
    .replace(/\b1000\.[A-Za-z0-9.]{16,}/g, '[redacted-token]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]');
}

// ---------- config ----------

function loadDotEnv(): void {
  const path = resolve(ROOT, '.env');
  // Same parser as `node --env-file`; variables already set in the shell win. Values are never printed.
  if (existsSync(path)) process.loadEnvFile(path);
}

function readConfig(): Config | { missing: string[] } {
  const names = [
    'ZOHO_DEV_CLIENT_ID',
    'ZOHO_DEV_CLIENT_SECRET',
    'ZOHO_DEV_REFRESH_TOKEN',
    'ZOHO_DEV_ORG_ID',
  ] as const;
  const missing = names.filter((n) => !process.env[n]?.trim());
  if (missing.length > 0) return { missing };
  const env = (n: (typeof names)[number]): string => process.env[n]?.trim() ?? '';
  return {
    clientId: env('ZOHO_DEV_CLIENT_ID'),
    clientSecret: env('ZOHO_DEV_CLIENT_SECRET'),
    refreshToken: env('ZOHO_DEV_REFRESH_TOKEN'),
    orgId: env('ZOHO_DEV_ORG_ID'),
    dc: (process.env.ZOHO_DEV_DC?.trim() || 'in').toLowerCase(),
  };
}

// ---------- http ----------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseObject(text: string): Json | null {
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

async function send(url: URL, init: RequestInit): Promise<HttpResult> {
  const wait = lastRequestAt + REQUEST_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  try {
    // redirect: 'manual' so a token is never replayed to another host.
    const res = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = parseObject(await res.text());
    const code = body !== null && typeof body.code === 'number' ? body.code : null;
    return { status: res.status, code, body, headers: res.headers, error: null };
  } catch (e) {
    const name = e instanceof Error ? e.name : 'Error';
    const error = name === 'TimeoutError' ? 'timeout' : `network error (${name})`;
    return { status: 0, code: null, body: null, headers: null, error };
  }
}

/** Only an https Zoho host may receive the access token, whatever `api_domain` says. */
function zohoOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    const zohoHost = /(^|\.)zoho[a-z]*\.(com|eu|in|com\.au|jp|ca|sa|uk|com\.cn)$/;
    return url.protocol === 'https:' && zohoHost.test(url.hostname) ? new URL(url.origin) : null;
  } catch {
    return null;
  }
}

/** GET `{api_domain}/inventory/v1/{path}`; `organization_id` on every call unless `org` is null. */
function apiGet(
  ctx: Ctx,
  path: string,
  params: Params = {},
  org: string | null = ctx.orgId,
  token: string = ctx.token,
): Promise<HttpResult> {
  const url = new URL(`/inventory/v1/${path}`, ctx.origin);
  if (org !== null) url.searchParams.set('organization_id', org);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return send(url, { method: 'GET', headers: { Authorization: `Zoho-oauthtoken ${token}` } });
}

async function apiList(
  ctx: Ctx,
  path: string,
  keys: string[],
  params: Params = {},
): Promise<ListResult> {
  const res = await apiGet(ctx, path, { per_page: PAGE, ...params });
  let key: string | null = null;
  let records: Json[] = [];
  for (const k of keys) {
    const v = res.body?.[k];
    if (Array.isArray(v)) {
      key = k;
      records = v.filter(isObject);
      break;
    }
  }
  const pc = res.body?.page_context;
  const pageContext = isObject(pc) ? pc : null;
  const hasMore =
    typeof pageContext?.has_more_page === 'boolean' ? pageContext.has_more_page : null;
  return { ...res, key, records, pageContext, hasMore };
}

const ok = (r: HttpResult): boolean => r.status === 200 && r.code === 0;

function describeError(r: HttpResult): string {
  if (r.error) return r.error;
  const msg = typeof r.body?.message === 'string' ? `: ${r.body.message.slice(0, 90)}` : '';
  return `http ${r.status}${r.code === null ? '' : `, code ${r.code}`}${msg}`;
}

function row(probe: string, r: HttpResult | null, verdict: string): Row {
  return { probe, status: r ? r.status : null, code: r ? r.code : null, verdict };
}

// ---------- record helpers ----------

function str(r: Json, field: string): string | null {
  const v = r[field];
  if (typeof v === 'string' && v.trim() !== '') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** The least frequent non-empty value of `field`: the most selective sample for a filter probe. */
function rarest(records: Json[], field: string): string | null {
  const counts = new Map<string, number>();
  for (const r of records) {
    const v = str(r, field);
    if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = Number.POSITIVE_INFINITY;
  for (const [v, n] of counts) {
    if (n < bestCount) {
      best = v;
      bestCount = n;
    }
  }
  return best;
}

const eq =
  (field: string) =>
  (sample: string): Predicate =>
  (r) =>
    str(r, field) === sample;

const contains =
  (field: string) =>
  (sample: string): Predicate =>
  (r) =>
    (str(r, field) ?? '').toLowerCase().includes(sample.toLowerCase());

/** search_text may match any text field, so any string value containing the sample counts. */
const anyText =
  () =>
  (sample: string): Predicate =>
  (r) =>
    Object.values(r).some(
      (v) => typeof v === 'string' && v.toLowerCase().includes(sample.toLowerCase()),
    );

function listSummary(r: ListResult): string {
  const pc = r.pageContext
    ? `page_context per_page=${String(r.pageContext.per_page)} has_more_page=${String(r.hasMore)}`
    : 'page_context ABSENT';
  return `${r.records.length}${r.hasMore ? '+' : ''} rows under "${r.key ?? 'no list key'}"; ${pc}`;
}

function dateOrder(records: Json[], field: string): string {
  const dates = records.map((r) => str(r, field)).filter((d): d is string => d !== null);
  if (dates.length < 2) return 'order unknown (<2 dated rows)';
  const desc = dates.every((d, i) => i === 0 || (dates[i - 1] ?? d) >= d);
  const asc = dates.every((d, i) => i === 0 || (dates[i - 1] ?? d) <= d);
  return desc && !asc
    ? 'newest first'
    : asc && !desc
      ? 'oldest first'
      : desc
        ? 'all same date'
        : 'unordered';
}

// ---------- filter probes ----------

interface FilterProbe {
  /** Shown in the table; parameter names only, never the sample value. */
  label: string;
  /** Field of the unfiltered rows to take the sample from; omitted for fixed-value filters. */
  field?: string;
  params(sample: string): Params;
  match: ((sample: string) => Predicate) | null;
}

/**
 * SUPPORTED: a strict subset of the unfiltered page in which every row matches the sample.
 * IGNORED: the same rows as unfiltered. rejected: HTTP error or non-zero code.
 */
function classify(
  base: ListResult,
  res: ListResult,
  idField: string,
  match: Predicate | null,
): string {
  if (!ok(res)) return `rejected (${describeError(res)})`;
  const baseN = `${base.records.length}${base.hasMore ? '+' : ''}`;
  const n = res.records.length;
  if (n === 0) {
    return `0 rows although the sample came from the ${baseN} unfiltered rows: semantics differ`;
  }
  const baseIds = new Set(base.records.map((r) => str(r, idField)));
  const same = n === baseIds.size && res.records.every((r) => baseIds.has(str(r, idField)));
  if (same) {
    if (match === null) {
      return `IGNORED? same ${n} rows as unfiltered (no field to tell if all match)`;
    }
    if (base.records.every(match)) return `inconclusive: every unfiltered row matches the sample`;
    return `IGNORED: same ${n} rows as unfiltered`;
  }
  if (match !== null && !res.records.every(match)) {
    const bad = res.records.filter((r) => !match(r)).length;
    return `UNCLEAR: ${n} rows, ${bad} do not match the sample`;
  }
  return `SUPPORTED: ${n} of ${baseN} rows${match === null ? '' : ', all matching'}`;
}

async function runFilters(
  ctx: Ctx,
  path: string,
  keys: string[],
  idField: string,
  base: ListResult,
  probes: FilterProbe[],
): Promise<Row[]> {
  if (base.records.length === 0) {
    return probes.map((p) => row(p.label, null, 'skipped: the unfiltered list is empty'));
  }
  const rows: Row[] = [];
  for (const p of probes) {
    const sample = p.field === undefined ? '' : rarest(base.records, p.field);
    if (sample === null) {
      rows.push(row(p.label, null, `skipped: no ${p.field ?? ''} value in the unfiltered rows`));
      continue;
    }
    const res = await apiList(ctx, path, keys, p.params(sample));
    rows.push(row(p.label, res, classify(base, res, idField, p.match ? p.match(sample) : null)));
  }
  return rows;
}

/** `partially_invoiced` → `PartiallyInvoiced`, the Books-style `filter_by=Status.<X>` spelling. */
function pascal(status: string): string {
  return status
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

// ---------- probe groups ----------

async function probeServerInfo(): Promise<Row> {
  const res = await send(new URL(SERVERINFO_URL), { method: 'GET' });
  if (res.status !== 200 || res.body === null) {
    return row('P-1 serverinfo (no auth)', res, describeError(res));
  }
  const shape = Object.entries(res.body)
    .map(([k, v]) => (isObject(v) ? `${k}{${Object.keys(v).join(',')}}` : k))
    .join('; ');
  return row('P-1 serverinfo (no auth)', res, `keys: ${shape}`);
}

async function probeRefresh(cfg: Config, accounts: string): Promise<{ row: Row; ctx: Ctx | null }> {
  // POST form body per accounts/acc_oauth_web-apps_access-token-expiry.txt. Counts against Zoho's limit of 10
  // access tokens per refresh token per 10 minutes, so it runs once per smoke run.
  const label = `P-3 token refresh (POST, DC ${cfg.dc})`;
  const res = await send(new URL('/oauth/v2/token', accounts), {
    method: 'POST',
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: cfg.refreshToken,
    }),
  });
  const body = res.body ?? {};
  if (typeof body.access_token !== 'string' || body.access_token === '') {
    const err = typeof body.error === 'string' ? body.error : describeError(res);
    return { row: row(label, res, `FAILED: ${err}`), ctx: null };
  }
  remember(body.access_token);
  const apiDomain = typeof body.api_domain === 'string' ? body.api_domain : '';
  const origin = zohoOrigin(apiDomain);
  if (origin === null) {
    return {
      row: row(label, res, `api_domain is not an https Zoho host: "${apiDomain}"`),
      ctx: null,
    };
  }
  // UNVERIFIED (P-3): which api_domain Inventory tokens get (the www API host or api.zoho.*).
  const verdict = `ok; api_domain host ${origin.hostname}; token_type ${String(body.token_type)}; expires_in ${String(body.expires_in)}`;
  return {
    row: row(label, res, verdict),
    ctx: { origin, token: body.access_token, orgId: cfg.orgId },
  };
}

async function probeOrganizations(ctx: Ctx): Promise<Row[]> {
  const res = await apiGet(ctx, 'organizations', {}, null);
  if (!ok(res)) return [row('P-7 GET /organizations', res, describeError(res))];
  const orgs = Array.isArray(res.body?.organizations)
    ? res.body.organizations.filter(isObject)
    : [];
  const mine = orgs.find((o) => str(o, 'organization_id') === ctx.orgId);
  const plan = mine
    ? `plan_name=${str(mine, 'plan_name') ?? '-'}, plan_type=${str(mine, 'plan_type') ?? '-'}`
    : 'ZOHO_DEV_ORG_ID NOT in the list';
  // UNVERIFIED (P-23): rate-limit headers are not documented; record any that appear.
  const names = res.headers
    ? [...res.headers.keys()].filter((h) => /rate|retry|limit/i.test(h))
    : [];
  const headers = names.map((h) => `${h}=${res.headers?.get(h) ?? ''}`).join(', ') || 'none';
  return [
    row('P-7 GET /organizations', res, `${orgs.length} org(s); ${plan}`),
    row('P-23 rate-limit headers on a normal call', res, headers),
  ];
}

async function probeItems(ctx: Ctx): Promise<Row[]> {
  const keys = ['items'];
  const base = await apiList(ctx, 'items', keys);
  const rows = [
    row('P-8 items per_page=200', base, ok(base) ? listSummary(base) : describeError(base)),
  ];
  // UNVERIFIED (P-8): the maximum per_page is not documented.
  const over = await apiList(ctx, 'items', keys, { per_page: '201' });
  const overVerdict = ok(over)
    ? `accepted: ${over.records.length} rows, page_context.per_page=${String(over.pageContext?.per_page)}`
    : `rejected (${describeError(over)})`;
  rows.push(row('P-8 items per_page=201', over, overVerdict));
  const itemId = base.records.map((r) => str(r, 'item_id')).find((id) => id !== null);
  if (!itemId) return [...rows, row('P-9 item location stock types', null, 'skipped: no items')];
  const detail = await apiGet(ctx, `items/${encodeURIComponent(itemId)}`);
  const item = isObject(detail.body?.item) ? detail.body.item : null;
  const loc = Array.isArray(item?.locations) ? item.locations.find(isObject) : undefined;
  const fields = [
    'location_stock_on_hand',
    'location_available_stock',
    'location_actual_available_stock',
  ];
  const types = loc
    ? fields.map((f) => `${f}: ${typeof loc[f]}`).join(', ')
    : 'no locations[] on the item';
  rows.push(
    row('P-9 item location stock types', detail, ok(detail) ? types : describeError(detail)),
  );
  return rows;
}

async function probeSalesOrders(ctx: Ctx): Promise<Row[]> {
  const keys = ['salesorders'];
  const base = await apiList(ctx, 'salesorders', keys);
  if (!ok(base)) return [row('P-8 salesorders (unfiltered)', base, describeError(base))];
  const rows = [
    row(
      'P-8/P-16 salesorders (unfiltered)',
      base,
      `${listSummary(base)}; ${dateOrder(base.records, 'date')}`,
    ),
  ];
  if (base.records.length < 2) {
    return [
      ...rows,
      row('P-14 salesorders filters', null, 'skipped: need at least 2 sales orders'),
    ];
  }
  // UNVERIFIED (P-14): /salesorders documents only page/per_page; every filter below is a Books-style guess.
  const probes: FilterProbe[] = [
    {
      label: 'P-14 salesorders ?search_text',
      field: 'salesorder_number',
      params: (v) => ({ search_text: v }),
      match: anyText(),
    },
    {
      label: 'P-14 salesorders ?customer_id',
      field: 'customer_id',
      params: (v) => ({ customer_id: v }),
      match: eq('customer_id'),
    },
    {
      label: 'P-14 salesorders ?date_start&date_end',
      field: 'date',
      params: (v) => ({ date_start: v, date_end: v }),
      match: eq('date'),
    },
    {
      label: 'P-14 salesorders ?filter_by=Status.<X>',
      field: 'status',
      params: (v) => ({ filter_by: `Status.${pascal(v)}` }),
      match: eq('status'),
    },
    {
      label: 'P-14 salesorders ?status',
      field: 'status',
      params: (v) => ({ status: v }),
      match: eq('status'),
    },
    {
      label: 'P-14 salesorders ?reference_number',
      field: 'reference_number',
      params: (v) => ({ reference_number: v }),
      match: eq('reference_number'),
    },
    {
      label: 'P-14 salesorders ?salesorder_number',
      field: 'salesorder_number',
      params: (v) => ({ salesorder_number: v }),
      match: eq('salesorder_number'),
    },
  ];
  rows.push(...(await runFilters(ctx, 'salesorders', keys, 'salesorder_id', base, probes)));
  // UNVERIFIED (P-15): salesorder_ids is documented for bulk operations; whether GET honours it is unknown.
  const ids = base.records
    .map((r) => str(r, 'salesorder_id'))
    .filter((id): id is string => id !== null)
    .slice(0, 2);
  const batch = await apiList(ctx, 'salesorders', keys, { salesorder_ids: ids.join(',') });
  const inBatch: Predicate = (r) => ids.includes(str(r, 'salesorder_id') ?? '');
  rows.push(
    row(
      'P-15 salesorders ?salesorder_ids=<2 ids>',
      batch,
      classify(base, batch, 'salesorder_id', inBatch),
    ),
  );
  return rows;
}

async function probeInvoices(ctx: Ctx): Promise<Row[]> {
  const keys = ['invoices'];
  const base = await apiList(ctx, 'invoices', keys);
  if (!ok(base)) return [row('P-8 invoices (unfiltered)', base, describeError(base))];
  const rows = [row('P-8 invoices (unfiltered)', base, listSummary(base))];
  const probes: FilterProbe[] = [
    {
      label: 'invoices ?reference_number (documented)',
      field: 'reference_number',
      params: (v) => ({ reference_number: v }),
      match: eq('reference_number'),
    },
    {
      label: 'invoices ?customer_id (documented)',
      field: 'customer_id',
      params: (v) => ({ customer_id: v }),
      match: eq('customer_id'),
    },
    {
      label: 'invoices ?status (documented)',
      field: 'status',
      params: (v) => ({ status: v }),
      match: eq('status'),
    },
    {
      label: 'invoices ?search_text (documented)',
      field: 'invoice_number',
      params: (v) => ({ search_text: v }),
      match: anyText(),
    },
    // UNVERIFIED: due_date_start/due_date_end appear only in the `due_date` description ("Variants").
    {
      label: 'invoices ?due_date_start&due_date_end (prose)',
      field: 'due_date',
      params: (v) => ({ due_date_start: v, due_date_end: v }),
      match: eq('due_date'),
    },
  ];
  rows.push(...(await runFilters(ctx, 'invoices', keys, 'invoice_id', base, probes)));
  return rows;
}

async function probePayments(ctx: Ctx): Promise<Row[]> {
  const keys = ['customerpayments'];
  const base = await apiList(ctx, 'customerpayments', keys);
  if (!ok(base)) return [row('P-17 customerpayments (unfiltered)', base, describeError(base))];
  const withRef = base.records.filter((r) => str(r, 'reference_number') !== null).length;
  const rzpRef = base.records.filter((r) =>
    RAZORPAY_ID.test(str(r, 'reference_number') ?? ''),
  ).length;
  const rzpDesc = base.records.filter((r) => RAZORPAY_ID.test(str(r, 'description') ?? '')).length;
  const where = `${withRef} with reference_number; Razorpay-like ids: ${rzpRef} in reference_number, ${rzpDesc} in description`;
  const rows = [row('P-17 customerpayments (unfiltered)', base, `${listSummary(base)}; ${where}`)];
  // A slice from inside the reference proves "contains" rather than "starts with".
  const inner = (v: string): string => (v.length >= 6 ? v.slice(1, Math.min(v.length - 1, 9)) : v);
  const probes: FilterProbe[] = [
    // UNVERIFIED (P-17): reference_number_contains appears only in the reference_number description.
    {
      label: 'P-17 customerpayments ?reference_number_contains (prose)',
      field: 'reference_number',
      params: (v) => ({ reference_number_contains: inner(v) }),
      match: (v) => contains('reference_number')(inner(v)),
    },
    {
      label: 'P-17 customerpayments ?reference_number (documented)',
      field: 'reference_number',
      params: (v) => ({ reference_number: v }),
      match: eq('reference_number'),
    },
    {
      label: 'P-17 customerpayments ?search_text=<reference>',
      field: 'reference_number',
      params: (v) => ({ search_text: v }),
      match: anyText(),
    },
  ];
  rows.push(...(await runFilters(ctx, 'customerpayments', keys, 'payment_id', base, probes)));
  return rows;
}

async function probePackages(ctx: Ctx): Promise<Row[]> {
  // UNVERIFIED (P-20): the OpenAPI names the list key `package`; `packages` is expected on the wire.
  const keys = ['packages', 'package'];
  const base = await apiList(ctx, 'packages', keys);
  if (!ok(base)) return [row('P-20 packages (unfiltered)', base, describeError(base))];
  const rows = [row('P-20 packages (unfiltered)', base, listSummary(base))];
  // Package list rows document no status field; use it only if the wire has one.
  const hasStatus = base.records.some((r) => str(r, 'status') !== null);
  const digits = (v: string): string => v.replace(/\D/g, '');
  const probes: FilterProbe[] = [
    {
      label: 'packages ?filter_by=Status.Shipped (documented)',
      params: () => ({ filter_by: 'Status.Shipped' }),
      match: hasStatus ? () => (r) => /shipped|delivered/i.test(str(r, 'status') ?? '') : null,
    },
    // UNVERIFIED (P-19): salesorder_number_contains is typed integer although SO numbers look like SO-00012.
    {
      label: 'P-19 packages ?salesorder_number_contains=<full number>',
      field: 'salesorder_number',
      params: (v) => ({ salesorder_number_contains: v }),
      match: contains('salesorder_number'),
    },
    {
      label: 'P-19 packages ?salesorder_number_contains=<digits>',
      field: 'salesorder_number',
      params: (v) => ({ salesorder_number_contains: digits(v) }),
      match: (v) => contains('salesorder_number')(digits(v)),
    },
    {
      label: 'packages ?customer_id (documented)',
      field: 'customer_id',
      params: (v) => ({ customer_id: v }),
      match: eq('customer_id'),
    },
    {
      label: 'packages ?date_start&date_end (documented)',
      field: 'date',
      params: (v) => ({ date_start: v, date_end: v }),
      match: eq('date'),
    },
  ];
  rows.push(...(await runFilters(ctx, 'packages', keys, 'package_id', base, probes)));
  return rows;
}

async function probeErrors(ctx: Ctx): Promise<Row[]> {
  // UNVERIFIED (P-22, P-12): per-module not-found codes and the invalid-token code are not documented.
  const notFound = await apiGet(ctx, 'items/1');
  const badOrg = await apiGet(ctx, 'items', { per_page: '1' }, '1');
  const badToken = await apiGet(ctx, 'organizations', {}, null, 'invalid-smoke-token');
  return [
    row('P-22 GET /items/1 (unknown id)', notFound, describeError(notFound)),
    row('bad organization_id', badOrg, describeError(badOrg)),
    row(
      'invalid access token',
      badToken,
      `${describeError(badToken)}${badToken.status === 401 ? ' (401 as documented)' : ''}`,
    ),
  ];
}

// ---------- report ----------

function renderTable(rows: Row[]): string {
  const cell = (s: string): string =>
    redact(s).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim().slice(0, 220);
  const status = (r: Row): string =>
    r.status === null ? '-' : r.status === 0 ? 'none' : String(r.status);
  return [
    '| Probe | HTTP | Zoho code | Verdict |',
    '|---|---|---|---|',
    ...rows.map(
      (r) => `| ${cell(r.probe)} | ${status(r)} | ${r.code ?? '-'} | ${cell(r.verdict)} |`,
    ),
  ].join('\n');
}

function renderDoc(rows: Row[], dc: string, apiHost: string): string {
  return `# Zoho smoke results

Generated by \`pnpm smoke\` (\`scripts/smoke.ts\`) at ${new Date().toISOString()} · DC \`${dc}\` · API host \`${apiHost}\` · DEV client.
GET-only probes plus one token refresh. Sanitized: no tokens, ids, sample values or customer data.
Copy the observations into ADR-0001 (\`docs/adr/0001-zoho-api-assumptions-and-smoke-results.md\`).

Filter verdicts: **SUPPORTED** = a strict subset of the unfiltered page in which every row matches the sample;
**IGNORED** = the same rows as unfiltered; **rejected** = HTTP error or non-zero \`code\`; **inconclusive** = this org's
data cannot tell. Samples are the least frequent value of the field in the unfiltered page.

${renderTable(rows)}

## Not probed here

- P-2, P-4: callback \`location\` / authorize at the user's DC. Observe during the OAuth flow on \`/connect\`.
- P-5, P-6: revoke DC and a bogus refresh token. Each spends a token request or revokes a token; run by hand if needed.
- P-10, P-11: behaviour with fewer scopes. Needs a separate consent with a narrower scope list.
- P-13, P-18, P-21: \`/itemdetails\` with 25 ids, invoice → sales order link, web deep links. Check by hand.
`;
}

async function main(): Promise<number> {
  loadDotEnv();
  const cfg = readConfig();
  if ('missing' in cfg) {
    console.error(
      `smoke: missing environment variables: ${cfg.missing.join(', ')} (set them in .env).`,
    );
    return 1;
  }
  [cfg.clientId, cfg.clientSecret, cfg.refreshToken, cfg.orgId].forEach(remember);
  const accounts = ACCOUNTS_SERVERS[cfg.dc];
  if (accounts === undefined) {
    console.error(`smoke: ZOHO_DEV_DC must be one of ${Object.keys(ACCOUNTS_SERVERS).join(', ')}.`);
    return 1;
  }

  const rows: Row[] = [await probeServerInfo()];
  const refreshed = await probeRefresh(cfg, accounts);
  rows.push(refreshed.row);
  const ctx = refreshed.ctx;
  if (ctx !== null) {
    rows.push(...(await probeOrganizations(ctx)));
    rows.push(...(await probeItems(ctx)));
    rows.push(...(await probeSalesOrders(ctx)));
    rows.push(...(await probeInvoices(ctx)));
    rows.push(...(await probePayments(ctx)));
    rows.push(...(await probePackages(ctx)));
    rows.push(...(await probeErrors(ctx)));
  }

  // Every dynamic value reaches the document through renderTable's redacting cells; the host is validated.
  const doc = renderDoc(rows, cfg.dc, ctx?.origin.hostname ?? 'n/a');
  console.log(doc);
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, doc);
  console.log(`Wrote ${relative(ROOT, RESULTS_PATH)}`);
  return ctx === null ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`smoke: ${redact(e instanceof Error ? e.message : String(e))}`);
    process.exitCode = 1;
  },
);
