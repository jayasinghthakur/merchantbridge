import type { Metadata } from 'next';
import { ConnectSuccess } from '../../../components/connect-success';

export const metadata: Metadata = {
  title: 'Connected',
  robots: { index: false, follow: false },
};

export default function ConnectSuccessPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 pt-6 sm:px-6 sm:pt-8">
      <ConnectSuccess />
    </div>
  );
}
