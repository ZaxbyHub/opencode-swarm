/**
 * PR 3922 closeout: the v2 native-async registry throws at its live-project
 * capacity. Setup must fail open (invariant 1): the project still loads, with
 * native-async mode off for that project, instead of rejecting plugin setup.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
	isNativeV2AsyncSubagentHost,
	registerNativeV2AsyncSubagents,
} from '../../../../src/host/v2/native-async-mode';
import { openCodeSwarmV2Setup } from '../../../../src/host/v2/setup';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const MAX_LIVE_PROJECTS = 128;

function makeHooks() {
	return {
		tool: {},
		agent: {},
		config: async () => {},
		event: async () => {},
		dispose: async () => {},
	};
}

describe('v2 native-async registration fails open at capacity (PR 3922 closeout)', () => {
	const releases: Array<() => void> = [];

	afterEach(() => {
		for (const release of releases.splice(0)) release();
		resetSwarmState();
	});

	test('setup completes with native-async mode off when the registry is full', async () => {
		for (let i = 0; i < MAX_LIVE_PROJECTS; i++) {
			releases.push(
				registerNativeV2AsyncSubagents(`/virtual/capacity-${i}`, `seed-${i}`),
			);
		}

		const directory = canonicalMkdtemp('swarm-v2-capacity-');
		const ctx = {
			app: { name: 'opencode', version: '2.3.1', channel: 'test' },
			location: {
				directory,
				workspaceID: 'w',
				project: { id: 'p', directory, canonical: directory },
			},
			options: {},
			tool: {
				transform: async () => ({ dispose: async () => {} }),
				reload: async () => {},
				list: async () => [],
				hook: async () => ({ dispose: async () => {} }),
			},
			agent: {
				transform: async () => ({ dispose: async () => {} }),
				reload: async () => {},
			},
			command: {
				transform: async () => ({ dispose: async () => {} }),
				reload: async () => {},
			},
			session: { hook: async () => ({ dispose: async () => {} }) },
			event: {
				subscribe: () =>
					(async function* () {
						/* no events */
					})(),
			},
			permission: {},
		} as never;
		const deps = { runInit: async () => makeHooks() };

		const cleanup = await openCodeSwarmV2Setup(ctx, deps as never);
		expect(typeof cleanup).toBe('function');
		expect(isNativeV2AsyncSubagentHost(directory)).toBe(false);
		await cleanup();
	});
});
