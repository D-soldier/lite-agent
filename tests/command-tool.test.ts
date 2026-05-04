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
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_COMMAND_TIMEOUT_MS,
  RUN_COMMAND_TOOL,
  parseRunCommandArgs,
  resolveCommandCwd,
  runCommandTool,
  type RunCommandShell,
} from "../src/command-tool";

const NODE_STDOUT_COMMAND = 'node -e "process.stdout.write(\'hello\')"';
const NODE_FAIL_COMMAND =
  'node -e "process.stderr.write(\'bad\'); process.exit(7)"';
const NODE_TIMEOUT_COMMAND = 'node -e "setTimeout(()=>{}, 2000)"';
const NODE_LARGE_OUTPUT_COMMAND =
  'node -e "process.stdout.write(\'a\'.repeat(70000)); process.stderr.write(\'e\'.repeat(70000))"';

async function canRunShell(shell: RunCommandShell): Promise<boolean> {
  const result = await runCommandTool({
    command: NODE_STDOUT_COMMAND,
    shell,
    cwd: process.cwd(),
    timeoutMs: 5_000,
  });

  return result.ok && result.stdout === "hello";
}

async function pickAvailableShell(): Promise<RunCommandShell | null> {
  if (await canRunShell("powershell")) {
    return "powershell";
  }

  if (await canRunShell("bash")) {
    return "bash";
  }

  return null;
}

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

describe("runCommandTool", () => {
  it("runs a PowerShell command when PowerShell is available", async () => {
    if (!(await canRunShell("powershell"))) {
      return;
    }

    const root = mkdtempSync(join(tmpdir(), "lite-agent-command-"));

    try {
      const result = await runCommandTool({
        command: NODE_STDOUT_COMMAND,
        shell: "powershell",
        cwd: root,
        timeoutMs: 5_000,
      });

      expect(result).toMatchObject({
        ok: true,
        shell: "powershell",
        command: NODE_STDOUT_COMMAND,
        cwd: root,
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "hello",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      });
      expect(result.durationMs).toEqual(expect.any(Number));
      expect(result.message).toBe("Command exited with code 0.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs a Bash command when Bash is available", async () => {
    if (!(await canRunShell("bash"))) {
      return;
    }

    const root = mkdtempSync(join(tmpdir(), "lite-agent-command-"));

    try {
      const result = await runCommandTool({
        command: NODE_STDOUT_COMMAND,
        shell: "bash",
        cwd: root,
        timeoutMs: 5_000,
      });

      expect(result.ok).toBe(true);
      expect(result.shell).toBe("bash");
      expect(result.stdout).toBe("hello");
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns ok false for non-zero exit codes", async () => {
    const shell = await pickAvailableShell();
    if (!shell) {
      return;
    }

    const root = mkdtempSync(join(tmpdir(), "lite-agent-command-"));

    try {
      const result = await runCommandTool({
        command: NODE_FAIL_COMMAND,
        shell,
        cwd: root,
        timeoutMs: 5_000,
      });

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(7);
      expect(result.timedOut).toBe(false);
      expect(result.stderr).toContain("bad");
      expect(result.message).toBe("Command exited with code 7.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns timedOut when the command exceeds timeoutMs", async () => {
    const shell = await pickAvailableShell();
    if (!shell) {
      return;
    }

    const root = mkdtempSync(join(tmpdir(), "lite-agent-command-"));

    try {
      const result = await runCommandTool({
        command: NODE_TIMEOUT_COMMAND,
        shell,
        cwd: root,
        timeoutMs: 100,
      });

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBeNull();
      expect(result.timedOut).toBe(true);
      expect(result.message).toBe("Command timed out after 100 ms.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("truncates stdout and stderr after 64KB", async () => {
    const shell = await pickAvailableShell();
    if (!shell) {
      return;
    }

    const root = mkdtempSync(join(tmpdir(), "lite-agent-command-"));

    try {
      const result = await runCommandTool({
        command: NODE_LARGE_OUTPUT_COMMAND,
        shell,
        cwd: root,
        timeoutMs: 5_000,
      });

      expect(result.ok).toBe(true);
      expect(Buffer.byteLength(result.stdout ?? "", "utf8")).toBe(
        MAX_COMMAND_OUTPUT_BYTES,
      );
      expect(Buffer.byteLength(result.stderr ?? "", "utf8")).toBe(
        MAX_COMMAND_OUTPUT_BYTES,
      );
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stderrTruncated).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a structured failure when the shell cannot start", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-command-"));

    try {
      const result = await runCommandTool({
        command: "echo hello",
        shell: "bash",
        cwd: root,
        timeoutMs: 5_000,
        executable: "definitely-missing-lite-agent-shell",
      });

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.message).toContain("Failed to start command");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
