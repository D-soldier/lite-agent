import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionMessageParam } from "../src/chat";
import {
  createConversationLogger,
  formatLogFileName,
  type Clock,
} from "../src/conversation-log";

const fsMockState = vi.hoisted(() => ({
  failNextWrite: false,
  initialSaveError: new Error("initial save failed"),
}));

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );

  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (fsMockState.failNextWrite) {
        fsMockState.failNextWrite = false;
        throw fsMockState.initialSaveError;
      }

      return actual.writeFile(...args);
    },
  };
});

function createSequenceClock(values: string[]): Clock {
  const dates = values.map((value) => new Date(value));
  let index = 0;

  return () => {
    const date = dates[Math.min(index, dates.length - 1)];
    index += 1;
    return date;
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function listTempFiles(path: string): string[] {
  return readdirSync(path).filter((fileName) => fileName.endsWith(".tmp"));
}

function listJsonFiles(path: string): string[] {
  return readdirSync(path).filter((fileName) => fileName.endsWith(".json"));
}

describe("formatLogFileName", () => {
  it("formats an ISO timestamp as a Windows-compatible JSON filename", () => {
    const fileName = formatLogFileName(
      new Date("2026-05-01T14:30:20.123Z"),
    );

    expect(fileName).toBe("2026-05-01T14-30-20-123Z.json");
    expect(fileName.slice(0, -".json".length)).not.toMatch(/[:.]/);
  });
});

describe("createConversationLogger", () => {
  it("creates the logs directory and writes an initial empty JSON snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-log-"));
    const logsDir = join(root, "logs");

    try {
      const logger = await createConversationLogger({
        model: "test-model",
        logsDir,
        now: createSequenceClock([
          "2026-05-01T14:30:20.123Z",
          "2026-05-01T14:30:20.456Z",
        ]),
      });

      expect(existsSync(logsDir)).toBe(true);
      expect(logger.filePath).toBe(
        join(logsDir, "2026-05-01T14-30-20-123Z.json"),
      );
      expect(readJson(logger.filePath)).toEqual({
        startedAt: "2026-05-01T14:30:20.123Z",
        updatedAt: "2026-05-01T14:30:20.456Z",
        model: "test-model",
        messages: [],
      });
      expect(readText(logger.filePath)).toContain('  "model": "test-model"');
      expect(readText(logger.filePath).endsWith("\n")).toBe(true);
      expect(listTempFiles(logsDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes the reserved log file and temp file when the initial save fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-log-"));
    const logsDir = join(root, "logs");

    try {
      fsMockState.failNextWrite = true;

      await expect(
        createConversationLogger({
          model: "test-model",
          logsDir,
          now: createSequenceClock([
            "2026-05-01T14:30:20.123Z",
            "2026-05-01T14:30:20.456Z",
          ]),
        }),
      ).rejects.toBe(fsMockState.initialSaveError);

      expect(listJsonFiles(logsDir)).toEqual([]);
      expect(listTempFiles(logsDir)).toEqual([]);
    } finally {
      fsMockState.failNextWrite = false;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a suffixed file name when a log already exists for the same timestamp", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-log-"));
    const logsDir = join(root, "logs");

    try {
      const first = await createConversationLogger({
        model: "test-model",
        logsDir,
        now: createSequenceClock([
          "2026-05-01T14:30:20.123Z",
          "2026-05-01T14:30:20.456Z",
        ]),
      });
      const second = await createConversationLogger({
        model: "test-model",
        logsDir,
        now: createSequenceClock([
          "2026-05-01T14:30:20.123Z",
          "2026-05-01T14:30:20.789Z",
        ]),
      });

      expect(first.filePath).toBe(
        join(logsDir, "2026-05-01T14-30-20-123Z.json"),
      );
      expect(second.filePath).toBe(
        join(logsDir, "2026-05-01T14-30-20-123Z-1.json"),
      );
      expect(existsSync(first.filePath)).toBe(true);
      expect(existsSync(second.filePath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("overwrites the same file with updated messages and updatedAt", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-log-"));
    const logsDir = join(root, "logs");

    try {
      const logger = await createConversationLogger({
        model: "test-model",
        logsDir,
        now: createSequenceClock([
          "2026-05-01T14:30:20.123Z",
          "2026-05-01T14:30:20.456Z",
          "2026-05-01T14:30:21.000Z",
          "2026-05-01T14:30:22.000Z",
        ]),
      });
      const userMessages: ChatCompletionMessageParam[] = [
        { role: "user", content: "你好" },
      ];
      const fullMessages: ChatCompletionMessageParam[] = [
        ...userMessages,
        { role: "assistant", content: "你好" },
      ];

      await logger.save(userMessages);
      await logger.save(fullMessages);

      expect(readJson(logger.filePath)).toEqual({
        startedAt: "2026-05-01T14:30:20.123Z",
        updatedAt: "2026-05-01T14:30:22.000Z",
        model: "test-model",
        messages: fullMessages,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes overlapping saves so the latest call wins", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-log-"));
    const logsDir = join(root, "logs");

    try {
      const logger = await createConversationLogger({
        model: "test-model",
        logsDir,
        now: createSequenceClock([
          "2026-05-01T14:30:20.123Z",
          "2026-05-01T14:30:20.456Z",
          "2026-05-01T14:30:21.000Z",
          "2026-05-01T14:30:22.000Z",
        ]),
      });
      const olderMessages: ChatCompletionMessageParam[] = [
        { role: "user", content: "old" },
      ];
      const newerMessages: ChatCompletionMessageParam[] = [
        { role: "user", content: "new" },
      ];

      const first = logger.save(olderMessages);
      const second = logger.save(newerMessages);
      await Promise.all([first, second]);

      expect(readJson(logger.filePath)).toEqual({
        startedAt: "2026-05-01T14:30:20.123Z",
        updatedAt: "2026-05-01T14:30:22.000Z",
        model: "test-model",
        messages: newerMessages,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
