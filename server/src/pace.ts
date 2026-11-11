// SPDX-License-Identifier: AGPL-3.0-only
// Human pace per domain (Charter): one page every few seconds, an hourly cap. The floor can't go to zero.
export const MIN_INTERVAL_FLOOR_MS = 1000;

export class Pacer {
  private readonly hits = new Map<string, number[]>();
  readonly minIntervalMs: number;
  readonly hourlyCap: number;
  constructor(opts: { minIntervalMs?: number; hourlyCap?: number } = {}) {
    this.minIntervalMs = Math.max(opts.minIntervalMs ?? 3000, MIN_INTERVAL_FLOOR_MS);
    this.hourlyCap = Math.max(1, opts.hourlyCap ?? 120);
  }
  check(userId: string, domain: string, at = Date.now()): { waitMs: number; refuse?: string } {
    const key = `${userId}|${domain}`;
    const list = (this.hits.get(key) ?? []).filter((t) => at - t < 3600_000);
    this.hits.set(key, list);
    if (list.length >= this.hourlyCap) return { waitMs: 0, refuse: `Hourly cap of ${this.hourlyCap} pages on ${domain} reached. Try again later.` };
    const last = list[list.length - 1];
    return { waitMs: last === undefined ? 0 : Math.max(0, this.minIntervalMs - (at - last)) };
  }
  record(userId: string, domain: string, at = Date.now()): void {
    const key = `${userId}|${domain}`;
    this.hits.set(key, [...(this.hits.get(key) ?? []), at]);
  }
}
