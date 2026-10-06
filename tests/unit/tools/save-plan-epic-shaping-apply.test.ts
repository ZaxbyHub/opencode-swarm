/**
 * Epic v2 C7 — shaping patches applied VERBATIM through the real save_plan.
 *
 * For each suggestion `epic_shaping` returns (snake_case payload), the
 * patch is applied exactly as written — new task(s) added, each edit's
 * complete `files_touched` / `depends`, `removed_task_ids` +
 * `removal_reason` — and saved with `executeSavePlan`: the save succeeds,
 * the persisted plan has no dangling dependency and no cycle, and the new
 * `epic_shaping` reports the effective speedup the suggestion promised.
 * Includes the merge-cycle repro (a transitive merge is never offered).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigLoadResult } from '../../../src/config/loader';
import { PluginConfigSchema } from '../../../src/config/schema';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { _internals as seamInternals } from '../../../src/epic/plan-shaping-seam';
import { loadPlanJsonOnly } from '../../../src/plan/manager';
import {
	executeSavePlan,
	_internals as savePlanInternals,
} from '../../../src/tools/save-plan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realSavePlan = { ...savePlanInternals };
const realSeam = { ...seamInternals };
const dirs: string[] = [];

interface TaskArg {
	id: string;
	description: string;
	files_touched: string[];
	depends?: string[];
	size?: 'small' | 'medium' | 'large';
}

// The advisory payload is plain JSON.
type Json = any;

function project(): string {
	const dir = canonicalMkdtemp('save-plan-shaping-apply-');
	dirs.push(dir);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'spec.md'),
		'# Spec\nshaping.',
		'utf-8',
	);
	fs.writeFileSync(
		path.join(dir, '.swarm', 'context.md'),
		'## Pending QA Gate Selection\n',
		'utf-8',
	);
	return dir;
}

function save(
	dir: string,
	tasks: TaskArg[],
	extra: Record<string, unknown> = {},
) {
	return executeSavePlan({
		title: 'Apply Plan',
		swarm_id: 'apply-swarm',
		working_directory: dir,
		phases: [{ id: 1, name: 'Phase 1', tasks }],
		...extra,
	} as Parameters<typeof executeSavePlan>[0]);
}

/** The patched task list + extra save_plan args, applied verbatim. */
function applyVerbatim(tasks: TaskArg[], suggestion: Json) {
	const patch = suggestion.patch;
	const removed: string[] = patch.removed_task_ids ?? [];
	const edits = new Map<string, Json>(
		(patch.edits ?? []).map((edit: Json) => [edit.task_id, edit]),
	);
	const next: TaskArg[] = tasks
		.filter((t) => !removed.includes(t.id))
		.map((t) => {
			const edit = edits.get(t.id);
			if (!edit) return t;
			return {
				...t,
				depends: edit.depends,
				...(edit.files_touched ? { files_touched: edit.files_touched } : {}),
			};
		});
	const added: Json[] = patch.new_task
		? [patch.new_task]
		: (patch.new_tasks ?? []);
	for (const t of added) {
		next.push({
			id: t.id,
			description: t.description,
			files_touched: t.files_touched,
			depends: t.depends,
		});
	}
	const extra =
		removed.length > 0
			? { removed_task_ids: removed, removal_reason: patch.removal_reason }
			: {};
	return { next, extra };
}

function cycleOrDangling(
	tasks: readonly { id: string; depends?: string[] }[],
): string[] {
	const deps = new Map(tasks.map((t) => [t.id, t.depends ?? []]));
	const problems: string[] = [];
	for (const [id, list] of deps) {
		for (const dep of list)
			if (!deps.has(dep)) problems.push(`dangling ${id}->${dep}`);
	}
	const state = new Map<string, number>();
	const visit = (id: string): boolean => {
		if (state.get(id) === 1) return true;
		if (state.get(id) === 2) return false;
		state.set(id, 1);
		for (const dep of deps.get(id) ?? [])
			if (deps.has(dep) && visit(dep)) return true;
		state.set(id, 2);
		return false;
	};
	for (const id of deps.keys()) if (visit(id)) problems.push(`cycle at ${id}`);
	return problems;
}

