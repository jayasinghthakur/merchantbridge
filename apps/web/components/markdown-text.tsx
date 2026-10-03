import type { Inline } from '../lib/markdown';
import { parseMarkdown } from '../lib/markdown';

function Inlines({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) => {
        if (p.kind === 'code') {
          return (
            <code
              key={i}
              className="rounded-[4px] border border-line bg-sunken px-1 py-px font-mono text-[0.85em] break-words"
            >
              {p.text}
            </code>
          );
        }
        if (p.kind === 'bold') {
          return (
            <strong key={i} className="font-bold text-ink">
              {p.text}
            </strong>
          );
        }
        return <span key={i}>{p.text}</span>;
      })}
    </>
  );
}

/** Renders assistant text from a safe Markdown subset; never uses innerHTML. */
export function MarkdownText({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="space-y-2.5 text-[0.9375rem] leading-relaxed break-words text-ink">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'p':
            return (
              <p key={i}>
                {b.lines.map((line, j) => (
                  <span key={j}>
                    {j > 0 ? <br /> : null}
                    <Inlines parts={line} />
                  </span>
                ))}
              </p>
            );
          case 'heading':
            return (
              <p key={i} className="font-bold">
                <Inlines parts={b.inlines} />
              </p>
            );
          case 'ul':
            return (
              <ul key={i} className="list-disc space-y-1 pl-5 marker:text-ink-subtle">
                {b.items.map((item, j) => (
                  <li key={j}>
                    <Inlines parts={item} />
                  </li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i} start={b.start} className="list-decimal space-y-1 pl-5 marker:text-ink-subtle">
                {b.items.map((item, j) => (
                  <li key={j}>
                    <Inlines parts={item} />
                  </li>
                ))}
              </ol>
            );
          case 'code':
            return (
              <pre key={i} tabIndex={0} className="mb-code overflow-x-auto p-3">
                <code>{b.text}</code>
              </pre>
            );
        }
      })}
    </div>
  );
}
