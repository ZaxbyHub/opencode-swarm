/**
 * PR 3922 closeout (counsel + reviewer D3): the v2 native-async registry is bounded
 * at 1024 live projects and fails CLOSED past that bound. A verified 2.3 host with
 * native-async mode off would settle async children as foreground (wrong dialect),
 * so a silent degrade is not an option; the refusal is loud and names the capacity.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
	isNativeV2AsyncSubagentHost,
	registerNativeV2AsyncSubagents,
} from '../../../../src/host/v2/native-async-mode';
import { openCodeSwarmV2Setup } from '../../../../src/host/v2/setup';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const MAX_LIVE_PROJECTS = 1024;

function makeHooks() {
	return {
		tool: {},
		agent: {},
		config: async () => {},
		event: async () => {},
		dispose: async () => {},
	};
}

describe('v2 native-async registry fails closed at its bound (PR 3922 closeout)', () => {
	const releases: Array<() => void> = [];

	function fillToBound(): void {
		for (let i = 0; i < MAX_LIVE_PROJECTS; i++) {
			releases.push(
				registerNativeV2AsyncSubagents(`/virtual/capacity-${i}`, `seed-${i}`),
			);
		}
	}

	afterEach(() => {
		for (const release of releases.splice(0)) release();
		resetSwarmState();
	});

	test('a registration past the bound refuses with a capacity error', () => {
		fillToBound();
		expect(() =>
			registerNativeV2AsyncSubagents('/virtual/one-too-many', 'overflow'),
		).toThrow(/capacity/);
	});

	test('v2 setup on a 2.3 host at the bound rejects with the capacity error', async () => {
		fillToBound();
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

		await expect(openCodeSwarmV2Setup(ctx, deps as never)).rejects.toThrow(
			/capacity/,
		);
		expect(isNativeV2AsyncSubagentHost(directory)).toBe(false);
	});
});
