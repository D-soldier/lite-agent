# Run Command Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加 `run_command` 工具，让模型可以在用户确认后，在 `LITE_AGENT_WRITE_ROOT` 内执行 PowerShell 或 Bash 命令，并把结构化输出返回给模型。

**Architecture:** 新增独立模块 `src/command-tool.ts`，负责工具 schema、参数解析、cwd 安全解析、子进程执行、超时和输出截断。`src/chat.ts` 只负责注册 `RUN_COMMAND_TOOL`、展示命令确认、在确认后调用命令执行函数；现有 `write_file`、`read_file` 和 conversation log 流程保持不变。

**Tech Stack:** TypeScript, Node.js `child_process.spawn`, Node.js `fs/promises`, OpenAI-compatible chat completions tool calling, Vitest, pnpm.

---

## File Structure

- Create: `src/command-tool.ts`
  - `RUN_COMMAND_TOOL`
  - `RunCommandShell`
  - `RunCommandArgs`
  - `ResolvedRunCommandArgs`
  - `RunCommandResult`
  - `parseRunCommandArgs()`
  - `resolveCommandCwd()`
  - `runCommandTool()`
- Create: `tests/command-tool.test.ts`
  - 覆盖 schema、参数解析、cwd 安全、shell 可用时执行、非零退出、超时、输出截断。
- Modify: `src/chat.ts`
  - 工具列表加入 `RUN_COMMAND_TOOL`。
  - `ConfirmationRequest` 改为 discriminated union，支持 `write_file` 和 `run_command` 两类确认。
  - `askCliConfirmation()` 根据 `request.type` 展示不同文案。
  - `executeToolCall()` 增加 `run_command` 分支。
- Modify: `tests/chat.test.ts`
  - 工具列表断言加入 `run_command`。
  - 覆盖确认、拒绝、执行成功、cwd 越界不确认。

---

### Task 1: Command Tool Schema And Argument Parser

**Files:**
- Create: `src/command-tool.ts`
- Create: `tests/command-tool.test.ts`

- [ ] **Step 1: Write the failing schema and parser tests**

Create `tests/command-tool.test.ts` with this content:

```ts
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
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```powershell
pnpm test tests/command-tool.test.ts
```

Expected: FAIL because `src/command-tool.ts` does not exist.

- [ ] **Step 3: Add the minimal command tool schema and parser**

Create `src/command-tool.ts` with this content:

```ts
import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const MAX_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_COMMAND_OUTPUT_BYTES = 65_536;

export type RunCommandShell = "powershell" | "bash";

export type RunCommandArgs = {
  command: string;
  shell: RunCommandShell;
  cwd: string;
  timeoutMs: number;
};

export type ResolvedRunCommandArgs = Omit<RunCommandArgs, "cwd"> & {
  cwd: string;
};

export type RunCommandResult = {
  ok: boolean;
  shell?: RunCommandShell;
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  durationMs?: number;
  message: string;
};

export const RUN_COMMAND_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_command",
    description:
      "Run a PowerShell or Bash command after the CLI confirms with the user.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Command text to execute after user confirmation.",
        },
        shell: {
          type: "string",
          enum: ["powershell", "bash"],
          description:
            "Shell used to execute the command. Defaults to powershell on Windows and bash elsewhere.",
        },
        cwd: {
          type: "string",
          description:
            "Working directory for the command, relative to the configured write root unless already inside it.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: MAX_COMMAND_TIMEOUT_MS,
          description: "Command timeout in milliseconds. Defaults to 30000.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

export function defaultCommandShell(
  platform: NodeJS.Platform = process.platform,
): RunCommandShell {
  return platform === "win32" ? "powershell" : "bash";
}

export function parseRunCommandArgs(
  raw: unknown,
  platform: NodeJS.Platform = process.platform,
): RunCommandArgs {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("run_command args must be an object.");
  }

  const value = raw as Record<string, unknown>;
  const command = value.command;
  const shell = value.shell ?? defaultCommandShell(platform);
  const cwd = value.cwd ?? ".";
  const timeoutMs = value.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error("run_command.command must be a non-empty string.");
  }

  if (shell !== "powershell" && shell !== "bash") {
    throw new Error("run_command.shell must be powershell or bash.");
  }

  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    throw new Error("run_command.cwd must be a non-empty string.");
  }

  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_COMMAND_TIMEOUT_MS
  ) {
    throw new Error(
      `run_command.timeoutMs must be an integer between 1 and ${MAX_COMMAND_TIMEOUT_MS}.`,
    );
  }

  return {
    command,
    shell,
    cwd,
    timeoutMs,
  };
}
```

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```powershell
pnpm test tests/command-tool.test.ts
```

Expected: PASS for the schema and parser tests.

- [ ] **Step 5: Commit the schema and parser**

Run:

```powershell
git add src/command-tool.ts tests/command-tool.test.ts
git commit -m "feat: add run command tool schema"
```

Expected: commit succeeds with only `src/command-tool.ts` and `tests/command-tool.test.ts` staged.

---

### Task 2: Command cwd Safety

**Files:**
- Modify: `src/command-tool.ts`
- Modify: `tests/command-tool.test.ts`

- [ ] **Step 1: Add failing cwd safety tests**

Replace the import block in `tests/command-tool.test.ts` with:

```ts
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
```

Append this block to `tests/command-tool.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```powershell
pnpm test tests/command-tool.test.ts
```

