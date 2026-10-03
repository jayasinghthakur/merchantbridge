'use client';

import type { DemoFault } from '@mb/core/telemetry';
import type { FaultInfo } from '../lib/faults';
import { FAULTS, toggleFault } from '../lib/faults';
import { ChevronDownIcon } from './icons';

function FaultSwitch({
  fault,
  on,
  disabled,
  onToggle,
}: {
  fault: FaultInfo;
  on: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const descId = `fault-desc-${fault.id}`;
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{fault.label}</p>
        <p id={descId} className="text-xs leading-relaxed text-ink-muted">
          {fault.description}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={fault.label}
        aria-describedby={descId}
        disabled={disabled}
        onClick={onToggle}
        data-testid={`fault-${fault.id}`}
        className={`relative mt-0.5 inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
          on ? 'border-accent bg-accent' : 'border-line-strong bg-sunken'
        }`}
      >
        <span
          aria-hidden="true"
          className={`inline-block h-4.5 w-4.5 rounded-full bg-raised shadow-[0_0_0_1px_var(--mb-line-strong)] transition-transform ${
            on ? 'translate-x-[18px]' : 'translate-x-[2px]'
          }`}
        />
      </button>
    </li>
  );
}

/** Session-scoped fault injection for the demo upstream. Only affects this tab's demo session. */
export function FaultToggles({
  value,
  onChange,
  disabled = false,
}: {
  value: readonly DemoFault[];
  onChange: (next: DemoFault[]) => void;
  disabled?: boolean;
}) {
  const primary = FAULTS.filter((f) => f.primary);
  const more = FAULTS.filter((f) => !f.primary);
  const moreActive = more.filter((f) => value.includes(f.id)).length;
  return (
    <div className="mb-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold text-ink">Fault injection</h2>
        <span className="text-xs text-ink-subtle">
          {value.length === 0 ? 'none active' : `${value.length} active`}
        </span>
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        Sent with every request from this tab while on; other visitors are unaffected.
      </p>
      <ul className="mt-2 divide-y divide-line">
        {primary.map((f) => (
          <FaultSwitch
            key={f.id}
            fault={f}
            on={value.includes(f.id)}
            disabled={disabled}
            onToggle={() => onChange(toggleFault(value, f.id))}
          />
        ))}
      </ul>
      <details className="group mt-1 border-t border-line pt-2">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-sm py-1 text-sm font-semibold text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden">
          <ChevronDownIcon size={15} className="transition-transform group-open:rotate-180" />
          More faults
          {moreActive > 0 ? (
            <span className="text-xs font-normal text-accent-ink">({moreActive} on)</span>
          ) : null}
        </summary>
        <ul className="divide-y divide-line">
          {more.map((f) => (
            <FaultSwitch
              key={f.id}
              fault={f}
              on={value.includes(f.id)}
              disabled={disabled}
              onToggle={() => onChange(toggleFault(value, f.id))}
            />
          ))}
        </ul>
      </details>
    </div>
  );
}
