# @djdembeck/pi-comment-checker

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
pi install git:github.com/djdembeck/pi-comment-checker
```

<details>
<summary>Manual installation</summary>

```bash
git clone https://github.com/djdembeck/pi-comment-checker.git ~/.pi/agent/extensions/pi-comment-checker
```

</details>

## How It Works

The extension monitors `write`, `edit`, `multiedit`, and `apply_patch` tool calls. When it detects unnecessary comments in the code being written, it marks the result as an error with a warning message.

**Allowed exceptions:**
- BDD comments (`// given`, `// when`, `// then`)
- Linter directives (`// @ts-ignore`, `// eslint-disable`, `# noqa`)
- Shebangs

**Supported languages:** 30+ via tree-sitter (TypeScript, Python, Go, Rust, Java, C/C++, Ruby, Swift, and more).

For full details on comment detection rules, binary configuration, and advanced usage, see the [go-claude-code-comment-checker repository](https://github.com/code-yeongyu/go-claude-code-comment-checker).

## Commands

- `/check-comments` — Confirm extension is loaded

## Related

- [go-claude-code-comment-checker](https://github.com/code-yeongyu/go-claude-code-comment-checker) — Core comment detection engine
- [Pi Coding Agent](https://github.com/marioechr/pi-mono) — The agent this extension works with

## License

MIT
