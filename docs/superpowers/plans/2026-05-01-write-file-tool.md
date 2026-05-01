# Write File Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为现有 DeepSeek CLI 增加 `write_file` 工具，让模型可以在用户确认后把内容写入允许根目录内的文件。

**Architecture:** 将当前 `src/index.ts` 拆成 `config.ts`、`file-tool.ts`、`chat.ts` 和瘦入口 `index.ts`。先用测试锁定配置与路径安全，再实现文件写入工具，最后把 OpenAI-compatible tool-call 回合接入聊天流程。

**Tech Stack:** Node.js、TypeScript、OpenAI SDK、DeepSeek Function Calling、Vitest、dotenv、Node fs/path/readline。

---

## 文件结构

- Modify: `src/index.ts`  
  保留 CLI 入口：加载 `.env`、读取配置、创建 client、启动 chat loop。
- Create: `src/config.ts`  
  负责 `.env` 加载、DeepSeek 配置读取、`writeRoot` 读取。
- Create: `src/file-tool.ts`  
  负责 `WRITE_FILE_TOOL` schema、工具参数解析、路径安全校验、覆盖/追加写入。
- Create: `src/chat.ts`  
  负责对话循环、普通模型请求、tool-call 请求、用户确认、工具结果回传、最终流式回复。
- Modify: `tests/index.test.ts`  
  保留入口级测试，只覆盖 `isDirectRun()`。
- Create: `tests/config.test.ts`  
  覆盖 `.env` 加载和配置读取。
- Create: `tests/file-tool.test.ts`  
  覆盖路径安全、参数解析、覆盖和追加写入。
- Create: `tests/chat.test.ts`  
  覆盖无工具调用、确认写入、拒绝写入、非法参数和未知工具等 chat 流程。

## Task 1: 抽出配置模块

**Files:**
- Create: `src/config.ts`
- Modify: `src/index.ts`
- Modify: `tests/index.test.ts`
- Create: `tests/config.test.ts`

- [ ] **Step 1: 写配置模块失败测试**

Create `tests/config.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  loadEnvFile,
  readConfig,
} from "../src/config";

describe("loadEnvFile", () => {
  it("loads .env values without overriding existing environment values", () => {
    const dir = mkdtempSync(join(tmpdir(), "lite-agent-env-"));

    try {
      const envFilePath = join(dir, ".env");
      const env = { DEEPSEEK_API_KEY: "existing-key" };
      writeFileSync(
        envFilePath,
        [
          "DEEPSEEK_API_KEY=file-key",
          "DEEPSEEK_MODEL=file-model",
          "DEEPSEEK_BASE_URL=https://file.example",
          "LITE_AGENT_WRITE_ROOT=notes",
          "",
        ].join("\n"),
      );

      loadEnvFile(envFilePath, env);

      expect(env).toEqual({
        DEEPSEEK_API_KEY: "existing-key",
        DEEPSEEK_MODEL: "file-model",
        DEEPSEEK_BASE_URL: "https://file.example",
        LITE_AGENT_WRITE_ROOT: "notes",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a missing .env file", () => {
    const env = {};

    expect(() => loadEnvFile("missing.env", env)).not.toThrow();
    expect(env).toEqual({});
  });
});

describe("readConfig", () => {
  it("throws when DEEPSEEK_API_KEY is missing", () => {
    expect(() => readConfig({})).toThrow("DEEPSEEK_API_KEY");
  });

  it("uses DeepSeek defaults and cwd write root when optional env vars are absent", () => {
    expect(readConfig({ DEEPSEEK_API_KEY: "sk-test" })).toEqual({
      apiKey: "sk-test",
      baseURL: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
      writeRoot: process.cwd(),
    });
  });

  it("allows model, base URL, and write root overrides", () => {
    expect(
      readConfig({
        DEEPSEEK_API_KEY: "sk-test",
        DEEPSEEK_MODEL: "custom-model",
        DEEPSEEK_BASE_URL: "https://example.test",
        LITE_AGENT_WRITE_ROOT: "sandbox",
      }),
    ).toEqual({
      apiKey: "sk-test",
      baseURL: "https://example.test",
      model: "custom-model",
      writeRoot: resolve("sandbox"),
    });
  });
});
```

- [ ] **Step 2: 缩小入口测试**

