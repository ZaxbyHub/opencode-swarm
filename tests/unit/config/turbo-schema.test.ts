/**
 * Turbo config schema tests — verifies turbo block parsing, strategy validation,
 * max_parallel_coders bounds, and backward compatibility.
 */
import { describe, expect, test } from 'bun:test';
import { PluginConfigSchema } from '../../../src/config/schema';

describe('turbo schema — backward compatibility', () => {
	test('turbo omitted remains backward-compatible', () => {
		const r = PluginConfigSchema.safeParse({});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.turbo).toBeUndefined();
			expect(r.data.turbo_mode).toBe(false);
		}
	});

	test('turbo.strategy "standard" parses explicitly', () => {
		const r = PluginConfigSchema.safeParse({
			turbo: {
				strategy: 'standard',
			},
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.turbo?.strategy).toBe('standard');
			expect(r.data.turbo?.lean).toBeUndefined();
		}
	});

	test('existing configs without turbo still parse', () => {
		const r = PluginConfigSchema.safeParse({
			agents: { architect: { model: 'test' } },
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.turbo).toBeUndefined();
			expect(r.data.turbo_mode).toBe(false);
		}
	});
});

describe('turbo schema — strategy validation', () => {
	test('turbo.strategy "lean" parses', () => {
		const r = PluginConfigSchema.safeParse({
			turbo: {
				strategy: 'lean',
				lean: {
					max_parallel_coders: 4,
					require_declared_scope: true,
					conflict_policy: 'serialize',
					degrade_on_risk: true,
					phase_reviewer: true,
					phase_critic: true,
					integrated_diff_required: true,
					allow_docs_only_without_reviewer: false,
					worktree_isolation: false,
				},
			},
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.turbo?.strategy).toBe('lean');
			expect(r.data.turbo?.lean).toBeDefined();
			if (r.data.turbo?.lean) {
				expect(r.data.turbo.lean.max_parallel_coders).toBe(4);
				expect(r.data.turbo.lean.require_declared_scope).toBe(true);
				expect(r.data.turbo.lean.conflict_policy).toBe('serialize');
			}
		}
	});

	test('turbo.strategy "standard" parses without lean', () => {
		const r = PluginConfigSchema.safeParse({
			turbo: {
				strategy: 'standard',
			},
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.turbo?.strategy).toBe('standard');
			expect(r.data.turbo?.lean).toBeUndefined();
		}
	});

	test('lean strategy requires lean sub-config', () => {
		const r = PluginConfigSchema.safeParse({
			turbo: {
				strategy: 'lean',
			},
		});
		expect(r.success).toBe(false);
		if (!r.success) {
			const paths = r.error.issues.map((i) => i.path.join('.'));
			expect(paths).toContain('turbo.lean');
		}
	});

	test('unknown strategies rejected', () => {
		const r1 = PluginConfigSchema.safeParse({
			turbo: { strategy: 'fast' },
		});
		expect(r1.success).toBe(false);
		if (!r1.success) {
			const paths = r1.error.issues.map((i) => i.path.join('.'));
			expect(paths).toContain('turbo.strategy');
		}

		const r2 = PluginConfigSchema.safeParse({
			turbo: { strategy: 'turbo' },
		});
		expect(r2.success).toBe(false);
		if (!r2.success) {
			const paths = r2.error.issues.map((i) => i.path.join('.'));
			expect(paths).toContain('turbo.strategy');
		}
	});
});

describe('turbo schema — max_parallel_coders bounds', () => {
	test('value 1 is accepted', () => {
		const r = PluginConfigSchema.safeParse({
			turbo: {
				strategy: 'lean',
				lean: {
					max_parallel_coders: 1,
				},
			},
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.turbo?.lean?.max_parallel_coders).toBe(1);
		}
	});

	test('value 6 is accepted', () => {
		const r = PluginConfigSchema.safeParse({
			turbo: {
				strategy: 'lean',
				lean: {
					max_parallel_coders: 6,
				},
			},
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.turbo?.lean?.max_parallel_coders).toBe(6);
		}
	});

	test('value 0 is rejected', () => {
		const r = PluginConfigSchema.safeParse({
			turbo: {
				strategy: 'lean',
				lean: {
					max_parallel_coders: 0,
				},
			},
		});
		expect(r.success).toBe(false);
		if (!r.success) {
			const paths = r.error.issues.map((i) => i.path.join('.'));
			expect(paths).toContain('turbo.lean.max_parallel_coders');
		}
	});

	test('value 7 is rejected', () => {
		const r = PluginConfigSchema.safeParse({
			turbo: {
				strategy: 'lean',
				lean: {
					max_parallel_coders: 7,
				},
			},
		});
		expect(r.success).toBe(false);
		if (!r.success) {
			const paths = r.error.issues.map((i) => i.path.join('.'));
			expect(paths).toContain('turbo.lean.max_parallel_coders');
		}
	});

	test('non-integer value is rejected', () => {
		const r = PluginConfigSchema.safeParse({
			turbo: {
				strategy: 'lean',
				lean: {
					max_parallel_coders: 2.5,
				},
			},
		});
		expect(r.success).toBe(false);
		if (!r.success) {
			const paths = r.error.issues.map((i) => i.path.join('.'));
			expect(paths).toContain('turbo.lean.max_parallel_coders');
		}
	});
});

describe('turbo schema — Full-Auto interop', () => {
	test('Full-Auto config still parses when turbo block present', () => {
		const r = PluginConfigSchema.safeParse({
			full_auto: {
				enabled: true,
				max_interactions_per_phase: 25,
				deadlock_threshold: 2,
				escalation_mode: 'pause',
				critic_model: 'opencode/big-pickle',
			},
			turbo: {
				strategy: 'lean',
				lean: {
					max_parallel_coders: 4,
					require_declared_scope: true,
					conflict_policy: 'serialize',
					degrade_on_risk: true,
					phase_reviewer: true,
					phase_critic: true,
					integrated_diff_required: true,
					allow_docs_only_without_reviewer: false,
					worktree_isolation: false,
				},
			},
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.full_auto?.enabled).toBe(true);
			expect(r.data.turbo?.strategy).toBe('lean');
			expect(r.data.turbo?.lean?.max_parallel_coders).toBe(4);
		}
	});
});
