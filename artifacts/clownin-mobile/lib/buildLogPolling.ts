/**
 * buildLogPolling
 *
 * Encapsulates the consecutive-failure state machine that drives build-log
 * polling in EASBuildDetailModal:
 *
 *   • Counts consecutive poll-tick failures.
 *   • Stops the polling interval automatically at POLL_FAILURE_THRESHOLD.
 *   • Resets the counter and stopped flag on the first successful fetch.
 *   • Exposes reset() for manual retry and AppState resume paths.
 *   • Owns the setInterval / clearInterval lifecycle so the logic is fully
 *     testable without a React tree.
 */

export const POLL_FAILURE_THRESHOLD = 3;

export class PollController {
  private _failCount  = 0;
  private _stopped    = false;
  private _intervalId: ReturnType<typeof setInterval> | null = null;

  // ── Read-only state ──────────────────────────────────────────────────────

  get isStopped(): boolean        { return this._stopped; }
  get consecutiveFailures(): number { return this._failCount; }
  get isRunning(): boolean          { return this._intervalId !== null; }

  // ── State transitions ────────────────────────────────────────────────────

  /**
   * Record a successful poll tick.
   * Resets the failure counter and the stopped flag.
   * Returns true if polling had been stopped — the caller should restart
   * the normal 5-second interval and clear any reconnect-probe interval.
   */
  recordSuccess(): boolean {
    const wasStopped    = this._stopped;
    this._failCount     = 0;
    this._stopped       = false;
    return wasStopped;
  }

  /**
   * Record a failed poll tick (must NOT be called for reconnect-probe
   * failures — those are handled silently by the caller).
   *
   * Returns true if this failure crossed the threshold and polling was
   * just stopped; the caller should update the stopped-state UI flag and
   * start the reconnect probe.
   */
  recordFailure(): boolean {
    if (this._stopped) return false; // already stopped — no further accumulation
    this._failCount++;
    if (this._failCount >= POLL_FAILURE_THRESHOLD) {
      this._stopped = true;
      this.clearInterval();
      return true;
    }
    return false;
  }

  /**
   * Reset failure state without touching the interval.  Call this on:
   *   • Manual retry (handlePollRetry)
   *   • AppState active resume when polling was not previously stopped
   *     (so a new interval starts from a clean counter)
   */
  reset(): void {
    this._failCount = 0;
    this._stopped   = false;
  }

  // ── Interval lifecycle ───────────────────────────────────────────────────

  /** Start a new polling interval, clearing any existing one first. */
  startInterval(fn: () => void, ms: number): void {
    this.clearInterval();
    this._intervalId = setInterval(fn, ms);
  }

  /** Clear the active polling interval (if any). */
  clearInterval(): void {
    if (this._intervalId !== null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }
}
