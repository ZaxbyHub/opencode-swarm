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
const { collectCheckRuns } = await import(
	'../../../.opencode/skills/swarm-ci-monitor/scripts/observe-ci'
);

const PR_HEAD = '1'.repeat(40);
const OTHER_HEAD = '2'.repeat(40);

const FIRST_CHECK = {
	id: 101,
	headSha: PR_HEAD,
	name: 'unit tests',
	status: 'completed',
	conclusion: 'success',
};
const REQUIRED_CHECK = {
	id: 102,
	headSha: PR_HEAD,
	name: 'required build',
	status: 'completed',
	conclusion: 'failure',
};

describe('swarm CI monitor — exact-head check pagination (#3709 AC1)', () => {
	// Only the page transport is simulated. HTTP decoding and branch protection
	// policy are outside this check of the completeness and identity contract.
	test('includes the failed required check from the second page', async () => {
		const requested: number[] = [];
		const observation = await collectCheckRuns(PR_HEAD, async (page) => {
			requested.push(page);
			return page === 1
				? { totalCount: 2, checks: [FIRST_CHECK], hasNext: true }
				: { totalCount: 2, checks: [REQUIRED_CHECK], hasNext: false };
		});

		expect(requested).toEqual([1, 2]);
		expect(observation.state).toBe('complete');
		expect(observation.checks).toEqual([FIRST_CHECK, REQUIRED_CHECK]);
	});

	test('retains earlier checks and marks the census incomplete when a later page fails', async () => {
		const requested: number[] = [];
		const observation = await collectCheckRuns(PR_HEAD, async (page) => {
			requested.push(page);
			if (page === 1) {
				return { totalCount: 2, checks: [FIRST_CHECK], hasNext: true };
			}
			throw new Error('fixture page unavailable');
		});

		expect(requested).toEqual([1, 2]);
		expect(observation.state).toBe('incomplete');
		expect(observation.checks).toEqual([FIRST_CHECK]);
	});

	test('rejects a returned check from a different head', async () => {
		const observation = await collectCheckRuns(PR_HEAD, async (page) =>
			page === 1
				? { totalCount: 2, checks: [FIRST_CHECK], hasNext: true }
				: {
						totalCount: 2,
						checks: [{ ...REQUIRED_CHECK, headSha: OTHER_HEAD }],
						hasNext: false,
					},
		);

		expect(observation.state).toBe('incomplete');
		expect(observation.checks).not.toContainEqual({
			...REQUIRED_CHECK,
			headSha: OTHER_HEAD,
		});
	});

	test('cannot reach a complete count by repeating an ID across pages', async () => {
		const observation = await collectCheckRuns(PR_HEAD, async (page) => ({
			totalCount: 2,
			checks: [FIRST_CHECK],
			hasNext: page === 1,
		}));

		expect(observation.state).toBe('incomplete');
	});

	test('marks an early terminal page incomplete when checks are missing', async () => {
		const observation = await collectCheckRuns(PR_HEAD, async () => ({
			totalCount: 2,
			checks: [FIRST_CHECK],
			hasNext: false,
		}));

		expect(observation.state).toBe('incomplete');
	});

	test('rejects a changed total across pages even when the last count matches', async () => {
		const observation = await collectCheckRuns(PR_HEAD, async (page) =>
			page === 1
				? { totalCount: 3, checks: [FIRST_CHECK], hasNext: true }
				: { totalCount: 2, checks: [REQUIRED_CHECK], hasNext: false },
		);

		expect(observation.state).toBe('incomplete');
	});
});
