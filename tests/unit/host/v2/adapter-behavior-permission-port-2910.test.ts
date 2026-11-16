/**
 * #2910 W2 re-pin (split from adapter-behavior.test.ts at the FR-006 500-line
 * cap): the former pin asserted the dead `tools` allowlist branch — removed;
 * the enforceable channel is the `permission` block, ported through the
 * host's own v1->v2 migration. The FULL contract lives in the frozen C4
 * (agent-permission-port-2910.test.ts); this sibling keeps the adapter-level
 * smoke pin without growing the capped parent.
 */
import { describe, expect, test } from 'bun:test';
import { mapV1AgentToV2 } from '../../../../src/host/v2/agents-commands';

describe('v2 adapter behavior — permission port smoke (#2910 W2)', () => {
	test('mapV1AgentToV2 ports the v1 permission block per the host migration (#2910 W2 re-pin; the dead tools branch is gone)', () => {
		// The former pin asserted the `tools` allowlist branch — removed: its
		// only feeder (getAgentConfigs) deletes `sdkConfig.tools` at the emit
		// site (src/agents/index.ts, issue #2528), so nothing can ever reach
		// it. The enforceable channel is the `permission` block, ported through
		// the host's own v1→v2 migration (frozen C4 =
		// agent-permission-port-2910.test.ts carries the full contract).
		const info = mapV1AgentToV2('w', {
			permission: {
				write: 'deny',
				bash: 'allow',
				swarm_memory_recall: 'deny',
				external_directory: { 'C:/secret/**': 'deny' },
			},
		});
		expect(info.permissions).toContainEqual({
			action: 'edit',
			resource: '*',
			effect: 'deny',
		});
		expect(info.permissions).toContainEqual({
			action: 'shell',
			resource: '*',
			effect: 'allow',
		});
		expect(info.permissions).toContainEqual({
			action: 'swarm_memory_recall',
			resource: '*',
			effect: 'deny',
		});
		expect(info.permissions).toContainEqual({
			action: 'external_directory',
			resource: 'C:/secret/**',
			effect: 'deny',
		});
		// No 'tool' catch-all action exists anywhere in the host migration.
		expect(info.permissions?.some((r) => r.action === 'tool')).toBe(false);
	});
});
