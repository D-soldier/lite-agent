# 命令执行工具设计

## 背景

当前 CLI 已支持三类能力：

- 使用 DeepSeek 的 OpenAI-compatible API 进行对话。
- 通过 `write_file` 在用户确认后写入文件。
- 通过 `read_file` 在允许根目录内读取文本文件。
- 将一次聊天的所有 `messages` 写入 `logs/`。

下一步需要增加一个本地命令执行工具，让模型可以请求执行 Bash 或 PowerShell 命令，并把命令输出作为 tool result 返回给模型。这个能力风险高，因此必须在执行前让用户确认。

## 目标

- 增加 `run_command` 工具，让模型可以执行 Bash 或 PowerShell 命令。
- 每次执行前都要求用户确认。
- 命令默认在 `LITE_AGENT_WRITE_ROOT` 中执行。
- 如果模型指定 `cwd`，也必须位于 `LITE_AGENT_WRITE_ROOT` 内。
- 支持默认 30 秒、最大 120 秒的超时控制。
- 支持较长命令，但不做后台进程管理。
- 捕获 stdout、stderr、exit code、signal、耗时和超时状态。
- stdout 和 stderr 各最多返回 64KB，超过后截断并标记。
- 子进程完整继承当前环境变量。
- 命令 tool call 和执行结果自然进入现有 conversation log。

## 非目标

- 不实现后台命令或进程生命周期管理。
- 不支持交互式 stdin 输入。
- 不做危险命令拦截或命令白名单。
- 不新增独立命令日志文件。
- 不新建 `LITE_AGENT_COMMAND_ROOT`。
- 不过滤子进程环境变量。
- 不重构为通用工具 registry。

## 已确认决策

- 执行前每次都要求用户确认。
- 命令执行根目录复用 `LITE_AGENT_WRITE_ROOT`。
- 支持 `powershell` 和 `bash`。
- 默认超时 `30000` ms，最大超时 `120000` ms。
- stdout 和 stderr 各最多返回 `65536` 字节。
- 子进程完整继承当前环境变量。
- 允许较长命令，但受最大 120 秒超时限制。
- 不做危险命令拦截，只依赖用户确认。
- 使用独立模块 `src/command-tool.ts`，不把命令逻辑放进 `src/file-tool.ts`。

## 工具定义

工具名：

```text
run_command
```

参数示例：

```json
{
  "command": "pnpm test",
  "shell": "powershell",
  "cwd": ".",
  "timeoutMs": 30000
}
```

字段规则：

- `command`：必填，非空字符串。
- `shell`：可选，值为 `powershell` 或 `bash`。未传时 Windows 默认 `powershell`，其他平台默认 `bash`。
- `cwd`：可选，默认 `"."`。相对路径以 `LITE_AGENT_WRITE_ROOT` 为基准解析；绝对路径必须位于该根目录内。
- `timeoutMs`：可选，默认 `30000`，必须是正整数，最大 `120000`。

