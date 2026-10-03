import type { ExplorerCallResponse, StatusResponse, ToolsResponse } from '@mb/core/http';
import type { DemoFault, PlaygroundRequest, TraceEvent } from '@mb/core/telemetry';
import type { Page, Route } from '@playwright/test';

export const STATUS: StatusResponse = {
  version: '0.1.0',
  playground_enabled: true,
  model: 'claude-haiku-4-5',
  demo_mcp_url: 'https://api.merchantbridge.test/mcp/demo',
  tool_count: 3,
  turnstile_site_key: null,
  connect_enabled: true,
};

const ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const TOOLS: ToolsResponse = {
  server: { name: 'merchantbridge', version: '0.1.0' },
  tools: [
    {
      name: 'zoho_find_by_payment_reference',
      title: 'Find by payment reference',
      description:
        'Returns the customer payment, invoices and sales orders linked to a Razorpay reference. Use when a user quotes a pay_, order_ or rfnd_ id.',
      inputJsonSchema: {
        type: 'object',
        properties: { reference: { type: 'string', description: 'Exact pay_/order_/rfnd_ id' } },
        required: ['reference'],
        additionalProperties: false,
      },
      outputJsonSchema: { type: 'object' },
      annotations: ANNOTATIONS,
      scopes: ['ZohoInventory.customerpayments.READ', 'ZohoInventory.invoices.READ'],
    },
    {
      name: 'zoho_get_item',
      title: 'Get item',
      description:
        'Returns one item with price and stock per location. Use when you know the item id or exact SKU. Don’t use for fuzzy search (use zoho_search_items instead).',
      inputJsonSchema: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'Exact SKU, e.g. CHAI-250' },
          item_id: { type: 'string' },
          include_locations: { type: 'boolean', default: true },
        },
        additionalProperties: false,
      },
      outputJsonSchema: { type: 'object' },
      annotations: ANNOTATIONS,
      scopes: ['ZohoInventory.items.READ'],
    },
    {
      name: 'zoho_list_invoices',
      title: 'List invoices',
      description: 'Returns invoices filtered by status, customer or due date. Lists return at most 100 rows.',
      inputJsonSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['unpaid', 'overdue', 'paid', 'partially_paid'] },
          due_before: { type: 'string', description: 'ISO date' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          cursor: { type: 'string' },
        },
        additionalProperties: false,
      },
      outputJsonSchema: { type: 'object' },
      annotations: ANNOTATIONS,
      scopes: ['ZohoInventory.invoices.READ'],
    },
  ],
};

export function sseBody(events: TraceEvent[]): string {
  // A heartbeat comment up front exercises the parser's comment handling.
  return `: heartbeat\n\n${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}`;
}

function session(faults: DemoFault[], replay = false): TraceEvent {
  return { type: 'session', session_id: 'e2e', model: 'claude-haiku-4-5', replay, faults };
}

export function disputeEvents(faults: DemoFault[] = []): TraceEvent[] {
  return [
    session(faults),
    { type: 'assistant_text', text: 'Looking up the payment reference first.' },
    {
      type: 'tool_call',
      call_id: 'c1',
      tool: 'zoho_find_by_payment_reference',
      args: { reference: 'pay_DEMO8xK2' },
    },
    {
      type: 'tool_result',
      call_id: 'c1',
      tool: 'zoho_find_by_payment_reference',
      is_error: false,
      error_code: null,
      duration_ms: 184,
      cached: false,
      upstream_calls: 2,
      retries: 0,
      decisions: [
        { type: 'admitted', waited_ms: 0 },
        { type: 'admitted', waited_ms: 12 },
      ],
      budget_remaining_today: 498,
      result: {
        data: { payment: { reference: 'pay_DEMO8xK2' }, invoices: [{ invoice_number: 'INV-00031' }] },
        meta: { as_of: '2026-10-03T09:00:00Z', cached: false, demo: true },
      },
    },
    { type: 'tool_call', call_id: 'c2', tool: 'zoho_get_sales_order', args: { salesorder_id: 'so_31' } },
    {
      type: 'tool_result',
      call_id: 'c2',
      tool: 'zoho_get_sales_order',
      is_error: false,
      error_code: null,
      duration_ms: 9,
      cached: true,
      upstream_calls: 0,
      retries: 0,
      decisions: [{ type: 'cache_hit' }],
      budget_remaining_today: 498,
      result: { data: { salesorder_number: 'SO-00031' } },
    },
    {
      type: 'assistant_text',
      text: '**Evidence pack for `pay_DEMO8xK2`**\n\n- Invoice **INV-00031**, paid in full\n- Sales order SO-00031\n- Shipped via Delhivery, tracking `DLV123456`, delivered on 28 Sep',
    },
    {
      type: 'done',
      stop_reason: 'end_turn',
      tool_calls: 2,
      input_tokens: 4120,
      output_tokens: 211,
      duration_ms: 4380,
    },
  ];
}