Replace `tests/index.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { isDirectRun } from "../src/index";

describe("isDirectRun", () => {
  it("detects when the current module is the process entry", () => {
    expect(isDirectRun("file:///tmp/app/src/index.ts", "/tmp/app/src/index.ts")).toBe(
      true,
    );
  });

  it("returns false when argv path is missing", () => {
    expect(isDirectRun("file:///tmp/app/src/index.ts", undefined)).toBe(false);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run:

```bash
pnpm test
```

Expected: FAIL because `src/config.ts` does not exist and old exports are no longer available from `src/index.ts`.

- [ ] **Step 4: 实现 `src/config.ts`**

Create `src/config.ts`:

```ts
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL = "deepseek-v4-flash";

export type AppConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
  writeRoot: string;
};

type Env = Partial<Record<string, string>>;

export function loadEnvFile(
  envFilePath = ".env",
  env: NodeJS.ProcessEnv = process.env,
): void {
  const result = loadDotenv({
    path: envFilePath,
    processEnv: env,
    override: false,
    quiet: true,
  });
  const error = result.error as NodeJS.ErrnoException | undefined;

  if (error && error.code !== "ENOENT") {
    throw error;
  }
}

export function readConfig(env: Env = process.env): AppConfig {
  const apiKey = env.DEEPSEEK_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      "缺少 DEEPSEEK_API_KEY。请先设置环境变量后再运行 pnpm chat。",
    );
  }

  return {
    apiKey,
    baseURL: env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL,
    model: env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL,
    writeRoot: resolve(env.LITE_AGENT_WRITE_ROOT?.trim() || process.cwd()),
  };
}
```

- [ ] **Step 5: 更新 `src/index.ts` 为瘦入口**

Replace `src/index.ts` with:

```ts
import OpenAI from "openai";
import { pathToFileURL } from "node:url";
import { loadEnvFile, readConfig } from "./config";
import { runChatLoop, formatError } from "./chat";

export function createClient(config = readConfig()): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
}

export function isDirectRun(metaUrl: string, argvPath?: string): boolean {
  if (!argvPath) {
    return false;
  }

  const candidates = [pathToFileURL(argvPath).href];

  if (argvPath.startsWith("/")) {
    candidates.push(`file://${argvPath}`);
  }

  return candidates.includes(metaUrl);
}

export async function main(): Promise<void> {
  try {
    loadEnvFile();
    const config = readConfig();
    const client = createClient(config);
    await runChatLoop({ client, model: config.model, writeRoot: config.writeRoot });
  } catch (error) {
    console.error(`错误：${formatError(error)}`);
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void main();
}
```

- [ ] **Step 6: Temporarily create `src/chat.ts` compatibility module**

Create `src/chat.ts` with current chat behavior so Task 1 can pass before tool support is added:

```ts
import OpenAI from "openai";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

export type RunChatLoopOptions = {
  client: OpenAI;
  model: string;
  writeRoot: string;
};

export type SendMessageOptions = {
  client: OpenAI;
  model: string;
  messages: ChatCompletionMessageParam[];
  write?: (text: string) => void;
};

export function isExitCommand(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return normalized === "exit" || normalized === "quit";
}

export function extractDelta(chunk: {
  choices?: Array<{ delta?: { content?: string | null } }>;
}): string {
  return chunk.choices?.[0]?.delta?.content ?? "";
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export async function sendMessage({
  client,
  model,
  messages,
  write = (text) => {
    stdout.write(text);
  },
}: SendMessageOptions): Promise<string> {
  const stream = await client.chat.completions.create({
    model,
    messages,
    stream: true,
  });
  let response = "";

  for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
    const delta = extractDelta(chunk);

    if (delta.length > 0) {
      write(delta);
      response += delta;
    }
  }

  return response;
}

export async function runChatLoop({
  client,
  model,
}: RunChatLoopOptions): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const messages: ChatCompletionMessageParam[] = [];
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    stdout.write("\n");
    rl.close();
  };

  process.once("SIGINT", onSigint);

  try {
    while (!interrupted) {
      let rawInput: string;

      try {
        rawInput = await rl.question("you> ");
      } catch (error) {
        if (interrupted) {
          break;
        }

        throw error;
      }

      const userInput = rawInput.trim();

      if (userInput.length === 0) {
        continue;
      }

      if (isExitCommand(userInput)) {
        break;
      }

      messages.push({ role: "user", content: userInput });

      try {
        const response = await sendMessage({ client, model, messages });
        stdout.write("\n");
        messages.push({ role: "assistant", content: response });
      } catch (error) {
        stdout.write(`\n请求失败：${formatError(error)}\n`);
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    rl.close();
  }
}
```

- [ ] **Step 7: 运行检查**

Run:

```bash
pnpm test
pnpm typecheck
```

Expected: both PASS.

- [ ] **Step 8: 提交配置模块拆分**

Run:

```bash
git add src/index.ts src/config.ts src/chat.ts tests/index.test.ts tests/config.test.ts
git commit -m "refactor: split configuration and chat modules"
```

Expected: commit succeeds.

## Task 2: 实现文件工具核心

**Files:**
- Create: `src/file-tool.ts`
- Create: `tests/file-tool.test.ts`

- [ ] **Step 1: 写文件工具失败测试**

Create `tests/file-tool.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WRITE_FILE_TOOL,
  parseWriteFileArgs,
  resolveWritePath,
  writeFileTool,
} from "../src/file-tool";

