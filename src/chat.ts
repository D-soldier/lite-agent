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

export type { ChatCompletionMessageParam };
