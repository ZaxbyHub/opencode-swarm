import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	clearScopeBindings,
	createScopeBinding,
	MAX_PENDING_SCOPE_BINDINGS,
	registerScopeBinding,
} from '../../../src/scope/scope-binding';
import {
	claimScopeBindingForChildDurably,
	persistAndRegisterScopeBinding,
	readScopeBindingFromDisk,
	replaceExistingScopeDeclaration,
} from '../../../src/scope/scope-persistence';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

function fixture(): { directory: string; plan: Plan } {
	const directory = canonicalMkdtemp('scope-admission-');
	roots.push(directory);
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Scope admission rollback',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Test scope admission rollback',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	};
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan),
	);
	return { directory, plan };
}

function binding(
	directory: string,
	plan: Plan,
	ownerSessionId: string,
	ownerMessageId: string,
	activation: 'declaration' | 'pending_child' = 'declaration',
) {
	const value = createScopeBinding({
		directory,
		plan,
		taskId: '1.1',
		files: ['src/a.ts'],
		ownerSessionId,
		ownerMessageId,
		dispatchCallId: activation === 'pending_child' ? ownerMessageId : undefined,
		activation,
		source: activation === 'pending_child' ? 'plan' : 'declare_scope',
	});
	if (!value) throw new Error('scope binding fixture failed');
	return value;
}

function fillMemory(directory: string, plan: Plan, count: number): void {
	for (let i = 0; i < count; i += 1) {
		const admission = registerScopeBinding(
			binding(directory, plan, `filler-${i}`, `message-${i}`),
		);
		expect(admission.ok).toBeTrue();
	}
}

afterEach(() => {
	clearScopeBindings();
	closeAllProjectDbs();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe('scope admission rollback', () => {
	test('failed child claim revokes the successor and restores the pending predecessor', async () => {
		const { directory, plan } = fixture();
		const predecessor = binding(
			directory,
			plan,
			'architect-session',
			'task-call',
			'pending_child',
		);
		expect(
			await persistAndRegisterScopeBinding(directory, predecessor),
		).toMatchObject({ ok: true });
		fillMemory(directory, plan, MAX_PENDING_SCOPE_BINDINGS - 1);

		const result = await claimScopeBindingForChildDurably({
			directory,
			parentSessionId: 'architect-session',
			childSessionId: 'coder-session',
			dispatchCallId: 'task-call',
		});
		expect(result).toMatchObject({ ok: false, code: 'SCOPE_BINDING_CAPACITY' });
		expect(
			readScopeBindingFromDisk({
				directory,
				taskId: '1.1',
				plan,
				ownerSessionId: 'architect-session',
				ownerMessageId: 'task-call',
			}),
		).toMatchObject({
			generationId: predecessor.generationId,
			lifecycleState: 'live',
		});
	});

	test('failed declaration admission revokes the newly written generation', async () => {
		const { directory, plan } = fixture();
		fillMemory(directory, plan, MAX_PENDING_SCOPE_BINDINGS);
		const declaration = binding(
			directory,
			plan,
			'new-architect',
			'new-message',
		);

		const result = await replaceExistingScopeDeclaration({
			directory,
			binding: declaration,
			replaceExisting: true,
		});
		expect(result).toMatchObject({ ok: false, code: 'SCOPE_BINDING_CAPACITY' });
		expect(
			readScopeBindingFromDisk({
				directory,
				taskId: '1.1',
				plan,
				ownerSessionId: 'new-architect',
				ownerMessageId: 'new-message',
				requireDeclaration: true,
			}),
		).toBeNull();
	});
});
