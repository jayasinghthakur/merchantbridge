import { isConnectorError } from '@mb/core';
import { z } from 'zod';
import { SCOPE, ZOHO_SCOPES } from '../scopes';
import { envelopes, parseUpstream } from '../upstream';
import { READ_ONLY, defineTool } from './shared';

const output = z.object({
  mode: z.enum(['demo', 'live']),
  dc: z.string().describe('Zoho data center, e.g. "in", "us", "eu".'),
  organization: z
    .object({
      organization_id: z.string(),
      name: z.string().nullable(),
      currency_code: z.string().nullable(),
      time_zone: z.string().nullable(),
    })
    .nullable(),
  plan: z.string().nullable(),
  scopes_granted: z.array(z.string()),
  scopes_missing: z.array(z.string()),
  upstream: z.object({
    reachable: z.boolean(),
    error_code: z
      .string()
      .nullable()
      .describe('Error code when Zoho could not be reached, e.g. RECONNECT_REQUIRED.'),
  }),
  governor: z.object({
    budget_remaining_today: z
      .number()
      .describe('Upstream calls this connector may still make today.'),
    daily_budget: z.number(),
    used_this_minute: z.number(),
    in_flight: z.number(),
    circuit: z.enum(['closed', 'open', 'half_open']),
    circuit_open_until: z.string().nullable(),
  }),
  read_only: z.literal(true),
});

export const getConnectionStatus = defineTool({
  name: 'zoho_get_connection_status',
  title: 'Zoho connection status',
  description:
    'Returns the health of the Zoho Inventory connection: organization name and currency, data center, plan, ' +
    'granted and missing scopes, whether Zoho is reachable, and the rate governor state (calls left today, ' +
    'circuit breaker). Use when another tool returned RECONNECT_REQUIRED, RATE_LIMITED or ' +
    "DAILY_QUOTA_EXHAUSTED, or the user asks which Zoho org is connected. Don't use to look up business data " +
    `(use the search/list/get tools instead). Costs 1 live upstream call (never cached). ${READ_ONLY}`,
  input: z.object({}),
  output,
  scopes: [SCOPE.settings],
  async handler(_args, ctx) {
    const client = ctx.client;
    const info = client.info();
    let organization: z.output<typeof output>['organization'] = null;
    let errorCode: string | null = null;
    try {
      // Deliberately uncached: a cached organization read says nothing about whether Zoho is reachable now,
      // and this tool is what agents call right after RECONNECT_REQUIRED / RATE_LIMITED.
      const res = await client.get(`organizations/${client.organizationId}`);
      const org = parseUpstream(envelopes.organization, res.body).organization;
      organization = {
        organization_id: org.organization_id,
        name: org.name,
        currency_code: org.currency_code,
        time_zone: org.time_zone,
      };
    } catch (e) {
      // A status tool reports the failure as data instead of failing itself.
      errorCode = isConnectorError(e) ? e.code : 'UPSTREAM_ERROR';
    }
    const snap = await client.snapshot();
    const granted = [...info.scopes];
    return {
      data: {
        mode: info.mode,
        dc: info.dc,
        organization:
          organization ??
          (info.organizationName === null
            ? null
            : {
                organization_id: client.organizationId,
                name: info.organizationName,
                currency_code: null,
                time_zone: null,
              }),
        plan: info.plan,
        scopes_granted: granted,
        scopes_missing: ZOHO_SCOPES.filter((s) => !granted.includes(s)),
        upstream: { reachable: errorCode === null, error_code: errorCode },
        governor: {
          budget_remaining_today: snap.budget_remaining_today,
          daily_budget: snap.daily_budget,
          used_this_minute: snap.used_this_minute,
          in_flight: snap.in_flight,
          circuit: snap.circuit,
          circuit_open_until: snap.circuit_open_until ?? null,
        },
        read_only: true as const,
      },
      upstreamUrl: client.webUrl('organization'),
    };
  },
});
