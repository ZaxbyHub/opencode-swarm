import { describe, expect, it } from 'bun:test';
import {
	DEFAULT_SCORING_CONFIG,
	resolveScoringConfig,
} from '../../../src/config/constants';
import {
	AgentOverrideConfigSchema,
	ContextBudgetConfigSchema,
	CouncilConfigSchema,
	DecisionDecaySchema,
	GeneralCouncilConfigSchema,
	GuardrailsConfigSchema,
	PipelineConfigSchema,
	PluginConfigSchema,
	ScoringConfigSchema,
	ScoringWeightsSchema,
	SwarmConfigSchema,
	stripKnownSwarmPrefix,
	TokenRatiosSchema,
} from '../../../src/config/schema';

describe('AgentOverrideConfigSchema', () => {
	it('accepts empty object {}', () => {
		const result = AgentOverrideConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({});
		}
	});

	it('accepts valid model string', () => {
		const originalWarn = console.warn;
		console.warn = () => {};
		const result = AgentOverrideConfigSchema.safeParse({ model: 'gpt-4' });
		console.warn = originalWarn;
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({ model: 'gpt-4' });
		}
	});

	it('accepts temperature at boundaries: 0', () => {
		const result = AgentOverrideConfigSchema.safeParse({ temperature: 0 });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({ temperature: 0 });
		}
	});

	it('accepts temperature at boundaries: 1', () => {
		const result = AgentOverrideConfigSchema.safeParse({ temperature: 1 });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({ temperature: 1 });
		}
	});

	it('accepts temperature at boundaries: 2', () => {
		const result = AgentOverrideConfigSchema.safeParse({ temperature: 2 });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({ temperature: 2 });
		}
	});

	it('rejects temperature below 0', () => {
		const result = AgentOverrideConfigSchema.safeParse({ temperature: -1 });
		expect(result.success).toBe(false);
	});

	it('rejects temperature above 2', () => {
		const result = AgentOverrideConfigSchema.safeParse({ temperature: 3 });
		expect(result.success).toBe(false);
	});

	it('accepts disabled boolean', () => {
		const result = AgentOverrideConfigSchema.safeParse({ disabled: true });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({ disabled: true });
		}
	});

	it('rejects non-string model', () => {
		const result = AgentOverrideConfigSchema.safeParse({ model: 123 });
		expect(result.success).toBe(false);
	});

	it('rejects non-number temperature', () => {
		const result = AgentOverrideConfigSchema.safeParse({
			temperature: 'invalid',
		});
		expect(result.success).toBe(false);
	});

	it('rejects non-boolean disabled', () => {
		const result = AgentOverrideConfigSchema.safeParse({ disabled: 'true' });
		expect(result.success).toBe(false);
	});

	// Fallback models validation tests
	it('parses without side effects when model is set without fallback_models', () => {
		// The schema no longer emits console.warn itself; the advisory is collected
		// and emitted once at plugin initialization to avoid per-agent spam.
		const originalWarn = console.warn;
		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(String(args[0]));
		};

		const result = AgentOverrideConfigSchema.safeParse({
			model: 'custom-model',
		});

		console.warn = originalWarn;

		expect(result.success).toBe(true);
		expect(result.data?.model).toBe('custom-model');
		expect(result.data?.fallback_models).toBeUndefined();
		// Schema itself must not emit any warnings — advisory lives in initializeOpenCodeSwarm
		expect(warnings.length).toBe(0);
	});

	it('does not warn when model is set with fallback_models', () => {
		const originalWarn = console.warn;
		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(String(args[0]));
		};

		const result = AgentOverrideConfigSchema.safeParse({
			model: 'custom-model',
			fallback_models: ['fallback-1', 'fallback-2'],
		});

		console.warn = originalWarn;

		expect(result.success).toBe(true);
		expect(warnings.some((w) => w.includes('fallback_models'))).toBe(false);
	});

	it('does not warn when fallback_models is set without model', () => {
		const originalWarn = console.warn;
		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(String(args[0]));
		};

		const result = AgentOverrideConfigSchema.safeParse({
			fallback_models: ['fallback-1', 'fallback-2'],
		});

		console.warn = originalWarn;

		expect(result.success).toBe(true);
		expect(warnings.some((w) => w.includes('fallback_models'))).toBe(false);
	});

	it('does not warn when neither model nor fallback_models is set', () => {
		const originalWarn = console.warn;
		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(String(args[0]));
		};

		const result = AgentOverrideConfigSchema.safeParse({
			temperature: 0.7,
		});

		console.warn = originalWarn;

		expect(result.success).toBe(true);
		expect(warnings.some((w) => w.includes('fallback_models'))).toBe(false);
	});

	it('accepts empty fallback_models array (schema-valid; plugin-init warning catches it)', () => {
		// fallback_models:[] is schema-valid but provides no runtime protection.
		// The consolidated warning in initializeOpenCodeSwarm checks length===0
		// and treats it identically to undefined.
		const result = AgentOverrideConfigSchema.safeParse({
			model: 'custom-model',
			fallback_models: [],
		});
		expect(result.success).toBe(true);
		expect(result.data?.fallback_models).toEqual([]);
	});

	// Variant (reasoning-effort) field tests
	it('accepts variant field with model', () => {
		const result = AgentOverrideConfigSchema.safeParse({
			model: 'grove-openai/gpt-5.3-codex',
			variant: 'medium',
			fallback_models: ['fallback-1'],
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.variant).toBe('medium');
			expect(result.data.model).toBe('grove-openai/gpt-5.3-codex');
		}
	});

	it('accepts variant field without model', () => {
		const result = AgentOverrideConfigSchema.safeParse({ variant: 'high' });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.variant).toBe('high');
			expect(result.data.model).toBeUndefined();
		}
	});

	it('rejects empty-string variant', () => {
		const result = AgentOverrideConfigSchema.safeParse({ variant: '' });
		expect(result.success).toBe(false);
	});

	it('rejects non-string variant', () => {
		const result = AgentOverrideConfigSchema.safeParse({ variant: 5 });
		expect(result.success).toBe(false);
	});

	it('omits variant when not set', () => {
		const result = AgentOverrideConfigSchema.safeParse({ model: 'm' });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.variant).toBeUndefined();
		}
	});

	it('accepts valid fallback_models array with up to 3 items', () => {
		const result = AgentOverrideConfigSchema.safeParse({
			fallback_models: ['fallback-1', 'fallback-2', 'fallback-3'],
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.fallback_models).toHaveLength(3);
		}
	});

	it('rejects fallback_models array with more than 3 items', () => {
		const result = AgentOverrideConfigSchema.safeParse({
			fallback_models: ['fallback-1', 'fallback-2', 'fallback-3', 'fallback-4'],
		});
		expect(result.success).toBe(false);
	});

	it('rejects fallback_models if not an array', () => {
		const result = AgentOverrideConfigSchema.safeParse({
			fallback_models: 'fallback-1',
		});
		expect(result.success).toBe(false);
	});
});

