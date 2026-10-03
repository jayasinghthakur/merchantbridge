import { randomUUID } from 'node:crypto';
import type { DemoFault } from '@mb/core';
import type { ZohoTokenSource } from '../client';
import type { DemoDataset } from './dataset';
import type { WireInvoice, WirePackage, WirePayment } from './wire';

/**
 * FakeZoho: a fetch-compatible transport that speaks Zoho Inventory's wire format (code≠0 errors, page_context,
 * 401 on bad tokens, 429 codes 44/45/1070, 5xx, malformed JSON). It is a fake *upstream*, so the real client,
 * mappers, governor and ToolRuntime all run against it. Read-only: every non-GET request gets 405.
 */
export interface FakeZohoOptions {
  dataset: DemoDataset;
  /** Read on every request, so playground toggles take effect immediately. */
  faults?: () => ReadonlySet<DemoFault>;
  latencyMs?: number;
}

export interface FakeZoho {
  fetch: typeof fetch;
  tokens: ZohoTokenSource;
  /** Requests received (including rejected ones). */
  readonly calls: number;
}

/** Any origin works; the path must start with this prefix. */
export const FAKE_ZOHO_API_DOMAIN = 'https://fake-zoho.invalid';
const API_PREFIX = '/inventory/v1/';
/** UNVERIFIED: documented default page size is 200; the maximum is not documented, so the fake caps at 200. */
const MAX_PER_PAGE = 200;

// Response bodies for the documented error codes (accounts/introduction.txt, accounts/errors.txt).
const BODY_44 = {
  code: 44,
  message:
    'For security reasons your organization has been blocked as it have exceeded the maximum number of requests per minute that can originate from an organization.',
};
const BODY_45 = {
  code: 45,
  message: 'The API call for this organization has exceeded the maximum call rate limit of 1000.',
};
const BODY_1070 = {
  code: 1070,
  message:
    'You have reached the maximum number of in process requests allowed. Kindly try again after some time.',
};
// UNVERIFIED: the docs only say 401 = invalid AuthToken; code 57 is what Zoho is commonly observed to send.
const BODY_401 = { code: 57, message: 'You are not authorized to perform this operation' };
// UNVERIFIED codes below: only 1002 ("Invoice does not exist.") is documented.
const NOT_FOUND_CODE = 1002;
const BODY_BAD_URL = { code: 5, message: 'Invalid URL Passed' };
const BODY_BAD_ORG = { code: 2, message: 'Invalid value passed for organization_id' };
const BODY_405 = { code: 37, message: 'The HTTP method is not allowed for the requested resource' };

