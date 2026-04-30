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

  const candidates = [pathToFileURL(argvPath).href];

  if (argvPath.startsWith("/")) {
    candidates.push(`file://${argvPath}`);
  }

  return candidates.includes(metaUrl);
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
