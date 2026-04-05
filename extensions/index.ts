import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Pi extension that integrates go-claude-code-comment-checker
 * to block AI-generated comment patterns.
 *
 * Philosophy: Code should be self-documenting. If you need comments to
 * explain what code does, the code needs better naming and structure.
 *
 * Allowed exceptions:
 * - BDD comments: // given, // when, // then
 * - Linter directives: // @ts-ignore, // eslint-disable
 * - Shebangs: #!/usr/bin/env node
 */

interface CommentCheckerInput {
  tool_name: string;
  file_path: string;
  tool_input: {
    file_path: string;
    content?: string;
    new_string?: string;
    old_string?: string;
    edits?: Array<{ old_string: string; new_string: string }>;
  };
}

interface CommentCheckerOutput {
  comments?: Array<{
    file: string;
    line: number;
    text: string;
  }>;
}

interface BinaryStatus {
  found: boolean;
  path: string;
  source: "sibling" | "global" | "path" | "not-found";
}

/** Timeout for comment-checker binary execution (ms) */
const BINARY_TIMEOUT_MS = 30000;

/**
 * Returns an array of candidate binary paths to search for the comment-checker,
 * ordered by search priority: sibling projects, user-local installs, system paths.
 * @returns Array of path candidates with their source classification
 */
function getBinaryCandidates(): Array<{ path: string; source: BinaryStatus["source"] }> {
  return [
    // Sibling project (where go-claude-code-comment-checker was cloned)
    {
      path: resolve(process.cwd(), "../go-claude-code-comment-checker/comment-checker"),
      source: "sibling" as const,
    },
    {
      path: resolve(process.cwd(), "../../go-claude-code-comment-checker/comment-checker"),
      source: "sibling" as const,
    },
    // User-local install locations (preferred over system) - only add if HOME is defined
    ...(process.env.HOME ? [
      { path: `${process.env.HOME}/.local/bin/comment-checker`, source: "global" as const },
      { path: `${process.env.HOME}/go/bin/comment-checker`, source: "global" as const },
    ] : []),
    // System install locations
    { path: "/usr/local/bin/comment-checker", source: "global" as const },
    { path: "/usr/bin/comment-checker", source: "global" as const },
    // Will try PATH lookup
    { path: "comment-checker", source: "path" as const },
  ];
}

/**
 * Searches for the comment-checker binary in common locations.
 * Checks sibling project directories, user-local paths, system paths, and PATH environment.
 * @returns BinaryStatus indicating if found, the full path, and source location
 */
function findBinary(): BinaryStatus {
  const candidates = getBinaryCandidates();

  for (const { path, source } of candidates) {
    // For PATH source, manually search through PATH directories
    if (source === "path" && process.env.PATH) {
      const pathDirs = process.env.PATH.split(delimiter);
      for (const dir of pathDirs) {
        const fullPath = resolve(dir, path);
        try {
          accessSync(fullPath, constants.X_OK);
          if (statSync(fullPath).isFile()) {
            return { found: true, path: fullPath, source };
          }
        } catch {
          continue;
        }
      }
    } else {
      try {
        accessSync(path, constants.X_OK);
        if (statSync(path).isFile()) {
          return { found: true, path, source };
        }
      } catch {
        continue;
      }
    }
  }

  return { found: false, path: "comment-checker", source: "not-found" };
}

/**
 * Executes the comment-checker binary with the given input and returns parsed output.
 * Handles timeout protection (30s), graceful degradation on errors, and process cleanup.
 * @param input - The comment checker input data with tool name, file path, and content
 * @param binaryPath - Full path to the comment-checker binary
 * @param debugLog - Debug logging function for troubleshooting
 * @returns Promise resolving to parsed output or null on error/timeout/no comments
 */
