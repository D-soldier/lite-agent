import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  ) {
    return target;
  }

  throw new Error(`Target path is outside the write root: ${root}`);
}

export async function writeFileTool(
  writeRoot: string,
  rawArgs: unknown,
): Promise<WriteFileResult> {
  try {
    const args = parseWriteFileArgs(rawArgs);
    const targetPath = resolveWritePath(writeRoot, args.path);
    await mkdir(dirname(targetPath), { recursive: true });

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
