import type { Metadata } from 'next';
import { DemoBadge } from '../../components/demo-badge';
import { ToolsExplorer } from '../../components/tools-explorer';

export const metadata: Metadata = {
  title: 'Tool explorer',
  description: 'Every MerchantBridge MCP tool with its schema, and the raw JSON-RPC exchange against the demo server.',
};

export default function ToolsPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 pt-6 sm:px-6 sm:pt-8">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Tool explorer</h1>
          <p className="mt-1 max-w-2xl text-[0.9375rem] text-ink-muted">
            Call any tool directly, without a model. You see exactly what an MCP client sends to{' '}
            <code className="font-mono text-[0.9em]">/mcp/demo</code> and what comes back.
          </p>
        </div>
        <DemoBadge className="self-start sm:self-auto" />
      </div>
      <ToolsExplorer />
    </div>
  );
}
