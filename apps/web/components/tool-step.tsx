'use client';

import { decisionChip } from '../lib/decisions';
import type { ToolStep } from '../lib/trace';
import { Spinner, WrenchIcon } from './icons';
import { prettyJson } from './json-view';
import { Badge } from './ui';

const MAX_RESULT_CHARS = 6000;

function compactArgs(args: Record<string, unknown>): string {
  const one = JSON.stringify(args);
  return one.length <= 72 ? one : prettyJson(args);
}

export function ToolStepView({ step, index }: { step: ToolStep; index: number }) {
  const r = step.result;
  const pending = r === null;
  const resultText = r ? prettyJson(r.result) : '';
  const shown =
    resultText.length > MAX_RESULT_CHARS
      ? `${resultText.slice(0, MAX_RESULT_CHARS)}\n… (${resultText.length - MAX_RESULT_CHARS} more characters)`
      : resultText;

  return (
    <li
      data-testid="tool-step"
      data-tool={step.tool}
      className={`rounded-md border bg-raised ${r?.is_error ? 'border-danger/50' : 'border-line'}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-2">
        <span className="font-mono text-xs text-ink-subtle">#{index}</span>
        <WrenchIcon size={14} className="text-brand-ink" />
        <span className="min-w-0 font-mono text-[13px] font-semibold break-all text-ink">{step.tool}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {pending ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted" role="status">
              <Spinner size={13} />
              running
            </span>
          ) : r.is_error ? (
            <Badge tone="danger" testId="error-code-badge">
              {r.error_code ?? 'ERROR'}
            </Badge>
          ) : (
            <Badge tone="brand">ok</Badge>
          )}
        </span>
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <pre className="mb-code overflow-x-auto px-2.5 py-1.5 text-xs" aria-label="Arguments">
          <code>{compactArgs(step.args)}</code>
        </pre>
        {r ? (
          <>
            <div className="flex flex-wrap items-center gap-1.5" aria-label="Call details">
              <Badge mono>{r.duration_ms} ms</Badge>
              {r.cached ? (
                <Badge tone="brand" testId="cached-badge">
                  cached
                </Badge>
              ) : null}
              <Badge mono title="Upstream Zoho requests made for this call">
                upstream {r.upstream_calls}
              </Badge>
              {r.retries > 0 ? (
                <Badge mono tone="warn">
                  retries {r.retries}
                </Badge>
              ) : null}
              {r.budget_remaining_today !== null ? (
                <Badge mono title="Remaining daily Zoho API budget for this org">
                  budget {r.budget_remaining_today.toLocaleString('en-US')} left
                </Badge>
              ) : null}
            </div>
            {r.decisions.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5" aria-label="Governor decisions">
                {r.decisions.map((d, i) => {
                  const chip = decisionChip(d, step.resultAt ?? Date.now());
                  return (
                    <li key={i}>
                      <Badge mono tone={chip.tone} title={chip.detail} testId={`decision-${d.type}`}>
                        {chip.label}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <details className="group">
              <summary className="cursor-pointer rounded-sm text-xs font-semibold text-ink-muted hover:text-ink">
                {r.is_error ? 'Error result' : 'Result'} (structuredContent)
              </summary>
              <pre tabIndex={0} className="mb-code mt-1.5 max-h-72 overflow-auto p-2.5 text-xs">
                <code>{shown}</code>
              </pre>
            </details>
          </>
        ) : null}
      </div>
    </li>
  );
}
