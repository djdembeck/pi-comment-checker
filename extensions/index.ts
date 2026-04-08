import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";

import { dirname, delimiter, extname, join, parse, resolve } from "node:path";

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
 * @param debugLog - Debug logging function for troubleshooting
 */
async function runCommentChecker(
  input: CommentCheckerInput,
  binaryPath: string,
  debugLog: (...args: unknown[]) => void,
): Promise<{ status: "ok"; result: CommentCheckerOutput; source: "clean" | "with-comments" } | { status: "error"; error: Error | string }> {
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

    const resolveOnce = (value: { status: "ok"; result: CommentCheckerOutput; source: "clean" | "with-comments" } | { status: "error"; error: Error | string }) => {
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
        resolveOnce({ status: "ok", result: { comments: [] }, source: "clean" });
      } else if (code === 2) {
        const comments = parseCommentOutput(stderr + '\n' + stdout);
        if (!comments || comments.length === 0) {
          debugLog('Comment-checker returned exit code 2 but with no comments, treating as fail');
          resolveOnce({
            status: "error",
            error: new Error(`comment-checker exit code 2 with no parsed comments (possible blocked file or parsing issue). stderr: ${stderr}, stdout: ${stdout}`),
          });
        } else {
          resolveOnce({ status: "ok", result: { comments }, source: "with-comments" });
        }
      } else {
        // Binary error - log when debug enabled, treat as pass (graceful degradation)
        if (!timedOut) {
          debugLog(`Binary exited with code ${code} (treating as pass): ${stderr || stdout}`);
        }
        resolveOnce({ status: "error", error: `Binary exited with code ${code}` });
      }
    });

    child.on("error", (err: Error) => {
      cleanup();
      debugLog(`Failed to spawn binary: ${err.message}`);
      resolveOnce({ status: "error", error: err });
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

function printCommentsByFile(
  comments: Array<{ file: string; line: number; text: string }>
): void {
  const byFile = new Map<string, Array<{ line: number; text: string }>>();
  for (const comment of comments) {
    const existing = byFile.get(comment.file) ?? [];
    existing.push({ line: comment.line, text: comment.text });
    byFile.set(comment.file, existing);
  }
  for (const [file, fileComments] of byFile) {
    console.log(`\n${file}`);
    for (const c of fileComments) {
      console.log(`  Line ${c.line}: ${c.text}`);
    }
  }
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
 * Common source code file extensions to check for comments.
 */
const SOURCE_EXTENSIONS = new Set([
  // JavaScript/TypeScript
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  // Python
  ".py", ".pyw",
  // Go
  ".go",
  // Rust
  ".rs",
  // Java/Kotlin
  ".java", ".kt", ".kts",
  // C/C++
  ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx",
  // Ruby
  ".rb", ".rake",
  // PHP
  ".php",
  // Swift/Objective-C
  ".swift", ".m", ".mm",
  // C#
  ".cs",
  // Scala
  ".scala", ".sc",
  // Shell scripts
  ".sh", ".bash", ".zsh",
  // Other common languages
  ".lua", ".r", ".rkt", ".clj", ".ex", ".exs", ".erl", ".hs", ".ml", ".fs", ".vb",
]);

/**
 * Directories to always skip when scanning for source files.
 */
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
]);

/**
 * Parsed gitignore pattern.
 */
interface GitignorePattern {
  pattern: string;
  negation: boolean;
  directoryOnly: boolean;
  anchored: boolean;
  regex: RegExp;
  sourceDir: string;
}

/**
 * Parses a .gitignore file and returns an array of patterns.
 * @param gitignorePath - Path to the .gitignore file
 * @returns Array of parsed patterns, or null if file not found/readable
 */
function parseGitignore(gitignorePath: string): GitignorePattern[] | null {
  try {
    const content = readFileSync(gitignorePath, "utf-8");
    const patterns: GitignorePattern[] = [];

    for (const line of content.split("\n")) {
      // Trim and skip empty lines and comments
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const pattern = parseGitignorePattern(trimmed, dirname(gitignorePath));
      if (pattern) {
        patterns.push(pattern);
      }
    }

    return patterns.length > 0 ? patterns : null;
  } catch {
    return null;
  }
}

/**
 * Parses a single gitignore pattern line into a structured format.
 * @param line - Single line from .gitignore
 * @returns Parsed pattern or null if invalid
 */
export function parseGitignorePattern(line: string, sourceDir: string = ""): GitignorePattern | null {
  let pattern = line;
  const negation = pattern.startsWith("!");
  if (negation) {
    pattern = pattern.slice(1);
  }

  // Directory-only pattern (trailing slash)
  const directoryOnly = pattern.endsWith("/");
  if (directoryOnly) {
    pattern = pattern.slice(0, -1);
  }

  // Anchored pattern (starts with /)
  const anchored = pattern.startsWith("/");
  if (anchored) {
    pattern = pattern.slice(1);
  }

  // Convert glob pattern to regex
  const regex = globToRegex(pattern, anchored, directoryOnly);

  return {
    pattern: line,
    negation,
    directoryOnly,
    anchored,
    regex,
    sourceDir,
  };
}

/**
 * Converts a gitignore glob pattern to a RegExp.
 * Handles: *, **, ?, character classes, and common patterns.
 * @param glob - Glob pattern (without leading ! or trailing /)
 * @param anchored - Whether pattern is anchored to root
 * @param directoryOnly - Whether pattern should only match directories
 * @returns RegExp for matching
 */
function globToRegex(glob: string, anchored: boolean, directoryOnly: boolean): RegExp {
  // For non-anchored patterns without slashes, prepend **/ to match at any depth
  // But for patterns containing slashes (like "src/dist"), keep them relative
  // so they don't over-broadly match nested paths
  const needsPrefix = !anchored && !glob.includes("/");
  const prefix = needsPrefix ? "**/" : "";
  const pattern = prefix + glob;

  // Convert glob to regex
  let regexStr = "^";
  let i = 0;

  while (i < pattern.length) {
    const c = pattern[i];

    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches any number of directories
        // **/ matches one or more directory levels
        if (pattern[i + 2] === "/") {
          regexStr += "(?:.*/)?";
          i += 3;
        } else {
          regexStr += ".*";
          i += 2;
        }
      } else {
        // * matches anything except /
        regexStr += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      // ? matches any single character except /
      regexStr += "[^/]";
      i++;
    } else if (c === "[") {
      // Character class [abc] or [!abc]
      // Special case: []] means match the character "]"
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        // Unclosed bracket, treat literally
        regexStr += "\\[";
        i++;
      } else {
        // Check if this is the special case []] where ] is first char in class
        // In gitignore, []] means "match the ] character"
        if (close === i + 1 && pattern[i + 1] === "]") {
          // Pattern is []] - match literal ]
          // Skip both the first ] and the second ]
          regexStr += "[\\]]";
          i = close + 2;
        } else {
          const content = pattern.slice(i + 1, close);
          if (content.startsWith("!")) {
            // Negated character class [!abc]
            regexStr += "[^" + content.slice(1) + "]";
          } else {
            regexStr += "[" + content + "]";
          }
          i = close + 1;
        }
      }
    } else if (c === "." || c === "+" || c === "(" || c === ")" || c === "|" || c === "^" || c === "$") {
      // Escape regex metacharacters
      regexStr += "\\" + c;
      i++;
    } else {
      regexStr += c;
      i++;
    }
  }

  // For directory patterns, allow matching the directory itself and its contents
  if (directoryOnly) {
    regexStr += "(?:/.*)?";
  }

  regexStr += "$";

  try {
    return new RegExp(regexStr);
  } catch {
    // Fallback: match nothing if pattern is invalid
    return /(?!)/;
  }
}

