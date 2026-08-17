import { afterEach, describe, expect, test } from 'bun:test';
import { _internals, reconcileLandedMerge } from '../../../src/worktree/merge';

const realBunSpawn = _internals.bunSpawn;
const HEX40 = 'a'.repeat(40);
const OTHER40 = 'c'.repeat(40);

/**
 * Captures the argv of every git invocation and returns a canned result, so the
 * assertions below are about the exact command shape rather than git's behavior.
 */
function captureArgv(exitCode: number): string[][] {
	const calls: string[][] = [];
	_internals.bunSpawn = ((args: string[]) => {
		calls.push(args);
		return {
			exited: Promise.resolve(exitCode),
			stdout: new Response('').body,
			stderr: new Response('').body,
		};
	}) as typeof _internals.bunSpawn;
	return calls;
}

afterEach(() => {
	_internals.bunSpawn = realBunSpawn;
});

describe('reconcileLandedMerge git argv shape', () => {
	test('cherry-pick trailer search ends with `--` immediately after the revision range', async () => {
		const calls = captureArgv(1);

		await reconcileLandedMerge('/tmp/primary', {
			operationId: 'op-1',
			sourceHead: HEX40,
			targetHeadBefore: OTHER40,
			branchName: 'swarm/lane-0',
			strategy: 'cherry-pick',
		});

		const logCall = calls.find((args) => args[1] === 'log');
		expect(logCall).toBeDefined();
		// `--` must be last and sit directly after the range: `git log -- A..B` would
		// parse the range as a pathspec and silently match nothing.
		expect(logCall?.at(-1)).toBe('--');
		expect(logCall?.at(-2)).toBe(`${OTHER40}..HEAD`);
	});

	test('merge-base ancestry check does not receive `--`', async () => {
		const calls = captureArgv(0);

		await reconcileLandedMerge('/tmp/primary', {
			operationId: 'op-1',
			sourceHead: HEX40,
			targetHeadBefore: OTHER40,
			branchName: 'swarm/lane-0',
			strategy: 'merge',
		});

		const mergeBaseCall = calls.find((args) => args[1] === 'merge-base');
		expect(mergeBaseCall).toBeDefined();
		// `git merge-base --is-ancestor` takes only commit operands; `--` has no
		// documented meaning there.
		expect(mergeBaseCall).not.toContain('--');
		expect(mergeBaseCall?.at(-1)).toBe('HEAD');
	});
});
