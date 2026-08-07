import { describe, expect, it } from 'bun:test';
import { GuardrailsConfigSchema } from '../../../src/config/schema';

// Split out of guardrails-profile.test.ts (FR-006 500-line cap ratchet).
// These are the exhaustive `toEqual()` fixtures for GuardrailsConfigSchema
// that enumerate every defaulted/known guardrails key, including the
// issue #2063 loop-containment keys:
//   gate_denial_warn_threshold, gate_denial_stop_threshold,
//   execution_stall_warn_calls, execution_stall_stop_calls,
//   execution_stall_episode_minutes
// The exact-equality shape is deliberate: adding a guardrails key is a
// conscious API change, and these tests catch unregistered/undocumented
// config keys by construction. Do not weaken to toMatchObject().
describe('GuardrailsConfigSchema with profiles (loop-containment keys)', () => {
	it('GuardrailsConfigSchema with profiles field parses', () => {
		const config = {
			enabled: true,
			block_destructive_commands: true,
			shell_audit_log: true,
			max_tool_calls: 200,
			max_duration_minutes: 30,
			max_repetitions: 10,
			max_consecutive_errors: 5,
			max_transient_retries: 5,
			warning_threshold: 0.75,
			idle_timeout_minutes: 60,
			no_op_warning_threshold: 15,
			max_coder_revisions: 5,
			runaway_output_max_turns: 5,
			gate_denial_warn_threshold: 3,
			gate_denial_stop_threshold: 5,
			execution_stall_warn_calls: 30,
			execution_stall_stop_calls: 60,
			execution_stall_episode_minutes: 30,
			profiles: {
				coder: { max_tool_calls: 400 },
				explorer: { max_duration_minutes: 60 },
			},
		};

		const result = GuardrailsConfigSchema.parse(config);
		expect(result).toEqual(config);
	});

	it('GuardrailsConfigSchema without profiles (backward compat) parses', () => {
		const config = {
			enabled: true,
			block_destructive_commands: true,
			shell_audit_log: true,
			max_tool_calls: 200,
			max_duration_minutes: 30,
			max_repetitions: 10,
			max_consecutive_errors: 5,
			max_transient_retries: 5,
			warning_threshold: 0.75,
			idle_timeout_minutes: 60,
			no_op_warning_threshold: 15,
			max_coder_revisions: 5,
			runaway_output_max_turns: 5,
			gate_denial_warn_threshold: 3,
			gate_denial_stop_threshold: 5,
			execution_stall_warn_calls: 30,
			execution_stall_stop_calls: 60,
			execution_stall_episode_minutes: 30,
		};

		const result = GuardrailsConfigSchema.parse(config);
		expect(result).toEqual(config);
	});

	it('empty profiles object parses', () => {
		const config = {
			enabled: true,
			block_destructive_commands: true,
			shell_audit_log: true,
			max_tool_calls: 200,
			max_duration_minutes: 30,
			max_repetitions: 10,
			max_consecutive_errors: 5,
			max_transient_retries: 5,
			warning_threshold: 0.75,
			idle_timeout_minutes: 60,
			no_op_warning_threshold: 15,
			max_coder_revisions: 5,
			runaway_output_max_turns: 5,
			gate_denial_warn_threshold: 3,
			gate_denial_stop_threshold: 5,
			execution_stall_warn_calls: 30,
			execution_stall_stop_calls: 60,
			execution_stall_episode_minutes: 30,
			profiles: {},
		};

		const result = GuardrailsConfigSchema.parse(config);
		expect(result).toEqual(config);
	});
});