/** List-response projections; the detail record is the full wire object (see wire.ts). */
const LIST_FIELDS = {
  items: [
    'item_id',
    'name',
    'status',
    'source',
    'is_linked_with_zohocrm',
    'item_type',
    'description',
    'rate',
    'is_taxable',
    'tax_id',
    'tax_name',
    'tax_percentage',
    'purchase_description',
    'purchase_rate',
    'is_combo_product',
    'product_type',
    'reorder_level',
    'sku',
    'created_time',
    'last_modified_time',
    'hsn_or_sac',
    'custom_fields',
    // UNVERIFIED: not in the documented list example (see WireItem.stock_on_hand).
    'stock_on_hand',
    'available_stock',
    'actual_available_stock',
  ],
  itemdetails: [
    'item_id',
    'name',
    'unit',
    'item_type',
    'product_type',
    'is_taxable',
    'tax_id',
    'description',
    'tax_name',
    'tax_percentage',
    'status',
    'rate',
    'pricebook_rate',
    'purchase_rate',
    'reorder_level',
    'locations',
    'sku',
    'purchase_description',
    'hsn_or_sac',
    'custom_fields',
  ],
  contacts: [
    'contact_id',
    'contact_name',
    'company_name',
    'contact_type',
    'status',
    'payment_terms',
    'payment_terms_label',
    'currency_id',
    'currency_code',
    'outstanding_receivable_amount',
    'unused_credits_receivable_amount',
    'first_name',
    'last_name',
    'email',
    'phone',
    'mobile',
    'created_time',
    'last_modified_time',
  ],
  contactDetailOmit: ['first_name', 'last_name', 'email', 'phone', 'mobile'],
  salesorders: [
    'salesorder_id',
    'customer_name',
    'customer_id',
    'status',
    'salesorder_number',
    'reference_number',
    'date',
    'shipment_date',
    'shipment_days',
    'quantity',
    'quantity_invoiced',
    'quantity_packed',
    'quantity_shipped',
    'currency_code',
    'total',
    'bcy_total',
    'created_time',
    'last_modified_time',
    'is_emailed',
    'sales_channel',
    'custom_fields',
  ],
  salesorderDetailOmit: [
    'shipment_days',
    'quantity',
    'quantity_invoiced',
    'quantity_packed',
    'quantity_shipped',
    'bcy_total',
  ],
  invoices: [
    'invoice_id',
    'customer_name',
    'customer_id',
    'status',
    'invoice_number',
    'reference_number',
    'date',
    'due_date',
    'due_days',
    'currency_id',
    'currency_code',
    'is_viewed_by_client',
    'has_attachment',
    'total',
    'balance',
    'created_time',
    'last_modified_time',
    'is_emailed',
    'reminders_sent',
    'payment_expected_date',
    'last_payment_date',
    'custom_fields',
    'location_id',
    'location_name',
    'shipping_charge',
    'adjustment',
    'write_off_amount',
    'exchange_rate',
  ],
  invoiceDetailOmit: ['due_days'],
  customerpayments: [
    'payment_id',
    'payment_number',
    'date',
    'payment_mode',
    'amount',
    'bcy_amount',
    'unused_amount',
    'account_id',
    'account_name',
    'description',
    'reference_number',
    'customer_id',
    'customer_name',
    'location_id',
    'location_name',
  ],
  paymentDetailOmit: ['payment_number', 'bcy_amount'],
  packages: [
    'created_time',
    'customer_id',
    'customer_name',
    'date',
    'email',
    'is_emailed',
    'last_modified_time',
    'mobile',
    'notes',
    'package_id',
    'package_number',
    'phone',
    'salesorder_id',
    'salesorder_number',
    'total_quantity',
    'custom_fields',
  ],
  organizationList: [
    'organization_id',
    'name',
    'contact_name',
    'email',
    'is_default_org',
    'plan_type',
    'plan_name',
    'plan_period',
    'language_code',
    'fiscal_year_start_month',
    'account_created_date',
    'time_zone',
    'is_org_active',
    'currency_id',
    'currency_code',
    'currency_symbol',
    'currency_format',
    'price_precision',
  ],
  organizationDetailOmit: ['plan_type', 'plan_name', 'plan_period'],
} as const;

type Row = object;

function pick(obj: Row, keys: readonly string[]): Record<string, unknown> {
  const src = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in src) out[k] = src[k];
  return out;
}

function omit(obj: Row, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  for (const k of keys) delete out[k];
  return out;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8', ...headers },
  });
}

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: { code: number; message: string },
  ) {
    super(body.message);
  }
}

const notFound = (resource: string): HttpFailure =>
  new HttpFailure(404, { code: NOT_FOUND_CODE, message: `${resource} does not exist.` });

/** A malformed %-escape is a bad URL to a real server (an HTTP error), not a transport failure. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpFailure(404, BODY_BAD_URL);
  }
}

// ---------- query helpers ----------

const lower = (s: string | null | undefined): string => (s ?? '').toLowerCase();

/** `<base>`, `<base>_startswith`, `<base>_contains`: the documented text-filter variants (case-insensitive). */
function textFilter<T>(
  rows: T[],
  q: URLSearchParams,
  base: string,
  values: (r: T) => string[],
): T[] {
  let out = rows;
  const exact = q.get(base);
  const starts = q.get(`${base}_startswith`);
  const contains = q.get(`${base}_contains`);
  if (exact !== null) out = out.filter((r) => values(r).some((v) => lower(v) === lower(exact)));
  if (starts !== null)
    out = out.filter((r) => values(r).some((v) => lower(v).startsWith(lower(starts))));
  if (contains !== null)
    out = out.filter((r) => values(r).some((v) => lower(v).includes(lower(contains))));
  return out;
}

