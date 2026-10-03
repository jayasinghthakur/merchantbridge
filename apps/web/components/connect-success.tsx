'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ConnectResult } from '../lib/connect';
import { agentSdkConfig, claudeCodeCommand, parseConnectHash } from '../lib/connect';
import { CodeBlock } from './code-block';
import { useLiveMcpUrl } from './mcp-command';
import { buttonClass, EmptyState, Loading, Notice } from './ui';

type State = { kind: 'reading' } | { kind: 'ready'; result: ConnectResult } | { kind: 'empty' };

/** The heading follows the state: only a page that actually holds a fresh key may say "connected". */
function Header({ connected }: { connected: boolean }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">
        {connected ? 'Zoho Inventory connected' : 'Your MerchantBridge key'}
      </h1>
      <p className="mt-1 text-[0.9375rem] text-ink-muted">
        {connected
          ? 'Your organization is now available to any agent that holds this key, read-only.'
          : 'A key is shown here once, right after you connect a Zoho Inventory organization.'}
      </p>
    </div>
  );
}

export function ConnectSuccess() {
  const [state, setState] = useState<State>({ kind: 'reading' });
  const mcpUrl = useLiveMcpUrl();

  useEffect(() => {
    const result = parseConnectHash(window.location.hash);
    if (result) {
      // The key lives only in the fragment (never sent to servers); drop it from the URL and history right away.
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      setState({ kind: 'ready', result });
    } else {
      // Strict-mode re-runs find the hash already cleared; keep the key that was read first.
      setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'empty' }));
    }
  }, []);

  if (state.kind === 'reading') {
    return (
      <>
        <Header connected={false} />
        <Loading label="Reading your key…" />
      </>
    );
  }

  if (state.kind === 'empty') {
    return (
      <>
        <Header connected={false} />
        <EmptyState title="There is no key to show">
          Keys are displayed once, right after connecting, and this page has already been used or opened without
          one. Connect again to mint a new key.
          <div className="mt-4">
            <Link href="/connect" className={buttonClass('secondary', 'sm')}>
              Back to connect
            </Link>
          </div>
        </EmptyState>
      </>
    );
  }

  const { key, org, dc } = state.result;
  return (
    <div className="space-y-6">
      <Header connected />
      <Notice tone="warn" title="Copy your key now: it will not be shown again" testId="key-once-warning">
        MerchantBridge stores only a hash of this key. If you lose it, connect again to mint a new one.
      </Notice>
      <dl className="mb-card grid gap-3 p-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-semibold text-ink-subtle">Organization</dt>
          <dd className="mt-0.5 font-semibold break-words">{org ?? 'Connected organization'}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold text-ink-subtle">Zoho data center</dt>
          <dd className="mt-0.5 font-mono">{dc ?? 'unknown'}</dd>
        </div>
      </dl>
      <div className="space-y-2">
        <h2 className="text-sm font-bold">API key</h2>
        <CodeBlock code={key} label="mb_live_ key" copyLabel="Copy API key" wrap testId="api-key" />
      </div>
      <div className="space-y-2">
        <h2 className="text-sm font-bold">Claude Code</h2>
        <CodeBlock code={claudeCodeCommand(key, mcpUrl)} label="Terminal" wrap />
      </div>
      <div className="space-y-2">
        <h2 className="text-sm font-bold">Claude Agent SDK options</h2>
        <CodeBlock code={agentSdkConfig(key, mcpUrl)} label="options" />
      </div>
    </div>
  );
}
