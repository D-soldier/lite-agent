# DeepSeek LLM 对话 CLI 设计

## 背景

当前项目是一个最小 Node.js 包，只有 `package.json`。目标是在这个项目中添加一个 TypeScript 命令行对话程序，通过 OpenAI SDK 调用 DeepSeek 的 OpenAI-compatible API。

DeepSeek 当前 API 文档列出 `https://api.deepseek.com` 作为 OpenAI-compatible base URL，并列出 `deepseek-v4-flash` 作为可用模型。

## 目标

- 提供交互式 CLI 对话循环。
- 使用官方 `openai` npm 包。
- 将 OpenAI SDK client 配置为调用 DeepSeek。
- 从 `DEEPSEEK_API_KEY` 读取 API key。
- 默认模型使用 `deepseek-v4-flash`。
- 以流式方式输出 assistant 回复。
- 只在当前进程内保留对话历史。

## 非目标

- 不持久化保存聊天历史。
- 不做 npm 包发布配置。
- 不加入 tool calling、文件上下文注入或 agent 框架。
- 不提供 GUI 或 Web 界面。

## 用户体验

用户通过以下命令启动 CLI：

```bash
pnpm chat
```

启动时，程序检查 `DEEPSEEK_API_KEY`。如果环境变量不存在，程序打印清晰的配置提示，并以非零状态码退出。

配置正确时，CLI 进入提示循环：

```text
you>
```

用户输入消息并按 Enter 后，assistant 回复会随着 token 到达持续输出到 stdout。每次回复结束后，CLI 打印换行并显示下一次输入提示。空输入会被忽略。输入 `exit` 或 `quit` 结束会话。按 `Ctrl+C` 也会干净退出。

## 配置

环境变量：

- `DEEPSEEK_API_KEY`：必填 API key。
- `DEEPSEEK_MODEL`：可选模型覆盖值，默认 `deepseek-v4-flash`。
- `DEEPSEEK_BASE_URL`：可选 base URL 覆盖值，默认 `https://api.deepseek.com`。

`DEEPSEEK_MODEL` 和 `DEEPSEEK_BASE_URL` 是可选项。这样默认使用路径足够简单，同时保留对兼容端点做测试或切换模型的能力。

## 技术设计

使用 TypeScript，并保持文件结构很小：

```text
package.json
tsconfig.json
src/
  index.ts
```

依赖：

- `openai`：访问 API。
- `tsx`：开发阶段直接运行 TypeScript。
- `typescript`：做类型检查。

`package.json` 脚本：

```json
{
  "chat": "tsx src/index.ts",
  "typecheck": "tsc --noEmit"
}
```

`src/index.ts` 包含 CLI 核心逻辑，并保持清晰的内部函数边界：

- `createClient()`：校验环境变量并返回 OpenAI SDK client。
- `runChatLoop()`：负责 readline 设置、提示符和退出处理。
- `sendMessage()`：携带当前消息历史发起流式请求。
- `extractDelta()`：从每个 stream chunk 中提取 assistant 增量文本。

第一版实现保持紧凑，同时为后续拆分模块留下自然扩展点。

## 数据流

1. 用户执行 `pnpm chat` 启动进程。
2. 程序读取环境变量。
3. 使用 `apiKey` 和 `baseURL` 创建 `OpenAI` client。
4. 初始化内存中的 `messages` 数组。
5. 对每条非空用户输入：
   - 追加 `{ role: "user", content: input }`。
   - 调用 `client.chat.completions.create()`，并设置 `stream: true`。
   - 将每个流式文本增量输出到 stdout。
   - 累积完整 assistant 回复。
   - 请求完成后追加 `{ role: "assistant", content: response }`。

如果流式调用在完成前失败，不把不完整的 assistant 回复加入历史。

## 错误处理

- 缺少 `DEEPSEEK_API_KEY`：打印直接的设置提示并退出。
- API 请求失败：打印简洁错误，然后继续提示循环。
- 空输入：忽略并重新提示。
- `exit`、`quit` 或 `Ctrl+C`：关闭 readline 并干净退出。

## 验证

实现后运行：

```bash
pnpm install
pnpm typecheck
```

手动检查：

- 未设置 `DEEPSEEK_API_KEY` 时，`pnpm chat` 打印缺少 key 的错误。
- 设置 `DEEPSEEK_API_KEY` 后，`pnpm chat` 启动交互式会话。
- 简单 prompt 能返回流式回复。
- 第二个 prompt 能带上前文对话上下文。
- `exit`、`quit` 和 `Ctrl+C` 都能干净退出。

## 参考

- DeepSeek API Docs: https://api-docs.deepseek.com/
- DeepSeek Models and Pricing: https://api-docs.deepseek.com/quick_start/pricing
