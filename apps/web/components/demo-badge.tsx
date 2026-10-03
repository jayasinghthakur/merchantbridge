import { DEMO_IDS } from '@mb/core/scenarios';

/** Always visible on demo surfaces: everything shown comes from the fake upstream, not a real merchant. */
export function DemoBadge({ className = '' }: { className?: string }) {
  return (
    <span
      data-testid="demo-badge"
      title="All data on this surface is synthetic demo data served by FakeZoho."
      className={`inline-flex items-center gap-1.5 rounded-sm border border-accent/60 bg-accent-soft px-2 py-1 text-[11px] leading-none font-bold tracking-wide whitespace-nowrap text-accent-ink ${className}`}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
      DEMO DATA · {DEMO_IDS.orgName}
    </span>
  );
}
