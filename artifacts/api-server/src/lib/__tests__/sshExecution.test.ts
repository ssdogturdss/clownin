import { describe, expect, it, vi } from "vitest";
import { buildRemoteProcessGroupStopCommand, createRemoteProcessAborter } from "../sshExecution";

describe("remote process-group stop command", () => {
  it("terminates the entire process group before escalating to KILL", () => {
    const command = buildRemoteProcessGroupStopCommand(4312);

    expect(command).toContain("kill -0 -4312");
    expect(command).toContain("kill -TERM -4312");
    expect(command).toContain("kill -KILL -4312");
    expect(command).toContain("sleep 1");
  });

  it.each([0, 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unsafe process group id %s",
    (pgid) => {
      expect(() => buildRemoteProcessGroupStopCommand(pgid)).toThrow("Invalid remote process group");
    },
  );
});

describe("remote execution cancellation", () => {
  it("keeps the exec channel open for a delayed PGID marker, then kills that group", () => {
    const stopProcessGroup = vi.fn();
    const closeStream = vi.fn();
    const aborter = createRemoteProcessAborter(stopProcessGroup, closeStream, 50);

    aborter.abort();
    // The marker is transported on the exec channel's stderr. It must stay
    // open so the marker can be received after the client has cancelled.
    expect(closeStream).not.toHaveBeenCalled();
    expect(stopProcessGroup).not.toHaveBeenCalled();

    aborter.setProcessGroup(4312);
    aborter.abort();

    expect(stopProcessGroup).toHaveBeenCalledTimes(1);
    expect(stopProcessGroup).toHaveBeenCalledWith(4312);
    expect(closeStream).toHaveBeenCalledTimes(1);
  });

  it("closes a cancelled stream when no PGID marker arrives during the grace period", () => {
    vi.useFakeTimers();
    const stopProcessGroup = vi.fn();
    const closeStream = vi.fn();
    const aborter = createRemoteProcessAborter(stopProcessGroup, closeStream, 50);

    aborter.abort();
    expect(closeStream).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);

    expect(stopProcessGroup).not.toHaveBeenCalled();
    expect(closeStream).toHaveBeenCalledTimes(1);
    aborter.dispose();
    vi.useRealTimers();
  });
});