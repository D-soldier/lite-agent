import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import {
  extractDelta,
  handleUserMessage,
  isExitCommand,
  sendMessage,
  sendPlainMessage,
  type ChatClient,
  type ChatCompletionMessageParam,
  type ConfirmationRequest,
} from "../src/chat";

function createFakeClient() {
  const calls: unknown[] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: unknown) => {
          calls.push(request);

          return (async function* () {
            yield { choices: [{ delta: { content: "你" } }] };
            yield { choices: [{ delta: { content: "好" } }] };
            yield { choices: [{ delta: {} }] };
          })();
        },
      },
    },
  } as unknown as OpenAI;

  return { client, calls };
}

describe("isExitCommand", () => {
  it("accepts exit commands case-insensitively", () => {
    expect(isExitCommand("exit")).toBe(true);
    expect(isExitCommand("Quit")).toBe(true);
    expect(isExitCommand(" Quit ")).toBe(true);
  });

  it("rejects normal messages", () => {
    expect(isExitCommand("hello")).toBe(false);
  });
});

describe("extractDelta", () => {
  it("returns streamed text content", () => {
    expect(
      extractDelta({ choices: [{ delta: { content: "hello" } }] }),
    ).toBe("hello");
  });

  it("returns an empty string when no text is present", () => {
    expect(extractDelta({ choices: [{ delta: {} }] })).toBe("");
    expect(extractDelta({})).toBe("");
  });
});

describe("sendPlainMessage", () => {
  it("streams deltas, writes them, and returns the full response", async () => {
    const { client, calls } = createFakeClient();
    const writes: string[] = [];
    const messages = [{ role: "user" as const, content: "你好" }];

    const response = await sendPlainMessage({
      client,
      model: "test-model",
      messages,
      write: (text) => {
        writes.push(text);
      },
    });

    expect(calls).toEqual([{ model: "test-model", messages, stream: true }]);
    expect(writes).toEqual(["你", "好"]);
    expect(response).toBe("你好");
  });
});

describe("sendMessage", () => {
  it("remains an alias for sendPlainMessage", () => {
    expect(sendMessage).toBe(sendPlainMessage);
  });
});

type FakeChatClient = ChatClient & {
  calls: unknown[];
};

function createQueuedFakeClient(responses: unknown[]): FakeChatClient {
  const calls: unknown[] = [];
  const client = {
    calls,
    chat: {
      completions: {
        create: async (request: unknown) => {
          calls.push(request);
          const response = responses.shift();

          if (response === undefined) {
            throw new Error("No fake response configured");
          }

          return response;
        },
      },
    },
  } as unknown as FakeChatClient;

  return client;
}

function chatMessage(message: unknown): unknown {
  return {
    choices: [{ message }],
  };
}

function streamText(text: string): AsyncIterable<unknown> {
  return (async function* () {
    yield { choices: [{ delta: { content: text } }] };
  })();
}

function createSaveRecorder() {
  const snapshots: ChatCompletionMessageParam[][] = [];

  return {
    snapshots,
    saveMessages: async (messages: ChatCompletionMessageParam[]) => {
      snapshots.push(
        JSON.parse(JSON.stringify(messages)) as ChatCompletionMessageParam[],
      );
    },
  };
}

