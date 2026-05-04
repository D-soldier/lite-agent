import { spawn, spawnSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
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
  executable?: string;
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
    const script = `${command}\nif ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE }`;
    const encodedCommand = Buffer.from(script, "utf16le").toString("base64");

    return {
      executable: executable ?? "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodedCommand,
      ],
    };
  }

  return {
    executable: executable ?? "bash",
    args: ["-lc", command],
  };
}

function isUnavailableDefaultWindowsBash(args: ResolvedRunCommandArgs): boolean {
  if (
    process.platform !== "win32" ||
    args.shell !== "bash" ||
    args.executable !== undefined
  ) {
    return false;
  }

  const result = spawnSync("where.exe", ["bash"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const firstBash = result.stdout
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.trim()
    .toLowerCase();

  return (
    firstBash?.endsWith("\\windows\\system32\\bash.exe") === true ||
    firstBash?.endsWith("\\windowsapps\\bash.exe") === true
  );
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

    if (isUnavailableDefaultWindowsBash(args)) {
      finish({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        message: "Failed to start command: Windows default Bash is unavailable.",
      });
      return;
    }

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
