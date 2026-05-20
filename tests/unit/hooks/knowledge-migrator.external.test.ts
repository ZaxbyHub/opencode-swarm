/**
 * Verification tests for migrateKnowledgeToExternal() in Task 1.3
 * Tests the migration from internal knowledge.jsonl to external platform path
 *
 * SKIPPED: This file originally used vitest vi.mock() which is incompatible with bun:test.
 * The mock setup needs to be rewritten to use _internals DI pattern per AGENTS.md §7.
 * Previously had a parse error (extra closing brace) — biome parse fix exposed that
 * the underlying tests use vi.mock/vi.fn which don't work under bun:test.
 *
 * See git history for the original vitest test content.
 * TODO: Rewrite using _internals DI pattern (see evidence-service tests for reference).
 */

import { describe } from 'bun:test';

describe.skip('migrateKnowledgeToExternal — needs _internals DI conversion from vitest vi.mock', () => {
	// Placeholder — original 16 tests preserved in git history
	// awaiting rewrite to bun:test _internals DI pattern
});