describe('SwarmConfigSchema', () => {
	it('accepts empty object {}', () => {
		const result = SwarmConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({});
		}
	});

	it('accepts name string', () => {
		const result = SwarmConfigSchema.safeParse({ name: 'Cloud Swarm' });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({ name: 'Cloud Swarm' });
		}
	});

	it('accepts agents record with valid overrides', () => {
		const config = {
			agents: {
				architect: { model: 'gpt-4', temperature: 0.7 },
				coder: { disabled: true },
			},
		};
		const result = SwarmConfigSchema.safeParse(config);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual(config);
		}
	});

	it('rejects invalid agent override values', () => {
		const config = {
			agents: {
				architect: { temperature: 'invalid' },
			},
		};
		const result = SwarmConfigSchema.safeParse(config);
		expect(result.success).toBe(false);
	});
});

describe('PluginConfigSchema', () => {
	it('accepts empty object {} and applies defaults (max_iterations=5, qa_retry_limit=3, inject_phase_reminders=true)', () => {
		const result = PluginConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			// adversarial_testing has a schema-level default so it appears in the output.
			// default_agent is intentionally optional with NO schema default — see
			// src/config/schema.ts for the full rationale (issue: multi-swarm
			// prefixed architects disappearing from OpenCode after v7.3.x).
			// Top-level non-full_auto fields stay strict; full_auto is asserted by
			// shape (legacy v1 fields exact, v2 fields presence-checked) so future
			// v2 additions don't break this test.
			expect(result.data.max_iterations).toBe(5);
			expect(result.data.qa_retry_limit).toBe(3);
			expect(result.data.inject_phase_reminders).toBe(true);
			expect(result.data.execution_mode).toBe('balanced');
			expect(result.data.turbo_mode).toBe(false);
			expect(result.data.quiet).toBe(true);
			expect(result.data.version_check).toBe(true);
			expect(result.data.adversarial_testing).toEqual({
				enabled: true,
				scope: 'all',
			});
			expect(result.data.full_auto?.enabled).toBe(false);
			expect(result.data.full_auto?.max_interactions_per_phase).toBe(50);
			expect(result.data.full_auto?.deadlock_threshold).toBe(3);
			expect(result.data.full_auto?.escalation_mode).toBe('pause');
			expect(result.data.full_auto?.mode).toBe('supervised');
			expect(result.data.full_auto?.fail_closed).toBe(true);
			// default_agent is omitted from the output because no schema default
			// applies — distinguishing omitted from explicit "architect" is a
			// load-bearing semantic.
			expect(result.data.default_agent).toBeUndefined();
		}
	});

	it('accepts valid full config', () => {
		const config = {
			agents: {
				architect: { model: 'gpt-4', temperature: 0.7 },
				coder: { disabled: true },
			},
			swarms: {
				cloud: {
					name: 'Cloud Swarm',
					agents: {
						architect: { model: 'gpt-4' },
					},
				},
				local: {
					name: 'Local Swarm',
					agents: {
						coder: { model: 'claude-3' },
					},
				},
			},
			max_iterations: 8,
			qa_retry_limit: 5,
			inject_phase_reminders: false,
		};
		const result = PluginConfigSchema.safeParse(config);
		expect(result.success).toBe(true);
		if (result.success) {
			// adversarial_testing is added by default; check known fields individually
			expect(result.data.max_iterations).toBe(8);
			expect(result.data.qa_retry_limit).toBe(5);
			expect(result.data.inject_phase_reminders).toBe(false);
			expect(result.data.agents).toEqual(config.agents);
			expect(result.data.swarms).toEqual(config.swarms);
		}
	});

	it('rejects max_iterations below 1', () => {
		const result = PluginConfigSchema.safeParse({ max_iterations: 0 });
		expect(result.success).toBe(false);
	});

	it('rejects max_iterations above 10', () => {
		const result = PluginConfigSchema.safeParse({ max_iterations: 11 });
		expect(result.success).toBe(false);
	});

	it('accepts max_iterations at boundary: 1', () => {
		const result = PluginConfigSchema.safeParse({ max_iterations: 1 });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.max_iterations).toBe(1);
		}
	});

	it('accepts max_iterations at boundary: 10', () => {
		const result = PluginConfigSchema.safeParse({ max_iterations: 10 });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.max_iterations).toBe(10);
		}
	});

	it('rejects qa_retry_limit below 1', () => {
		const result = PluginConfigSchema.safeParse({ qa_retry_limit: 0 });
		expect(result.success).toBe(false);
	});

	it('rejects qa_retry_limit above 10', () => {
		const result = PluginConfigSchema.safeParse({ qa_retry_limit: 11 });
		expect(result.success).toBe(false);
	});

	it('accepts qa_retry_limit at boundary: 1', () => {
		const result = PluginConfigSchema.safeParse({ qa_retry_limit: 1 });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.qa_retry_limit).toBe(1);
		}
	});

	it('accepts qa_retry_limit at boundary: 10', () => {
		const result = PluginConfigSchema.safeParse({ qa_retry_limit: 10 });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.qa_retry_limit).toBe(10);
		}
	});

	it('rejects non-boolean inject_phase_reminders', () => {
		const result = PluginConfigSchema.safeParse({
			inject_phase_reminders: 'true',
		});
		expect(result.success).toBe(false);
	});

	// full_auto field tests
	it('full_auto defaults to { enabled: false } when omitted', () => {
		const result = PluginConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			// Legacy v1 fields preserved exactly.
			expect(result.data.full_auto?.enabled).toBe(false);
			expect(result.data.full_auto?.max_interactions_per_phase).toBe(50);
			expect(result.data.full_auto?.deadlock_threshold).toBe(3);
			expect(result.data.full_auto?.escalation_mode).toBe('pause');
			// v2 fields added: shape exists with safe defaults; do not lock the
			// full nested object so future v2 additions don't break this test.
			expect(result.data.full_auto?.mode).toBe('supervised');
			expect(result.data.full_auto?.fail_closed).toBe(true);
			expect(result.data.full_auto?.permission_policy?.enabled).toBe(true);
			expect(result.data.full_auto?.denials?.max_consecutive).toBe(3);
			expect(result.data.full_auto?.denials?.max_total).toBe(20);
		}
	});

	it('max_interactions_per_phase rejects values below 5', () => {
		const result = PluginConfigSchema.safeParse({
			full_auto: { max_interactions_per_phase: 4 },
		});
		expect(result.success).toBe(false);
	});

	it('max_interactions_per_phase rejects values above 200', () => {
		const result = PluginConfigSchema.safeParse({
			full_auto: { max_interactions_per_phase: 201 },
		});
		expect(result.success).toBe(false);
	});

	it('max_interactions_per_phase accepts boundary value 5', () => {
		const result = PluginConfigSchema.safeParse({
			full_auto: { max_interactions_per_phase: 5 },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.full_auto.max_interactions_per_phase).toBe(5);
		}
	});

	it('max_interactions_per_phase accepts boundary value 200', () => {
		const result = PluginConfigSchema.safeParse({
			full_auto: { max_interactions_per_phase: 200 },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.full_auto.max_interactions_per_phase).toBe(200);
		}
	});

	it('deadlock_threshold rejects values below 2', () => {
		const result = PluginConfigSchema.safeParse({
			full_auto: { deadlock_threshold: 1 },
		});
		expect(result.success).toBe(false);
	});

	it('deadlock_threshold rejects values above 10', () => {
		const result = PluginConfigSchema.safeParse({
			full_auto: { deadlock_threshold: 11 },
		});
		expect(result.success).toBe(false);
	});

	it('deadlock_threshold accepts boundary value 2', () => {
		const result = PluginConfigSchema.safeParse({
			full_auto: { deadlock_threshold: 2 },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.full_auto.deadlock_threshold).toBe(2);
		}
	});

	it('deadlock_threshold accepts boundary value 10', () => {
		const result = PluginConfigSchema.safeParse({
			full_auto: { deadlock_threshold: 10 },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.full_auto.deadlock_threshold).toBe(10);
		}
	});

	it('escalation_mode accepts "pause"', () => {
		const result = PluginConfigSchema.safeParse({
			full_auto: { escalation_mode: 'pause' },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.full_auto.escalation_mode).toBe('pause');
		}
	});

	it('escalation_mode accepts "terminate"', () => {
		const result = PluginConfigSchema.safeParse({
			full_auto: { escalation_mode: 'terminate' },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.full_auto.escalation_mode).toBe('terminate');
		}
	});

	it('escalation_mode rejects invalid string', () => {
		const result = PluginConfigSchema.safeParse({
			full_auto: { escalation_mode: 'invalid' },
		});
		expect(result.success).toBe(false);
	});

	it('critic_model accepts valid model string', () => {
		const result = PluginConfigSchema.safeParse({
			full_auto: { critic_model: 'gpt-4' },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.full_auto.critic_model).toBe('gpt-4');
		}
	});

	it('enabled: true is accepted when all other fields valid', () => {
		const result = PluginConfigSchema.safeParse({
			full_auto: {
				enabled: true,
				critic_model: 'claude-3-opus',
				max_interactions_per_phase: 100,
				deadlock_threshold: 5,
				escalation_mode: 'terminate',
			},
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.full_auto.enabled).toBe(true);
			expect(result.data.full_auto.critic_model).toBe('claude-3-opus');
			expect(result.data.full_auto.max_interactions_per_phase).toBe(100);
			expect(result.data.full_auto.deadlock_threshold).toBe(5);
			expect(result.data.full_auto.escalation_mode).toBe('terminate');
		}
	});

	it('accepts swarms record', () => {
		const config = {
			swarms: {
				default: {
					name: 'Default Swarm',
					agents: {
						architect: { model: 'gpt-4' },
					},
				},
				cloud: {
					name: 'Cloud Swarm',
					agents: {
						coder: { disabled: true },
					},
				},
			},
		};
		const result = PluginConfigSchema.safeParse(config);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.swarms).toEqual(config.swarms);
			expect(result.data.max_iterations).toBe(5); // Default applied
			expect(result.data.qa_retry_limit).toBe(3); // Default applied
			expect(result.data.inject_phase_reminders).toBe(true); // Default applied
		}
	});
});

