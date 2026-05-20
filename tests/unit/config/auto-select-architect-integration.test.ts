/**
 * Integration tests for auto_select_architect config hook behavior.
 *
 * These tests simulate the logic inside the `config:` hook closure in
 * src/index.ts (lines 977-1080) without importing the hook itself
 * (which is not exportable). The hook operations are:
 *
 *  1. Normalize opencodeConfig.agent to {} if absent or non-object
 *  2. Object.assign(opencodeConfig.agent, agents)
 *  3. If auto_select_architect is truthy AND an architect exists:
 *     a. Disable build/plan (respecting existing disable:true overrides)
 *     b. If auto_select_architect === true && multiple primary architects: warn
 *     c. If string value and target is a valid architect: demote non-target
 *        architects, promote target to primary
 *     d. If string value and target is NOT a valid architect: warn (no demotion)
 *  4. If auto_select_architect is truthy but NO architect exists: warn
 *
 * We use the actual stripKnownSwarmPrefix and PluginConfigSchema from
 * src/config/schema.ts to verify end-to-end behavior.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
	PluginConfigSchema,
	stripKnownSwarmPrefix,
	// Agents index to get getAgentConfigs type
} from '../../../src/config/schema';

// ─── Helpers that mirror the config: hook logic ────────────────────────────────

/**
 * Simulates the auto_select_architect branch of the config: hook.
 * Returns { warnings } so we can assert on the warning condition without
 * actually calling addDeferredWarning.
 */
function applyAutoSelectArchitectLogic({
	opencodeConfig,
	agents,
	autoSelect,
}: {
	opencodeConfig: Record<string, unknown>;
	agents: Record<string, unknown>;
	autoSelect: boolean | string | undefined;
}): { warnings: string[] } {
	const warnings: string[] = [];

	// Normalize agent config (from hook lines 978-981)
	if (!opencodeConfig.agent || typeof opencodeConfig.agent !== 'object') {
		(opencodeConfig as Record<string, unknown>).agent = {};
	}

	// Merge agent configs (from hook lines 983-988)
	if (!opencodeConfig.agent) {
		opencodeConfig.agent = { ...agents };
	} else {
		Object.assign(opencodeConfig.agent, agents);
	}

	// Auto-select architect (from hook lines 990-1080)
	if (autoSelect) {
		// Check that at least one architect agent exists in the generated set
		const hasArchitect = Object.keys(agents).some(
			(name) => stripKnownSwarmPrefix(name) === 'architect',
		);

		if (hasArchitect) {
			// Disable build and plan built-in agents
			for (const builtin of ['build', 'plan'] as const) {
				const existing = (opencodeConfig.agent as Record<string, unknown>)?.[
					builtin
				] as Record<string, unknown> | undefined;

				if (
					existing &&
					typeof existing === 'object' &&
					existing.disable === true
				) {
					// User already disabled this agent — respect their override
					continue;
				}

				(opencodeConfig.agent as Record<string, unknown>)[builtin] = {
					...(existing && typeof existing === 'object' ? existing : {}),
					disable: true,
				};
			}

			// Warn when boolean true and multiple architects are primary
			if (autoSelect === true) {
				const primaryArchitects = Object.entries(agents).filter(
					([name, cfg]) =>
						stripKnownSwarmPrefix(name) === 'architect' &&
						(cfg as Record<string, unknown>)?.mode === 'primary',
				);

				if (primaryArchitects.length > 1) {
					const names = primaryArchitects.map(([n]) => n).join(', ');
					warnings.push(
						`[swarm] auto_select_architect is true but ${primaryArchitects.length} architect agents are primary (${names}). Consider setting auto_select_architect to a specific agent name.`,
					);
				}
			}

			// When a specific architect name is provided, demote non-matching
			// architects to subagent
			if (typeof autoSelect === 'string' && autoSelect !== '') {
				const targetName = autoSelect;

				// Only proceed if the target is actually an architect-role agent
				const targetIsArchitect =
					Object.hasOwn(agents, targetName) &&
					stripKnownSwarmPrefix(targetName) === 'architect';

				if (targetIsArchitect) {
					// Demote non-matching architects to subagent
					for (const [name, cfg] of Object.entries(agents)) {
						if (
							stripKnownSwarmPrefix(name) === 'architect' &&
							name !== targetName
						) {
							if (
								opencodeConfig.agent &&
								typeof opencodeConfig.agent === 'object'
							) {
								(opencodeConfig.agent as Record<string, unknown>)[name] = {
									...(cfg && typeof cfg === 'object' ? cfg : {}),
									mode: 'subagent',
								};
							}
						}
					}

					// Promote the target architect to primary
					if (
						opencodeConfig.agent &&
						typeof opencodeConfig.agent === 'object'
					) {
						const targetExisting = (
							opencodeConfig.agent as Record<string, unknown>
						)[targetName] as Record<string, unknown> | undefined;

						(opencodeConfig.agent as Record<string, unknown>)[targetName] = {
							...(targetExisting && typeof targetExisting === 'object'
								? targetExisting
								: {}),
							...(agents[targetName] && typeof agents[targetName] === 'object'
								? (agents[targetName] as Record<string, unknown>)
								: {}),
							mode: 'primary',
						};
					}
				} else {
					// Target is not a valid architect — warn the user
					warnings.push(
						`[swarm] auto_select_architect is set to "${targetName}" but that is not a known architect agent. No architect demotion applied.`,
					);
				}
			}
		} else {
			// No architect agents found — warn the user
			warnings.push(
				'[swarm] auto_select_architect is enabled but no architect agents were found in the generated set. The option has no effect.',
			);
		}
	}

	return { warnings };
}

