'use client';

import type { Scenario } from '@mb/core/scenarios';
import { ArrowRightIcon, LockIcon } from './icons';

export function ScenarioCards({
  scenarios,
  disabled,
  activeId,
  onPick,
}: {
  scenarios: readonly Scenario[];
  disabled: boolean;
  activeId: string | null;
  onPick: (s: Scenario) => void;
}) {
  return (
    <ul className="grid gap-2" aria-label="Scenarios">
      {scenarios.map((s) => {
        const active = activeId === s.id;
        return (
          <li key={s.id}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(s)}
              data-testid="scenario-card"
              data-scenario={s.id}
              aria-describedby={`scenario-desc-${s.id}`}
              className={`group w-full rounded-md border bg-raised p-3.5 text-left transition-colors hover:border-brand disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-line ${
                active ? 'border-brand' : 'border-line'
              }`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-[11px] font-bold tracking-[0.1em] text-brand-ink uppercase">
                  {s.refusal ? <LockIcon size={12} /> : null}
                  {s.agent}
                </span>
                <ArrowRightIcon
                  size={15}
                  className="text-ink-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-brand-ink"
                />
              </span>
              <span className="mt-1 block font-semibold text-ink">{s.title}</span>
              <span
                id={`scenario-desc-${s.id}`}
                className="mt-0.5 block text-sm leading-relaxed text-ink-muted"
              >
                {s.description}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
