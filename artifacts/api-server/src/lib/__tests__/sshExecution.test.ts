import { describe, expect, it } from "vitest";
import { buildRemoteProcessGroupStopCommand } from "../sshExecution";

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