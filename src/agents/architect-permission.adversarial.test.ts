/**
 * Adversarial Tests for Architect Task-Permission Hotfix (Task 1.21)
 * Focus: Agent naming edge cases, prefix misclassification, permission leakage
 */

import { describe, expect, it } from 'bun:test';
import type { PluginConfig } from '../config';
import { getAgentConfigs } from './index';

// Helper to create minimal valid PluginConfig (bypasses strict schema)
const minimalConfig = (partial: Partial<PluginConfig> = {}): PluginConfig =>
	partial as PluginConfig;

// Test helper: check if an agent has task permission
function hasTaskPermission(
	config: ReturnType<typeof getAgentConfigs>,
	agentName: string,
): boolean {
	const agentConfig = config[agentName];
	// Use type assertion to bypass SDK type checking
	const permission = agentConfig?.permission as { task?: string } | undefined;
	return permission?.task === 'allow';
}

// Test helper: check if an agent is primary mode
function isPrimaryMode(
	config: ReturnType<typeof getAgentConfigs>,
	agentName: string,
): boolean {
	const agentConfig = config[agentName];
	return agentConfig?.mode === 'primary';
}

describe('ADVERSARIAL: Architect Task Permission Edge Cases', () => {
	describe('Exact "architect" name matching', () => {
		it('should grant task permission for exact "architect" name (default swarm)', () => {
			const config = getAgentConfigs(undefined);
			// Default swarm creates unprefixed "architect"
			expect(hasTaskPermission(config, 'architect')).toBe(true);
			expect(isPrimaryMode(config, 'architect')).toBe(true);
		});

		it('should NOT grant task permission to non-architect agents in default swarm', () => {
			const config = getAgentConfigs(undefined);
			expect(hasTaskPermission(config, 'coder')).toBe(false);
			expect(hasTaskPermission(config, 'reviewer')).toBe(false);
			expect(hasTaskPermission(config, 'explorer')).toBe(false);
			expect(hasTaskPermission(config, 'sme')).toBe(false);
			expect(hasTaskPermission(config, 'critic')).toBe(false);
			expect(hasTaskPermission(config, 'test_engineer')).toBe(false);
			expect(hasTaskPermission(config, 'docs')).toBe(false);
		});
	});

	describe('Swarm-prefixed architect names (legitimate use case)', () => {
		it('should grant task permission for cloud_architect (cloud swarm)', () => {
			const config = getAgentConfigs(
				minimalConfig({
					swarms: {
						cloud: { name: 'Cloud Swarm', agents: {} },
					},
				}),
			);
			expect(hasTaskPermission(config, 'cloud_architect')).toBe(true);
			expect(isPrimaryMode(config, 'cloud_architect')).toBe(true);
		});

		it('should grant task permission for local_architect (local swarm)', () => {
			const config = getAgentConfigs(
				minimalConfig({
					swarms: {
						local: { name: 'Local Swarm', agents: {} },
					},
				}),
			);
			expect(hasTaskPermission(config, 'local_architect')).toBe(true);
			expect(isPrimaryMode(config, 'local_architect')).toBe(true);
		});

		it('should grant task permission for mega_architect (mega swarm)', () => {
			const config = getAgentConfigs(
				minimalConfig({
					swarms: {
						mega: { name: 'Mega Swarm', agents: {} },
					},
				}),
			);
			expect(hasTaskPermission(config, 'mega_architect')).toBe(true);
			expect(isPrimaryMode(config, 'mega_architect')).toBe(true);
		});

		it('should grant task permission for paid_architect (paid swarm)', () => {
			const config = getAgentConfigs(
				minimalConfig({
					swarms: {
						paid: { name: 'Paid Swarm', agents: {} },
					},
				}),
			);
			expect(hasTaskPermission(config, 'paid_architect')).toBe(true);
			expect(isPrimaryMode(config, 'paid_architect')).toBe(true);
		});

		it('should NOT grant task permission to swarm-prefixed non-architects', () => {
			const config = getAgentConfigs(
				minimalConfig({
					swarms: {
						cloud: { name: 'Cloud Swarm', agents: {} },
					},
				}),
			);
			// All non-architect agents should remain subagents without task permission
			expect(hasTaskPermission(config, 'cloud_coder')).toBe(false);
			expect(hasTaskPermission(config, 'cloud_reviewer')).toBe(false);
			expect(hasTaskPermission(config, 'cloud_explorer')).toBe(false);
			expect(hasTaskPermission(config, 'cloud_sme')).toBe(false);
			expect(hasTaskPermission(config, 'cloud_critic')).toBe(false);
			expect(hasTaskPermission(config, 'cloud_test_engineer')).toBe(false);
			expect(hasTaskPermission(config, 'cloud_docs')).toBe(false);
		});
	});

	describe('String matching logic edge cases (endsWith behavior)', () => {
		// These test the underlying string logic that determines permission

		const testCases = [
			// [name, expectedMatch, description]
			['architect', true, 'exact match'],
			['cloud_architect', true, 'prefix_architect (legitimate swarm)'],
			['architect_', false, 'trailing underscore'],
			['architect_extra', false, 'contains but not suffix'],
			['architect_coder', false, 'contains architect in middle'],
			['not_an_architect', true, 'contains _architect as suffix (ISSUE)'],
			['architected', false, 'no underscore separator'],
			['my_architect_role', false, 'different suffix'],
			['ARCHITECT', false, 'uppercase - case sensitive'],
			['Architect', false, 'title case - case sensitive'],
			['ARCHITECT_architect', true, 'ends with lowercase _architect'],
			['_architect', true, 'leading underscore (suspicious)'],
			['__architect', true, 'double leading underscore (ends with _architect)'],
			[
				'_____architect',
				true,
				'multiple leading underscores (ends with _architect)',
			],
			['architect_____', false, 'multiple trailing underscores'],
			['architecture', false, 'similar but no underscore'],
			['architektt', false, 'typo'],
			['', false, 'empty string'],
		] as const;

		testCases.forEach(([name, expectedMatch, description]) => {
			it(`should ${expectedMatch ? 'match' : 'NOT match'}: "${name}" (${description})`, () => {
				// Test the exact condition from getAgentConfigs line 342
				const matches = name === 'architect' || name.endsWith('_architect');
				expect(matches).toBe(expectedMatch);
			});
		});
	});

	describe('Potential permission leakage vectors', () => {
		it('should NOT leak task permission to designer (opt-in agent)', () => {
			const config = getAgentConfigs(
				minimalConfig({
					ui_review: { enabled: true, trigger_paths: [], trigger_keywords: [] },
				}),
			);
			expect(hasTaskPermission(config, 'designer')).toBe(false);
		});

		it('should NOT leak task permission even with custom agent config', () => {
			const config = getAgentConfigs(
				minimalConfig({
					agents: {
						coder: { model: 'gpt-4' },
						reviewer: { model: 'gpt-4' },
					},
				}),
			);
			// Custom config should not affect permission
			expect(hasTaskPermission(config, 'coder')).toBe(false);
			expect(hasTaskPermission(config, 'reviewer')).toBe(false);
		});

		it('should NOT grant task permission in legacy single-swarm mode with prefix', () => {
			// Legacy mode uses 'default' swarm - no prefix
			const config = getAgentConfigs(
				minimalConfig({
					agents: {
						architect: { model: 'gpt-4' },
					},
				}),
			);
			expect(hasTaskPermission(config, 'architect')).toBe(true);
			// But any prefixed names shouldn't appear
			expect(config.local_architect).toBeUndefined();
		});
	});

	describe('Multiple swarm interaction edge cases', () => {
		it('should correctly handle multiple swarms with different prefixes', () => {
			const config = getAgentConfigs(
				minimalConfig({
					swarms: {
						local: { name: 'Local', agents: {} },
						cloud: { name: 'Cloud', agents: {} },
						mega: { name: 'Mega', agents: {} },
					},
				}),
			);

			// All three swarm architects should have permission
			expect(hasTaskPermission(config, 'local_architect')).toBe(true);
			expect(hasTaskPermission(config, 'cloud_architect')).toBe(true);
			expect(hasTaskPermission(config, 'mega_architect')).toBe(true);

			// But non-architects should not
			expect(hasTaskPermission(config, 'local_coder')).toBe(false);
			expect(hasTaskPermission(config, 'cloud_coder')).toBe(false);
			expect(hasTaskPermission(config, 'mega_coder')).toBe(false);
		});

		it('should handle "architect" as swarm name (edge case)', () => {
			// What if someone names a swarm "architect"?
			const config = getAgentConfigs(
				minimalConfig({
					swarms: {
						architect: { name: 'Architect Swarm', agents: {} },
					},
				}),
			);
			// The agent would be named "architect_architect" which ends with _architect
			// So it would get permission - this is correct behavior
			expect(hasTaskPermission(config, 'architect_architect')).toBe(true);
		});
	});

	describe('Permission object structure validation', () => {
		it('should grant task:allow to architect agents (last entry of their block)', () => {
			const config = getAgentConfigs(undefined);
			// Since #2528 the permission block also carries per-agent tool
			// denies; the delegation grant is the LAST entry (findLast wins).
			const permission = config.architect?.permission as Record<string, string>;
			expect(permission.task).toBe('allow');
			expect(Object.keys(permission).at(-1)).toBe('task');
		});

		it('should not grant task to non-architect agents', () => {
			const config = getAgentConfigs(undefined);
			// Non-architects get a permission block (their tool denies) but
			// never a task entry.
			expect(
				(config.coder?.permission as Record<string, unknown>)?.task,
			).toBeUndefined();
		});

		it('should set mode to "primary" for architect, "subagent" for others', () => {
			const config = getAgentConfigs(undefined);
			expect(config.architect?.mode).toBe('primary');
			expect(config.coder?.mode).toBe('subagent');
			expect(config.reviewer?.mode).toBe('subagent');
		});
	});
});
