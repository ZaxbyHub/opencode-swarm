import { describe, expect, it } from 'bun:test';
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../../helpers/plugin-host';

/**
 * Defect-class guardrail for issue #2533: a host-hook registration in
 * src/index.ts that indexes a config-gated hook factory's returned record (or
 * handler object) and calls it unguarded, while the factory omits that key or
 * method when its flag is disabled, throws at runtime for every user who sets
 * the documented opt-out.
 *
 * The compaction instance of the class is covered by
 * compaction-host-hook-2533.test.ts. This file pins the OTHER gated-hook
 * consumers: for each config flag that can disable a hook factory feeding the
 * registered compose chains, boot the real plugin with the flag in its
 * disabled state and fire the registered hooks that factory feeds, asserting
 * they resolve. The 2026-09-06 census found every such consumer safe
 * (filter(Boolean) compose arrays, no-op-method factories, in-handler flag
 * checks) — this test exists so a future regression of the class fails CI.
 *
 * Note on delegation_tracker: it defaults to false (opt-in), so both its
 * default-off and explicit-on states are exercised.
 */

const BOOTS = [
	{
		label: 'system_enhancer=false',
		overrides: { hooks: { system_enhancer: false } },
	},
	{
		label: 'agent_activity=false',
		overrides: { hooks: { agent_activity: false } },
	},
	{
		label: 'delegation_tracker=true (opt-in)',
		overrides: { hooks: { delegation_tracker: true } },
	},
	{ label: 'hooks absent (all defaults)', overrides: {} },
	{
		label: 'system_enhancer+agent_activity+compaction all off',
		overrides: {
			hooks: {
				system_enhancer: false,
				agent_activity: false,
				compaction: false,
			},
		},
	},
] as const;

describe('config-gated hook factories never throw through the registered compose chains (#2533 class)', () => {
	for (const { label, overrides } of BOOTS) {
		it(`resolves messages.transform and system.transform with ${label}`, async () => {
			const host = await bootSwarmPluginHost(
				createPluginHostProject('swarm-2533-class-'),
				{ ...overrides },
			);
			const sessionID = 'class-audit-session';
			const messagesOutput = { messages: [] as unknown[] };
			await host.hooks['experimental.chat.messages.transform'](
				{ messages: [], sessionID },
				messagesOutput,
			);
			const systemOutput = { system: [] as unknown[] };
			await host.hooks['experimental.chat.system.transform'](
				{ sessionID },
				systemOutput,
			);
			expect(true).toBe(true);
		});

		it(`resolves compaction with ${label}`, async () => {
			const host = await bootSwarmPluginHost(
				createPluginHostProject('swarm-2533-class-'),
				{ ...overrides },
			);
			const output = { context: [] as string[] };
			await host.hooks['experimental.session.compacting'](
				{ sessionID: 'class-audit-compaction' },
				output,
			);
			expect(Array.isArray(output.context)).toBe(true);
		});
	}
});