Expected: FAIL because `resolveCommandCwd` is not exported.

- [ ] **Step 3: Implement cwd safety**

Add these imports at the top of `src/command-tool.ts` before the OpenAI type import:

```ts
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
```

Append this code after `parseRunCommandArgs()`:

```ts
function isPathInside(root: string, target: string): boolean {
  const relativePath = relative(root, target);

  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith("../") &&
      !relativePath.startsWith("..\\") &&
      !isAbsolute(relativePath))
  );
}

async function rejectLinkedCwdSegments(
  root: string,
  cwd: string,
): Promise<void> {
  const relativeDirectory = relative(root, cwd);
  if (relativeDirectory === "") {
    return;
  }

  let current = root;
  for (const segment of relativeDirectory.split(sep)) {
    current = resolve(current, segment);

    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error(`Command cwd includes a linked directory: ${current}`);
    }
  }
}

export async function resolveCommandCwd(
  writeRoot: string,
  requestedCwd = ".",
): Promise<string> {
  const root = resolve(writeRoot);
  const cwd = isAbsolute(requestedCwd)
    ? resolve(requestedCwd)
    : resolve(root, requestedCwd);

  if (!isPathInside(root, cwd)) {
    throw new Error(`Command cwd is outside the write root: ${root}`);
  }

  let rootStats;
  try {
    rootStats = await lstat(root);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(`Command write root does not exist: ${root}`);
    }
    throw error;
  }

  if (rootStats.isSymbolicLink()) {
    throw new Error(`Command write root is a linked directory: ${root}`);
  }

  if (!rootStats.isDirectory()) {
    throw new Error(`Command write root is not a directory: ${root}`);
  }

  const realRoot = await realpath(root);

  try {
    await rejectLinkedCwdSegments(root, cwd);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(`Command cwd does not exist: ${cwd}`);
    }
    throw error;
  }

  let cwdStats;
  try {
    cwdStats = await lstat(cwd);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(`Command cwd does not exist: ${cwd}`);
    }
    throw error;
  }

  if (cwdStats.isSymbolicLink()) {
    throw new Error(`Command cwd is a linked directory: ${cwd}`);
  }

  if (!cwdStats.isDirectory()) {
    throw new Error(`Command cwd is not a directory: ${cwd}`);
  }

  const realCwd = await realpath(cwd);
  if (!isPathInside(realRoot, realCwd)) {
    throw new Error(`Command cwd resolves outside the write root: ${realRoot}`);
  }

  return cwd;
}
```

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```powershell
pnpm test tests/command-tool.test.ts
```

Expected: PASS for parser and cwd safety tests.

- [ ] **Step 5: Commit cwd safety**

Run:

```powershell
git add src/command-tool.ts tests/command-tool.test.ts
git commit -m "feat: add command cwd safety"
```

Expected: commit succeeds with only `src/command-tool.ts` and `tests/command-tool.test.ts` staged.

---

### Task 3: Command Execution Core

**Files:**
- Modify: `src/command-tool.ts`
- Modify: `tests/command-tool.test.ts`

- [ ] **Step 1: Add failing execution tests**

Update the import from `../src/command-tool` in `tests/command-tool.test.ts` to include:

```ts
  MAX_COMMAND_OUTPUT_BYTES,
  runCommandTool,
  type RunCommandShell,
```

Append these helpers near the top of `tests/command-tool.test.ts` after imports:

```ts
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
```

Append this test block:

```ts
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
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```powershell
pnpm test tests/command-tool.test.ts
```

Expected: FAIL because `runCommandTool` is not exported.

- [ ] **Step 3: Implement command execution**

Add this import at the top of `src/command-tool.ts`:

```ts
import { spawn } from "node:child_process";
```

Update `ResolvedRunCommandArgs` in `src/command-tool.ts` to include an optional executable override for tests:

```ts
export type ResolvedRunCommandArgs = Omit<RunCommandArgs, "cwd"> & {
  cwd: string;
  executable?: string;
};
```

Append this code after `resolveCommandCwd()`:

```ts
type OutputCapture = {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
};

