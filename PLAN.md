# Pi Comment Checker Enforcement Implementation Plan

## Goal

Move enforcement from `tool_result` (post-execution) to `tool_call` (pre-execution) for `write`, `edit`, and `multiedit` tools, and add regression tests.

## Changes Required

### 1. `extensions/index.ts`

- Add `buildApplyPatchCheckerInput` helper for apply_patch tool_result handling
- Add `formatCommentMessage` helper for consistent message formatting
- Replace `tool_result` handler for write/edit/multiedit with `tool_call` handler that:
  - Normalizes input using existing `buildCheckerInput`
  - Runs comment checker (pre-execution blocking)
  - Returns `{ block: true, reason }` when comments detected
  - Preserves warn-once behavior when binary missing
- Keep `tool_result` for apply_patch but improve it:
  - Use diff-style Edit representation when `before` and `after` both present
  - Skip deleted files properly
- Export helpers needed for testing

### 2. `extensions/index.test.ts`

- Add mock Pi API type for testing
- Add tests for `tool_call` handler:
  - Blocks write with comments
  - Allows clean write
  - Ignores non-file-modifying tools
  - Handles missing binary gracefully
- Add tests for improved `apply_patch` handling
- Add tests for helper functions (`formatCommentMessage`, `buildApplyPatchCheckerInput`)

## Acceptance Criteria

- `tool_call` handler registered and blocks before execution
- Tests prove hook registration and behavior
- apply_patch handling uses Edit-style diff when possible
- Binary missing = warn-once, not block
- All tests pass
