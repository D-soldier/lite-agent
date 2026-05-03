import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  parseReadFileArgs,
  parseWriteFileArgs,
  readFileTool,
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

describe("READ_FILE_TOOL", () => {
  it("defines the read_file function schema", () => {
    expect(READ_FILE_TOOL.type).toBe("function");
    if (READ_FILE_TOOL.type !== "function") {
      throw new Error("Expected function tool");
    }

    expect(READ_FILE_TOOL.function.name).toBe("read_file");
    expect(READ_FILE_TOOL.function.parameters).toMatchObject({
      type: "object",
      required: ["path"],
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        maxBytes: { type: "integer", minimum: 1, maximum: 262144 },
      },
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

describe("parseReadFileArgs", () => {
  it("defaults offset to zero and maxBytes to 256KB", () => {
    expect(parseReadFileArgs({ path: "notes/hello.txt" })).toEqual({
      path: "notes/hello.txt",
      offset: 0,
      maxBytes: 262144,
    });
  });

  it("accepts explicit offset and maxBytes", () => {
    expect(
      parseReadFileArgs({
        path: "notes/hello.txt",
        offset: 12,
        maxBytes: 4096,
      }),
    ).toEqual({
      path: "notes/hello.txt",
      offset: 12,
      maxBytes: 4096,
    });
  });

  it("rejects invalid args", () => {
    expect(() => parseReadFileArgs(null)).toThrow("object");
    expect(() => parseReadFileArgs({ path: "" })).toThrow("path");
    expect(() => parseReadFileArgs({ path: "notes/hello.txt", offset: -1 }))
      .toThrow("offset");
    expect(() => parseReadFileArgs({ path: "notes/hello.txt", offset: 1.5 }))
      .toThrow("offset");
    expect(() => parseReadFileArgs({ path: "notes/hello.txt", maxBytes: 0 }))
      .toThrow("maxBytes");
    expect(() =>
      parseReadFileArgs({ path: "notes/hello.txt", maxBytes: 1.5 }),
    ).toThrow("maxBytes");
    expect(() =>
      parseReadFileArgs({ path: "notes/hello.txt", maxBytes: 262145 }),
    ).toThrow("maxBytes");
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

  it("allows root-contained paths whose first segment starts with dots", () => {
    const root = resolve("sandbox");

    expect(resolveWritePath(root, "..safe/hello.txt")).toBe(
      join(root, "..safe", "hello.txt"),
    );
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
      const outsideName = `${basename(root)}-outside.txt`;
      const outsidePath = resolve(root, "..", outsideName);
      const result = await writeFileTool(root, {
        path: `../${outsideName}`,
        content: "no",
      });

      expect(result.ok).toBe(false);
      expect(existsSync(outsidePath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not follow a directory symlink or junction outside the write root", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-write-"));
    const outside = mkdtempSync(join(tmpdir(), "lite-agent-outside-"));

    try {
      const linkPath = join(root, "link");
      try {
        symlinkSync(
          outside,
          linkPath,
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "EPERM" || error.code === "EACCES")
        ) {
          return;
        }
        throw error;
      }

      const result = await writeFileTool(root, {
        path: "link/outside.txt",
        content: "no",
      });

      expect(result.ok).toBe(false);
      expect(existsSync(join(outside, "outside.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing symlink file", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-write-"));
    const outside = mkdtempSync(join(tmpdir(), "lite-agent-outside-"));

    try {
      const outsideTarget = join(outside, "target.txt");
      writeFileSync(outsideTarget, "outside");

      try {
        symlinkSync(outsideTarget, join(root, "target.txt"), "file");
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "EPERM" || error.code === "EACCES")
        ) {
          return;
        }
        throw error;
      }

      const result = await writeFileTool(root, {
        path: "target.txt",
        content: "inside",
      });

      expect(result.ok).toBe(false);
      expect(readFileSync(outsideTarget, "utf8")).toBe("outside");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("readFileTool", () => {
  it("reads a relative text file", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-read-"));

    try {
      const targetDir = join(root, "notes");
      const target = join(targetDir, "hello.txt");
      mkdirSync(targetDir);
      writeFileSync(target, "hello world");

      const result = await readFileTool(root, {
        path: "notes/hello.txt",
      });

      expect(result).toMatchObject({
        ok: true,
        path: target,
        offset: 0,
        bytesRead: 11,
        nextOffset: 11,
        truncated: false,
        content: "hello world",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads from an offset and reports truncation", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-read-"));

    try {
      const target = join(root, "sample.txt");
      writeFileSync(target, "abcdef");

      const result = await readFileTool(root, {
        path: "sample.txt",
        offset: 2,
        maxBytes: 3,
      });

      expect(result).toMatchObject({
        ok: true,
        offset: 2,
        bytesRead: 3,
        nextOffset: 5,
        truncated: true,
        content: "cde",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns empty content when offset equals file size", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-read-"));

    try {
      const target = join(root, "sample.txt");
      writeFileSync(target, "abc");

      const result = await readFileTool(root, {
        path: "sample.txt",
        offset: 3,
      });

      expect(result).toMatchObject({
        ok: true,
        offset: 3,
        bytesRead: 0,
        nextOffset: 3,
        truncated: false,
        content: "",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when offset is larger than file size", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-read-"));

    try {
      const target = join(root, "sample.txt");
      writeFileSync(target, "abc");

      const result = await readFileTool(root, {
        path: "sample.txt",
        offset: 4,
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("offset");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails for directories and missing files", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-read-"));

    try {
      mkdirSync(join(root, "notes"));

      const directoryResult = await readFileTool(root, { path: "notes" });
      const missingResult = await readFileTool(root, { path: "missing.txt" });

      expect(directoryResult.ok).toBe(false);
      expect(directoryResult.message).toContain("file");
      expect(missingResult.ok).toBe(false);
      expect(missingResult.message).toContain("exist");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not read paths outside the write root", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-read-"));

    try {
      const outsideName = `${basename(root)}-outside.txt`;
      const outsidePath = resolve(root, "..", outsideName);
      writeFileSync(outsidePath, "secret");

      const result = await readFileTool(root, {
        path: `../${outsideName}`,
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("write root");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(resolve(root, "..", `${basename(root)}-outside.txt`), {
        force: true,
      });
    }
  });

  it("does not follow a directory symlink or junction outside the write root", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-read-"));
    const outside = mkdtempSync(join(tmpdir(), "lite-agent-outside-"));

    try {
      const linkPath = join(root, "link");
      writeFileSync(join(outside, "outside.txt"), "secret");

      try {
        symlinkSync(
          outside,
          linkPath,
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "EPERM" || error.code === "EACCES")
        ) {
          return;
        }
        throw error;
      }

      const result = await readFileTool(root, {
        path: "link/outside.txt",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("linked");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not read an existing symlink file", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-agent-read-"));
    const outside = mkdtempSync(join(tmpdir(), "lite-agent-outside-"));

    try {
      const outsideTarget = join(outside, "target.txt");
      writeFileSync(outsideTarget, "secret");

      try {
        symlinkSync(outsideTarget, join(root, "target.txt"), "file");
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "EPERM" || error.code === "EACCES")
        ) {
          return;
        }
        throw error;
      }

      const result = await readFileTool(root, {
        path: "target.txt",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("symbolic link");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
