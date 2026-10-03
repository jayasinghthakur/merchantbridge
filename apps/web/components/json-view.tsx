import { CodeBlock } from './code-block';

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'undefined';
  } catch {
    return String(value);
  }
}

export function JsonView({ value, label, testId }: { value: unknown; label: string; testId?: string }) {
  return <CodeBlock code={prettyJson(value)} label={label} copyLabel={`Copy ${label}`} testId={testId} />;
}
