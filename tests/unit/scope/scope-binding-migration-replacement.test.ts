import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	clearScopeBindings,
	createClaimedScopeBinding,
	createScopeBinding,
} from '../../../src/scope/scope-binding';
import {
	readScopeBindingFromDisk,
	replaceExistingScopeDeclaration,
	resolveAuthorizedScopeBindingDetailed,
} from '../../../src/scope/scope-persistence';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

function setup(): { directory: string; plan: Plan } {
	const directory = canonicalMkdtemp('scope-migration-');
	roots.push(directory);
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Migration plan',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Migration',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Migrate',
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

function declaration(
	directory: string,
	plan: Plan,
	message: string,
	files = ['src/a.ts'],
) {
	const binding = createScopeBinding({
		directory,
		plan,
		taskId: '1.1',
		files,
		ownerSessionId: 'architect-session',
		ownerMessageId: message,
		source: 'declare_scope',
	});
	if (!binding) throw new Error('declaration fixture failed');
	return binding;
}

afterEach(() => {
	clearScopeBindings();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe('scope binding migration and declaration replacement', () => {
	test('weak v2 filename migrates deterministically before authorization', () => {
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
		if (!parent) throw new Error('pending fixture failed');
		const active = createClaimedScopeBinding(parent, {
			parentSessionId: 'architect-session',
			childSessionId: 'coder-session',
			dispatchCallId: 'task-call',
		});
		const weak = { ...active } as Record<string, unknown>;
		for (const field of [
			'bindingId',
			'generationId',
			'revision',
			'lifecycleState',
			'updatedAt',
			'leaseStartedAt',
			'predecessorGenerationId',
		])
			delete weak[field];
		const ownerHash = createHash('sha256')
			.update('coder-session')
			.digest('hex')
			.slice(0, 24);
		fs.writeFileSync(
			path.join(directory, '.swarm', 'scopes', `binding-1.1-${ownerHash}.json`),
			JSON.stringify(weak),
		);

		const resolution = resolveAuthorizedScopeBindingDetailed({
			directory,
			taskId: '1.1',
			activeSessionId: 'coder-session',
		});
		expect(resolution).toMatchObject({ status: 'found' });
		const names = fs.readdirSync(path.join(directory, '.swarm', 'scopes'));
		expect(names.some((name) => name === `binding-1.1-${ownerHash}.json`)).toBe(
			false,
		);
		expect(
			names.filter((name) => name.startsWith('binding-1.1-')),
		).toHaveLength(1);
		expect(
			fs
				.readdirSync(path.join(directory, '.swarm', 'scopes', 'archive'))
				.some((name) => name.startsWith('migrated-')),
		).toBe(true);
	});

	test('replace_existing revokes owned generations and admits one declaration', async () => {
		const { directory, plan } = setup();
		const first = declaration(directory, plan, 'first');
		expect(
			await replaceExistingScopeDeclaration({
				directory,
				binding: first,
				replaceExisting: false,
			}),
		).toMatchObject({ ok: true });
		const second = declaration(directory, plan, 'second', [
			'src/a.ts',
			'src/b.ts',
		]);
		expect(
			await replaceExistingScopeDeclaration({
				directory,
				binding: second,
				replaceExisting: false,
			}),
		).toMatchObject({ ok: false, code: 'SCOPE_BINDING_AMBIGUOUS' });
		expect(
			await replaceExistingScopeDeclaration({
				directory,
				binding: second,
				replaceExisting: true,
			}),
		).toMatchObject({ ok: true });
		clearScopeBindings();
		expect(
			readScopeBindingFromDisk({
				directory,
				taskId: '1.1',
				plan,
				ownerSessionId: 'architect-session',
				requireDeclaration: true,
			}),
		).toMatchObject({ generationId: second.generationId, files: second.files });
	});
});