/** Save, then apply every patch suggestion verbatim in a fresh project. */
async function applyAll(tasks: TaskArg[]): Promise<Json[]> {
	const first = await save(project(), tasks);
	expect(first.success).toBe(true);
	const suggestions: Json[] = (first.epic_shaping as Json)?.suggestions ?? [];
	for (const suggestion of suggestions) {
		if (!suggestion.patch) continue;
		const dir = project();
		expect((await save(dir, tasks)).success).toBe(true);
		const { next, extra } = applyVerbatim(tasks, suggestion);
		const applied = await save(dir, next, extra);
		expect({ type: suggestion.type, success: applied.success }).toEqual({
			type: suggestion.type,
			success: true,
		});
		const persisted = await loadPlanJsonOnly(dir);
		expect(cycleOrDangling(persisted?.phases[0].tasks ?? [])).toEqual([]);
		const after = applied.epic_shaping as Json;
		if (after && 'effective_speedup' in after) {
			expect(after.effective_speedup).toBeCloseTo(
				suggestion.what_if.effective_speedup,
				3,
			);
		}
	}
	return suggestions;
}

const t = (id: string, files: string[], depends: string[] = []): TaskArg => ({
	id,
	description: `Implement ${id}`,
	files_touched: files,
	depends,
	size: 'small',
});

beforeEach(() => {
	process.env.SWARM_SKIP_GATE_SELECTION = '1';
	const config = PluginConfigSchema.parse({
		epic: { mode: { enabled: true } },
	});
	savePlanInternals.loadPluginConfigWithMeta = (() =>
		({
			config,
		}) as unknown as ConfigLoadResult) as typeof savePlanInternals.loadPluginConfigWithMeta;
	seamInternals.existsSync = (target) =>
		path.basename(target) === '.git' || fs.existsSync(target);
});

afterEach(() => {
	delete process.env.SWARM_SKIP_GATE_SELECTION;
	Object.assign(savePlanInternals, realSavePlan);
	Object.assign(seamInternals, realSeam);
	closeAllProjectDbs();
	for (const dir of dirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

describe('patches applied verbatim through save_plan', () => {
	test('merge-tasks: removal + re-pointed dependents save cleanly', async () => {
		const suggestions = await applyAll([
			t('1.1', ['src/m.ts', 'src/n.ts']),
			t('1.2', ['src/n.ts', 'src/m.ts'], ['1.1']),
			t('1.3', ['src/c.ts'], ['1.2']),
			...Array.from({ length: 5 }, (_, i) => t(`1.${i + 4}`, [`src/o${i}.ts`])),
		]);
		expect(suggestions.find((s) => s.type === 'merge-tasks')).toMatchObject({
			keep: '1.1',
			absorb: '1.2',
			patch: { removed_task_ids: ['1.2'] },
		});
	});

	test('regression (merge cycle): a transitive merge is never offered', async () => {
		const suggestions = await applyAll([
			t('1.1', ['src/a.ts']),
			t('1.2', ['src/a.ts', 'src/b.ts'], ['1.1']),
			t('1.3', ['src/a.ts'], ['1.2']),
			t('1.10', ['src/a.ts', 'src/c.ts']),
			t('1.11', ['src/a.ts', 'src/d.ts']),
			...Array.from({ length: 6 }, (_, i) => t(`1.${i + 4}`, [`src/w${i}.ts`])),
		]);
		for (const s of suggestions.filter((x) => x.type === 'merge-tasks')) {
			expect([s.keep, s.absorb].sort()).not.toEqual(['1.1', '1.3']);
		}
	});

	test('extract-prerequisite with dependencies, and split-task', async () => {
		const extract = await applyAll([
			t('1.1', ['src/base.ts']),
			t('1.2', ['src/hub.ts', 'src/f2.ts'], ['1.1']),
			t('1.3', ['src/hub.ts', 'src/f3.ts'], ['1.2']),
			t('1.4', ['src/hub.ts', 'src/f4.ts']),
			t('1.5', ['src/hub.ts', 'src/f5.ts']),
			t('1.6', ['src/s6.ts']),
			t('1.7', ['src/s7.ts']),
		]);
		expect(extract.some((s) => s.type === 'extract-prerequisite')).toBe(true);
		const split = await applyAll([
			t('1.1', ['src/x.ts', 'src/a1.ts']),
			t('1.2', ['src/x.ts', 'src/a2.ts']),
			t('1.3', ['src/y.ts', 'src/b1.ts']),
			t('1.4', ['src/y.ts', 'src/b2.ts']),
			t('1.5', ['src/x.ts', 'src/y.ts', 'src/own.ts']),
			t('1.6', ['src/after.ts'], ['1.5']),
		]);
		expect(split.some((s) => s.type === 'split-task')).toBe(true);
	});
});