/** `<base>`, `_less_than`, `_less_equals`, `_greater_than`, `_greater_equals`. */
function numberFilter<T>(
  rows: T[],
  q: URLSearchParams,
  base: string,
  value: (r: T) => number,
): T[] {
  const ops: [string, (a: number, b: number) => boolean][] = [
    [base, (a, b) => a === b],
    [`${base}_less_than`, (a, b) => a < b],
    [`${base}_less_equals`, (a, b) => a <= b],
    [`${base}_greater_than`, (a, b) => a > b],
    [`${base}_greater_equals`, (a, b) => a >= b],
  ];
  let out = rows;
  for (const [param, cmp] of ops) {
    const raw = q.get(param);
    if (raw === null) continue;
    const n = Number(raw);
    if (!Number.isFinite(n))
      throw new HttpFailure(400, { code: 2, message: `Invalid value passed for ${param}` });
    out = out.filter((r) => cmp(value(r), n));
  }
  return out;
}

/** `<base>` (exact), `_start`/`_after`, `_end`/`_before` over yyyy-mm-dd prefixes. */
function dateFilter<T>(rows: T[], q: URLSearchParams, base: string, value: (r: T) => string): T[] {
  const d = (s: string): string => s.slice(0, 10);
  let out = rows;
  const exact = q.get(base);
  const start = q.get(`${base}_start`);
  const end = q.get(`${base}_end`);
  const after = q.get(`${base}_after`);
  const before = q.get(`${base}_before`);
  if (exact !== null) out = out.filter((r) => d(value(r)) === d(exact));
  if (start !== null) out = out.filter((r) => value(r) !== '' && d(value(r)) >= d(start));
  if (end !== null) out = out.filter((r) => value(r) !== '' && d(value(r)) <= d(end));
  if (after !== null) out = out.filter((r) => value(r) !== '' && d(value(r)) > d(after));
  if (before !== null) out = out.filter((r) => value(r) !== '' && d(value(r)) < d(before));
  return out;
}

function sortRows<T extends Row>(
  rows: T[],
  q: URLSearchParams,
  allowed: readonly string[],
  fallback: (a: T, b: T) => number,
): T[] {
  const col = q.get('sort_column');
  const desc = q.get('sort_order') === 'D';
  if (col === null || !allowed.includes(col)) return [...rows].sort(fallback);
  return [...rows].sort((a, b) => {
    const av = (a as Record<string, unknown>)[col];
    const bv = (b as Record<string, unknown>)[col];
    const text = (v: unknown): string =>
      typeof v === 'string' || typeof v === 'number' ? String(v) : '';
    const c =
      typeof av === 'number' && typeof bv === 'number' ? av - bv : text(av).localeCompare(text(bv));
    return desc ? -c : c;
  });
}

function paginate<T>(
  rows: T[],
  q: URLSearchParams,
): { slice: T[]; page_context: Record<string, unknown> } {
  const intParam = (name: string, dflt: number): number => {
    const raw = q.get(name);
    if (raw === null) return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1)
      throw new HttpFailure(400, { code: 2, message: `Invalid value passed for ${name}` });
    return n;
  };
  const page = intParam('page', 1);
  const perPage = Math.min(intParam('per_page', MAX_PER_PAGE), MAX_PER_PAGE);
  const start = (page - 1) * perPage;
  return {
    slice: rows.slice(start, start + perPage),
    page_context: { page, per_page: perPage, has_more_page: start + perPage < rows.length },
  };
}

const byDateDesc =
  <T>(date: (r: T) => string, tie: (r: T) => string) =>
  (a: T, b: T): number =>
    date(b).localeCompare(date(a)) || tie(b).localeCompare(tie(a));

/** Zoho filters `Status.X` / `PaymentMode.X`; returns the part after the dot, lower-cased. */
function filterBy(q: URLSearchParams, prefix: string): string | null {
  const raw = q.get('filter_by');
  if (raw === null || !raw.startsWith(`${prefix}.`)) return null;
  return raw.slice(prefix.length + 1).toLowerCase();
}

// ---------- the fake ----------

