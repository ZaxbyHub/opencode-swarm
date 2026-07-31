import { describe, expect, test } from 'bun:test';
import { _internals } from './registry';
import { classifySwarmCommandToolUse } from './tool-policy';

describe('/swarm review tool policy', () => {
	test('remains human-only through swarm_command for every selector', () => {
		for (const tokens of [
			['review'],
			['review', '--json'],
			['review', '--base', 'origin/main', '--json'],
			['review', '--range', 'main...feature'],
			['review', '--working-tree', '--json'],
			['review', '--base', '-unsafe'],
			['review', '--base', 'main', '--working-tree'],
			['review', '--unknown'],
		]) {
			const resolved = _internals.resolveCommand(tokens);
			expect(resolved).not.toBeNull();
			const policy = classifySwarmCommandToolUse(resolved!);
			expect(policy.allowed).toBe(false);
			if (!policy.allowed) expect(policy.message).toContain('human-only');
		}
	});
});