async function runCommentChecker(
  input: CommentCheckerInput,
  binaryPath: string,
  debugLog: (...args: unknown[]) => void,
): Promise<CommentCheckerOutput | null> {
  return new Promise((resolve) => {
    const child = spawn(binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Set up timeout to prevent zombie processes
    let timeout: NodeJS.Timeout | null = null;
    let graceKillTimer: NodeJS.Timeout | null = null;
    let resolved = false;

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (graceKillTimer) {
        clearTimeout(graceKillTimer);
        graceKillTimer = null;
      }
    };

    const resolveOnce = (value: CommentCheckerOutput | null) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(value);
      }
    };

    timeout = setTimeout(() => {
      timedOut = true;
      debugLog(`Binary timed out after ${BINARY_TIMEOUT_MS}ms, killing process`);
      child.kill("SIGTERM");

      // Grace period: SIGKILL if process hasn't exited
      graceKillTimer = setTimeout(() => {
        debugLog("Process still running after SIGTERM, sending SIGKILL");
        child.kill("SIGKILL");
      }, 5000);
    }, BINARY_TIMEOUT_MS);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code: number | null) => {
      cleanup();

      // Exit codes:
      // 0 = pass (no problematic comments or not a code file)
      // 2 = block (problematic comments detected)
      // 1 or other = error (binary issue, parsing error, invalid input)
      if (code === 0) {
        resolveOnce(null);
      } else if (code === 2) {
        const comments = parseCommentOutput(stderr + '\n' + stdout);
        if (!comments || comments.length === 0) {
          debugLog('Comment-checker returned exit code 2 but with no comments, treating as fail');
          resolveOnce(null);
        } else {
          resolveOnce({ comments });
        }
      } else {
        // Binary error - log when debug enabled, treat as pass (graceful degradation)
        if (!timedOut) {
          debugLog(`Binary exited with code ${code} (treating as pass): ${stderr || stdout}`);
        }
        resolveOnce(null);
      }
    });

    child.on("error", (err: Error) => {
      cleanup();
      debugLog(`Failed to spawn binary: ${err.message}`);
      resolveOnce(null);
    });

    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
  });
}

/**
 * Parses XML-like output from the comment-checker binary into structured comment data.
 * Extracts file path from comments element and line numbers/text from comment elements.
 * @param output - Raw stdout/stderr output from the comment-checker binary
 * @returns Array of parsed comments with file path, line number, and comment text
 */
export function parseCommentOutput(output: string): Array<{ file: string; line: number; text: string }> {
  const comments: Array<{ file: string; line: number; text: string }> = [];

  // Parse XML-like output: <comments file="..."><comment line-number="...">text</comment></comments>
  // Uses lazy matching for comment text to handle nested content
  const commentRegex = /<comment\s+line-number="(\d+)">([^]*?)<\/comment>/g;
  const fileRegex = /<comments[^>]*\s+file="([^"]*)"/;

  const fileMatch = output.match(fileRegex);
  const file = fileMatch ? fileMatch[1] : "unknown";

  let match;
  while ((match = commentRegex.exec(output)) !== null) {
    const lineNum = parseInt(match[1], 10);
    // Skip invalid line numbers
    if (isNaN(lineNum) || lineNum < 1) {
      continue;
    }
    comments.push({
      file,
      line: lineNum,
      text: match[2].trim(),
    });
  }

  return comments;
}

/**
 * Safely extracts a string argument from an object, returning undefined if not a string.
 * @param name - Property name to extract from args
 * @param args - Object containing potential arguments
 * @returns The string value if present and valid, otherwise undefined
 */
export function getStringArg(name: string, args: Record<string, unknown>): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Extracts a file path from tool arguments, checking multiple possible key names.
 * Priority: filePath > file_path > path (handles both camelCase and snake_case)
 * @param args - Tool input arguments object
 * @returns The file path string if found, otherwise undefined
 */
export function extractFilePath(args: Record<string, unknown>): string | undefined {
  return getStringArg("filePath", args) ?? getStringArg("file_path", args) ?? getStringArg("path", args);
}

/**
 * Type guard to validate that an object is a valid edit with required string properties.
 * @param edit - Value to validate as an edit object
 * @returns True if edit has both old_string and new_string as strings
 */
export function isValidEdit(
  edit: unknown,
): edit is { old_string: string; new_string: string } {
  if (typeof edit !== "object" || edit === null) return false;
  const e = edit as Record<string, unknown>;
  return typeof e.old_string === "string" && typeof e.new_string === "string";
}

