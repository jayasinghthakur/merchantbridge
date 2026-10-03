import type { Metadata } from 'next';
import { ConnectSuccess } from '../../../components/connect-success';

export const metadata: Metadata = {
  title: 'Connected',
  robots: { index: false, follow: false },
};

export default function ConnectSuccessPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 pt-6 sm:px-6 sm:pt-8">
      <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Zoho Inventory connected</h1>
      <p className="mt-1 mb-6 text-[0.9375rem] text-ink-muted">
        Your organization is now available to any agent that holds this key, read-only.
      </p>
      <ConnectSuccess />
    </div>
  );
}
