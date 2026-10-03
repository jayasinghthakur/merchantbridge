import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from '../lib/markdown';

describe('parseInline', () => {
  it('splits code and bold', () => {
    expect(parseInline('SKU `CHAI-250` is **in stock**.')).toEqual([
      { kind: 'text', text: 'SKU ' },
      { kind: 'code', text: 'CHAI-250' },
      { kind: 'text', text: ' is ' },
      { kind: 'bold', text: 'in stock' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('keeps unclosed markers literal (mid-stream text)', () => {
    expect(parseInline('price **18')).toEqual([{ kind: 'text', text: 'price **18' }]);
    expect(parseInline('a `b')).toEqual([{ kind: 'text', text: 'a `b' }]);
  });

  it('never produces HTML: tags stay text', () => {
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([
      { kind: 'text', text: '<img src=x onerror=alert(1)>' },
    ]);
  });
});

describe('parseMarkdown', () => {
  it('builds paragraphs, lists, headings and code', () => {
    const blocks = parseMarkdown('## Evidence\nLine one\nline two\n\n- a\n- b\n\n1. x\n2. y\n\n```\ncode\n```');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'p', 'ul', 'ol', 'code']);
    const p = blocks[1];
    expect(p?.kind === 'p' ? p.lines.length : 0).toBe(2);
    const ul = blocks[2];
    expect(ul?.kind === 'ul' ? ul.items.length : 0).toBe(2);
  });

  it('switches between list kinds', () => {
    expect(parseMarkdown('- a\n1. b').map((b) => b.kind)).toEqual(['ul', 'ol']);
  });
});
