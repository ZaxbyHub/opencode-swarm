import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Plan } from '../../../src/config/plan-schema';
import {
	closeAllProjectDbs,
	getProjectDb,
	listCoordinationStateRowsRaw,
	listCoordinationStates,
	transitionCoordinationState,
} from '../../../src/db';
import { createScopeBinding } from '../../../src/scope/scope-binding';
import {
	resolveScopeBindingFromDisk,
	tombstoneScopeBinding,
} from '../../../src/scope/scope-persistence';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

// The store readers this PR added (#3889) prepare no SQL the store did not
// already have, and the deny ledger is read by its one fixed key. On Windows,
// Bun keeps a closed connection's database file locked until garbage
// collection once that connection has prepared more than a few dozen
// statements, so a new statement in a long flow is enough to strand swarm.db
// at teardown: two pre-existing suites sat exactly on that boundary and went
// red when this PR prepared one more. These legs pin the readers' behavior;
// the boundary itself is pinned by those pre-existing suites on the Windows
// CI runners.
const plan: Plan = {
	schema_version: '1.0',
	title: 'store-readers',
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
	const root = canonicalMkdtemp('scope-store-readers-');
	roots.push(root);
	return root;
}

function seedRow(
	root: string,
	entityKey: string,
	payload: string,
	namespace = 'scope-binding',
): void {
	const seeded = transitionCoordinationState(root, {
		namespace,
		entityKey,
		generation: 1,
		status: namespace === 'scope-binding' ? 'live' : 'active',
		payload,
	});
	if (seeded.outcome !== 'applied')
		throw new Error(`seed failed: ${seeded.outcome}`);
}

/** Corrupt one stored payload out of band: the store's own writer refuses
 * non-JSON payloads, so only an external edit can produce one. */
function corruptPayload(
	root: string,
	namespace: string,
	entityKey: string,
): void {
	getProjectDb(root).run(
		'UPDATE coordination_state SET payload = ? WHERE namespace = ? AND entity_key = ?',
		['{corrupt', namespace, entityKey],
	);
}

function liveDeclaration(root: string) {
	const binding = createScopeBinding({
		directory: root,
		plan,
		taskId: '1.1',
		files: ['src/a.ts'],
		ownerSessionId: 'owner',
		ownerMessageId: 'declare',
		source: 'declare_scope',
	});
	if (!binding) throw new Error('declaration fixture failed');
	seedRow(root, binding.generationId, JSON.stringify(binding));
	return binding;
}

function seedLedger(root: string): void {
	seedRow(
		root,
		'deny-ledger',
		JSON.stringify({ version: 1, entries: {} }),
		'scope-binding-deny',
	);
}

const KEY_A = '00000000-0000-4000-a000-000000000000';
const KEY_B = 'aaaaaaaa-0000-4000-a000-000000000001';
const KEY_C = 'ffffffff-0000-4000-a000-000000000002';

beforeEach(() => {
	restoreClock = freezeClock();
});

afterEach(() => {
	restoreClock?.();
	closeAllProjectDbs();
	for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

describe('store readers (#3889)', () => {
	test('the raw row list matches the validated reader and is bounded in key order', () => {
		const root = fixture();
		seedRow(root, KEY_B, '{"malformed":true}');
		seedRow(root, KEY_A, 'null');
		seedRow(root, KEY_C, JSON.stringify({ ok: true }));

		const project = (state: {
			entityKey: string;
			payload: string;
			revision: number;
			generation: number;
		}) => ({
			entityKey: state.entityKey,
			payload: state.payload,
			revision: state.revision,
			generation: state.generation,
		});
		const rows = listCoordinationStateRowsRaw(root, 'scope-binding', 10);
		expect(rows.map((row) => row.entityKey)).toEqual([KEY_A, KEY_B, KEY_C]);
		// Same rows the validated paged reader returns, payload bytes intact.
		expect(rows).toEqual(
			listCoordinationStates(root, 'scope-binding', 10).map(project),
		);
		expect(rows[0]?.payload).toBe('null');
		expect(rows[1]?.payload).toBe('{"malformed":true}');
		// Bounded by the limit, applied in key order.
		expect(
			listCoordinationStateRowsRaw(root, 'scope-binding', 2).map(
				(row) => row.entityKey,
			),
		).toEqual([KEY_A, KEY_B]);
		// An absent namespace and a non-positive limit read as empty.
		expect(
			listCoordinationStateRowsRaw(root, 'zz-absent-namespace', 10),
		).toEqual([]);
		expect(listCoordinationStateRowsRaw(root, 'scope-binding', 0)).toEqual([]);
	});

	test('the raw row list returns an unparsable payload untouched instead of throwing', () => {
		const root = fixture();
		seedRow(root, KEY_A, 'null');
		seedRow(root, KEY_B, JSON.stringify({ ok: true }));
		corruptPayload(root, 'scope-binding', KEY_B);
		// The validated reader rejects the whole namespace...
		expect(() => listCoordinationStates(root, 'scope-binding', 10)).toThrow();
		// ...while the raw reader hands recovery the bytes as stored.
		const rows = listCoordinationStateRowsRaw(root, 'scope-binding', 10);
		expect(rows.map((row) => [row.entityKey, row.payload])).toEqual([
			[KEY_A, 'null'],
			[KEY_B, '{corrupt'],
		]);
	});

	test('a deny ledger whose payload fails validation is unreadable, not a throw', () => {
		const resolve = (root: string) =>
			resolveScopeBindingFromDisk({
				directory: root,
				taskId: '1.1',
				plan,
				ownerSessionId: 'owner',
				requireDeclaration: true,
			}).status;
		// Control: a healthy binding under a healthy ledger resolves.
		const healthy = fixture();
		liveDeclaration(healthy);
		seedLedger(healthy);
		expect(resolve(healthy)).toBe('found');

		const root = fixture();
		liveDeclaration(root);
		seedLedger(root);
		corruptPayload(root, 'scope-binding-deny', 'deny-ledger');
		// The binding row is healthy; the ledger is the only corrupt input.
		// Its own validation classifies the payload; the store read itself
		// must not throw on the way there.
		expect(resolve(root)).toBe('store_unreadable');
	});

	test('a terminal transition with an unparsable ledger is a typed failure that leaves the row', async () => {
		// Control: with a healthy ledger the same retirement completes.
		const healthy = fixture();
		const healthyBinding = liveDeclaration(healthy);
		seedLedger(healthy);
		expect(
			await tombstoneScopeBinding(healthy, healthyBinding, 'revoked'),
		).toMatchObject({ ok: true });
		expect(
			listCoordinationStateRowsRaw(healthy, 'scope-binding', 10).map(
				(row) => row.entityKey,
			),
		).toEqual([]);

		const root = fixture();
		const binding = liveDeclaration(root);
		seedLedger(root);
		corruptPayload(root, 'scope-binding-deny', 'deny-ledger');
		const retired = await tombstoneScopeBinding(root, binding, 'revoked');
		// A read that validated would surface as a failed store read here; the
		// raw read carries the corrupt bytes to the ledger's own validation.
		expect(retired.ok).toBe(false);
		expect(retired.ok ? '' : retired.message).toBe(
			'Scope tombstone sink failed: The scope deny ledger payload is malformed.',
		);
		// Nothing was retired without its deny evidence.
		expect(
			listCoordinationStateRowsRaw(root, 'scope-binding', 10).map(
				(row) => row.entityKey,
			),
		).toEqual([binding.generationId]);
	});
});
