/**
 * Issue #3659 supplementary pin: the MCP knowledge-memory adapter's disabled
 * message addresses the operator, not the model. The three tool handlers'
 * disabled payloads are already pinned in
 * tests/unit/tools/swarm-memory-tools.test.ts; this covers the fourth surface
 * (src/mcp/adapters/knowledge-memory.ts).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { swarmMemoryRecallAdapter } from '../../../src/mcp/adapters/knowledge-memory';

describe('knowledge-memory adapter disabled message (issue #3659)', () => {
	test('disabled adapter message addresses the operator and stays inert', async () => {
		// A root with no opencode-swarm config: memory.enabled resolves to the
		// schema default false, so the adapter's feature-flag probe degrades.
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'km-disabled-3659-')),
		);
		try {
			const result = await swarmMemoryRecallAdapter.execute(
				{ query: 'anything' },
				root,
			);
			expect(result.available).toBe(false);
			expect(result.reason).toBe('memory_disabled');
			expect(result.message).toContain('Swarm memory is disabled');
			expect(result.message).toContain('operator');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
