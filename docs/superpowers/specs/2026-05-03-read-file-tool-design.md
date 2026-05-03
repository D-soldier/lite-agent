# 文件读取工具设计

## 背景

当前 CLI 已支持：

- 使用 DeepSeek 的 OpenAI-compatible API 进行对话。
- 通过 `write_file` 工具在用户确认后写入文件。
- 使用 `LITE_AGENT_WRITE_ROOT` 限制文件写入根目录，默认是当前项目目录。
- 对写入路径做越界、符号链接和 junction 逃逸防护。
- 将一次聊天会话的 `messages` 写入 `logs/`。

下一步需要增加第二个本地工具：`read_file`。模型可以读取允许根目录内的文本文件内容，再基于内容继续回答或决定是否继续分段读取。

## 目标

- 增加 `read_file` 工具，允许模型读取本地文本文件。
- 读取范围复用现有 `writeRoot`，也就是 `LITE_AGENT_WRITE_ROOT`；未设置时使用 `process.cwd()`。
- 相对路径以 `writeRoot` 为基准解析。
- 绝对路径必须位于 `writeRoot` 内。
- 阻止 `..`、绝对路径、符号链接或 junction 造成的根目录逃逸。
- 读取前不要求用户确认。
- 单次最多读取 `256KB`。
- 支持通过 `offset` 继续读取后续内容。
- 工具结果回传给模型，并自然进入现有 conversation log。
- 为参数解析、路径安全、分段读取和聊天 tool-call 流程添加自动化测试。

## 非目标

- 不增加新的 `LITE_AGENT_READ_ROOT`。
- 不支持读取任意绝对路径。
- 不对读取内容做脱敏。
- 不实现文件搜索、目录遍历或 glob。
- 不实现二进制文件专用模式或 base64 返回。
- 不实现持久化 cursor；续读只通过显式 `offset` 完成。
- 不改变 `write_file` 的用户确认和写入安全逻辑。

## 工具定义

工具名：

```text
read_file
```

参数：

```json
{
  "path": "notes/hello.txt",
  "offset": 0,
  "maxBytes": 262144
}
```

字段规则：

- `path`：必填，非空字符串。
- `offset`：可选，非负整数，默认 `0`。单位是字节。
- `maxBytes`：可选，正整数，默认 `262144`，最大值也限制为 `262144`。单位是字节。

