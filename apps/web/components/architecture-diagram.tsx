import type { ReactNode } from 'react';
import { ArrowDownIcon } from './icons';
import { LiveToolCount } from './live-tool-count';

function Box({
  title,
  children,
  tone = 'plain',
}: {
  title: string;
  children?: ReactNode;
  tone?: 'plain' | 'brand' | 'muted';
}) {
  const tones = {
    plain: 'border-line-strong bg-raised',
    brand: 'border-brand/50 bg-brand-soft',
    muted: 'border-dashed border-line-strong bg-surface',
  } as const;
  return (
    <div className={`min-w-0 rounded-md border px-3 py-2.5 ${tones[tone]}`}>
      <p className="text-sm font-bold text-ink">{title}</p>
      {children ? <div className="mt-0.5 text-xs leading-relaxed text-ink-muted">{children}</div> : null}
    </div>
  );
}

function Down({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-1.5 text-xs text-ink-subtle">
      <ArrowDownIcon size={14} />
      <span className="font-mono">{label}</span>
    </div>
  );
}

/** Compact request path: agents → MCP door → ToolRuntime → governor → Zoho or FakeZoho. */
export function ArchitectureDiagram() {
  return (
    <figure
      aria-label="Architecture: agents call the MerchantBridge MCP server, which reads Zoho Inventory through a rate governor"
      className="mb-card p-4 sm:p-5"
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <Box title="Merchant agents">Claude Code, Agent SDK, Messages API, Claude.ai</Box>
        <Box title="This site" tone="muted">
          The playground runs a real agent and the explorer calls tools directly, both on the demo tenant
        </Box>
      </div>
      <Down label="POST /mcp (Bearer mb_live_) · /mcp/demo" />
      <div className="rounded-lg border border-brand/50 p-2.5 sm:p-3">
        <p className="px-1 pb-2 text-xs font-semibold tracking-[0.12em] text-brand-ink uppercase">
          MerchantBridge API
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          <Box title="MCP server" tone="brand">
            Stateless Streamable HTTP; <LiveToolCount /> read-only tools, no write tools
          </Box>
          <Box title="ToolRuntime" tone="brand">
            Zod in and out, PII masking, untrusted text, 10K-token cap, one usage event per call
          </Box>
          <Box title="Rate governor" tone="brand">
            80/min, concurrency leases, daily share, circuit on code 44, short-TTL cache
          </Box>
        </div>
      </div>
      <Down label="GET only · ZohoInventory.*.READ" />
      <div className="grid gap-2 sm:grid-cols-2">
        <Box title="Zoho Inventory">Live tenants, per-DC api_domain, encrypted refresh tokens</Box>
        <Box title="FakeZoho" tone="muted">
          Demo tenant: wire-accurate fake upstream with injectable faults
        </Box>
      </div>
    </figure>
  );
}