// ─── Test cases ───────────────────────────────────────────────────────────────

describe('auto_select_architect integration — config: hook simulation', () => {
	afterEach(() => {
		mock.restore();
	});

	// Test 1: Full flow — auto_select_architect=true disables build/plan
	test('auto_select_architect=true disables build and plan agents', () => {
		const agents = {
			mega_architect: { name: 'mega_architect', mode: 'primary' as const },
		};
		const opencodeConfig: Record<string, unknown> = {};

		const { warnings } = applyAutoSelectArchitectLogic({
			opencodeConfig,
			agents,
			autoSelect: true,
		});

		// build and plan should be disabled
		const agent = opencodeConfig.agent as Record<string, unknown>;
		expect(agent.build).toEqual({ disable: true });
		expect(agent.plan).toEqual({ disable: true });

		// No warnings since only one primary architect
		expect(warnings).toHaveLength(0);
	});

	// Test 2: Full flow — auto_select_architect="mega_architect" demotes
	// non-matching architects and promotes the target
	test('auto_select_architect="mega_architect" demotes non-target architects', () => {
		const agents = {
			mega_architect: {
				name: 'mega_architect',
				mode: 'primary' as const,
			},
			local_architect: {
				name: 'local_architect',
				mode: 'primary' as const,
			},
		};
		const opencodeConfig: Record<string, unknown> = {};

		const { warnings } = applyAutoSelectArchitectLogic({
			opencodeConfig,
			agents,
			autoSelect: 'mega_architect',
		});

		const agent = opencodeConfig.agent as Record<string, unknown>;

		// mega_architect should be promoted to primary
		expect((agent.mega_architect as Record<string, unknown>)?.mode).toBe(
			'primary',
		);

		// local_architect should be demoted to subagent
		expect((agent.local_architect as Record<string, unknown>)?.mode).toBe(
			'subagent',
		);

		// No warnings (string autoSelect doesn't trigger the boolean warning)
		expect(warnings).toHaveLength(0);
	});

	// Test 3: User override respected — existing disable:true on build
	// should not be overwritten
	test('user override: existing disable:true on build is respected', () => {
		const agents = {
			architect: { name: 'architect', mode: 'primary' as const },
		};
		const opencodeConfig: Record<string, unknown> = {
			agent: {
				build: { disable: true, customField: 'preserved' },
			},
		};

		const { warnings } = applyAutoSelectArchitectLogic({
			opencodeConfig,
			agents,
			autoSelect: true,
		});

		const agent = opencodeConfig.agent as Record<string, unknown>;

		// build.disable should remain true; customField preserved
		expect(agent.build).toEqual({ disable: true, customField: 'preserved' });

		// plan should still be disabled (no prior override)
		expect(agent.plan).toEqual({ disable: true });

		expect(warnings).toHaveLength(0);
	});

	// Test 4: No architect agents — build/plan should NOT be disabled
	test('no architect agents: build and plan are NOT disabled', () => {
		const agents = {
			coder: { name: 'coder', mode: 'primary' as const },
			reviewer: { name: 'reviewer', mode: 'primary' as const },
		};
		const opencodeConfig: Record<string, unknown> = {};

		const { warnings } = applyAutoSelectArchitectLogic({
			opencodeConfig,
			agents,
			autoSelect: true,
		});

		const agent = opencodeConfig.agent as Record<string, unknown>;

		// build and plan should NOT be modified
		expect(agent.build).toBeUndefined();
		expect(agent.plan).toBeUndefined();

		// No architect = advisory warning about no architects found
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('no architect agents were found');
	});

	// Test 5: Invalid string target — auto_select_architect="nonexistent_architect"
	// should not cause demotion, but warns about invalid target
	test('invalid string target: no demotion happens, warns about invalid target', () => {
		const agents = {
			mega_architect: {
				name: 'mega_architect',
				mode: 'primary' as const,
			},
			local_architect: {
				name: 'local_architect',
				mode: 'primary' as const,
			},
		};
		const opencodeConfig: Record<string, unknown> = {};

		const { warnings } = applyAutoSelectArchitectLogic({
			opencodeConfig,
			agents,
			autoSelect: 'nonexistent_architect',
		});

		const agent = opencodeConfig.agent as Record<string, unknown>;

		// Both architects should keep their original mode (no demotion)
		expect((agent.mega_architect as Record<string, unknown>)?.mode).toBe(
			'primary',
		);
		expect((agent.local_architect as Record<string, unknown>)?.mode).toBe(
			'primary',
		);

		// build and plan should still be disabled (architect exists)
		expect(agent.build).toEqual({ disable: true });
		expect(agent.plan).toEqual({ disable: true });

		// Warning should be emitted for invalid target (not a known architect agent)
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('not a known architect agent');
		expect(warnings[0]).toContain('nonexistent_architect');
	});

	// Test 6: Primitive opencodeConfig.agent — should be normalized to {}
	// before merging
	test('primitive opencodeConfig.agent is normalized to {} before merging', () => {
		const agents = {
			architect: { name: 'architect', mode: 'primary' as const },
		};

		// Simulate the hook's normalization step directly
		const opencodeConfig: Record<string, unknown> = {
			agent: 'bad' as unknown as Record<string, unknown>,
		};

		// The hook checks typeof !== 'object' and replaces with {}
		if (!opencodeConfig.agent || typeof opencodeConfig.agent !== 'object') {
			(opencodeConfig as Record<string, unknown>).agent = {};
		}

		expect(opencodeConfig.agent).toEqual({});

		// Now merge would happen
		Object.assign(opencodeConfig.agent, agents);

		const agent = opencodeConfig.agent as Record<string, unknown>;
		expect(agent.architect).toEqual({ name: 'architect', mode: 'primary' });
	});

	// Test 7: Multiple primary architects warning — auto_select_architect=true
	// with 2+ primary architects triggers warning condition
	test('multiple primary architects: warning condition is satisfied', () => {
		const agents = {
			mega_architect: {
				name: 'mega_architect',
				mode: 'primary' as const,
			},
			local_architect: {
				name: 'local_architect',
				mode: 'primary' as const,
			},
		};
		const opencodeConfig: Record<string, unknown> = {};

		const { warnings } = applyAutoSelectArchitectLogic({
			opencodeConfig,
			agents,
			autoSelect: true,
		});

		// Warning should be emitted for multiple primary architects
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('2 architect agents are primary');
		expect(warnings[0]).toContain('mega_architect');
		expect(warnings[0]).toContain('local_architect');

		// Both architects should still be primary (warning only, not demotion)
		const agent = opencodeConfig.agent as Record<string, unknown>;
		expect((agent.mega_architect as Record<string, unknown>)?.mode).toBe(
			'primary',
		);
		expect((agent.local_architect as Record<string, unknown>)?.mode).toBe(
			'primary',
		);
	});

	// Test 8: PluginConfigSchema parses auto_select_architect correctly
	// (ensures the schema integration with the hook logic is sound)
	test('PluginConfigSchema: auto_select_architect transforms are correct', () => {
		const result1 = PluginConfigSchema.safeParse({
			auto_select_architect: true,
		});
		expect(result1.success).toBe(true);
		if (result1.success) {
			expect(result1.data.auto_select_architect).toBe(true);
		}

		const result2 = PluginConfigSchema.safeParse({
			auto_select_architect: 'mega_architect',
		});
		expect(result2.success).toBe(true);
		if (result2.success) {
			expect(result2.data.auto_select_architect).toBe('mega_architect');
		}

		const result3 = PluginConfigSchema.safeParse({
			auto_select_architect: false,
		});
		expect(result3.success).toBe(true);
		if (result3.success) {
			expect(result3.data.auto_select_architect).toBe(false);
		}

		const result4 = PluginConfigSchema.safeParse({
			auto_select_architect: 'nonexistent',
		});
		expect(result4.success).toBe(true);
		if (result4.success) {
			// Schema accepts any string; validation against agents set is semantic
			expect(result4.data.auto_select_architect).toBe('nonexistent');
		}
	});

	// Test 9: Mixed — auto_select_architect with string target that is also
	// the ONLY architect (no demotion needed, just promotion)
	test('single architect with string target: just promotes to primary', () => {
		const agents = {
			mega_architect: {
				name: 'mega_architect',
				// No mode set (undefined)
			},
		};
		const opencodeConfig: Record<string, unknown> = {};

		const { warnings } = applyAutoSelectArchitectLogic({
			opencodeConfig,
			agents,
			autoSelect: 'mega_architect',
		});

		const agent = opencodeConfig.agent as Record<string, unknown>;

		// mega_architect should be promoted to primary
		expect((agent.mega_architect as Record<string, unknown>)?.mode).toBe(
			'primary',
		);

		// build/plan should be disabled
		expect(agent.build).toEqual({ disable: true });
		expect(agent.plan).toEqual({ disable: true });

		expect(warnings).toHaveLength(0);
	});

	// Test 10: auto_select_architect=false (explicit) — no hook changes
	test('auto_select_architect=false: no hook changes applied', () => {
		const agents = {
			architect: { name: 'architect', mode: 'primary' as const },
		};
		const opencodeConfig: Record<string, unknown> = {};

		const { warnings } = applyAutoSelectArchitectLogic({
			opencodeConfig,
			agents,
			autoSelect: false,
		});

		const agent = opencodeConfig.agent as Record<string, unknown>;

		// Nothing should be disabled (autoSelect is falsy)
		expect(agent.build).toBeUndefined();
		expect(agent.plan).toBeUndefined();

		// Agent merged but not modified
		expect(agent.architect).toEqual({ name: 'architect', mode: 'primary' });

		expect(warnings).toHaveLength(0);
	});

	// Test 11: Non-architect string target (e.g., "mega_coder") warns but still disables build/plan
	test('non-architect string target: warns and disables build/plan without demotion', () => {
		const agents = {
			mega_architect: {
				name: 'mega_architect',
				mode: 'primary' as const,
			},
			mega_coder: {
				name: 'mega_coder',
				mode: 'subagent' as const,
			},
		};
		const opencodeConfig: Record<string, unknown> = {};

		const { warnings } = applyAutoSelectArchitectLogic({
			opencodeConfig,
			agents,
			autoSelect: 'mega_coder',
		});

		const agent = opencodeConfig.agent as Record<string, unknown>;

		// build/plan should still be disabled (hasArchitect is true from mega_architect)
		expect(agent.build).toEqual({ disable: true });
		expect(agent.plan).toEqual({ disable: true });

		// mega_architect should NOT be demoted (invalid target skips demotion)
		expect((agent.mega_architect as Record<string, unknown>)?.mode).toBe(
			'primary',
		);

		// mega_coder should NOT be promoted to primary
		expect((agent.mega_coder as Record<string, unknown>)?.mode).toBe(
			'subagent',
		);

		// Warning should be emitted for invalid target
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('not a known architect agent');
		expect(warnings[0]).toContain('mega_coder');
	});

	// Test 12: No architect agents with string target warns
	test('no architect agents with string target: warns and no changes', () => {
		const agents = {
			mega_coder: {
				name: 'mega_coder',
				mode: 'primary' as const,
			},
		};
		const opencodeConfig: Record<string, unknown> = {};

		const { warnings } = applyAutoSelectArchitectLogic({
			opencodeConfig,
			agents,
			autoSelect: 'mega_coder',
		});

		const agent = opencodeConfig.agent as Record<string, unknown>;

		// build/plan should NOT be disabled (no architects at all)
		expect(agent.build).toBeUndefined();
		expect(agent.plan).toBeUndefined();

		// Warning should be emitted for no architects
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('no architect agents were found');
	});
});