function appendLimitedOutput(capture: OutputCapture, chunk: Buffer): void {
  const remainingBytes = MAX_COMMAND_OUTPUT_BYTES - capture.bytes;

  if (remainingBytes > 0) {
    const nextChunk = chunk.subarray(0, remainingBytes);
    capture.chunks.push(nextChunk);
    capture.bytes += nextChunk.byteLength;
  }

  if (chunk.byteLength > remainingBytes) {
    capture.truncated = true;
  }
}

function stringifyOutput(capture: OutputCapture): string {
  return Buffer.concat(capture.chunks, capture.bytes).toString("utf8");
}

function shellInvocation({
  command,
  shell,
  executable,
}: {
  command: string;
  shell: RunCommandShell;
  executable?: string;
}): { executable: string; args: string[] } {
  if (shell === "powershell") {
    return {
      executable: executable ?? "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
      ],
    };
  }

  return {
    executable: executable ?? "bash",
    args: ["-lc", command],
  };
}

export async function runCommandTool(
  args: ResolvedRunCommandArgs,
): Promise<RunCommandResult> {
  const startedAt = Date.now();
  const stdoutCapture: OutputCapture = {
    chunks: [],
    bytes: 0,
    truncated: false,
  };
  const stderrCapture: OutputCapture = {
    chunks: [],
    bytes: 0,
    truncated: false,
  };
  const invocation = shellInvocation(args);

  return await new Promise<RunCommandResult>((resolveResult) => {
    let timedOut = false;
    let settled = false;

    const finish = (
      partial: Pick<
        RunCommandResult,
        "ok" | "exitCode" | "signal" | "timedOut" | "message"
      >,
    ) => {
      if (settled) {
        return;
      }

      settled = true;
      resolveResult({
        shell: args.shell,
        command: args.command,
        cwd: args.cwd,
        stdout: stringifyOutput(stdoutCapture),
        stderr: stringifyOutput(stderrCapture),
        stdoutTruncated: stdoutCapture.truncated,
        stderrTruncated: stderrCapture.truncated,
        durationMs: Date.now() - startedAt,
        ...partial,
      });
    };

    const child = spawn(invocation.executable, invocation.args, {
      cwd: args.cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, args.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      appendLimitedOutput(stdoutCapture, chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      appendLimitedOutput(stderrCapture, chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      finish({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut,
        message: `Failed to start command: ${error.message}`,
      });
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);

      if (timedOut) {
        finish({
          ok: false,
          exitCode: null,
          signal,
          timedOut: true,
          message: `Command timed out after ${args.timeoutMs} ms.`,
        });
        return;
      }

      if (exitCode === null) {
        finish({
          ok: false,
          exitCode,
          signal,
          timedOut: false,
          message: `Command exited with signal ${signal}.`,
        });
        return;
      }

      finish({
        ok: exitCode === 0,
        exitCode,
        signal,
        timedOut: false,
        message: `Command exited with code ${exitCode}.`,
      });
    });
  });
}
```

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```powershell
pnpm test tests/command-tool.test.ts
```

Expected: PASS for schema, parser, cwd safety, and command execution tests. Shell-specific tests may return early only when the requested shell is unavailable.

- [ ] **Step 5: Run TypeScript type checking for the new module**

Run:

```powershell
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit command execution**

Run:

```powershell
git add src/command-tool.ts tests/command-tool.test.ts
git commit -m "feat: execute confirmed shell commands"
```

Expected: commit succeeds with only `src/command-tool.ts` and `tests/command-tool.test.ts` staged.

---

### Task 4: Chat Integration

**Files:**
- Modify: `src/chat.ts`
- Modify: `tests/chat.test.ts`

- [ ] **Step 1: Add failing chat integration tests**

In `tests/chat.test.ts`, update the tool list assertion in `"writes a normal assistant response when no tool call is returned"`:

```ts
expect(firstRequest.tools?.map((tool) => tool.function?.name)).toEqual([
  "write_file",
  "read_file",
  "run_command",
]);
```

Append these tests inside `describe("handleUserMessage", () => { ... })`, after the `read_file` tests:

```ts
it("confirms run_command, executes it, sends tool result, and streams final response", async () => {
  const root = mkdtempSync(join(tmpdir(), "lite-agent-chat-"));

  try {
    const messages: ChatCompletionMessageParam[] = [];
    const writes: string[] = [];
    const confirmations: ConfirmationRequest[] = [];
    const client = createQueuedFakeClient([
      chatMessage({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_command_1",
            type: "function",
            function: {
              name: "run_command",
              arguments: JSON.stringify({
                command: "node -e \"process.stdout.write('command ok')\"",
                shell: process.platform === "win32" ? "powershell" : "bash",
                cwd: ".",
                timeoutMs: 5000,
              }),
            },
          },
        ],
      }),
      chatMessage({ role: "assistant", content: "ready to answer" }),
      streamText("command done"),
    ]);

    await handleUserMessage({
      client,
      model: "test-model",
      writeRoot: root,
      messages,
      userInput: "run a command",
      write: (text) => {
        writes.push(text);
      },
      askConfirmation: async (request) => {
        confirmations.push(request);
        return true;
      },
    });

    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({
      type: "run_command",
      command: "node -e \"process.stdout.write('command ok')\"",
      cwd: root,
      timeoutMs: 5000,
    });

    const toolMessage = messages.find((message) => message.role === "tool");
    if (!toolMessage || typeof toolMessage.content !== "string") {
      throw new Error("Expected run_command tool message");
    }
    const payload = JSON.parse(toolMessage.content) as Record<string, unknown>;

    expect(payload).toMatchObject({
      ok: true,
      cwd: root,
      exitCode: 0,
      timedOut: false,
      stdout: "command ok",
    });
    expect(writes).toEqual(["command done"]);
    expect(messages.at(-1)).toEqual({
      role: "assistant",
      content: "command done",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("does not execute run_command when the user rejects confirmation", async () => {
  const root = mkdtempSync(join(tmpdir(), "lite-agent-chat-"));

  try {
    const messages: ChatCompletionMessageParam[] = [];
    const markerPath = join(root, "marker.txt");
    const client = createQueuedFakeClient([
      chatMessage({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_command_1",
            type: "function",
            function: {
              name: "run_command",
              arguments: JSON.stringify({
                command:
                  "node -e \"require('node:fs').writeFileSync('marker.txt', 'created')\"",
                shell: process.platform === "win32" ? "powershell" : "bash",
                cwd: ".",
              }),
            },
          },
        ],
      }),
      chatMessage({ role: "assistant", content: "ready to answer" }),
      streamText("command rejected"),
    ]);

    await handleUserMessage({
      client,
      model: "test-model",
      writeRoot: root,
      messages,
      userInput: "run a command",
      write: () => undefined,
      askConfirmation: async () => false,
    });

    expect(existsSync(markerPath)).toBe(false);
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        content: expect.stringContaining("用户拒绝执行命令"),
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects run_command cwd outside the write root before confirmation", async () => {
  const root = mkdtempSync(join(tmpdir(), "lite-agent-chat-"));

  try {
    const messages: ChatCompletionMessageParam[] = [];
    let confirmationCalls = 0;
    const client = createQueuedFakeClient([
      chatMessage({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_command_1",
            type: "function",
            function: {
              name: "run_command",
              arguments: JSON.stringify({
                command: "node -e \"process.stdout.write('no')\"",
                shell: process.platform === "win32" ? "powershell" : "bash",
                cwd: "../outside",
              }),
            },
          },
        ],
      }),
      chatMessage({ role: "assistant", content: "ready to answer" }),
      streamText("command failed"),
    ]);

    await handleUserMessage({
      client,
      model: "test-model",
      writeRoot: root,
      messages,
      userInput: "run outside",
      write: () => undefined,
      askConfirmation: async () => {
        confirmationCalls += 1;
        return true;
      },
    });

    const toolMessage = messages.find((message) => message.role === "tool");
    if (!toolMessage || typeof toolMessage.content !== "string") {
      throw new Error("Expected run_command tool message");
    }
    const payload = JSON.parse(toolMessage.content) as Record<string, unknown>;

    expect(confirmationCalls).toBe(0);
    expect(payload.ok).toBe(false);
    expect(payload.message).toEqual(expect.stringContaining("write root"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the focused chat test and confirm it fails**

Run:

```powershell
pnpm test tests/chat.test.ts
```

Expected: FAIL because `AVAILABLE_TOOLS` does not include `run_command`, and `executeToolCall()` does not support it.

- [ ] **Step 3: Update chat imports and tool list**

In `src/chat.ts`, add this import after the conversation-log import:

```ts
import {
  RUN_COMMAND_TOOL,
  parseRunCommandArgs,
  resolveCommandCwd,
  runCommandTool,
} from "./command-tool";
```

Replace `AVAILABLE_TOOLS` with:

```ts
export const AVAILABLE_TOOLS = [
  WRITE_FILE_TOOL,
  READ_FILE_TOOL,
  RUN_COMMAND_TOOL,
];
```

- [ ] **Step 4: Extend confirmation request types**

Replace the current `ConfirmationRequest` type in `src/chat.ts` with:

```ts
export type WriteFileConfirmationRequest = {
  type: "write_file";
  path: string;
  mode: "overwrite" | "append";
  contentLength: number;
};

export type RunCommandConfirmationRequest = {
  type: "run_command";
  shell: "powershell" | "bash";
  command: string;
  cwd: string;
  timeoutMs: number;
};

export type ConfirmationRequest =
  | WriteFileConfirmationRequest
  | RunCommandConfirmationRequest;
```

Update the existing write-file confirmation call in `executeToolCall()`:

```ts
const confirmed = await askConfirmation({
  type: "write_file",
  path: targetPath,
  mode: args.mode,
  contentLength: args.content.length,
});
```

- [ ] **Step 5: Update CLI confirmation output**

Replace `askCliConfirmation()` in `src/chat.ts` with:

```ts
export async function askCliConfirmation(
  rl: Interface,
  request: ConfirmationRequest,
): Promise<boolean> {
  if (request.type === "run_command") {
    stdout.write(
      [
        "\n模型请求执行命令：",
        `shell：${request.shell}`,
        `cwd：${request.cwd}`,
        `timeoutMs：${request.timeoutMs}`,
        `command：${request.command}`,
        "确认执行请输入 y。",
      ].join("\n"),
    );
  } else {
    stdout.write(
      [
        "\n模型请求写入文件：",
        `路径：${request.path}`,
        `模式：${request.mode}`,
        `内容长度：${request.contentLength}`,
        "确认写入请输入 y。",
      ].join("\n"),
    );
  }

  const answer = await rl.question("\nconfirm> ");

  return answer.trim() === "y";
}
```

- [ ] **Step 6: Execute run_command tool calls**

Add this branch in `executeToolCall()` after the `read_file` branch and before the `write_file` branch:

```ts
if (toolCall.function.name === "run_command") {
  try {
    const args = parseRunCommandArgs(
      parseToolArguments(toolCall.function.arguments),
    );
    const cwd = await resolveCommandCwd(writeRoot, args.cwd);
    const confirmed = await askConfirmation({
      type: "run_command",
      shell: args.shell,
      command: args.command,
      cwd,
      timeoutMs: args.timeoutMs,
    });

    if (!confirmed) {
      return toolResult({ ok: false, message: "用户拒绝执行命令。" });
    }

    return JSON.stringify(
      await runCommandTool({
        ...args,
        cwd,
      }),
    );
  } catch (error) {
    return toolResult({ ok: false, message: formatError(error) });
  }
}
```

- [ ] **Step 7: Run focused chat tests and confirm they pass**

Run:

```powershell
pnpm test tests/chat.test.ts
```

Expected: PASS for all chat tests.

- [ ] **Step 8: Run command-tool tests again**

Run:

```powershell
pnpm test tests/command-tool.test.ts
```

Expected: PASS for all command-tool tests.

- [ ] **Step 9: Commit chat integration**

Run:

```powershell
git add src/chat.ts tests/chat.test.ts
git commit -m "feat: wire run command tool into chat"
```

Expected: commit succeeds with only `src/chat.ts` and `tests/chat.test.ts` staged.

---

### Task 5: Final Verification

**Files:**
- Read: `package.json`
- Read: `git status`

- [ ] **Step 1: Run the full automated test suite**

Run:

```powershell
pnpm test
```

Expected: PASS for every test file.

- [ ] **Step 2: Run TypeScript type checking**

Run:

```powershell
pnpm typecheck
```

Expected: command exits with code 0.

- [ ] **Step 3: Check the working tree**

Run:

```powershell
git status --short --branch
```

Expected: branch shows only expected ahead commits plus any pre-existing user changes from the main working tree; there should be no unstaged implementation changes in the implementation worktree.

- [ ] **Step 4: Optional manual CLI command check when a real API key is configured**

Run:

```powershell
pnpm chat
```

At the `you>` prompt, enter:

```text
请运行 pnpm test
```

Expected:

- CLI shows a command confirmation prompt with shell, cwd, timeoutMs, and command.
- Entering `y` executes the command.
- The model receives stdout/stderr and can summarize the test result.
- The newest `logs/*.json` contains the `run_command` tool call and tool result.