describe('GuardrailsConfigSchema', () => {
	it('accepts empty object and applies all defaults', () => {
		const result = GuardrailsConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.enabled).toBe(true);
			expect(result.data.max_tool_calls).toBe(200);
			expect(result.data.max_duration_minutes).toBe(30);
			expect(result.data.max_repetitions).toBe(10);
			expect(result.data.max_consecutive_errors).toBe(5);
			expect(result.data.warning_threshold).toBe(0.75);
		}
	});

	it('accepts partial config and merges defaults', () => {
		const result = GuardrailsConfigSchema.safeParse({ max_tool_calls: 100 });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.max_tool_calls).toBe(100);
			expect(result.data.enabled).toBe(true); // Default
			expect(result.data.max_duration_minutes).toBe(30); // Default
			expect(result.data.max_repetitions).toBe(10); // Default
			expect(result.data.max_consecutive_errors).toBe(5); // Default
			expect(result.data.warning_threshold).toBe(0.75); // Default
		}
	});

	it('supports qa_gates defaults', () => {
		const result = GuardrailsConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.qa_gates).toBeUndefined();
		}
	});

	it('supports configurable qa_gates overrides', () => {
		const result = GuardrailsConfigSchema.safeParse({
			qa_gates: {
				required_tools: ['lint'],
				require_reviewer_test_engineer: false,
			},
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.qa_gates.required_tools).toEqual(['lint']);
			expect(result.data.qa_gates.require_reviewer_test_engineer).toBe(false);
		}
	});

	it('rejects max_tool_calls below 0', () => {
		const result = GuardrailsConfigSchema.safeParse({ max_tool_calls: -1 });
		expect(result.success).toBe(false);
	});

	it('allows max_tool_calls of 0 (unlimited)', () => {
		const result = GuardrailsConfigSchema.safeParse({ max_tool_calls: 0 });
		expect(result.success).toBe(true);
		expect(result.data?.max_tool_calls).toBe(0);
	});

	it('rejects max_tool_calls above 1000', () => {
		const result = GuardrailsConfigSchema.safeParse({ max_tool_calls: 1001 });
		expect(result.success).toBe(false);
	});

	it('rejects warning_threshold below 0.1', () => {
		const result = GuardrailsConfigSchema.safeParse({
			warning_threshold: 0.05,
		});
		expect(result.success).toBe(false);
	});

	it('rejects warning_threshold above 0.9', () => {
		const result = GuardrailsConfigSchema.safeParse({
			warning_threshold: 0.95,
		});
		expect(result.success).toBe(false);
	});

	it('accepts all boundary values (minimums)', () => {
		const result = GuardrailsConfigSchema.safeParse({
			max_tool_calls: 10,
			max_duration_minutes: 1,
			max_repetitions: 3,
			max_consecutive_errors: 2,
			warning_threshold: 0.1,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.max_tool_calls).toBe(10);
			expect(result.data.max_duration_minutes).toBe(1);
			expect(result.data.max_repetitions).toBe(3);
			expect(result.data.max_consecutive_errors).toBe(2);
			expect(result.data.warning_threshold).toBe(0.1);
		}
	});

	it('accepts all boundary values (maximums)', () => {
		const result = GuardrailsConfigSchema.safeParse({
			max_tool_calls: 1000,
			max_duration_minutes: 120,
			max_repetitions: 50,
			max_consecutive_errors: 20,
			warning_threshold: 0.9,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.max_tool_calls).toBe(1000);
			expect(result.data.max_duration_minutes).toBe(120);
			expect(result.data.max_repetitions).toBe(50);
			expect(result.data.max_consecutive_errors).toBe(20);
			expect(result.data.warning_threshold).toBe(0.9);
		}
	});
});

