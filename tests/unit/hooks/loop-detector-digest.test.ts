import { beforeEach, describe, expect, test } from 'bun:test';
import { _test_exports, detectLoop } from '../../../src/hooks/loop-detector';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';

const { canonicalDelegationDigest } = _test_exports;

describe('canonicalDelegationDigest (issue #2103 workstream B)', () => {
	test('five distinct tasks delegated to one role do not collide', () => {
		const digests = new Set<string>();
		for (let i = 1; i <= 5; i++) {
			digests.add(
				canonicalDelegationDigest('Task', {
					subagent_type: 'coder',
					task_id: `3.1.${i}`,
					prompt: `do task ${i}`,
					description: `task ${i}`,
				}),
			);
		}
		expect(digests.size).toBe(5);
	});

	test('distinct prompts to the same role without task ids also do not collide', () => {
		const a = canonicalDelegationDigest('Task', {
			subagent_type: 'coder',
			prompt: 'fix the login bug',
		});
		const b = canonicalDelegationDigest('Task', {
			subagent_type: 'coder',
			prompt: 'fix the signup bug',
		});
		expect(a).not.toBe(b);
	});

	test('a true retry of the same action collides', () => {
		const args = {
			subagent_type: 'mega_coder',
			task_id: '2.1',
			prompt: 'implement the fix',
			description: 'fix',
		};
		expect(canonicalDelegationDigest('Task', args)).toBe(
			canonicalDelegationDigest('Task', { ...args }),
		);
		// Swarm-prefix normalization: mega_coder ≡ coder for loop identity.
		const unprefixed = canonicalDelegationDigest('Task', {
			...args,
			subagent_type: 'coder',
		});
		expect(canonicalDelegationDigest('Task', args)).toBe(unprefixed);
	});

	test('argument key order does not change the digest; relevant value changes do', () => {
		const a = canonicalDelegationDigest('Task', {
			subagent_type: 'reviewer',
			prompt: 'review X',
			file_path: 'src/a.ts',
		});
		const b = canonicalDelegationDigest('Task', {
			file_path: 'src/a.ts',
			prompt: 'review X',
			subagent_type: 'reviewer',
		});
		expect(a).toBe(b);
		const c = canonicalDelegationDigest('Task', {
			subagent_type: 'reviewer',
			prompt: 'review X',
			file_path: 'src/B.ts',
		});
		expect(a).not.toBe(c);
	});

	test('raw prompt/secret text is absent from the stored digest', () => {
		const secret = 'API_KEY=sk-supersecret';
		const digest = canonicalDelegationDigest('Task', {
			subagent_type: 'coder',
			prompt: `use ${secret}`,
		});
		expect(digest).not.toContain('sk-supersecret');
		expect(digest).not.toContain('API_KEY');
	});
});

describe('detectLoop with the semantic digest (acceptance tests 1-2)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	test('five distinct tasks to one role never trip the loop detector', () => {
		const sessionID = 'loop-distinct';
		ensureAgentSession(sessionID, 'test-agent');
		for (let i = 1; i <= 5; i++) {
			const result = detectLoop(sessionID, 'Task', {
				subagent_type: 'coder',
				task_id: `1.1.${i}`,
				prompt: `task ${i}`,
			});
			expect(result.looping).toBe(false);
		}
	});

	test('repeating the same canonical action trips it', () => {
		const sessionID = 'loop-same';
		ensureAgentSession(sessionID, 'test-agent');
		const args = { subagent_type: 'coder', task_id: '1.1', prompt: 'same' };
		let result = detectLoop(sessionID, 'Task', args);
		result = detectLoop(sessionID, 'Task', args);
		result = detectLoop(sessionID, 'Task', args);
		expect(result.looping).toBe(true);
		expect(result.count).toBe(3);
	});
});
