import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  extractDelta,
  isExitCommand,
  readConfig,
} from "../src/index";

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