describe('ScoringWeightsSchema', () => {
	it('accepts empty object and applies all defaults', () => {
		const result = ScoringWeightsSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.phase).toBe(1.0);
			expect(result.data.current_task).toBe(2.0);
			expect(result.data.blocked_task).toBe(1.5);
			expect(result.data.recent_failure).toBe(2.5);
			expect(result.data.recent_success).toBe(0.5);
			expect(result.data.evidence_presence).toBe(1.0);
			expect(result.data.decision_recency).toBe(1.5);
			expect(result.data.dependency_proximity).toBe(1.0);
		}
	});

	it('accepts partial config and merges defaults', () => {
		const result = ScoringWeightsSchema.safeParse({
			phase: 2.0,
			current_task: 3.0,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.phase).toBe(2.0);
			expect(result.data.current_task).toBe(3.0);
			expect(result.data.blocked_task).toBe(1.5); // Default
			expect(result.data.recent_failure).toBe(2.5); // Default
		}
	});

	it('accepts weight at minimum boundary (0)', () => {
		const result = ScoringWeightsSchema.safeParse({ phase: 0 });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.phase).toBe(0);
		}
	});

	it('accepts weight at maximum boundary (5)', () => {
		const result = ScoringWeightsSchema.safeParse({ phase: 5 });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.phase).toBe(5);
		}
	});

	it('rejects weight below minimum (0)', () => {
		const result = ScoringWeightsSchema.safeParse({ phase: -0.1 });
		expect(result.success).toBe(false);
	});

	it('rejects weight above maximum (5)', () => {
		const result = ScoringWeightsSchema.safeParse({ phase: 5.1 });
		expect(result.success).toBe(false);
	});
});

