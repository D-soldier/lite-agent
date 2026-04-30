import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  extractDelta,
  isExitCommand,
  isDirectRun,
  loadEnvFile,
  readConfig,
  sendMessage,
} from "../src/index";

describe("loadEnvFile", () => {
  it("loads .env values without overriding existing environment values", () => {
    const dir = mkdtempSync(join(tmpdir(), "lite-agent-env-"));

    try {
      const envFilePath = join(dir, ".env");
      const env = { DEEPSEEK_API_KEY: "existing-key" };
      writeFileSync(
        envFilePath,
        [
          "DEEPSEEK_API_KEY=file-key",
          "DEEPSEEK_MODEL=file-model",
          "DEEPSEEK_BASE_URL=https://file.example",
          "",
        ].join("\n"),
      );

      loadEnvFile(envFilePath, env);

      expect(env).toEqual({
        DEEPSEEK_API_KEY: "existing-key",
        DEEPSEEK_MODEL: "file-model",
        DEEPSEEK_BASE_URL: "https://file.example",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a missing .env file", () => {
    const env = {};

    expect(() => loadEnvFile("missing.env", env)).not.toThrow();
    expect(env).toEqual({});
  });
});

describe("readConfig", () => {
  it("throws when DEEPSEEK_API_KEY is missing", () => {
    expect(() => readConfig({})).toThrow("DEEPSEEK_API_KEY");
  });

  it("uses DeepSeek defaults when optional env vars are absent", () => {
    expect(readConfig({ DEEPSEEK_API_KEY: "sk-test" })).toEqual({
      apiKey: "sk-test",
      baseURL: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
    });
  });

  it("allows model and base URL overrides", () => {
    expect(
      readConfig({
        DEEPSEEK_API_KEY: "sk-test",
        DEEPSEEK_MODEL: "custom-model",
        DEEPSEEK_BASE_URL: "https://example.test",
      }),
    ).toEqual({
      apiKey: "sk-test",
      baseURL: "https://example.test",
      model: "custom-model",
    });
  });
});

describe("isExitCommand", () => {
  it("accepts exit and quit regardless of surrounding whitespace or case", () => {
    expect(isExitCommand("exit")).toBe(true);
    expect(isExitCommand(" Quit ")).toBe(true);
  });

  it("rejects normal chat messages", () => {
    expect(isExitCommand("hello")).toBe(false);
  });
});

describe("extractDelta", () => {
  it("returns streamed text content", () => {
    const chunk = {
      choices: [{ delta: { content: "你好" } }],
    };

    expect(extractDelta(chunk)).toBe("你好");
  });

  it("returns an empty string when a chunk has no text", () => {
    const chunk = {
      choices: [{ delta: {} }],
    };

    expect(extractDelta(chunk)).toBe("");
  });
});

describe("sendMessage", () => {
  it("sends chat history with streaming enabled and writes streamed deltas", async () => {
    const calls: unknown[] = [];
    const fakeStream = (async function* () {
      yield { choices: [{ delta: { content: "你" } }] };
      yield { choices: [{ delta: { content: "好" } }] };
      yield { choices: [{ delta: {} }] };
    })();
    const client = {
      chat: {
        completions: {
          create: async (params: unknown) => {
            calls.push(params);
            return fakeStream;
          },
        },
      },
    } as unknown as OpenAI;
    const writes: string[] = [];
    const messages = [{ role: "user" as const, content: "你好" }];

    const response = await sendMessage({
      client,
      model: "deepseek-v4-flash",
      messages,
      write: (text) => {
        writes.push(text);
      },
    });

    expect(response).toBe("你好");
    expect(writes.join("")).toBe("你好");
    expect(calls).toEqual([
      {
        model: "deepseek-v4-flash",
        messages,
        stream: true,
      },
    ]);
  });
});

describe("isDirectRun", () => {
  it("detects when the current module is the process entry", () => {
    expect(isDirectRun("file:///tmp/app/src/index.ts", "/tmp/app/src/index.ts")).toBe(
      true,
    );
  });

  it("returns false when argv path is missing", () => {
    expect(isDirectRun("file:///tmp/app/src/index.ts", undefined)).toBe(false);
  });
});
