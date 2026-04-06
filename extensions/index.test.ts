import { describe, it, expect } from "vitest";
import {
  parseCommentOutput,
  extractFilePath,
  isValidEdit,
  buildCheckerInput,
  isValidFileChange,
  parseGitignorePattern,
  isIgnoredByGitignore,
} from "./index.js";

describe("parseCommentOutput", () => {
  it("parses single comment from XML output", () => {
    const output = `<comments file="test.ts"><comment line-number="5">// This is a comment</comment></comments>`;
    const result = parseCommentOutput(output);
    expect(result).toEqual([
      { file: "test.ts", line: 5, text: "// This is a comment" },
    ]);
  });

  it("parses multiple comments", () => {
    const output = `<comments file="app.ts">
      <comment line-number="10">// TODO: fix this</comment>
      <comment line-number="20">// Hack: workaround</comment>
    </comments>`;
    const result = parseCommentOutput(output);
    expect(result).toEqual([
      { file: "app.ts", line: 10, text: "// TODO: fix this" },
      { file: "app.ts", line: 20, text: "// Hack: workaround" },
    ]);
  });

  it("returns unknown file when file attribute missing", () => {
    const output = `<comments><comment line-number="1">// comment</comment></comments>`;
    const result = parseCommentOutput(output);
    expect(result).toEqual([{ file: "unknown", line: 1, text: "// comment" }]);
  });

  it("skips invalid line numbers", () => {
    const output = `<comments file="test.ts">
      <comment line-number="0">// zero</comment>
      <comment line-number="-1">// negative</comment>
      <comment line-number="abc">// not a number</comment>
      <comment line-number="5">// valid</comment>
    </comments>`;
    const result = parseCommentOutput(output);
    expect(result).toEqual([{ file: "test.ts", line: 5, text: "// valid" }]);
  });

  it("returns empty array for no comments", () => {
    const output = `<comments file="test.ts"></comments>`;
    const result = parseCommentOutput(output);
    expect(result).toEqual([]);
  });

  it("trims comment text whitespace", () => {
    const output = `<comments file="test.ts"><comment line-number="1">  // spaced comment  </comment></comments>`;
    const result = parseCommentOutput(output);
    expect(result[0].text).toBe("// spaced comment");
  });
});

describe("extractFilePath", () => {
  it("extracts filePath from args", () => {
    expect(extractFilePath({ filePath: "/path/to/file.ts" })).toBe(
      "/path/to/file.ts",
    );
  });

  it("extracts file_path from args (snake_case)", () => {
    expect(extractFilePath({ file_path: "/path/to/file.ts" })).toBe(
      "/path/to/file.ts",
    );
  });

  it("extracts path from args", () => {
    expect(extractFilePath({ path: "/path/to/file.ts" })).toBe(
      "/path/to/file.ts",
    );
  });

  it("prioritizes filePath over other formats", () => {
    expect(
      extractFilePath({
        filePath: "/first.ts",
        file_path: "/second.ts",
        path: "/third.ts",
      }),
    ).toBe("/first.ts");
  });

  it("returns undefined when no path present", () => {
    expect(extractFilePath({})).toBeUndefined();
    expect(extractFilePath({ content: "code" })).toBeUndefined();
  });
});

describe("isValidEdit", () => {
  it("returns true for valid edit object", () => {
    expect(isValidEdit({ old_string: "old", new_string: "new" })).toBe(true);
  });

  it("returns false for null", () => {
    expect(isValidEdit(null)).toBe(false);
  });

  it("returns false for non-objects", () => {
    expect(isValidEdit("string")).toBe(false);
    expect(isValidEdit(123)).toBe(false);
    expect(isValidEdit(undefined)).toBe(false);
  });

  it("returns false when missing required properties", () => {
    expect(isValidEdit({})).toBe(false);
    expect(isValidEdit({ old_string: "old" })).toBe(false);
    expect(isValidEdit({ new_string: "new" })).toBe(false);
  });

  it("returns false when properties are not strings", () => {
    expect(isValidEdit({ old_string: 123, new_string: "new" })).toBe(false);
    expect(isValidEdit({ old_string: "old", new_string: null })).toBe(false);
  });
});

