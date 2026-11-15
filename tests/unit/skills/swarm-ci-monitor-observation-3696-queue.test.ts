import { describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';

// The tracer copies this driver into its base replay, where the implementation
// is absent. Keep the published Bun sentinel for that deterministic base leg.
const implementation = new URL(
	'../../../.opencode/skills/swarm-ci-monitor/scripts/observe-ci.ts',
	import.meta.url,
);
if (statSync(implementation, { throwIfNoEntry: false }) === undefined) {
	throw new Error(
		'The following filters did not match any test files: CI observation implementation is absent at the base revision.',
	);
}
const { resolveMergeObservation } = await import(
	'../../../.opencode/skills/swarm-ci-monitor/scripts/observe-ci'
);

const PR_HEAD = '1'.repeat(40);
const QUEUE_HEAD = '2'.repeat(40);
const MERGE_SHA = '3'.repeat(40);
const EXPECTED_PR = {
	repository: 'example/swarm',
	number: 42,
	headSha: PR_HEAD,
	baseRefName: 'main',
};
const STALE_CANDIDATE = {
	headSha: QUEUE_HEAD,
	status: 'UNKNOWN',
	conclusion: null,
};
const MERGED_PR = {
	...EXPECTED_PR,
	state: 'MERGED' as const,
	mergeCommitSha: MERGE_SHA,
};

describe('swarm CI monitor — independent terminal merge proof (#3709 AC2)', () => {
	// Only the independent Git proof reader is simulated. Fetching refs and
	// checking ancestry in Git are adapter concerns outside this contract test.
	test('keeps stale candidate identity beside an independently confirmed merge', async () => {
		const proofs: Array<[string, string]> = [];
		const observation = await resolveMergeObservation(
			EXPECTED_PR,
			MERGED_PR,
			STALE_CANDIDATE,
			async (mergeSha, baseRefName) => {
				proofs.push([mergeSha, baseRefName]);
				return true;
			},
		);

		expect(proofs).toEqual([[MERGE_SHA, 'main']]);
		expect(observation.state).toBe('merged');
		expect(observation.headSha).toBe(PR_HEAD);
		expect(observation.candidate).toEqual(STALE_CANDIDATE);
		expect(observation.mergeCommitSha).toBe(MERGE_SHA);
	});

	test('a successful candidate cannot substitute for a missing base proof', async () => {
		const proofs: Array<[string, string]> = [];
		const observation = await resolveMergeObservation(
			EXPECTED_PR,
			MERGED_PR,
			{ headSha: QUEUE_HEAD, status: 'completed', conclusion: 'success' },
			async (mergeSha, baseRefName) => {
				proofs.push([mergeSha, baseRefName]);
				return false;
			},
		);

		expect(proofs).toEqual([[MERGE_SHA, 'main']]);
		expect(observation.state).toBe('unconfirmed');
	});

	test('a successful candidate cannot make an open PR terminal', async () => {
		let proofCalls = 0;
		const observation = await resolveMergeObservation(
			EXPECTED_PR,
			{ ...MERGED_PR, state: 'OPEN', mergeCommitSha: null },
			{ headSha: QUEUE_HEAD, status: 'completed', conclusion: 'success' },
			async () => {
				proofCalls += 1;
				return true;
			},
		);

		expect(proofCalls).toBe(0);
		expect(observation.state).toBe('unconfirmed');
	});

	test.each([
		['head', { headSha: '4'.repeat(40) }],
		['base', { baseRefName: 'release' }],
		['repository', { repository: 'example/other' }],
		['pull request', { number: 43 }],
	] as const)('refuses a mismatched pull request %s without attempting proof', async (_field, mismatch) => {
		let proofCalls = 0;
		const observation = await resolveMergeObservation(
			EXPECTED_PR,
			{ ...MERGED_PR, ...mismatch },
			STALE_CANDIDATE,
			async () => {
				proofCalls += 1;
				return true;
			},
		);

		expect(proofCalls).toBe(0);
		expect(observation.state).toBe('unconfirmed');
	});
});
