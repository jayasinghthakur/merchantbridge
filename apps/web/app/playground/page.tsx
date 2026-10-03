import type { Metadata } from 'next';
import { DemoBadge } from '../../components/demo-badge';
import { PlaygroundClient } from '../../components/playground-client';

export const metadata: Metadata = {
  title: 'Playground',
  description: 'Watch a real Claude agent call the MerchantBridge MCP server against demo Zoho Inventory data.',
};

export default function PlaygroundPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 pt-6 sm:px-6 sm:pt-8">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Playground</h1>
          <p className="mt-1 max-w-2xl text-[0.9375rem] text-ink-muted">
            A real Claude agent with this connector as its only tools. Pick a scenario, then flip a fault to see how the
            governor and errors behave.
          </p>
        </div>
        <DemoBadge className="self-start sm:self-auto lg:hidden" />
      </div>
      <PlaygroundClient />
    </div>
  );
}
