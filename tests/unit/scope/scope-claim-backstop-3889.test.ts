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
	claimScopeBindingForChildDurably,
	clearSessionScopeBindingsFromDisk,
	persistAndRegisterScopeBinding,
	resolveScopeBindingFromDisk,
} from '../../../src/scope/scope-persistence';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

function setup(): { directory: string; plan: Plan } {
	const directory = canonicalMkdtemp('scope-claim-backstop-');
	roots.push(directory);
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Claim backstop plan',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Claim backstop',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Claim backstop',
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

afterEach(() => {
	clearScopeBindings();
	closeAllProjectDbs();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe('retired generations cannot be re-claimed through a leftover file (#3889)', () => {
	test('a leftover binding file for a retired claim cannot restore authority', async () => {
		const { directory, plan } = setup();
		const parent = createScopeBinding({
			directory,
			plan,
			taskId: '1.1',
			files: ['src/a.ts'],
			ownerSessionId: 'architect-session',
			ownerMessageId: 'task-call',
			dispatchCallId: 'task-call',
			activation: 'pending_child',
			source: 'plan',
		});
		expect(parent).not.toBeNull();
		const published = await persistAndRegisterScopeBinding(directory, parent!);
		expect(published.ok).toBe(true);
		const claimed = await claimScopeBindingForChildDurably({
			directory,
			parentSessionId: 'architect-session',
			childSessionId: 'coder-session',
			dispatchCallId: 'task-call',
		});
		expect(claimed.ok).toBe(true);

		const scopesDir = path.join(directory, '.swarm', 'scopes');
		const filesBefore = fs
			.readdirSync(scopesDir)
			.filter((n) => n.startsWith('binding-') && n.endsWith('.json'));
		expect(filesBefore.length).toBeGreaterThan(0);
		const savedFile = path.join(scopesDir, filesBefore[0]!);
		const savedContent = fs.readFileSync(savedFile, 'utf8');

		const outcome = await clearSessionScopeBindingsFromDisk(directory, [
			'coder-session',
		]);
		expect(outcome.removed).toBeGreaterThan(0);

		// Simulate a failed shadow unlink (for example a Windows lock): the
		// retired generation's binding file survives on disk.
		fs.writeFileSync(savedFile, savedContent);
		clearScopeBindings();
		closeAllProjectDbs();

		// The leftover file must not let a child re-claim authority.
		const reClaim = await claimScopeBindingForChildDurably({
			directory,
			parentSessionId: 'architect-session',
			childSessionId: 'coder-session',
			dispatchCallId: 'task-call',
		});
		expect(reClaim.ok).toBe(false);

		const resolution = resolveScopeBindingFromDisk({
			directory,
			taskId: '1.1',
			plan,
			ownerSessionId: 'coder-session',
			requireDeclaration: false,
			includeExpired: false,
		});
		expect(resolution.status).toBe('not_declared');
	}, 60_000);
});