describe("WRITE_FILE_TOOL", () => {
  it("defines the write_file function schema", () => {
    expect(WRITE_FILE_TOOL.function.name).toBe("write_file");
    expect(WRITE_FILE_TOOL.function.parameters).toMatchObject({
      type: "object",
      required: ["path", "content"],
      additionalProperties: false,
    });
  });
});

describe("parseWriteFileArgs", () => {
  it("defaults mode to overwrite", () => {
    expect(parseWriteFileArgs({ path: "a.txt", content: "hello" })).toEqual({
      path: "a.txt",
      content: "hello",
      mode: "overwrite",
    });
  });

  it("accepts append mode", () => {
    expect(
      parseWriteFileArgs({ path: "a.txt", content: "hello", mode: "append" }),
    ).toEqual({
      path: "a.txt",
      content: "hello",
      mode: "append",
    });
  });

  it("rejects invalid args", () => {
    expect(() => parseWriteFileArgs({ path: "", content: "hello" })).toThrow(
      "path",
    );
    expect(() => parseWriteFileArgs({ path: "a.txt", content: 123 })).toThrow(
      "content",
    );
    expect(() =>
      parseWriteFileArgs({ path: "a.txt", content: "hello", mode: "bad" }),
    ).toThrow("mode");
  });
});

describe("resolveWritePath", () => {
  it("resolves a relative path inside the write root", () => {
    const root = resolve("sandbox");

    expect(resolveWritePath(root, "notes/hello.txt")).toBe(
      join(root, "notes", "hello.txt"),
    );
  });

  it("allows an absolute path inside the write root", () => {
    const root = resolve("sandbox");
    const target = join(root, "notes", "hello.txt");

    expect(resolveWritePath(root, target)).toBe(target);
  });

  it("rejects paths outside the write root", () => {
    const root = resolve("sandbox");

    expect(() => resolveWritePath(root, "../outside.txt")).toThrow(
      "允许写入目录",
    );
    expect(() => resolveWritePath(root, resolve("outside.txt"))).toThrow(
      "允许写入目录",
    );
  });
});

