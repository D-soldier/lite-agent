import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  RUN_COMMAND_TOOL,
  parseRunCommandArgs,
} from "../src/command-tool";

describe("RUN_COMMAND_TOOL", () => {
  it("defines the run_command function schema", () => {
    expect(RUN_COMMAND_TOOL.type).toBe("function");
    if (RUN_COMMAND_TOOL.type !== "function") {
      throw new Error("Expected function tool");
    }

    expect(RUN_COMMAND_TOOL.function.name).toBe("run_command");
    expect(RUN_COMMAND_TOOL.function.parameters).toMatchObject({
      type: "object",
      required: ["command"],
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        shell: { type: "string", enum: ["powershell", "bash"] },
        cwd: { type: "string" },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: MAX_COMMAND_TIMEOUT_MS,
        },
      },
    });
  });
});

describe("parseRunCommandArgs", () => {
  it("defaults shell, cwd, and timeout", () => {
    const args = parseRunCommandArgs({ command: "pnpm test" }, "win32");

    expect(args).toEqual({
      command: "pnpm test",
      shell: "powershell",
      cwd: ".",
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    });
  });

  it("defaults to bash on non-Windows platforms", () => {
    expect(parseRunCommandArgs({ command: "pnpm test" }, "linux").shell).toBe(
      "bash",
    );
  });

  it("accepts explicit shell, cwd, and timeout", () => {
    expect(
      parseRunCommandArgs({
        command: "pnpm test",
        shell: "bash",
        cwd: "packages/app",
        timeoutMs: 45_000,
      }),
    ).toEqual({
      command: "pnpm test",
      shell: "bash",
      cwd: "packages/app",
      timeoutMs: 45_000,
    });
  });

  it("rejects invalid args", () => {
    expect(() => parseRunCommandArgs(null)).toThrow("object");
    expect(() => parseRunCommandArgs({ command: "" })).toThrow("command");
    expect(() => parseRunCommandArgs({ command: 123 })).toThrow("command");
    expect(() =>
      parseRunCommandArgs({ command: "pwd", shell: "cmd" }),
    ).toThrow("shell");
    expect(() => parseRunCommandArgs({ command: "pwd", cwd: "" })).toThrow(
      "cwd",
    );
    expect(() => parseRunCommandArgs({ command: "pwd", cwd: 123 })).toThrow(
      "cwd",
    );
    expect(() =>
      parseRunCommandArgs({ command: "pwd", timeoutMs: 0 }),
    ).toThrow("timeoutMs");
    expect(() =>
      parseRunCommandArgs({ command: "pwd", timeoutMs: 1.5 }),
    ).toThrow("timeoutMs");
    expect(() =>
      parseRunCommandArgs({ command: "pwd", timeoutMs: 120_001 }),
    ).toThrow("timeoutMs");
  });
});
