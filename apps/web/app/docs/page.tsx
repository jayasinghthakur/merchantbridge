import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { CheckIcon, LockIcon } from '../../components/icons';
import { IntegrationSnippets } from '../../components/integration-snippets';
import { LiveToolTable } from '../../components/live-tool-table';
import { InlineCode, SectionHeading } from '../../components/ui';
import { REPO_URL } from '../../lib/config';

export const metadata: Metadata = {
  title: 'Docs',
  description: 'What the MerchantBridge connector can and cannot do, its tools, limits, and how to plug it into Claude.',
};

const CAN: ReactNode[] = [
  <>Look up items by id or exact SKU, with price and stock per warehouse location.</>,
  <>Fetch a sales order with its line items, packages, tracking numbers and invoices in one call.</>,
  <>Search customers by name, company, email or phone, and list their sales orders and invoices.</>,
  <>List invoices by status, customer or due date, with balances in minor units.</>,
  <>
    Trace a Razorpay reference (<InlineCode>pay_</InlineCode>, <InlineCode>order_</InlineCode>,{' '}
    <InlineCode>rfnd_</InlineCode>) to the payment, invoice and sales order it settled.
  </>,
  <>Report its own connection: organization, data center, plan, granted scopes, budget left and circuit state.</>,
  <>
    Page through lists with an opaque cursor: <InlineCode>limit</InlineCode> defaults to 20, max 100.
  </>,
  <>
    Attach <InlineCode>as_of</InlineCode> and a <InlineCode>zoho_url</InlineCode> deep link to every result so a person
    can verify it.
  </>,
];

const CANNOT: ReactNode[] = [
  <>Create, edit, cancel or delete anything. It requests only READ scopes, its client issues GET only, and no write tool exists.</>,
  <>
    Search sales orders freely. Zoho documents no filters on <InlineCode>/salesorders</InlineCode>, so the connector
    uses bounded fallbacks (customer lookups, packages, at most 3 pages × 200) and says when a scan was partial.
  </>,
  <>Return unbounded data. Lists stop at 100 rows and every result stays under about 10K tokens.</>,
  <>Show raw customer email or phone numbers; they come back masked.</>,
  <>
    Take instructions from merchant data. Notes and descriptions are wrapped as <InlineCode>untrusted_text</InlineCode>{' '}
    so an agent treats them as data.
  </>,
  <>Use more than its share of the merchant’s Zoho quota (see rate limits below).</>,
];

const NEVER: string[] = [
  'Mirror merchant data into its own database; only a short-TTL cache keyed by tenant.',
  'Pass Zoho tokens to an agent, or store a refresh token unencrypted.',
  'Log tokens, auth codes, client secrets or unmasked contact details.',
  'Let the public demo touch a real Zoho organization.',
];

const RATE_LIMITS: { label: string; body: ReactNode }[] = [
  { label: 'Per minute', body: <>80 requests per organization, below Zoho’s 100/min hard limit.</> },
  { label: 'Concurrency', body: <>Leases of 4 in-flight calls on the free plan, 8 on paid plans (Zoho allows 5 / 10).</> },
  { label: 'Daily share', body: <>At most 50% of the plan’s daily quota, leaving the rest for the merchant’s other integrations.</> },
  { label: 'Code 44', body: <>Zoho blocked the org for the minute: a 60 s circuit opens and calls fail fast with RATE_LIMITED and retry_after_s.</> },
  { label: 'Code 45', body: <>Daily quota exhausted: DAILY_QUOTA_EXHAUSTED, never retried until the UTC-midnight reset.</> },
  { label: 'Code 1070', body: <>Concurrency exceeded: requeued with jittered backoff.</> },
  { label: '5xx / timeout', body: <>Up to two retries, 10 s per attempt; a call queues at most 10 s before RATE_LIMITED.</> },
];

const SECURITY: ReactNode[] = [
  <>Two separate credentials: the merchant authorizes Zoho once with OAuth; agents use a per-tenant <InlineCode>mb_live_</InlineCode> key that is shown once and stored only as a SHA-256 hash.</>,
  <>Zoho refresh tokens are encrypted with AES-256-GCM; access tokens refresh single-flight, so twenty parallel calls cause one token request.</>,
  <>Every tool call writes exactly one usage event (tool, status, error code, latency, masked arguments), success or failure.</>,
  <>Tenant id is part of every database row, cache key and governor key.</>,
  <>Errors are tool results with <InlineCode>isError: true</InlineCode> and a code, message, retryable flag and hint, so an agent can recover instead of crashing.</>,
];

