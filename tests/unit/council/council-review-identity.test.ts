/**
 * Issue #2102 contract A — canonical council review identity.
 *
 * Pins:
 * - the review hash is status-stable (pure execution progress never changes
 *   it) and sensitive to every review-relevant plan field;
 * - the per-level policy digest changes on every policy field the issue
 *   enumerates and is untouched by inert fields;
 * - the final completion policy fails closed to all_required;
 * - member role resolution accepts canonical + multi-swarm prefixed names,
 *   never counts unknown names, and collapses cross-swarm duplicates.
 */

import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../../src/config/plan-schema';
import {
	COUNCIL_REVIEW_IDENTITY_VERSION,
	computeCouncilPolicyDigest,
	computeCouncilReviewHash,
	computeCouncilReviewIdentity,
	resolveCouncilMemberRole,
	resolveFinalCompletionPolicy,
} from '../../../src/council/council-review-identity';
import type { CouncilConfig } from '../../../src/council/types';

function plan(
	overrides: { mutate?: (plan: Record<string, unknown>) => void } = {},
): Parameters<typeof computeCouncilReviewHash>[0] {
	const base = {
		schema_version: '1.0.0',
		title: 'Demo',
		swarm: 'default',
		current_phase: 1,
		migration_status: 'migrated',
		specMtime: '2026-08-01T00:00:00.000Z',
		specHash: 'a'.repeat(64),
		execution_profile: { planning_profile: 'strict', max_concurrent_tasks: 4 },
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				type: 'code',
				required_agents: ['coder', 'reviewer'],
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'in_progress',
						size: 'medium',
						description: 'Do the thing',
						depends: ['1.2'],
						acceptance: 'It works',
						files_touched: ['src/a.ts'],
						evidence_path: '.swarm/evidence/1.1.json',
						blocked_reason: 'waiting on review',
						fr_refs: ['FR-1'],
					},
				],
			},
		],
	} as Record<string, unknown>;
	overrides.mutate?.(base);
	return PlanSchema.parse(base);
}

function cloneWith(
	mutate: (plan: Record<string, unknown>) => void,
): Parameters<typeof computeCouncilReviewHash>[0] {
	return plan({ mutate });
}

function firstTask(p: Record<string, unknown>): Record<string, unknown> {
	const phases = p.phases as Array<{ tasks: Array<Record<string, unknown>> }>;
	return phases[0]!.tasks[0]!;
}

describe('computeCouncilReviewHash — status stability', () => {
	test('baseline is deterministic', () => {
		expect(computeCouncilReviewHash(plan())).toBe(
			computeCouncilReviewHash(plan()),
		);
	});

	test.each([
		[
			'phase.status flip',
			(p: Record<string, unknown>) => {
				(p.phases as Array<{ status: string }>)[0]!.status = 'complete';
			},
		],
		[
			'task.status flip',
			(p: Record<string, unknown>) => {
				firstTask(p).status = 'completed';
			},
		],
		[
			'current_phase pointer move',
			(p: Record<string, unknown>) => {
				p.current_phase = 2;
			},
		],
		[
			'transient blocked_reason change',
			(p: Record<string, unknown>) => {
				firstTask(p).blocked_reason = 'waiting on CI';
			},
		],
		[
			'blocked_reason cleared',
			(p: Record<string, unknown>) => {
				delete firstTask(p).blocked_reason;
			},
		],
		[
			'specMtime timestamp change',
			(p: Record<string, unknown>) => {
				p.specMtime = '2026-09-01T00:00:00.000Z';
			},
		],
	])('%s keeps the hash stable', (_name, mutate) => {
		expect(computeCouncilReviewHash(cloneWith(mutate))).toBe(
			computeCouncilReviewHash(plan()),
		);
	});
});

