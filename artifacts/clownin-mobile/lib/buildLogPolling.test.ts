/**
 * Tests for the PollController build-log polling state machine and the
 * shouldRecoverFullLog log-gap recovery predicate.
 *
 * PollController covers four scenarios:
 *   1. 3 consecutive failures → interval stopped + retry button should be shown
 *   2. A success in the middle (or after stopping) resets the failure counter
 *   3. Manual retry (reset + startInterval) restarts the interval
 *   4. AppState active transition resumes cleanly (normal poll or reconnect probe)
 *
 * shouldRecoverFullLog covers three scenarios:
 *   5. Terminal status + stale logOffset → full refetch must fire
 *   6. Terminal status + advancing logOffset (normal delta) → no refetch
 *   7. Active build status → no refetch regardless of offset
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { PollController, POLL_FAILURE_THRESHOLD, shouldRecoverFullLog } from './buildLogPolling';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Returns a no-op tick function and a counter of how many times it ran. */
function makeTick(): { fn: () => void; count: () => number } {
  let n = 0;
  return { fn: () => { n++; }, count: () => n };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('PollController', () => {
  let ctrl: PollController;

  beforeEach(() => {
    ctrl = new PollController();
  });

  afterEach(() => {
    // Always clean up any live interval left by the test.
    ctrl.clearInterval();
  });

  // ── 1. Three consecutive failures stop the interval and signal the UI ──────

  describe('consecutive failures → poll stopped', () => {
    it('exports POLL_FAILURE_THRESHOLD = 3', () => {
      expect(POLL_FAILURE_THRESHOLD).toBe(3);
    });

    it('does not stop after 1 failure', () => {
      ctrl.startInterval(makeTick().fn, 60_000);
      const justStopped = ctrl.recordFailure();
      expect(justStopped).toBe(false);
      expect(ctrl.isStopped).toBe(false);
      expect(ctrl.isRunning).toBe(true);
      expect(ctrl.consecutiveFailures).toBe(1);
    });

    it('does not stop after 2 failures', () => {
      ctrl.startInterval(makeTick().fn, 60_000);
      ctrl.recordFailure();
      const justStopped = ctrl.recordFailure();
      expect(justStopped).toBe(false);
      expect(ctrl.isStopped).toBe(false);
      expect(ctrl.isRunning).toBe(true);
      expect(ctrl.consecutiveFailures).toBe(2);
    });

    it('stops exactly at 3 consecutive failures and clears the interval', () => {
      ctrl.startInterval(makeTick().fn, 60_000);
      ctrl.recordFailure();
      ctrl.recordFailure();
      const justStopped = ctrl.recordFailure(); // 3rd failure
      expect(justStopped).toBe(true);          // signals the UI to show retry button
      expect(ctrl.isStopped).toBe(true);
      expect(ctrl.isRunning).toBe(false);       // interval was cleared
      expect(ctrl.consecutiveFailures).toBe(3);
    });

    it('does not double-count failures once already stopped', () => {
      ctrl.startInterval(makeTick().fn, 60_000);
      ctrl.recordFailure(); ctrl.recordFailure(); ctrl.recordFailure(); // stopped
      const again = ctrl.recordFailure(); // 4th call after stop
      expect(again).toBe(false);           // should not re-signal
      expect(ctrl.consecutiveFailures).toBe(3); // count stays at threshold
    });

    it('ignores any number of reconnect-probe failures', () => {
      ctrl.startInterval(makeTick().fn, 60_000);

      for (let i = 0; i < POLL_FAILURE_THRESHOLD * 10; i++) {
        expect(ctrl.recordFailure(true)).toBe(false);
      }

      expect(ctrl.consecutiveFailures).toBe(0);
      expect(ctrl.isStopped).toBe(false);
      expect(ctrl.isRunning).toBe(true);
    });

    it('keeps the stopped state and idle interval through repeated probe failures', () => {
      ctrl.startInterval(makeTick().fn, 60_000);
      ctrl.recordFailure();
      ctrl.recordFailure();
      ctrl.recordFailure();

      for (let i = 0; i < POLL_FAILURE_THRESHOLD * 10; i++) {
        ctrl.recordFailure(true);
      }

      expect(ctrl.consecutiveFailures).toBe(POLL_FAILURE_THRESHOLD);
      expect(ctrl.isStopped).toBe(true);
      expect(ctrl.isRunning).toBe(false);
    });
  });

  // ── 2. A success resets the failure counter ───────────────────────────────

  describe('success resets failure counter', () => {
    it('recordSuccess after 2 failures resets the counter', () => {
      ctrl.startInterval(makeTick().fn, 60_000);
      ctrl.recordFailure();
      ctrl.recordFailure();
      const wasStopped = ctrl.recordSuccess();
      expect(wasStopped).toBe(false); // was not stopped at the time of success
      expect(ctrl.isStopped).toBe(false);
      expect(ctrl.consecutiveFailures).toBe(0);
    });

    it('recordSuccess after polling stopped resets everything and signals the caller', () => {
      ctrl.startInterval(makeTick().fn, 60_000);
      ctrl.recordFailure(); ctrl.recordFailure(); ctrl.recordFailure(); // stopped
      const wasStopped = ctrl.recordSuccess(); // reconnect probe succeeded
      expect(wasStopped).toBe(true); // caller should restart the 5-second interval
      expect(ctrl.isStopped).toBe(false);
      expect(ctrl.consecutiveFailures).toBe(0);
    });

    it('a probe success after repeated probe failures restarts normal polling', () => {
      ctrl.startInterval(makeTick().fn, 60_000);
      ctrl.recordFailure();
      ctrl.recordFailure();
      ctrl.recordFailure();

      for (let i = 0; i < POLL_FAILURE_THRESHOLD * 10; i++) {
        ctrl.recordFailure(true);
      }
      expect(ctrl.isStopped).toBe(true);
      expect(ctrl.isRunning).toBe(false);

      const wasStopped = ctrl.recordSuccess();
      expect(wasStopped).toBe(true);
      expect(ctrl.consecutiveFailures).toBe(0);
      expect(ctrl.isStopped).toBe(false);

      ctrl.startInterval(makeTick().fn, 5_000);
      expect(ctrl.isRunning).toBe(true);
    });

    it('after a mid-stream success, 3 failures must re-accumulate before stopping', () => {
      ctrl.startInterval(makeTick().fn, 60_000);
      ctrl.recordFailure();
      ctrl.recordFailure(); // 2 failures
      ctrl.recordSuccess(); // reset
      ctrl.recordFailure();
      ctrl.recordFailure();
      expect(ctrl.isStopped).toBe(false); // only 2 failures since reset
      ctrl.recordFailure();
      expect(ctrl.isStopped).toBe(true);  // now 3 since reset
    });

    it('recordSuccess on a fresh controller (no failures) returns wasStopped = false', () => {
      const wasStopped = ctrl.recordSuccess();
      expect(wasStopped).toBe(false);
      expect(ctrl.consecutiveFailures).toBe(0);
    });
  });

  // ── 3. Manual retry: reset() + startInterval() restarts polling ───────────

  describe('manual retry restarts the interval', () => {
    it('reset() clears isStopped and failure counter', () => {
      ctrl.startInterval(makeTick().fn, 60_000);
      ctrl.recordFailure(); ctrl.recordFailure(); ctrl.recordFailure();
      expect(ctrl.isStopped).toBe(true);
      ctrl.reset();
      expect(ctrl.isStopped).toBe(false);
      expect(ctrl.consecutiveFailures).toBe(0);
    });

    it('reset() does not restart the interval by itself', () => {
      ctrl.startInterval(makeTick().fn, 60_000);
      ctrl.recordFailure(); ctrl.recordFailure(); ctrl.recordFailure();
      ctrl.reset();
      expect(ctrl.isRunning).toBe(false); // interval was cleared at stop time
    });

    it('startInterval() after reset() resumes polling', () => {
      ctrl.startInterval(makeTick().fn, 60_000);
      ctrl.recordFailure(); ctrl.recordFailure(); ctrl.recordFailure();
      ctrl.reset();
      ctrl.startInterval(makeTick().fn, 60_000); // manual retry restarted
      expect(ctrl.isRunning).toBe(true);
    });

    it('failures after a manual retry accumulate from zero again', () => {
      ctrl.startInterval(makeTick().fn, 60_000);
      ctrl.recordFailure(); ctrl.recordFailure(); ctrl.recordFailure();
      ctrl.reset();
      ctrl.startInterval(makeTick().fn, 60_000);
      ctrl.recordFailure();
      ctrl.recordFailure();
      expect(ctrl.isStopped).toBe(false); // only 2 failures since retry
    });

    it('clearInterval() + reset() + startInterval() matches the handlePollRetry sequence', () => {
      // Simulate the full handlePollRetry sequence used in EASBuildDetailModal.
      ctrl.startInterval(makeTick().fn, 60_000);
      ctrl.recordFailure(); ctrl.recordFailure(); ctrl.recordFailure(); // stopped
      // handlePollRetry calls:
      ctrl.reset();           // pollControllerRef.current.reset()
      ctrl.startInterval(makeTick().fn, 60_000); // restart 5-second interval
      expect(ctrl.isRunning).toBe(true);
      expect(ctrl.isStopped).toBe(false);
      expect(ctrl.consecutiveFailures).toBe(0);
    });
  });

  // ── 4. AppState active transition resumes cleanly ─────────────────────────

  describe('AppState active transition', () => {
    it('clearInterval() on background then startInterval() on resume resumes normal polling when not stopped', () => {
      ctrl.startInterval(makeTick().fn, 60_000);
      ctrl.recordFailure(); // 1 failure, not stopped
      // App goes to background:
      ctrl.clearInterval();
      expect(ctrl.isRunning).toBe(false);
      expect(ctrl.isStopped).toBe(false); // still not stopped
      // App returns to active → normal resume (isStopped is false):
      ctrl.startInterval(makeTick().fn, 60_000);
      expect(ctrl.isRunning).toBe(true);
      expect(ctrl.isStopped).toBe(false);
    });

    it('when stopped before background, isStopped is preserved across background/active so the reconnect probe starts instead', () => {
      ctrl.startInterval(makeTick().fn, 60_000);
      ctrl.recordFailure(); ctrl.recordFailure(); ctrl.recordFailure(); // stopped
      // App goes to background:
      ctrl.clearInterval();
      // Simulate coming back to active: the component checks isStopped
      // and starts the reconnect probe (not the normal interval) → isStopped must still be true.
      expect(ctrl.isStopped).toBe(true);
      expect(ctrl.isRunning).toBe(false);
    });

    it('reconnect probe success on active resume resets state via recordSuccess', () => {
      ctrl.startInterval(makeTick().fn, 60_000);
      ctrl.recordFailure(); ctrl.recordFailure(); ctrl.recordFailure(); // stopped
      ctrl.clearInterval(); // background
      // Active resume → reconnect probe fires and succeeds:
      const wasStopped = ctrl.recordSuccess();
      expect(wasStopped).toBe(true);  // caller should restart normal interval
      expect(ctrl.isStopped).toBe(false);
      expect(ctrl.consecutiveFailures).toBe(0);
      // Caller then starts the normal interval:
      ctrl.startInterval(makeTick().fn, 60_000);
      expect(ctrl.isRunning).toBe(true);
    });

    it('background transition does not alter the failure counter', () => {
      ctrl.startInterval(makeTick().fn, 60_000);
      ctrl.recordFailure();
      ctrl.recordFailure();
      ctrl.clearInterval(); // background — pauses but does not reset
      expect(ctrl.consecutiveFailures).toBe(2); // still 2
      expect(ctrl.isStopped).toBe(false);
    });
  });

  // ── Interval lifecycle edge cases ─────────────────────────────────────────

  describe('interval lifecycle', () => {
    it('startInterval replaces any existing interval without leaking', () => {
      ctrl.startInterval(makeTick().fn, 60_000);
      expect(ctrl.isRunning).toBe(true);
      ctrl.startInterval(makeTick().fn, 60_000); // should clear old one first
      expect(ctrl.isRunning).toBe(true);
    });

    it('clearInterval on an idle controller is a no-op', () => {
      expect(ctrl.isRunning).toBe(false);
      ctrl.clearInterval(); // should not throw
      expect(ctrl.isRunning).toBe(false);
    });
  });
});

// ── shouldRecoverFullLog ──────────────────────────────────────────────────────

describe('shouldRecoverFullLog', () => {
  // ── 5. Terminal status + stale logOffset → full refetch must fire ─────────

  describe('terminal build + stale offset → triggers full refetch', () => {
    it('returns true when build is terminal, offset > 0, and serverLogOffset equals requestedOffset', () => {
      // Simulates: app was backgrounded at offset 42; when it resumes the
      // silent catch-up poll gets back logOffset=42 (no new lines), build=FINISHED.
      expect(shouldRecoverFullLog({
        silent: true,
        requestedOffset: 42,
        terminalStatus: true,
        serverLogOffset: 42,
      })).toBe(true);
    });

    it('returns true when serverLogOffset is strictly less than requestedOffset', () => {
      // Simulates server log rotation: server reports logOffset=10 even though
      // we requested from offset 80 — the buffer was truncated.
      expect(shouldRecoverFullLog({
        silent: true,
        requestedOffset: 80,
        terminalStatus: true,
        serverLogOffset: 10,
      })).toBe(true);
    });

    it('returns true when serverLogOffset is 0 (empty buffer after rotation)', () => {
      expect(shouldRecoverFullLog({
        silent: true,
        requestedOffset: 55,
        terminalStatus: true,
        serverLogOffset: 0,
      })).toBe(true);
    });
  });

  // ── 6. Terminal status + advancing logOffset (normal delta) → no refetch ──

  describe('terminal build + advancing offset → no recovery needed', () => {
    it('returns false when serverLogOffset advances past requestedOffset (new lines arrived)', () => {
      // Normal case: the build finished and the server delivered the final
      // batch of lines — logOffset moved from 42 to 57.
      expect(shouldRecoverFullLog({
        silent: true,
        requestedOffset: 42,
        terminalStatus: true,
        serverLogOffset: 57,
      })).toBe(false);
    });

    it('returns false when requestedOffset is 0 (initial full load, not a delta poll)', () => {
      // The very first fetch always uses offset=0; recovery must never
      // trigger on the initial load even if status is already terminal.
      expect(shouldRecoverFullLog({
        silent: true,
        requestedOffset: 0,
        terminalStatus: true,
        serverLogOffset: 0,
      })).toBe(false);
    });

    it('returns false when silent is false (non-silent initial load)', () => {
      // A non-silent fetch is the initial page load; recovery only applies
      // to silent poll ticks.
      expect(shouldRecoverFullLog({
        silent: false,
        requestedOffset: 42,
        terminalStatus: true,
        serverLogOffset: 42,
      })).toBe(false);
    });
  });

  // ── 7. Active build status → no refetch regardless of offset ─────────────

  describe('active build → no recovery triggered', () => {
    it('returns false when build is still active (IN_PROGRESS) even if offset is stale', () => {
      // The build is still running — a stale-looking offset just means no new
      // lines arrived yet; do not trigger a full reload.
      expect(shouldRecoverFullLog({
        silent: true,
        requestedOffset: 30,
        terminalStatus: false,  // isActive(status) === true
        serverLogOffset: 30,
      })).toBe(false);
    });

    it('returns false when build is queued (IN_QUEUE) with zero offset', () => {
      expect(shouldRecoverFullLog({
        silent: true,
        requestedOffset: 0,
        terminalStatus: false,
        serverLogOffset: 0,
      })).toBe(false);
    });

    it('returns false when build is active and serverLogOffset is behind requestedOffset', () => {
      // Even if offset looks stale, an active build means we must wait — no recovery.
      expect(shouldRecoverFullLog({
        silent: true,
        requestedOffset: 100,
        terminalStatus: false,
        serverLogOffset: 80,
      })).toBe(false);
    });
  });
});
