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
