import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  RUN_COMMAND_TOOL,
  parseRunCommandArgs,
  resolveCommandCwd,
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

describe("resolveCommandCwd", () => {
  it("resolves the default cwd to the write root", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-command-"));

    try {
      await expect(resolveCommandCwd(root, ".")).resolves.toBe(resolve(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows a relative directory inside the write root", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-command-"));

    try {
      mkdirSync(join(root, "packages", "app"), { recursive: true });

      await expect(resolveCommandCwd(root, "packages/app")).resolves.toBe(
        join(root, "packages", "app"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows an absolute directory inside the write root", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-command-"));

    try {
      const cwd = join(root, "scripts");
      mkdirSync(cwd);

      await expect(resolveCommandCwd(root, cwd)).resolves.toBe(cwd);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects cwd outside the write root", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-command-"));
    const outside = mkdtempSync(join(tmpdir(), "lite-agent-outside-"));

    try {
      await expect(resolveCommandCwd(root, "../outside")).rejects.toThrow(
        "write root",
      );
      await expect(resolveCommandCwd(root, outside)).rejects.toThrow(
        "write root",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects missing directories and file paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-command-"));

    try {
      writeFileSync(join(root, "file.txt"), "content");

      await expect(resolveCommandCwd(root, "missing")).rejects.toThrow(
        "exist",
      );
      await expect(resolveCommandCwd(root, "file.txt")).rejects.toThrow(
        "directory",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a linked cwd that escapes the write root", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-command-"));
    const outside = mkdtempSync(join(tmpdir(), "lite-agent-outside-"));

    try {
      const linkPath = join(root, "link");

      try {
        symlinkSync(
          outside,
          linkPath,
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "EPERM" || error.code === "EACCES")
        ) {
          return;
        }
        throw error;
      }

      await expect(resolveCommandCwd(root, "link")).rejects.toThrow("linked");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not create directories while resolving cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-command-"));

    try {
      await expect(resolveCommandCwd(root, "missing")).rejects.toThrow();
      expect(existsSync(join(root, "missing"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
