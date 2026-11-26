import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	listCoordinationStateRowsRaw,
	listCoordinationStates,
} from '../../../src/db/coordination-store.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	clearScopeBindings,
	createScopeBinding,
	MAX_PENDING_SCOPE_BINDINGS,
	registerScopeBinding,
} from '../../../src/scope/scope-binding';
import {
	_scopePersistenceInternals,
	claimScopeBindingForChildDurably,
	persistAndRegisterScopeBinding,
	readScopeBindingFromDisk,
	replaceExistingScopeDeclaration,
	writeScopeBindingToDisk,
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
		// #3889 v4b contract: a failed admission revokes the whole chain — the
		// predecessor is NOT restored (retired through the deny-ledger sink) and
		// the unadmitted successor is deleted + deny-ledgered. Neither row may
		// authorize; recovery is a fresh declare (new generation unblocked).
		expect(
			readScopeBindingFromDisk({
				directory,
				taskId: '1.1',
				plan,
				ownerSessionId: 'architect-session',
				ownerMessageId: 'task-call',
			}),
		).toBeNull();
		const denyRows = listCoordinationStateRowsRaw(
			directory,
			'scope-binding-deny',
			2,
		);
		const ledger = JSON.parse(
			denyRows.find((row) => row.entityKey === 'deny-ledger')?.payload ??
				'{"entries":{}}',
		) as { entries: Record<string, { kind: string }> };
		expect(ledger.entries[predecessor.generationId]?.kind).toBe('terminal');
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

	test('full capacity still admits an atomic replacement after retiring its predecessor', async () => {
		const { directory, plan } = fixture();
		const predecessor = binding(directory, plan, 'architect-session', 'first');
		expect(
			await persistAndRegisterScopeBinding(directory, predecessor),
		).toMatchObject({ ok: true });
		fillMemory(directory, plan, MAX_PENDING_SCOPE_BINDINGS - 1);

		const replacement = binding(directory, plan, 'architect-session', 'second');
		expect(
			await replaceExistingScopeDeclaration({
				directory,
				binding: replacement,
				replaceExisting: true,
			}),
		).toMatchObject({
			ok: true,
			value: { generationId: replacement.generationId },
		});
	});

	for (const scenario of ['child claim', 'declaration replacement'] as const) {
		test(`a failed ${scenario} successor write persists nothing (#3889 atomicity)`, async () => {
			const { directory, plan } = fixture();
			const predecessor = binding(
				directory,
				plan,
				'architect-session',
				scenario === 'child claim' ? 'task-call' : 'first',
				scenario === 'child claim' ? 'pending_child' : 'declaration',
			);
			expect(
				await persistAndRegisterScopeBinding(directory, predecessor),
			).toMatchObject({ ok: true });
			const original =
				_scopePersistenceInternals.transitionScopeBindingStateWithinTransaction;
			let calls = 0;
			// Fault the successor write itself: under the new flow the successor
			// write, its admission-pending ledger entry, and the predecessor
			// retirement all live in ONE transaction, so a failure at the first
			// step must leave the store byte-identical.
			_scopePersistenceInternals.transitionScopeBindingStateWithinTransaction =
				(transitionDirectory, candidate, expectedRevision) =>
					++calls === 1
						? {
								ok: false,
								code: 'SCOPE_BINDING_PERSISTENCE_FAILED',
								message: 'injected successor write failure',
							}
						: original(transitionDirectory, candidate, expectedRevision);
			try {
				const result =
					scenario === 'child claim'
						? await claimScopeBindingForChildDurably({
								directory,
								parentSessionId: 'architect-session',
								childSessionId: 'coder-session',
								dispatchCallId: 'task-call',
							})
						: await replaceExistingScopeDeclaration({
								directory,
								binding: binding(
									directory,
									plan,
									'architect-session',
									'replacement',
								),
								replaceExisting: true,
							});
				expect(result).toMatchObject({
					ok: false,
					code: 'SCOPE_BINDING_PERSISTENCE_FAILED',
				});
				expect(
					listCoordinationStates(directory, 'scope-binding', 10).map((row) => [
						row.entityKey,
						row.status,
					]),
				).toEqual([[predecessor.generationId, 'live']]);
			} finally {
				_scopePersistenceInternals.transitionScopeBindingStateWithinTransaction =
					original;
			}
		});
	}

	test('F9 (#3889 contract): a capacity-failed admission retires the whole prior chain', async () => {
		// v4b: predecessors are retired through the shared sink in the same
		// transaction as the successor write; a failed in-memory admission then
		// revokes the successor too. Nothing stays authorizable and every
		// retired generation carries terminal deny evidence.
		const { directory, plan } = fixture();
		const first = binding(directory, plan, 'architect-session', 'first');
		const second = binding(directory, plan, 'architect-session', 'second');
		expect(await writeScopeBindingToDisk(directory, first)).toMatchObject({
			ok: true,
		});
		expect(await writeScopeBindingToDisk(directory, second)).toMatchObject({
			ok: true,
		});
		const replacement = binding(directory, plan, 'architect-session', 'third');
		const collision = binding(directory, plan, 'other-session', 'collision');
		expect(
			registerScopeBinding({
				...collision,
				generationId: replacement.generationId,
			}),
		).toMatchObject({ ok: true });
		fillMemory(directory, plan, MAX_PENDING_SCOPE_BINDINGS - 1);

		// The colliding in-memory generation identity makes the successor
		// admission fail STALE (the exact-identity check fires before the
		// capacity check); either class drives the same sink compensation.
		expect(
			await replaceExistingScopeDeclaration({
				directory,
				binding: replacement,
				replaceExisting: true,
			}),
		).toMatchObject({ ok: false, code: 'SCOPE_BINDING_STALE' });
		const rows = listCoordinationStates(directory, 'scope-binding', 10);
		expect(rows.map((row) => [row.entityKey, row.status])).toEqual([]);
		const denyRows = listCoordinationStateRowsRaw(
			directory,
			'scope-binding-deny',
			2,
		);
		const ledger = JSON.parse(
			denyRows.find((row) => row.entityKey === 'deny-ledger')?.payload ??
				'{"entries":{}}',
		) as { entries: Record<string, { kind: string }> };
		expect(ledger.entries[first.generationId]?.kind).toBe('terminal');
		expect(ledger.entries[second.generationId]?.kind).toBe('terminal');
		expect(ledger.entries[replacement.generationId]?.kind).toBe('terminal');
	});
});