JSON Schema：

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "Command text to execute after user confirmation."
    },
    "shell": {
      "type": "string",
      "enum": ["powershell", "bash"],
      "description": "Shell used to execute the command. Defaults to powershell on Windows and bash elsewhere."
    },
    "cwd": {
      "type": "string",
      "description": "Working directory for the command, relative to the configured write root unless already inside it."
    },
    "timeoutMs": {
      "type": "integer",
      "minimum": 1,
      "maximum": 120000,
      "description": "Command timeout in milliseconds. Defaults to 30000."
    }
  },
  "required": ["command"],
  "additionalProperties": false
}
```

## 返回结构

成功且 exit code 为 0 时：

```json
{
  "ok": true,
  "shell": "powershell",
  "command": "pnpm test",
  "cwd": "D:\\code\\lite_agent",
  "exitCode": 0,
  "signal": null,
  "timedOut": false,
  "stdout": "...",
  "stderr": "",
  "stdoutTruncated": false,
  "stderrTruncated": false,
  "durationMs": 1234,
  "message": "Command exited with code 0."
}
```

命令执行完成但 exit code 非 0 时：

```json
{
  "ok": false,
  "shell": "powershell",
  "command": "pnpm test",
  "cwd": "D:\\code\\lite_agent",
  "exitCode": 1,
  "signal": null,
  "timedOut": false,
  "stdout": "...",
  "stderr": "...",
  "stdoutTruncated": false,
  "stderrTruncated": false,
  "durationMs": 1234,
  "message": "Command exited with code 1."
}
```

超时时：

```json
{
  "ok": false,
  "shell": "powershell",
  "command": "pnpm test",
  "cwd": "D:\\code\\lite_agent",
  "exitCode": null,
  "signal": "SIGTERM",
  "timedOut": true,
  "stdout": "...",
  "stderr": "...",
  "stdoutTruncated": false,
  "stderrTruncated": false,
  "durationMs": 120000,
  "message": "Command timed out after 120000 ms."
}
```

参数错误、cwd 越界、shell 不可用或 spawn 失败时：

```json
{
  "ok": false,
  "message": "Command cwd is outside the write root: D:\\code\\lite_agent"
}
```

## 路径与工作目录安全

命令工作目录复用现有 `writeRoot`：

- `writeRoot` 来自 `LITE_AGENT_WRITE_ROOT` 或 `process.cwd()`。
- `cwd` 未传时使用 `writeRoot`。
- 相对 `cwd` 使用 `resolve(writeRoot, cwd)`。
- 绝对 `cwd` 使用 `resolve(cwd)`。
- 解析后的 `cwd` 必须位于 `writeRoot` 内。
- `cwd` 必须存在并且是目录。
- `cwd` 本身不能是符号链接或 junction。
- `cwd` 的真实路径必须仍位于真实 `writeRoot` 内。

如果 `cwd` 校验失败，工具直接返回失败结果，不进入用户确认，也不执行命令。

## Shell 执行方式

`run_command` 使用 Node.js `child_process.spawn()`。

PowerShell：

```text
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <command>
```

Bash：

```text
bash -lc <command>
```

默认 shell：

- Windows：`powershell`
- 非 Windows：`bash`

如果请求的 shell 不存在或无法启动，返回失败 tool result。

## 确认流程

`run_command` 每次执行前都需要用户确认。

确认前 CLI 展示：

- shell
- cwd
- command
- timeoutMs

只有用户输入 `y` 才执行。其他输入视为拒绝。

用户拒绝时返回：

```json
{
  "ok": false,
  "message": "用户拒绝执行命令。"
}
```

## 环境变量

子进程完整继承当前 `process.env`。

这意味着模型请求的命令可以读取当前进程拥有的环境变量，包括 `DEEPSEEK_API_KEY`、`*_KEY`、`*_TOKEN`、`*_SECRET` 等敏感变量。该设计依赖确认界面让用户在执行前看到完整命令并决定是否允许。

## 超时与输出截断

超时：

- 默认 `timeoutMs` 为 `30000`。
- 最大 `timeoutMs` 为 `120000`。
- 超时后终止子进程并返回 `timedOut: true`。
- 不追踪或清理命令自行创建的子进程。

输出：

- stdout 最多返回 `65536` 字节。
- stderr 最多返回 `65536` 字节。
- 超出限制时截断后续输出。
- 截断字段分别为 `stdoutTruncated` 和 `stderrTruncated`。
- 截断后的内容会进入 tool result 和 conversation log。

## 聊天流程集成

新增 `src/command-tool.ts`：

- `RUN_COMMAND_TOOL`
- `RunCommandShell`
- `RunCommandArgs`
- `RunCommandResult`
- `parseRunCommandArgs()`
- `resolveCommandCwd()`
- `runCommandTool()`

调整 `src/chat.ts`：

- `AVAILABLE_TOOLS` 增加 `RUN_COMMAND_TOOL`。
- 确认请求类型扩展为可表达写文件和执行命令两种请求。
- `askCliConfirmation()` 根据请求类型展示不同确认文案。
- `executeToolCall()` 增加 `run_command` 分支。
- `run_command` 的 cwd 越界或参数错误直接返回失败结果。
- `run_command` 只有在参数和 cwd 校验通过后才询问用户确认。
- `write_file` 和 `read_file` 的现有行为保持不变。

现有单轮最多 2 轮工具调用限制保持不变。

## 日志

不新增独立命令日志文件。

现有 conversation log 会自然记录：

- 模型发出的 `run_command` tool call。
- 用户确认后命令的 tool result。
- stdout/stderr 截断后的内容。
- 超时、exit code、signal 等结构化结果。

如果命令输出包含敏感信息，这些信息也会进入 `logs/*.json`。这是完整继承环境变量和记录 tool result 的直接后果。

## 错误处理

以下情况返回失败 tool result：

- 参数不是对象。
- `command` 为空或不是字符串。
- `shell` 不是 `powershell` 或 `bash`。
- `cwd` 不是字符串。
- `cwd` 解析到 `writeRoot` 外。
- `cwd` 不存在或不是目录。
- `cwd` 是符号链接或 junction。
- `timeoutMs` 不是正整数或超过 `120000`。
- 用户拒绝执行。
- shell 启动失败。
- 命令超时。
- 命令 exit code 非 0。

工具不会因为命令 exit code 非 0 抛出异常；它会返回结构化结果并设置 `ok: false`。

## 测试计划

自动化测试：

- `tests/command-tool.test.ts`
  - `RUN_COMMAND_TOOL` schema 正确。
  - `parseRunCommandArgs()` 使用默认 shell、cwd 和 timeout。
  - `parseRunCommandArgs()` 拒绝非法 `command`、`shell`、`cwd`、`timeoutMs`。
  - `resolveCommandCwd()` 接受根目录内相对路径和绝对路径。
  - `resolveCommandCwd()` 拒绝根目录外路径。
  - `resolveCommandCwd()` 拒绝不存在的目录和文件路径。
  - `resolveCommandCwd()` 拒绝符号链接或 junction 逃逸。
  - PowerShell 命令执行成功。
  - Bash 命令在可用时执行成功；不可用时跳过。
  - 非零 exit code 返回 `ok: false`。
  - 超时命令返回 `timedOut: true`。
  - stdout/stderr 超过 64KB 时截断。
- `tests/chat.test.ts`
  - 工具列表包含 `write_file`、`read_file`、`run_command`。
  - `run_command` 执行前触发确认。
  - 用户拒绝时不执行命令。
  - 用户确认后执行并追加 tool message。
  - `cwd` 越界时直接失败，不进入确认。
  - 现有 `write_file` 和 `read_file` 流程不回归。

手动验收：

1. 运行 `pnpm chat`。
2. 输入 `请运行 pnpm test`。
3. CLI 展示命令确认信息。
4. 输入 `y`。
5. 模型收到命令输出并回复测试结果。
6. 查看最新 `logs/*.json`，确认包含 `run_command` tool call 和 result。

## 验收标准

- `pnpm test` 通过。
- `pnpm typecheck` 通过。
- 模型可以请求执行 PowerShell 命令。
- 模型可以请求执行 Bash 命令，前提是本机安装 Bash。
- 每次命令执行前都要求用户确认。
- 用户拒绝时不执行命令。
- 命令只能在 `LITE_AGENT_WRITE_ROOT` 内的 cwd 执行。
- 命令超时后返回 `timedOut: true`。
- stdout/stderr 超过 64KB 时被截断并标记。
- 子进程完整继承环境变量。
- `write_file`、`read_file` 和 conversation log 行为不回归。
