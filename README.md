# pi-comment-checker

Pi extension that enforces self-documenting code by warning when unnecessary comments are written. Integrates [go-claude-code-comment-checker](https://github.com/code-yeongyu/go-claude-code-comment-checker).

**Why?** Comments are often a code smell—better naming and structure eliminate the need for them. This extension catches problematic comments before they reach your codebase.

## Installation

### 1. Install the Binary

```bash
go install github.com/code-yeongyu/go-claude-code-comment-checker/cmd/comment-checker@latest
```

Verify: `comment-checker --help`

<details>
<summary>Alternative install options</summary>

- **Homebrew**: `brew tap code-yeongyu/tap && brew install comment-checker`
- **Release binary**: Download from [GitHub Releases](https://github.com/code-yeongyu/go-claude-code-comment-checker/releases)
- **Build from source**: Clone and `go build ./cmd/comment-checker`

</details>

### 2. Install the Pi Extension

```bash
pi install pi-comment-checker
```

<details>
<summary>Manual installation</summary>

```bash
git clone https://github.com/djdembeck/pi-comment-checker.git ~/.pi/agent/extensions/pi-comment-checker
```

</details>

## How It Works

The extension monitors `write`, `edit`, and `multiedit` before execution, blocking those tool calls when it detects unnecessary comments. It also inspects `apply_patch` results and marks them as errors when comments are detected there.

**Allowed exceptions:**

- BDD comments (`// given`, `// when`, `// then`)
- Linter directives (`// @ts-ignore`, `// eslint-disable`, `# noqa`)
- Shebangs

**Supported languages:** 30+ via tree-sitter (TypeScript, Python, Go, Rust, Java, C/C++, Ruby, Swift, and more).

For full details on comment detection rules, binary configuration, and advanced usage, see the [go-claude-code-comment-checker repository](https://github.com/code-yeongyu/go-claude-code-comment-checker).

## Commands

### `/check-comments` — Check extension status

Show binary location and setup help:

`/check-comments`

### `/check-comments <path>` — Scan files for problematic comments

Retroactively check existing files for unnecessary comments:

```bash
# Check a single file
/check-comments src/utils.ts

# Check all source files in a directory (recursive)
/check-comments src/

# Check the entire project
/check-comments .
```

**Output includes:**

- Files scanned count
- Files with problematic comments
- Total comments found
- Grouped output by file with line numbers

**Gitignore support:** The extension automatically finds and respects your project's `.gitignore` file when scanning directories. Patterns like `*.log`, `node_modules/`, `dist/`, and `**/vendor` are honored to avoid checking files you've already excluded from version control.

**Always skipped:** `.git`, `.svn`, `.hg` (VCS directories)

**Supported file extensions:** `.js`, `.jsx`, `.ts`, `.tsx`, `.py`, `.go`, `.rs`, `.java`, `.kt`, `.c`, `.cpp`, `.h`, `.rb`, `.php`, `.swift`, `.cs`, and many more.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PI_COMMENT_CHECKER_DEBUG` | unset | Set to `1` to enable debug logging to stderr (`[comment-checker]` prefix) |
| `PI_COMMENT_CHECKER_NOTIFY` | unset | Set to `1` to show terminal notifications when AI comments are detected. By default, detections are passed silently to the agent via tool return values |

## Related

- [go-claude-code-comment-checker](https://github.com/code-yeongyu/go-claude-code-comment-checker) — Core comment detection engine
- [Pi Coding Agent](https://github.com/marioechr/pi-mono) — The agent this extension works with

## License

MIT
