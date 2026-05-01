# 文件写入工具设计

## 背景

当前项目是一个 TypeScript CLI，对话模型使用 DeepSeek 的 OpenAI-compatible API。现有实现支持：

- 从 `.env` 和系统环境变量读取配置。
- 使用 `openai` SDK 创建 DeepSeek client。
- 交互式读取用户输入。
- 向模型发送消息并流式输出回复。
- 在当前进程内保留对话历史。

下一步需要增加第一个小工具：`write_file`。模型可以通过 OpenAI-compatible function calling 请求写文件，CLI 负责实际执行文件写入。

DeepSeek 官方 Function Calling 文档说明：模型可以返回 `tool_calls`，应用程序执行工具后，把 `{ role: "tool", tool_call_id, content }` 追加回消息，再让模型继续生成最终回复。工具本身由应用程序执行，模型不直接访问本地文件系统。

参考文档：DeepSeek Function Calling https://api-docs.deepseek.com/guides/function_calling/

## 目标

- 增加 `write_file` 工具，允许模型请求将内容写入文件。
- 默认只允许写入当前项目目录。
- 支持通过 `LITE_AGENT_WRITE_ROOT` 配置允许写入的根目录。
- 阻止目标路径跳出允许根目录。
- 支持 `overwrite` 和 `append` 两种写入模式。
- 未指定模式时默认 `overwrite`。
- 写入前要求用户确认。
- 工具执行结果作为 tool message 发回模型，让模型继续生成最终回复。
- 为配置、路径安全、写入行为和 tool-call 流程添加自动化测试。

## 非目标

- 不实现读取文件工具。
- 不实现删除、移动、重命名文件。
- 不支持任意绝对路径写入。
- 不持久化工具调用历史。
- 不实现多工具注册框架，只为当前 `write_file` 做清晰边界。
- 不处理流式 tool call chunk 拼接；第一版使用非流式 tool-call 判断，再流式输出最终回复。

## 用户体验

用户启动 CLI：

```bash
pnpm chat
```

用户可以输入：

```text
请创建 notes/hello.txt，内容是 hello deepseek
```

如果模型请求调用 `write_file`，CLI 展示确认信息：

```text
模型请求写入文件：
路径：D:\code\lite_agent\notes\hello.txt
模式：overwrite
内容长度：14 字符
确认写入？输入 y 继续：
```

用户输入 `y` 后，CLI 执行写入，把工具结果发回模型，并继续输出模型最终回复。用户输入其他内容时，不写文件，并把“用户拒绝写入”作为工具结果发回模型。

## 配置

新增环境变量：

- `LITE_AGENT_WRITE_ROOT`：可选，允许写入的根目录。

默认值：

- 如果未设置 `LITE_AGENT_WRITE_ROOT`，使用 `process.cwd()`。

路径规则：

- 工具参数里的 `path` 可以是相对路径，也可以是允许根目录内的绝对路径。
- 相对路径会以 `writeRoot` 为基准解析。
- 解析后的绝对路径必须位于 `writeRoot` 内。
- 路径越界直接拒绝，不写文件。

## 架构

当前 `src/index.ts` 已经承担配置、CLI、模型请求和辅助函数等多项职责。加入 tool-call 后继续堆在单文件中会让测试和维护变困难。因此本次设计将代码拆分为小模块：

```text
src/
  index.ts
  config.ts
  chat.ts
  file-tool.ts
```

职责：

- `src/index.ts`
  - CLI 入口。
  - 加载配置。
  - 创建 OpenAI client。
  - 启动 chat loop。
- `src/config.ts`
  - 加载 `.env`。
  - 读取 DeepSeek 配置。
  - 读取 `writeRoot`。
- `src/file-tool.ts`
  - 定义 `WRITE_FILE_TOOL` schema。
  - 解析和校验工具参数。
  - 安全解析目标路径。
  - 执行覆盖或追加写入。
- `src/chat.ts`
  - 管理 readline 对话循环。
  - 发送普通消息。
  - 处理 `tool_calls`。
  - 请求用户确认。
  - 将工具结果追加回 `messages`。
  - 请求模型生成最终回复并流式输出。

## 工具定义

工具名：

```text
write_file
```

参数：