describe("handleUserMessage", () => {
  it("writes a normal assistant response when no tool call is returned", async () => {
    const messages: ChatCompletionMessageParam[] = [];
    const writes: string[] = [];
    const recorder = createSaveRecorder();
    const client = createQueuedFakeClient([
      chatMessage({ role: "assistant", content: "普通回复" }),
    ]);

    await handleUserMessage({
      client,
      model: "test-model",
      writeRoot: process.cwd(),
      messages,
      userInput: "你好",
      write: (text) => {
        writes.push(text);
      },
      askConfirmation: async () => true,
      saveMessages: recorder.saveMessages,
    });

    expect(writes).toEqual(["普通回复"]);
    expect(messages).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "普通回复" },
    ]);
    expect(recorder.snapshots).toEqual([
      [{ role: "user", content: "你好" }],
      [
        { role: "user", content: "你好" },
        { role: "assistant", content: "普通回复" },
      ],
    ]);
    expect(client.calls).toHaveLength(1);
    const firstRequest = client.calls[0] as {
      tools?: Array<{ function?: { name?: string } }>;
    };

    expect(firstRequest.tools?.map((tool) => tool.function?.name)).toEqual([
      "write_file",
      "read_file",
    ]);
  });

  it("confirms write_file, writes a file, sends tool result, and streams final response", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-chat-"));

    try {
      const messages: ChatCompletionMessageParam[] = [];
      const writes: string[] = [];
      const confirmations: ConfirmationRequest[] = [];
      const recorder = createSaveRecorder();
      const client = createQueuedFakeClient([
        chatMessage({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "notes/hello.txt",
                  content: "hello",
                }),
              },
            },
          ],
        }),
        chatMessage({ role: "assistant", content: "准备最终回复" }),
        streamText("写好了"),
      ]);

      await handleUserMessage({
        client,
        model: "test-model",
        writeRoot: root,
        messages,
        userInput: "写文件",
        write: (text) => {
          writes.push(text);
        },
        askConfirmation: async (request) => {
          confirmations.push(request);
          return true;
        },
        saveMessages: recorder.saveMessages,
      });

      expect(confirmations).toHaveLength(1);
      expect(confirmations[0]).toMatchObject({
        path: join(root, "notes", "hello.txt"),
        mode: "overwrite",
        contentLength: 5,
      });
      expect(readFileSync(join(root, "notes", "hello.txt"), "utf8")).toBe(
        "hello",
      );
      expect(writes).toEqual(["写好了"]);
      expect(client.calls).toHaveLength(3);
      expect(client.calls[0]).toMatchObject({
        model: "test-model",
        tools: expect.any(Array),
      });
      expect(client.calls[1]).toMatchObject({
        model: "test-model",
        messages,
        tools: expect.any(Array),
      });
      expect(client.calls[2]).toMatchObject({
        model: "test-model",
        messages,
        stream: true,
      });
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_1",
          content: expect.stringContaining('"ok":true'),
        }),
      );
      expect(messages.at(-1)).toEqual({
        role: "assistant",
        content: "写好了",
      });
      expect(recorder.snapshots).toHaveLength(4);
      expect(recorder.snapshots[0]).toEqual([
        { role: "user", content: "写文件" },
      ]);
      expect(recorder.snapshots[1]).toEqual([
        { role: "user", content: "写文件" },
        expect.objectContaining({
          role: "assistant",
          tool_calls: expect.any(Array),
        }),
      ]);
      expect(recorder.snapshots[2]).toEqual([
        { role: "user", content: "写文件" },
        expect.objectContaining({
          role: "assistant",
          tool_calls: expect.any(Array),
        }),
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_1",
          content: expect.stringContaining('"ok":true'),
        }),
      ]);
      expect(recorder.snapshots[3]).toEqual([
        { role: "user", content: "写文件" },
        expect.objectContaining({
          role: "assistant",
          tool_calls: expect.any(Array),
        }),
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_1",
          content: expect.stringContaining('"ok":true'),
        }),
        { role: "assistant", content: "写好了" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes read_file without confirmation and streams the final response", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-chat-"));

    try {
      const targetDir = join(root, "notes");
      mkdirSync(targetDir);
      writeFileSync(join(targetDir, "hello.txt"), "hello world");

      const messages: ChatCompletionMessageParam[] = [];
      const writes: string[] = [];
      let confirmationCalls = 0;
      const client = createQueuedFakeClient([
        chatMessage({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_read_1",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({
                  path: "notes/hello.txt",
                  maxBytes: 5,
                }),
              },
            },
          ],
        }),
        chatMessage({ role: "assistant", content: "ready to answer" }),
        streamText("read done"),
      ]);

      await handleUserMessage({
        client,
        model: "test-model",
        writeRoot: root,
        messages,
        userInput: "read a file",
        write: (text) => {
          writes.push(text);
        },
        askConfirmation: async () => {
          confirmationCalls += 1;
          throw new Error("read_file should not ask for confirmation");
        },
      });

      const toolMessage = messages.find((message) => message.role === "tool");
      if (!toolMessage || typeof toolMessage.content !== "string") {
        throw new Error("Expected read_file tool message");
      }
      const payload = JSON.parse(toolMessage.content) as Record<
        string,
        unknown
      >;

      expect(confirmationCalls).toBe(0);
      expect(payload).toMatchObject({
        ok: true,
        offset: 0,
        bytesRead: 5,
        nextOffset: 5,
        truncated: true,
        content: "hello",
      });
      expect(writes).toEqual(["read done"]);
      expect(client.calls).toHaveLength(3);
      expect(client.calls[2]).toMatchObject({
        model: "test-model",
        messages,
        stream: true,
      });
      expect(messages.at(-1)).toEqual({
        role: "assistant",
        content: "read done",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a read_file tool error and still streams the final response", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-chat-"));

    try {
      writeFileSync(join(root, "short.txt"), "abc");

      const messages: ChatCompletionMessageParam[] = [];
      const writes: string[] = [];
      let confirmationCalls = 0;
      const client = createQueuedFakeClient([
        chatMessage({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_read_1",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({
                  path: "short.txt",
                  offset: 4,
                }),
              },
            },
          ],
        }),
        chatMessage({ role: "assistant", content: "ready to answer" }),
        streamText("read failed"),
      ]);

      await handleUserMessage({
        client,
        model: "test-model",
        writeRoot: root,
        messages,
        userInput: "read past the end",
        write: (text) => {
          writes.push(text);
        },
        askConfirmation: async () => {
          confirmationCalls += 1;
          throw new Error("read_file should not ask for confirmation");
        },
      });

      const toolMessage = messages.find((message) => message.role === "tool");
      if (!toolMessage || typeof toolMessage.content !== "string") {
        throw new Error("Expected read_file tool message");
      }
      const payload = JSON.parse(toolMessage.content) as Record<
        string,
        unknown
      >;

      expect(confirmationCalls).toBe(0);
      expect(payload.ok).toBe(false);
      expect(payload.message).toEqual(expect.stringContaining("offset"));
      expect(writes).toEqual(["read failed"]);
      expect(messages.at(-1)).toEqual({
        role: "assistant",
        content: "read failed",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles two consecutive write_file tool rounds before final response", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-chat-"));

    try {
      const messages: ChatCompletionMessageParam[] = [];
      const writes: string[] = [];
      const client = createQueuedFakeClient([
        chatMessage({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "notes/one.txt",
                  content: "one",
                }),
              },
            },
          ],
        }),
        chatMessage({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_2",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "notes/two.txt",
                  content: "two",
                }),
              },
            },
          ],
        }),
        chatMessage({ role: "assistant", content: "准备最终回复" }),
        streamText("两个文件都写好了"),
      ]);

      await handleUserMessage({
        client,
        model: "test-model",
        writeRoot: root,
        messages,
        userInput: "写两个文件",
        write: (text) => {
          writes.push(text);
        },
        askConfirmation: async () => true,
      });

      expect(readFileSync(join(root, "notes", "one.txt"), "utf8")).toBe("one");
      expect(readFileSync(join(root, "notes", "two.txt"), "utf8")).toBe("two");
      expect(writes).toEqual(["两个文件都写好了"]);
      expect(client.calls).toHaveLength(4);
      expect(client.calls).toEqual([
        expect.objectContaining({ tools: expect.any(Array) }),
        expect.objectContaining({ tools: expect.any(Array) }),
        expect.objectContaining({ tools: expect.any(Array) }),
        expect.objectContaining({ stream: true }),
      ]);
      expect(
        messages.filter((message) => message.role === "tool"),
      ).toHaveLength(2);
      expect(messages.at(-1)).toEqual({
        role: "assistant",
        content: "两个文件都写好了",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not write when the user rejects confirmation", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-chat-"));

    try {
      const messages: ChatCompletionMessageParam[] = [];
      const client = createQueuedFakeClient([
        chatMessage({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "notes/hello.txt",
                  content: "hello",
                }),
              },
            },
          ],
        }),
        chatMessage({ role: "assistant", content: "准备最终回复" }),
        streamText("已取消"),
      ]);

      await handleUserMessage({
        client,
        model: "test-model",
        writeRoot: root,
        messages,
        userInput: "写文件",
        write: () => undefined,
        askConfirmation: async () => false,
      });

      expect(existsSync(join(root, "notes", "hello.txt"))).toBe(false);
      expect(client.calls.at(-1)).toMatchObject({
        model: "test-model",
        messages,
        stream: true,
      });
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          content: expect.stringContaining("用户拒绝写入。"),
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a tool error when arguments are invalid JSON", async () => {
    const messages: ChatCompletionMessageParam[] = [];
    const client = createQueuedFakeClient([
      chatMessage({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "write_file",
              arguments: "{bad json",
            },
          },
        ],
      }),
      chatMessage({ role: "assistant", content: "准备最终回复" }),
      streamText("参数错误"),
    ]);

    await handleUserMessage({
      client,
      model: "test-model",
      writeRoot: process.cwd(),
      messages,
      userInput: "写文件",
      write: () => undefined,
      askConfirmation: async () => true,
    });

    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        content: expect.stringContaining("JSON"),
      }),
    );
    expect(client.calls.at(-1)).toMatchObject({
      model: "test-model",
      messages,
      stream: true,
    });
  });

  it("returns a tool error for unknown tools", async () => {
    const messages: ChatCompletionMessageParam[] = [];
    const client = createQueuedFakeClient([
      chatMessage({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "unknown_tool",
              arguments: "{}",
            },
          },
        ],
      }),
      chatMessage({ role: "assistant", content: "准备最终回复" }),
      streamText("未知工具"),
    ]);

    await handleUserMessage({
      client,
      model: "test-model",
      writeRoot: process.cwd(),
      messages,
      userInput: "调用工具",
      write: () => undefined,
      askConfirmation: async () => true,
    });

    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        content: expect.stringContaining("不支持的工具"),
      }),
    );
    expect(client.calls.at(-1)).toMatchObject({
      model: "test-model",
      messages,
      stream: true,
    });
  });

  it("stops when tool calls exceed the maximum tool rounds", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-chat-"));

    try {
      const messages: ChatCompletionMessageParam[] = [];
      const writes: string[] = [];
      const client = createQueuedFakeClient([
        chatMessage({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "notes/one.txt",
                  content: "one",
                }),
              },
            },
          ],
        }),
        chatMessage({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_2",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "notes/two.txt",
                  content: "two",
                }),
              },
            },
          ],
        }),
        chatMessage({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_3",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "notes/three.txt",
                  content: "three",
                }),
              },
            },
          ],
        }),
      ]);

      await handleUserMessage({
        client,
        model: "test-model",
        writeRoot: root,
        messages,
        userInput: "一直写文件",
        write: (text) => {
          writes.push(text);
        },
        askConfirmation: async () => true,
      });

      expect(readFileSync(join(root, "notes", "one.txt"), "utf8")).toBe("one");
      expect(readFileSync(join(root, "notes", "two.txt"), "utf8")).toBe("two");
      expect(existsSync(join(root, "notes", "three.txt"))).toBe(false);
      expect(writes).toEqual([
        "工具调用超过最大轮数 2，已停止继续执行工具。",
      ]);
      expect(client.calls).toHaveLength(3);
      expect(
        messages.filter((message) => message.role === "tool"),
      ).toHaveLength(2);
      expect(messages.at(-1)).toEqual({
        role: "assistant",
        content: "工具调用超过最大轮数 2，已停止继续执行工具。",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
