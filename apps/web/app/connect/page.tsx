import type { Metadata } from 'next';
import { ConnectForm } from '../../components/connect-form';
import { LockIcon } from '../../components/icons';
import { CONNECT_SCOPES } from '../../lib/connect';

export const metadata: Metadata = {
  title: 'Connect Zoho Inventory',
  description: 'Connect a Zoho Inventory organization to MerchantBridge with read-only OAuth scopes.',
};

const STEPS = [
  'You sign in to Zoho once and approve read-only access for one organization.',
  'MerchantBridge stores the refresh token encrypted and never hands Zoho tokens to an agent.',
  'You get an mb_live_ key, shown once, that every agent you run can use.',
  'Revoke any time: disconnecting revokes the Zoho token, and you can also remove the app in Zoho’s connected apps.',
];

export default function ConnectPage() {
  return (
    <div className="mx-auto grid max-w-5xl gap-8 px-4 pt-6 sm:px-6 sm:pt-8 md:grid-cols-[1.1fr_1fr]">
      <div className="min-w-0">
        <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Connect Zoho Inventory</h1>
        <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-muted">
          One-time OAuth makes your organization available to every agent you run, through a single key. Nothing can
          be changed in Zoho through this connector.
        </p>
        <ol className="mt-6 space-y-3">
          {STEPS.map((s, i) => (
            <li key={s} className="flex gap-3 text-sm leading-relaxed">
              <span
                aria-hidden="true"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-brand-soft font-mono text-xs font-bold text-brand-ink"
              >
                {i + 1}
              </span>
              <span className="text-ink-muted">{s}</span>
            </li>
          ))}
        </ol>
        <div className="mt-8">
          <h2 className="flex items-center gap-2 text-sm font-bold">
            <LockIcon size={15} className="text-brand-ink" />
            Scopes requested (all read-only)
          </h2>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {CONNECT_SCOPES.map((s) => (
              <li key={s} className="rounded-sm border border-line bg-raised px-1.5 py-0.5 font-mono text-xs text-ink-muted">
                {s}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-subtle">
            All eight are requested on first consent, because each re-consent uses up one of the limited refresh tokens
            Zoho allows per user.
          </p>
        </div>
      </div>
      <div className="min-w-0">
        <ConnectForm />
      </div>
    </div>
  );
}