/**
 * Checks if a path is ignored by gitignore patterns.
 * Each pattern is matched relative to its own sourceDir (where the .gitignore file lives).
 * @param fullPath - Absolute path of the file/directory being checked
 * @param basePath - Base directory for computing relative paths
 * @param isDirectory - Whether the path is a directory
 * @param patterns - Array of gitignore patterns
 * @returns True if path should be ignored
 */
export function isIgnoredByGitignore(
  fullPath: string,
  basePath: string,
  isDirectory: boolean,
  patterns: GitignorePattern[],
): boolean {
  let ignored = false;

  for (const pattern of patterns) {
    // Skip directory-only patterns for files
    if (pattern.directoryOnly && !isDirectory) {
      continue;
    }

    // Compute relative path from pattern's source directory
    const sourceDir = pattern.sourceDir || basePath;
    let relativePath: string;
    // If fullPath starts with sourceDir (or sourceDir is empty), compute relative path
    if (sourceDir === "" || fullPath.startsWith(sourceDir)) {
      const sliceStart = sourceDir.length;
      relativePath = fullPath.slice(sliceStart).replace(/\\/g, "/");
      // Remove leading slash and ./ prefix
      if (relativePath.startsWith("/") || relativePath.startsWith("./")) {
        relativePath = relativePath.replace(/^\.?\//, "");
      }
    } else {
      relativePath = fullPath;
    }

    // For anchored patterns, only apply if we're checking within the same directory as the .gitignore
    // The relativePath calculation (slice from sourceDir) already ensures this
    if (pattern.anchored && !fullPath.startsWith(sourceDir)) {
      continue;
    }

    const matches = pattern.regex.test(relativePath);

    if (matches) {
      ignored = !pattern.negation;
    }
  }

  return ignored;
}

/**
 * Finds the .gitignore file by walking up from the given directory.
 * Stops at the first .git directory found (project root).
 * @param startDir - Directory to start searching from
 * @returns Path to .gitignore, or null if not found
 */
function findGitignore(startDir: string): string | null {
  let current = startDir;
  const root = parse(startDir).root;

  while (current !== root) {
    const gitignorePath = join(current, ".gitignore");
    const gitPath = join(current, ".git");

    // Check if .gitignore exists
    try {
      statSync(gitignorePath);
      return gitignorePath;
    } catch {
      // .gitignore doesn't exist, continue
    }

    // Check if we've reached the git root
    try {
      statSync(gitPath);
      // Found .git but no .gitignore, stop here
      return null;
    } catch {
      // Not a git directory, continue up
    }

    current = resolve(current, "..");
  }

  return null;
}

/**
 * Finds all .gitignore files by walking up from the given directory to the repo root.
 * Collects and merges all applicable .gitignore files for hierarchical rule application.
 * @param startDir - Directory to start searching from
 * @returns Array of { path, patterns } for each .gitignore found (closest first)
 */
function findGitignoreAncestors(startDir: string): Array<{ path: string; patterns: GitignorePattern[] }> {
  const result: Array<{ path: string; patterns: GitignorePattern[] }> = [];
  let current = startDir;
  const root = parse(startDir).root;

  while (current !== root) {
    const gitignorePath = join(current, ".gitignore");
    const gitPath = join(current, ".git");

    // Check if .gitignore exists
    try {
      statSync(gitignorePath);
      const patterns = parseGitignore(gitignorePath);
      if (patterns) {
        // Insert at beginning so closest (most specific) patterns are first
        result.unshift({ path: gitignorePath, patterns });
      }
    } catch {
      // .gitignore doesn't exist, continue
    }

    // Check if we've reached the git root
    try {
      statSync(gitPath);
      // Found .git, stop here
      break;
    } catch {
      // Not a git directory, continue up
    }

    current = resolve(current, "..");
  }

  return result;
}

/**
 * Merges multiple gitignore pattern arrays, with later patterns (more specific) taking precedence.
 * Negation patterns are evaluated in order across all pattern sets.
 * @param patternSets - Array of pattern arrays from multiple .gitignore files (root to leaf order)
 * @returns Combined array of all patterns in evaluation order
 */
function mergeGitignorePatterns(patternSets: GitignorePattern[][]): GitignorePattern[] {
  // Flatten all patterns - earlier sets (more root-level) come first,
  // so later patterns (more specific/closer to target) naturally override
  return patternSets.flat();
}

/**
 * Wraps an error with context for better error messages.
 * @param err - The error to wrap
 * @param context - Contextual information to add to the error message
 * @returns Error with context
 */
function wrapWithContext(err: unknown, context: string): Error | string {
  if (err instanceof Error) {
    return new Error(`${context}: ${err.message}`);
  }
  return `${context}: ${err}`;
}

/**
 * Checks if a file path has a source code extension.
 * @param filePath - Path to check
 * @returns True if the file is a source code file
 */
function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/**
 * Recursively discovers source files in a directory.
 * Skips common non-source directories like node_modules, .git, etc.
 * @param dir - Directory to scan
 * @param basePath - Base path for relative path calculation
 * @param gitignorePatterns - Optional gitignore patterns to respect
 * @param debugLog - Optional debug logging function
 * @returns Array of absolute paths to source files
 */
export function discoverSourceFiles(
  dir: string,
  basePath: string = dir,
  gitignorePatterns?: GitignorePattern[] | null,
  debugLog?: (...args: unknown[]) => void,
): { files: string[]; errors: Array<{ path: string; error: Error | string }> } {
  const files: string[] = [];
  const errors: Array<{ path: string; error: Error | string }> = [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = fullPath.startsWith(basePath)
        ? fullPath.slice(basePath.length).replace(/\\/g, "/").replace(/^\//, "")
        : fullPath;

      if (entry.isDirectory()) {
        // Skip VCS directories always
        if (SKIP_DIRECTORIES.has(entry.name)) {
          continue;
        }

        // Skip symlinks to avoid circular references
        if (entry.isSymbolicLink()) {
          continue;
        }

        // Check gitignore
        if (gitignorePatterns && isIgnoredByGitignore(fullPath, basePath, true, gitignorePatterns)) {
          debugLog?.(`Skipping (gitignore): ${relativePath}`);
          continue;
        }

        const subResult = discoverSourceFiles(fullPath, basePath, gitignorePatterns, debugLog);
        files.push(...subResult.files);
        errors.push(...subResult.errors);
      } else if (entry.isFile() && isSourceFile(entry.name)) {
        // Check gitignore for files
        if (gitignorePatterns && isIgnoredByGitignore(fullPath, basePath, false, gitignorePatterns)) {
          debugLog?.(`Skipping (gitignore): ${relativePath}`);
          continue;
        }
        files.push(fullPath);
      }
    }
  } catch (err) {
    // Surface directory traversal errors with context instead of silently dropping
    const errorContext = wrapWithContext(err, `Failed to read directory ${dir}`);
    errors.push({ path: dir, error: errorContext });
    debugLog?.(`Directory traversal error: ${errorContext instanceof Error ? errorContext.message : errorContext}`);
  }

  return { files, errors };
}

/**
 * Reads a file and checks it for problematic comments.
 * @param filePath - Absolute path to the file
 * @param binaryPath - Path to the comment-checker binary
 * @param debugLog - Debug logging function
 * @returns Object with status and comments, or error
 */
async function checkFileForComments(
  filePath: string,
  binaryPath: string,
  debugLog: (...args: unknown[]) => void,
): Promise<{
  status: "ok";
  comments: Array<{ file: string; line: number; text: string }>;
} | {
  status: "failed";
  error: Error | string;
}> {
  try {
    const content = readFileSync(filePath, "utf-8");
    if (!content.trim()) {
      return { status: "ok", comments: [] };
    }

    const checkerInput: CommentCheckerInput = {
      tool_name: "write",
      file_path: filePath,
      tool_input: {
        file_path: filePath,
        content,
      },
    };

    const result = await runCommentChecker(checkerInput, binaryPath, debugLog);
    if (result.status === "error") {
      return { 
        status: "failed",
        error: result.error
      };
    }
    return {
      status: "ok",
      comments: result.result.comments ?? [],
    };
  } catch (err) {
    const message = `Error reading/checking ${filePath}`;
    const error = wrapWithContext(err, message);
    return { status: "failed", error };
  }
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

    if (result.status === "error") {
      debug(`Comment checker error: ${result.error}`);
      return;
    }
    if (result.status === "ok" && result.result.comments && result.result.comments.length > 0) {
      const commentList = result.result.comments.map((c) => `  Line ${c.line}: ${c.text}`).join("\n");

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
      if (result.status === "ok" && result.result.comments) {
        allComments.push(...result.result.comments);
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

  // Register a command to check binary status or scan files for comments
  pi.registerCommand("check-comments", {
    description: "Check comment-checker status, or scan a file/directory for problematic comments",
    handler: async (args, ctx) => {
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

      // If no arguments, just show status
      if (!args || args.trim() === "") {
        ctx.ui.notify(`comment-checker: ${status.path} (${status.source})`, "info");
        console.log(`Comment-checker binary: ${status.path} (${status.source})`);
        console.log("\nUsage: /check-comments [path]");
        console.log("  - No path: Show this status message");
        console.log("  - File path: Check that file for problematic comments");
        console.log("  - Directory: Recursively scan for problematic comments in all source files");
        return;
      }

      // Parse the path argument
      const targetPath = resolve(ctx.cwd, args.trim());
      let fileStats;
      try {
        fileStats = statSync(targetPath);
      } catch (err) {
        ctx.ui.notify(`Path not found: ${targetPath}`, "error");
        return;
      }

      ctx.ui.notify(`Scanning for comments in ${targetPath}...`, "info");

      // Collect and merge all applicable .gitignore files hierarchically
      let gitignorePatterns: GitignorePattern[] | null = null;
      let gitignoreDir: string = targetPath;
      const gitignoreSources: string[] = [];
      if (fileStats.isDirectory()) {
        const ancestorGitignores = findGitignoreAncestors(targetPath);
        if (ancestorGitignores.length > 0) {
          // Use the directory of the closest .gitignore as base for relative paths
          gitignoreDir = dirname(ancestorGitignores[ancestorGitignores.length - 1].path);
          // Merge all patterns - root-level first, then more specific
          const allPatternSets = ancestorGitignores.map(g => g.patterns);
          gitignorePatterns = mergeGitignorePatterns(allPatternSets);
          gitignoreSources.push(...ancestorGitignores.map(g => g.path));
          if (gitignorePatterns) {
            console.log(`Using .gitignore: ${gitignoreSources.join(", ")} (${gitignorePatterns.length} patterns)`);
          }
        }
      }

      // Collect files to check
      const filesToCheck: string[] = [];
      let traversalFailures = 0;
      if (fileStats.isFile()) {
        if (isSourceFile(targetPath)) {
          filesToCheck.push(targetPath);
        } else {
          ctx.ui.notify(`Not a source code file: ${targetPath}`, "warning");
          return;
        }
      } else if (fileStats.isDirectory()) {
        const discoveryResult = discoverSourceFiles(targetPath, gitignoreDir, gitignorePatterns, debug);
        filesToCheck.push(...discoveryResult.files);
        // Surface directory traversal errors separately - don't add to filesToCheck
        for (const err of discoveryResult.errors) {
          traversalFailures++;
          console.error(`Directory traversal error for ${err.path}: ${err.error instanceof Error ? err.error.message : err.error}`);
        }
        if (filesToCheck.length === 0 && traversalFailures === 0) {
          ctx.ui.notify("No source files found in directory", "warning");
          return;
        }
      } else {
        ctx.ui.notify(`Invalid path type: ${targetPath}`, "error");
        return;
      }

      // Check each file
      const allComments: Array<{ file: string; line: number; text: string }> = [];
      let filesChecked = 0;
      let filesWithComments = 0;
      let failedFiles = traversalFailures;

      for (const filePath of filesToCheck) {
        const result = await checkFileForComments(filePath, status.path, debug);
        filesChecked++;

        if (result.status === "failed") {
          failedFiles++;
          console.error(`Failed to check ${filePath}: ${result.error instanceof Error ? result.error.message : result.error}`);
          continue;
        }

        if (result.comments.length > 0) {
          filesWithComments++;
          allComments.push(...result.comments);
        }
      }

      // Report results
      console.log("\n" + "=".repeat(60));
      console.log("COMMENT CHECKER RESULTS");
      console.log("=".repeat(60));
      console.log(`Files scanned: ${filesChecked}`);
      if (failedFiles > 0) {
        console.log(`Files that could not be checked: ${failedFiles}`);
      }
      console.log(`Files with problematic comments: ${filesWithComments}`);
      console.log(`Total problematic comments: ${allComments.length}`);

      if (allComments.length === 0 && failedFiles === 0) {
        console.log("\n✓ No problematic comments found!");
        ctx.ui.notify("No problematic comments found", "info");
      } else if (failedFiles > 0) {
        // Emit incomplete-scan error when files could not be checked
        console.log("\n⚠ Scan completed with errors");
        console.log(`${failedFiles} file(s) could not be checked due to errors.`);
        ctx.ui.notify(`Scan incomplete: ${failedFiles} file(s) could not be checked`, "warning");
        if (allComments.length > 0) {
          // Also show comments found in successfully checked files
          console.log("\n" + "-".repeat(60));
          console.log("PROBLEMATIC COMMENTS FOUND (in successfully checked files):");
          console.log("-".repeat(60));

          
          printCommentsByFile(allComments);
        }
      } else {
        console.log("\n" + "-".repeat(60));
        console.log("PROBLEMATIC COMMENTS FOUND:");
        console.log("-".repeat(60));

        // Group by file for cleaner output
        printCommentsByFile(allComments);


        console.log("\n" + "-".repeat(60));
        console.log("These comments may violate the self-documenting code principle.");
        console.log("Consider:");
        console.log("  - Using meaningful variable/function names");
        console.log("  - Extracting functions instead of explaining with comments");
        console.log("  - Letting the code speak for itself");
        console.log("\nAllowed exceptions: BDD (given/when/then), linter directives (@ts-ignore, eslint-disable), shebangs");
        console.log("=".repeat(60));

        ctx.ui.notify(`Found ${allComments.length} problematic comment(s) in ${filesWithComments} file(s)`, "warning");
      }
    },
  });

  const initialStatus = findBinary();
  debug(
    `Extension loaded. Binary: ${initialStatus.found ? "found" : "not found"} (${initialStatus.path})`,
  );
}
