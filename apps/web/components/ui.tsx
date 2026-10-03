import type { ReactNode } from 'react';
import { AlertIcon, InfoIcon, Spinner } from './icons';

export type Tone = 'neutral' | 'brand' | 'warn' | 'danger';

const BADGE_TONES: Record<Tone, string> = {
  neutral: 'border-line-strong bg-sunken text-ink-muted',
  brand: 'border-brand/40 bg-brand-soft text-brand-ink',
  warn: 'border-accent/50 bg-accent-soft text-accent-ink',
  danger: 'border-danger/40 bg-danger-soft text-danger',
};

export function Badge({
  tone = 'neutral',
  children,
  title,
  mono = false,
  className = '',
  testId,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
  mono?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <span
      title={title}
      data-testid={testId}
      className={`inline-flex max-w-full items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] leading-4 font-semibold tracking-wide whitespace-nowrap ${
        mono ? 'font-mono font-medium tracking-normal' : 'uppercase'
      } ${BADGE_TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export function buttonClass(variant: ButtonVariant = 'primary', size: 'sm' | 'md' = 'md'): string {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-55 select-none';
  const sizes = size === 'sm' ? 'h-8 px-3 text-sm' : 'h-10 px-4 text-[0.9375rem]';
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-brand text-on-brand hover:bg-brand-hover',
    secondary: 'border border-line-strong bg-raised text-ink hover:border-brand hover:text-brand-ink',
    ghost: 'text-ink-muted hover:bg-sunken hover:text-ink',
  };
  return `${base} ${sizes} ${variants[variant]}`;
}

const NOTICE_TONES: Record<'info' | 'warn' | 'error', string> = {
  info: 'border-line bg-raised',
  warn: 'border-accent/60 bg-accent-soft',
  error: 'border-danger/50 bg-danger-soft',
};

export function Notice({
  tone = 'info',
  title,
  children,
  action,
  testId,
}: {
  tone?: 'info' | 'warn' | 'error';
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  testId?: string;
}) {
  const Icon = tone === 'info' ? InfoIcon : AlertIcon;
  const iconColor = tone === 'error' ? 'text-danger' : tone === 'warn' ? 'text-accent-ink' : 'text-brand-ink';
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      data-testid={testId}
      className={`flex gap-3 rounded-md border p-3.5 text-sm ${NOTICE_TONES[tone]}`}
    >
      <Icon size={18} className={`mt-0.5 shrink-0 ${iconColor}`} />
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-ink">{title}</p>
        {children ? <div className="mt-1 text-ink-muted">{children}</div> : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-2 py-6 text-sm text-ink-muted">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-sm bg-sunken ${className}`} />;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-line-strong px-4 py-8 text-center">
      <p className="text-sm font-semibold text-ink">{title}</p>
      {children ? <div className="mt-1 text-sm text-ink-muted">{children}</div> : null}
    </div>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  children,
  id,
}: {
  eyebrow?: string;
  title: ReactNode;
  children?: ReactNode;
  id?: string;
}) {
  return (
    <div className="max-w-2xl">
      {eyebrow ? (
        <p className="text-xs font-semibold tracking-[0.12em] text-brand-ink uppercase">{eyebrow}</p>
      ) : null}
      <h2 id={id} className="mt-1 text-xl font-bold tracking-tight text-ink sm:text-2xl">
        {title}
      </h2>
      {children ? <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-muted">{children}</p> : null}
    </div>
  );
}

export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-[4px] border border-line bg-sunken px-1 py-px font-mono text-[0.85em] break-words text-ink">
      {children}
    </code>
  );
}
