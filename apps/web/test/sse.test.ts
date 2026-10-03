import { describe, expect, it } from 'vitest';
import { SseParser } from '../lib/sse';

describe('SseParser', () => {
  it('parses complete frames', () => {
    const p = new SseParser();
    expect(p.push('data: {"a":1}\n\ndata: {"b":2}\n\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('reassembles frames split across chunks, including mid-CRLF', () => {
    const p = new SseParser();
    expect(p.push('data: {"ty')).toEqual([]);
    expect(p.push('pe":"done"}\r')).toEqual([]);
    expect(p.push('\n\r\n')).toEqual(['{"type":"done"}']);
  });

  it('ignores heartbeats and non-data fields', () => {
    const p = new SseParser();
    expect(p.push(': ping\n\nevent: x\nid: 7\ndata: hi\nretry: 10\n\n')).toEqual(['hi']);
    expect(p.push(':\n\n')).toEqual([]);
  });

  it('joins multi-line data with newlines', () => {
    const p = new SseParser();
    expect(p.push('data: one\ndata: two\n\n')).toEqual(['one\ntwo']);
  });

  it('flushes an unterminated final event', () => {
    const p = new SseParser();
    expect(p.push('data: last')).toEqual([]);
    expect(p.flush()).toEqual(['last']);
  });
});