describe('DecisionDecaySchema', () => {
	it('accepts empty object and applies all defaults', () => {
		const result = DecisionDecaySchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.mode).toBe('exponential');
			expect(result.data.half_life_hours).toBe(24);
		}
	});

	it('accepts valid mode "linear"', () => {
		const result = DecisionDecaySchema.safeParse({ mode: 'linear' });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.mode).toBe('linear');
			expect(result.data.half_life_hours).toBe(24); // Default
		}
	});

	it('accepts valid mode "exponential"', () => {
		const result = DecisionDecaySchema.safeParse({ mode: 'exponential' });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.mode).toBe('exponential');
		}
	});

	it('rejects invalid mode', () => {
		const result = DecisionDecaySchema.safeParse({ mode: 'invalid' });
		expect(result.success).toBe(false);
	});

	it('accepts half_life_hours at minimum boundary (1)', () => {
		const result = DecisionDecaySchema.safeParse({ half_life_hours: 1 });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.half_life_hours).toBe(1);
		}
	});

	it('accepts half_life_hours at maximum boundary (168)', () => {
		const result = DecisionDecaySchema.safeParse({ half_life_hours: 168 });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.half_life_hours).toBe(168);
		}
	});

	it('rejects half_life_hours below minimum (1)', () => {
		const result = DecisionDecaySchema.safeParse({ half_life_hours: 0 });
		expect(result.success).toBe(false);
	});

	it('rejects half_life_hours above maximum (168)', () => {
		const result = DecisionDecaySchema.safeParse({ half_life_hours: 169 });
		expect(result.success).toBe(false);
	});
});

describe('TokenRatiosSchema', () => {
	it('accepts empty object and applies all defaults', () => {
		const result = TokenRatiosSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.prose).toBe(0.25);
			expect(result.data.code).toBe(0.4);
			expect(result.data.markdown).toBe(0.3);
			expect(result.data.json).toBe(0.35);
		}
	});

	it('accepts partial config and merges defaults', () => {
		const result = TokenRatiosSchema.safeParse({ prose: 0.5, code: 0.6 });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.prose).toBe(0.5);
			expect(result.data.code).toBe(0.6);
			expect(result.data.markdown).toBe(0.3); // Default
			expect(result.data.json).toBe(0.35); // Default
		}
	});

	it('accepts ratio at minimum boundary (0.1)', () => {
		const result = TokenRatiosSchema.safeParse({ prose: 0.1 });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.prose).toBe(0.1);
		}
	});

	it('accepts ratio at maximum boundary (1.0)', () => {
		const result = TokenRatiosSchema.safeParse({ prose: 1.0 });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.prose).toBe(1.0);
		}
	});

	it('rejects ratio below minimum (0.1)', () => {
		const result = TokenRatiosSchema.safeParse({ prose: 0.05 });
		expect(result.success).toBe(false);
	});

	it('rejects ratio above maximum (1.0)', () => {
		const result = TokenRatiosSchema.safeParse({ prose: 1.1 });
		expect(result.success).toBe(false);
	});
});

