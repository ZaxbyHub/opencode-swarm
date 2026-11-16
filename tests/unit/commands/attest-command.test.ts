import { describe, expect, test } from 'bun:test';
import { handleAttestCommand } from '../../../src/commands/attest.js';

/**
 * /swarm attest command-surface argument handling (issue #3432 review
 * PRR-007): unknown options are refused, never silently filtered. The
 * executor-level behavior (anchors, bundles, completion admission) is
 * covered by tests/unit/tools/attest-task.test.ts.
 */
describe('/swarm attest command argument handling', () => {
	test('rejects unknown options instead of silently filtering them', async () => {
		const out = await handleAttestCommand('x', ['1.1', '--force']);
		expect(out).toContain('Unsupported option(s): --force');
		expect(out).toContain('Usage: /swarm attest <task_id>');
	});

	test('keeps the missing-id and extra-argument usage errors', async () => {
		const missing = await handleAttestCommand('x', []);
		expect(missing).toContain('Missing task id');
		const extra = await handleAttestCommand('x', ['1.1', '2.2']);
		expect(extra).toContain('Unexpected arguments: 1.1 2.2');
		expect(extra).toContain('Usage: /swarm attest <task_id>');
	});

	test('a lone task id passes through to the executor (non-root directory refuses downstream)', async () => {
		const out = await handleAttestCommand('x', ['9.9']);
		expect(out).not.toContain('Usage: /swarm attest');
		expect(out).toContain('❌');
	});
});
