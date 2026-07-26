import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	executePlanConflictCheck,
	plan_conflict_check,
} from '../../../src/tools/plan-conflict-check.js';

let tempDir: string;
let scopesDir: string;
let swarmDir: string;

function writeScope(taskId: string, files: string[]): void {
	fs.writeFileSync(
		path.join(scopesDir, `scope-${taskId}.json`),
		JSON.stringify({
			taskId,
			files,
			declaredAt: '2024-01-01T00:00:00.000Z',
		}),
		'utf-8',
	);
}

function writePlan(taskIds: string[]): void {
	// Minimal plan that passes PlanSchema.parse (schema_version '1.0.0', title,
	// swarm, ≥1 phase; tasks need required `id`, `phase`, `description`).
	const plan = {
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				tasks: taskIds.map((id) => ({
					id,
					phase: 1,
					description: `Task ${id}`,
					status: 'pending' as const,
				})),
			},
		],
	};
	fs.writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify(plan),
		'utf-8',
	);
}

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-conflict-check-test-'));
	swarmDir = path.join(tempDir, '.swarm');
	scopesDir = path.join(swarmDir, 'scopes');
	fs.mkdirSync(scopesDir, { recursive: true });
});

afterEach(() => {
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
});

describe('executePlanConflictCheck — verdict delegation', () => {
	test('two disjoint tasks → all_disjoint', async () => {
		writeScope('1.1', ['src/a.ts']);
		writeScope('1.2', ['src/b.ts']);

		const result = await executePlanConflictCheck(
			{ task_ids: ['1.1', '1.2'] },
			tempDir,
		);

		expect(result.verdict).toBe('all_disjoint');
		expect(result.pairs).toHaveLength(1);
		expect(result.used_cochange).toBe(false);
	});

	test('two overlapping tasks → conflicts_present', async () => {
		writeScope('2.1', ['src/shared.ts']);
		writeScope('2.2', ['src/shared.ts']);

		const result = await executePlanConflictCheck(
			{ task_ids: ['2.1', '2.2'] },
			tempDir,
		);

		expect(result.verdict).toBe('conflicts_present');
	});

	test('unknown scope → unknown_scopes', async () => {
		writeScope('3.1', ['src/a.ts']);
		// 3.2 missing

		const result = await executePlanConflictCheck(
			{ task_ids: ['3.1', '3.2'] },
			tempDir,
		);

		expect(result.verdict).toBe('unknown_scopes');
		expect(result.unknown_scope_tasks).toContain('3.2');
	});

	test('three mixed tasks → correct matrix', async () => {
		writeScope('4.1', ['src/a.ts']);
		writeScope('4.2', ['src/b.ts', 'src/shared.ts']);
		writeScope('4.3', ['src/shared.ts']);

		const result = await executePlanConflictCheck(
			{ task_ids: ['4.1', '4.2', '4.3'] },
			tempDir,
		);

		expect(result.verdict).toBe('conflicts_present');
		expect(result.pairs).toHaveLength(3);
		expect(result.suggested_serial_order).toHaveLength(3);
	});
});

describe('executePlanConflictCheck — task-id validation against plan', () => {
	test('surfaces unknown_to_plan when plan loaded and task id absent', async () => {
		writePlan(['5.1', '5.2']);
		writeScope('5.1', ['src/a.ts']);
		writeScope('5.2', ['src/b.ts']);

		const result = (await executePlanConflictCheck(
			{ task_ids: ['5.1', '5.9'] }, // 5.9 not in plan
			tempDir,
		)) as Awaited<ReturnType<typeof executePlanConflictCheck>> & {
			unknown_to_plan?: string[];
		};

		expect(result.plan_loaded).toBe(true);
		expect(result.unknown_to_plan).toEqual(['5.9']);
	});

	test('plan_loaded=false when plan.json absent (still runs on scope files)', async () => {
		writeScope('6.1', ['src/a.ts']);
		writeScope('6.2', ['src/b.ts']);

		const result = await executePlanConflictCheck(
			{ task_ids: ['6.1', '6.2'] },
			tempDir,
		);

		expect(result.plan_loaded).toBe(false);
		expect(result.verdict).toBe('all_disjoint');
	});
});

