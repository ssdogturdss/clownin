/**
 * Tests for the PollController build-log polling state machine.
 *
 * Covers the four required scenarios:
 *   1. 3 consecutive failures → interval stopped + retry button should be shown
 *   2. A success in the middle (or after stopping) resets the failure counter
 *   3. Manual retry (reset + startInterval) restarts the interval
 *   4. AppState active transition resumes cleanly (normal poll or reconnect probe)
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { PollController, POLL_FAILURE_THRESHOLD } from './buildLogPolling';

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
