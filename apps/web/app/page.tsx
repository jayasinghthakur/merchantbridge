import Link from 'next/link';
import { ArchitectureDiagram } from '../components/architecture-diagram';
import { ArrowRightIcon, LockIcon } from '../components/icons';
import { McpDemoCommand } from '../components/mcp-command';
import { buttonClass, InlineCode, SectionHeading } from '../components/ui';
import { STATIC_TOOLS } from '../lib/tools-fallback';

const JOURNEY: { title: string; body: string }[] = [
  {
    title: 'Open the playground',
    body: 'No login. Pick a scenario card modeled on an Agent Studio launch agent.',
  },
  {
    title: 'Watch a real agent work',
    body: 'Claude calls the MCP server; the trace shows each tool, its args, latency, cache hits, governor decisions and budget left.',
  },
  {
    title: 'Break Zoho on purpose',
    body: 'Flip "Zoho 429 (code 44)" or "Expired token" and see the backoff, the circuit, and a structured RATE_LIMITED result.',
  },
  {
    title: 'Ask it to change data',
    body: 'The refusal card makes zero tool calls: there are no write tools to call.',
  },
  {
    title: 'Plug it into your own Claude',
    body: 'Copy one command and the same demo server shows up in Claude Code or as a Claude.ai custom connector.',
  },
];

const PRINCIPLES: { principle: string; feature: string }[] = [
  {
    principle: 'Review first',
    feature: 'Read-only by construction: GET-only client, READ scopes only, no write tools exist.',
  },
  {
    principle: 'Verified first-party data',
    feature: 'Every result carries as_of and a zoho_url deep link so a human can check the claim.',
  },
  {
    principle: 'Validation layer',
    feature: 'Zod schemas on input and output, scope checks, email and phone masking, free text fenced as untrusted.',
  },
  {
    principle: 'Audit trail',
    feature: 'Exactly one usage event per tool call, success or error, with masked arguments.',
  },
  {
    principle: 'Data stays put',
    feature: 'No mirroring of merchant data; only a short-TTL cache keyed by tenant.',
  },
];

export default function HomePage() {
  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      <section className="grid gap-10 pt-12 pb-14 sm:pt-16 lg:grid-cols-[1.15fr_1fr] lg:items-center lg:gap-12">
        <div className="min-w-0">
          <p className="inline-flex items-center gap-2 rounded-sm border border-line bg-raised px-2 py-1 text-xs font-semibold text-ink-muted">
            <LockIcon size={13} className="text-brand-ink" />
            Read-only MCP server · Zoho Inventory
          </p>
          <h1 className="mt-4 text-[2rem] leading-[1.12] font-extrabold tracking-tight text-balance text-ink sm:text-5xl">
            A private Agent Studio-style connector for Zoho Inventory
          </h1>
          <p className="mt-4 max-w-xl text-lg leading-relaxed text-ink-muted">
            One-time OAuth, available to every agent the merchant runs, scoped to their organization, read-only by
            construction, and audited call by call.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link href="/playground" className={buttonClass('primary')}>
              Try it in the playground
              <ArrowRightIcon size={16} />
            </Link>
            <Link href="/docs" className={buttonClass('secondary')}>
              Read the docs
            </Link>
          </div>
        </div>
        <div className="mb-card min-w-0 p-4 sm:p-5">
          <p className="text-sm font-semibold text-ink">Use it from your agent</p>
          <p className="mt-1 mb-3 text-sm text-ink-muted">
            The public demo server runs against synthetic data for <InlineCode>Chai &amp; Co (DEMO)</InlineCode>.
          </p>
          <McpDemoCommand />
          <p className="mt-3 text-xs text-ink-subtle">
            Then ask: “Is CHAI-250 in stock in Bengaluru, and at what price?”
          </p>
        </div>
      </section>

      <section aria-labelledby="journey" className="border-t border-line py-14">
        <SectionHeading id="journey" eyebrow="3-minute tour" title="What a reviewer sees">
          Everything below runs live against the demo tenant, with no account.
        </SectionHeading>
        <ol className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {JOURNEY.map((step, i) => (
            <li key={step.title} className="mb-card flex gap-3 p-4 lg:flex-col">
              <span
                aria-hidden="true"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-brand-soft font-mono text-sm font-bold text-brand-ink"
              >
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="font-semibold text-ink">{step.title}</p>
                <p className="mt-1 text-sm leading-relaxed text-ink-muted">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="principles" className="border-t border-line py-14">
        <SectionHeading id="principles" eyebrow="Agent Studio principles" title="Principle, then the feature that enforces it">
          Agent Studio publishes its guardrails; this connector maps each one to something the server does, not something
          the prompt asks for.
        </SectionHeading>
        <div className="mb-card mt-8 overflow-hidden">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-sunken text-xs tracking-wide text-ink-subtle uppercase">
              <tr>
                <th scope="col" className="w-[34%] px-4 py-2.5 font-semibold">
                  Principle
                </th>
                <th scope="col" className="px-4 py-2.5 font-semibold">
                  How MerchantBridge enforces it
                </th>
              </tr>
            </thead>
            <tbody>
              {PRINCIPLES.map((row) => (
                <tr key={row.principle} className="border-t border-line align-top">
                  <th scope="row" className="px-4 py-3 font-semibold text-ink">
                    {row.principle}
                  </th>
                  <td className="px-4 py-3 leading-relaxed text-ink-muted">{row.feature}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="architecture" className="grid gap-8 border-t border-line py-14 lg:grid-cols-[1fr_1.4fr]">
        <SectionHeading id="architecture" eyebrow="Architecture" title="One thin door, one governed path to Zoho">
          MCP is only the door. Every tool runs through the same runtime and every Zoho request goes through the rate
          governor, so the public demo exercises exactly what a merchant’s agents would.
        </SectionHeading>
        <ArchitectureDiagram />
      </section>

      <section aria-labelledby="tools" className="border-t border-line py-14">
        <SectionHeading id="tools" eyebrow="Tool surface" title={`${STATIC_TOOLS.length} read-only tools`}>
          Lists return at most 100 rows with an opaque cursor; every result stays under 10K tokens. Money comes back in
          minor units so it compares directly with Razorpay amounts.
        </SectionHeading>
        <ul className="mt-8 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {STATIC_TOOLS.map((t) => (
            <li key={t.name} className="mb-card min-w-0 p-3.5">
              <p className="truncate font-mono text-[13px] font-medium text-brand-ink" title={t.name}>
                {t.name}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-ink-muted">{t.summary}</p>
            </li>
          ))}
        </ul>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/tools" className={buttonClass('secondary')}>
            Explore schemas and raw JSON-RPC
          </Link>
          <Link href="/docs" className={buttonClass('ghost')}>
            What it can and cannot do
          </Link>
        </div>
      </section>

      <section className="mb-card mt-2 flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-lg font-bold tracking-tight">See it answer a dispute in one turn</p>
          <p className="mt-1 text-sm text-ink-muted">
            Payment reference to invoice to sales order to tracking number, with the trace open.
          </p>
        </div>
        <Link href="/playground" className={buttonClass('primary')}>
          Open the playground
          <ArrowRightIcon size={16} />
        </Link>
      </section>
    </div>
  );
}
