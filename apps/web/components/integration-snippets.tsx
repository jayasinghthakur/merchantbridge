'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { DEFAULT_PLAYGROUND_MODEL } from '../lib/config';
import {
  agentSdkPython,
  agentSdkTs,
  claudeCodeDemo,
  claudeCodeLive,
  KEY_PLACEHOLDER,
  messagesApiCurl,
} from '../lib/snippets';
import { useStatus } from '../lib/use-status';
import { CodeBlock } from './code-block';
import { useDemoMcpUrl, useLiveMcpUrl } from './mcp-command';
import { InlineCode } from './ui';

function Sub({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-3">
      <h3 className="text-base font-bold text-ink">{title}</h3>
      {children}
    </div>
  );
}

export function IntegrationSnippets() {
  const status = useStatus();
  const demoUrl = useDemoMcpUrl();
  const liveUrl = useLiveMcpUrl();
  const model = status.kind === 'ready' ? status.status.model : DEFAULT_PLAYGROUND_MODEL;
  const [lang, setLang] = useState<'ts' | 'py'>('ts');

  return (
    <div className="space-y-10">
      <Sub title="Claude Code">
        <p className="text-sm text-ink-muted">Public demo server (synthetic data, no key):</p>
        <CodeBlock code={claudeCodeDemo(demoUrl)} label="Terminal" wrap testId="docs-claude-code-demo" />
        <p className="text-sm text-ink-muted">
          Your own Zoho organization, with the key shown once after <Link className="font-semibold text-brand-ink underline" href="/connect">connecting</Link>:
        </p>
        <CodeBlock code={claudeCodeLive(liveUrl)} label="Terminal" wrap />
      </Sub>

      <Sub title="Claude Agent SDK">
        <div role="tablist" aria-label="Language" className="inline-flex rounded-sm border border-line p-0.5">
          {(
            [
              ['ts', 'TypeScript'],
              ['py', 'Python'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={lang === id}
              onClick={() => setLang(id)}
              className={`h-7 rounded-[4px] px-3 text-xs font-semibold ${
                lang === id ? 'bg-brand-soft text-brand-ink' : 'text-ink-muted hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {lang === 'ts' ? (
          <CodeBlock code={agentSdkTs(liveUrl)} label="agent.ts" />
        ) : (
          <CodeBlock code={agentSdkPython(liveUrl)} label="agent.py" />
        )}
        <p className="text-sm text-ink-muted">
          Tools appear as <InlineCode>mcp__merchantbridge__zoho_*</InlineCode>. For the demo server, use{' '}
          <InlineCode>{demoUrl}</InlineCode> and drop the header.
        </p>
      </Sub>

      <Sub title="Claude Messages API (MCP connector)">
        <CodeBlock code={messagesApiCurl(liveUrl, model)} label="Shell" />
        <p className="text-sm text-ink-muted">
          Requires the <InlineCode>mcp-client-2025-11-20</InlineCode> beta header and both halves: the{' '}
          <InlineCode>mcp_servers</InlineCode> entry and an <InlineCode>mcp_toolset</InlineCode> that names it. The
          server must be reachable from the public internet, so this does not work against localhost. Replace{' '}
          <InlineCode>{KEY_PLACEHOLDER}</InlineCode> with your key.
        </p>
      </Sub>

      <Sub title="Claude.ai custom connector">
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink-muted marker:text-ink-subtle">
          <li>
            Open <strong className="text-ink">Customize → Connectors → Add custom connector</strong>.
          </li>
          <li>Name it MerchantBridge demo and paste the URL below.</li>
          <li>Leave the OAuth fields empty: the demo server needs no sign-in.</li>
          <li>Enable it in a chat and ask about CHAI-250.</li>
        </ol>
        <CodeBlock code={demoUrl} label="Remote MCP server URL" wrap testId="docs-connector-url" />
      </Sub>
    </div>
  );
}
