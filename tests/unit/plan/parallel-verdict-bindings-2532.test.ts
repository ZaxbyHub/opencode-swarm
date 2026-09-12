/**
 * #2532 (PARALLEL-4) regression suite: the parallel verdict resolves task
 * scopes from the AUTHORITATIVE v2 binding store (the same source
 * `declare_scope` writes), never from the legacy v1 `.swarm/scopes/
 * scope-<taskId>.json` projection.
 *
 * Covers the frozen acceptance checks C1/C7/C8/C9 territory plus the
 * critic-required mutation (a stale-planStructureHash binding must NOT
 * certify disjointness) and the ambiguity fail-closed path.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema.js';
import { computePlanStructureHash } from '../../../src/plan/ledger.js';
import { computeParallelVerdict } from '../../../src/plan/parallel-verdict.js';
import { derivePlanId } from '../../../src/plan/utils.js';
import type { ScopeBinding } from '../../../src/scope/scope-binding.js';
import {
	readAuthoritativeScopeBindingSet,
	readDeclaredScopeFilesFromBindings,
} from '../../../src/scope/scope-persistence.js';
import { executeDeclareScope } from '../../../src/tools/declare-scope.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tempDir: string;

function makePlanJson(): string {
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'P4 Regression Plan',
		swarm: 'p4-regression',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [1, 2].map((n) => ({
					id: `1.${n}`,
					phase: 1,
					status: 'pending',
					size: 'small',
					description: `Task 1.${n}`,
					depends: [],
					files_touched: [],
				})),
			},
		],
	};
	return JSON.stringify(plan, null, 2);
}

async function declare(taskId: string, files: string[]): Promise<void> {
	const result = await executeDeclareScope(
		{ taskId, files, working_directory: tempDir },
		tempDir,
		{ sessionID: 'p4-regression-architect', messageID: `m-${taskId}` },
	);
	expect(result.success).toBe(true);
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('p4-bindings-2532-');
	fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(tempDir, '.swarm', 'plan.json'),
		makePlanJson(),
		'utf-8',
	);
});

afterEach(() => {
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('computeParallelVerdict — v2 binding authority (#2532)', () => {
	test('v2-declared disjoint tasks → all_disjoint (PARALLEL-4 core)', async () => {
		await declare('1.1', ['src/a.ts']);
		await declare('1.2', ['src/b.ts']);
		const verdict = computeParallelVerdict(tempDir, ['1.1', '1.2']);
		expect(verdict.verdict).toBe('all_disjoint');
		expect(verdict.unknownScopeTasks).toEqual([]);
	});

	test('v2-declared overlapping tasks → conflicts_present with shared-path evidence', async () => {
		await declare('1.1', ['src/shared.ts']);
		await declare('1.2', ['src/shared.ts', 'src/other.ts']);
		const verdict = computeParallelVerdict(tempDir, ['1.1', '1.2']);
		expect(verdict.verdict).toBe('conflicts_present');
		const conflict = verdict.pairs.find((p) => p.verdict === 'conflict');
		expect(conflict).toBeDefined();
		expect(conflict!.evidence.some((e) => e.includes('src/shared.ts'))).toBe(
			true,
		);
	});

	test('undeclared task fails closed to unknown (never all_disjoint)', async () => {
		await declare('1.1', ['src/a.ts']);
		// 1.2 undeclared
		const verdict = computeParallelVerdict(tempDir, ['1.1', '1.2']);
		expect(verdict.verdict).toBe('unknown_scopes');
		expect(verdict.unknownScopeTasks).toEqual(['1.2']);
	});

	test('GUARDRAIL: hand-written v1 projection cannot flip the verdict (C9)', async () => {
		// No v2 declarations at all; write the v1 projection for BOTH tasks
		// with disjoint files — the obsolete surface must be ignored.
		const scopesDir = path.join(tempDir, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });
		for (const [id, file] of [
			['1.1', 'src/a.ts'],
			['1.2', 'src/b.ts'],
		] as const) {
			fs.writeFileSync(
				path.join(scopesDir, `scope-${id}.json`),
				JSON.stringify({
					version: 1,
					taskId: id,
					files: [file],
					declaredAt: 1,
					expiresAt: Number.MAX_SAFE_INTEGER,
				}),
				'utf-8',
			);
		}
		const verdict = computeParallelVerdict(tempDir, ['1.1', '1.2']);
		expect(verdict.verdict).toBe('unknown_scopes');
	});

	test('GUARDRAIL (source ratchet): parallel-verdict.ts never imports the v1 readers', async () => {
		const source = await fs.promises.readFile(
			path.resolve('src/plan/parallel-verdict.ts'),
			'utf-8',
		);
		expect(source).not.toContain('readScopeFromDisk');
		expect(source).not.toContain('readTaskScopes');
	});

	test('stale planStructureHash binding must NOT certify disjointness (critic F7b)', async () => {
		await declare('1.1', ['src/a.ts']);
		await declare('1.2', ['src/b.ts']);
		// Revise the plan on disk (change a task description) WITHOUT
		// re-declaring: the structure hash changes, so both bindings go stale
		// and the verdict must fail closed to unknown.
		const raw = JSON.parse(
			fs.readFileSync(path.join(tempDir, '.swarm', 'plan.json'), 'utf-8'),
		) as Plan;
		raw.phases[0].tasks[0].description = 'Revised task description';
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(raw, null, 2),
			'utf-8',
		);
		const verdict = computeParallelVerdict(tempDir, ['1.1', '1.2']);
		expect(verdict.verdict).toBe('unknown_scopes');
	});

	test('one hoisted binding-set read per verdict still resolves every task', async () => {
		await declare('1.1', ['src/a.ts']);
		await declare('1.2', ['src/b.ts']);
		const hoisted = readAuthoritativeScopeBindingSet(tempDir);
		expect(hoisted).not.toBeNull();
		const plan = JSON.parse(
			fs.readFileSync(path.join(tempDir, '.swarm', 'plan.json'), 'utf-8'),
		) as Plan;
		for (const id of ['1.1', '1.2']) {
			const files = readDeclaredScopeFilesFromBindings({
				directory: tempDir,
				taskId: id,
				plan,
				bindingSet: hoisted,
			});
			expect(files).not.toBeNull();
		}
	});
});

describe('readDeclaredScopeFilesFromBindings — fail-closed matrix', () => {
	function makeBinding(overrides: Partial<ScopeBinding>): ScopeBinding {
		const plan = JSON.parse(
			fs.readFileSync(path.join(tempDir, '.swarm', 'plan.json'), 'utf-8'),
		) as Plan;
		// Real identity so hash/planId filters genuinely match the plan.
		const realPlanId = derivePlanId(plan);
		const realStructureHash = computePlanStructureHash(plan);
		return {
			version: 2,
			bindingId: 'b-00000000-0000-4000-8000-000000000001',
			generationId: 'g-00000000-0000-4000-8000-000000000001',
			revision: 1,
			lifecycleState: 'live',
			workspaceIdentity: 'wi',
			planId: realPlanId,
			planStructureHash: realStructureHash,
			taskId: '1.1',
			ownerSessionId: 'sess',
			ownerMessageId: 'msg',
			activation: 'declaration',
			source: 'declare_scope',
			files: ['src/a.ts'],
			declaredAt: 1_700_000_000_000,
			expiresAt: 4_102_444_800_000, // 2100-01-01: deterministic, always future
			...overrides,
		} as ScopeBinding;
	}

	function currentPlanBinding(): { plan: Plan; binding: ScopeBinding } {
		const plan = JSON.parse(
			fs.readFileSync(path.join(tempDir, '.swarm', 'plan.json'), 'utf-8'),
		) as Plan;
		return { plan, binding: makeBinding({}) };
	}

	test('null bindingSet (store failure) → null', () => {
		const { plan } = currentPlanBinding();
		const files = readDeclaredScopeFilesFromBindings({
			directory: tempDir,
			taskId: '1.1',
			plan,
			bindingSet: null,
		});
		expect(files).toBeNull();
	});

	test('two live candidates that DISAGREE on files (ambiguous) → null', () => {
		const { plan, binding } = currentPlanBinding();
		const twin = makeBinding({
			bindingId: 'b-00000000-0000-4000-8000-000000000002',
			generationId: 'g-00000000-0000-4000-8000-000000000002',
			ownerSessionId: 'sess-2',
			files: ['src/other.ts'],
		});
		const files = readDeclaredScopeFilesFromBindings({
			directory: tempDir,
			taskId: '1.1',
			plan,
			bindingSet: [binding, twin],
		});
		expect(files).toBeNull();
	});

	test('dispatch-correlated twin that AGREES on files resolves (not ambiguous)', () => {
		// The delegation gate mints a dispatch binding (activation 'active',
		// child owner) alongside the architect's declaration for the same
		// task with the same files — the scheduling answer is unambiguous.
		const { plan, binding } = currentPlanBinding();
		const dispatchTwin = makeBinding({
			bindingId: 'b-00000000-0000-4000-8000-000000000003',
			generationId: 'g-00000000-0000-4000-8000-000000000003',
			ownerSessionId: 'child-session',
			activation: 'active',
			dispatchCallId: 'call-1',
			source: 'worktree_derived',
		});
		const files = readDeclaredScopeFilesFromBindings({
			directory: tempDir,
			taskId: '1.1',
			plan,
			bindingSet: [binding, dispatchTwin],
		});
		expect(files).toEqual(binding.files);
	});

	test('expired binding → null', () => {
		const { plan, binding } = currentPlanBinding();
		binding.expiresAt = 1_700_000_000_000 - 1_000;
		const files = readDeclaredScopeFilesFromBindings({
			directory: tempDir,
			taskId: '1.1',
			plan,
			bindingSet: [binding],
		});
		expect(files).toBeNull();
	});

	test('revoked binding → null', () => {
		const { plan, binding } = currentPlanBinding();
		binding.lifecycleState = 'revoked';
		const files = readDeclaredScopeFilesFromBindings({
			directory: tempDir,
			taskId: '1.1',
			plan,
			bindingSet: [binding],
		});
		expect(files).toBeNull();
	});

	test('empty file list on the binding → null', () => {
		const { plan, binding } = currentPlanBinding();
		binding.files = [];
		const files = readDeclaredScopeFilesFromBindings({
			directory: tempDir,
			taskId: '1.1',
			plan,
			bindingSet: [binding],
		});
		expect(files).toBeNull();
	});
});
