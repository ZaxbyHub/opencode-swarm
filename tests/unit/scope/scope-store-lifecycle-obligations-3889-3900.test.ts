import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import type { Plan } from '../../../src/config/plan-schema';
import {
	closeAllProjectDbs,
	deleteCoordinationState,
	listCoordinationStateRowsRaw,
	transitionCoordinationState,
	withCoordinationTransaction,
} from '../../../src/db';
import {
	clearScopeBindings,
	createScopeBinding,
	registerScopeBinding,
	type ScopeBinding,
} from '../../../src/scope/scope-binding';
import {
	_scopePersistenceInternals,
	claimScopeBindingForChildDurably,
	clearSessionScopeBindingsFromDisk,
	flushScopeBindingMaintenance,
	replaceExistingScopeDeclaration,
	resolveScopeBindingFromDisk,
} from '../../../src/scope/scope-persistence';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const plan: Plan = {
	schema_version: '1.0.0',
	title: 'obligations',
	swarm: 'test',
	current_phase: 1,
	phases: [
		{
			id: 1,
			name: 'P',
			status: 'in_progress',
			tasks: [
				{
					id: '1.1',
					phase: 1,
					status: 'pending',
					size: 'small',
					description: 'd',
					depends: [],
					files_touched: ['src/a.ts'],
				},
			],
		},
	],
};

const roots: string[] = [];
let restoreClock: Restore | undefined;

function fixture(): string {
	const root = canonicalMkdtemp('scope-obligations-');
	roots.push(root);
	return root;
}

function decl(root: string, owner: string, message: string): ScopeBinding {
	const value = createScopeBinding({
		directory: root,
		plan,
		taskId: '1.1',
		files: ['src/a.ts'],
		ownerSessionId: owner,
		ownerMessageId: message,
		source: 'declare_scope',
	});
	if (!value) throw new Error('fixture failed');
	return value;
}

function readLedger(root: string): Record<string, { kind: string }> {
	const rows = listCoordinationStateRowsRaw(root, 'scope-binding-deny', 2);
	const payload = rows.find((row) => row.entityKey === 'deny-ledger')?.payload;
	if (!payload) return {};
	return (JSON.parse(payload) as { entries: Record<string, { kind: string }> })
		.entries;
}

beforeEach(() => {
	restoreClock = freezeClock();
});