/**
 * Builds the input structure for the comment-checker binary based on tool name and arguments.
 * Supports write, edit, and multiedit tools with appropriate field mapping.
 * @param toolName - Name of the Pi tool (write, edit, or multiedit)
 * @param args - Tool input arguments containing file path and content/edit data
 * @returns Structured input for comment-checker, or null if input is invalid
 */
export function buildCheckerInput(
  toolName: string,
  args: Record<string, unknown>,
): CommentCheckerInput | null {
  const filePath = extractFilePath(args);
  if (!filePath) return null;

  const toolInput: CommentCheckerInput["tool_input"] = {
    file_path: filePath,
  };

  if (toolName === "write") {
    const content = getStringArg("content", args);
    if (content === undefined) {
      return null;
    }
    toolInput.content = content;
  } else if (toolName === "edit") {
    const newStr = getStringArg("newString", args) ?? getStringArg("new_string", args);
    const oldStr = getStringArg("oldString", args) ?? getStringArg("old_string", args);
    // Validate strings exist before passing
    if (newStr === undefined || oldStr === undefined) {
      return null;
    }
    toolInput.new_string = newStr;
    toolInput.old_string = oldStr;
  } else if (toolName === "multiedit") {
    const edits = args.edits;
    if (!Array.isArray(edits)) {
      return null;
    }
    // Validate each edit has required properties
    if (!edits.every(isValidEdit)) {
      return null;
    }
    toolInput.edits = edits;
  }

  return {
    tool_name: toolName,
    file_path: filePath,
    tool_input: toolInput,
  };
}

/**
 * Type guard to validate file change metadata from apply_patch tool results.
 * Checks for required filePath and after properties, with optional movePath.
 * @param file - Value to validate as a file change object
 * @returns True if file has valid structure for comment checking
 */
export function isValidFileChange(
  file: unknown,
): file is { filePath: string; movePath?: string; after: string } {
  if (typeof file !== "object" || file === null) return false;
  const f = file as Record<string, unknown>;
  return (
    typeof f.filePath === "string" &&
    typeof f.after === "string" &&
    (f.movePath === undefined || typeof f.movePath === "string")
  );
}

/**
 * Pi extension entry point that registers event handlers to intercept and validate file modifications.
 * Hooks into write, edit, multiedit, and apply_patch tools to check for AI-generated comments.
 * Provides a /check-comments command for binary status verification and setup help.
 * @param pi - The Pi ExtensionAPI for registering handlers and commands
 */
