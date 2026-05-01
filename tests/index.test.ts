import { describe, expect, it } from "vitest";
import { isDirectRun } from "../src/index";

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
