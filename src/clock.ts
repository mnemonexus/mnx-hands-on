/** Counts the seconds a learner is actually working: stops when paused or when the frame is hidden. */
export class Clock {
  private base: number;
  private since: number | null = null;
  private wanted = false;
  private readonly onVisibility = () => { if (document.hidden) this.halt(); else if (this.wanted) this.begin(); };

  constructor(startAt = 0) {
    this.base = startAt;
    document.addEventListener('visibilitychange', this.onVisibility);
  }
  private begin() { if (this.since === null && !document.hidden) this.since = performance.now(); }
  private halt() { if (this.since !== null) { this.base += (performance.now() - this.since) / 1000; this.since = null; } }
  start() { this.wanted = true; this.begin(); }
  stop() { this.wanted = false; this.halt(); }
  get running() { return this.wanted; }
  seconds(): number { return this.base + (this.since === null ? 0 : (performance.now() - this.since) / 1000); }
  dispose() { this.stop(); document.removeEventListener('visibilitychange', this.onVisibility); }
}
