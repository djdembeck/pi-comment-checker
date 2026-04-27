import { describe, it, expect, vi, beforeEach } from "vitest";
import commentCheckerExtension, {
  parseCommentOutput,
  extractFilePath,
  isValidEdit,
  buildCheckerInput,
  isValidFileChange,
  parseGitignorePattern,
  isIgnoredByGitignore,
  discoverSourceFiles,
  formatCommentMessage,
  buildApplyPatchCheckerInput,
} from "./index.js";
import { mkdir, writeFile, rm, mkdtemp } from "fs/promises";
import { join, dirname, relative } from "path";
import { tmpdir } from "os";

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
  it("returns true for valid edit object with snake_case", () => {
    expect(isValidEdit({ old_string: "old", new_string: "new" })).toBe(true);
  });

  it("returns true for valid edit object with camelCase (Pi format)", () => {
    expect(isValidEdit({ oldText: "old", newText: "new" })).toBe(true);
  });

  it("returns true for valid edit object with old_text/new_text (oh-my-pi format)", () => {
    expect(isValidEdit({ old_text: "old", new_text: "new" })).toBe(true);
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
  it("builds input for write tool with Pi runtime format (path key)", () => {
    const result = buildCheckerInput("write", {
      path: "/test.ts",
      content: "file content",
    });
    expect(result).toEqual({
      tool_name: "Write",
      file_path: "/test.ts",
      tool_input: {
        file_path: "/test.ts",
        content: "file content",
      },
    });
  });

  it("builds input for write tool with filePath key", () => {
    const result = buildCheckerInput("write", {
      filePath: "/test.ts",
      content: "file content",
    });
    expect(result).toEqual({
      tool_name: "Write",
      file_path: "/test.ts",
      tool_input: {
        file_path: "/test.ts",
        content: "file content",
      },
    });
  });

  it("builds input for write tool with file_path key (snake_case)", () => {
    const result = buildCheckerInput("write", {
      file_path: "/test.ts",
      content: "file content",
    });
    expect(result).toEqual({
      tool_name: "Write",
      file_path: "/test.ts",
      tool_input: {
        file_path: "/test.ts",
        content: "file content",
      },
    });
  });

  it("builds input for edit tool with Pi normalized format (edits array)", () => {
    const result = buildCheckerInput("edit", {
      path: "/test.ts",
      edits: [{ oldText: "old", newText: "new" }],
    });
    expect(result).toEqual({
      tool_name: "Edit",
      file_path: "/test.ts",
      tool_input: {
        file_path: "/test.ts",
        old_string: "old",
        new_string: "new",
      },
    });
  });

  it("builds input for edit tool with mixed snake_case in edits array", () => {
    const result = buildCheckerInput("edit", {
      path: "/test.ts",
      edits: [{ old_string: "old", new_string: "new" }],
    });
    expect(result).toEqual({
      tool_name: "Edit",
      file_path: "/test.ts",
      tool_input: {
        file_path: "/test.ts",
        old_string: "old",
        new_string: "new",
      },
    });
  });

  it("builds input for edit tool with oh-my-pi format (path inside edits, old_text/new_text)", () => {
    const result = buildCheckerInput("edit", {
      edits: [{ path: "/test.ts", old_text: "old", new_text: "new" }],
    });
    expect(result).toEqual({
      tool_name: "Edit",
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
      tool_name: "MultiEdit",
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

  it("builds input for multiedit tool with camelCase edits (Pi format)", () => {
    const result = buildCheckerInput("multiedit", {
      path: "/test.ts",
      edits: [
        { oldText: "old1", newText: "new1" },
        { oldText: "old2", newText: "new2" },
      ],
    });
    expect(result).toEqual({
      tool_name: "MultiEdit",
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

  it("builds input for edit tool with multiple edits (uses MultiEdit format)", () => {
    const result = buildCheckerInput("edit", {
      path: "/test.ts",
      edits: [
        { oldText: "old1", newText: "new1" },
        { oldText: "old2", newText: "new2" },
      ],
    });
    expect(result).toEqual({
      tool_name: "MultiEdit",
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

  it("builds input for edit tool with multiple edits in oh-my-pi format (path inside edits, old_text/new_text)", () => {
    const result = buildCheckerInput("edit", {
      edits: [
        { path: "/test.ts", old_text: "old1", new_text: "new1" },
        { path: "/test.ts", old_text: "old2", new_text: "new2" },
      ],
    });
    expect(result).toEqual({
      tool_name: "MultiEdit",
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

  it("returns null for edit with empty edits array", () => {
    expect(
      buildCheckerInput("edit", { path: "/test.ts", edits: [] }),
    ).toBeNull();
  });

  it("returns null for edit with invalid edits entry", () => {
    expect(
      buildCheckerInput("edit", {
        path: "/test.ts",
        edits: [{ oldText: "old" }], // missing newText
      }),
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
      buildCheckerInput("multiedit", {
        filePath: "/test.ts",
        edits: "not-array",
      }),
    ).toBeNull();
  });
});

describe("isValidFileChange", () => {
  it("returns true for valid file change", () => {
    expect(isValidFileChange({ filePath: "/test.ts", after: "content" })).toBe(
      true,
    );
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

  it("returns true when before and type are present", () => {
    expect(
      isValidFileChange({
        filePath: "/test.ts",
        before: "old content",
        after: "new content",
        type: "update",
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

  it("returns false when before is not a string", () => {
    expect(
      isValidFileChange({
        filePath: "/test.ts",
        before: 123,
        after: "content",
      }),
    ).toBe(false);
  });

  it("returns false when type is not a string", () => {
    expect(
      isValidFileChange({
        filePath: "/test.ts",
        after: "content",
        type: 123,
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
    expect(isIgnoredByGitignore("debug.log", "", false, patterns)).toBe(true);
    expect(isIgnoredByGitignore("src/app.ts", "", false, patterns)).toBe(false);
  });

  it("matches directory pattern", () => {
    const patterns = [parseGitignorePattern("node_modules/")!];
    expect(isIgnoredByGitignore("node_modules", "", true, patterns)).toBe(true);
    expect(
      isIgnoredByGitignore("node_modules/package", "", true, patterns),
    ).toBe(true);
  });

  it("handles negation", () => {
    const patterns = [
      parseGitignorePattern("*.log")!,
      parseGitignorePattern("!important.log")!,
    ];
    expect(isIgnoredByGitignore("debug.log", "", false, patterns)).toBe(true);
    expect(isIgnoredByGitignore("important.log", "", false, patterns)).toBe(
      false,
    );
  });

  it("matches anchored pattern from root", () => {
    const patterns = [parseGitignorePattern("/dist")!];
    // Scanner passes paths like "./dist" - anchored pattern should match only at root
    expect(isIgnoredByGitignore("./dist", "", true, patterns)).toBe(true);
    expect(isIgnoredByGitignore("./src/dist", "", true, patterns)).toBe(false);
  });

  it("matches anchored pattern for nested directories", () => {
    const patterns = [parseGitignorePattern("/dist")!];
    // Anchored pattern "/dist" should NOT match "./src/dist" (nested)
    expect(isIgnoredByGitignore("./src/dist", "", true, patterns)).toBe(false);
    expect(isIgnoredByGitignore("./nested/deep/dist", "", true, patterns)).toBe(
      false,
    );
  });

  it("matches double-star pattern", () => {
    const patterns = [parseGitignorePattern("**/node_modules")!];
    expect(isIgnoredByGitignore("node_modules", "", true, patterns)).toBe(true);
    expect(isIgnoredByGitignore("src/node_modules", "", true, patterns)).toBe(
      true,
    );
    expect(
      isIgnoredByGitignore("deep/nested/node_modules", "", true, patterns),
    ).toBe(true);
  });

  it("skips directory-only patterns for files", () => {
    const patterns = [parseGitignorePattern("build/")!];
    // Directory-only pattern should not match files
    expect(isIgnoredByGitignore("build", "", false, patterns)).toBe(false);
    // But should match directories
    expect(isIgnoredByGitignore("build", "", true, patterns)).toBe(true);
  });
});

describe("discoverSourceFiles integration", () => {
  it("respects anchored gitignore patterns (root level)", async () => {
    // Create temp directory structure with dist at root
    const tmpDir = await mkdtemp(join(tmpdir(), "vitest-test-dist"));
    try {
      // Create dist directory and file
      await mkdir(join(tmpDir, "dist"), { recursive: true });
      await writeFile(join(tmpDir, "dist", "test.ts"), "// comment");
      // Create src directory and file
      await mkdir(join(tmpDir, "src"), { recursive: true });
      await writeFile(join(tmpDir, "src", "main.ts"), "// comment");

      // Test with anchored pattern "/dist" - should exclude ./dist
      const patterns = [parseGitignorePattern("/dist")!];
      const discoveryResult = discoverSourceFiles(tmpDir, tmpDir, patterns);
      const files = discoveryResult.files;

      // Should find main.ts but not dist/test.ts
      expect(files.length).toBe(1);
      const relativePath = relative(tmpDir, files[0]).replace(/\\/g, "/");
      expect(relativePath.endsWith("src/main.ts")).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("respects anchored gitignore patterns (nested directories)", async () => {
    // Create temp directory structure with nested dist
    const tmpDir = await mkdtemp(join(tmpdir(), "vitest-test-nested"));
    try {
      // Create src/dist directory and file (nested)
      await mkdir(join(tmpDir, "src", "dist"), { recursive: true });
      await writeFile(join(tmpDir, "src", "dist", "test.ts"), "// comment");
      // Create src directory and file
      await writeFile(join(tmpDir, "src", "main.ts"), "// comment");

      // Test with anchored pattern "/dist" - should NOT exclude ./src/dist (nested)
      const patterns = [parseGitignorePattern("/dist")!];
      const discoveryResult = discoverSourceFiles(tmpDir, tmpDir, patterns);
      const files = discoveryResult.files;

      // Should find both - src/main.ts and src/dist/test.ts since /dist only matches root
      expect(files.length).toBe(2);
      const mainFile = files.find((f) =>
        relative(tmpDir, f).replace(/\\/g, "/").includes("src/main.ts"),
      );
      const distFile = files.find((f) =>
        relative(tmpDir, f).replace(/\\/g, "/").includes("src/dist/test.ts"),
      );
      expect(mainFile).toBeDefined();
      expect(distFile).toBeDefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("formatCommentMessage", () => {
  it("formats single comment message", () => {
    const comments = [{ file: "/test.ts", line: 5, text: "// TODO: fix this" }];
    const result = formatCommentMessage(comments, "/test.ts");
    expect(result).toContain("AI Comment Detected");
    expect(result).toContain("/test.ts:5: // TODO: fix this");
    expect(result).toContain("Self-Documenting Code Required");
  });

  it("formats multiple comments", () => {
    const comments = [
      { file: "/app.ts", line: 10, text: "// Hack: workaround" },
      { file: "/app.ts", line: 20, text: "// TODO: refactor" },
    ];
    const result = formatCommentMessage(comments, "/app.ts");
    expect(result).toContain("/app.ts:10: // Hack: workaround");
    expect(result).toContain("/app.ts:20: // TODO: refactor");
  });

  it("uses fallback file path for unknown comment file", () => {
    const comments = [{ file: "unknown", line: 1, text: "// comment" }];
    const result = formatCommentMessage(comments, "/test.ts");
    expect(result).toContain("/test.ts:1: // comment");
  });

  it("includes allowed exceptions in message", () => {
    const comments = [{ file: "/test.ts", line: 1, text: "// comment" }];
    const result = formatCommentMessage(comments, "/test.ts");
    expect(result).toContain("BDD (given/when/then)");
    expect(result).toContain("@ts-ignore");
    expect(result).toContain("eslint-disable");
  });

  it("uses literal 'unknown' when fallback is not provided and comment file is unknown", () => {
    const comments = [{ file: "unknown", line: 1, text: "// comment" }];
    const result = formatCommentMessage(comments);
    expect(result).toContain("unknown:1: // comment");
  });
});

describe("buildApplyPatchCheckerInput", () => {
  it("builds Edit-style input when before and after both present", () => {
    const file = {
      filePath: "/test.ts",
      after: "new content",
      before: "old content",
    };
    const result = buildApplyPatchCheckerInput(file);
    expect(result).toEqual({
      tool_name: "Edit",
      file_path: "/test.ts",
      tool_input: {
        file_path: "/test.ts",
        old_string: "old content",
        new_string: "new content",
      },
    });
  });

  it("builds Write-style input when only after present", () => {
    const file = {
      filePath: "/test.ts",
      after: "new content",
    };
    const result = buildApplyPatchCheckerInput(file);
    expect(result).toEqual({
      tool_name: "Write",
      file_path: "/test.ts",
      tool_input: {
        file_path: "/test.ts",
        content: "new content",
      },
    });
  });

  it("returns null for explicit delete operations", () => {
    const file = {
      filePath: "/test.ts",
      after: "",
      before: "old content",
      type: "delete",
    };
    const result = buildApplyPatchCheckerInput(file);
    expect(result).toBeNull();
  });

  it("keeps empty after content for non-delete edits", () => {
    const file = {
      filePath: "/test.ts",
      after: "",
      before: "old content",
      type: "update",
    };
    const result = buildApplyPatchCheckerInput(file);
    expect(result).toEqual({
      tool_name: "Edit",
      file_path: "/test.ts",
      tool_input: {
        file_path: "/test.ts",
        old_string: "old content",
        new_string: "",
      },
    });
  });

  it("uses movePath when present", () => {
    const file = {
      filePath: "/old.ts",
      movePath: "/new.ts",
      after: "content",
    };
    const result = buildApplyPatchCheckerInput(file);
    expect(result?.file_path).toBe("/new.ts");
    expect(result?.tool_input.file_path).toBe("/new.ts");
  });
});

describe("commentCheckerExtension", () => {
  interface MockPiAPI {
    handlers: Map<
      string,
      Array<(event: any, ctx: any) => Promise<unknown> | unknown>
    >;
    commands: Map<
      string,
      {
        description: string;
        handler: (args: string, ctx: any) => Promise<void>;
      }
    >;
    on: (
      event: string,
      handler: (event: any, ctx: any) => Promise<unknown> | unknown,
    ) => void;
    registerCommand: (
      name: string,
      options: {
        description: string;
        handler: (args: string, ctx: any) => Promise<void>;
      },
    ) => void;
  }

  /**
   * Creates a mock Pi API object with on/registerCommand event tracking.
   * Used to verify extension registration behavior without a real Pi runtime.
   * @returns Mock Pi API with handlers map, commands map, on, and registerCommand
   */
  function createMockPi(): MockPiAPI {
    const handlers = new Map<
      string,
      Array<(event: any, ctx: any) => Promise<unknown> | unknown>
    >();
    const commands = new Map<
      string,
      {
        description: string;
        handler: (args: string, ctx: any) => Promise<void>;
      }
    >();

    return {
      handlers,
      commands,
      on: (event, handler) => {
        const existing = handlers.get(event) ?? [];
        existing.push(handler);
        handlers.set(event, existing);
      },
      registerCommand: (name, options) => {
        commands.set(name, options);
      },
    };
  }

  /**
   * Creates a mock Pi context with a stubbed ui.notify function and current working directory.
   * @returns Mock context object for testing event handlers
   */
  function createMockCtx() {
    return {
      ui: {
        notify: vi.fn(),
      },
      cwd: process.cwd(),
    };
  }

  /**
   * Retrieves the single registered handler for a given event, asserting exactly one exists.
   * @param mockPi - Mock Pi API instance to inspect
   * @param event - Event name to retrieve handler for
   * @returns The single handler function registered for the event
   */
  function getSingleHandler(mockPi: MockPiAPI, event: string) {
    const handlers = mockPi.handlers.get(event);
    expect(handlers).toHaveLength(1);
    return handlers![0];
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("registers tool_call, tool_result, and check-comments command", () => {
    const mockPi = createMockPi();
    commentCheckerExtension(mockPi as any, {
      findBinary: () => ({
        found: false,
        path: "comment-checker",
        source: "not-found",
      }),
    });

    expect(mockPi.handlers.has("tool_call")).toBe(true);
    expect(mockPi.handlers.has("tool_result")).toBe(true);
    expect(mockPi.commands.has("check-comments")).toBe(true);
  });

  it("blocks write tool calls with detected comments", async () => {
    const mockPi = createMockPi();
    const ctx = createMockCtx();
    const runCommentCheckerMock = vi.fn().mockResolvedValue({
      status: "ok",
      result: {
        comments: [
          { file: "/tmp/test.ts", line: 1, text: "// TODO: fix this" },
        ],
      },
      source: "with-comments",
    });

    commentCheckerExtension(mockPi as any, {
      findBinary: () => ({
        found: true,
        path: "/bin/comment-checker",
        source: "path",
      }),
      runCommentChecker: runCommentCheckerMock,
    });

    const handler = getSingleHandler(mockPi, "tool_call");
    const result = await handler(
      {
        toolName: "write",
        input: {
          path: "/tmp/test.ts",
          content: "// TODO: fix this\nconst x = 1;",
        },
      },
      ctx,
    );

    expect(runCommentCheckerMock).toHaveBeenCalledWith(
      {
        tool_name: "Write",
        file_path: "/tmp/test.ts",
        tool_input: {
          file_path: "/tmp/test.ts",
          content: "// TODO: fix this\nconst x = 1;",
        },
      },
      "/bin/comment-checker",
      expect.any(Function),
    );
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("/tmp/test.ts:1: // TODO: fix this"),
    });
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      "AI comment detected — tool blocked",
      "warning",
    );
  });

  it("notifies on tool_call when PI_COMMENT_CHECKER_NOTIFY=1", async () => {
    process.env.PI_COMMENT_CHECKER_NOTIFY = "1";
    try {
      const mockPi = createMockPi();
      const ctx = createMockCtx();
      const runCommentCheckerMock = vi.fn().mockResolvedValue({
        status: "ok",
        result: {
          comments: [
            { file: "/tmp/test.ts", line: 1, text: "// TODO: fix this" },
          ],
        },
        source: "with-comments",
      });

      commentCheckerExtension(mockPi as any, {
        findBinary: () => ({
          found: true,
          path: "/bin/comment-checker",
          source: "path",
        }),
        runCommentChecker: runCommentCheckerMock,
      });

      const handler = getSingleHandler(mockPi, "tool_call");
      await handler(
        {
          toolName: "write",
          input: {
            path: "/tmp/notify.ts",
            content: "// TODO: fix this\nconst x = 1;",
          },
        },
        ctx,
      );

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "AI comment detected — tool blocked",
        "warning",
      );
    } finally {
      delete process.env.PI_COMMENT_CHECKER_NOTIFY;
    }
  });

  it("blocks edit tool calls with detected comments", async () => {
    const mockPi = createMockPi();
    const ctx = createMockCtx();
    const runCommentCheckerMock = vi.fn().mockResolvedValue({
      status: "ok",
      result: {
        comments: [
          { file: "/tmp/test.ts", line: 3, text: "// HACK: workaround" },
        ],
      },
      source: "with-comments",
    });

    commentCheckerExtension(mockPi as any, {
      findBinary: () => ({
        found: true,
        path: "/bin/comment-checker",
        source: "path",
      }),
      runCommentChecker: runCommentCheckerMock,
    });

    const handler = getSingleHandler(mockPi, "tool_call");
    const result = await handler(
      {
        toolName: "edit",
        input: {
          path: "/tmp/test.ts",
          edits: [
            {
              oldText: "const x = 1;",
              newText: "// HACK: workaround\nconst x = 1;",
            },
          ],
        },
      },
      ctx,
    );

    expect(runCommentCheckerMock).toHaveBeenCalledWith(
      {
        tool_name: "Edit",
        file_path: "/tmp/test.ts",
        tool_input: {
          file_path: "/tmp/test.ts",
          old_string: "const x = 1;",
          new_string: "// HACK: workaround\nconst x = 1;",
        },
      },
      "/bin/comment-checker",
      expect.any(Function),
    );
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("/tmp/test.ts:3: // HACK: workaround"),
    });
  });

  it("does not block when comment checker returns error", async () => {
    const mockPi = createMockPi();
    const ctx = createMockCtx();
    const runCommentCheckerMock = vi.fn().mockResolvedValue({
      status: "error",
      error: "checker process failed",
    });

    commentCheckerExtension(mockPi as any, {
      findBinary: () => ({
        found: true,
        path: "/bin/comment-checker",
        source: "path",
      }),
      runCommentChecker: runCommentCheckerMock,
    });

    const handler = getSingleHandler(mockPi, "tool_call");
    const result = await handler(
      {
        toolName: "write",
        input: { path: "/tmp/test.ts", content: "const x = 1;" },
      },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      "AI comment detected — tool blocked",
      "warning",
    );
  });

  it("allows clean write tool calls", async () => {
    const mockPi = createMockPi();
    const ctx = createMockCtx();
    const runCommentCheckerMock = vi.fn().mockResolvedValue({
      status: "ok",
      result: { comments: [] },
      source: "clean",
    });

    commentCheckerExtension(mockPi as any, {
      findBinary: () => ({
        found: true,
        path: "/bin/comment-checker",
        source: "path",
      }),
      runCommentChecker: runCommentCheckerMock,
    });

    const handler = getSingleHandler(mockPi, "tool_call");
    const result = await handler(
      {
        toolName: "write",
        input: { path: "/tmp/test.ts", content: "const x = 1;" },
      },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      "AI comment detected — tool blocked",
      "warning",
    );
  });

  it("ignores non-file-modifying tools in tool_call", async () => {
    const mockPi = createMockPi();
    const ctx = createMockCtx();
    const runCommentCheckerMock = vi.fn();

    commentCheckerExtension(mockPi as any, {
      findBinary: () => ({
        found: true,
        path: "/bin/comment-checker",
        source: "path",
      }),
      runCommentChecker: runCommentCheckerMock,
    });

    const handler = getSingleHandler(mockPi, "tool_call");
    const result = await handler(
      { toolName: "read", input: { path: "/tmp/test.ts" } },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(runCommentCheckerMock).not.toHaveBeenCalled();
  });

  it("warns once and does not block when binary is missing", async () => {
    const mockPi = createMockPi();
    const ctx = createMockCtx();
    const runCommentCheckerMock = vi.fn();

    commentCheckerExtension(mockPi as any, {
      findBinary: () => ({
        found: false,
        path: "comment-checker",
        source: "not-found",
      }),
      runCommentChecker: runCommentCheckerMock,
    });

    const handler = getSingleHandler(mockPi, "tool_call");
    const firstResult = await handler(
      {
        toolName: "write",
        input: { path: "/tmp/test.ts", content: "// TODO" },
      },
      ctx,
    );
    const secondResult = await handler(
      {
        toolName: "write",
        input: { path: "/tmp/test.ts", content: "// TODO again" },
      },
      ctx,
    );

    expect(firstResult).toBeUndefined();
    expect(secondResult).toBeUndefined();
    expect(runCommentCheckerMock).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "comment-checker: Binary not found. Run /check-comments for setup help.",
      "warning",
    );
  });

  it("checks apply_patch results with edit-style diffs and skips deletes", async () => {
    const mockPi = createMockPi();
    const ctx = createMockCtx();
    const runCommentCheckerMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: "ok",
        result: {
          comments: [{ file: "/tmp/a.ts", line: 1, text: "// comment" }],
        },
        source: "with-comments",
      })
      .mockResolvedValueOnce({
        status: "ok",
        result: { comments: [] },
        source: "clean",
      });

    commentCheckerExtension(mockPi as any, {
      findBinary: () => ({
        found: true,
        path: "/bin/comment-checker",
        source: "path",
      }),
      runCommentChecker: runCommentCheckerMock,
    });

    const handler = getSingleHandler(mockPi, "tool_result");
    const result = await handler(
      {
        toolName: "apply_patch",
        isError: false,
        content: [],
        details: {
          metadata: {
            files: [
              {
                filePath: "/tmp/a.ts",
                before: "const a = 1;\n",
                after: "// comment\nconst a = 1;\n",
                type: "update",
              },
              {
                filePath: "/tmp/b.ts",
                movePath: "/tmp/c.ts",
                before: "const b = 1;\n",
                after: "const c = 1;\n",
                type: "move",
              },
              {
                filePath: "/tmp/deleted.ts",
                before: "const gone = true;\n",
                after: "",
                type: "delete",
              },
            ],
          },
        },
      },
      ctx,
    );

    expect(runCommentCheckerMock).toHaveBeenCalledTimes(2);
    expect(runCommentCheckerMock).toHaveBeenNthCalledWith(
      1,
      {
        tool_name: "Edit",
        file_path: "/tmp/a.ts",
        tool_input: {
          file_path: "/tmp/a.ts",
          old_string: "const a = 1;\n",
          new_string: "// comment\nconst a = 1;\n",
        },
      },
      "/bin/comment-checker",
      expect.any(Function),
    );
    expect(runCommentCheckerMock).toHaveBeenNthCalledWith(
      2,
      {
        tool_name: "Edit",
        file_path: "/tmp/c.ts",
        tool_input: {
          file_path: "/tmp/c.ts",
          old_string: "const b = 1;\n",
          new_string: "const c = 1;\n",
        },
      },
      "/bin/comment-checker",
      expect.any(Function),
    );
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: expect.stringContaining("/tmp/a.ts:1: // comment"),
        },
      ],
      isError: true,
    });
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      "AI comment detected in apply_patch — see tool output",
      "warning",
    );
  });

  it("notifies on tool_result when PI_COMMENT_CHECKER_NOTIFY=1", async () => {
    process.env.PI_COMMENT_CHECKER_NOTIFY = "1";
    try {
      const mockPi = createMockPi();
      const ctx = createMockCtx();
      const runCommentCheckerMock = vi.fn().mockResolvedValue({
        status: "ok",
        result: {
          comments: [
            { file: "/tmp/a.ts", line: 1, text: "// comment" },
          ],
        },
        source: "with-comments",
      });

      commentCheckerExtension(mockPi as any, {
        findBinary: () => ({
          found: true,
          path: "/bin/comment-checker",
          source: "path",
        }),
        runCommentChecker: runCommentCheckerMock,
      });

      const handler = getSingleHandler(mockPi, "tool_result");
      await handler(
        {
          toolName: "apply_patch",
          isError: false,
          details: {
            metadata: {
              files: [
                {
                  type: "update",
                  filePath: "/tmp/a.ts",
                  before: "const a = 1;\n",
                  after: "// comment\nconst a = 2;\n",
                },
              ],
            },
          },
        },
        ctx,
      );

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "AI comment detected in apply_patch — see tool output",
        "warning",
      );
    } finally {
      delete process.env.PI_COMMENT_CHECKER_NOTIFY;
    }
  });
});
