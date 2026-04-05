import type { ExtensionAPI, ToolResult } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";

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

function getBinaryCandidates(): Array<{ path: string; source: BinaryStatus["source"] }> {
  return [
    // Sibling project (where go-claude-code-comment-checker was cloned)
    { path: resolve(process.cwd(), "../go-claude-code-comment-checker/comment-checker"), source: "sibling" as const },
    { path: resolve(process.cwd(), "../../go-claude-code-comment-checker/comment-checker"), source: "sibling" as const },
    // Global install locations
    { path: "/usr/local/bin/comment-checker", source: "global" as const },
    { path: "/usr/bin/comment-checker", source: "global" as const },
    { path: `${process.env.HOME}/.local/bin/comment-checker`, source: "global" as const },
    { path: `${process.env.HOME}/go/bin/comment-checker`, source: "global" as const },
    // Will try PATH lookup
    { path: "comment-checker", source: "path" as const },
  ];
}

function findBinary(): BinaryStatus {
  const candidates = getBinaryCandidates();

  for (const { path, source } of candidates) {
    try {
      accessSync(path, constants.X_OK);
      return { found: true, path, source };
    } catch {
      continue;
    }
  }

  return { found: false, path: "comment-checker", source: "not-found" };
}

function formatBinaryStatus(status: BinaryStatus): string {
  if (status.found) {
    return `✓ Binary found (${status.source}): ${status.path}`;
  }
  return `✗ Binary not found. Searched:\n${getBinaryCandidates()
    .map((c) => `  - ${c.path}`)
    .join("\n")}`;
}

async function runCommentChecker(
  input: CommentCheckerInput,
  binaryPath: string,
): Promise<CommentCheckerOutput | null> {
  return new Promise((resolve) => {
    const child = spawn(binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      // Exit codes:
      // 0 = pass (no problematic comments or not a code file)
      // 2 = block (problematic comments detected)
      // other = error (binary issue, parsing error, etc.)
      if (code === 0) {
        resolve(null);
      } else if (code === 2) {
        const comments = parseCommentOutput(stderr || stdout);
        resolve({ comments });
      } else {
        // Binary error - treat as pass (graceful degradation)
        resolve(null);
      }
    });

    child.on("error", () => {
      // Binary not found or spawn failed - treat as pass
      resolve(null);
    });

    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
  });
}

function parseCommentOutput(output: string): Array<{ file: string; line: number; text: string }> {
  const comments: Array<{ file: string; line: number; text: string }> = [];

  const commentRegex = /<comment line-number="(\d+)">([^<]+)<\/comment>/g;
  const fileMatch = output.match(/file="([^"]+)"/);
  const file = fileMatch ? fileMatch[1] : "unknown";

  let match;
  while ((match = commentRegex.exec(output)) !== null) {
    comments.push({
      file,
      line: parseInt(match[1], 10),
      text: match[2].trim(),
    });
  }

  return comments;
}

function extractFilePath(args: Record<string, unknown>): string | undefined {
  return (
    (args.filePath as string) ??
    (args.file_path as string) ??
    (args.path as string)
  );
}

function buildCheckerInput(
  toolName: string,
  args: Record<string, unknown>,
): CommentCheckerInput | null {
  const filePath = extractFilePath(args);
  if (!filePath) return null;

  const toolInput: CommentCheckerInput["tool_input"] = {
    file_path: filePath,
  };

  if (toolName === "write") {
    toolInput.content = (args.content as string) ?? "";
  } else if (toolName === "edit") {
    toolInput.new_string = (args.newString ?? args.new_string) as string;
    toolInput.old_string = (args.oldString ?? args.old_string) as string;
  } else if (toolName === "multiedit") {
    toolInput.edits = (args.edits as Array<{ old_string: string; new_string: string }>) ?? [];
  }

  return {
    tool_name: toolName,
    file_path: filePath,
    tool_input: toolInput,
  };
}

export default function commentCheckerExtension(pi: ExtensionAPI) {
  const DEBUG = process.env.PI_COMMENT_CHECKER_DEBUG === "1";
  const binaryStatus = findBinary();
  let warnedMissing = false;

  function debug(...args: unknown[]) {
    if (DEBUG) {
      console.error("[comment-checker]", ...args);
    }
  }

  function warnOnce(ctx: { ui: { notify: (msg: string, type: "warning" | "error" | "info") => void } }) {
    if (!binaryStatus.found && !warnedMissing) {
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
    warnOnce(ctx);

    if (!binaryStatus.found) {
      debug(`Skipping check: binary not found (${toolName})`);
      return;
    }

    const checkerInput = buildCheckerInput(toolName, event.input);
    if (!checkerInput) {
      return;
    }

    debug(`Checking ${toolName} on ${checkerInput.file_path}`);

    const result = await runCommentChecker(checkerInput, binaryStatus.path);

    if (result?.comments && result.comments.length > 0) {
      const commentList = result.comments
        .map((c) => `  Line ${c.line}: ${c.text}`)
        .join("\n");

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
        content: [
          ...(event.content || []),
          { type: "text", text: message },
        ],
        isError: true,
      };
    }
  });

  // Handle apply_patch separately since it has different structure
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName.toLowerCase() !== "apply_patch") {
      return;
    }

    // Warn if binary not found (once per session)
    warnOnce(ctx);

    if (!binaryStatus.found) {
      debug("Skipping apply_patch check: binary not found");
      return;
    }

    // apply_patch metadata contains the file changes
    const metadata = event.details?.metadata;
    if (!metadata?.files || !Array.isArray(metadata.files)) {
      return;
    }

    const files: Array<{
      filePath: string;
      movePath?: string;
      before: string;
      after: string;
    }> = metadata.files;

    const allComments: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
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

      const result = await runCommentChecker(checkerInput, binaryStatus.path);
      if (result?.comments) {
        allComments.push(...result.comments);
      }
    }

    if (allComments.length > 0) {
      const commentList = allComments
        .map((c) => `  ${c.file}:${c.line}: ${c.text}`)
        .join("\n");

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
        content: [
          ...(event.content || []),
          { type: "text", text: message },
        ],
        isError: true,
      };
    }
  });

  // Register a command to check binary status
  pi.registerCommand("check-comments", {
    description: "Check comment-checker status and binary location",
    handler: async (_args, ctx) => {
      const status = binaryStatus;
      const message = formatBinaryStatus(status);

      if (!status.found) {
        const help = `
${message}

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
        ctx.ui.notify("comment-checker: Binary not found — see output for help", "error");
        return {
          content: [{ type: "text", text: help }],
          isError: false,
        };
      }

      ctx.ui.notify(`comment-checker: ${status.path} (${status.source})`, "info");
      return {
        content: [{ type: "text", text: message }],
        isError: false,
      };
    },
  });

  debug(`Extension loaded. Binary: ${binaryStatus.found ? "found" : "not found"} (${binaryStatus.path})`);
}
