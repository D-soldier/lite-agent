import {
  appendFile,
  lstat,
  mkdir,
  open,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const WRITE_FILE_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "write_file",
    description:
      "Write text content to a file after the CLI confirms with the user.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to write, relative to the configured write root unless it is already inside the write root.",
        },
        content: {
          type: "string",
          description: "Complete text content to write to the file.",
        },
        mode: {
          type: "string",
          enum: ["overwrite", "append"],
          description: "Write mode. Defaults to overwrite.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
};

export const DEFAULT_READ_MAX_BYTES = 262_144;
export const MAX_READ_BYTES = 262_144;

export const READ_FILE_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "read_file",
    description:
      "Read text content from a file inside the configured write root.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to read, relative to the configured write root unless it is already inside the write root.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Byte offset to start reading from. Defaults to 0.",
        },
        maxBytes: {
          type: "integer",
          minimum: 1,
          maximum: MAX_READ_BYTES,
          description:
            "Maximum bytes to read. Defaults to 262144 and cannot exceed 262144.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

export type WriteMode = "overwrite" | "append";

export type WriteFileArgs = {
  path: string;
  content: string;
  mode: WriteMode;
};

export type WriteFileResult = {
  ok: boolean;
  path?: string;
  mode?: WriteMode;
  bytes?: number;
  message: string;
};

export type ReadFileArgs = {
  path: string;
  offset: number;
  maxBytes: number;
};

export type ReadFileResult = {
  ok: boolean;
  path?: string;
  offset?: number;
  bytesRead?: number;
  nextOffset?: number;
  truncated?: boolean;
  content?: string;
  message: string;
};

export function parseWriteFileArgs(raw: unknown): WriteFileArgs {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("write_file args must be an object.");
  }

  const value = raw as Record<string, unknown>;
  const path = value.path;
  const content = value.content;
  const mode = value.mode ?? "overwrite";

  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("write_file.path must be a non-empty string.");
  }

  if (typeof content !== "string") {
    throw new Error("write_file.content must be a string.");
  }

  if (mode !== "overwrite" && mode !== "append") {
    throw new Error("write_file.mode must be overwrite or append.");
  }

  return {
    path,
    content,
    mode,
  };
}

export function parseReadFileArgs(raw: unknown): ReadFileArgs {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("read_file args must be an object.");
  }

  const value = raw as Record<string, unknown>;
  const path = value.path;
  const offset = value.offset ?? 0;
  const maxBytes = value.maxBytes ?? DEFAULT_READ_MAX_BYTES;

  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("read_file.path must be a non-empty string.");
  }

  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
    throw new Error("read_file.offset must be a non-negative integer.");
  }

  if (
    typeof maxBytes !== "number" ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_READ_BYTES
  ) {
    throw new Error(
      `read_file.maxBytes must be an integer between 1 and ${MAX_READ_BYTES}.`,
    );
  }

  return {
    path,
    offset,
    maxBytes,
  };
}

export function resolveWritePath(
  writeRoot: string,
  requestedPath: string,
): string {
  const root = resolve(writeRoot);
  const target = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(root, requestedPath);
  const relativePath = relative(root, target);

  if (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith("../") &&
      !relativePath.startsWith("..\\") &&
      !isAbsolute(relativePath))
  ) {
    return target;
  }

  throw new Error(`Target path is outside the write root: ${root}`);
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

async function rejectLinkedExistingAncestors(
  root: string,
  targetDirectory: string,
): Promise<void> {
  const relativeDirectory = relative(root, targetDirectory);
  if (relativeDirectory === "") {
    return;
  }

  let current = root;
  for (const segment of relativeDirectory.split(sep)) {
    current = resolve(current, segment);

    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`Target path includes a linked directory: ${current}`);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
  }
}

async function ensureSafeWriteTarget(
  writeRoot: string,
  targetPath: string,
): Promise<void> {
  const root = resolve(writeRoot);
  const targetDirectory = dirname(targetPath);

  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);

  await rejectLinkedExistingAncestors(root, targetDirectory);
  await mkdir(targetDirectory, { recursive: true });

  const realTargetDirectory = await realpath(targetDirectory);
  if (!isPathInside(realRoot, realTargetDirectory)) {
    throw new Error(`Target path resolves outside the write root: ${realRoot}`);
  }

  try {
    const targetStats = await lstat(targetPath);
    if (targetStats.isSymbolicLink()) {
      throw new Error(`Target file is a symbolic link: ${targetPath}`);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

async function ensureSafeReadTarget(
  writeRoot: string,
  targetPath: string,
): Promise<{ size: number }> {
  const root = resolve(writeRoot);

  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);

  await rejectLinkedExistingAncestors(root, dirname(targetPath));

  let targetStats;
  try {
    targetStats = await lstat(targetPath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(`Target file does not exist: ${targetPath}`);
    }
    throw error;
  }

  if (targetStats.isSymbolicLink()) {
    throw new Error(`Target file is a symbolic link: ${targetPath}`);
  }

  if (!targetStats.isFile()) {
    throw new Error(`Target path is not a file: ${targetPath}`);
  }

  const realTarget = await realpath(targetPath);
  if (!isPathInside(realRoot, realTarget)) {
    throw new Error(`Target path resolves outside the write root: ${realRoot}`);
  }

  return { size: targetStats.size };
}

export async function writeFileTool(
  writeRoot: string,
  rawArgs: unknown,
): Promise<WriteFileResult> {
  try {
    const args = parseWriteFileArgs(rawArgs);
    const targetPath = resolveWritePath(writeRoot, args.path);
    await ensureSafeWriteTarget(writeRoot, targetPath);

    if (args.mode === "append") {
      await appendFile(targetPath, args.content, "utf8");
    } else {
      await writeFile(targetPath, args.content, "utf8");
    }

    return {
      ok: true,
      path: targetPath,
      mode: args.mode,
      bytes: Buffer.byteLength(args.content, "utf8"),
      message: `Wrote file: ${targetPath}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readFileTool(
  writeRoot: string,
  rawArgs: unknown,
): Promise<ReadFileResult> {
  try {
    const args = parseReadFileArgs(rawArgs);
    const targetPath = resolveWritePath(writeRoot, args.path);
    const { size } = await ensureSafeReadTarget(writeRoot, targetPath);

    if (args.offset > size) {
      throw new Error(
        `read_file.offset ${args.offset} is larger than file size ${size}.`,
      );
    }

    const requestedBytes = Math.min(args.maxBytes, size - args.offset);
    const buffer = Buffer.alloc(requestedBytes);
    let bytesRead = 0;

    if (requestedBytes > 0) {
      const file = await open(targetPath, "r");
      try {
        const result = await file.read(
          buffer,
          0,
          requestedBytes,
          args.offset,
        );
        bytesRead = result.bytesRead;
      } finally {
        await file.close();
      }
    }

    const nextOffset = args.offset + bytesRead;

    return {
      ok: true,
      path: targetPath,
      offset: args.offset,
      bytesRead,
      nextOffset,
      truncated: nextOffset < size,
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      message: `Read file: ${targetPath}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
