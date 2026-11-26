import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	closeAllProjectDbs,
	listCoordinationStateRowsRaw,
	transitionCoordinationState,
} from '../../../src/db';
import {
	clearScopeBindings,
	createScopeBinding,
	type ScopeBinding,
} from '../../../src/scope/scope-binding';
import {
	_scopePersistenceInternals,
	claimScopeBindingForChildDurably,
	clearSessionScopeBindingsFromDisk,
	flushScopeBindingMaintenance,
	resolveAuthorizedScopeBinding,
	resolveScopeBindingFromDisk,
} from '../../../src/scope/scope-persistence';
import { resetSwarmState } from '../../../src/state';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const plan: Plan = {
	schema_version: '1.0.0',
	title: 'failclosed',
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

const HOUR = 60 * 60 * 1000;
const roots: string[] = [];
let restoreClock: Restore | undefined;

function fixture(name: string): string {
	const root = canonicalMkdtemp(name);
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

function seedRow(root: string, binding: ScopeBinding): void {
	const seeded = transitionCoordinationState(root, {
		namespace: 'scope-binding',
		entityKey: binding.generationId,
		generation: 1,
		status: 'live',
		payload: JSON.stringify(binding),
	});
	if (seeded.outcome !== 'applied') throw new Error('seed failed');
}

/** Lapse a binding with internally consistent timestamps (a row whose
 * expiresAt precedes its leaseStartedAt fails binding-shape validation and
 * renders the whole store unreadable). */
function lapseBinding(binding: ScopeBinding, hoursPast: number): ScopeBinding {
	const expiresAt = Date.now() - hoursPast * HOUR;
	return {
		...binding,
		declaredAt: expiresAt - HOUR,
		updatedAt: expiresAt - HOUR,
		leaseStartedAt: expiresAt - HOUR,
		expiresAt,
	};
}

function rewriteRow(root: string, binding: ScopeBinding): void {
	// CAS rewrite: the row parser requires payload.revision to equal the
	// coordination row's revision column (and lifecycleState to equal the
	// row status), so the replacement payload carries the next revision.
	const existing = listCoordinationStateRowsRaw(root, 'scope-binding', 10).find(
		(row) => row.entityKey === binding.generationId,
	);
	const transition = transitionCoordinationState(root, {
		namespace: 'scope-binding',
		entityKey: binding.generationId,
		expectedRevision: existing?.revision,
		generation: 1,
		status: 'live',
		payload: JSON.stringify({
			...binding,
			revision: existing ? existing.revision + 1 : binding.revision,
		}),
	});
	if (transition.outcome !== 'applied') throw new Error('row rewrite failed');
}

function readLedger(
	root: string,
): Record<string, { kind: string; revision: number }> {
	const rows = listCoordinationStateRowsRaw(root, 'scope-binding-deny', 2);
	const payload = rows.find((row) => row.entityKey === 'deny-ledger')?.payload;
	if (!payload) return {};
	return (JSON.parse(payload) as { entries: Record<string, never> }).entries;
}

function writeLedger(root: string, entries: Record<string, unknown>): void {
	// Merge-aware: a claim may already have installed the ledger row, and the
	// coordination transition fails on a stale generation when it exists.
	const existing = listCoordinationStateRowsRaw(
		root,
		'scope-binding-deny',
		2,
	).find((row) => row.entityKey === 'deny-ledger');
	const merged: Record<string, unknown> = existing
		? ((JSON.parse(existing.payload) as { entries: Record<string, unknown> })
				.entries ?? {})
		: {};
	Object.assign(merged, entries);
	const transition = transitionCoordinationState(root, {
		namespace: 'scope-binding-deny',
		entityKey: 'deny-ledger',
		generation: existing ? existing.generation + 1 : 1,
		status: 'active',
		payload: JSON.stringify({ version: 1, entries: merged }),
	});
	if (transition.outcome !== 'applied') throw new Error('ledger seed failed');
}

beforeEach(() => {
	restoreClock = freezeClock();
});

afterEach(() => {
	restoreClock?.();
	resetSwarmState();
	clearScopeBindings();
	closeAllProjectDbs();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

// Final-critic F1: the fail-closed classes were proven only by git-ignored
// probes — these committed legs pin them for CI (mutations M1/M2/M4/M5/M6 of
// the round-1 critic each survived the then-committed suites).
describe('fail-closed contract (#3889, final-critic round 1)', () => {
	test('non-capacity durable-read failure classifies store_unreadable (M1)', () => {
		const root = fixture('failclosed-m1-');
		seedRow(root, decl(root, 'owner', 'live'));
		transitionCoordinationState(root, {
			namespace: 'scope-binding',
			entityKey: 'aaaaaaaa-0000-4000-a000-000000000001',
			generation: 1,
			status: 'live',
			// Valid JSON, wrong shape: parseCoordinationScopeBinding rejects it
			// (the coordination store itself refuses non-JSON payloads).
			payload: '{"malformed":true}',
		});
		const resolution = resolveScopeBindingFromDisk({
			directory: root,
			taskId: '1.1',
			plan,
			ownerSessionId: 'owner',
			requireDeclaration: true,
		});
		expect(resolution.status).toBe('store_unreadable');
		expect(resolution.status).not.toBe('overloaded');
	});

	test('unreadable deny ledger fails closed before any fallback (M4)', () => {
		const root = fixture('failclosed-m4-');
		seedRow(root, decl(root, 'owner', 'live'));
		transitionCoordinationState(root, {
			namespace: 'scope-binding-deny',
			entityKey: 'deny-ledger',
			generation: 1,
			status: 'active',
			// Valid JSON, wrong ledger shape (version !== 1): the tri-state
			// reader classifies it unreadable.
			payload: '{"version":2,"entries":{}}',
		});
		const resolution = resolveScopeBindingFromDisk({
			directory: root,
			taskId: '1.1',
			plan,
			ownerSessionId: 'owner',
			requireDeclaration: true,
		});
		// The binding rows are healthy; only the ledger is corrupt — still
		// store_unreadable, never found/not_declared via fallback trust.
		expect(resolution.status).toBe('store_unreadable');
	});

	test('reset sweep treats a null-payload row as unidentifiable (F2)', async () => {
		const root = fixture('failclosed-f2-');
		const victim = decl(root, 'victim', 'declare');
		seedRow(root, victim);
		transitionCoordinationState(root, {
			namespace: 'scope-binding',
			entityKey: 'bbbbbbbb-0000-4000-a000-000000000001',
			generation: 1,
			status: 'live',
			payload: 'null',
		});
		// Pre-fix this threw (TypeError on parsed.ownerSessionId) and swept
		// nothing; now the corrupt row is counted and the good row is swept.
		const sweep = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		expect(sweep).toMatchObject({ removed: 1, unidentifiable: 1 });
		expect(
			listCoordinationStateRowsRaw(root, 'scope-binding', 10).some(
				(row) => row.entityKey === victim.generationId,
			),
		).toBe(false);
	});

	test('pending entry survives FIFO flood and has no independent TTL (obligation 6)', async () => {
		const root = fixture('failclosed-ob6-');
		const entries: Record<string, unknown> = {};
		const now = Date.now();
		for (let i = 0; i < 2049; i += 1) {
			// Oldest terminals first so FIFO evicts index 0.
			entries[
				`f${i.toString(16).padStart(4, '0')}000-0000-4000-a000-000000000000`
			] = {
				bindingId: `flood-${i}`,
				kind: 'terminal',
				revision: 1,
				at: now - 23 * HOUR + i,
				rowExpiresAt: now - 23 * HOUR + i,
			};
		}
		const stalePendingId = 'cccccc00-0000-4000-a000-000000000000';
		// Stale pending (48h old, future row expiry): no independent TTL may
		// prune it.
		entries[stalePendingId] = {
			bindingId: 'stale-pending',
			kind: 'admission-pending',
			revision: 7,
			at: now - 48 * HOUR,
			rowExpiresAt: now + 24 * HOUR,
		};
		writeLedger(root, entries);
		// Any ledger write runs housekeeping: a claim adds + releases its own
		// pending entry and prunes the terminal FIFO to its 2048 cap.
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
		seedRow(root, predecessor);
		const claimed = await claimScopeBindingForChildDurably({
			directory: root,
			parentSessionId: 'architect',
			childSessionId: 'coder',
			dispatchCallId: 'task-call',
		});
		expect(claimed).toMatchObject({ ok: true });
		const ledger = readLedger(root);
		// The stale pending entry survived the flood + housekeeping.
		expect(ledger[stalePendingId]).toMatchObject({
			kind: 'admission-pending',
		});
		// The terminal FIFO cap held at 2048 and evicted the oldest.
		const terminals = Object.values(ledger).filter(
			(entry) => entry.kind === 'terminal',
		);
		expect(terminals.length).toBeLessThanOrEqual(2048);
		expect(ledger['f00000000-0000-4000-a000-000000000000']).toBeUndefined();
	}, 60_000);

	test('a foreign pending entry and a terminal entry survive an unrelated admission release (obligation 7)', async () => {
		const root = fixture('failclosed-ob7-');
		const now = Date.now();
		writeLedger(root, {
			'ddddddd0-0000-4000-a000-000000000000': {
				bindingId: 'foreign-pending',
				kind: 'admission-pending',
				revision: 3,
				at: now,
				rowExpiresAt: now + 24 * HOUR,
			},
			'ddddddd1-0000-4000-a000-000000000001': {
				bindingId: 'foreign-terminal',
				kind: 'terminal',
				revision: 2,
				at: now,
				rowExpiresAt: now,
			},
		});
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
		seedRow(root, predecessor);
		const claimed = await claimScopeBindingForChildDurably({
			directory: root,
			parentSessionId: 'architect',
			childSessionId: 'coder',
			dispatchCallId: 'task-call',
		});
		expect(claimed).toMatchObject({ ok: true });
		// The claim's own pending entry released; the foreign entries of both
		// kinds at foreign revisions are untouched by that removal.
		const ledger = readLedger(root);
		expect(ledger['ddddddd0-0000-4000-a000-000000000000']).toMatchObject({
			kind: 'admission-pending',
			revision: 3,
		});
		expect(ledger['ddddddd1-0000-4000-a000-000000000001']).toMatchObject({
			kind: 'terminal',
			revision: 2,
		});
		expect(ledger[claimed.value.claimed.generationId]).toBeUndefined();
		// Interleaved delayed removal: a post-admission release arriving for a
		// generation whose pending entry now sits at a DIFFERENT revision must
		// not delete it; the exact-revision release must.
		const pendingGen = 'ddddddd0-0000-4000-a000-000000000000';
		_scopePersistenceInternals.releaseAdmissionPending(root, pendingGen, 2);
		expect(readLedger(root)[pendingGen]).toMatchObject({
			kind: 'admission-pending',
			revision: 3,
		});
		_scopePersistenceInternals.releaseAdmissionPending(root, pendingGen, 3);
		expect(readLedger(root)[pendingGen]).toBeUndefined();
		// The terminal neighbor survived both removals.
		expect(
			readLedger(root)['ddddddd1-0000-4000-a000-000000000001'],
		).toMatchObject({ kind: 'terminal', revision: 2 });
	});

	test('post-window maintenance terminalizes pending evidence and frees a fresh declaration (obligation 8)', async () => {
		const root = fixture('failclosed-ob8-');
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
		seedRow(root, predecessor);
		const claimed = await claimScopeBindingForChildDurably({
			directory: root,
			parentSessionId: 'architect',
			childSessionId: 'coder',
			dispatchCallId: 'task-call',
		});
		expect(claimed).toMatchObject({ ok: true });
		// Lapse the claimed row past the TTL + 24h revival window (direct
		// coordination rewrite: updateExactScopeBinding only maintains the
		// in-memory registration, not this durable row).
		const lapsed = lapseBinding(claimed.value.claimed, 48);
		rewriteRow(root, lapsed);
		// Drop the claim's in-memory authority so the durable contract is
		// what the post-sweep assertions observe.
		clearScopeBindings();
		// Normal maintenance: read (schedules) + flush (drains).
		resolveScopeBindingFromDisk({
			directory: root,
			taskId: '1.1',
			plan,
			ownerSessionId: 'coder',
			requireDispatchCorrelation: true,
		});
		await flushScopeBindingMaintenance(root);
		// The row is collected through the sink and the deny evidence is
		// terminal (v4d conversion at revival impossibility).
		expect(
			listCoordinationStateRowsRaw(root, 'scope-binding', 10).some(
				(row) => row.entityKey === lapsed.generationId,
			),
		).toBe(false);
		expect(readLedger(root)[lapsed.generationId]?.kind).toBe('terminal');
		// Fresh declaration is the immediate recovery — unblocked.
		const fresh = decl(root, 'architect', 'fresh');
		seedRow(root, fresh);
		expect(
			resolveScopeBindingFromDisk({
				directory: root,
				taskId: '1.1',
				plan,
				ownerSessionId: 'architect',
				requireDeclaration: true,
			}).status,
		).toBe('found');
	});

	test('admission-pending evidence denies idle revival inside the window (M6)', async () => {
		async function scenario(seedPending: boolean): Promise<string | null> {
			const root = fixture(
				seedPending ? 'failclosed-m6-deny-' : 'failclosed-m6-ctl-',
			);
			fs.mkdirSync(path.join(root, '.swarm'), { recursive: true });
			fs.writeFileSync(
				path.join(root, '.swarm', 'plan.json'),
				JSON.stringify(plan),
			);
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
			seedRow(root, predecessor);
			const claimed = await claimScopeBindingForChildDurably({
				directory: root,
				parentSessionId: 'architect',
				childSessionId: 'coder',
				dispatchCallId: 'task-call',
			});
			if (!claimed.ok) throw new Error('claim failed');
			// One hour past expiry: inside the 24h idle-revival window.
			const lapsed = lapseBinding(claimed.value.claimed, 1);
			rewriteRow(root, lapsed);
			if (seedPending) {
				writeLedger(root, {
					[lapsed.generationId]: {
						bindingId: lapsed.bindingId,
						kind: 'admission-pending',
						revision: lapsed.revision,
						at: Date.now(),
						rowExpiresAt: Date.now() + 24 * HOUR,
					},
				});
			}
			const resolved = resolveAuthorizedScopeBinding({
				directory: root,
				taskId: '1.1',
				activeSessionId: 'coder',
			});
			return resolved ? 'found' : null;
		}
		// Control: without pending evidence the idle binding revives.
		expect(await scenario(false)).toBe('found');
		// Deny: an admission-pending entry refuses revival (revision-ungated).
		expect(await scenario(true)).toBeNull();
	}, 60_000);
});