describe("buildCheckerInput", () => {
  it("builds input for write tool", () => {
    const result = buildCheckerInput("write", {
      filePath: "/test.ts",
      content: "file content",
    });
    expect(result).toEqual({
      tool_name: "write",
      file_path: "/test.ts",
      tool_input: {
        file_path: "/test.ts",
        content: "file content",
      },
    });
  });

  it("builds input for edit tool with camelCase", () => {
    const result = buildCheckerInput("edit", {
      filePath: "/test.ts",
      oldString: "old",
      newString: "new",
    });
    expect(result).toEqual({
      tool_name: "edit",
      file_path: "/test.ts",
      tool_input: {
        file_path: "/test.ts",
        old_string: "old",
        new_string: "new",
      },
    });
  });

  it("builds input for edit tool with snake_case", () => {
    const result = buildCheckerInput("edit", {
      file_path: "/test.ts",
      old_string: "old",
      new_string: "new",
    });
    expect(result).toEqual({
      tool_name: "edit",
      file_path: "/test.ts",
      tool_input: {
        file_path: "/test.ts",
        old_string: "old",
        new_string: "new",
      },
    });
  });

  it("builds input for multiedit tool", () => {
    const result = buildCheckerInput("multiedit", {
      filePath: "/test.ts",
      edits: [
        { old_string: "old1", new_string: "new1" },
        { old_string: "old2", new_string: "new2" },
      ],
    });
    expect(result).toEqual({
      tool_name: "multiedit",
      file_path: "/test.ts",
      tool_input: {
        file_path: "/test.ts",
        edits: [
          { old_string: "old1", new_string: "new1" },
          { old_string: "old2", new_string: "new2" },
        ],
      },
    });
  });

  it("returns null when no file path", () => {
    const result = buildCheckerInput("write", { content: "content" });
    expect(result).toBeNull();
  });

  it("returns null for edit without required strings", () => {
    expect(
      buildCheckerInput("edit", { filePath: "/test.ts", oldString: "old" }),
    ).toBeNull();
    expect(
      buildCheckerInput("edit", { filePath: "/test.ts", newString: "new" }),
    ).toBeNull();
  });

  it("returns null for multiedit with invalid edits", () => {
    expect(
      buildCheckerInput("multiedit", {
        filePath: "/test.ts",
        edits: [{ old_string: "old" }],
      }),
    ).toBeNull();
  });

  it("returns null for multiedit with non-array edits", () => {
    expect(
      buildCheckerInput("multiedit", { filePath: "/test.ts", edits: "not-array" }),
    ).toBeNull();
  });
});

describe("isValidFileChange", () => {
  it("returns true for valid file change", () => {
    expect(
      isValidFileChange({ filePath: "/test.ts", after: "content" }),
    ).toBe(true);
  });

  it("returns true for file change with movePath", () => {
    expect(
      isValidFileChange({
        filePath: "/old.ts",
        movePath: "/new.ts",
        after: "content",
      }),
    ).toBe(true);
  });

  it("returns false for null", () => {
    expect(isValidFileChange(null)).toBe(false);
  });

  it("returns false for non-objects", () => {
    expect(isValidFileChange("string")).toBe(false);
    expect(isValidFileChange(123)).toBe(false);
  });

  it("returns false when missing required properties", () => {
    expect(isValidFileChange({})).toBe(false);
    expect(isValidFileChange({ filePath: "/test.ts" })).toBe(false);
    expect(isValidFileChange({ after: "content" })).toBe(false);
  });

  it("returns false when movePath is not a string", () => {
    expect(
      isValidFileChange({
        filePath: "/test.ts",
        movePath: 123,
        after: "content",
      }),
    ).toBe(false);
  });

  it("returns true when movePath is undefined", () => {
    expect(
      isValidFileChange({
        filePath: "/test.ts",
        movePath: undefined,
        after: "content",
      }),
    ).toBe(true);
  });
});

