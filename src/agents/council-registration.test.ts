/**
 * Integration tests for council agent registration in src/agents/index.ts.
 *
 * Pins two behaviors that the council-mode refactor (commit c7e3be4) intends
 * to guarantee:
 *
 * 1. Model resolution regression test — `council_generalist` / `council_skeptic`
 *    / `council_domain_expert` MUST source their models from the user's
 *    configured `agents.reviewer.model` / `agents.critic.model` /
 *    `agents.sme.model` overrides, not from a hardcoded DEFAULT_MODELS
 *    fallback. This pins the fix for the original bug where
 *    `getModel('council_member')` always fell back to
 *    DEFAULT_MODELS.council_member because no swarm config ever had a
 *    `council_member` entry.
 *
 * 2. Deprecation warning pathway test — setting
 *    `council.general.moderatorModel` MUST surface a deferred deprecation
 *    warning at agent-creation time. The legacy `council.general.moderator`
 *    field is NOT checked because the strict schema applies a default of
 *    `true` to it, and the warning would then fire for every council user
 *    (real bug fixed in commit eee5977).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PluginConfig } from '../config';
import { deferredWarnings } from '../services/warning-buffer.js';
import { createAgents } from './index';

// Bypass the strict schema for these focused unit tests — we want to feed
// the registration code minimal, hand-crafted configs without re-writing
// every schema default.
const config = (partial: Record<string, unknown>): PluginConfig =>
	partial as unknown as PluginConfig;

const COUNCIL_AGENTS = [
	'council_generalist',
	'council_skeptic',
	'council_domain_expert',
] as const;

beforeEach(() => {
	// deferredWarnings is module-scoped; clear before each test to avoid
	// cross-test bleed.
	deferredWarnings.length = 0;
});

afterEach(() => {
	deferredWarnings.length = 0;
});

describe('council agent registration — model resolution', () => {
	test('all three council agents are registered when council.general.enabled === true', () => {
		const agents = createAgents(
			config({
				council: { general: { enabled: true } },
				quiet: true,
			}),
		);
		const names = new Set(agents.map((a) => a.name));
		for (const name of COUNCIL_AGENTS) {
			expect(names.has(name)).toBe(true);
		}
	});

	test('no council agents are registered when council.general.enabled is absent', () => {
		const agents = createAgents(config({ quiet: true }));
		const names = new Set(agents.map((a) => a.name));
		for (const name of COUNCIL_AGENTS) {
			expect(names.has(name)).toBe(false);
		}
	});

	test('council_generalist sources its model from agents.reviewer.model (not DEFAULT_MODELS)', () => {
		const agents = createAgents(
			config({
				council: { general: { enabled: true } },
				agents: {
					reviewer: { model: 'custom-org/reviewer-model' },
				},
				quiet: true,
			}),
		);
		const generalist = agents.find((a) => a.name === 'council_generalist');
		expect(generalist).toBeDefined();
		expect(generalist?.config.model).toBe('custom-org/reviewer-model');
	});

	test('council_skeptic sources its model from agents.critic.model (not DEFAULT_MODELS)', () => {
		const agents = createAgents(
			config({
				council: { general: { enabled: true } },
				agents: {
					critic: { model: 'custom-org/critic-model' },
				},
				quiet: true,
			}),
		);
		const skeptic = agents.find((a) => a.name === 'council_skeptic');
		expect(skeptic).toBeDefined();
		expect(skeptic?.config.model).toBe('custom-org/critic-model');
	});

	test('council_domain_expert sources its model from agents.sme.model (not DEFAULT_MODELS)', () => {
		const agents = createAgents(
			config({
				council: { general: { enabled: true } },
				agents: {
					sme: { model: 'custom-org/sme-model' },
				},
				quiet: true,
			}),
		);
		const expert = agents.find((a) => a.name === 'council_domain_expert');
		expect(expert).toBeDefined();
		expect(expert?.config.model).toBe('custom-org/sme-model');
	});

	test('all three council agents respect their respective model overrides simultaneously', () => {
		const agents = createAgents(
			config({
				council: { general: { enabled: true } },
				agents: {
					reviewer: { model: 'reviewer-model-A' },
					critic: { model: 'critic-model-B' },
					sme: { model: 'sme-model-C' },
				},
				quiet: true,
			}),
		);
		expect(
			agents.find((a) => a.name === 'council_generalist')?.config.model,
		).toBe('reviewer-model-A');
		expect(agents.find((a) => a.name === 'council_skeptic')?.config.model).toBe(
			'critic-model-B',
		);
		expect(
			agents.find((a) => a.name === 'council_domain_expert')?.config.model,
		).toBe('sme-model-C');
	});
});

describe('council agent registration — deprecation warning pathway', () => {
	test('setting council.general.moderatorModel surfaces the deprecation warning', () => {
		createAgents(
			config({
				council: {
					general: {
						enabled: true,
						moderatorModel: 'some-legacy-model',
					},
				},
				quiet: true,
			}),
		);
		const matched = deferredWarnings.filter((w) =>
			w.includes('council.general.moderatorModel is deprecated'),
		);
		expect(matched.length).toBeGreaterThan(0);
	});

	test('omitting moderatorModel does NOT surface the deprecation warning (no false positive)', () => {
		createAgents(
			config({
				council: { general: { enabled: true } },
				quiet: true,
			}),
		);
		const matched = deferredWarnings.filter((w) =>
			w.includes('council.general.moderatorModel is deprecated'),
		);
		expect(matched.length).toBe(0);
	});

	test('setting only the legacy moderator boolean does NOT spam the warning', () => {
		// The schema default for `moderator` is `true`, so checking that field
		// directly would fire for every council user. We pin that the warning
		// stays silent when only `moderator` is set (and `moderatorModel` is
		// not), matching the post-eee5977 fix.
		createAgents(
			config({
				council: { general: { enabled: true, moderator: true } },
				quiet: true,
			}),
		);
		const matched = deferredWarnings.filter((w) =>
			w.includes('council.general.moderatorModel is deprecated'),
		);
		expect(matched.length).toBe(0);
	});
});

describe('council agent registration — reduced-council warning (councilAgentsCreated < 3)', () => {
	test('no council-reduction warning when all three base agents are enabled', () => {
		createAgents(
			config({
				council: { general: { enabled: true } },
				quiet: true,
			}),
		);
		const matched = deferredWarnings.filter((w) =>
			w.includes('council agents could be registered'),
		);
		expect(matched.length).toBe(0);
	});

	test('fires warning listing council_generalist when reviewer is disabled', () => {
		createAgents(
			config({
				council: { general: { enabled: true } },
				agents: { reviewer: { disabled: true } },
				quiet: true,
			}),
		);
		const matched = deferredWarnings.filter((w) =>
			w.includes('council agents could be registered'),
		);
		expect(matched.length).toBeGreaterThan(0);
		expect(matched[0]).toContain('council_generalist (requires reviewer)');
		expect(matched[0]).toContain('2/3');
	});

	test('fires warning listing council_skeptic when critic is disabled', () => {
		createAgents(
			config({
				council: { general: { enabled: true } },
				agents: { critic: { disabled: true } },
				quiet: true,
			}),
		);
		const matched = deferredWarnings.filter((w) =>
			w.includes('council agents could be registered'),
		);
		expect(matched.length).toBeGreaterThan(0);
		expect(matched[0]).toContain('council_skeptic (requires critic)');
		expect(matched[0]).toContain('2/3');
	});

	test('fires warning listing council_domain_expert when sme is disabled', () => {
		createAgents(
			config({
				council: { general: { enabled: true } },
				agents: { sme: { disabled: true } },
				quiet: true,
			}),
		);
		const matched = deferredWarnings.filter((w) =>
			w.includes('council agents could be registered'),
		);
		expect(matched.length).toBeGreaterThan(0);
		expect(matched[0]).toContain('council_domain_expert (requires sme)');
		expect(matched[0]).toContain('2/3');
	});

	test('when all three base agents are disabled, zero council agents are registered and warning lists all three', () => {
		const agents = createAgents(
			config({
				council: { general: { enabled: true } },
				agents: {
					reviewer: { disabled: true },
					critic: { disabled: true },
					sme: { disabled: true },
				},
				quiet: true,
			}),
		);
		// No council agents registered
		const councilAgents = agents.filter((a) =>
			COUNCIL_AGENTS.includes(a.name as (typeof COUNCIL_AGENTS)[number]),
		);
		expect(councilAgents).toHaveLength(0);
		// Warning names all three missing roles and shows 0/3
		const matched = deferredWarnings.filter((w) =>
			w.includes('council agents could be registered'),
		);
		expect(matched.length).toBeGreaterThan(0);
		const warning = matched[0];
		expect(warning).toContain('0/3');
		expect(warning).toContain('council_generalist (requires reviewer)');
		expect(warning).toContain('council_skeptic (requires critic)');
		expect(warning).toContain('council_domain_expert (requires sme)');
	});

	test('fires warning for a named swarm when its reviewer is disabled (isAgentDisabled with swarmPrefix)', () => {
		// In multi-swarm mode the swarm prefix is prepended to agent names.
		// isAgentDisabled must correctly strip the prefix before looking up swarmAgents.
		createAgents(
			config({
				swarms: {
					local: {
						name: 'Local',
						agents: { reviewer: { disabled: true } },
					},
				},
				council: { general: { enabled: true } },
				quiet: true,
			}),
		);
		const matched = deferredWarnings.filter((w) =>
			w.includes('council agents could be registered'),
		);
		expect(matched.length).toBeGreaterThan(0);
		expect(matched[0]).toContain('council_generalist (requires reviewer)');
	});
});
