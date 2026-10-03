'use client';

import { SCENARIOS } from '@mb/core/scenarios';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import type { RunState } from '../lib/trace';
import { toolSteps } from '../lib/trace';
import { Countdown } from './countdown';
import { DemoBadge } from './demo-badge';
import { Spinner } from './icons';
import { MarkdownText } from './markdown-text';
import { ToolStepView } from './tool-step';
import { Badge, buttonClass, EmptyState, Notice } from './ui';

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function ToolsExplorerLink() {
  return (
    <Link href="/tools" className={buttonClass('secondary', 'sm')}>
      Open the Tools explorer
    </Link>
  );
}

function RunError({ run }: { run: RunState }) {
  const err = run.error;
  if (!err) return null;
  switch (err.code) {
    case 'PLAYGROUND_DISABLED':
      return (
        <Notice tone="warn" title="The live agent is paused" testId="playground-error" action={<ToolsExplorerLink />}>
          <p>{err.message}</p>
          <p className="mt-1">
            The MCP server itself is unaffected: the Tools explorer runs the same tools without a model, and you can add
            the demo server to your own Claude from the home page.
          </p>
        </Notice>
      );
    case 'RATE_LIMITED': {
      const until = (run.errorAt ?? Date.now()) + (err.retry_after_s ?? 60) * 1000;
      return (
        <Notice tone="warn" title="Too many questions from this browser" testId="playground-error">
          <p>{err.message}</p>
          <p className="mt-1 font-semibold text-ink" data-testid="retry-countdown">
            <Countdown untilMs={until}>
              {(s) => (s > 0 ? `You can ask again in ${s}s.` : 'You can ask again now.')}
            </Countdown>
          </p>
        </Notice>
      );
    }
    case 'BUDGET_EXHAUSTED':
      return (
        <Notice tone="warn" title="Today’s demo budget is used up" testId="playground-error">
          The playground has a fixed daily model budget and it has run out. It resets tomorrow; meanwhile the{' '}
          <Link className="font-semibold text-brand-ink underline" href="/tools">
            tool explorer
          </Link>{' '}
          and the public MCP server still work without a model.
        </Notice>
      );
    case 'BAD_REQUEST':
      return (
        <Notice tone="error" title="The request was rejected" testId="playground-error">
          {err.message}
        </Notice>
      );
    case 'INTERNAL':
      return (
        <Notice tone="error" title="The agent run failed" testId="playground-error">
          {err.message} Nothing was changed: the connector is read-only.
        </Notice>
      );
  }
}

function RunView({ run }: { run: RunState }) {
  const scenario = run.scenarioId ? SCENARIOS.find((s) => s.id === run.scenarioId) : undefined;
  const steps = toolSteps(run);
  let stepIndex = 0;
  const streaming = run.status === 'streaming';
  const lastIsText = run.items[run.items.length - 1]?.kind === 'text';

  return (
    <article className="space-y-3" data-testid="run" data-status={run.status} aria-busy={streaming}>
      <div className="rounded-md border border-line bg-sunken px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-ink-subtle">
          <span>{scenario ? scenario.agent : 'Your question'}</span>
          {run.session?.replay ? (
            <Badge tone="warn" testId="replay-badge" title="Recorded transcript, not a live model call">
              replay
            </Badge>
          ) : null}
          {run.session ? <span className="font-mono font-normal">{run.session.model}</span> : null}
          {run.session?.faults.map((f) => (
            <Badge key={f} tone="warn" mono>
              fault {f}
            </Badge>
          ))}
        </div>
        <p className="mt-1 text-sm break-words text-ink">{run.question}</p>
      </div>

      {run.items.length === 0 && streaming ? (
        <p className="flex items-center gap-2 px-1 text-sm text-ink-muted" role="status">
          <Spinner size={14} />
          Agent is thinking…
        </p>
      ) : null}

      <ol className="space-y-3">
        {run.items.map((item, i) =>
          item.kind === 'tool' ? (
            <ToolStepView key={`${item.callId}-${i}`} step={item} index={(stepIndex += 1)} />
          ) : (
            <li key={`text-${i}`} data-testid="assistant-text" className="px-1">
              <MarkdownText text={item.text} />
              {streaming && i === run.items.length - 1 ? (
                <span aria-hidden="true" className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-brand align-middle" />
              ) : null}
            </li>
          ),
        )}
      </ol>

      {streaming && run.items.length > 0 && !lastIsText ? (
        <p className="flex items-center gap-2 px-1 text-xs text-ink-muted" role="status">
          <Spinner size={13} />
          Waiting for the agent…
        </p>
      ) : null}

      <RunError run={run} />

      {run.status === 'interrupted' ? (
        <Notice tone="error" title="The stream ended before the agent finished" testId="playground-interrupted">
          {run.clientError ?? 'The connection closed early.'} Try the question again.
        </Notice>
      ) : null}

      {run.done ? (
        <p
          data-testid="run-done"
          className="flex flex-wrap gap-x-3 gap-y-1 border-t border-line px-1 pt-2.5 font-mono text-xs text-ink-subtle"
        >
          <span>done</span>
          <span>
            {run.done.tool_calls} tool call{run.done.tool_calls === 1 ? '' : 's'}
          </span>
          <span>
            {run.done.input_tokens.toLocaleString('en-US')} in / {run.done.output_tokens.toLocaleString('en-US')}{' '}
            out tokens
          </span>
          <span>{formatDuration(run.done.duration_ms)}</span>
          {steps.length === 0 && run.done.tool_calls === 0 ? <span>no tools used</span> : null}
        </p>
      ) : null}
    </article>
  );
}

export function TracePane({
  runs,
  paused,
  onClear,
}: {
  runs: RunState[];
  /** The API reports the playground disabled: explain instead of inviting a run. */
  paused: boolean;
  onClear: (() => void) | null;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const last = runs[runs.length - 1];

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <section
      aria-label="Agent trace"
      className="mb-card flex min-h-[420px] min-w-0 flex-col overflow-hidden lg:h-[calc(100dvh-7.5rem)] lg:min-h-0"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-sm font-bold">Trace</h2>
          {last?.session?.replay ? (
            <Badge tone="warn" title="Recorded transcript, not a live model call">
              replay
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <DemoBadge />
          {onClear ? (
            <button type="button" className={buttonClass('ghost', 'sm')} onClick={onClear}>
              Clear
            </button>
          ) : null}
        </div>
      </header>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="flex-1 space-y-8 overflow-y-auto p-4"
        aria-live="polite"
        aria-relevant="additions"
      >
        {runs.length === 0 && paused ? (
          <div data-testid="trace-paused">
            <EmptyState title="Nothing will run here while the agent is paused">
              <p>
                Every tool the agent would call can be run by hand in the Tools explorer, with the raw JSON-RPC exchange
                and the governor decisions for each call.
              </p>
              <div className="mt-4">
                <ToolsExplorerLink />
              </div>
            </EmptyState>
          </div>
        ) : runs.length === 0 ? (
          <EmptyState title="No runs yet">
            Pick a scenario card or ask your own question. Each tool call, its arguments, latency, cache and governor
            decisions appear here as the agent works.
          </EmptyState>
        ) : (
          runs.map((run) => <RunView key={run.id} run={run} />)
        )}
      </div>
    </section>
  );
}
