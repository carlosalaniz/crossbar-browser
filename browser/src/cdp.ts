// SPDX-License-Identifier: AGPL-3.0-only
// Minimal CDP client over one browser WebSocket with flat sessions (ADR 0009).
// Every target (page, OOPIF, worker, service worker) is a sessionId on this one socket.
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";

type Commands = ProtocolMapping.Commands;
type Events = ProtocolMapping.Events;
export type CommandName = keyof Commands;
export type EventName = keyof Events;
export type Params<M extends CommandName> = Commands[M]["paramsType"] extends [infer P] ? P : Commands[M]["paramsType"] extends [(infer P)?] ? P | undefined : undefined;
export type Result<M extends CommandName> = Commands[M]["returnType"];
export type EventParams<E extends EventName> = Events[E] extends [infer P] ? P : undefined;
type Handler<E extends EventName> = (params: EventParams<E>, sessionId: string | undefined) => void;

export class CdpError extends Error {
  readonly method: string;
  readonly code: number;
  constructor(method: string, code: number, message: string) {
    super(`${method}: ${message} (${code})`);
    this.method = method;
    this.code = code;
  }
}

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly handlers = new Map<string, Set<Handler<EventName>>>();
  private closed = false;
  private readonly ws: WebSocket;
  private readonly closeCbs = new Set<() => void>();
  /**
   * No command waits forever: a page frozen by a busy script (or anything else that stops Chrome answering)
   * becomes an error the agent can act on, not a hang nobody is there to notice.
   */
  static commandTimeoutMs = 60_000;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`CDP socket closed during ${p.method}`));
      this.pending.clear();
      for (const cb of this.closeCbs) cb();
    });
  }

  static connect(wsUrl: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.addEventListener("open", () => resolve(new CdpConnection(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error(`CDP connect failed: ${wsUrl}`)), { once: true });
    });
  }

  send<M extends CommandName>(method: M, params?: Params<M>, sessionId?: string): Promise<Result<M>> {
    if (this.closed) return Promise.reject(new Error(`CDP socket closed; can't send ${method}`));
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method, params: params ?? {} };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Chrome didn't answer ${method} within ${Math.round(CdpConnection.commandTimeoutMs / 1000)} s: the page may be frozen.`));
      }, CdpConnection.commandTimeoutMs);
      timer.unref?.();
      const done = <T>(f: (v: T) => void) => (v: T) => {
        clearTimeout(timer);
        f(v);
      };
      this.pending.set(id, { method, resolve: done(resolve as (v: unknown) => void), reject: done(reject) });
      this.ws.send(JSON.stringify(msg));
    });
  }

  /** Runs when the connection to Chrome ends (Chrome exited or crashed). */
  onClose(cb: () => void): () => void {
    if (this.closed) cb();
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  on<E extends EventName>(event: E, handler: Handler<E>): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler as Handler<EventName>);
    return () => set.delete(handler as Handler<EventName>);
  }

  close(): void {
    this.ws.close();
  }

  private onMessage(raw: string): void {
    const msg = JSON.parse(raw) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string }; sessionId?: string };
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CdpError(p.method, msg.error.code, msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      for (const h of this.handlers.get(msg.method) ?? []) {
        try {
          h(msg.params as never, msg.sessionId);
        } catch (e) {
          queueMicrotask(() => {
            throw e;
          });
        }
      }
    }
  }
}
