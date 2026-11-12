/**
 * Issue #3659 supplementary pin: the MCP knowledge-memory adapter's disabled
 * message addresses the operator, not the model. The three tool handlers'
 * disabled payloads are pinned in tests/unit/tools/swarm-memory-tools.test.ts
 * (operator wording + the real `memory.enabled` schema key path, each
 * asserting the absence of the old `swarm.memory.enabled` spelling); this
 * file pins the fourth surface (src/mcp/adapters/knowledge-memory.ts) with
 * the same three assertions.
 */
import { describe, expect, test } from 'bun:test';
import { swarmMemoryRecallAdapter } from '../../../src/mcp/adapters/knowledge-memory';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('knowledge-memory adapter disabled message (issue #3659)', () => {
	test('disabled adapter message addresses the operator and stays inert', async () => {
		// A root with no opencode-swarm config: memory.enabled resolves to the
		// schema default false, so the adapter's feature-flag probe degrades.
		const root = canonicalMkdtemp('km-disabled-3659-');
		try {
			const result = await swarmMemoryRecallAdapter.execute(
				{ query: 'anything' },
				root,
			);
			expect(result.available).toBe(false);
			expect(result.reason).toBe('memory_disabled');
			expect(result.message).toContain('Swarm memory is disabled');
			expect(result.message).toContain('operator');
			expect(result.message).toContain('memory.enabled');
			expect(result.message).not.toContain('swarm.memory.enabled');
		} finally {
			safeRmRecursive(root);
		}
	});
});
