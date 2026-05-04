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
import {
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  parseWriteFileArgs,
  readFileTool,
  resolveWritePath,
  writeFileTool,
} from "./file-tool";
import {
  RUN_COMMAND_TOOL,
  parseRunCommandArgs,
  resolveCommandCwd,
  runCommandTool,
} from "./command-tool";
import {
  createConversationLogger,
  type ConversationLogger,
} from "./conversation-log";

export const MAX_TOOL_ROUNDS = 2;
export const AVAILABLE_TOOLS = [
  WRITE_FILE_TOOL,
  READ_FILE_TOOL,
  RUN_COMMAND_TOOL,
];

export type ChatClient = Pick<OpenAI, "chat">;

export type RunChatLoopOptions = {
  client: ChatClient;
  model: string;
  writeRoot: string;
  createLogger?: CreateConversationLogger;
};

export type CreateConversationLogger = (options: {
  model: string;
}) => Promise<ConversationLogger>;

export type SendMessageOptions = {
  client: ChatClient;
  model: string;
  messages: ChatCompletionMessageParam[];
  write?: (text: string) => void;
};

export type WriteFileConfirmationRequest = {
  type: "write_file";
  path: string;
  mode: "overwrite" | "append";
  contentLength: number;
};

export type RunCommandConfirmationRequest = {
  type: "run_command";
  shell: "powershell" | "bash";
  command: string;
  cwd: string;
  timeoutMs: number;
};

export type ConfirmationRequest =
  | WriteFileConfirmationRequest
  | RunCommandConfirmationRequest;

export type AskConfirmation = (
  request: ConfirmationRequest,
) => Promise<boolean>;

export type SaveMessages = (
  messages: ChatCompletionMessageParam[],
) => Promise<void>;

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
  if (request.type === "run_command") {
    stdout.write(
      [
        "\n模型请求执行命令：",
        `shell：${request.shell}`,
        `cwd：${request.cwd}`,
        `timeoutMs：${request.timeoutMs}`,
        `command：${request.command}`,
        "确认执行请输入 y。",
      ].join("\n"),
    );
  } else {
    stdout.write(
      [
        "\n模型请求写入文件：",
        `路径：${request.path}`,
        `模式：${request.mode}`,
        `内容长度：${request.contentLength}`,
        "确认写入请输入 y。",
      ].join("\n"),
    );
  }

  const answer = await rl.question("\nconfirm> ");

  return answer.trim() === "y";
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
    tools: AVAILABLE_TOOLS,
  });
  const message = (response as ChatCompletion).choices[0]?.message;

  if (!message) {
    return { role: "assistant", content: "", refusal: null };
  }

  return message;
}

function toolResult(content: { ok: boolean; message: string }): string {
  return JSON.stringify(content);
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
  if (toolCall.type !== "function") {
    return toolResult({
      ok: false,
      message: `不支持的工具：${toolCall.type}`,
    });
  }

  if (toolCall.function.name === "read_file") {
    try {
      const args = parseToolArguments(toolCall.function.arguments);

      return JSON.stringify(await readFileTool(writeRoot, args));
    } catch (error) {
      return toolResult({ ok: false, message: formatError(error) });
    }
  }

  if (toolCall.function.name === "run_command") {
    try {
      const args = parseRunCommandArgs(
        parseToolArguments(toolCall.function.arguments),
      );
      const cwd = await resolveCommandCwd(writeRoot, args.cwd);
      const confirmed = await askConfirmation({
        type: "run_command",
        shell: args.shell,
        command: args.command,
        cwd,
        timeoutMs: args.timeoutMs,
      });

      if (!confirmed) {
        return toolResult({ ok: false, message: "用户拒绝执行命令。" });
      }

      return JSON.stringify(
        await runCommandTool({
          ...args,
          cwd,
        }),
      );
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
        type: "write_file",
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
  saveMessages = async () => undefined,
}: HandleUserMessageOptions): Promise<void> {
  messages.push({ role: "user", content: userInput });
  await saveMessages(messages);

  let toolRounds = 0;

  while (true) {
    const message = await requestToolOrText({ client, model, messages });

    if (!message.tool_calls || message.tool_calls.length === 0) {
      if (toolRounds > 0) {
        const response = await sendPlainMessage({
          client,
          model,
          messages,
          write,
        });
        messages.push({ role: "assistant", content: response });
        await saveMessages(messages);
        return;
      }

      const content = message.content ?? "";

      if (content.length > 0) {
        write(content);
      }

      messages.push({ role: "assistant", content });
      await saveMessages(messages);
      return;
    }

    if (toolRounds >= MAX_TOOL_ROUNDS) {
      const content = `工具调用超过最大轮数 ${MAX_TOOL_ROUNDS}，已停止继续执行工具。`;

      write(content);
      messages.push({ role: "assistant", content });
      await saveMessages(messages);
      return;
    }

    messages.push(message as ChatCompletionAssistantMessageParam);
    await saveMessages(messages);

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
      await saveMessages(messages);
    }

    toolRounds += 1;
  }
}

export async function runChatLoop({
  client,
  model,
  writeRoot,
  createLogger = createConversationLogger,
}: RunChatLoopOptions): Promise<void> {
  const logger = await createLogger({ model });
  const saveMessages: SaveMessages = (nextMessages) =>
    logger.save(nextMessages);
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
          saveMessages,
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

export type { ChatCompletionMessageParam };
