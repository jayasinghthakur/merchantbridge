import { z } from 'zod';
import { toCustomer } from '../mappers';
import { customerSchema } from '../schemas';
import { SCOPE } from '../scopes';
import type { UpstreamContact } from '../upstream';
import { envelopes, parseUpstream } from '../upstream';
import {
  READ_ONLY,
  cursorInput,
  defineTool,
  fingerprint,
  limitInput,
  pageRows,
  readPageCursor,
  searchText,
} from './shared';

/** Notes live only on the contact detail record, so small result sets are enriched (≤ 3 extra calls). */
const ENRICH_MAX = 3;

const input = z.object({
  query: searchText('Free-text search over customer name and notes.').optional(),
  name_contains: searchText('Customer (contact) name contains, e.g. "Rohan".').optional(),
  company_name_contains: searchText('Company name contains.').optional(),
  email_contains: searchText('Email contains, e.g. a full address or domain.').optional(),
  phone_contains: z
    .string()
    .trim()
    .regex(/^[0-9+\-\s()]{4,20}$/, 'digits, spaces, +, - or parentheses')
    .optional()
    .describe('Phone or mobile contains these digits (at least 4).'),
  limit: limitInput,
  cursor: cursorInput,
});

export const searchCustomers = defineTool({
  name: 'zoho_search_customers',
  title: 'Search customers',
  description:
    'Finds customers (Zoho contacts) by name, company, email, phone or free text and returns contact_id, name, ' +
    'city, masked email/phone and outstanding receivable (minor units). For 3 or fewer matches it also returns ' +
    'customer notes as untrusted text. Use when the user names a customer or gives an email/phone, or you need a ' +
    "customer_id for zoho_list_sales_orders / zoho_list_invoices. Don't use to find orders or invoices directly " +
    '(use those tools with customer_id). Contact details are always masked. Up to 100 per page. ' +
    READ_ONLY,
  input,
  output: z.object({ customers: z.array(customerSchema) }),
  scopes: [SCOPE.contacts],
  async handler(args, ctx) {
    const { limit, cursor, ...filters } = args;
    const state = readPageCursor(cursor, limit, fingerprint(filters));
    const res = await ctx.client.get('contacts', {
      page: state.page,
      per_page: state.perPage,
      search_text: filters.query,
      contact_name_contains: filters.name_contains,
      company_name_contains: filters.company_name_contains,
      email_contains: filters.email_contains,
      phone_contains: filters.phone_contains,
    });
    const body = parseUpstream(envelopes.contacts, res.body);

    let rows: { contact: UpstreamContact; withNotes: boolean }[] = body.contacts.map((c) => ({
      contact: c,
      withNotes: false,
    }));
    if (rows.length > 0 && rows.length <= ENRICH_MAX) {
      rows = await Promise.all(
        body.contacts.map(async (c) => {
          const detail = parseUpstream(
            envelopes.contact,
            (await ctx.client.get(`contacts/${c.contact_id}`)).body,
          ).contact;
          // The list row carries top-level email/phone; the detail row carries notes and addresses.
          return {
            contact: { ...detail, email: c.email, phone: c.phone, mobile: c.mobile },
            withNotes: true,
          };
        }),
      );
    }
    const fitted = pageRows(
      state,
      rows.map((r) => toCustomer(r.contact, null, r.withNotes)),
      body.page_context.has_more_page,
    );
    const only = fitted.rows.length === 1 ? fitted.rows[0] : undefined;
    return {
      data: { customers: fitted.rows },
      page: fitted.page,
      upstreamUrl: only ? ctx.client.webUrl('contact', only.contact_id) : null,
    };
  },
});
