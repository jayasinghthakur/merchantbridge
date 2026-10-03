'use client';

import type { ToolsResponse } from '@mb/core/http';
import { useEffect, useState } from 'react';
import { describeApiError, getTools } from '../lib/api';
import { STATIC_TOOLS } from '../lib/tools-fallback';
import { Badge, Skeleton } from './ui';

type State = { kind: 'loading' } | { kind: 'live'; data: ToolsResponse } | { kind: 'static'; reason: string };

function firstSentence(text: string): string {
  const m = /^(.+?[.!?])(\s|$)/s.exec(text.trim());
  return (m?.[1] ?? text).trim();
}

/** Tool table from the live API, falling back to the static Tier-1 list when the API is unreachable. */
export function LiveToolTable() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    const ac = new AbortController();
    getTools({ signal: ac.signal }).then(
      (data) => setState({ kind: 'live', data }),
      (e: unknown) => {
        if (!ac.signal.aborted) setState({ kind: 'static', reason: describeApiError(e) });
      },
    );
    return () => ac.abort();
  }, []);

  if (state.kind === 'loading') {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Loading tools">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );
  }

  const rows =
    state.kind === 'live'
      ? state.data.tools.map((t) => ({ name: t.name, summary: firstSentence(t.description) }))
      : STATIC_TOOLS.map((t) => ({ name: t.name, summary: t.summary }));

  return (
    <div className="space-y-2">
      <p className="flex flex-wrap items-center gap-2 text-xs text-ink-subtle">
        {state.kind === 'live' ? (
          <>
            <Badge tone="brand">live</Badge> from /api/tools · {rows.length} tools
          </>
        ) : (
          <>
            <Badge>static</Badge> API unreachable ({state.reason}); showing the documented list
          </>
        )}
      </p>
      <div className="mb-card overflow-hidden">
        <table className="block w-full border-collapse text-left text-sm sm:table" data-testid="docs-tool-table">
          <thead className="hidden bg-sunken text-xs tracking-wide text-ink-subtle uppercase sm:table-header-group">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-semibold">
                Tool
              </th>
              <th scope="col" className="px-4 py-2.5 font-semibold">
                Returns
              </th>
            </tr>
          </thead>
          <tbody className="block sm:table-row-group">
            {rows.map((r) => (
              <tr key={r.name} className="block border-t border-line align-top first:border-t-0 sm:table-row sm:first:border-t">
                <td className="block px-4 pt-3 font-mono text-[13px] break-all text-brand-ink sm:table-cell sm:py-2.5 sm:break-normal sm:whitespace-nowrap">
                  {r.name}
                </td>
                <td className="block px-4 pt-1 pb-3 leading-relaxed text-ink-muted sm:table-cell sm:py-2.5">{r.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