export function createFakeZoho(opts: FakeZohoOptions): FakeZoho {
  const ds = opts.dataset;
  const faults = opts.faults ?? (() => new Set<DemoFault>());
  const latencyMs = opts.latencyMs ?? 0;

  let calls = 0;
  let tokenSerial = 0;
  const issued = new Map<string, number>();
  const revoked = new Set<string>();
  let expiredArmed = false;
  let expiredCutoff = 0;
  let served1070 = 0;
  let served5xx = 0;

  const issue = (): string => {
    tokenSerial += 1;
    const token = `1000.demo${tokenSerial}.${randomUUID().replaceAll('-', '')}`;
    issued.set(token, tokenSerial);
    return token;
  };
  let current = issue();

  const tokens: ZohoTokenSource = {
    get: () => Promise.resolve(current),
    refreshAfterUnauthorized: (failed) => {
      // Single-flight semantics: only the holder of the current token triggers a new one.
      if (failed === current) current = issue();
      return Promise.resolve(current);
    },
  };

  const orgId = ds.organization.organization_id;
  const contactById = new Map(ds.contacts.map((c) => [c.contact_id, c]));
  const packageStatus = (p: WirePackage): 'not_shipped' | 'shipped' | 'delivered' =>
    p.shipment_order?.status ?? 'not_shipped';

  function authorize(headers: Headers, active: ReadonlySet<DemoFault>): Response | null {
    const match = /^Zoho-oauthtoken (\S+)$/.exec(headers.get('authorization') ?? '');
    const token = match?.[1];
    const serial = token === undefined ? undefined : issued.get(token);
    if (token === undefined || serial === undefined || revoked.has(token))
      return json(401, BODY_401);

    if (active.has('expired_token')) {
      if (!expiredArmed) {
        // Every token issued before the fault was first observed is now considered expired.
        expiredArmed = true;
        expiredCutoff = tokenSerial + 1;
      }
      if (serial < expiredCutoff) {
        revoked.add(token);
        return json(401, BODY_401);
      }
    } else {
      expiredArmed = false;
    }
    return null;
  }

  function injectFault(active: ReadonlySet<DemoFault>): Response | null {
    if (active.has('daily_quota_45')) return json(429, BODY_45);
    if (active.has('rate_limit_44')) return json(429, BODY_44);
    if (active.has('concurrency_1070') && served1070 < 2) {
      served1070 += 1;
      return json(429, BODY_1070);
    }
    if (active.has('server_5xx') && served5xx < 1) {
      served5xx += 1;
      return new Response('<html><body>503 Service Temporarily Unavailable</body></html>', {
        status: 503,
        headers: { 'content-type': 'text/html' },
      });
    }
    if (active.has('malformed')) {
      return new Response('{"code":0,"message":"success","items":[{"item_id":"46', {
        status: 200,
        headers: { 'content-type': 'application/json;charset=UTF-8' },
      });
    }
    return null;
  }

  function route(segments: string[], q: URLSearchParams): unknown {
    const [resource, id, ...rest] = segments;
    if (rest.length > 0 || resource === undefined) throw new HttpFailure(404, BODY_BAD_URL);

    if (resource === 'organizations') {
      if (id === undefined) {
        return {
          code: 0,
          message: 'success',
          organizations: [pick(ds.organization, LIST_FIELDS.organizationList)],
        };
      }
      if (id !== orgId) throw notFound('Organization');
      return {
        code: 0,
        message: 'success',
        organization: omit(ds.organization, LIST_FIELDS.organizationDetailOmit),
      };
    }

    // UNVERIFIED: exact error body for a missing/foreign organization_id is undocumented.
    if (q.get('organization_id') !== orgId) throw new HttpFailure(400, BODY_BAD_ORG);

    switch (resource) {
      case 'locations':
        if (id !== undefined) break;
        return { code: 0, message: 'success', locations: ds.locations };
      case 'items':
        return id === undefined ? listItems(q) : getItem(id);
      case 'itemdetails':
        if (id !== undefined) break;
        return itemDetails(q);
      case 'contacts':
        return id === undefined ? listContacts(q) : getContact(id);
      case 'salesorders':
        return id === undefined ? listSalesOrders(q) : getSalesOrder(id);
      case 'invoices':
        return id === undefined ? listInvoices(q) : getInvoice(id);
      case 'customerpayments':
        return id === undefined ? listPayments(q) : getPayment(id);
      case 'packages':
        return id === undefined ? listPackages(q) : getPackage(id);
      case 'shipmentorders':
        if (id === undefined) break; // shipment orders have no list endpoint
        return getShipmentOrder(id);
    }
    throw new HttpFailure(404, BODY_BAD_URL);
  }

  function listItems(q: URLSearchParams): unknown {
    let rows = ds.items;
    const search = q.get('search_text');
    if (search !== null) {
      const s = lower(search);
      rows = rows.filter((r) => [r.name, r.sku, r.description].some((v) => lower(v).includes(s)));
    }
    rows = textFilter(rows, q, 'name', (r) => [r.name]);
    rows = textFilter(rows, q, 'sku', (r) => [r.sku]);
    rows = numberFilter(rows, q, 'rate', (r) => r.rate);
    rows = numberFilter(rows, q, 'purchase_rate', (r) => r.purchase_rate);
    const itemId = q.get('item_id');
    if (itemId !== null) rows = rows.filter((r) => r.item_id === itemId);
    const status = q.get('status');
    if (status !== null) rows = rows.filter((r) => r.status === lower(status));
    const locationId = q.get('location_id') ?? q.get('warehouse_id');
    if (locationId !== null)
      rows = rows.filter((r) => r.locations.some((l) => l.location_id === locationId));
    const by = filterBy(q, 'Status');
    if (by === 'active' || by === 'inactive') rows = rows.filter((r) => r.status === by);
    if (by === 'lowstock')
      rows = rows.filter((r) => r.status === 'active' && r.stock_on_hand <= r.reorder_level);
    const sorted = sortRows(
      rows,
      q,
      [
        'name',
        'sku',
        'rate',
        'purchase_rate',
        'created_time',
        'last_modified_time',
        'reorder_level',
        'stock_on_hand',
      ],
      (a, b) => a.name.localeCompare(b.name),
    );
    const { slice, page_context } = paginate(sorted, q);
    return {
      code: 0,
      message: 'success',
      items: slice.map((r) => pick(r, LIST_FIELDS.items)),
      page_context,
    };
  }

  function getItem(id: string): unknown {
    const item = ds.items.find((r) => r.item_id === id);
    if (!item) throw notFound('Item');
    return { code: 0, message: 'success', item };
  }

  function itemDetails(q: URLSearchParams): unknown {
    const ids = (q.get('item_ids') ?? '').split(',').filter((s) => s !== '');
    if (ids.length === 0)
      throw new HttpFailure(400, { code: 2, message: 'Invalid value passed for item_ids' });
    const rows = ds.items.filter((r) => ids.includes(r.item_id));
    return {
      code: 0,
      message: 'success',
      items: rows.map((r) => pick(r, LIST_FIELDS.itemdetails)),
    };
  }

  function listContacts(q: URLSearchParams): unknown {
    let rows = ds.contacts;
    rows = textFilter(rows, q, 'contact_name', (r) => [r.contact_name]);
    rows = textFilter(rows, q, 'company_name', (r) => [r.company_name]);
    rows = textFilter(rows, q, 'first_name', (r) => [
      r.first_name,
      ...r.contact_persons.map((p) => p.first_name),
    ]);
    rows = textFilter(rows, q, 'last_name', (r) => [
      r.last_name,
      ...r.contact_persons.map((p) => p.last_name),
    ]);
    rows = textFilter(rows, q, 'email', (r) => [r.email, ...r.contact_persons.map((p) => p.email)]);
    rows = textFilter(rows, q, 'address', (r) => [
      r.billing_address.address,
      r.billing_address.city,
    ]);
    // Phone numbers are matched on digits too, so "98450 10001" finds "+91-98450-10001".
    const digits = (s: string): string => s.replace(/\D/g, '');
    for (const variant of ['phone', 'phone_startswith', 'phone_contains'] as const) {
      const raw = q.get(variant);
      if (raw === null) continue;
      const want = digits(raw);
      rows = rows.filter((r) =>
        [r.phone, r.mobile, ...r.contact_persons.flatMap((p) => [p.phone, p.mobile])].some((v) => {
          const have = digits(v);
          if (want === '') return false;
          if (variant === 'phone') return have === want;
          return variant === 'phone_startswith' ? have.startsWith(want) : have.includes(want);
        }),
      );
    }
    const search = q.get('search_text');
    if (search !== null) {
      const s = lower(search);
      rows = rows.filter((r) => lower(r.contact_name).includes(s) || lower(r.notes).includes(s));
    }
    const by = filterBy(q, 'Status');
    if (by === 'active' || by === 'inactive') rows = rows.filter((r) => r.status === by);
    const sorted = sortRows(
      rows,
      q,
      [
        'contact_name',
        'first_name',
        'last_name',
        'email',
        'outstanding_receivable_amount',
        'created_time',
        'last_modified_time',
      ],
      (a, b) => a.contact_name.localeCompare(b.contact_name),
    );
    const { slice, page_context } = paginate(sorted, q);
    return {
      code: 0,
      message: 'success',
      contacts: slice.map((r) => pick(r, LIST_FIELDS.contacts)),
      page_context,
    };
  }

  function getContact(id: string): unknown {
    const contact = contactById.get(id);
    if (!contact) throw notFound('Contact');
    return { code: 0, message: 'success', contact: omit(contact, LIST_FIELDS.contactDetailOmit) };
  }

  function listSalesOrders(q: URLSearchParams): unknown {
    // salesorders.yml documents only page/per_page for this endpoint, so the fake honours nothing else.
    // UNVERIFIED: default ordering (newest first).
    const sorted = [...ds.salesorders].sort(
      byDateDesc(
        (r) => r.date,
        (r) => r.salesorder_number,
      ),
    );
    const { slice, page_context } = paginate(sorted, q);
    return {
      code: 0,
      message: 'success',
      salesorders: slice.map((r) => pick(r, LIST_FIELDS.salesorders)),
      page_context,
    };
  }

  function getSalesOrder(id: string): unknown {
    const so = ds.salesorders.find((r) => r.salesorder_id === id);
    if (!so) throw notFound('Sales Order');
    return { code: 0, message: 'success', salesorder: omit(so, LIST_FIELDS.salesorderDetailOmit) };
  }

  /** UNVERIFIED semantics: `unpaid` = any issued invoice with a balance (sent, overdue, partially paid…). */
  function invoiceMatchesStatus(r: WireInvoice, status: string): boolean {
    if (status === 'unpaid') return r.balance > 0 && r.status !== 'draft' && r.status !== 'void';
    if (status === 'partiallypaid') return r.status === 'partially_paid';
    if (status === 'all') return true;
    return r.status === status;
  }

  function listInvoices(q: URLSearchParams): unknown {
    let rows = ds.invoices;
    rows = textFilter(rows, q, 'invoice_number', (r) => [r.invoice_number]);
    rows = textFilter(rows, q, 'customer_name', (r) => [r.customer_name]);
    rows = textFilter(rows, q, 'email', (r) => [contactById.get(r.customer_id)?.email ?? '']);
    const ref = q.get('reference_number');
    if (ref !== null) rows = rows.filter((r) => r.reference_number === ref);
    const customerId = q.get('customer_id');
    if (customerId !== null) rows = rows.filter((r) => r.customer_id === customerId);
    const itemId = q.get('item_id');
    if (itemId !== null) rows = rows.filter((r) => r.line_items.some((l) => l.item_id === itemId));
    rows = dateFilter(rows, q, 'date', (r) => r.date);
    rows = dateFilter(rows, q, 'due_date', (r) => r.due_date);
    rows = numberFilter(rows, q, 'total', (r) => r.total);
    rows = numberFilter(rows, q, 'balance', (r) => r.balance);
    const status = q.get('status');
    if (status !== null) rows = rows.filter((r) => invoiceMatchesStatus(r, lower(status)));
    const by = filterBy(q, 'Status');
    if (by !== null) rows = rows.filter((r) => invoiceMatchesStatus(r, by));
    const search = q.get('search_text');
    if (search !== null) {
      const s = lower(search);
      rows = rows.filter((r) =>
        [r.invoice_number, r.customer_name, r.reference_number].some((v) => lower(v).includes(s)),
      );
    }
    const sorted = sortRows(
      rows,
      q,
      ['customer_name', 'invoice_number', 'date', 'due_date', 'total', 'balance', 'created_time'],
      byDateDesc(
        (r) => r.date,
        (r) => r.invoice_number,
      ),
    );
    const { slice, page_context } = paginate(sorted, q);
    return {
      code: 0,
      message: 'success',
      invoices: slice.map((r) => pick(r, LIST_FIELDS.invoices)),
      page_context,
    };
  }

  function getInvoice(id: string): unknown {
    const invoice = ds.invoices.find((r) => r.invoice_id === id);
    if (!invoice) throw notFound('Invoice');
    return { code: 0, message: 'success', invoice: omit(invoice, LIST_FIELDS.invoiceDetailOmit) };
  }

  function paymentListRow(p: WirePayment): Record<string, unknown> {
    return {
      ...pick(p, LIST_FIELDS.customerpayments),
      invoice_number: p.invoices.map((i) => i.invoice_number).join(','),
    };
  }

  function listPayments(q: URLSearchParams): unknown {
    let rows = ds.customerpayments;
    rows = textFilter(rows, q, 'reference_number', (r) => [r.reference_number]);
    rows = textFilter(rows, q, 'customer_name', (r) => [r.customer_name]);
    rows = textFilter(rows, q, 'notes', (r) => [r.description]);
    rows = textFilter(rows, q, 'payment_mode', (r) => [r.payment_mode]);
    rows = dateFilter(rows, q, 'date', (r) => r.date);
    rows = numberFilter(rows, q, 'amount', (r) => r.amount);
    const mode = filterBy(q, 'PaymentMode');
    if (mode !== null && mode !== 'all') rows = rows.filter((r) => lower(r.payment_mode) === mode);
    const search = q.get('search_text');
    if (search !== null) {
      const s = lower(search);
      rows = rows.filter((r) =>
        [r.reference_number, r.customer_name, r.description].some((v) => lower(v).includes(s)),
      );
    }
    const sorted = sortRows(
      rows,
      q,
      ['date', 'amount', 'customer_name', 'reference_number', 'payment_number'],
      byDateDesc(
        (r) => r.date,
        (r) => r.payment_id,
      ),
    );
    const { slice, page_context } = paginate(sorted, q);
    return {
      code: 0,
      message: 'success',
      customerpayments: slice.map(paymentListRow),
      page_context,
    };
  }

  function getPayment(id: string): unknown {
    const payment = ds.customerpayments.find((r) => r.payment_id === id);
    if (!payment) throw notFound('Payment');
    return { code: 0, message: 'success', payment: omit(payment, LIST_FIELDS.paymentDetailOmit) };
  }

  function listPackages(q: URLSearchParams): unknown {
    let rows = ds.packages;
    const by = filterBy(q, 'Status');
    if (by === 'notshipped') rows = rows.filter((r) => packageStatus(r) === 'not_shipped');
    if (by === 'shipped') rows = rows.filter((r) => packageStatus(r) === 'shipped');
    if (by === 'delivered') rows = rows.filter((r) => packageStatus(r) === 'delivered');
    const status = q.get('status');
    if (status !== null) rows = rows.filter((r) => packageStatus(r) === lower(status));
    const customerId = q.get('customer_id');
    if (customerId !== null) rows = rows.filter((r) => r.customer_id === customerId);
    rows = textFilter(rows, q, 'customer_name', (r) => [r.customer_name]);
    rows = textFilter(rows, q, 'salesorder_number', (r) => [r.salesorder_number]);
    rows = textFilter(rows, q, 'packing_number', (r) => [r.package_number]);
    rows = textFilter(rows, q, 'delivery_method', (r) => [r.shipment_order?.delivery_method ?? '']);
    rows = dateFilter(rows, q, 'date', (r) => r.date);
    rows = dateFilter(rows, q, 'shipment_date', (r) => r.shipment_order?.shipping_date ?? '');
    const search = q.get('search_text');
    if (search !== null) {
      const s = lower(search);
      rows = rows.filter((r) =>
        [
          r.package_number,
          r.salesorder_number,
          r.customer_name,
          r.shipment_order?.tracking_number ?? '',
        ].some((v) => lower(v).includes(s)),
      );
    }
    const sorted = sortRows(
      rows,
      q,
      [
        'salesorder_number',
        'package_number',
        'date',
        'created_time',
        'last_modified_time',
        'customer_name',
        'customer_id',
      ],
      byDateDesc(
        (r) => r.date,
        (r) => r.package_number,
      ),
    );
    const { slice, page_context } = paginate(sorted, q);
    // packages.yml names the list key `package` (singular).
    return {
      code: 0,
      message: 'success',
      package: slice.map((r) => pick(r, LIST_FIELDS.packages)),
      page_context,
    };
  }

  function getPackage(id: string): unknown {
    const pkg = ds.packages.find((r) => r.package_id === id);
    if (!pkg) throw notFound('Package');
    const detail = pkg.shipment_order === null ? omit(pkg, ['shipment_order']) : { ...pkg };
    // packages.yml documents the detail record wrapped in a one-element `package` array.
    return { code: 0, message: 'success', package: [detail] };
  }

  function getShipmentOrder(id: string): unknown {
    const pkg = ds.packages.find((r) => r.shipment_order?.shipment_id === id);
    const so = pkg ? ds.salesorders.find((r) => r.salesorder_id === pkg.salesorder_id) : undefined;
    const ship = pkg?.shipment_order;
    if (!pkg || !so || !ship) throw notFound('Shipment Order');
    const { phone: _phone, ...billing } = pkg.billing_address;
    const { phone: _phone2, ...shipping } = pkg.shipping_address;
    return {
      code: 0,
      message: 'success',
      shipment_order: {
        salesorder_id: so.salesorder_id,
        salesorder_number: so.salesorder_number,
        shipment_id: ship.shipment_id,
        shipment_number: ship.shipment_number,
        date: ship.shipping_date,
        status: ship.status,
        detailed_status: ship.detailed_status,
        status_message: ship.status === 'delivered' ? 'Delivered' : 'Shipped',
        carrier: ship.carrier,
        service: ship.service,
        delivery_days: ship.delivery_days,
        delivery_guarantee: ship.delivery_guarantee,
        reference_number: so.reference_number,
        customer_id: so.customer_id,
        customer_name: so.customer_name,
        currency_id: so.currency_id,
        currency_code: so.currency_code,
        currency_symbol: so.currency_symbol,
        exchange_rate: so.exchange_rate,
        delivery_method: ship.delivery_method,
        tracking_number: ship.tracking_number,
        line_items: so.line_items.map((l) =>
          pick(l, [
            'item_id',
            'line_item_id',
            'name',
            'description',
            'item_order',
            'bcy_rate',
            'rate',
            'unit',
            'tax_id',
            'tax_name',
            'tax_type',
            'tax_percentage',
            'item_total',
            'is_invoiced',
          ]),
        ),
        shipping_charge: so.shipping_charge,
        sub_total: so.sub_total,
        tax_total: so.tax_total,
        total: so.total,
        taxes: so.taxes,
        price_precision: so.price_precision,
        is_emailed: so.is_emailed,
        // shipmentorders.yml documents both addresses as arrays.
        billing_address: [billing],
        shipping_address: [shipping],
        notes: ship.notes,
        created_time: pkg.created_time,
        last_modified_time: pkg.last_modified_time,
      },
    };
  }

  async function wait(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  const fakeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls += 1;
    const request = input instanceof Request ? input : null;
    const signal = init?.signal ?? request?.signal;
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    await wait(latencyMs, signal);

    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') return json(405, BODY_405, { allow: 'GET' });

    const url = new URL(request ? request.url : input instanceof URL ? input.href : input);
    if (!url.pathname.startsWith(API_PREFIX)) return json(404, BODY_BAD_URL);

    const active = faults();
    const headers = new Headers(init?.headers ?? request?.headers);
    const denied = authorize(headers, active);
    if (denied) return denied;
    const injected = injectFault(active);
    if (injected) return injected;

    const segments = url.pathname
      .slice(API_PREFIX.length)
      .split('/')
      .filter((s) => s !== '');
    try {
      return json(200, route(segments.map(decodeSegment), url.searchParams));
    } catch (e) {
      if (e instanceof HttpFailure) return json(e.status, e.body);
      throw e;
    }
  };

  return {
    fetch: fakeFetch,
    tokens,
    get calls() {
      return calls;
    },
  };
}
