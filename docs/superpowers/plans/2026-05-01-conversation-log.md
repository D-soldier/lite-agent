# Conversation Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 DeepSeek CLI 增加一次 `pnpm chat` 会话一个 JSON 日志文件的能力，并在每次 `messages` 变化后保存完整快照。

**Architecture:** 新增 `src/conversation-log.ts` 作为独立日志模块，负责生成 `logs/*.json`、创建目录和写入快照。`src/chat.ts` 只接收一个可测试的 `saveMessages` 回调，并在 `runChatLoop()` 启动时创建默认 logger。日志不参与模型上下文，也不改变工具调用流程。

**Tech Stack:** Node.js、TypeScript、OpenAI SDK message types、Vitest、Node fs/path/readline。

---

## 文件结构

- Create: `src/conversation-log.ts`  
  负责 JSON 日志文件名、日志目录创建、初始空日志写入、后续完整 `messages` 快照保存。
- Create: `tests/conversation-log.test.ts`  
  覆盖文件名、目录创建、初始日志、重复保存覆盖同一文件和 JSON 内容。
- Modify: `src/chat.ts`  
  新增 `SaveMessages` 类型和 `saveMessages` 注入点；在每次 `messages.push(...)` 后保存日志；`runChatLoop()` 创建默认会话 logger。
- Modify: `tests/chat.test.ts`  
  覆盖普通回复和工具调用流程中的日志保存顺序。
- Modify: `.gitignore`  
  增加 `logs/`，避免提交本地聊天记录。

## Task 1: 实现独立 conversation log 模块

**Files:**
- Create: `src/conversation-log.ts`
- Create: `tests/conversation-log.test.ts`

- [ ] **Step 1: 写日志模块失败测试**

Create `tests/conversation-log.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam } from "../src/chat";
import {
  createConversationLogger,
  formatLogFileName,
  type Clock,
} from "../src/conversation-log";

function createSequenceClock(values: string[]): Clock {
  const dates = values.map((value) => new Date(value));
  let index = 0;

  return () => {
    const date = dates[Math.min(index, dates.length - 1)];
    index += 1;
    return date;
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("formatLogFileName", () => {
  it("formats an ISO timestamp as a Windows-compatible JSON filename", () => {
    const fileName = formatLogFileName(
      new Date("2026-05-01T14:30:20.123Z"),
    );

    expect(fileName).toBe("2026-05-01T14-30-20-123Z.json");
    expect(fileName.slice(0, -".json".length)).not.toMatch(/[:.]/);
  });
});

describe("createConversationLogger", () => {
  it("creates the logs directory and writes an initial empty JSON snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-log-"));
    const logsDir = join(root, "logs");

    try {
      const logger = await createConversationLogger({
        model: "test-model",
        logsDir,
        now: createSequenceClock([
          "2026-05-01T14:30:20.123Z",
          "2026-05-01T14:30:20.456Z",
        ]),
      });

      expect(existsSync(logsDir)).toBe(true);
      expect(logger.filePath).toBe(
        join(logsDir, "2026-05-01T14-30-20-123Z.json"),
      );
      expect(readJson(logger.filePath)).toEqual({
        startedAt: "2026-05-01T14:30:20.123Z",
        updatedAt: "2026-05-01T14:30:20.456Z",
        model: "test-model",
        messages: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("overwrites the same file with updated messages and updatedAt", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-log-"));
    const logsDir = join(root, "logs");

    try {
      const logger = await createConversationLogger({
        model: "test-model",
        logsDir,
        now: createSequenceClock([
          "2026-05-01T14:30:20.123Z",
          "2026-05-01T14:30:20.456Z",
          "2026-05-01T14:30:21.000Z",
          "2026-05-01T14:30:22.000Z",
        ]),
      });
      const userMessages: ChatCompletionMessageParam[] = [
        { role: "user", content: "你好" },
      ];
      const fullMessages: ChatCompletionMessageParam[] = [
        ...userMessages,
        { role: "assistant", content: "你好" },
      ];

      await logger.save(userMessages);
      await logger.save(fullMessages);

      expect(readJson(logger.filePath)).toEqual({
        startedAt: "2026-05-01T14:30:20.123Z",
        updatedAt: "2026-05-01T14:30:22.000Z",
        model: "test-model",
        messages: fullMessages,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm test tests/conversation-log.test.ts
```

