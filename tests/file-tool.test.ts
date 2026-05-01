import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WRITE_FILE_TOOL,
  parseWriteFileArgs,
  resolveWritePath,
  writeFileTool,
} from "../src/file-tool";

describe("WRITE_FILE_TOOL", () => {
  it("defines the write_file function schema", () => {
    expect(WRITE_FILE_TOOL.type).toBe("function");
    if (WRITE_FILE_TOOL.type !== "function") {
      throw new Error("Expected function tool");
    }

    expect(WRITE_FILE_TOOL.function.name).toBe("write_file");
    expect(WRITE_FILE_TOOL.function.parameters).toMatchObject({
      type: "object",
      required: ["path", "content"],
      additionalProperties: false,
    });
  });
});

describe("parseWriteFileArgs", () => {
  it("defaults mode to overwrite", () => {
    expect(parseWriteFileArgs({ path: "a.txt", content: "hello" })).toEqual({
      path: "a.txt",
      content: "hello",
      mode: "overwrite",
    });
  });

  it("accepts append mode", () => {
    expect(
      parseWriteFileArgs({ path: "a.txt", content: "hello", mode: "append" }),
    ).toEqual({
      path: "a.txt",
      content: "hello",
      mode: "append",
    });
  });

  it("rejects invalid args", () => {
    expect(() => parseWriteFileArgs(null)).toThrow("object");
    expect(() => parseWriteFileArgs({ path: "", content: "hello" })).toThrow(
      "path",
    );
    expect(() => parseWriteFileArgs({ path: "a.txt", content: 123 })).toThrow(
      "content",
    );
    expect(() =>
      parseWriteFileArgs({ path: "a.txt", content: "hello", mode: "bad" }),
    ).toThrow("mode");
  });
});

describe("resolveWritePath", () => {
  it("resolves a relative path inside the write root", () => {
    const root = resolve("sandbox");

    expect(resolveWritePath(root, "notes/hello.txt")).toBe(
      join(root, "notes", "hello.txt"),
    );
  });

  it("allows an absolute path inside the write root", () => {
    const root = resolve("sandbox");
    const target = join(root, "notes", "hello.txt");

    expect(resolveWritePath(root, target)).toBe(target);
  });

  it("rejects paths outside the write root", () => {
    const root = resolve("sandbox");

    expect(() => resolveWritePath(root, "../outside.txt")).toThrow(
      "write root",
    );
    expect(() => resolveWritePath(root, resolve("outside.txt"))).toThrow(
      "write root",
    );
  });
});

describe("writeFileTool", () => {
  it("overwrites files and creates parent directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-write-"));

    try {
      const result = await writeFileTool(root, {
        path: "notes/hello.txt",
        content: "hello",
      });

      expect(result.ok).toBe(true);
      expect(result.mode).toBe("overwrite");
      expect(readFileSync(join(root, "notes", "hello.txt"), "utf8")).toBe(
        "hello",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("appends files", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-write-"));

    try {
      const targetDir = join(root, "notes");
      const target = join(targetDir, "hello.txt");
      mkdirSync(targetDir);
      writeFileSync(target, "hello");

      const result = await writeFileTool(root, {
        path: "notes/hello.txt",
        content: " world",
        mode: "append",
      });

      expect(result.ok).toBe(true);
      expect(result.mode).toBe("append");
      expect(readFileSync(target, "utf8")).toBe("hello world");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not write when args are invalid", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-write-"));

    try {
      const result = await writeFileTool(root, {
        path: "../outside.txt",
        content: "no",
      });

      expect(result.ok).toBe(false);
      expect(existsSync(resolve(root, "..", "outside.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