describe('ScoringConfigSchema', () => {
	it('accepts empty object and applies all defaults', () => {
		const result = ScoringConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.enabled).toBe(false);
			expect(result.data.max_candidates).toBe(100);
			expect(result.data.weights).toBeUndefined();
			expect(result.data.decision_decay).toBeUndefined();
			expect(result.data.token_ratios).toBeUndefined();
		}
	});

	it('accepts enabled: true', () => {
		const result = ScoringConfigSchema.safeParse({ enabled: true });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.enabled).toBe(true);
			expect(result.data.max_candidates).toBe(100); // Default
		}
	});

	it('accepts max_candidates at minimum boundary (10)', () => {
		const result = ScoringConfigSchema.safeParse({ max_candidates: 10 });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.max_candidates).toBe(10);
		}
	});

	it('accepts max_candidates at maximum boundary (500)', () => {
		const result = ScoringConfigSchema.safeParse({ max_candidates: 500 });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.max_candidates).toBe(500);
		}
	});

	it('rejects max_candidates below minimum (10)', () => {
		const result = ScoringConfigSchema.safeParse({ max_candidates: 9 });
		expect(result.success).toBe(false);
	});

	it('rejects max_candidates above maximum (500)', () => {
		const result = ScoringConfigSchema.safeParse({ max_candidates: 501 });
		expect(result.success).toBe(false);
	});

	it('accepts nested weights config', () => {
		const result = ScoringConfigSchema.safeParse({
			weights: { phase: 2.0, current_task: 3.0 },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.weights?.phase).toBe(2.0);
			expect(result.data.weights?.current_task).toBe(3.0);
		}
	});

	it('accepts nested decision_decay config', () => {
		const result = ScoringConfigSchema.safeParse({
			decision_decay: { mode: 'linear', half_life_hours: 48 },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.decision_decay?.mode).toBe('linear');
			expect(result.data.decision_decay?.half_life_hours).toBe(48);
		}
	});

	it('accepts nested token_ratios config', () => {
		const result = ScoringConfigSchema.safeParse({
			token_ratios: { prose: 0.5, code: 0.6 },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.token_ratios?.prose).toBe(0.5);
			expect(result.data.token_ratios?.code).toBe(0.6);
		}
	});

	it('accepts full scoring config', () => {
		const result = ScoringConfigSchema.safeParse({
			enabled: true,
			max_candidates: 50,
			weights: {
				phase: 1.5,
				current_task: 2.5,
				blocked_task: 1.0,
				recent_failure: 3.0,
				recent_success: 0.25,
				evidence_presence: 1.2,
				decision_recency: 2.0,
				dependency_proximity: 0.8,
			},
			decision_decay: {
				mode: 'exponential',
				half_life_hours: 12,
			},
			token_ratios: {
				prose: 0.3,
				code: 0.5,
				markdown: 0.25,
				json: 0.4,
			},
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.enabled).toBe(true);
			expect(result.data.max_candidates).toBe(50);
			expect(result.data.weights?.phase).toBe(1.5);
			expect(result.data.decision_decay?.half_life_hours).toBe(12);
			expect(result.data.token_ratios?.code).toBe(0.5);
		}
	});
});

describe('ContextBudgetConfigSchema with scoring', () => {
	it('accepts context_budget without scoring block', () => {
		const result = ContextBudgetConfigSchema.safeParse({
			enabled: true,
			max_injection_tokens: 2000,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.enabled).toBe(true);
			expect(result.data.max_injection_tokens).toBe(2000);
			expect(result.data.scoring).toBeUndefined();
		}
	});

	it('accepts context_budget with scoring block', () => {
		const result = ContextBudgetConfigSchema.safeParse({
			enabled: true,
			scoring: {
				enabled: true,
				max_candidates: 200,
				weights: { phase: 1.5 },
			},
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.scoring?.enabled).toBe(true);
			expect(result.data.scoring?.max_candidates).toBe(200);
			expect(result.data.scoring?.weights?.phase).toBe(1.5);
		}
	});
});

describe('DEFAULT_SCORING_CONFIG', () => {
	it('has correct default values', () => {
		expect(DEFAULT_SCORING_CONFIG.enabled).toBe(false);
		expect(DEFAULT_SCORING_CONFIG.max_candidates).toBe(100);
		expect(DEFAULT_SCORING_CONFIG.weights.phase).toBe(1.0);
		expect(DEFAULT_SCORING_CONFIG.weights.current_task).toBe(2.0);
		expect(DEFAULT_SCORING_CONFIG.weights.blocked_task).toBe(1.5);
		expect(DEFAULT_SCORING_CONFIG.weights.recent_failure).toBe(2.5);
		expect(DEFAULT_SCORING_CONFIG.weights.recent_success).toBe(0.5);
		expect(DEFAULT_SCORING_CONFIG.weights.evidence_presence).toBe(1.0);
		expect(DEFAULT_SCORING_CONFIG.weights.decision_recency).toBe(1.5);
		expect(DEFAULT_SCORING_CONFIG.weights.dependency_proximity).toBe(1.0);
		expect(DEFAULT_SCORING_CONFIG.decision_decay.mode).toBe('exponential');
		expect(DEFAULT_SCORING_CONFIG.decision_decay.half_life_hours).toBe(24);
		expect(DEFAULT_SCORING_CONFIG.token_ratios.prose).toBe(0.25);
		expect(DEFAULT_SCORING_CONFIG.token_ratios.code).toBe(0.4);
		expect(DEFAULT_SCORING_CONFIG.token_ratios.markdown).toBe(0.3);
		expect(DEFAULT_SCORING_CONFIG.token_ratios.json).toBe(0.35);
	});
});

