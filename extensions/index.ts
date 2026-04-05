import type { ExtensionAPI, ToolResult } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
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

function getCommentCheckerPath(): string {
  // Look for binary in common locations
  const paths = [
    // Sibling project (where go-claude-code-comment-checker was cloned)
    resolve(process.cwd(), "../go-claude-code-comment-checker/comment-checker"),
    resolve(process.cwd(), "../../go-claude-code-comment-checker/comment-checker"),
    // Global install locations
    "/usr/local/bin/comment-checker",
    "/usr/bin/comment-checker",
    `${process.env.HOME}/.local/bin/comment-checker`,
    `${process.env.HOME}/go/bin/comment-checker`,
  ];

  for (const path of paths) {
    try {
      // Check if file exists and is executable
      const { accessSync, constants } = require("node:fs");
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      continue;
    }
  }

  // Fallback: try to find in PATH
  return "comment-checker";
}

async function runCommentChecker(input: CommentCheckerInput): Promise<CommentCheckerOutput | null> {
  const binaryPath = getCommentCheckerPath();

  return new Promise((resolve, reject) => {
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
      // Exit code 0: pass (no problematic comments)
      // Exit code 2: block (problematic comments detected)
      if (code === 0) {
        resolve(null);
      } else if (code === 2) {
        // Parse XML output for comments
        const comments = parseCommentOutput(stderr || stdout);
        resolve({ comments });
      } else {
        // Binary not found or other error - silently skip
        resolve(null);
      }
    });

    child.on("error", () => {
      // Binary not found or failed to spawn - silently skip
      resolve(null);
    });

    // Send input to checker
    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
  });
}

function parseCommentOutput(output: string): Array<{ file: string; line: number; text: string }> {
  const comments: Array<{ file: string; line: number; text: string }> = [];

  // Parse XML-like output: <comments file="..."><comment line-number="...">text</comment></comments>
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

  function debug(...args: unknown[]) {
    if (DEBUG) {
      console.error("[comment-checker]", ...args);
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

    const checkerInput = buildCheckerInput(toolName, event.input);
    if (!checkerInput) {
      return;
    }

    debug(`Checking ${toolName} on ${checkerInput.file_path}`);

    const result = await runCommentChecker(checkerInput);

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
        isError: true, // Mark as error to get attention
      };
    }
  });

  // Handle apply_patch separately since it has different structure
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName.toLowerCase() !== "apply_patch") {
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

      const result = await runCommentChecker(checkerInput);
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

  // Register a command to check current file
  pi.registerCommand("check-comments", {
    description: "Check current file for unnecessary comments",
    handler: async (_args, ctx) => {
      // This would need access to the last tool result or current file
      // For now, just show status
      ctx.ui.notify("comment-checker: watching write/edit/multiedit/apply_patch tools", "info");
    },
  });

  debug("comment-checker extension loaded");
}
