/**
 * A deliberately tiny Markdown subset for assistant text: paragraphs, bullet and numbered lists, headings (shown
 * as bold lines), fenced code, `inline code` and **bold**. Output is a plain data tree rendered by React, so model
 * output can never inject HTML. Unclosed markers (common mid-stream) stay literal text.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; text: string };

export type Block =
  | { kind: 'p'; lines: Inline[][] }
  | { kind: 'heading'; inlines: Inline[] }
  | { kind: 'ul'; items: Inline[][] }
  | { kind: 'ol'; items: Inline[][]; start: number }
  | { kind: 'code'; text: string };

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,4})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const FENCE = /^\s*```/;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf) out.push({ kind: 'text', text: buf });
    buf = '';
  };
  while (i < text.length) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: 'code', text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ kind: 'bold', text: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    buf += text[i];
    i += 1;
  }
  flush();
  return out;
}

type ListBlock = Extract<Block, { kind: 'ul' | 'ol' }>;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  // Held in an object so the helpers below see the current values (no closure narrowing surprises).
  const open: { para: Inline[][] | null; list: ListBlock | null } = { para: null, list: null };

  const endPara = () => {
    if (open.para) blocks.push({ kind: 'p', lines: open.para });
    open.para = null;
  };
  const endList = () => {
    if (open.list) blocks.push(open.list);
    open.list = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    if (FENCE.test(line)) {
      endPara();
      endList();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      endPara();
      endList();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      endPara();
      endList();
      blocks.push({ kind: 'heading', inlines: parseInline(heading[1] ?? '') });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      endPara();
      const kind = bullet ? 'ul' : 'ol';
      const text = bullet ? (bullet[1] ?? '') : (numbered?.[2] ?? '');
      if (!open.list || open.list.kind !== kind) {
        endList();
        open.list =
          kind === 'ul'
            ? { kind: 'ul', items: [] }
            : { kind: 'ol', items: [], start: Number(numbered?.[1] ?? 1) };
      }
      open.list.items.push(parseInline(text));
      continue;
    }

    if (open.list && /^\s{2,}\S/.test(line)) {
      // Indented continuation of the previous list item.
      const last = open.list.items[open.list.items.length - 1];
      if (last) last.push({ kind: 'text', text: ' ' }, ...parseInline(line.trim()));
      continue;
    }

    endList();
    open.para ??= [];
    open.para.push(parseInline(line.trim()));
  }
  endPara();
  endList();
  return blocks;
}
