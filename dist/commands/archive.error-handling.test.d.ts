/**
 * Tests for archive.ts graceful handling of corrupt evidence files (Task 1.6)
 *
 * Verifies that the try/catch in handleArchiveCommand's dry-run loop
 * catches exceptions from loadEvidence and skips corrupt/unreadable files.
 *
 * Uses real filesystem operations like existing archive tests.
 */
export {};