export function rateLimitedEvents(faults: DemoFault[]): TraceEvent[] {
  return [
    session(faults),
    { type: 'tool_call', call_id: 'c1', tool: 'zoho_get_item', args: { sku: 'CHAI-250' } },
    {
      type: 'tool_result',
      call_id: 'c1',
      tool: 'zoho_get_item',
      is_error: true,
      error_code: 'RATE_LIMITED',
      duration_ms: 512,
      cached: false,
      upstream_calls: 1,
      retries: 0,
      decisions: [
        { type: 'admitted', waited_ms: 0 },
        { type: 'circuit_open', until_ms: 60_000, reason: 'zoho code 44' },
      ],
      budget_remaining_today: 497,
      result: {
        error: {
          code: 'RATE_LIMITED',
          message: 'Zoho is rate limiting this organization.',
          retryable: true,
          retry_after_s: 60,
        },
      },
    },
    {
      type: 'assistant_text',
      text: 'Zoho is temporarily rate limiting this organization, so I could not check stock. Please retry in about a minute.',
    },
    { type: 'done', stop_reason: 'end_turn', tool_calls: 1, input_tokens: 2100, output_tokens: 60, duration_ms: 2100 },
  ];
}

export function refusalEvents(): TraceEvent[] {
  return [
    session([]),
    {
      type: 'assistant_text',
      text: 'I can’t do that. This connector is **read-only**: it can look up SO-00012 and its invoice, but it cannot cancel orders or record payments.',
    },
    { type: 'done', stop_reason: 'end_turn', tool_calls: 0, input_tokens: 1500, output_tokens: 48, duration_ms: 1200 },
  ];
}

export type PlaygroundHandler = (req: PlaygroundRequest, route: Route) => Promise<void>;

export const scriptedPlayground: PlaygroundHandler = async (req, route) => {
  let events: TraceEvent[];
  if (req.scenario_id === 'refuse-write') events = refusalEvents();
  else if (req.faults.includes('rate_limit_44')) events = rateLimitedEvents(req.faults);
  else events = disputeEvents(req.faults);
  await route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    body: sseBody(events),
  });
};

export const EXPLORER_RESPONSE: ExplorerCallResponse = {
  request: {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'zoho_get_item', arguments: { sku: 'CHAI-250' } },
  },
  // Same shape the real API returns: the trace _meta and the text copy come before structuredContent.
  response: {
    jsonrpc: '2.0',
    id: 1,
    result: {
      _meta: {
        'dev.merchantbridge/trace': {
          decisions: [{ type: 'admitted', waited_ms: 0 }],
          upstream_calls: 1,
          retries: 0,
          cache_hits: 0,
          duration_ms: 12,
          budget_remaining_today: 499,
        },
      },
      content: [
        { type: 'text', text: '{"data":{"sku":"CHAI-250","name":"Masala Chai 250g"},"meta":{"demo":true}}' },
      ],
      isError: false,
      structuredContent: {
        data: { sku: 'CHAI-250', name: 'Masala Chai 250g', rate: { amount_minor: 18000, currency: 'INR' } },
        meta: { organization_id: 'demo', as_of: '2026-10-03T09:00:00Z', cached: false, demo: true },
      },
    },
  },
  duration_ms: 37,
  decisions: [{ type: 'admitted', waited_ms: 0 }],
};

export interface MockOptions {
  status?: Partial<StatusResponse>;
  playground?: PlaygroundHandler;
  tools?: ToolsResponse | 'error';
  /** Captures the last playground request body for assertions. */
  onPlaygroundRequest?: (req: PlaygroundRequest) => void;
}

export async function mockApi(page: Page, opts: MockOptions = {}): Promise<void> {
  await page.route('**/__mockapi/api/status', (route) =>
    route.fulfill({ json: { ...STATUS, ...opts.status } }),
  );
  await page.route('**/__mockapi/api/tools', (route) =>
    opts.tools === 'error'
      ? route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'API is restarting' } } })
      : route.fulfill({ json: opts.tools ?? TOOLS }),
  );
  await page.route('**/__mockapi/api/explorer/call', (route) => route.fulfill({ json: EXPLORER_RESPONSE }));
  await page.route('**/__mockapi/api/playground', async (route) => {
    const req = route.request().postDataJSON() as PlaygroundRequest;
    opts.onPlaygroundRequest?.(req);
    await (opts.playground ?? scriptedPlayground)(req, route);
  });
}
