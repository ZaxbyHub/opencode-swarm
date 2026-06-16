/**
 * Full-Auto v2 schema tests — confirms both legacy and v2 shapes parse and that
 * defaults match the intended fail-closed posture.
 */
import { describe, expect, test } from 'bun:test';
import { PluginConfigSchema } from '../../../src/config/schema';

describe('full_auto schema — legacy v1 shape', () => {
	test('parses minimal v1 config', () => {
		const r = PluginConfigSchema.safeParse({
			full_auto: {
				enabled: true,
				max_interactions_per_phase: 25,
				deadlock_threshold: 2,
				escalation_mode: 'pause',
				critic_model: 'opencode/big-pickle',
			},
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.full_auto?.enabled).toBe(true);
			expect(r.data.full_auto?.mode).toBe('supervised');
			expect(r.data.full_auto?.fail_closed).toBe(true);
		}
	});

	test('uses safe defaults when full_auto omitted entirely', () => {
		const r = PluginConfigSchema.safeParse({});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.full_auto?.enabled).toBe(false);
			expect(r.data.full_auto?.locked).toBe(false);
			expect(r.data.full_auto?.mode).toBe('supervised');
			expect(r.data.full_auto?.fail_closed).toBe(true);
			expect(r.data.full_auto?.denials?.max_consecutive).toBe(3);
			expect(r.data.full_auto?.denials?.max_total).toBe(20);
		}
	});

	test('locked defaults to false and parses when set true', () => {
		const omitted = PluginConfigSchema.safeParse({ full_auto: {} });
		expect(omitted.success).toBe(true);
		if (omitted.success) {
			expect(omitted.data.full_auto?.locked).toBe(false);
		}
		const locked = PluginConfigSchema.safeParse({
			full_auto: { locked: true },
		});
		expect(locked.success).toBe(true);
		if (locked.success) {
			expect(locked.data.full_auto?.locked).toBe(true);
		}
	});
});

describe('full_auto schema — v2 shape', () => {
	test('parses full v2 config', () => {
		const r = PluginConfigSchema.safeParse({
			full_auto: {
				enabled: true,
				mode: 'strict',
				fail_closed: true,
				permission_policy: {
					enabled: true,
					trusted_roots: ['.'],
					trusted_domains: ['docs.example.com'],
					protected_paths: ['package.json'],
					allow_defaults: false,
				},
				denials: {
					max_consecutive: 5,
					max_total: 50,
					on_limit: 'terminate',
				},
				oversight: {
					on_plan_change: true,
					on_task_completion: true,
					on_phase_boundary: true,
					on_high_risk_action: true,
					on_subagent_return_warning: true,
					every_tool_calls: 10,
					every_architect_turns: 3,
					every_minutes: 5,
				},
			},
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.full_auto?.mode).toBe('strict');
			expect(r.data.full_auto?.permission_policy?.allow_defaults).toBe(false);
			expect(r.data.full_auto?.denials?.on_limit).toBe('terminate');
			expect(r.data.full_auto?.oversight?.every_tool_calls).toBe(10);
		}
	});

	test('rejects invalid mode', () => {
		const r = PluginConfigSchema.safeParse({
			full_auto: { enabled: true, mode: 'rambo' },
		});
		expect(r.success).toBe(false);
	});

	test('rejects out-of-range denial limits', () => {
		const r = PluginConfigSchema.safeParse({
			full_auto: { enabled: true, denials: { max_consecutive: 0 } },
		});
		expect(r.success).toBe(false);
	});

	test('default protected_paths includes plugin/build sensitive entries', () => {
		const r = PluginConfigSchema.safeParse({});
		expect(r.success).toBe(true);
		if (r.success) {
			const protectedPaths =
				r.data.full_auto?.permission_policy?.protected_paths ?? [];
			expect(protectedPaths).toContain('package.json');
			expect(protectedPaths).toContain('.git');
			expect(protectedPaths).toContain('.swarm');
			expect(protectedPaths).toContain('CHANGELOG.md');
		}
	});
});
