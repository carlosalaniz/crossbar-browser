// SPDX-License-Identifier: AGPL-3.0-only
// Ground truth for Crossbar tests: every request the site received, by shape.
// Tests read /__testsite/log to assert that a denied request never arrived.

export interface LogEntry {
  seq: number;
  time: string;
  host: string;
  method: string;
  path: string;
  queryKeys: string[];
  bodyKeys: string[];
  bodyLength: number;
  /** Cookie names the request carried (third-party cookie tests); never values. */
  cookieKeys: string[];
  session: string | null;
  ip: string;
  /** Upgrade requests (WebSocket handshakes) are marked so a test can tell them apart. */
  upgrade?: string;
}

export class RequestLog {
  private entries: LogEntry[] = [];
  private seq = 0;
  private readonly max: number;
  constructor(max = 10_000) {
    this.max = max;
  }

  add(e: Omit<LogEntry, "seq" | "time">): LogEntry {
    const entry: LogEntry = { seq: ++this.seq, time: new Date().toISOString(), ...e };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    return entry;
  }

  /** Filters: host, method, path prefix, entries after a sequence number. */
  list(f: { host?: string; method?: string; pathPrefix?: string; since?: number } = {}): LogEntry[] {
    return this.entries.filter(
      (e) =>
        (!f.host || e.host === f.host) &&
        (!f.method || e.method === f.method.toUpperCase()) &&
        (!f.pathPrefix || e.path.startsWith(f.pathPrefix)) &&
        (f.since === undefined || e.seq > f.since),
    );
  }

  reset(): void {
    this.entries = [];
  }
}
