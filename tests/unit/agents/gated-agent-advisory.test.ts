/**
 * Tests for gated-agent config-but-no-flag advisory. Issue #1914 Defect 3.
 *
 * Covers designer (ui_review.enabled), docs_design (design_docs.enabled), and
 * council_{generalist,skeptic,domain_expert} (council.general.enabled).
 * Verifies the advisory fires when the agent is configured but the enabling
 * flag is OFF, and does NOT fire when the flag is ON or the agent is explicitly
 * disabled. Also covers cross-swarm dedupe.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import { createAgents } from '../../../src/agents/index';
import type { PluginConfig } from '../../../src/config';
import { resetSwarmState } from '../../../src/state';

describe('gated-agent config advisory — issue #1914 Defect 3', () => {
	beforeEach(() => {
		resetSwarmState();
		clearDeferredWarnings();
	});

	afterEach(() => {
		resetSwarmState();
		clearDeferredWarnings();
	});

	describe('designer / ui_review', () => {
		test('agents.designer configured + ui_review.enabled absent → advisory fires naming ui_review.enabled', () => {
			const config = {
				agents: { designer: { model: 'some-model' } },
			} as PluginConfig;
			createAgents(config);
			const warnings = getDeferredWarnings().join('\n');
			expect(warnings).toContain('agents.designer is configured');
			expect(warnings).toContain('ui_review.enabled is not true');
			expect(warnings).toContain('"ui_review": { "enabled": true }');
		});

		test('agents.designer configured + ui_review.enabled: true → no advisory; designer registered', () => {
			const config = {
				ui_review: { enabled: true },
				agents: { designer: { model: 'some-model' } },
			} as PluginConfig;
			const agents = createAgents(config);
			const warnings = getDeferredWarnings().join('\n');
			expect(warnings).not.toContain('agents.designer is configured');
			expect(agents.map((a) => a.name)).toContain('designer');
		});

		test('agents.designer configured + disabled: true → no advisory', () => {
			const config = {
				agents: { designer: { disabled: true } },
			} as PluginConfig;
			createAgents(config);
			const warnings = getDeferredWarnings().join('\n');
			expect(warnings).not.toContain('agents.designer is configured');
		});

		test('no agents.designer + ui_review.enabled absent → no advisory', () => {
			const config = {} as PluginConfig;
			createAgents(config);
			const warnings = getDeferredWarnings().join('\n');
			expect(warnings).not.toContain('agents.designer is configured');
		});

		test('agents.designer configured + ui_review.enabled: false → advisory fires', () => {
			const config = {
				ui_review: { enabled: false },
				agents: { designer: { model: 'some-model' } },
			} as PluginConfig;
			createAgents(config);
			const warnings = getDeferredWarnings().join('\n');
			expect(warnings).toContain('agents.designer is configured');
		});
	});

	describe('docs_design / design_docs', () => {
		test('agents.docs_design configured + design_docs.enabled absent → advisory fires', () => {
			const config = {
				agents: { docs_design: { model: 'some-model' } },
			} as PluginConfig;
			createAgents(config);
			const warnings = getDeferredWarnings().join('\n');
			expect(warnings).toContain('agents.docs_design is configured');
			expect(warnings).toContain('design_docs.enabled is not true');
		});

		test('agents.docs_design configured + design_docs.enabled: true → no advisory; registered', () => {
			const config = {
				design_docs: { enabled: true },
				agents: { docs_design: { model: 'some-model' } },
			} as PluginConfig;
			const agents = createAgents(config);
			const warnings = getDeferredWarnings().join('\n');
			expect(warnings).not.toContain('agents.docs_design is configured');
			expect(agents.map((a) => a.name)).toContain('docs_design');
		});

		test('agents.docs_design configured + disabled: true → no advisory', () => {
			const config = {
				agents: { docs_design: { disabled: true } },
			} as PluginConfig;
			createAgents(config);
			const warnings = getDeferredWarnings().join('\n');
			expect(warnings).not.toContain('agents.docs_design is configured');
		});
	});

	describe('council_* / council.general.enabled', () => {
		test('one council_* configured + council.general.enabled absent → advisory fires once', () => {
			const config = {
				agents: { council_generalist: { model: 'some-model' } },
			} as PluginConfig;
			createAgents(config);
			const matching = getDeferredWarnings().filter((w) =>
				w.includes('council_{generalist,skeptic,domain_expert} are configured'),
			);
			expect(matching.length).toBe(1);
			expect(matching[0]).toContain('council.general.enabled is not true');
		});

		test('all three council_* configured + council.general.enabled absent → single advisory', () => {
			const config = {
				agents: {
					council_generalist: { model: 'a' },
					council_skeptic: { model: 'b' },
					council_domain_expert: { model: 'c' },
				},
			} as PluginConfig;
			createAgents(config);
			const matching = getDeferredWarnings().filter((w) =>
				w.includes('council_{generalist,skeptic,domain_expert} are configured'),
			);
			expect(matching.length).toBe(1);
		});

		test('one council_* configured + council.general.enabled: true → no advisory', () => {
			const config = {
				council: { general: { enabled: true } },
				agents: { council_generalist: { model: 'some-model' } },
			} as PluginConfig;
			createAgents(config);
			const warnings = getDeferredWarnings().join('\n');
			expect(warnings).not.toContain('council_');
		});

		test('one council_* configured with disabled:true (others absent) → no advisory', () => {
			// The v2 false-positive case: the per-agent "configured AND not disabled"
			// disjunction ensures this does NOT fire.
			const config = {
				agents: { council_generalist: { disabled: true } },
			} as PluginConfig;
			createAgents(config);
			const warnings = getDeferredWarnings().join('\n');
			expect(warnings).not.toContain('council_{generalist');
		});

		test('all three council_* disabled → no advisory', () => {
			const config = {
				agents: {
					council_generalist: { disabled: true },
					council_skeptic: { disabled: true },
					council_domain_expert: { disabled: true },
				},
			} as PluginConfig;
			createAgents(config);
			const warnings = getDeferredWarnings().join('\n');
			expect(warnings).not.toContain('council_{generalist');
		});

		test('no council_* configured → no advisory', () => {
			const config = {} as PluginConfig;
			createAgents(config);
			const warnings = getDeferredWarnings().join('\n');
			expect(warnings).not.toContain('council_{generalist');
		});
	});

	describe('multi-swarm dedupe', () => {
		test('multi-swarm config with top-level agents.designer + ui_review off → advisory fires once per createAgents call', () => {
			// Top-level config.agents is merged into every swarm before
			// createSwarmAgents runs. Without dedupe the advisory would fire
			// once per swarm (2x for 2 swarms). With dedupe it fires exactly
			// once per createAgents call.
			const config = {
				ui_review: { enabled: false },
				agents: { designer: { model: 'some-model' } },
				swarms: {
					default: { name: 'Default' },
					cloud: { name: 'Cloud' },
				},
			} as PluginConfig;
			createAgents(config);
			const matching = getDeferredWarnings().filter((w) =>
				w.includes('agents.designer is configured'),
			);
			expect(matching.length).toBe(1);
		});

		test('multi-swarm config with top-level agents.docs_design + design_docs off → advisory fires once', () => {
			const config = {
				agents: { docs_design: { model: 'some-model' } },
				swarms: {
					default: { name: 'Default' },
					cloud: { name: 'Cloud' },
				},
			} as PluginConfig;
			createAgents(config);
			const matching = getDeferredWarnings().filter((w) =>
				w.includes('agents.docs_design is configured'),
			);
			expect(matching.length).toBe(1);
		});

		test('multi-swarm config with council_* configured → advisory fires once', () => {
			const config = {
				agents: { council_generalist: { model: 'some-model' } },
				swarms: {
					default: { name: 'Default' },
					cloud: { name: 'Cloud' },
				},
			} as PluginConfig;
			createAgents(config);
			const matching = getDeferredWarnings().filter((w) =>
				w.includes('council_{generalist,skeptic,domain_expert} are configured'),
			);
			expect(matching.length).toBe(1);
		});

		test('advisory re-emits on a second createAgents call (dedupe cleared at entry)', () => {
			// The dedupe Set is cleared at createAgents entry so tests calling
			// createAgents repeatedly get correct isolation.
			const config = {
				agents: { designer: { model: 'some-model' } },
			} as PluginConfig;
			createAgents(config);
			createAgents(config);
			const matching = getDeferredWarnings().filter((w) =>
				w.includes('agents.designer is configured'),
			);
			// Two calls → two advisories (one per call). Plugin init behaves
			// the same way (calls createAgents twice); this is the accepted
			// cosmetic-duplicate behavior.
			expect(matching.length).toBe(2);
		});

		test('advisory routes through advisoryWarn (quiet=false) and still buffers the warning', () => {
			// The quiet ternary inside emitGatedAgentAdvisory calls advisoryWarn
			// when quiet=false. advisoryWarn funnels through addDeferredWarning
			// (services/warning-buffer.ts:152), so the warning still appears in
			// getDeferredWarnings() — this test covers the !quiet branch.
			const config = {
				quiet: false,
				agents: { designer: { model: 'some-model' } },
			} as PluginConfig;
			createAgents(config);
			const matching = getDeferredWarnings().filter((w) =>
				w.includes('agents.designer is configured'),
			);
			expect(matching.length).toBe(1);
		});
	});
});