afterEach(() => {
	restoreClock?.();
	clearScopeBindings();
	closeAllProjectDbs();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe('plan-critic round-7 obligations (#3889/#3900)', () => {
	test('legacy backfill installs exact-generation deny entries (obligation 4)', async () => {
		const root = fixture();
		const live = decl(root, 'owner', 'live');
		expect(
			await replaceExistingScopeDeclaration({
				directory: root,
				binding: live,
				replaceExisting: true,
			}),
		).toMatchObject({ ok: true });
		const now = Date.now();
		const legacyIds: string[] = [];
		for (let i = 0; i < 6; i += 1) {
			const generationId = `ccccccc${i}-0000-4000-a000-00000000000${i}`;
			legacyIds.push(generationId);
			const row = {
				...decl(root, `old-${i}`, `msg-${i}`),
				generationId,
				declaredAt: now - 26 * 60 * 60 * 1000,
				updatedAt: now - 25 * 60 * 60 * 1000,
				leaseStartedAt: now - 26 * 60 * 60 * 1000,
				expiresAt: now - 25 * 60 * 60 * 1000,
				lifecycleState: 'superseded' as const,
			};
			transitionCoordinationState(root, {
				namespace: 'scope-binding',
				entityKey: generationId,
				generation: 1,
				status: 'superseded',
				payload: JSON.stringify(row),
			});
		}
		// One authoritative read schedules maintenance; flush drains it.
		expect(
			resolveScopeBindingFromDisk({
				directory: root,
				taskId: '1.1',
				plan,
				ownerSessionId: 'owner',
				requireDeclaration: true,
			}),
		).toMatchObject({ status: 'found' });
		await flushScopeBindingMaintenance(root);
		// Only the live generation remains resolvable for the task.
		expect(
			resolveScopeBindingFromDisk({
				directory: root,
				taskId: '1.1',
				plan,
				ownerSessionId: 'owner',
				requireDeclaration: true,
			}),
		).toMatchObject({ status: 'found' });
		const legacyResolutions = [] as string[];
		for (let i = 0; i < 6; i += 1) {
			const resolution = resolveScopeBindingFromDisk({
				directory: root,
				taskId: '1.1',
				plan,
				ownerSessionId: 'old-' + i,
				requireDeclaration: true,
			});
			legacyResolutions.push(resolution.status);
		}
		expect(legacyResolutions).toEqual([
			'not_declared',
			'not_declared',
			'not_declared',
			'not_declared',
			'not_declared',
			'not_declared',
		]);
		const ledger = readLedger(root);
		for (const generationId of legacyIds) {
			expect(ledger[generationId]?.kind).toBe('terminal');
		}
	}, 60_000);

	test('second-runtime stale authority stays denied after reset (obligation 3)', async () => {
		const root = fixture();
		const binding = decl(root, 'session-x', 'declare');
		expect(registerScopeBinding(binding).ok).toBe(true);
		// Durable row for session-x.
		const seed = transitionCoordinationState(root, {
			namespace: 'scope-binding',
			entityKey: binding.generationId,
			generation: 1,
			status: 'live',
			payload: JSON.stringify(binding),
		});
		expect(seed.outcome).toBe('applied');
		// Reset (another "runtime"): durable sweep + in-memory clear.
		const sweep = await clearSessionScopeBindingsFromDisk(root, ['session-x']);
		expect(sweep.removed).toBe(1);
		// Second runtime REINSTALLS stale in-memory authority after the reset.
		expect(
			registerScopeBinding({ ...binding, revision: binding.revision }).ok,
		).toBe(true);
		// Fallback resolution through the reinstalled copy is denied by the
		// terminal ledger entry (no durable row exists anymore).
		expect(
			resolveScopeBindingFromDisk({
				directory: root,
				taskId: '1.1',
				plan,
				ownerSessionId: 'session-x',
				requireDeclaration: true,
			}),
		).toMatchObject({ status: 'not_declared' });
		expect(readLedger(root)[binding.generationId]?.kind).toBe('terminal');
	}, 60_000);

	test('committed successor stays denied when compensation fails after commit (obligation 5, declaration)', async () => {
		const root = fixture();
		const replacement = decl(root, 'architect', 'replacement');
		// Force in-memory admission failure AFTER commit: occupy the map.
		const collision = decl(root, 'other', 'collision');
		expect(
			registerScopeBinding({
				...collision,
				generationId: replacement.generationId,
			}).ok,
		).toBe(true);
		const result = await replaceExistingScopeDeclaration({
			directory: root,
			binding: replacement,
			replaceExisting: true,
		});
		// Admission failed STALE after the successor committed; compensation
		// retired it through the sink. A fresh runtime cannot resolve it found
		// (durable row gone + terminal ledger entry).
		expect(result).toMatchObject({ ok: false });
		const fresh = resolveScopeBindingFromDisk({
			directory: root,
			taskId: '1.1',
			plan,
			ownerSessionId: 'architect',
			requireDeclaration: true,
		});
		expect(fresh.status).not.toBe('found');
		expect(readLedger(root)[replacement.generationId]?.kind).toBe('terminal');
	}, 60_000);

	test('claimed successor carries admission-pending deny evidence until admitted (obligation 5, claim)', async () => {
		const root = fixture();
		const predecessor = createScopeBinding({
			directory: root,
			plan,
			taskId: '1.1',
			files: ['src/a.ts'],
			ownerSessionId: 'architect',
			ownerMessageId: 'task-call',
			dispatchCallId: 'task-call',
			activation: 'pending_child',
			source: 'plan',
		});
		if (!predecessor) throw new Error('predecessor fixture failed');
		const seed = transitionCoordinationState(root, {
			namespace: 'scope-binding',
			entityKey: predecessor.generationId,
			generation: 1,
			status: 'live',
			payload: JSON.stringify(predecessor),
		});
		expect(seed.outcome).toBe('applied');
		const claimed = await claimScopeBindingForChildDurably({
			directory: root,
			parentSessionId: 'architect',
			childSessionId: 'coder',
			dispatchCallId: 'task-call',
		});
		expect(claimed).toMatchObject({ ok: true });
		// Admission succeeded -> pending released; the claimed generation
		// resolves found and no pending entry remains.
		const ledger = readLedger(root);
		expect(ledger[claimed.value.claimed.generationId]?.kind).not.toBe(
			'admission-pending',
		);
		expect(
			resolveScopeBindingFromDisk({
				directory: root,
				taskId: '1.1',
				plan,
				ownerSessionId: 'coder',
				requireDispatchCorrelation: true,
			}),
		).toMatchObject({ status: 'found' });
	}, 60_000);
});

describe('plan-critic round-7 obligations, 4.5 round-2 findings', () => {
	test('failed post-commit compensation leaves the successor deny-ledgered, not authorizable (round-2 finding 2)', async () => {
		const root = fixture();
		const replacement = decl(root, 'architect', 'replacement');
		const collision = decl(root, 'other', 'collision');
		expect(
			registerScopeBinding({
				...collision,
				generationId: replacement.generationId,
			}).ok,
		).toBe(true);
		const original =
			_scopePersistenceInternals.retireScopeBindingGenerationWithinTransaction;
		let sunk = 0;
		_scopePersistenceInternals.retireScopeBindingGenerationWithinTransaction =
			() => {
				sunk += 1;
				return {
					ok: false,
					code: 'SCOPE_BINDING_PERSISTENCE_FAILED',
					message: 'injected compensation sink failure',
				};
			};
		try {
			const result = await replaceExistingScopeDeclaration({
				directory: root,
				binding: replacement,
				replaceExisting: true,
			});
			expect(result).toMatchObject({
				ok: false,
				code: 'SCOPE_BINDING_PERSISTENCE_FAILED',
			});
			expect(sunk).toBeGreaterThan(0);
			const rows = listCoordinationStateRowsRaw(root, 'scope-binding', 10);
			expect(
				rows.some((row) => row.entityKey === replacement.generationId),
			).toBe(true);
			const fresh = resolveScopeBindingFromDisk({
				directory: root,
				taskId: '1.1',
				plan,
				ownerSessionId: 'architect',
				requireDeclaration: true,
			});
			expect(fresh.status).not.toBe('found');
			const ledger = readLedger(root);
			expect(ledger[replacement.generationId]?.kind).toBe('admission-pending');
		} finally {
			_scopePersistenceInternals.retireScopeBindingGenerationWithinTransaction =
				original;
		}
	}, 60_000);

	test('one flush drains more than one 128-row maintenance batch (round-2 finding 1)', async () => {
		const root = fixture();
		const live = decl(root, 'owner', 'live');
		expect(
			await replaceExistingScopeDeclaration({
				directory: root,
				binding: live,
				replaceExisting: true,
			}),
		).toMatchObject({ ok: true });
		const now = Date.now();
		const total = 300;
		for (let i = 0; i < total; i += 1) {
			const hex = i.toString(16).padStart(12, '0');
			const generationId = 'dddddddd-0000-4000-a000-' + hex;
			const row = {
				...decl(root, 'bulk-old', 'bulk-' + i),
				generationId,
				declaredAt: now - 26 * 60 * 60 * 1000,
				updatedAt: now - 25 * 60 * 60 * 1000,
				leaseStartedAt: now - 26 * 60 * 60 * 1000,
				expiresAt: now - 25 * 60 * 60 * 1000,
				lifecycleState: 'superseded' as const,
			};
			transitionCoordinationState(root, {
				namespace: 'scope-binding',
				entityKey: generationId,
				generation: 1,
				status: 'superseded',
				payload: JSON.stringify(row),
			});
		}
		expect(
			resolveScopeBindingFromDisk({
				directory: root,
				taskId: '1.1',
				plan,
				ownerSessionId: 'owner',
				requireDeclaration: true,
			}),
		).toMatchObject({ status: 'found' });
		await flushScopeBindingMaintenance(root);
		const remaining = listCoordinationStateRowsRaw(root, 'scope-binding', 500);
		expect(
			remaining.filter((row) => row.entityKey.startsWith('dddddddd-')),
		).toHaveLength(0);
	}, 120_000);
});

describe('the terminal sink retires only the row the caller named (#3889)', () => {
	const KEY = 'eeeeeeee-0000-4000-a000-000000000000';
	const store = (root: string, payload: Record<string, unknown>): void => {
		transitionCoordinationState(root, {
			namespace: 'scope-binding',
			entityKey: KEY,
			generation: 1,
			status: 'live',
			payload: JSON.stringify(payload),
		});
	};
	const retire = (
		root: string,
		bindingId: string,
		expectedPayload?: string,
	): unknown => {
		let failure: unknown = null;
		withCoordinationTransaction(root, () => {
			failure =
				_scopePersistenceInternals.retireScopeBindingGenerationWithinTransaction(
					root,
					{ bindingId, generationId: KEY, revision: 1, expiresAt: 0 },
					'revoked',
					expectedPayload,
				);
		});
		return failure;
	};
	const storedBindingIds = (root: string): unknown[] =>
		listCoordinationStateRowsRaw(root, 'scope-binding', 4).map(
			(row) => (JSON.parse(row.payload) as Record<string, unknown>).bindingId,
		);
	/** A row of the kind written before binding ids existed. */
	const legacyRow = (
		root: string,
		message: string,
	): Record<string, unknown> => {
		const legacy = { ...decl(root, 'victim', message), generationId: KEY };
		delete (legacy as Partial<typeof legacy>).bindingId;
		return legacy;
	};

	test('a different binding stored under the same key and revision is neither retired nor deny-ledgered', () => {
		const root = fixture();
		const listed = decl(root, 'victim', 'aba-listed');
		const replacement = decl(root, 'someone-else', 'aba-other');
		// Another process deletes the listed row and stores a different
		// binding under the same key. A fresh insert carries revision 1, the
		// revision the listed row had, so a delete by key and revision alone
		// would match it.
		store(root, { ...replacement, generationId: KEY });
		expect(retire(root, listed.bindingId)).toMatchObject({ ok: false });
		expect(storedBindingIds(root)).toEqual([replacement.bindingId]);
		expect(readLedger(root)).toEqual({});
	});

	test('the same binding stored again under its key and revision is retired', () => {
		const root = fixture();
		const listed = decl(root, 'victim', 'aba-same');
		store(root, { ...listed, generationId: KEY });
		expect(retire(root, listed.bindingId)).toBeNull();
		expect(storedBindingIds(root)).toEqual([]);
		expect(readLedger(root)).toMatchObject({
			[KEY]: { kind: 'terminal', bindingId: listed.bindingId },
		});
	});

	test('a legacy row that carries no binding id is left to the revision check', () => {
		const root = fixture();
		// Nothing to compare on either side, and no observed payload.
		store(root, legacyRow(root, 'aba-legacy'));
		expect(retire(root, '')).toBeNull();
		expect(storedBindingIds(root)).toEqual([]);
		// A caller that names a binding, against a row that names none, and
		// passes no payload: still only the key and revision are checked.
		store(root, legacyRow(root, 'aba-legacy-2'));
		expect(retire(root, 'aaaabbbb-0000-4000-a000-000000000000')).toBeNull();
		expect(storedBindingIds(root)).toEqual([]);
	});

	test('a caller that passes the payload it observed retires that content or nothing', () => {
		const root = fixture();
		const observed = legacyRow(root, 'aba-observed');
		// A different row under the same key and revision, carrying no binding
		// id: only its content can tell it from the row the caller observed.
		store(root, { ...observed, files: ['src/other.ts'] });
		expect(retire(root, 'listed', JSON.stringify(observed))).toMatchObject({
			ok: false,
		});
		expect(listCoordinationStateRowsRaw(root, 'scope-binding', 4)).toHaveLength(
			1,
		);
		expect(readLedger(root)).toEqual({});
		// The row the caller observed, stored again under the same key and
		// revision: retired.
		deleteCoordinationState(root, 'scope-binding', KEY);
		store(root, observed);
		expect(retire(root, 'listed', JSON.stringify(observed))).toBeNull();
		expect(storedBindingIds(root)).toEqual([]);
		expect(readLedger(root)).toMatchObject({ [KEY]: { bindingId: 'listed' } });
	});
});
