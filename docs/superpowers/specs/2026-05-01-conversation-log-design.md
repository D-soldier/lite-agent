# 对话日志系统设计

## 背景

当前 CLI 支持一次 `pnpm chat` 启动后的连续对话，并在进程内维护 `messages` 数组。这个数组会发送给 DeepSeek，也会包含工具调用相关消息，例如 assistant 的 `tool_calls` 和本地执行后的 `role: "tool"` 结果。

为了便于调试、复盘和排查工具调用问题，需要把一次 CLI 会话中的完整 `messages` 记录到本地文件。日志只用于本地观察，不参与模型上下文，也不改变已有聊天行为。

## 目标

- 每次运行 `pnpm chat` 时创建一个独立日志文件。
- 日志文件放在项目根目录的 `logs/` 文件夹内。
- 日志格式使用 JSON。
- 每次 `messages` 变化后，覆盖写入同一个日志文件。
- JSON 中完整保留当前会话的 `messages`，包括 user、assistant、tool、tool_calls 和 tool result。
- 日志文件包含会话元信息，至少包括 `startedAt`、`updatedAt` 和 `model`。
- `logs/` 加入 `.gitignore`，避免提交本地聊天记录。
- 为日志文件命名、写入行为、chat 集成添加自动化测试。

## 非目标

- 不做日志检索、压缩、清理或轮转。
- 不隐藏、脱敏或加密消息内容。
- 不支持自定义日志目录。
- 不把日志作为新的模型上下文来源。
- 不改变 `write_file` 工具的执行流程和安全边界。

## 文件命名

日志文件放在：

```text
logs/
```

文件名使用 UTC 时间戳生成，避免 Windows 文件名中的 `:`：

```text
logs/2026-05-01T14-30-20-123Z.json
```

命名规则：

- 基于 `new Date().toISOString()`。
- 将 `:` 替换为 `-`。
- 将 `.` 替换为 `-`。
- 保留 `.json` 后缀。

## JSON 结构

日志文件结构：

```json
{
  "startedAt": "2026-05-01T14:30:20.123Z",
  "updatedAt": "2026-05-01T14:30:22.456Z",
  "model": "deepseek-v4-flash",
  "messages": [
    {
      "role": "user",
      "content": "你好"
    },
    {
      "role": "assistant",
      "content": "你好，有什么可以帮你？"
    }
  ]
}
```

说明：

- `startedAt` 是日志会话创建时间。
- `updatedAt` 是最近一次写入时间。
- `model` 是当前 CLI 使用的模型名。
- `messages` 是当前内存中的完整 OpenAI-compatible message 数组。

## 架构

新增独立模块：

```text
src/conversation-log.ts
```

职责：

- 创建 `logs/` 目录。
- 根据时间生成日志文件路径。
- 接收 `model` 和 `messages`。
- 每次保存时写入完整 JSON 快照。

`src/chat.ts` 负责在会话启动时创建 logger，并在每次 `messages` 变化后调用保存函数。日志模块不依赖 OpenAI client，也不执行模型请求。

## 对话流程

一次 `pnpm chat` 会话启动后：

1. `runChatLoop()` 创建空 `messages` 数组。
2. `runChatLoop()` 创建一个会话 logger。
3. logger 立即创建 `logs/`，并写入空 `messages` 的初始日志。
4. 用户输入普通消息后，`messages.push({ role: "user", ... })`，随后保存日志。
5. assistant 普通回复加入 `messages` 后，保存日志。
6. assistant tool-call message 加入 `messages` 后，保存日志。
7. 每个 tool result 加入 `messages` 后，保存日志。
8. 工具后的最终 assistant 回复加入 `messages` 后，保存日志。
9. 用户输入 `exit` 或中断退出时，不需要额外生成新文件；现有文件已经包含最近一次成功保存的状态。

## 错误处理

- 如果 `logs/` 创建失败，CLI 打印错误并结束启动，因为日志功能是会话记录的明确要求。
- 如果保存日志失败，当前轮聊天请求不继续执行，错误由现有 `runChatLoop()` 错误输出路径展示。
- 日志写入使用 UTF-8。
- 日志写入失败不会产生部分 JSON 要求；实现可以通过先写临时文件再 rename，或直接覆盖写入。第一版优先简单直接覆盖写入，并依靠自动化测试保证正常路径。

## 测试计划

自动化测试：

- `conversation-log.ts`
  - 能创建 `logs/` 目录。
  - 能生成 Windows 兼容的 `.json` 文件名。
  - 保存后 JSON 包含 `startedAt`、`updatedAt`、`model` 和 `messages`。
  - 多次保存会覆盖同一个文件，并更新 `updatedAt` 与 `messages`。
- `chat.ts`
  - `runChatLoop()` 启动时创建 logger。
  - 用户消息加入后会保存日志。
  - 普通 assistant 回复加入后会保存日志。
  - tool-call、tool result、最终 assistant 回复加入后都会保存日志。
- `.gitignore`
  - 包含 `logs/`。

手动验收：

1. 运行 `pnpm chat`。
2. 输入一轮普通对话。
3. 输入 `exit`。
4. 确认 `logs/` 中出现一个 `.json` 文件。
5. 确认 JSON 中包含本次会话的 user 和 assistant messages。
6. 触发 `write_file` 工具调用时，确认日志中包含 assistant `tool_calls` 和 `role: "tool"` 结果。

## 验收标准

- `pnpm test` 通过。
- `pnpm typecheck` 通过。
- 每次 CLI 会话只创建一个日志文件。
- 每次 `messages` 变化后，同一个日志文件被更新。
- 日志 JSON 可以被标准 JSON 解析器读取。
- `logs/` 不会进入 git 提交。