describe('resolveScoringConfig', () => {
	it('returns DEFAULT_SCORING_CONFIG when userConfig is undefined', () => {
		const result = resolveScoringConfig(undefined);
		expect(result).toEqual(DEFAULT_SCORING_CONFIG);
	});

	it('returns DEFAULT_SCORING_CONFIG when userConfig is empty object', () => {
		const result = resolveScoringConfig({} as any);
		expect(result.enabled).toBe(false);
		expect(result.max_candidates).toBe(100);
		expect(result.weights.phase).toBe(1.0);
	});

	it('merges partial user config with defaults', () => {
		const userConfig = {
			enabled: true,
			max_candidates: 200,
		};
		const result = resolveScoringConfig(userConfig as any);
		expect(result.enabled).toBe(true);
		expect(result.max_candidates).toBe(200);
		// Should keep defaults for unspecified fields
		expect(result.weights.phase).toBe(1.0);
		expect(result.weights.current_task).toBe(2.0);
		expect(result.decision_decay.mode).toBe('exponential');
		expect(result.token_ratios.code).toBe(0.4);
	});

	it('deep merges nested weights config', () => {
		const userConfig = {
			weights: {
				phase: 3.0,
				current_task: 4.0,
			},
		};
		const result = resolveScoringConfig(userConfig as any);
		expect(result.weights.phase).toBe(3.0);
		expect(result.weights.current_task).toBe(4.0);
		// Should keep defaults for unspecified weight fields
		expect(result.weights.blocked_task).toBe(1.5);
		expect(result.weights.recent_failure).toBe(2.5);
		expect(result.weights.recent_success).toBe(0.5);
		expect(result.weights.evidence_presence).toBe(1.0);
		expect(result.weights.decision_recency).toBe(1.5);
		expect(result.weights.dependency_proximity).toBe(1.0);
		// Should keep defaults for other sections
		expect(result.enabled).toBe(false);
		expect(result.decision_decay.half_life_hours).toBe(24);
	});

	it('deep merges nested decision_decay config', () => {
		const userConfig = {
			decision_decay: {
				mode: 'linear' as const,
			},
		};
		const result = resolveScoringConfig(userConfig as any);
		expect(result.decision_decay.mode).toBe('linear');
		expect(result.decision_decay.half_life_hours).toBe(24); // Default
		// Should keep defaults for other sections
		expect(result.enabled).toBe(false);
		expect(result.weights.phase).toBe(1.0);
	});

	it('deep merges nested token_ratios config', () => {
		const userConfig = {
			token_ratios: {
				prose: 0.5,
				code: 0.6,
			},
		};
		const result = resolveScoringConfig(userConfig as any);
		expect(result.token_ratios.prose).toBe(0.5);
		expect(result.token_ratios.code).toBe(0.6);
		expect(result.token_ratios.markdown).toBe(0.3); // Default
		expect(result.token_ratios.json).toBe(0.35); // Default
	});

	it('merges full user config completely', () => {
		const userConfig = {
			enabled: true,
			max_candidates: 50,
			weights: {
				phase: 2.0,
				current_task: 3.0,
				blocked_task: 2.0,
				recent_failure: 1.0,
				recent_success: 0.25,
				evidence_presence: 1.5,
				decision_recency: 2.0,
				dependency_proximity: 0.5,
			},
			decision_decay: {
				mode: 'linear' as const,
				half_life_hours: 12,
			},
			token_ratios: {
				prose: 0.3,
				code: 0.5,
				markdown: 0.25,
				json: 0.4,
			},
		};
		const result = resolveScoringConfig(userConfig as any);
		expect(result.enabled).toBe(true);
		expect(result.max_candidates).toBe(50);
		expect(result.weights.phase).toBe(2.0);
		expect(result.weights.current_task).toBe(3.0);
		expect(result.decision_decay.mode).toBe('linear');
		expect(result.decision_decay.half_life_hours).toBe(12);
		expect(result.token_ratios.prose).toBe(0.3);
		expect(result.token_ratios.code).toBe(0.5);
	});
});

describe('PipelineConfigSchema', () => {
	it('accepts empty object and applies defaults', () => {
		const result = PipelineConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({ parallel_precheck: true });
		}
	});

	it('accepts parallel_precheck: true', () => {
		const result = PipelineConfigSchema.safeParse({ parallel_precheck: true });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({ parallel_precheck: true });
		}
	});

	it('accepts parallel_precheck: false', () => {
		const result = PipelineConfigSchema.safeParse({ parallel_precheck: false });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({ parallel_precheck: false });
		}
	});

	it('rejects parallel_precheck as string', () => {
		const result = PipelineConfigSchema.safeParse({
			parallel_precheck: 'true',
		});
		expect(result.success).toBe(false);
	});

	it('rejects parallel_precheck as number', () => {
		const result = PipelineConfigSchema.safeParse({ parallel_precheck: 1 });
		expect(result.success).toBe(false);
	});
});

describe('PluginConfigSchema with pipeline', () => {
	it('accepts pipeline block with parallel_precheck', () => {
		const result = PluginConfigSchema.safeParse({
			pipeline: { parallel_precheck: false },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.pipeline).toEqual({ parallel_precheck: false });
		}
	});

	it('pipeline is optional — absent config still parses', () => {
		const result = PluginConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.pipeline).toBeUndefined();
		}
	});
});

