import type { ConnectErrorReason } from '@mb/core/http';
import { API_ROUTES } from '@mb/core/http';
import { API_BASE_URL, LIVE_MCP_URL } from './config';

export const ZOHO_DCS = [
  { id: 'in', label: 'India (zoho.in)' },
  { id: 'us', label: 'United States (zoho.com)' },
  { id: 'eu', label: 'Europe (zoho.eu)' },
  { id: 'au', label: 'Australia (zoho.com.au)' },
  { id: 'jp', label: 'Japan (zoho.jp)' },
  { id: 'ca', label: 'Canada (zohocloud.ca)' },
  { id: 'sa', label: 'Saudi Arabia (zoho.sa)' },
] as const;

export type ZohoDc = (typeof ZOHO_DCS)[number]['id'];

export const CONNECT_SCOPES = [
  'ZohoInventory.settings.READ',
  'ZohoInventory.items.READ',
  'ZohoInventory.salesorders.READ',
  'ZohoInventory.invoices.READ',
  'ZohoInventory.contacts.READ',
  'ZohoInventory.packages.READ',
  'ZohoInventory.shipmentorders.READ',
  'ZohoInventory.customerpayments.READ',
] as const;

export function oauthStartUrl(dc: ZohoDc, invite: string): string {
  const q = new URLSearchParams({ dc, invite: invite.trim() });
  return `${API_BASE_URL}${API_ROUTES.oauthStart}?${q.toString()}`;
}

export interface ConnectResult {
  key: string;
  org: string | null;
  dc: string | null;
}

/** Parses `#key=…&org=…&dc=…` from the OAuth success redirect. Returns null when no live key is present. */
export function parseConnectHash(hash: string): ConnectResult | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const key = params.get('key');
  if (!key || !key.startsWith('mb_live_')) return null;
  return { key, org: params.get('org'), dc: params.get('dc') };
}

export function claudeCodeCommand(key: string, mcpUrl: string = LIVE_MCP_URL): string {
  return `claude mcp add --transport http merchantbridge ${mcpUrl} --header "Authorization: Bearer ${key}"`;
}

export function agentSdkConfig(key: string, mcpUrl: string = LIVE_MCP_URL): string {
  return JSON.stringify(
    {
      mcpServers: {
        merchantbridge: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${key}` } },
      },
      allowedTools: ['mcp__merchantbridge__*'],
    },
    null,
    2,
  );
}

const MESSAGES: Record<ConnectErrorReason, { title: string; body: string }> = {
  invalid_invite: {
    title: 'That invite code is not valid',
    body: 'Connecting a real organization is invite-only during this preview. Check the code, or use the public demo.',
  },
  invalid_state: {
    title: 'The sign-in link expired',
    body: 'The authorization took longer than 10 minutes or the link was reused. Start again from the connect page.',
  },
  access_denied: {
    title: 'Access was not granted',
    body: 'The Zoho consent screen was cancelled, so nothing was connected. You can start again at any time.',
  },
  exchange_failed: {
    title: 'Zoho did not accept the authorization',
    body: 'Zoho codes are valid for 60 seconds; the exchange likely timed out. Try connecting again.',
  },
  no_organization: {
    title: 'No Zoho Inventory organization found',
    body: 'The Zoho account you signed in with has no Inventory organization. Sign in with the account that owns it.',
  },
  unsupported_dc: {
    title: 'That Zoho data center is not supported',
    body: 'Pick the region your Zoho account lives in (the domain you sign in on) and try again.',
  },
  dc_mismatch: {
    title: 'Your Zoho account is in a different region',
    body: 'The region you picked does not match where your Zoho account lives. Pick the region of the domain you sign in on (for example zoho.in for India) and try again.',
  },
  internal: {
    title: 'Something went wrong on our side',
    body: 'Nothing was stored. Try again in a minute.',
  },
};

export function connectErrorMessage(reason: string | null | undefined): { title: string; body: string } {
  if (reason && Object.hasOwn(MESSAGES, reason)) return MESSAGES[reason as ConnectErrorReason];
  return MESSAGES.internal;
}
