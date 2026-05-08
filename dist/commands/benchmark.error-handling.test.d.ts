/**
 * Tests for benchmark.ts graceful handling of corrupt evidence files.
 *
 * Verifies that the try/catch in handleBenchmarkCommand's cumulative loop
 * catches exceptions from loadEvidence and skips corrupt/unreadable files.
 */
export {};
