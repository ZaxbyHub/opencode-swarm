/**
 * Epic v2 declared-scope resolver (`src/epic/declared-scopes.ts`).
 *
 * Declarations go through the real `declare_scope` path; the resolver must
 * read only the v2 binding store pinned to the exact plan identity and map
 * every requested task (declared or not) to a file list.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { resolveEpicDeclaredScopes } from '../../../src/epic/declared-scopes';
import {
	declareScopesForTest,
	resetDeclaredScopesForTest,
} from '../../helpers/declared-scope-bindings';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let dir: string;
let cleanup: () => void;

function plan(taskIds: string[]): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Epic declared scopes',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: taskIds.map((id) => ({
					id,
					phase: 1,
					status: 'pending',
					size: 'small',
					description: `Task ${id}`,
					depends: [],
					files_touched: [],
				})),
			},
		],
		migration_status: 'native',
	} as Plan;
}

function writePlan(p: Plan): void {
	fs.writeFileSync(path.join(dir, '.swarm', 'plan.json'), JSON.stringify(p));
}

beforeEach(() => {
	const created = createSafeTestDir('epic-declared-scopes-');
	dir = created.dir;
	cleanup = created.cleanup;
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

afterEach(async () => {
	await resetDeclaredScopesForTest();
	cleanup();
});

describe('resolveEpicDeclaredScopes', () => {
	test('live bindings resolve; undeclared tasks map to []', async () => {
		const p = plan(['1.1', '1.2', '1.3']);
		writePlan(p);
		await declareScopesForTest(dir, {
			'1.1': ['src/a.ts'],
			'1.2': ['src/b.ts', 'src/c.ts'],
		});

		const scopes = resolveEpicDeclaredScopes(dir, p, ['1.1', '1.2', '1.3']);

		expect(scopes['1.1']).toEqual(['src/a.ts']);
		expect([...scopes['1.2']].sort()).toEqual(['src/b.ts', 'src/c.ts']);
		expect(scopes['1.3']).toEqual([]);
		expect(Object.keys(scopes).sort()).toEqual(['1.1', '1.2', '1.3']);
	});

	test('REGRESSION: a stale v1 scope file is never a declared scope', () => {
		const p = plan(['1.1']);
		writePlan(p);
		const scopesDir = path.join(dir, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });
		fs.writeFileSync(
			path.join(scopesDir, 'scope-1.1.json'),
			JSON.stringify({ taskId: '1.1', files: ['src/a.ts'] }),
		);

		expect(resolveEpicDeclaredScopes(dir, p, ['1.1'])).toEqual({
			'1.1': [],
		});
	});

	test('a binding pinned to an older plan revision is not live', async () => {
		const before = plan(['1.1']);
		writePlan(before);
		await declareScopesForTest(dir, { '1.1': ['src/a.ts'] });
		const revised = plan(['1.1', '1.2']);

		expect(resolveEpicDeclaredScopes(dir, before, ['1.1'])['1.1']).toEqual([
			'src/a.ts',
		]);
		expect(resolveEpicDeclaredScopes(dir, revised, ['1.1'])['1.1']).toEqual([]);
	});

	test('no plan identity → every task maps to []', () => {
		expect(resolveEpicDeclaredScopes(dir, null, ['1.1', '1.2'])).toEqual({
			'1.1': [],
			'1.2': [],
		});
	});
});