Expected: FAIL because `src/conversation-log.ts` does not exist.

- [ ] **Step 3: 实现 `src/conversation-log.ts`**

Create `src/conversation-log.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export type Clock = () => Date;

export type ConversationLogSnapshot = {
  startedAt: string;
  updatedAt: string;
  model: string;
  messages: ChatCompletionMessageParam[];
};

export type ConversationLogger = {
  filePath: string;
  save: (messages: ChatCompletionMessageParam[]) => Promise<void>;
};

export type CreateConversationLoggerOptions = {
  model: string;
  logsDir?: string;
  now?: Clock;
};

export function formatLogFileName(date: Date): string {
  const safeTimestamp = date
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");

  return `${safeTimestamp}.json`;
}

export async function createConversationLogger({
  model,
  logsDir = resolve("logs"),
  now = () => new Date(),
}: CreateConversationLoggerOptions): Promise<ConversationLogger> {
  const resolvedLogsDir = resolve(logsDir);
  const startedAtDate = now();
  const startedAt = startedAtDate.toISOString();
  const filePath = join(resolvedLogsDir, formatLogFileName(startedAtDate));

  await mkdir(resolvedLogsDir, { recursive: true });

  const save = async (
    messages: ChatCompletionMessageParam[],
  ): Promise<void> => {
    const snapshot: ConversationLogSnapshot = {
      startedAt,
      updatedAt: now().toISOString(),
      model,
      messages,
    };

    await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  };

  await save([]);

  return {
    filePath,
    save,
  };
}
```

- [ ] **Step 4: 运行日志模块测试和类型检查**

Run:

```bash
pnpm test tests/conversation-log.test.ts
pnpm typecheck
```

Expected: both PASS.

- [ ] **Step 5: 提交日志模块**

Run:

```bash
git add src/conversation-log.ts tests/conversation-log.test.ts
git commit -m "feat: add conversation log writer"
```

Expected: commit succeeds.

## Task 2: 在 `handleUserMessage()` 中保存每次 message 变化

**Files:**
- Modify: `src/chat.ts`
- Modify: `tests/chat.test.ts`

- [ ] **Step 1: 给普通回复流程增加失败测试**

In `tests/chat.test.ts`, add this helper after `streamText()`:

```ts
function createSaveRecorder() {
  const snapshots: ChatCompletionMessageParam[][] = [];

  return {
    snapshots,
    saveMessages: async (messages: ChatCompletionMessageParam[]) => {
      snapshots.push(
        JSON.parse(JSON.stringify(messages)) as ChatCompletionMessageParam[],
      );
    },
  };
}
```

Then update the test named `"writes a normal assistant response when no tool call is returned"` so it creates a recorder, passes `saveMessages`, and asserts the snapshots:

```ts
  it("writes a normal assistant response when no tool call is returned", async () => {
    const messages: ChatCompletionMessageParam[] = [];
    const writes: string[] = [];
    const recorder = createSaveRecorder();
    const client = createQueuedFakeClient([
      chatMessage({ role: "assistant", content: "普通回复" }),
    ]);

    await handleUserMessage({
      client,
      model: "test-model",
      writeRoot: process.cwd(),
      messages,
      userInput: "你好",
      write: (text) => {
        writes.push(text);
      },
      askConfirmation: async () => true,
      saveMessages: recorder.saveMessages,
    });

    expect(writes).toEqual(["普通回复"]);
    expect(messages).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "普通回复" },
    ]);
    expect(recorder.snapshots).toEqual([
      [{ role: "user", content: "你好" }],
      [
        { role: "user", content: "你好" },
        { role: "assistant", content: "普通回复" },
      ],
    ]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      model: "test-model",
      messages,
      tools: [
        expect.objectContaining({
          function: expect.objectContaining({ name: "write_file" }),
        }),
      ],
    });
  });
```

