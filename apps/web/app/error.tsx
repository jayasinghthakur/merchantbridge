'use client';

import { buttonClass, Notice } from '../components/ui';

export default function RouteError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
      <Notice
        tone="error"
        title="This page hit an unexpected error"
        action={
          <button type="button" className={buttonClass('secondary', 'sm')} onClick={retry}>
            Try again
          </button>
        }
      >
        Nothing was changed anywhere: MerchantBridge is read-only. Reload or try again.
      </Notice>
    </div>
  );
}
