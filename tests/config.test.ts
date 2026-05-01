import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  loadEnvFile,
  readConfig,
} from "../src/config";

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
          "LITE_AGENT_WRITE_ROOT=notes",
          "",
        ].join("\n"),
      );

      loadEnvFile(envFilePath, env);

      expect(env).toEqual({
        DEEPSEEK_API_KEY: "existing-key",
        DEEPSEEK_MODEL: "file-model",
        DEEPSEEK_BASE_URL: "https://file.example",
        LITE_AGENT_WRITE_ROOT: "notes",
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

  it("uses DeepSeek defaults and cwd write root when optional env vars are absent", () => {
    expect(readConfig({ DEEPSEEK_API_KEY: "sk-test" })).toEqual({
      apiKey: "sk-test",
      baseURL: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
      writeRoot: process.cwd(),
    });
  });

  it("allows model, base URL, and write root overrides", () => {
    expect(
      readConfig({
        DEEPSEEK_API_KEY: "sk-test",
        DEEPSEEK_MODEL: "custom-model",
        DEEPSEEK_BASE_URL: "https://example.test",
        LITE_AGENT_WRITE_ROOT: "sandbox",
      }),
    ).toEqual({
      apiKey: "sk-test",
      baseURL: "https://example.test",
      model: "custom-model",
      writeRoot: resolve("sandbox"),
    });
  });
});
