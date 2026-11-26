import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	clearScopeBindings,
	createScopeBinding,
} from '../../../src/scope/scope-binding';
import {
	clearSessionScopeBindingsFromDisk,
	replaceExistingScopeDeclaration,
	resolveScopeBindingFromDisk,
} from '../../../src/scope/scope-persistence';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

function setup(): { directory: string; plan: Plan } {
	const directory = canonicalMkdtemp('scope-shadow-cleanup-');
	roots.push(directory);
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Shadow cleanup plan',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Shadow cleanup',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Shadow cleanup',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	};
	fs.mkdirSync(path.join(directory, '.swarm', 'scopes'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan),
	);
	return { directory, plan };
}

function makeDeclaration(directory: string, plan: Plan) {
	const b = createScopeBinding({
		directory,
		plan,
		taskId: '1.1',
		files: ['src/a.ts'],
		ownerSessionId: 'architect-session',
		ownerMessageId: 'task-call',
		source: 'declare_scope',
		activation: 'declaration',
	});
	if (!b) throw new Error('declaration fixture failed');
	return b;
}

afterEach(() => {
	clearScopeBindings();
	closeAllProjectDbs();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe('reset sweep removes the binding file it retired (#3889)', () => {
	test('a swept generation is not re-imported by the next read', async () => {
		const { directory, plan } = setup();
		const binding = makeDeclaration(directory, plan);
		expect(
			await replaceExistingScopeDeclaration({
				directory,
				binding,
				replaceExisting: false,
			}),
		).toMatchObject({ ok: true });

		const scopesDir = path.join(directory, '.swarm', 'scopes');
		const before = fs
			.readdirSync(scopesDir)
			.filter((n) => n.startsWith('binding-') && n.endsWith('.json'));
		expect(before.length).toBe(1);
		const savedFile = path.join(scopesDir, before[0]!);
		const savedContent = fs.readFileSync(savedFile, 'utf8');

		const outcome = await clearSessionScopeBindingsFromDisk(directory, [
			'architect-session',
		]);
		expect(outcome).toMatchObject({ removed: 1 });
		// The binding file must be gone: a leftover file is re-imported as a
		// live row by the next read.
		const after = fs
			.readdirSync(scopesDir)
			.filter((n) => n.startsWith('binding-') && n.endsWith('.json'));
		expect(after).toEqual([]);

		// Simulate a fresh runtime: clear in-memory state, then read from disk.
		clearScopeBindings();
		closeAllProjectDbs();
		const resolution = resolveScopeBindingFromDisk({
			directory,
			taskId: '1.1',
			plan,
			ownerSessionId: 'architect-session',
			requireDeclaration: true,
			includeExpired: false,
		});
		expect(resolution.status).toBe('not_declared');
		const rows = fs
			.readdirSync(scopesDir)
			.filter((n) => n.startsWith('binding-') && n.endsWith('.json'));
		expect(rows).toEqual([]);

		// Defence in depth: even if the file survives (failed unlink), a
		// re-imported row for a retired generation must not authorize.
		fs.writeFileSync(savedFile, savedContent);
		clearScopeBindings();
		closeAllProjectDbs();
		const backstop = resolveScopeBindingFromDisk({
			directory,
			taskId: '1.1',
			plan,
			ownerSessionId: 'architect-session',
			requireDeclaration: true,
			includeExpired: false,
		});
		expect(backstop.status).toBe('not_declared');

		// A legitimate re-declaration is not blocked by the terminal entry.
		const second = makeDeclaration(directory, plan);
		expect(
			await replaceExistingScopeDeclaration({
				directory,
				binding: second,
				replaceExisting: true,
			}),
		).toMatchObject({ ok: true });
		clearScopeBindings();
		closeAllProjectDbs();
		const redeployed = resolveScopeBindingFromDisk({
			directory,
			taskId: '1.1',
			plan,
			ownerSessionId: 'architect-session',
			requireDeclaration: true,
			includeExpired: false,
		});
		expect(redeployed.status).toBe('found');
	}, 60_000);
});