describe('computeCouncilReviewHash — review-relevant sensitivity', () => {
	test.each([
		[
			'task description',
			(p: Record<string, unknown>) => {
				firstTask(p).description = 'Changed';
			},
		],
		[
			'acceptance criteria',
			(p: Record<string, unknown>) => {
				firstTask(p).acceptance = 'Different bar';
			},
		],
		[
			'dependencies',
			(p: Record<string, unknown>) => {
				firstTask(p).depends = ['1.3'];
			},
		],
		[
			'files_touched',
			(p: Record<string, unknown>) => {
				firstTask(p).files_touched = ['src/b.ts'];
			},
		],
		[
			'task size',
			(p: Record<string, unknown>) => {
				firstTask(p).size = 'large';
			},
		],
		[
			'fr_refs (spec references)',
			(p: Record<string, unknown>) => {
				firstTask(p).fr_refs = ['FR-2'];
			},
		],
		[
			'evidence_path',
			(p: Record<string, unknown>) => {
				firstTask(p).evidence_path = '.swarm/evidence/9.9.json';
			},
		],
		[
			'required_agents',
			(p: Record<string, unknown>) => {
				(
					p.phases as Array<{ required_agents?: string[] }>
				)[0]!.required_agents = ['coder'];
			},
		],
		[
			'phase name',
			(p: Record<string, unknown>) => {
				(p.phases as Array<{ name: string }>)[0]!.name = 'Renamed';
			},
		],
		[
			'phase type',
			(p: Record<string, unknown>) => {
				(p.phases as Array<{ type?: string }>)[0]!.type = 'non-code';
			},
		],
		[
			'plan title',
			(p: Record<string, unknown>) => {
				p.title = 'New Title';
			},
		],
		[
			'plan swarm',
			(p: Record<string, unknown>) => {
				p.swarm = 'other-swarm';
			},
		],
		[
			'migration_status',
			(p: Record<string, unknown>) => {
				p.migration_status = undefined;
			},
		],
		[
			'execution profile',
			(p: Record<string, unknown>) => {
				p.execution_profile = {
					planning_profile: 'strict',
					max_concurrent_tasks: 8,
				};
			},
		],
		[
			'task id',
			(p: Record<string, unknown>) => {
				firstTask(p).id = '1.2';
			},
		],
	])('%s changes the hash', (_name, mutate) => {
		expect(computeCouncilReviewHash(cloneWith(mutate))).not.toBe(
			computeCouncilReviewHash(plan()),
		);
	});

	test('array order does not matter (sorted normalization)', () => {
		const reordered = cloneWith((p) => {
			firstTask(p).depends = ['1.2', '1.0'];
			firstTask(p).files_touched = ['src/a.ts', 'src/0.ts'];
		});
		// differs from baseline content — just assert sorted-equivalent plans hash equally
		const a = cloneWith((p) => {
			firstTask(p).depends = ['1.2', '1.0'];
		});
		const b = cloneWith((p) => {
			firstTask(p).depends = ['1.0', '1.2'];
		});
		expect(computeCouncilReviewHash(a)).toBe(computeCouncilReviewHash(b));
		void reordered;
	});
});

describe('computeCouncilPolicyDigest', () => {
	const base: CouncilConfig = {
		enabled: true,
		maxRounds: 3,
		parallelTimeoutMs: 30_000,
		vetoPriority: true,
		requireAllMembers: false,
		minimumMembers: 3,
		phaseConcernsAllowComplete: true,
		finalCompletionPolicy: { mode: 'all_required' },
		freshnessMaxAgeHours: 24,
	};

	test.each([
		['maxRounds', { maxRounds: 5 }],
		['vetoPriority', { vetoPriority: false }],
		['minimumMembers', { minimumMembers: 4 }],
		['requireAllMembers', { requireAllMembers: true }],
		['freshnessMaxAgeHours', { freshnessMaxAgeHours: 48 }],
	] as Array<
		[string, Partial<CouncilConfig>]
	>)('%s changes the task/phase digest', (_name, patch) => {
		expect(computeCouncilPolicyDigest('task', { ...base, ...patch })).not.toBe(
			computeCouncilPolicyDigest('task', base),
		);
		expect(computeCouncilPolicyDigest('phase', { ...base, ...patch })).not.toBe(
			computeCouncilPolicyDigest('phase', base),
		);
	});

	test('phaseConcernsAllowComplete changes only the phase digest', () => {
		const changed = { ...base, phaseConcernsAllowComplete: false };
		expect(computeCouncilPolicyDigest('phase', changed)).not.toBe(
			computeCouncilPolicyDigest('phase', base),
		);
		expect(computeCouncilPolicyDigest('task', changed)).toBe(
			computeCouncilPolicyDigest('task', base),
		);
	});

	test('finalCompletionPolicy changes only the final digest', () => {
		const changed: CouncilConfig = {
			...base,
			finalCompletionPolicy: { mode: 'quorum', minimumMembers: 4 },
		};
		expect(computeCouncilPolicyDigest('final', changed)).not.toBe(
			computeCouncilPolicyDigest('final', base),
		);
		expect(computeCouncilPolicyDigest('task', changed)).toBe(
			computeCouncilPolicyDigest('task', base),
		);
	});

	test('inert fields (parallelTimeoutMs, escalateOnMaxRounds) do NOT change any digest', () => {
		const changed: CouncilConfig = {
			...base,
			parallelTimeoutMs: 120_000,
			escalateOnMaxRounds: 'https://hooks.example.invalid/x?q=1',
		};
		for (const level of ['task', 'phase', 'final'] as const) {
			expect(computeCouncilPolicyDigest(level, changed)).toBe(
				computeCouncilPolicyDigest(level, base),
			);
		}
	});

	test('undefined config digests identically to explicit defaults', () => {
		expect(computeCouncilPolicyDigest('final')).toBe(
			computeCouncilPolicyDigest('final', base),
		);
	});
});

