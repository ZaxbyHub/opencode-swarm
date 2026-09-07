import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { swarmState } from '../../../src/state';
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
 * Surface notes (review PRR-005/PRR-006): agent_activity's registered surface
 * is tool.execute.before/after (no-op methods when disabled), so a dedicated
 * boot below fires those keys directly. delegation_tracker is gated
 * in-handler (delegation-tracker.ts), so its default-off state is covered by
 * the hooks-absent boot; the explicit-on boot exercises the enabled branch.
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
		label: 'delegation_tracker=true (opt-in, in-handler enabled branch)',
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

const createdDirs: string[] = [];

afterEach(async () => {
	for (const dir of createdDirs.splice(0)) {
		// Bounded retry: a freshly-booted plugin can hold open handles in the
		// project dir on Windows (EBUSY). Hygiene never fails the test, but a
		// dir that stays unreclaimed after the retries is reported, not
		// silently leaked.
		for (let attempt = 0; attempt < 4; attempt += 1) {
			try {
				rmSync(dir, { recursive: true, force: true });
				break;
			} catch {
				if (attempt === 3) {
					console.warn(
						`[gated-hook-registration-class] temp dir not reclaimed: ${dir}`,
					);
				} else {
					await Bun.sleep(50);
				}
			}
		}
	}
});

async function bootAndTrack(
	overrides: Record<string, unknown>,
): Promise<Record<string, (...args: unknown[]) => Promise<unknown>>> {
	const host = await bootSwarmPluginHost(
		createPluginHostProject('swarm-2533-class-'),
		{ ...overrides },
	);
	createdDirs.push(host.directory);
	return host.hooks;
}

describe('config-gated hook factories never throw through the registered compose chains (#2533 class)', () => {
	for (const { label, overrides } of BOOTS) {
		it(`resolves messages.transform and system.transform with ${label}`, async () => {
			const hooks = await bootAndTrack({ ...overrides });
			const sessionID = 'class-audit-session';
			const messagesOutput = { messages: [] as unknown[] };
			await hooks['experimental.chat.messages.transform'](
				{ messages: [], sessionID },
				messagesOutput,
			);
			const systemOutput = { system: [] as unknown[] };
			await hooks['experimental.chat.system.transform'](
				{ sessionID },
				systemOutput,
			);
			// Both chains mutate their outputs in place; resolution plus intact
			// array surfaces is the disabled-state postcondition.
			expect(Array.isArray(messagesOutput.messages)).toBe(true);
			expect(Array.isArray(systemOutput.system)).toBe(true);
		});

		it(`resolves compaction with ${label}`, async () => {
			const hooks = await bootAndTrack({ ...overrides });
			const output = { context: [] as string[] };
			await hooks['experimental.session.compacting'](
				{ sessionID: 'class-audit-compaction' },
				output,
			);
			expect(Array.isArray(output.context)).toBe(true);
		});
	}

	it('proves the agent_activity disabled branch is a no-op through its registered surface', async () => {
		// Enabled control: toolBefore seeds swarmState.activeToolCalls and
		// toolAfter consumes the entry (src/hooks/agent-activity.ts).
		const enabled = await bootAndTrack({
			hooks: { agent_activity: true },
		});
		const enabledInput = {
			tool: 'class-audit-tool',
			sessionID: 'class-audit-tool-session',
			callID: 'class-audit-tool-call-enabled',
		};
		await enabled['tool.execute.before'](enabledInput, { args: {} });
		expect(swarmState.activeToolCalls.has(enabledInput.callID)).toBe(true);
		await enabled['tool.execute.after'](enabledInput, {});
		expect(swarmState.activeToolCalls.has(enabledInput.callID)).toBe(false);

		// Disabled: the factory's no-op branch must neither throw nor track.
		const disabled = await bootAndTrack({
			hooks: { agent_activity: false },
		});
		const disabledInput = {
			tool: 'class-audit-tool',
			sessionID: 'class-audit-tool-session',
			callID: 'class-audit-tool-call-disabled',
		};
		await disabled['tool.execute.before'](disabledInput, { args: {} });
		expect(swarmState.activeToolCalls.has(disabledInput.callID)).toBe(false);
		await disabled['tool.execute.after'](disabledInput, {});
		expect(swarmState.activeToolCalls.has(disabledInput.callID)).toBe(false);
	});
});
