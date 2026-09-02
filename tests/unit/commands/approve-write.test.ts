import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { handleApproveWriteCommand } from '../../../src/commands/approve-write.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let root = '';
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = '';
});
describe('/swarm approve-write', () => {
	test('issues only an exact valid approval', async () => {
		root = canonicalMkdtemp('approve-write-command-');
		const result = await handleApproveWriteCommand(
			root,
			['target-session', 'harness_activate', 'candidate', 'a'.repeat(64)],
			'human-session',
		);
		expect(result).toContain('Issued write approval waf_');
		expect(result).toContain(
			'/swarm approve-write target-session harness_activate candidate',
		);
	});
	test('rejects malformed hashes and unknown actions', async () => {
		root = canonicalMkdtemp('approve-write-command-');
		expect(
			await handleApproveWriteCommand(
				root,
				['s', 'skill_improve', 'c', 'bad'],
				'human',
			),
		).toContain('must be a lowercase sha256');
		expect(
			await handleApproveWriteCommand(
				root,
				['s', 'other', 'c', 'a'.repeat(64)],
				'human',
			),
		).toContain('unknown action');
	});
});