describe('resolveFinalCompletionPolicy', () => {
	test('undefined config and missing policy fail closed to all_required', () => {
		expect(resolveFinalCompletionPolicy(undefined)).toEqual({
			mode: 'all_required',
		});
		expect(
			resolveFinalCompletionPolicy({
				enabled: true,
				maxRounds: 3,
				parallelTimeoutMs: 30_000,
				vetoPriority: true,
				requireAllMembers: false,
				minimumMembers: 3,
				phaseConcernsAllowComplete: true,
				freshnessMaxAgeHours: 24,
			}),
		).toEqual({ mode: 'all_required' });
	});

	test('explicit quorum is honored when bounded 3..5', () => {
		for (const minimumMembers of [3, 4, 5]) {
			expect(
				resolveFinalCompletionPolicy({
					enabled: true,
					maxRounds: 3,
					parallelTimeoutMs: 30_000,
					vetoPriority: true,
					requireAllMembers: false,
					minimumMembers: 3,
					phaseConcernsAllowComplete: true,
					finalCompletionPolicy: { mode: 'quorum', minimumMembers },
					freshnessMaxAgeHours: 24,
				}),
			).toEqual({ mode: 'quorum', minimumMembers });
		}
	});

	test('quorum without a valid minimum fails closed to all_required', () => {
		for (const minimumMembers of [undefined, 2, 6, 3.5]) {
			expect(
				resolveFinalCompletionPolicy({
					enabled: true,
					maxRounds: 3,
					parallelTimeoutMs: 30_000,
					vetoPriority: true,
					requireAllMembers: false,
					minimumMembers: 3,
					phaseConcernsAllowComplete: true,
					finalCompletionPolicy: { mode: 'quorum', minimumMembers },
					freshnessMaxAgeHours: 24,
				}),
			).toEqual({ mode: 'all_required' });
		}
	});
});

describe('resolveCouncilMemberRole', () => {
	test('exact canonical roles resolve', () => {
		expect(resolveCouncilMemberRole('critic')).toBe('critic');
		expect(resolveCouncilMemberRole('test_engineer')).toBe('test_engineer');
	});

	test('multi-swarm prefixed roles resolve to the canonical role', () => {
		expect(resolveCouncilMemberRole('local_critic')).toBe('critic');
		expect(resolveCouncilMemberRole('mega_test_engineer')).toBe(
			'test_engineer',
		);
	});

	test('suffix-resolution edge cases resolve conservatively (F-BOT-4)', () => {
		// Role must be the SUFFIX; prefixes/aliases around it never resolve.
		expect(resolveCouncilMemberRole('critic_extra')).toBeNull();
		expect(resolveCouncilMemberRole('my_critic_alias')).toBeNull();
		expect(resolveCouncilMemberRole('_critic')).toBeNull(); // no swarm identity before separator
		expect(resolveCouncilMemberRole('my_critic')).toBe('critic');
		expect(resolveCouncilMemberRole('notacritic')).toBeNull();
	});

	test('unknown names never resolve', () => {
		expect(resolveCouncilMemberRole('council_generalist')).toBeNull();
		expect(resolveCouncilMemberRole('not_a_member')).toBeNull();
		expect(resolveCouncilMemberRole('')).toBeNull();
	});
});

describe('computeCouncilReviewIdentity', () => {
	test('embeds the identity version and binds plan identity', () => {
		const p = plan();
		const identity = computeCouncilReviewIdentity({
			level: 'final',
			scope: { kind: 'final', final: true },
			plan: p,
			config: undefined,
		});
		expect(identity.version).toBe(COUNCIL_REVIEW_IDENTITY_VERSION);
		expect(identity.identityDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(identity.planId).toBe('default-Demo');
		expect(identity.reviewHash).toBe(computeCouncilReviewHash(p));
	});

	test('scope differences change the identity digest', () => {
		const p = plan();
		const a = computeCouncilReviewIdentity({
			level: 'phase',
			scope: { kind: 'phase', phaseNumber: 1 },
			plan: p,
			config: undefined,
		});
		const b = computeCouncilReviewIdentity({
			level: 'phase',
			scope: { kind: 'phase', phaseNumber: 2 },
			plan: p,
			config: undefined,
		});
		expect(a.identityDigest).not.toBe(b.identityDigest);
	});

	test('null plan yields null plan fields (consumers with a plan fail closed)', () => {
		const identity = computeCouncilReviewIdentity({
			level: 'final',
			scope: { kind: 'final', final: true },
			plan: null,
			config: undefined,
		});
		expect(identity.planId).toBeNull();
		expect(identity.reviewHash).toBeNull();
	});
});
