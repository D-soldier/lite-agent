import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ChatCompletionMessageParam } from "./chat";

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
  return `${date.toISOString().replace(/[:.]/g, "-")}.json`;
}

export async function createConversationLogger({
  model,
  logsDir = resolve("logs"),
  now = () => new Date(),
}: CreateConversationLoggerOptions): Promise<ConversationLogger> {
  const startedAt = now().toISOString();
  const filePath = join(logsDir, formatLogFileName(new Date(startedAt)));

  await mkdir(logsDir, { recursive: true });

  const logger: ConversationLogger = {
    filePath,
    save: async (messages) => {
      const snapshot: ConversationLogSnapshot = {
        startedAt,
        updatedAt: now().toISOString(),
        model,
        messages,
      };

      await writeFile(
        filePath,
        `${JSON.stringify(snapshot, null, 2)}\n`,
        "utf8",
      );
    },
  };

  await logger.save([]);

  return logger;
}
