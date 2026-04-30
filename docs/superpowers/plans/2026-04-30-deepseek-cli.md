# DeepSeek LLM 对话 CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 TypeScript 交互式 CLI，通过 OpenAI SDK 调用 DeepSeek `deepseek-v4-flash` 并流式输出回复。

**Architecture:** 保持一个生产入口 `src/index.ts`，内部拆出配置读取、退出命令判断、stream chunk 提取、流式发送和 REPL 主循环等小函数。用 Vitest 覆盖不需要真实 API key 的纯逻辑和流式发送行为，用手动验证覆盖真实 API 调用和交互退出。

**Tech Stack:** Node.js、pnpm、TypeScript、OpenAI SDK、tsx、Vitest、Node readline/promises。

---

## 文件结构

- Modify: `package.json`  
  添加 ESM、脚本和依赖。依赖版本由 `pnpm add` 写入，不手写固定版本。
- Create: `.gitignore`  
  忽略依赖目录、本地环境文件和构建输出。
- Create: `tsconfig.json`  
  TypeScript 严格配置，覆盖 `src/**/*.ts` 和 `tests/**/*.ts`。
- Create: `tests/index.test.ts`  
  覆盖配置读取、退出命令判断、stream delta 提取和 `sendMessage()` 的流式行为。
- Create: `src/index.ts`  
  CLI 入口和核心逻辑。生产代码保持单文件，符合当前 spec 的小范围设计。

## Task 1: 建立 TypeScript 工具链

**Files:**
- Modify: `package.json`
- Create: `.gitignore`
- Create: `tsconfig.json`

- [ ] **Step 1: 安装运行和开发依赖**

Run:

```bash
pnpm add openai
pnpm add -D typescript tsx vitest @types/node
```

Expected: `package.json` 出现 `openai` 依赖，以及 `typescript`、`tsx`、`vitest`、`@types/node` 开发依赖。

- [ ] **Step 2: 更新 `package.json` 脚本和 ESM 配置**

Run:

```bash
pnpm pkg set private=true
pnpm pkg set type=module
pnpm pkg set scripts.chat="tsx src/index.ts"
pnpm pkg set scripts.typecheck="tsc --noEmit"
pnpm pkg set scripts.test="vitest run"
```

Expected: `package.json` 至少包含这些字段：

```json
{
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "chat": "tsx src/index.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 3: 创建 TypeScript 配置**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 4: 创建 `.gitignore`**

Create `.gitignore`:

```gitignore
node_modules/
dist/
.env
.env.*
```

- [ ] **Step 5: 提交工具链配置**

Run:

```bash
git add package.json pnpm-lock.yaml tsconfig.json .gitignore
git commit -m "chore: add TypeScript tooling"
```

Expected: commit succeeds.

## Task 2: 用测试锁定配置和小工具函数

**Files:**
- Create: `tests/index.test.ts`
- Create: `src/index.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  extractDelta,
  isExitCommand,
  readConfig,
} from "../src/index";

describe("readConfig", () => {
  it("throws when DEEPSEEK_API_KEY is missing", () => {
    expect(() => readConfig({})).toThrow("DEEPSEEK_API_KEY");
  });

  it("uses DeepSeek defaults when optional env vars are absent", () => {
    expect(readConfig({ DEEPSEEK_API_KEY: "sk-test" })).toEqual({
      apiKey: "sk-test",
      baseURL: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
    });
  });

  it("allows model and base URL overrides", () => {
    expect(
      readConfig({
        DEEPSEEK_API_KEY: "sk-test",
        DEEPSEEK_MODEL: "custom-model",
        DEEPSEEK_BASE_URL: "https://example.test",
      }),
    ).toEqual({
      apiKey: "sk-test",
      baseURL: "https://example.test",
      model: "custom-model",
    });
  });
});

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
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm test
```

Expected: FAIL because `../src/index` does not exist or does not export the tested symbols.

- [ ] **Step 3: 写最小实现让测试通过**

Create `src/index.ts`:

```ts
export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL = "deepseek-v4-flash";

export type AppConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
};

type Env = Partial<Record<string, string>>;

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
  };
}

export function isExitCommand(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return normalized === "exit" || normalized === "quit";
}

