'use strict';
// Reads a worker's stream-json output as it grows. Tracks the session id, tools in flight (a tool_use with no
// tool_result yet), progress, error events and the result event. A line cut off mid-way is held back and only
// counted if it turns out to be complete JSON when the stream ends.
const { classifyText, classifyStructured, classifyField, resetFromText } = require('./classify');

class StreamTracker {
  constructor() {
    this.buf = '';
    this.sessionId = null;
    this.model = null;
    this.agent = null;
    this.pending = new Map(); // tool_use id -> {name, at}
    this.progress = 0; // assistant messages and tool results seen
    this.events = 0;
    this.result = null;
    this.errors = []; // {kind:'limit'|'auth'|'transient', resetAt?, text}
    this.lastText = null;
    this.badLines = 0;
  }

  feed(chunk, now = Date.now()) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      this.line(line, now);
    }
  }

  /** The stream is over. A last line without a newline counts only if it parses whole. */
  finish(now = Date.now()) {
    const rest = this.buf;
    this.buf = '';
    if (rest.trim()) this.line(rest, now);
  }

  line(line, now) {
    if (!line.trim()) return;
    let ev;
    try { ev = JSON.parse(line); } catch { this.badLines++; return; }
    if (!ev || typeof ev !== 'object') return;
    this.events++;
    if (typeof ev.session_id === 'string' && ev.session_id) this.sessionId = ev.session_id;
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') { this.model = ev.model || this.model; this.agent = ev.agent || this.agent; }
        break;
      case 'assistant': {
        this.progress++;
        const msg = ev.message || {};
        const kind = classifyField(ev.error || msg.error);
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        for (const b of blocks) {
          if (b && b.type === 'tool_use' && b.id) this.pending.set(b.id, { name: b.name, at: now });
          if (b && b.type === 'text' && typeof b.text === 'string') this.lastText = b.text;
        }
        if (kind) this.errors.push({ kind, text: this.lastText || String(ev.error || msg.error), resetAt: resetFromText(this.lastText) });
        break;
      }
      case 'user': {
        const blocks = Array.isArray((ev.message || {}).content) ? ev.message.content : [];
        for (const b of blocks) if (b && b.type === 'tool_result' && b.tool_use_id) { this.pending.delete(b.tool_use_id); this.progress++; }
        break;
      }
      case 'rate_limit_event': {
        const info = ev.rate_limit_info || {};
        if (info.status === 'rejected') this.errors.push({ kind: 'limit', text: 'rate_limit_event rejected', resetAt: typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : null });
        break;
      }
      case 'result': {
        this.result = ev;
        if (ev.is_error === true) {
          const text = typeof ev.result === 'string' ? ev.result : '';
          // Structured fields first; text only when they are absent.
          let kind = classifyStructured(ev.api_error_status, ev.api_error);
          if (kind === null) kind = classifyText(text);
          if (kind === 'other') kind = null;
          if (kind) this.errors.push({ kind, text: text.slice(0, 300), resetAt: resetFromText(text) });
        }
        break;
      }
      default:
    }
  }

  get inFlight() { return this.pending.size; }
  get oldestToolAt() { let m = null; for (const v of this.pending.values()) if (m === null || v.at < m) m = v.at; return m; }
  get succeeded() { return !!this.result && this.result.is_error !== true && this.result.subtype === 'success' && typeof this.result.result === 'string'; }
}

module.exports = { StreamTracker };
