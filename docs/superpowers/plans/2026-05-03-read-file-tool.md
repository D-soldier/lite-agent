# Read File Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加 `read_file` 工具，让模型可以在允许的项目根目录内读取文本文件，并通过 `offset` 分段继续读取大文件。

**Architecture:** 第一版继续放在现有 `src/file-tool.ts` 中，复用 `write_file` 的根目录解析和路径越界判断，新增只读的安全检查和分段读取逻辑。`src/chat.ts` 只负责把 `read_file` 暴露给模型并执行 tool call，读取结果会自然进入现有 `messages` 和 conversation log。

**Tech Stack:** TypeScript, Node.js `fs/promises`, OpenAI-compatible chat completions tool calling, Vitest, pnpm.

---

## File Structure

- Modify: `src/file-tool.ts`
  - 新增 `READ_FILE_TOOL` schema。
  - 新增 `parseReadFileArgs()`、`readFileTool()` 和 `ensureSafeReadTarget()`。
  - 继续复用 `resolveWritePath()`、`isPathInside()`、`rejectLinkedExistingAncestors()`。
- Modify: `src/chat.ts`
  - 工具列表从只包含 `WRITE_FILE_TOOL` 改为同时包含 `WRITE_FILE_TOOL` 和 `READ_FILE_TOOL`。
  - `executeToolCall()` 增加 `read_file` 分支。
  - `write_file` 用户确认流程保持不变，`read_file` 不询问用户确认。
- Modify: `tests/file-tool.test.ts`
  - 覆盖 read 工具 schema、参数解析、分段读取、边界条件、路径越界和 symlink/junction 安全。
- Modify: `tests/chat.test.ts`
  - 覆盖聊天请求暴露两个工具。
  - 覆盖 `read_file` 成功和失败的 tool-call 流程。

---

### Task 1: Add Read File Schema And Argument Parser

**Files:**
- Modify: `src/file-tool.ts`
- Test: `tests/file-tool.test.ts`

- [ ] **Step 1: Write the failing schema and parser tests**

Update the import block in `tests/file-tool.test.ts`:

```ts
import {
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  parseReadFileArgs,
  parseWriteFileArgs,
  resolveWritePath,
  writeFileTool,
} from "../src/file-tool";
```

Append these tests after the existing `WRITE_FILE_TOOL` describe block:

```ts
describe("READ_FILE_TOOL", () => {
  it("defines the read_file function schema", () => {
    expect(READ_FILE_TOOL.type).toBe("function");
    if (READ_FILE_TOOL.type !== "function") {
      throw new Error("Expected function tool");
    }

    expect(READ_FILE_TOOL.function.name).toBe("read_file");
    expect(READ_FILE_TOOL.function.parameters).toMatchObject({
      type: "object",
      required: ["path"],
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        maxBytes: { type: "integer", minimum: 1, maximum: 262144 },
      },
    });
  });
});
```

Append these tests after the existing `parseWriteFileArgs` describe block:

```ts
describe("parseReadFileArgs", () => {
  it("defaults offset to zero and maxBytes to 256KB", () => {
    expect(parseReadFileArgs({ path: "notes/hello.txt" })).toEqual({
      path: "notes/hello.txt",
      offset: 0,
      maxBytes: 262144,
    });
  });

  it("accepts explicit offset and maxBytes", () => {
    expect(
      parseReadFileArgs({
        path: "notes/hello.txt",
        offset: 12,
        maxBytes: 4096,
      }),
    ).toEqual({
      path: "notes/hello.txt",
      offset: 12,
      maxBytes: 4096,
    });
  });

  it("rejects invalid args", () => {
    expect(() => parseReadFileArgs(null)).toThrow("object");
    expect(() => parseReadFileArgs({ path: "" })).toThrow("path");
    expect(() => parseReadFileArgs({ path: "notes/hello.txt", offset: -1 }))
      .toThrow("offset");
    expect(() => parseReadFileArgs({ path: "notes/hello.txt", offset: 1.5 }))
      .toThrow("offset");
    expect(() => parseReadFileArgs({ path: "notes/hello.txt", maxBytes: 0 }))
      .toThrow("maxBytes");
    expect(() =>
      parseReadFileArgs({ path: "notes/hello.txt", maxBytes: 1.5 }),
    ).toThrow("maxBytes");
    expect(() =>
      parseReadFileArgs({ path: "notes/hello.txt", maxBytes: 262145 }),
    ).toThrow("maxBytes");
  });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```powershell