export function extractDelta(chunk: {
  choices?: Array<{ delta?: { content?: string | null } }>;
}): string {
  return chunk.choices?.[0]?.delta?.content ?? "";
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 5: 运行类型检查**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: 提交配置和工具函数**

Run:

```bash
git add src/index.ts tests/index.test.ts
git commit -m "test: cover DeepSeek CLI configuration"
```

Expected: commit succeeds.

## Task 3: 实现 OpenAI client 和流式发送

**Files:**
- Modify: `tests/index.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: 写 `sendMessage()` 失败测试**

Append to `tests/index.test.ts`:

```ts
import type OpenAI from "openai";
import { sendMessage } from "../src/index";

describe("sendMessage", () => {
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

    const response = await sendMessage({
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
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm test
```

Expected: FAIL because `sendMessage` is not exported.

- [ ] **Step 3: 实现 `createClient()`、`sendMessage()` 和相关类型**

Replace `src/index.ts` with:

```ts
import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL = "deepseek-v4-flash";

export type AppConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
};

type Env = Partial<Record<string, string>>;

export type SendMessageOptions = {
  client: OpenAI;
  model: string;
  messages: ChatCompletionMessageParam[];
  write?: (text: string) => void;
};

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
  };
}

export function createClient(config: AppConfig = readConfig()): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
}

export function isExitCommand(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return normalized === "exit" || normalized === "quit";
}

export function extractDelta(chunk: {
  choices?: Array<{ delta?: { content?: string | null } }>;
}): string {
  return chunk.choices?.[0]?.delta?.content ?? "";
}

export async function sendMessage({
  client,
  model,
  messages,
  write = (text) => {
    process.stdout.write(text);
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

export type { ChatCompletionMessageParam };
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 5: 运行类型检查**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: 提交流式发送实现**

Run:

```bash
git add src/index.ts tests/index.test.ts
git commit -m "feat: add streaming DeepSeek chat request"
```

Expected: commit succeeds.

## Task 4: 实现交互式 REPL 和 CLI 入口

**Files:**
- Modify: `tests/index.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: 写 CLI 入口辅助函数测试**

Append to `tests/index.test.ts`:

```ts
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

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm test
```

Expected: FAIL because `isDirectRun` is not exported.

- [ ] **Step 3: 实现 REPL、错误格式化、主入口**

Replace `src/index.ts` with:

```ts
import OpenAI from "openai";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL = "deepseek-v4-flash";

export type AppConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
};

type Env = Partial<Record<string, string>>;

export type SendMessageOptions = {
  client: OpenAI;
  model: string;
  messages: ChatCompletionMessageParam[];
  write?: (text: string) => void;
};

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
  };
}

export function createClient(config: AppConfig = readConfig()): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
}

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

export async function runChatLoop(client: OpenAI, model: string): Promise<void> {
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

export function isDirectRun(metaUrl: string, argvPath?: string): boolean {
  if (!argvPath) {
    return false;
  }

  return metaUrl === pathToFileURL(argvPath).href;
}

export async function main(): Promise<void> {
  try {
    const config = readConfig();
    const client = createClient(config);
    await runChatLoop(client, config.model);
  } catch (error) {
    console.error(`错误：${formatError(error)}`);
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void main();
}

export type { ChatCompletionMessageParam };
```

- [ ] **Step 4: 运行自动化检查**

Run:

```bash
pnpm test
pnpm typecheck
```

Expected: both PASS.

- [ ] **Step 5: 验证缺少 API key 时的错误路径**

Run in PowerShell:

```powershell
Remove-Item Env:\DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
pnpm chat
```

Expected: command exits non-zero and prints:

```text
错误：缺少 DEEPSEEK_API_KEY。请先设置环境变量后再运行 pnpm chat。
```

- [ ] **Step 6: 提交 CLI 入口实现**

Run:

```bash
git add src/index.ts tests/index.test.ts
git commit -m "feat: add interactive DeepSeek chat CLI"
```

Expected: commit succeeds.

## Task 5: 真实 API 手动验证和收尾

**Files:**
- Modify: none unless verification finds a defect.

- [ ] **Step 1: 使用真实 API key 启动 CLI**

Run in PowerShell:

```powershell
$env:DEEPSEEK_API_KEY = "<your key>"
pnpm chat
```

Expected: CLI prints:

```text
you>
```

- [ ] **Step 2: 验证流式回复**

At the prompt, enter:

```text
用一句话介绍你自己
```

Expected: assistant response appears progressively rather than only after the full response is complete.

- [ ] **Step 3: 验证当前会话上下文**

At the next prompt, enter:

```text
我刚才问了什么？
```

Expected: assistant refers to the previous question about introducing itself.

- [ ] **Step 4: 验证退出命令**

At the next prompt, enter:

```text
exit
```

Expected: process exits cleanly.

- [ ] **Step 5: 最终仓库检查**

Run:

```bash
git status --short
pnpm test
pnpm typecheck
```

Expected:

```text
# git status outputs nothing
```

Both checks PASS.

## 自检结果

- Spec coverage: CLI 启动、环境变量、DeepSeek base URL、`deepseek-v4-flash`、流式输出、当前会话上下文、退出方式和错误处理都映射到了任务。
- 完整性扫描：计划没有待补内容、空泛步骤或未定义的后续步骤。
- Type consistency: `readConfig()`、`createClient()`、`sendMessage()`、`extractDelta()`、`runChatLoop()` 和 `isDirectRun()` 的名称在测试和实现步骤中一致。
