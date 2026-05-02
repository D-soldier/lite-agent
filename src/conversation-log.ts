import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
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

let nextWriteId = 0;

export function formatLogFileName(date: Date): string {
  return `${date.toISOString().replace(/[:.]/g, "-")}.json`;
}

function formatCandidateLogFileName(date: Date, suffix: number): string {
  const fileName = formatLogFileName(date);

  if (suffix === 0) {
    return fileName;
  }

  return `${fileName.slice(0, -".json".length)}-${suffix}.json`;
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function getTempFilePath(filePath: string): string {
  nextWriteId += 1;
  return `${filePath}.${process.pid}.${nextWriteId}.tmp`;
}

async function writeFileAtomically(
  filePath: string,
  contents: string,
): Promise<void> {
  const tempPath = getTempFilePath(filePath);

  try {
    await writeFile(tempPath, contents, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function reserveLogFile(logsDir: string, startedAt: Date): Promise<string> {
  for (let suffix = 0; ; suffix += 1) {
    const filePath = join(
      logsDir,
      formatCandidateLogFileName(startedAt, suffix),
    );

    try {
      const file = await open(filePath, "wx");
      await file.close();
      return filePath;
    } catch (error) {
      if (isFileExistsError(error)) {
        continue;
      }

      throw error;
    }
  }
}

export async function createConversationLogger({
  model,
  logsDir = resolve("logs"),
  now = () => new Date(),
}: CreateConversationLoggerOptions): Promise<ConversationLogger> {
  const startedAtDate = now();
  const startedAt = startedAtDate.toISOString();

  await mkdir(logsDir, { recursive: true });

  const filePath = await reserveLogFile(logsDir, startedAtDate);
  let writeChain = Promise.resolve();

  const logger: ConversationLogger = {
    filePath,
    save: (messages) => {
      const snapshot: ConversationLogSnapshot = {
        startedAt,
        updatedAt: now().toISOString(),
        model,
        messages,
      };
      const currentWrite = writeChain.catch(() => undefined).then(async () => {
        await writeFileAtomically(
          filePath,
          `${JSON.stringify(snapshot, null, 2)}\n`,
        );
      });

      writeChain = currentWrite;

      return currentWrite;
    },
  };

  await logger.save([]);

  return logger;
}
