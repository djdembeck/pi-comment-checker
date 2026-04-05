# @djdembeck/pi-comment-checker

Pi extension that integrates [go-claude-code-comment-checker](https://github.com/code-yeongyu/go-claude-code-comment-checker) to enforce self-documenting code principles.

## Philosophy

> "Code is like humor. When you have to explain it, it's bad." - Cory House

Comments are code smell. If your code needs comments to be understood, your code needs better naming and structure.

This extension watches `write`, `edit`, `multiedit`, and `apply_patch` tool calls and warns when it detects unnecessary comments.

## Allowed Exceptions

- **BDD comments**: `// given`, `// when`, `// then`
- **Linter directives**: `// @ts-ignore`, `// eslint-disable`, `# noqa`
- **Shebangs**: `#!/usr/bin/env node`
- **Docstrings** (evaluated case-by-case — most are unnecessary)

## Prerequisites

- [go-claude-code-comment-checker](https://github.com/code-yeongyu/go-claude-code-comment-checker) binary installed

## Installing the Binary

### Option 1: Go Install (Recommended)

Single command, auto-updates, cross-platform:

```bash
go install github.com/code-yeongyu/go-claude-code-comment-checker/cmd/comment-checker@latest
```

Verify it's in your PATH:
```bash
comment-checker --help
```

### Option 2: Homebrew (macOS/Linux)

```bash
brew tap code-yeongyu/tap
brew install comment-checker
```

### Option 3: Clone and Build

For development or to have the source available:

```bash
git clone https://github.com/code-yeongyu/go-claude-code-comment-checker.git
cd go-claude-code-comment-checker
go build -o comment-checker ./cmd/comment-checker

# Move to a location in your PATH
mv comment-checker ~/.local/bin/
```

### Option 4: Download Release Binary

Download prebuilt binaries from [GitHub Releases](https://github.com/code-yeongyu/go-claude-code-comment-checker/releases).

## Installing the Pi Extension

### Via `pi install` (Recommended)

```bash
pi install git:github.com/djdembeck/pi-comment-checker-extension
```

### Manual Installation

```bash
# Clone to Pi extensions directory
git clone https://github.com/djdembeck/pi-comment-checker-extension.git ~/.pi/agent/extensions/pi-comment-checker

# Or symlink from anywhere
ln -s /path/to/pi-comment-checker-extension ~/.pi/agent/extensions/pi-comment-checker
```

## Binary Location Resolution

The extension looks for the `comment-checker` binary in this order:

1. `../go-claude-code-comment-checker/comment-checker` (sibling project)
2. `../../go-claude-code-comment-checker/comment-checker`
3. `~/.local/bin/comment-checker`
4. `~/go/bin/comment-checker`
5. `/usr/local/bin/comment-checker`
6. `/usr/bin/comment-checker`
7. `comment-checker` (PATH lookup)

## Usage

The extension auto-loads when Pi starts. It will:

1. Check every `write`, `edit`, `multiedit`, and `apply_patch` tool result
2. Run the comment-checker binary against modified files
3. If problematic comments are detected, mark the result as error with a warning message

### Commands

- `/check-comments` — Shows status message confirming extension is loaded

### Environment Variables

- `PI_COMMENT_CHECKER_DEBUG=1` — Enable debug logging to console

## How It Works

```typescript
// Extension subscribes to tool_result events
pi.on("tool_result", async (event, ctx) => {
  // Only check file modification tools
  if (!["write", "edit", "multiedit"].includes(toolName)) return;

  // Build checker input
  const checkerInput = buildCheckerInput(toolName, event.input);

  // Run comment-checker binary
  const result = await runCommentChecker(checkerInput);

  // If comments found, mark as error with warning
  if (result?.comments?.length > 0) {
    return {
      content: [...event.content, { type: "text", text: warningMessage }],
      isError: true,
    };
  }
});
```

## Package Structure

```
pi-comment-checker-extension/
├── extensions/
│   └── index.ts          # Extension entry point
├── src/                  # Additional source files (if needed)
├── package.json          # Pi package manifest
├── tsconfig.json         # TypeScript configuration
├── README.md             # This file
├── LICENSE               # MIT license
└── .gitignore
```

## Supported Languages

30+ languages via tree-sitter:
- TypeScript/JavaScript/JSX/TSX
- Python
- Go
- Rust
- Java/Kotlin/Scala
- C/C++
- Ruby
- Swift
- And more...

## Troubleshooting

### Extension not loading

Check Pi's extension loading:
```bash
# Test load directly
pi -e /path/to/pi-comment-checker-extension/extensions/index.ts

# Check Pi logs for extension loading errors
```

### Binary not found

Verify the binary exists and is executable:
```bash
ls -la ../go-claude-code-comment-checker/comment-checker
../go-claude-code-comment-checker/comment-checker --help
```

### False positives

If you encounter legitimate comments being flagged:
1. Consider if the code could be self-documenting without the comment
2. Use BDD format (`// given`, `// when`, `// then`) for test comments
3. For linter directives, ensure they follow standard formats

## Development

```bash
# Type check
npm run typecheck

# Test extension loading
pi -e ./extensions/index.ts
```

## Related

- [go-claude-code-comment-checker](https://github.com/code-yeongyu/go-claude-code-comment-checker) — The Go binary that does the actual comment detection
- [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) — OpenCode plugin with the same comment-checker integration
- [Pi Coding Agent](https://github.com/marioechr/pi-mono) — The coding agent this extension works with

## License

MIT
