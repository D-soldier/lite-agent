import { stdout } from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionMessageParam } from "../src/chat";

const readlineMock = vi.hoisted(() => ({
  close: vi.fn(),
  createInterface: vi.fn(),
  question: vi.fn(),
}));

vi.mock("node:readline/promises", () => ({
  createInterface: readlineMock.createInterface,
}));

const { runChatLoop } = await import("../src/chat");
import type { ChatClient } from "../src/chat";

function chatMessage(message: unknown): unknown {
  return { choices: [{ message }] };
}

function createQueuedFakeClient(responses: unknown[]): ChatClient {
  return {
    chat: {
      completions: {
        create: async () => {
          const response = responses.shift();

          if (response === undefined) {
            throw new Error("No fake response configured");
          }

          return response;
        },
      },
    },
  } as unknown as ChatClient;
}

function cloneMessages(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  return JSON.parse(JSON.stringify(messages)) as ChatCompletionMessageParam[];
}

describe("runChatLoop", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(stdout, "write").mockImplementation(() => true);
    readlineMock.createInterface.mockReturnValue({
      question: readlineMock.question,
      close: readlineMock.close,
    });
  });

  it("creates one logger and saves message snapshots", async () => {
    const snapshots: ChatCompletionMessageParam[][] = [];
    const save = vi.fn(async (messages: ChatCompletionMessageParam[]) => {
      snapshots.push(cloneMessages(messages));
    });
    const createLogger = vi.fn(async () => ({
      filePath: "log.json",
      save,
    }));
    const client = createQueuedFakeClient([
      chatMessage({ role: "assistant", content: "普通回复" }),
    ]);

    readlineMock.question
      .mockResolvedValueOnce("hello")
      .mockResolvedValueOnce("exit");

    await runChatLoop({
      client,
      model: "test-model",
      writeRoot: process.cwd(),
      createLogger,
    });

    expect(createLogger).toHaveBeenCalledTimes(1);
    expect(createLogger).toHaveBeenCalledWith({ model: "test-model" });
    expect(save).toHaveBeenCalledTimes(2);
    expect(snapshots).toEqual([
      [{ role: "user", content: "hello" }],
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "普通回复" },
      ],
    ]);
    expect(readlineMock.createInterface).toHaveBeenCalledTimes(1);
    expect(readlineMock.close).toHaveBeenCalled();
  });

  it("rejects when logger creation fails", async () => {
    const createLogger = vi.fn(async () => {
      throw new Error("log failed");
    });
    const client = createQueuedFakeClient([]);

    await expect(
      runChatLoop({
        client,
        model: "test-model",
        writeRoot: process.cwd(),
        createLogger,
      }),
    ).rejects.toThrow("log failed");

    expect(readlineMock.createInterface).not.toHaveBeenCalled();
  });
});