export default function commentCheckerExtension(pi: ExtensionAPI) {
  const DEBUG = process.env.PI_COMMENT_CHECKER_DEBUG === "1";
  let warnedMissing = false;

  function debug(...args: unknown[]) {
    if (DEBUG) {
      console.error("[comment-checker]", ...args);
    }
  }

  function warnOnce(
    ctx: {
      ui: { notify: (msg: string, type: "warning" | "error" | "info") => void };
    },
    status: BinaryStatus,
  ) {
    if (!status.found && !warnedMissing) {
      warnedMissing = true;
      ctx.ui.notify(
        "comment-checker: Binary not found. Run /check-comments for setup help.",
        "warning",
      );
    }
  }

  // Check regular write/edit/multiedit tools
  pi.on("tool_result", async (event, ctx) => {
    const toolName = event.toolName.toLowerCase();

    // Only check file modification tools
    if (!["write", "edit", "multiedit"].includes(toolName)) {
      return;
    }

    // Skip if tool errored
    if (event.isError) {
      return;
    }

    // Warn if binary not found (once per session)
    const status = findBinary();
    warnOnce(ctx, status);

    if (!status.found) {
      debug(`Skipping check: binary not found (${toolName})`);
      return;
    }

    const checkerInput = buildCheckerInput(toolName, event.input);
    if (!checkerInput) {
      debug(`Skipping check: could not build checker input for ${toolName}`);
      return;
    }

    debug(`Checking ${toolName} on ${checkerInput.file_path}`);

    const result = await runCommentChecker(checkerInput, status.path, debug);

    if (result?.comments && result.comments.length > 0) {
      const commentList = result.comments.map((c) => `  Line ${c.line}: ${c.text}`).join("\n");

      const message = `
⚠️  AI Comment Detected — Self-Documenting Code Required

File: ${checkerInput.file_path}

${commentList}

These comments violate the self-documenting code principle.
Remove them and improve your code to be self-explanatory:
- Use meaningful variable/function names
- Extract functions instead of explaining with comments
- Let the code speak for itself

Allowed exceptions: BDD (given/when/then), linter directives (@ts-ignore, eslint-disable), shebangs
`;

      // Notify user
      ctx.ui.notify("AI comment detected — see tool output", "warning");

      // Modify result to show warning
      return {
        content: [...(event.content || []), { type: "text", text: message }],
        isError: true,
      };
    }
  });

  // Handle apply_patch separately since it has different structure
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName.toLowerCase() !== "apply_patch") {
      return;
    }

    // Skip if tool errored
    if (event.isError) {
      return;
    }

    // Warn if binary not found (once per session)
    const status = findBinary();
    warnOnce(ctx, status);

    if (!status.found) {
      debug("Skipping apply_patch check: binary not found");
      return;
    }

    // apply_patch metadata contains the file changes
    const metadata = (event.details as { metadata?: { files?: unknown[] } } | undefined)?.metadata;
    if (!metadata?.files || !Array.isArray(metadata.files)) {
      return;
    }

    // Validate each file entry has required properties
    const validFiles = metadata.files.filter(isValidFileChange);
    if (validFiles.length === 0) {
      debug("No valid file changes found in apply_patch metadata");
      return;
    }

    const allComments: Array<{ file: string; line: number; text: string }> = [];

    for (const file of validFiles) {
      // Skip deleted files
      if (!file.after) continue;

      const checkerInput: CommentCheckerInput = {
        tool_name: "write",
        file_path: file.movePath ?? file.filePath,
        tool_input: {
          file_path: file.movePath ?? file.filePath,
          content: file.after,
        },
      };

      const result = await runCommentChecker(checkerInput, status.path, debug);
      if (result?.comments) {
        allComments.push(...result.comments);
      }
    }

    if (allComments.length > 0) {
      const commentList = allComments.map((c) => `  ${c.file}:${c.line}: ${c.text}`).join("\n");

      const message = `
⚠️  AI Comment Detected — Self-Documenting Code Required

${commentList}

These comments violate the self-documenting code principle.
Remove them and improve your code to be self-explanatory:
- Use meaningful variable/function names
- Extract functions instead of explaining with comments
- Let the code speak for itself

Allowed exceptions: BDD (given/when/then), linter directives (@ts-ignore, eslint-disable), shebangs
`;

      ctx.ui.notify("AI comment detected in apply_patch — see tool output", "warning");

      return {
        content: [...(event.content || []), { type: "text", text: message }],
        isError: true,
      };
    }
  });

  // Register a command to check binary status
  pi.registerCommand("check-comments", {
    description: "Check comment-checker status and binary location",
    handler: async (_args, ctx) => {
      const status = findBinary();

      if (!status.found) {
        const help = `Binary not found. Searched:
${getBinaryCandidates().map((c) => `  - ${c.path}`).join("\n")}

To install the comment-checker binary:

**Recommended (single command):**
   go install github.com/code-yeongyu/go-claude-code-comment-checker/cmd/comment-checker@latest

**Alternative methods:**

Homebrew (macOS/Linux):
   brew tap code-yeongyu/tap
   brew install comment-checker

Build from source:
   git clone https://github.com/code-yeongyu/go-claude-code-comment-checker.git
   cd go-claude-code-comment-checker
   go build -o comment-checker ./cmd/comment-checker
   mv comment-checker ~/.local/bin/

Download prebuilt:
   https://github.com/code-yeongyu/go-claude-code-comment-checker/releases
`;
        ctx.ui.notify("comment-checker: Binary not found — check console for help", "error");
        console.error(help);
        return;
      }

      ctx.ui.notify(`comment-checker: ${status.path} (${status.source})`, "info");
    },
  });

  const initialStatus = findBinary();
  debug(
    `Extension loaded. Binary: ${initialStatus.found ? "found" : "not found"} (${initialStatus.path})`,
  );
}
