import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe(".gitignore", () => {
  it("ignores local conversation logs", () => {
    const entries = readFileSync(".gitignore", "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim());

    expect(entries).toContain("logs/");
  });
});