describe("writeFileTool", () => {
  it("overwrites files and creates parent directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-write-"));

    try {
      const result = await writeFileTool(root, {
        path: "notes/hello.txt",
        content: "hello",
      });

      expect(result.ok).toBe(true);
      expect(result.mode).toBe("overwrite");
      expect(readFileSync(join(root, "notes", "hello.txt"), "utf8")).toBe(
        "hello",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("appends files", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-write-"));

    try {
      const target = join(root, "notes", "hello.txt");
      writeFileSync(target, "hello");

      const result = await writeFileTool(root, {
        path: "notes/hello.txt",
        content: " world",
        mode: "append",
      });

      expect(result.ok).toBe(true);
      expect(result.mode).toBe("append");
      expect(readFileSync(target, "utf8")).toBe("hello world");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not write when args are invalid", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-write-"));

    try {
      const result = await writeFileTool(root, {
        path: "../outside.txt",
        content: "no",
      });

      expect(result.ok).toBe(false);
      expect(existsSync(resolve(root, "..", "outside.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm test tests/file-tool.test.ts
```

Expected: FAIL because `src/file-tool.ts` does not exist.

- [ ] **Step 3: 实现 `src/file-tool.ts`**

Create `src/file-tool.ts`:

```ts
import { mkdir, writeFile, appendFile } from "node:fs/promises";
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
  if (!raw || typeof raw !== "object") {
    throw new Error("write_file 参数必须是对象。");
  }

  const value = raw as Record<string, unknown>;
  const path = value.path;
  const content = value.content;
  const mode = value.mode ?? "overwrite";

  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("write_file.path 必须是非空字符串。");
  }

  if (typeof content !== "string") {
    throw new Error("write_file.content 必须是字符串。");
  }

  if (mode !== "overwrite" && mode !== "append") {
    throw new Error("write_file.mode 必须是 overwrite 或 append。");
  }

  return {
    path,
    content,
    mode,
  };
}

export function resolveWritePath(writeRoot: string, requestedPath: string): string {
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

  throw new Error(`目标路径不在允许写入目录内：${root}`);
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
      message: `写入成功：${targetPath}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      ok: false,
      message,
    };
  }
}
```

- [ ] **Step 4: 运行测试和类型检查**

Run:

```bash
pnpm test tests/file-tool.test.ts
pnpm typecheck
```

Expected: both PASS.

- [ ] **Step 5: 提交文件工具核心**

Run:

```bash
git add src/file-tool.ts tests/file-tool.test.ts
git commit -m "feat: add write file tool core"
```

Expected: commit succeeds.

## Task 3: 为 chat 模块加入可测试依赖注入

**Files:**
- Modify: `src/chat.ts`
- Create: `tests/chat.test.ts`

- [ ] **Step 1: 写现有 chat 行为测试**

Create `tests/chat.test.ts`:

```ts
import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import {
  extractDelta,
  isExitCommand,
  sendMessage,
  sendPlainMessage,
} from "../src/chat";

describe("isExitCommand", () => {
  it("accepts exit and quit regardless of surrounding whitespace or case", () => {
    expect(isExitCommand("exit")).toBe(true);
    expect(isExitCommand(" Quit ")).toBe(true);
  });

  it("rejects normal chat messages", () => {
    expect(isExitCommand("hello")).toBe(false);
  });
});

describe("extractDelta", () => {
  it("returns streamed text content", () => {
    const chunk = {
      choices: [{ delta: { content: "你好" } }],
    };

    expect(extractDelta(chunk)).toBe("你好");
  });

  it("returns an empty string when a chunk has no text", () => {
    const chunk = {
      choices: [{ delta: {} }],
    };

    expect(extractDelta(chunk)).toBe("");
  });
});

describe("sendPlainMessage", () => {
  it("sends chat history with streaming enabled and writes streamed deltas", async () => {
    const calls: unknown[] = [];
    const fakeStream = (async function* () {
      yield { choices: [{ delta: { content: "你" } }] };
      yield { choices: [{ delta: { content: "好" } }] };
      yield { choices: [{ delta: {} }] };
    })();
    const client = {
      chat: {
        completions: {
          create: async (params: unknown) => {
            calls.push(params);
            return fakeStream;
          },
        },
      },
    } as unknown as OpenAI;
    const writes: string[] = [];
    const messages = [{ role: "user" as const, content: "你好" }];

    const response = await sendPlainMessage({
      client,
      model: "deepseek-v4-flash",
      messages,
      write: (text) => {
        writes.push(text);
      },
    });

    expect(response).toBe("你好");
    expect(writes.join("")).toBe("你好");
    expect(calls).toEqual([
      {
        model: "deepseek-v4-flash",
        messages,
        stream: true,
      },
    ]);
  });
});

describe("sendMessage compatibility", () => {
  it("keeps sendMessage as an alias for plain streaming", async () => {
    expect(sendMessage).toBe(sendPlainMessage);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm test tests/chat.test.ts
```

Expected: FAIL because `sendPlainMessage` is not exported.

- [ ] **Step 3: Rename existing `sendMessage()` to `sendPlainMessage()` and export alias**

Modify `src/chat.ts` so the streaming function is:

```ts
export async function sendPlainMessage({
  client,
  model,
  messages,
  write = (text) => {
    stdout.write(text);
  },
}: SendMessageOptions): Promise<string> {
  const stream = await client.chat.completions.create({
    model,
    messages,
    stream: true,
  });
  let response = "";

  for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
    const delta = extractDelta(chunk);

    if (delta.length > 0) {
      write(delta);
      response += delta;
    }
  }

  return response;
}

export const sendMessage = sendPlainMessage;
```

Also update `runChatLoop()` to call `sendPlainMessage()`.

- [ ] **Step 4: 运行测试和类型检查**

Run:

```bash
pnpm test
pnpm typecheck
```

Expected: both PASS.

- [ ] **Step 5: 提交 chat 测试基础**

Run:

```bash
git add src/chat.ts tests/chat.test.ts
git commit -m "test: cover chat streaming behavior"
```

Expected: commit succeeds.

## Task 4: 接入 write_file tool-call 流程

**Files:**
- Modify: `src/chat.ts`
- Modify: `tests/chat.test.ts`

- [ ] **Step 1: 写 tool-call 流程失败测试**

Append to `tests/chat.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleUserMessage,
  type AskConfirmation,
  type ChatClient,
} from "../src/chat";

function createFakeClient(responses: unknown[]): ChatClient {
  const calls: unknown[] = [];

  return {
    calls,
    chat: {
      completions: {
        create: async (params: unknown) => {
          calls.push(params);
          const response = responses.shift();

          if (!response) {
            throw new Error("No fake response configured");
          }

          return response;
        },
      },
    },
  } as unknown as ChatClient;
}

function streamText(text: string): AsyncIterable<unknown> {
  return (async function* () {
    yield { choices: [{ delta: { content: text } }] };
  })();
}

describe("handleUserMessage", () => {
  it("streams a normal assistant response when no tool call is returned", async () => {
    const messages = [];
    const writes: string[] = [];
    const client = createFakeClient([streamText("普通回复")]);

    await handleUserMessage({
      client,
      model: "deepseek-v4-flash",
      writeRoot: process.cwd(),
      messages,
      userInput: "你好",
      write: (text) => writes.push(text),
      askConfirmation: async () => true,
    });

    expect(writes.join("")).toBe("普通回复");
    expect(messages).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "普通回复" },
    ]);
    expect(client.calls[0]).toMatchObject({
      model: "deepseek-v4-flash",
      stream: true,
    });
  });

  it("confirms, writes a file, sends tool result, and streams final response", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-chat-"));

    try {
      const messages = [];
      const writes: string[] = [];
      const confirmations: Parameters<AskConfirmation>[0][] = [];
      const client = createFakeClient([
        {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: JSON.stringify({
                        path: "notes/hello.txt",
                        content: "hello",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        },
        streamText("写好了"),
      ]);

      await handleUserMessage({
        client,
        model: "deepseek-v4-flash",
        writeRoot: root,
        messages,
        userInput: "写文件",
        write: (text) => writes.push(text),
        askConfirmation: async (request) => {
          confirmations.push(request);
          return true;
        },
      });

      expect(confirmations).toHaveLength(1);
      expect(confirmations[0]).toMatchObject({
        mode: "overwrite",
        contentLength: 5,
      });
      expect(readFileSync(join(root, "notes", "hello.txt"), "utf8")).toBe(
        "hello",
      );
      expect(writes.join("")).toBe("写好了");
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_1",
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not write when the user rejects confirmation", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-chat-"));

    try {
      const messages = [];
      const client = createFakeClient([
        {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: JSON.stringify({
                        path: "notes/hello.txt",
                        content: "hello",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        },
        streamText("已取消"),
      ]);

      await handleUserMessage({
        client,
        model: "deepseek-v4-flash",
        writeRoot: root,
        messages,
        userInput: "写文件",
        write: () => undefined,
        askConfirmation: async () => false,
      });

      expect(messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          content: expect.stringContaining("用户拒绝写入"),
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a tool error for invalid arguments", async () => {
    const messages = [];
    const client = createFakeClient([
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: "{bad json",
                  },
                },
              ],
            },
          },
        ],
      },
      streamText("参数错误"),
    ]);

    await handleUserMessage({
      client,
      model: "deepseek-v4-flash",
      writeRoot: process.cwd(),
      messages,
      userInput: "写文件",
      write: () => undefined,
      askConfirmation: async () => true,
    });

    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        content: expect.stringContaining("JSON"),
      }),
    );
  });

  it("returns a tool error for unknown tools", async () => {
    const messages = [];
    const client = createFakeClient([
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "unknown_tool",
                    arguments: "{}",
                  },
                },
              ],
            },
          },
        ],
      },
      streamText("未知工具"),
    ]);

    await handleUserMessage({
      client,
      model: "deepseek-v4-flash",
      writeRoot: process.cwd(),
      messages,
      userInput: "调用工具",
      write: () => undefined,
      askConfirmation: async () => true,
    });

    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        content: expect.stringContaining("不支持的工具"),
      }),
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm test tests/chat.test.ts
```

Expected: FAIL because `handleUserMessage`, `AskConfirmation`, and `ChatClient` are not exported.

- [ ] **Step 3: Replace `src/chat.ts` with tool-aware implementation**

Replace `src/chat.ts` with:

```ts
import OpenAI from "openai";
import { stdin, stdout } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import { WRITE_FILE_TOOL, parseWriteFileArgs, resolveWritePath, writeFileTool } from "./file-tool";

export const MAX_TOOL_ROUNDS = 2;

export type ChatClient = Pick<OpenAI, "chat"> & {
  calls?: unknown[];
};

export type RunChatLoopOptions = {
  client: ChatClient;
  model: string;
  writeRoot: string;
};

export type SendMessageOptions = {
  client: ChatClient;
  model: string;
  messages: ChatCompletionMessageParam[];
  write?: (text: string) => void;
};

export type ConfirmationRequest = {
  path: string;
  mode: "overwrite" | "append";
  contentLength: number;
};

export type AskConfirmation = (
  request: ConfirmationRequest,
) => Promise<boolean>;

export type HandleUserMessageOptions = {
  client: ChatClient;
  model: string;
  writeRoot: string;
  messages: ChatCompletionMessageParam[];
  userInput: string;
  write?: (text: string) => void;
  askConfirmation: AskConfirmation;
};

export function isExitCommand(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return normalized === "exit" || normalized === "quit";
}

export function extractDelta(chunk: {
  choices?: Array<{ delta?: { content?: string | null } }>;
}): string {
  return chunk.choices?.[0]?.delta?.content ?? "";
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export async function sendPlainMessage({
  client,
  model,
  messages,
  write = (text) => {
    stdout.write(text);
  },
}: SendMessageOptions): Promise<string> {
  const stream = await client.chat.completions.create({
    model,
    messages,
    stream: true,
  });
  let response = "";

  for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
    const delta = extractDelta(chunk);

    if (delta.length > 0) {
      write(delta);
      response += delta;
    }
  }

  return response;
}

export const sendMessage = sendPlainMessage;

export async function askCliConfirmation(
  rl: Interface,
  request: ConfirmationRequest,
): Promise<boolean> {
  stdout.write(
    [
      "\n模型请求写入文件：",
      `路径：${request.path}`,
      `模式：${request.mode}`,
      `内容长度：${request.contentLength} 字符`,
      "确认写入？输入 y 继续：",
    ].join("\n"),
  );
  const answer = await rl.question("confirm> ");

  return answer.trim().toLowerCase() === "y";
}

export async function requestToolOrText({
  client,
  model,
  messages,
}: {
  client: ChatClient;
  model: string;
  messages: ChatCompletionMessageParam[];
}): Promise<ChatCompletion["choices"][number]["message"]> {
  const response = await client.chat.completions.create({
    model,
    messages,
    tools: [WRITE_FILE_TOOL],
  });

  return (response as ChatCompletion).choices[0]?.message;
}

function parseToolArguments(rawArguments: string): unknown {
  try {
    return JSON.parse(rawArguments);
  } catch {
    throw new Error("工具参数不是合法 JSON。");
  }
}

async function executeToolCall({
  toolCall,
  writeRoot,
  askConfirmation,
}: {
  toolCall: ChatCompletionMessageToolCall;
  writeRoot: string;
  askConfirmation: AskConfirmation;
}): Promise<string> {
  if (toolCall.function.name !== "write_file") {
    return JSON.stringify({
      ok: false,
      message: `不支持的工具：${toolCall.function.name}`,
    });
  }

  try {
    const args = parseWriteFileArgs(parseToolArguments(toolCall.function.arguments));
    const targetPath = resolveWritePath(writeRoot, args.path);
    const confirmed = await askConfirmation({
      path: targetPath,
      mode: args.mode,
      contentLength: args.content.length,
    });

    if (!confirmed) {
      return JSON.stringify({
        ok: false,
        message: "用户拒绝写入。",
      });
    }

    return JSON.stringify(await writeFileTool(writeRoot, args));
  } catch (error) {
    return JSON.stringify({
      ok: false,
      message: formatError(error),
    });
  }
}

export async function handleUserMessage({
  client,
  model,
  writeRoot,
  messages,
  userInput,
  write = (text) => {
    stdout.write(text);
  },
  askConfirmation,
}: HandleUserMessageOptions): Promise<void> {
  messages.push({ role: "user", content: userInput });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const message = await requestToolOrText({ client, model, messages });

    if (!message.tool_calls || message.tool_calls.length === 0) {
      const content = message.content ?? "";

      if (content.length > 0) {
        write(content);
      }

      messages.push({ role: "assistant", content });
      return;
    }

    messages.push(message as ChatCompletionAssistantMessageParam);

    for (const toolCall of message.tool_calls) {
      const result = await executeToolCall({
        toolCall,
        writeRoot,
        askConfirmation,
      });

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  messages.push({
    role: "system",
    content: `工具调用超过最大轮数 ${MAX_TOOL_ROUNDS}，本轮已停止继续执行工具。`,
  });
}

export async function runChatLoop({
  client,
  model,
  writeRoot,
}: RunChatLoopOptions): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const messages: ChatCompletionMessageParam[] = [];
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    stdout.write("\n");
    rl.close();
  };

  process.once("SIGINT", onSigint);

  try {
    while (!interrupted) {
      let rawInput: string;

      try {
        rawInput = await rl.question("you> ");
      } catch (error) {
        if (interrupted) {
          break;
        }

        throw error;
      }

      const userInput = rawInput.trim();

      if (userInput.length === 0) {
        continue;
      }

      if (isExitCommand(userInput)) {
        break;
      }

      try {
        await handleUserMessage({
          client,
          model,
          writeRoot,
          messages,
          userInput,
          askConfirmation: (request) => askCliConfirmation(rl, request),
        });
        stdout.write("\n");
      } catch (error) {
        stdout.write(`\n请求失败：${formatError(error)}\n`);
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    rl.close();
  }
}
```

- [ ] **Step 4: 运行测试和类型检查**

Run:

```bash
pnpm test
pnpm typecheck
```

Expected: both PASS.

- [ ] **Step 5: 提交 tool-call 聊天流程**

Run:

```bash
git add src/chat.ts tests/chat.test.ts
git commit -m "feat: wire write file tool into chat flow"
```

Expected: commit succeeds.

## Task 5: CLI smoke tests and documentation alignment

**Files:**
- Modify: `.env` only if local manual testing needs `LITE_AGENT_WRITE_ROOT` value. Do not commit `.env`.

- [ ] **Step 1: Verify missing key path still works**

Run:

```powershell
Remove-Item Env:\DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:\LITE_AGENT_WRITE_ROOT -ErrorAction SilentlyContinue
Rename-Item .env .env.local-test
pnpm chat
Rename-Item .env.local-test .env
```

Expected: command exits non-zero and prints:

```text
错误：缺少 DEEPSEEK_API_KEY。请先设置环境变量后再运行 pnpm chat。
```

- [ ] **Step 2: Verify `.env` startup with exit input**

Run:

```powershell
@'
exit
'@ | pnpm chat
```

Expected: CLI starts, prints `you>`, reads `exit`, and exits with status 0.

- [ ] **Step 3: Optional real DeepSeek manual test**

Run only if `.env` contains a real `DEEPSEEK_API_KEY`:

```powershell
pnpm chat
```

At prompt:

```text
请创建 notes/hello.txt，内容是 hello deepseek
```

Expected:

```text
模型请求写入文件：
路径：<project>\notes\hello.txt
模式：overwrite
内容长度：14 字符
确认写入？输入 y 继续：
```

Enter:

```text
y
```

Expected: `notes/hello.txt` exists and contains:

```text
hello deepseek
```

If no real key is available, record that this manual test was not run.

- [ ] **Step 4: Final verification**

Run:

```bash
pnpm test
pnpm typecheck
git status --short
```

Expected:

```text
# git status outputs nothing
```

Both checks PASS.

## Self-Review

- Spec coverage: Tasks cover `write_file`, `LITE_AGENT_WRITE_ROOT`, path confinement, overwrite/append modes, user confirmation, tool result feedback, module split, tests, and manual validation.
- Completeness scan: All code steps include concrete file paths, code snippets, commands, and expected outcomes.
- Type consistency: The plan consistently uses `AppConfig.writeRoot`, `WRITE_FILE_TOOL`, `parseWriteFileArgs`, `resolveWritePath`, `writeFileTool`, `handleUserMessage`, and `askCliConfirmation`.
