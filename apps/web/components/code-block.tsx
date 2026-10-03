import { CopyButton } from './copy-button';

export function CodeBlock({
  code,
  label,
  copyLabel,
  wrap = false,
  testId,
}: {
  code: string;
  /** Small caption shown in the header (file name, language, shell). */
  label?: string;
  copyLabel?: string;
  /** Wrap long lines instead of scrolling horizontally (for one-line commands). */
  wrap?: boolean;
  testId?: string;
}) {
  return (
    <div className="mb-code min-w-0 overflow-hidden" data-testid={testId}>
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5">
        <span className="truncate font-sans text-xs font-semibold text-ink-subtle">{label ?? ''}</span>
        <CopyButton text={code} label={copyLabel ?? (label ? `Copy ${label}` : 'Copy code')} />
      </div>
      <pre
        tabIndex={0}
        className={`max-h-[28rem] overflow-auto p-3 text-ink ${wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : ''}`}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