describe('executePlanConflictCheck — read-only guarantee (#1656 acceptance)', () => {
	test('writes nothing to the source tree or .swarm/', async () => {
		writeScope('7.1', ['src/a.ts']);
		writeScope('7.2', ['src/b.ts']);

		const before = walkTree(tempDir);
		await executePlanConflictCheck({ task_ids: ['7.1', '7.2'] }, tempDir);
		const after = walkTree(tempDir);

		expect(after).toEqual(before);
	});
});

describe('executePlanConflictCheck — co-change opt-in', () => {
	test('use_cochange defaults to false (no git invocation, stays fast)', async () => {
		writeScope('8.1', ['src/a.ts']);
		writeScope('8.2', ['src/b.ts']);

		const result = await executePlanConflictCheck(
			{ task_ids: ['8.1', '8.2'] },
			tempDir,
		);

		expect(result.used_cochange).toBe(false);
		// Even though 8.1/8.2 are path-disjoint, no co-change signal was used.
		expect(result.verdict).toBe('all_disjoint');
	});

	test('use_cochange=true falls back to path-only when git unavailable (signal-absent)', async () => {
		// tempDir is not a git repo → getCoChangePairs returns []. used_cochange
		// reflects whether co-change data was obtained.
		writeScope('9.1', ['src/a.ts']);
		writeScope('9.2', ['src/b.ts']);

		const result = await executePlanConflictCheck(
			{ task_ids: ['9.1', '9.2'], use_cochange: true },
			tempDir,
		);

		// Path-only verdict still valid; co-change signal absent in a non-git dir.
		expect(result.verdict).toBe('all_disjoint');
	});
});

describe('plan_conflict_check — tool binding', () => {
	test('tool is defined and has the expected shape', () => {
		expect(plan_conflict_check).toBeDefined();
		expect(typeof plan_conflict_check).toBe('object');
		// @opencode-ai/plugin tool() returns an object with description/args/execute.
		expect(plan_conflict_check.description).toEqual(expect.any(String));
		expect(plan_conflict_check.execute).toEqual(expect.any(Function));
	});

	test('description mentions read-only and #1656', () => {
		const desc = plan_conflict_check.description.toLowerCase();
		expect(desc).toContain('read-only');
		expect(plan_conflict_check.description).toContain('#1656');
	});
});

/**
 * The tool module must NOT import any Epic-Mode-activation-gated code path
 * (issue #1656 acceptance: "does not import or depend on any Epic-Mode-
 * activation-gated code path"). The shared helper imports `epicPairConflict`
 * which is a PURE function (verified: no activation check) — that is allowed.
 * What is banned is importing `decideEpicActivation` or anything that gates on
 * Epic Mode being enabled. This test guards against a future regression.
 */
describe('plan_conflict_check — Epic-Mode decoupling (import audit)', () => {
	test('tool module does not import decideEpicActivation', async () => {
		const source = await fs.promises.readFile(
			path.resolve('src/tools/plan-conflict-check.ts'),
			'utf-8',
		);
		expect(source).not.toContain('decideEpicActivation');
		expect(source).not.toContain('epic_decide_phase');
	});

	test('helper module imports epicPairConflict (pure) but not activation gating', async () => {
		const source = await fs.promises.readFile(
			path.resolve('src/plan/parallel-verdict.ts'),
			'utf-8',
		);
		// epicPairConflict is the allowed pure function.
		expect(source).toContain('epicPairConflict');
		// Activation gating is banned.
		expect(source).not.toContain('decideEpicActivation');
	});
});

/** Recursively collect all relative file paths under root. */
function walkTree(root: string): string[] {
	const out: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const cur = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(cur, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			const full = path.join(cur, e.name);
			if (e.isDirectory()) {
				stack.push(full);
			} else {
				out.push(path.relative(root, full));
			}
		}
	}
	return out.sort();
}