pnpm test tests/file-tool.test.ts
```

Expected: FAIL with TypeScript/runtime errors showing `READ_FILE_TOOL` and `parseReadFileArgs` are not exported from `src/file-tool.ts`.

- [ ] **Step 3: Add the minimal schema, types, and parser**

In `src/file-tool.ts`, add this block after `WRITE_FILE_TOOL`:

```ts
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
```

Add these exported types after `WriteFileResult`:

```ts
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
```

Add this parser after `parseWriteFileArgs()`:

```ts
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
```

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```powershell
pnpm test tests/file-tool.test.ts
```

Expected: PASS for the new schema/parser tests and all existing write-file tests.

- [ ] **Step 5: Commit the schema and parser**

Run:

```powershell
git add src/file-tool.ts tests/file-tool.test.ts
git commit -m "feat: add read file tool schema"
```

Expected: commit succeeds with only `src/file-tool.ts` and `tests/file-tool.test.ts` staged.

---

### Task 2: Implement Safe Read File Core

**Files:**
- Modify: `src/file-tool.ts`
- Test: `tests/file-tool.test.ts`

- [ ] **Step 1: Write the failing readFileTool tests**

Update the import block in `tests/file-tool.test.ts`:

```ts
import {
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  parseReadFileArgs,
  parseWriteFileArgs,
  readFileTool,
  resolveWritePath,
  writeFileTool,
} from "../src/file-tool";
```

Append these tests after the existing `writeFileTool` describe block:

```ts
describe("readFileTool", () => {
  it("reads a relative text file", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-read-"));

    try {
      const targetDir = join(root, "notes");
      const target = join(targetDir, "hello.txt");
      mkdirSync(targetDir);
      writeFileSync(target, "hello world");

      const result = await readFileTool(root, {
        path: "notes/hello.txt",
      });

      expect(result).toMatchObject({
        ok: true,
        path: target,
        offset: 0,
        bytesRead: 11,
        nextOffset: 11,
        truncated: false,
        content: "hello world",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads from an offset and reports truncation", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-read-"));

    try {
      const target = join(root, "sample.txt");
      writeFileSync(target, "abcdef");

      const result = await readFileTool(root, {
        path: "sample.txt",
        offset: 2,
        maxBytes: 3,
      });

      expect(result).toMatchObject({
        ok: true,
        offset: 2,
        bytesRead: 3,
        nextOffset: 5,
        truncated: true,
        content: "cde",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns empty content when offset equals file size", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-read-"));

    try {
      const target = join(root, "sample.txt");
      writeFileSync(target, "abc");

      const result = await readFileTool(root, {
        path: "sample.txt",
        offset: 3,
      });

      expect(result).toMatchObject({
        ok: true,
        offset: 3,
        bytesRead: 0,
        nextOffset: 3,
        truncated: false,
        content: "",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when offset is larger than file size", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-read-"));

    try {
      const target = join(root, "sample.txt");
      writeFileSync(target, "abc");

      const result = await readFileTool(root, {
        path: "sample.txt",
        offset: 4,
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("offset");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails for directories and missing files", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-read-"));

    try {
      mkdirSync(join(root, "notes"));

      const directoryResult = await readFileTool(root, { path: "notes" });
      const missingResult = await readFileTool(root, { path: "missing.txt" });

      expect(directoryResult.ok).toBe(false);
      expect(directoryResult.message).toContain("file");
      expect(missingResult.ok).toBe(false);
      expect(missingResult.message).toContain("exist");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not read paths outside the write root", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-read-"));

    try {
      const outsideName = `${basename(root)}-outside.txt`;
      const outsidePath = resolve(root, "..", outsideName);
      writeFileSync(outsidePath, "secret");

      const result = await readFileTool(root, {
        path: `../${outsideName}`,
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("write root");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(resolve(root, "..", `${basename(root)}-outside.txt`), {
        force: true,
      });
    }
  });

  it("does not follow a directory symlink or junction outside the write root", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-read-"));
    const outside = mkdtempSync(join(tmpdir(), "lite-agent-outside-"));

    try {
      const linkPath = join(root, "link");
      writeFileSync(join(outside, "outside.txt"), "secret");

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

      const result = await readFileTool(root, {
        path: "link/outside.txt",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("linked");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not read an existing symlink file", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-read-"));
    const outside = mkdtempSync(join(tmpdir(), "lite-agent-outside-"));

    try {
      const outsideTarget = join(outside, "target.txt");
      writeFileSync(outsideTarget, "secret");

      try {
        symlinkSync(outsideTarget, join(root, "target.txt"), "file");
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

      const result = await readFileTool(root, {
        path: "target.txt",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("symbolic link");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```powershell
pnpm test tests/file-tool.test.ts
```

Expected: FAIL because `readFileTool` is not exported.

- [ ] **Step 3: Implement safe read support**

Update the `node:fs/promises` import in `src/file-tool.ts`:

```ts
import {
  appendFile,
  lstat,
  mkdir,
  open,
  realpath,
  writeFile,
} from "node:fs/promises";
```

Add this helper after `ensureSafeWriteTarget()`:

```ts
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
```

Add this exported tool implementation after `writeFileTool()`:

```ts
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
```

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```powershell
pnpm test tests/file-tool.test.ts
```

Expected: PASS for all read-file and existing write-file tests.

- [ ] **Step 5: Commit the read-file core**

Run:

```powershell
git add src/file-tool.ts tests/file-tool.test.ts
git commit -m "feat: add safe read file tool"
```

Expected: commit succeeds with only the core implementation and file-tool tests staged.

---

### Task 3: Add Chat Flow Tests For read_file

**Files:**
- Modify: `tests/chat.test.ts`

- [ ] **Step 1: Update test imports**

Update the `node:fs` import in `tests/chat.test.ts`:

```ts
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
```

- [ ] **Step 2: Tighten the tool list assertion**

In the `"writes a normal assistant response when no tool call is returned"` test, replace the existing `expect(client.calls[0]).toMatchObject({ ... tools ... })` assertion with:

```ts
const firstRequest = client.calls[0] as {
  tools?: Array<{ function?: { name?: string } }>;
};

expect(firstRequest.tools?.map((tool) => tool.function?.name)).toEqual([
  "write_file",
  "read_file",
]);
```

- [ ] **Step 3: Add read_file success and failure tests**

Append these tests inside the existing `describe("handleUserMessage", () => { ... })` block after the write-file success test:

```ts
it("executes read_file without confirmation and streams the final response", async () => {
  const root = mkdtempSync(join(tmpdir(), "lite-agent-chat-"));

  try {
    const targetDir = join(root, "notes");
    mkdirSync(targetDir);
    writeFileSync(join(targetDir, "hello.txt"), "hello world");

    const messages: ChatCompletionMessageParam[] = [];
    const writes: string[] = [];
    let confirmationCalls = 0;
    const client = createQueuedFakeClient([
      chatMessage({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_read_1",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({
                path: "notes/hello.txt",
                maxBytes: 5,
              }),
            },
          },
        ],
      }),
      chatMessage({ role: "assistant", content: "ready to answer" }),
      streamText("read done"),
    ]);

    await handleUserMessage({
      client,
      model: "test-model",
      writeRoot: root,
      messages,
      userInput: "read a file",
      write: (text) => {
        writes.push(text);
      },
      askConfirmation: async () => {
        confirmationCalls += 1;
        throw new Error("read_file should not ask for confirmation");
      },
    });

    const toolMessage = messages.find((message) => message.role === "tool");
    if (!toolMessage || typeof toolMessage.content !== "string") {
      throw new Error("Expected read_file tool message");
    }
    const payload = JSON.parse(toolMessage.content) as Record<string, unknown>;

    expect(confirmationCalls).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      offset: 0,
      bytesRead: 5,
      nextOffset: 5,
      truncated: true,
      content: "hello",
    });
    expect(writes).toEqual(["read done"]);
    expect(client.calls).toHaveLength(3);
    expect(client.calls[2]).toMatchObject({
      model: "test-model",
      messages,
      stream: true,
    });
    expect(messages.at(-1)).toEqual({
      role: "assistant",
      content: "read done",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("returns a read_file tool error and still streams the final response", async () => {
  const root = mkdtempSync(join(tmpdir(), "lite-agent-chat-"));

  try {
    writeFileSync(join(root, "short.txt"), "abc");

    const messages: ChatCompletionMessageParam[] = [];
    const writes: string[] = [];
    let confirmationCalls = 0;
    const client = createQueuedFakeClient([
      chatMessage({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_read_1",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({
                path: "short.txt",
                offset: 4,
              }),
            },
          },
        ],
      }),
      chatMessage({ role: "assistant", content: "ready to answer" }),
      streamText("read failed"),
    ]);

    await handleUserMessage({
      client,
      model: "test-model",
      writeRoot: root,
      messages,
      userInput: "read past the end",
      write: (text) => {
        writes.push(text);
      },
      askConfirmation: async () => {
        confirmationCalls += 1;
        throw new Error("read_file should not ask for confirmation");
      },
    });

    const toolMessage = messages.find((message) => message.role === "tool");
    if (!toolMessage || typeof toolMessage.content !== "string") {
      throw new Error("Expected read_file tool message");
    }
    const payload = JSON.parse(toolMessage.content) as Record<string, unknown>;

    expect(confirmationCalls).toBe(0);
    expect(payload.ok).toBe(false);
    expect(payload.message).toEqual(expect.stringContaining("offset"));
    expect(writes).toEqual(["read failed"]);
    expect(messages.at(-1)).toEqual({
      role: "assistant",
      content: "read failed",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Run the chat tests and confirm they fail**

Run:

```powershell
pnpm test tests/chat.test.ts
```

Expected: FAIL because `requestToolOrText()` still sends only `write_file`, and `executeToolCall()` still reports `read_file` as unsupported.

---

### Task 4: Wire read_file Into Chat Tool Execution

**Files:**
- Modify: `src/chat.ts`
- Test: `tests/chat.test.ts`

- [ ] **Step 1: Update chat imports**

Update the `./file-tool` import in `src/chat.ts`:

```ts
import {
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  parseWriteFileArgs,
  readFileTool,
  resolveWritePath,
  writeFileTool,
} from "./file-tool";
```

- [ ] **Step 2: Add a shared tool list**

Add this line after `export const MAX_TOOL_ROUNDS = 2;`:

```ts
export const AVAILABLE_TOOLS = [WRITE_FILE_TOOL, READ_FILE_TOOL];
```

- [ ] **Step 3: Send both tools to the model**

In `requestToolOrText()`, replace:

```ts
tools: [WRITE_FILE_TOOL],
```

with:

```ts
tools: AVAILABLE_TOOLS,
```

- [ ] **Step 4: Execute read_file without confirmation**

Replace the name check and body of `executeToolCall()` with this branch structure:

```ts
  if (toolCall.function.name === "read_file") {
    try {
      const args = parseToolArguments(toolCall.function.arguments);

      return JSON.stringify(await readFileTool(writeRoot, args));
    } catch (error) {
      return toolResult({ ok: false, message: formatError(error) });
    }
  }

  if (toolCall.function.name === "write_file") {
    try {
      const args = parseWriteFileArgs(
        parseToolArguments(toolCall.function.arguments),
      );
      const targetPath = resolveWritePath(writeRoot, args.path);
      const confirmed = await askConfirmation({
        path: targetPath,
        mode: args.mode,
        contentLength: args.content.length,
      });

      if (!confirmed) {
        return toolResult({ ok: false, message: "用户拒绝写入。" });
      }

      return JSON.stringify(await writeFileTool(writeRoot, args));
    } catch (error) {
      return toolResult({ ok: false, message: formatError(error) });
    }
  }

  return toolResult({
    ok: false,
    message: `不支持的工具：${toolCall.function.name}`,
  });
```

The `toolCall.type !== "function"` guard at the top of `executeToolCall()` stays in place.

- [ ] **Step 5: Run the focused chat tests and confirm they pass**

Run:

```powershell
pnpm test tests/chat.test.ts
```

Expected: PASS for all chat tests, including existing `write_file` confirmation tests.

- [ ] **Step 6: Run file-tool tests again**

Run:

```powershell
pnpm test tests/file-tool.test.ts
```

Expected: PASS for all file-tool tests.

- [ ] **Step 7: Commit chat integration**

Run:

```powershell
git add src/chat.ts tests/chat.test.ts
git commit -m "feat: wire read file tool into chat"
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

Expected: branch shows only expected ahead commits plus the pre-existing untracked `1.txt`; there should be no unstaged implementation changes.

- [ ] **Step 4: Optional manual CLI read check when a real API key is configured**

Run:

```powershell
Set-Content -Path .\manual-read-file-tool-smoke.txt -Value "manual read smoke"
pnpm chat
```

At the `you>` prompt, enter:

```text
请读取 manual-read-file-tool-smoke.txt，并复述文件内容。
```

Expected:
- CLI should not ask for write confirmation.
- The model should call `read_file` and include `manual read smoke` in its final answer.
- The newest `logs/*.json` should contain the `read_file` tool call and the tool result.

After the manual check, run:

```powershell
Remove-Item -LiteralPath .\manual-read-file-tool-smoke.txt -Force
git status --short --branch
```

Expected: the manual smoke file is removed and no tracked files changed.