function Card({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-card min-w-0 p-5">
      <h3 className="flex items-center gap-2 text-base font-bold">
        {icon}
        {title}
      </h3>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Bullets({ items, tone }: { items: ReactNode[]; tone: 'can' | 'cannot' }) {
  return (
    <ul className="space-y-2.5 text-sm leading-relaxed text-ink-muted">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5">
          <span
            aria-hidden="true"
            className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${tone === 'can' ? 'bg-brand' : 'bg-danger'}`}
          />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  );
}

export default function DocsPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 pt-6 sm:px-6 sm:pt-8">
      <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Docs</h1>
      <p className="mt-1 max-w-2xl text-[0.9375rem] text-ink-muted">
        What an agent gets when it connects, the limits it runs under, and copy-paste setup for every Claude surface.
      </p>
      <nav aria-label="On this page" className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm font-semibold text-brand-ink">
        <a href="#capabilities">Can / cannot</a>
        <a href="#tools">Tools</a>
        <a href="#integrate">Integrate</a>
        <a href="#rate-limits">Rate limits</a>
        <a href="#security">Security</a>
      </nav>

      <section aria-labelledby="capabilities" className="pt-12">
        <SectionHeading id="capabilities" eyebrow="Capabilities" title="What it can and cannot do">
          Nine read-only tools over one Zoho Inventory organization. The limits are enforced by the server, not by the
          prompt.
        </SectionHeading>
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <Card title="Can" icon={<CheckIcon size={18} className="text-brand-ink" />}>
            <Bullets items={CAN} tone="can" />
          </Card>
          <Card title="Cannot" icon={<LockIcon size={18} className="text-danger" />}>
            <Bullets items={CANNOT} tone="cannot" />
          </Card>
        </div>
        <div className="mb-card mt-4 p-5">
          <h3 className="text-base font-bold">Never does</h3>
          <ul className="mt-3 grid gap-2 text-sm text-ink-muted sm:grid-cols-2">
            {NEVER.map((n) => (
              <li key={n} className="flex gap-2.5">
                <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-ink-subtle" />
                <span>{n}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="tools" className="pt-14">
        <SectionHeading id="tools" eyebrow="Reference" title="Tools">
          Server name <InlineCode>merchantbridge</InlineCode>, so agents see <InlineCode>mcp__merchantbridge__zoho_*</InlineCode>.
          Every result uses the same envelope: <InlineCode>data</InlineCode>, <InlineCode>page</InlineCode> and{' '}
          <InlineCode>meta</InlineCode>.
        </SectionHeading>
        <div className="mt-6">
          <LiveToolTable />
        </div>
      </section>

      <section aria-labelledby="integrate" className="pt-14">
        <SectionHeading id="integrate" eyebrow="Integrate" title="Use it from Claude">
          The demo server needs no key. A connected organization uses the bearer key from the connect flow.
        </SectionHeading>
        <div className="mt-8">
          <IntegrationSnippets />
        </div>
      </section>

      <section aria-labelledby="rate-limits" className="pt-14">
        <SectionHeading id="rate-limits" eyebrow="Rate governor" title="Sharing the merchant’s Zoho quota">
          Zoho limits each organization, not each app, so every agent and integration shares one budget. The governor
          keeps this connector well inside it. Block duration and daily reset time are undocumented by Zoho; the values
          below are the connector’s defaults.
        </SectionHeading>
        <dl className="mb-card mt-6 divide-y divide-line">
          {RATE_LIMITS.map((r) => (
            <div key={r.label} className="grid gap-1 px-4 py-3 sm:grid-cols-[150px_1fr] sm:gap-4">
              <dt className="text-sm font-semibold text-ink">{r.label}</dt>
              <dd className="text-sm leading-relaxed text-ink-muted">{r.body}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="security" className="pt-14">
        <SectionHeading id="security" eyebrow="Security" title="Security notes" />
        <ul className="mt-6 space-y-2.5 text-sm leading-relaxed text-ink-muted">
          {SECURITY.map((s, i) => (
            <li key={i} className="flex gap-2.5">
              <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
              <span className="min-w-0">{s}</span>
            </li>
          ))}
        </ul>
        {REPO_URL ? (
          <p className="mt-6 text-sm">
            Source:{' '}
            <a className="font-semibold text-brand-ink underline" href={REPO_URL} rel="noopener noreferrer" target="_blank">
              {REPO_URL.replace(/^https?:\/\//, '')}
            </a>
          </p>
        ) : null}
      </section>
    </div>
  );
}
