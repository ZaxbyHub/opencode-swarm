/**
 * Tests for command-not-found UX improvement in createSwarmCommandHandler.
 *
 * Covers:
 * - Unknown single-word command shows "Command not found" + suggestions + footer
 * - Unknown compound command shows header with command name
 * - Empty tokens (empty array) → returns buildHelpText() output
 * - Command with no similar matches → shows header + footer only (no "Did you mean" section)
 * - Multiple similar commands returned → all shown with bullet format
 */
export {};