describe("parseGitignorePattern", () => {
  it("parses simple pattern", () => {
    const result = parseGitignorePattern("*.log");
    expect(result).not.toBeNull();
    expect(result?.negation).toBe(false);
    expect(result?.directoryOnly).toBe(false);
    expect(result?.anchored).toBe(false);
  });

  it("parses negation pattern", () => {
    const result = parseGitignorePattern("!important.log");
    expect(result).not.toBeNull();
    expect(result?.negation).toBe(true);
    expect(result?.pattern).toBe("!important.log");
  });

  it("parses directory-only pattern", () => {
    const result = parseGitignorePattern("node_modules/");
    expect(result).not.toBeNull();
    expect(result?.directoryOnly).toBe(true);
  });

  it("parses anchored pattern", () => {
    const result = parseGitignorePattern("/dist");
    expect(result).not.toBeNull();
    expect(result?.anchored).toBe(true);
  });

  it("parses complex pattern", () => {
    const result = parseGitignorePattern("/build/**/*.js");
    expect(result).not.toBeNull();
    expect(result?.anchored).toBe(true);
    expect(result?.directoryOnly).toBe(false);
  });

  it("parses character class with closing bracket literal", () => {
    // Edge case: []] means "match the character ]"
    const result = parseGitignorePattern("[]]");
    expect(result).not.toBeNull();
    // Should match file named "]"
    expect(result?.regex.test("]")).toBe(true);
    // Should not match empty string or other chars
    expect(result?.regex.test("a")).toBe(false);
  });
});

describe("isIgnoredByGitignore", () => {
  it("matches simple wildcard pattern", () => {
    const patterns = [parseGitignorePattern("*.log")!];
    expect(isIgnoredByGitignore("debug.log", false, patterns)).toBe(true);
    expect(isIgnoredByGitignore("src/app.ts", false, patterns)).toBe(false);
  });

  it("matches directory pattern", () => {
    const patterns = [parseGitignorePattern("node_modules/")!];
    expect(isIgnoredByGitignore("node_modules", true, patterns)).toBe(true);
    expect(isIgnoredByGitignore("node_modules/package", true, patterns)).toBe(true);
  });

  it("handles negation", () => {
    const patterns = [
      parseGitignorePattern("*.log")!,
      parseGitignorePattern("!important.log")!,
    ];
    expect(isIgnoredByGitignore("debug.log", false, patterns)).toBe(true);
    expect(isIgnoredByGitignore("important.log", false, patterns)).toBe(false);
  });

  it("matches anchored pattern from root", () => {
    const patterns = [parseGitignorePattern("/dist")!];
    expect(isIgnoredByGitignore("dist", true, patterns)).toBe(true);
    expect(isIgnoredByGitignore("src/dist", true, patterns)).toBe(false);
  });

  it("matches double-star pattern", () => {
    const patterns = [parseGitignorePattern("**/node_modules")!];
    expect(isIgnoredByGitignore("node_modules", true, patterns)).toBe(true);
    expect(isIgnoredByGitignore("src/node_modules", true, patterns)).toBe(true);
    expect(isIgnoredByGitignore("deep/nested/node_modules", true, patterns)).toBe(true);
  });

  it("skips directory-only patterns for files", () => {
    const patterns = [parseGitignorePattern("build/")!];
    // Directory-only pattern should not match files
    expect(isIgnoredByGitignore("build", false, patterns)).toBe(false);
    // But should match directories
    expect(isIgnoredByGitignore("build", true, patterns)).toBe(true);
  });
});