- [ ] **Step 2: 给工具调用流程增加失败测试**

In `tests/chat.test.ts`, update the test named `"confirms write_file, writes a file, sends tool result, and streams final response"` so it creates a recorder, passes `saveMessages`, and asserts four snapshots:

```ts
  it("confirms write_file, writes a file, sends tool result, and streams final response", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-chat-"));

    try {
      const messages: ChatCompletionMessageParam[] = [];
      const writes: string[] = [];
      const confirmations: ConfirmationRequest[] = [];
      const recorder = createSaveRecorder();
      const client = createQueuedFakeClient([
        chatMessage({
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
        }),
        chatMessage({ role: "assistant", content: "准备最终回复" }),
        streamText("写好了"),
      ]);

      await handleUserMessage({
        client,
        model: "test-model",
        writeRoot: root,
        messages,
        userInput: "写文件",
        write: (text) => {
          writes.push(text);
        },
        askConfirmation: async (request) => {
          confirmations.push(request);
          return true;
        },
        saveMessages: recorder.saveMessages,
      });

      expect(confirmations).toHaveLength(1);
      expect(confirmations[0]).toMatchObject({
        path: join(root, "notes", "hello.txt"),
        mode: "overwrite",
        contentLength: 5,
      });
      expect(readFileSync(join(root, "notes", "hello.txt"), "utf8")).toBe(
        "hello",
      );
      expect(writes).toEqual(["写好了"]);
      expect(client.calls).toHaveLength(3);
      expect(client.calls[0]).toMatchObject({
        model: "test-model",
        tools: expect.any(Array),
      });
      expect(client.calls[1]).toMatchObject({
        model: "test-model",
        messages,
        tools: expect.any(Array),
      });
      expect(client.calls[2]).toMatchObject({
        model: "test-model",
        messages,
        stream: true,
      });
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_1",
          content: expect.stringContaining('"ok":true'),
        }),
      );
      expect(messages.at(-1)).toEqual({
        role: "assistant",
        content: "写好了",
      });
      expect(recorder.snapshots).toHaveLength(4);
      expect(recorder.snapshots[0]).toEqual([
        { role: "user", content: "写文件" },
      ]);
      expect(recorder.snapshots[1]).toEqual([
        { role: "user", content: "写文件" },
        expect.objectContaining({
          role: "assistant",
          tool_calls: expect.any(Array),
        }),
      ]);
      expect(recorder.snapshots[2]).toEqual([
        { role: "user", content: "写文件" },
        expect.objectContaining({
          role: "assistant",
          tool_calls: expect.any(Array),
        }),
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_1",
          content: expect.stringContaining('"ok":true'),
        }),
      ]);
      expect(recorder.snapshots[3]).toEqual([
        { role: "user", content: "写文件" },
        expect.objectContaining({
          role: "assistant",
          tool_calls: expect.any(Array),
        }),
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_1",
          content: expect.stringContaining('"ok":true'),
        }),
        { role: "assistant", content: "写好了" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 3: 运行测试确认失败**

Run:

```bash
pnpm test tests/chat.test.ts
```

Expected: FAIL because `handleUserMessage()` does not accept `saveMessages`.

- [ ] **Step 4: 更新 `src/chat.ts` 类型和保存回调**

In `src/chat.ts`, add this type near `SendMessageOptions`:

```ts
export type SaveMessages = (
  messages: ChatCompletionMessageParam[],
) => Promise<void>;
```

Then add `saveMessages?: SaveMessages;` to `HandleUserMessageOptions`:

```ts
export type HandleUserMessageOptions = {
  client: ChatClient;
  model: string;
  writeRoot: string;
  messages: ChatCompletionMessageParam[];
  userInput: string;
  write?: (text: string) => void;
  askConfirmation: AskConfirmation;
  saveMessages?: SaveMessages;
};
```

In `handleUserMessage()`, destructure `saveMessages` with a default async no-op:

```ts
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
  saveMessages = async () => undefined,
}: HandleUserMessageOptions): Promise<void> {
```

- [ ] **Step 5: 保存 user 和普通 assistant message**

In `handleUserMessage()`, immediately save after the user message is pushed:

```ts
  messages.push({ role: "user", content: userInput });
  await saveMessages(messages);
```

In the no-tool branch, save after the assistant message is pushed:

```ts
      messages.push({ role: "assistant", content });
      await saveMessages(messages);
      return;
```

- [ ] **Step 6: 保存工具调用、tool result、限制消息和最终回复**

In `handleUserMessage()`, save after the tool-round limit assistant message is pushed:

```ts
      messages.push({ role: "assistant", content });
      await saveMessages(messages);
      return;
```

Save after the assistant tool-call message is pushed:

```ts
    messages.push(message as ChatCompletionAssistantMessageParam);
    await saveMessages(messages);
```

Save after each tool result is pushed:

```ts
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
      await saveMessages(messages);
```

Save after the final streaming assistant response is pushed:

```ts
        messages.push({ role: "assistant", content: response });
        await saveMessages(messages);
        return;
```

- [ ] **Step 7: 运行聊天测试和类型检查**

Run:

```bash
pnpm test tests/chat.test.ts
pnpm typecheck
```

Expected: both PASS.

- [ ] **Step 8: 提交保存回调集成**

Run:

```bash
git add src/chat.ts tests/chat.test.ts
git commit -m "feat: save chat messages after each change"
```

Expected: commit succeeds.

## Task 3: 在 CLI 会话启动时创建默认日志并忽略 `logs/`

**Files:**
- Modify: `src/chat.ts`
- Modify: `.gitignore`
- Create: `tests/gitignore.test.ts`

- [ ] **Step 1: 给 `runChatLoop()` 增加可测试 logger 创建接口**

In `src/chat.ts`, import the logger type and factory:

```ts
import {
  createConversationLogger,
  type ConversationLogger,
} from "./conversation-log";
```

Add this type near `RunChatLoopOptions`:

```ts
export type CreateConversationLogger = (options: {
  model: string;
}) => Promise<ConversationLogger>;
```

Then update `RunChatLoopOptions`:

```ts
export type RunChatLoopOptions = {
  client: ChatClient;
  model: string;
  writeRoot: string;
  createLogger?: CreateConversationLogger;
};
```

- [ ] **Step 2: 在 `runChatLoop()` 创建 logger 并传入保存回调**

Update the `runChatLoop()` function signature:

```ts
export async function runChatLoop({
  client,
  model,
  writeRoot,
  createLogger = createConversationLogger,
}: RunChatLoopOptions): Promise<void> {
```

Inside `runChatLoop()`, create the logger before creating the readline interface:

```ts
  const logger = await createLogger({ model });
  const saveMessages: SaveMessages = (nextMessages) =>
    logger.save(nextMessages);
  const rl = createInterface({ input: stdin, output: stdout });
  const messages: ChatCompletionMessageParam[] = [];
```

Then pass `saveMessages` into `handleUserMessage()`:

```ts
        await handleUserMessage({
          client,
          model,
          writeRoot,
          messages,
          userInput,
          askConfirmation: (request) => askCliConfirmation(rl, request),
          saveMessages,
        });
```

- [ ] **Step 3: 在 `.gitignore` 忽略 `logs/`**

Append this line to `.gitignore`:

```gitignore
logs/
```

- [ ] **Step 4: 增加 `.gitignore` 测试**

Create `tests/gitignore.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe(".gitignore", () => {
  it("ignores local conversation logs", () => {
    const entries = readFileSync(".gitignore", "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim());

    expect(entries).toContain("logs/");
  });
});
```

- [ ] **Step 5: 运行测试和类型检查**

Run:

```bash
pnpm test
pnpm typecheck
```

Expected: both PASS.

- [ ] **Step 6: 提交 CLI 默认日志接入**

Run:

```bash
git add src/chat.ts .gitignore tests/gitignore.test.ts
git commit -m "feat: create conversation logs for chat sessions"
```

Expected: commit succeeds.

## Task 4: CLI smoke 验证与最终检查

**Files:**
- No committed file changes expected.

- [ ] **Step 1: 用临时 `.env` 验证 `exit` 会创建日志文件**

Run this PowerShell command from the repo root:

```powershell
$envPath = Join-Path (Get-Location) ".env"
$backupEnvPath = Join-Path (Get-Location) ".env.conversation-log-smoke"
if (Test-Path -LiteralPath $backupEnvPath) { throw "$backupEnvPath already exists; aborting smoke test." }
$hadEnv = Test-Path -LiteralPath $envPath
$before = @(Get-ChildItem -LiteralPath logs -Filter *.json -ErrorAction SilentlyContinue).Count
$code = 1
try {
  if ($hadEnv) {
    Rename-Item -LiteralPath $envPath -NewName ".env.conversation-log-smoke"
  }
  Set-Content -LiteralPath $envPath -Encoding utf8 -Value @("DEEPSEEK_API_KEY=sk-smoke", "DEEPSEEK_MODEL=deepseek-v4-flash", "")
  @'
exit
'@ | pnpm chat
  $code = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $envPath -Force -ErrorAction SilentlyContinue
  if ($hadEnv -and (Test-Path -LiteralPath $backupEnvPath)) {
    Rename-Item -LiteralPath $backupEnvPath -NewName ".env"
  }
}
$after = @(Get-ChildItem -LiteralPath logs -Filter *.json -ErrorAction SilentlyContinue).Count
"EXIT_CODE=$code"
"LOGS_BEFORE=$before"
"LOGS_AFTER=$after"
if ($code -ne 0) { exit 1 }
if ($after -ne ($before + 1)) { exit 1 }
exit 0
```

Expected: PASS with `EXIT_CODE=0` and `LOGS_AFTER` exactly one greater than `LOGS_BEFORE`.

- [ ] **Step 2: 确认新日志文件是可解析 JSON**

Run:

```powershell
$latest = Get-ChildItem -LiteralPath logs -Filter *.json | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$json = Get-Content -Raw -Encoding utf8 -LiteralPath $latest.FullName | ConvertFrom-Json
if ($json.model -ne "deepseek-v4-flash") { exit 1 }
if ($json.messages.Count -ne 0) { exit 1 }
"LOG_FILE=$($latest.FullName)"
"MODEL=$($json.model)"
"MESSAGES=$($json.messages.Count)"
```

Expected: PASS and `MESSAGES=0` because the smoke input exits before sending a user message.

- [ ] **Step 3: 运行最终自动化验证**

Run:

```bash
pnpm test
pnpm typecheck
git status --short
```

Expected:

```text
# git status may show existing unrelated untracked 1.txt only
```

Both checks PASS. `logs/` must not appear in `git status --short`.

## Self-Review

- Spec coverage: Task 1 implements JSON file naming, initial empty snapshot, metadata, and repeated saves. Task 2 records every `messages` mutation inside user/assistant/tool flows. Task 3 creates one logger per `runChatLoop()` session and ignores `logs/`. Task 4 verifies CLI smoke behavior and final checks.
- Placeholder scan: The plan contains concrete file paths, code blocks, commands, and expected outputs. It avoids undefined function names and leaves no open implementation decisions.
- Type consistency: `Clock`, `ConversationLogger`, `createConversationLogger`, `SaveMessages`, and `CreateConversationLogger` are introduced before use and reused consistently across tasks.
