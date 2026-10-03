/**
 * Incremental parser for a text/event-stream body. Feed decoded text chunks with push(); it returns the `data`
 * payload of every event completed by that chunk. Handles frames split across chunks, CRLF/CR line endings,
 * multi-line data fields and `:` comment lines (heartbeats). Fields other than `data` are ignored.
 */
export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      // A lone trailing \r may be the first half of \r\n; wait for the next chunk to decide.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const payload = this.line(line);
      if (payload !== null) out.push(payload);
    }
    return out;
  }

  /** Call at end of stream: dispatches a final event that was not terminated by a blank line. */
  flush(): string[] {
    const out: string[] = [];
    if (this.buffer !== '') {
      const payload = this.line(this.buffer);
      this.buffer = '';
      if (payload !== null) out.push(payload);
    }
    const last = this.line('');
    if (last !== null) out.push(last);
    return out;
  }

  private line(line: string): string | null {
    if (line === '') {
      if (this.dataLines.length === 0) return null;
      const data = this.dataLines.join('\n');
      this.dataLines = [];
      return data;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.dataLines.push(value);
    return null;
  }
}