describe('stripKnownSwarmPrefix', () => {
	// Tests for the new 'synthetic' prefix (11th entry in KNOWN_SWARM_PREFIXES)
	it('strips synthetic_reviewer and returns reviewer', () => {
		expect(stripKnownSwarmPrefix('synthetic_reviewer')).toBe('reviewer');
	});

	it('strips synthetic_coder and returns coder', () => {
		expect(stripKnownSwarmPrefix('synthetic_coder')).toBe('coder');
	});

	it('strips synthetic_test_engineer and returns test_engineer', () => {
		expect(stripKnownSwarmPrefix('synthetic_test_engineer')).toBe(
			'test_engineer',
		);
	});

	it('strips synthetic-reviewer (dash separator) and returns reviewer', () => {
		expect(stripKnownSwarmPrefix('synthetic-reviewer')).toBe('reviewer');
	});

	it('strips synthetic reviewer (space separator) and returns reviewer', () => {
		expect(stripKnownSwarmPrefix('synthetic reviewer')).toBe('reviewer');
	});

	it('returns synthetic unchanged (bare prefix without separator is not an agent name)', () => {
		expect(stripKnownSwarmPrefix('synthetic')).toBe('synthetic');
	});

	// Verify existing known prefix still works
	it('strips mega_reviewer and returns reviewer (existing prefix)', () => {
		expect(stripKnownSwarmPrefix('mega_reviewer')).toBe('reviewer');
	});

	// Additional edge cases
	it('handles uppercase Synthetic_Architect', () => {
		expect(stripKnownSwarmPrefix('Synthetic_Architect')).toBe('architect');
	});

	it('returns original string when no known agent found', () => {
		expect(stripKnownSwarmPrefix('unknown_agent')).toBe('unknown_agent');
	});

	it('handles empty string', () => {
		expect(stripKnownSwarmPrefix('')).toBe('');
	});
});

describe('GeneralCouncilConfigSchema', () => {
	it('accepts an empty object and applies defaults', () => {
		const result = GeneralCouncilConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.enabled).toBe(false);
			expect(result.data.searchProvider).toBe('tavily');
			expect(result.data.deliberate).toBe(true);
			expect(result.data.moderator).toBe(true);
			expect(result.data.maxSourcesPerMember).toBe(5);
			expect(result.data.members).toEqual([]);
			expect(result.data.presets).toEqual({});
		}
	});

	it('accepts a fully-populated config', () => {
		const result = GeneralCouncilConfigSchema.safeParse({
			enabled: true,
			searchProvider: 'brave',
			searchApiKey: 'test-key',
			members: [
				{ memberId: 'm1', model: 'gpt-4', role: 'generalist' },
				{
					memberId: 'm2',
					model: 'claude',
					role: 'skeptic',
					persona: 'Be contrarian',
				},
			],
			presets: {
				tech: [{ memberId: 't1', model: 'opus', role: 'domain_expert' }],
			},
			deliberate: true,
			moderator: true,
			moderatorModel: 'gpt-5',
			maxSourcesPerMember: 8,
		});
		expect(result.success).toBe(true);
	});

	it('rejects an unknown provider', () => {
		const result = GeneralCouncilConfigSchema.safeParse({
			searchProvider: 'duckduckgo',
		});
		expect(result.success).toBe(false);
	});

	it('rejects maxSourcesPerMember out of range (0)', () => {
		const result = GeneralCouncilConfigSchema.safeParse({
			maxSourcesPerMember: 0,
		});
		expect(result.success).toBe(false);
	});

	it('rejects maxSourcesPerMember out of range (21)', () => {
		const result = GeneralCouncilConfigSchema.safeParse({
			maxSourcesPerMember: 21,
		});
		expect(result.success).toBe(false);
	});

	it('rejects unknown keys (.strict)', () => {
		const result = GeneralCouncilConfigSchema.safeParse({
			enabled: true,
			extraneous: 'oops',
		});
		expect(result.success).toBe(false);
	});

	it('rejects an unknown member role', () => {
		const result = GeneralCouncilConfigSchema.safeParse({
			members: [{ memberId: 'm1', model: 'gpt-4', role: 'overlord' }],
		});
		expect(result.success).toBe(false);
	});

	it('rejects empty memberId', () => {
		const result = GeneralCouncilConfigSchema.safeParse({
			members: [{ memberId: '', model: 'gpt-4', role: 'generalist' }],
		});
		expect(result.success).toBe(false);
	});
});

describe('CouncilConfigSchema with general council', () => {
	it('accepts a council config without `general` (backward compat)', () => {
		const result = PluginConfigSchema.safeParse({
			council: { enabled: false },
		});
		expect(result.success).toBe(true);
	});

	it('accepts council.general nested under council', () => {
		const result = PluginConfigSchema.safeParse({
			council: {
				enabled: true,
				general: {
					enabled: true,
					searchProvider: 'tavily',
				},
			},
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.council?.general?.enabled).toBe(true);
			expect(result.data.council?.general?.searchProvider).toBe('tavily');
		}
	});

	it('rejects unknown key directly under council (.strict)', () => {
		const result = PluginConfigSchema.safeParse({
			council: { enabled: true, generel: {} },
		});
		expect(result.success).toBe(false);
	});
});