JSON Schema：

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Path to read, relative to the configured write root unless it is already inside the write root."
    },
    "offset": {
      "type": "integer",
      "minimum": 0,
      "description": "Byte offset to start reading from. Defaults to 0."
    },
    "maxBytes": {
      "type": "integer",
      "minimum": 1,
      "maximum": 262144,
      "description": "Maximum bytes to read. Defaults to 262144 and cannot exceed 262144."
    }
  },
  "required": ["path"],
  "additionalProperties": false
}
```

## 返回结构

成功时：

```json
{
  "ok": true,
  "path": "D:\\code\\lite_agent\\notes\\hello.txt",
  "offset": 0,
  "bytesRead": 1234,
  "nextOffset": 1234,
  "truncated": false,
  "content": "hello deepseek",
  "message": "Read file: D:\\code\\lite_agent\\notes\\hello.txt"
}
```

字段说明：

- `offset` 是本次读取起点。
- `bytesRead` 是本次实际读取字节数。
- `nextOffset` 是下一次继续读取应传入的 offset，等于 `offset + bytesRead`。
- `truncated` 表示文件在 `nextOffset` 后还有内容。
- `content` 是本次读取到的内容，按 UTF-8 解码为字符串。

如果 `truncated: true`，模型可以继续调用：

```json
{
  "path": "notes/hello.txt",
  "offset": 1234
}
```

失败时：

```json
{
  "ok": false,
  "message": "Target path is outside the write root: D:\\code\\lite_agent"
}
```

## 路径安全

读取路径使用与写入工具一致的根目录约束：

- `writeRoot` 取自 `LITE_AGENT_WRITE_ROOT` 或 `process.cwd()`。
- 相对路径用 `resolve(writeRoot, requestedPath)` 解析。
- 绝对路径必须解析在 `writeRoot` 内。
- 路径越界时拒绝读取。
- 读取目标必须是普通文件。
- 目录读取会失败。
- 目标文件本身是符号链接时拒绝读取。
- 现有父级路径中包含符号链接或 junction 时拒绝读取。
- 最终真实路径必须位于真实 `writeRoot` 内。

这会避免模型通过 `../`、绝对路径、symlink 或 junction 读取允许根目录外的文件。

## 读取行为

读取使用字节语义：

1. 解析并校验 `path`、`offset`、`maxBytes`。
2. 安全解析目标路径。
3. 确认目标是普通文件。
4. 获取文件大小。
5. 从 `offset` 开始读取最多 `maxBytes` 字节。
6. 将读取到的 Buffer 以 UTF-8 解码为 `content`。
7. 返回 `bytesRead`、`nextOffset` 和 `truncated`。

边界行为：

- 如果 `offset` 等于文件大小，返回空 `content`、`bytesRead: 0`、`truncated: false`。
- 如果 `offset` 大于文件大小，返回失败结果。
- 如果文件不存在，返回失败结果。
- 如果 `maxBytes` 大于 `262144`，返回失败结果，不自动放大。

## 架构

第一版使用现有 `src/file-tool.ts`，不引入通用工具注册框架。

新增或调整内容：

- `src/file-tool.ts`
  - 新增 `READ_FILE_TOOL` schema。
  - 新增 `parseReadFileArgs()`。
  - 新增 `readFileTool()`。
  - 抽出或复用路径安全辅助函数，保证 `write_file` 和 `read_file` 共享同一套根目录判断。
- `src/chat.ts`
  - 将工具列表从 `[WRITE_FILE_TOOL]` 改为 `[WRITE_FILE_TOOL, READ_FILE_TOOL]`。
  - `executeToolCall()` 支持 `read_file`。
  - `read_file` 不调用用户确认。
  - `write_file` 保持现有确认流程。

不改动：

- `src/config.ts` 不新增配置项。
- `src/conversation-log.ts` 不需要特殊处理；现有日志会记录 `read_file` 的 tool call 和 tool result。

## 对话流程

每轮用户输入后：

1. CLI 向模型发送包含 `write_file` 和 `read_file` 的工具定义。
2. 如果模型返回 `read_file` tool call：
   - CLI 校验参数和路径。
   - CLI 不询问用户确认。
   - CLI 读取最多 `maxBytes` 字节。
   - CLI 将读取结果作为 `role: "tool"` 消息追加到 `messages`。
3. 模型根据读取结果生成最终回复。
4. 如果结果 `truncated: true`，模型可以在同一轮或后续轮再次调用 `read_file`，传入 `nextOffset` 继续读取。

现有单轮最多 2 轮工具调用限制保持不变。也就是说模型在同一轮用户输入中最多可以连续读取两段；如果仍需要更多内容，可以让用户继续发起下一轮请求。

## 错误处理

- 参数不是对象：返回失败 tool result。
- `path` 为空或不是字符串：返回失败 tool result。
- `offset` 不是非负整数：返回失败 tool result。
- `maxBytes` 不是正整数或超过 `262144`：返回失败 tool result。
- 路径越界：返回失败 tool result。
- 路径包含符号链接或 junction 逃逸风险：返回失败 tool result。
- 目标不是普通文件：返回失败 tool result。
- 文件不存在或读取失败：返回失败 tool result。
- 未知工具名：保持现有失败 tool result。
- API 请求失败：保持现有 CLI 错误输出路径。

## 测试计划

自动化测试：

- `file-tool.ts`
  - `READ_FILE_TOOL` schema 正确。
  - `parseReadFileArgs()` 默认 `offset: 0` 和 `maxBytes: 262144`。
  - 非法 `path`、`offset`、`maxBytes` 被拒绝。
  - 相对路径读取成功。
  - 根目录内绝对路径读取成功。
  - `offset` 续读成功。
  - 文件超过 `maxBytes` 时返回 `truncated: true` 和正确 `nextOffset`。
  - `offset` 等于文件大小时返回空内容。
  - `offset` 大于文件大小时失败。
  - `../` 越界路径失败。
  - 根目录外绝对路径失败。
  - 目录读取失败。
  - 目标 symlink 或父级 junction/symlink 逃逸失败。
- `chat.ts`
  - tools 请求包含 `write_file` 和 `read_file`。
  - `read_file` tool call 不触发用户确认。
  - `read_file` 成功后追加 tool result，并继续最终流式回复。
  - `read_file` 失败后追加失败 tool result，并继续最终流式回复。
  - 现有 `write_file` 流程不回归。
- `conversation-log.ts`
  - 不需要新增专门逻辑；chat 测试可确认 read tool result 在 `messages` 中，自然会被保存。

手动验收：

1. 运行 `pnpm chat`。
2. 输入 `请读取 1.txt 的内容`。
3. 模型调用 `read_file`。
4. CLI 不出现确认提示。
5. 模型基于文件内容回复。
6. 查看 `logs/` 最新 JSON，确认包含 `read_file` tool call 和 tool result。
7. 对超过 `256KB` 的文件，确认模型可以通过 `nextOffset` 继续读取。

## 验收标准

- `pnpm test` 通过。
- `pnpm typecheck` 通过。
- 默认只能读取当前项目目录内文件。
- 设置 `LITE_AGENT_WRITE_ROOT` 后，只能读取该根目录内文件。
- `read_file` 不要求用户确认。
- 单次读取不超过 `256KB`。
- 可以通过 `offset` 继续读取后续内容。
- 符号链接、junction、越界路径不能读取根目录外文件。
- `write_file` 原有行为不回归。