```json
{
  "path": "notes/hello.txt",
  "content": "hello deepseek",
  "mode": "overwrite"
}
```

JSON Schema：

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Path to write, relative to the configured write root unless it is already inside the write root."
    },
    "content": {
      "type": "string",
      "description": "Complete text content to write to the file."
    },
    "mode": {
      "type": "string",
      "enum": ["overwrite", "append"],
      "description": "Write mode. Defaults to overwrite."
    }
  },
  "required": ["path", "content"],
  "additionalProperties": false
}
```

`mode` 默认值在本地参数解析阶段补齐为 `overwrite`。

## 对话流程

每次用户输入后：

1. 将用户消息追加到 `messages`。
2. 发起第一阶段请求，携带 `tools: [WRITE_FILE_TOOL]`。
3. 如果模型返回普通内容：
   - 输出回复。
   - 将 assistant 回复追加到 `messages`。
4. 如果模型返回 `tool_calls`：
   - 将 assistant tool-call message 追加到 `messages`。
   - 对每个 tool call：
     - 如果工具名不是 `write_file`，返回“不支持的工具”。
     - 解析 JSON 参数。
     - 校验 `path`、`content`、`mode`。
     - 解析安全目标路径。
     - 展示确认信息。
     - 用户确认后执行写入；否则不写入。
     - 将工具结果追加为 `role: "tool"` 消息。
   - 发起第二阶段请求，让模型根据工具结果生成最终回复。
   - 最终回复以流式方式输出，并追加到 `messages`。

为避免模型反复请求工具导致死循环，单轮用户输入最多执行 2 轮工具调用。超过限制时，CLI 给模型追加一条工具/系统可见的失败结果，并结束该轮工具处理。

## 错误处理

- JSON 参数解析失败：不写文件，tool result 返回失败原因。
- `path` 为空或不是字符串：不写文件，tool result 返回失败原因。
- `content` 不是字符串：不写文件，tool result 返回失败原因。
- `mode` 不是 `overwrite` 或 `append`：不写文件，tool result 返回失败原因。
- 路径跳出 `writeRoot`：不写文件，tool result 返回失败原因。
- 用户拒绝写入：不写文件，tool result 返回“用户拒绝写入”。
- 文件写入失败：tool result 返回 I/O 错误消息。
- 未知工具名：tool result 返回“不支持的工具”。
- API 请求失败：CLI 打印错误，并继续下一轮用户输入。

## 测试计划

自动化测试：

- `config.ts`
  - `.env` 能加载到传入的环境对象。
  - 系统环境变量优先，不被 `.env` 覆盖。
  - `LITE_AGENT_WRITE_ROOT` 未设置时使用 `process.cwd()`。
  - `LITE_AGENT_WRITE_ROOT` 设置时被读取并解析为绝对路径。
- `file-tool.ts`
  - 相对路径解析到允许根目录内。
  - 允许根目录内的绝对路径通过。
  - `..` 路径被拒绝。
  - 根目录外绝对路径被拒绝。
  - `overwrite` 覆盖文件。
  - `append` 追加文件。
  - 未传 `mode` 默认覆盖。
  - 非法参数返回清晰错误。
- `chat.ts`
  - 无 tool call 时保持普通对话。
  - 有 `write_file` tool call 时请求用户确认。
  - 用户确认后写入文件，并把 tool result 发回模型。
  - 用户拒绝时不写文件，并把拒绝结果发回模型。
  - 工具参数非法时不写文件。
  - 未知工具名返回失败结果。

手动验收：

1. 在 `.env` 中设置 `DEEPSEEK_API_KEY`。
2. 运行 `pnpm chat`。
3. 输入 `请创建 notes/hello.txt，内容是 hello deepseek`。
4. CLI 展示确认信息。
5. 输入 `y`。
6. 确认 `notes/hello.txt` 被写入。
7. 确认模型继续输出最终回复。

## 验收标准

- `pnpm test` 通过。
- `pnpm typecheck` 通过。
- 默认无法写出当前项目目录。
- 配置 `LITE_AGENT_WRITE_ROOT` 后，只能写入该根目录内。
- 模型请求写文件时，用户未确认不会写入。
- 用户确认后，文件按 `overwrite` 或 `append` 正确写入。
- 工具结果会回传给模型，模型能继续生成最终回复。
