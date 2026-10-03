import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonClass, Notice } from '../../../components/ui';
import { connectErrorMessage } from '../../../lib/connect';

export const metadata: Metadata = {
  title: 'Connection failed',
  robots: { index: false, follow: false },
};

export default async function ConnectErrorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.reason;
  const reason = Array.isArray(raw) ? raw[0] : raw;
  const msg = connectErrorMessage(reason);
  return (
    <div className="mx-auto max-w-2xl px-4 pt-6 sm:px-6 sm:pt-8">
      <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Zoho was not connected</h1>
      <div className="mt-6">
        <Notice tone="error" title={msg.title} testId="connect-error">
          {msg.body}
        </Notice>
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        <Link href="/connect" className={buttonClass('primary')}>
          Try again
        </Link>
        <Link href="/playground" className={buttonClass('secondary')}>
          Use the demo instead
        </Link>
      </div>
      {reason ? (
        <p className="mt-6 font-mono text-xs text-ink-subtle">reason: {reason.slice(0, 40)}</p>
      ) : null}
    </div>
  );
}
