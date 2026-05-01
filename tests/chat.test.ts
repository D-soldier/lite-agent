import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import {
  extractDelta,
  isExitCommand,
  sendMessage,
  sendPlainMessage,
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
    expect(writes.join("")).toBe("你好");
    expect(response).toBe("你好");
  });
});

describe("sendMessage", () => {
  it("remains an alias for sendPlainMessage", () => {
    expect(sendMessage).toBe(sendPlainMessage);
  });
});
