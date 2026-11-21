import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Plan } from '../../../src/config/plan-schema';
import {
	clearScopeBindings,
	createScopeBinding,
	getScopeBinding,
	hasDeliberateScopeBindingDenyOverlay,
	hasScopeBindingDenyOverlay,
	MAX_PENDING_SCOPE_BINDINGS,
	MAX_SCOPE_BINDING_AGE_MS,
	registerScopeBinding,
	type ScopeBinding,
} from '../../../src/scope/scope-binding';
import {
	persistAndRegisterScopeBinding,
	refreshScopeBindingLease,
} from '../../../src/scope/scope-persistence';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { freezeClock } from '../../helpers/test-clock';

const HOUR_MS = 60 * 60 * 1000;
const FIXED_NOW = 1_700_000_000_000;

let restoreClock: () => void = () => {};
const cleanups: Array<() => void> = [];

function workspace(prefix: string): string {
	const created = createSafeTestDir(prefix);
	cleanups.push(created.cleanup);
	return created.dir;
}

function plan(title = 'Lease age cap'): Plan {
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'default',
		phases: [
			{
				id: 1,
				name: 'Fix',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'repair',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	};
}

let seq = 0;
const planFixture = plan();

/** One live declaration with a unique task/session identity (unique map key). */
function freshBinding(directory: string): ScopeBinding {
	seq += 1;
	const binding = createScopeBinding({
		directory,
		plan: planFixture,
		taskId: `1.${seq}`,
		files: ['src/a.ts'],
		ownerSessionId: `ses_lease_age_${seq}`,
		ownerMessageId: `msg_lease_age_${seq}`,
		source: 'declare_scope',
	});
	if (!binding)
		throw new Error(`createScopeBinding returned null for seq ${seq}`);
	return binding;
}

/**
 * Shape of a binding that has been continuously lease-renewed: `expiresAt`
 * is in the future (refreshScopeBindingLease keeps it so) while `declaredAt`
 * is the ORIGINAL declaration time (the renewal spreads `...current`).
 */
function renewedOldBinding(binding: ScopeBinding, ageMs: number): ScopeBinding {
	return {
		...binding,
		declaredAt: FIXED_NOW - ageMs,
		updatedAt: FIXED_NOW,
		leaseStartedAt: FIXED_NOW,
		expiresAt: FIXED_NOW + HOUR_MS,
	};
}

/** Exact-identity lookup for a synthetic declaration (runs a sweep first). */
function lookup(directory: string, binding: ScopeBinding): ScopeBinding | null {
	return getScopeBinding({
		directory,
		plan: planFixture,
		taskId: binding.taskId,
		ownerSessionId: binding.ownerSessionId,
		ownerMessageId: binding.ownerMessageId,
	});
}

let directory: string;

beforeEach(() => {
	clearScopeBindings();
	restoreClock = freezeClock({ fixedNow: FIXED_NOW });
	directory = workspace('scope-lease-age');
	seq = 0;
});

afterEach(() => {
	restoreClock();
	clearScopeBindings();
	restoreClock = () => {};
	while (cleanups.length > 0) {
		cleanups.pop()?.();
	}
});

test('exported hard age cap is 24h', () => {
	expect(MAX_SCOPE_BINDING_AGE_MS).toBe(24 * HOUR_MS);
});

test('fresh entries at capacity still fail closed (the cap must not evict fresh entries)', () => {
	// Admission is checked BEFORE insertion, so the 256th fresh entry
	// legitimately occupies the last slot and the 257th must fail.
	for (let i = 0; i < MAX_PENDING_SCOPE_BINDINGS; i += 1) {
		const result = registerScopeBinding(freshBinding(directory));
		expect(result.ok).toBe(true);
	}
	const blocked = registerScopeBinding(freshBinding(directory));
	expect(blocked.ok).toBe(false);
	if (!blocked.ok) expect(blocked.code).toBe('SCOPE_BINDING_CAPACITY');
});

test('renewed entries older than the cap are swept, reopening admission (issue #3889)', () => {
	// Admit one 23h-old and one 25h-old binding shaped like continuously
	// renewed live bindings (expiresAt in the future; the 23h entry must NOT
	// be touched by the age cap), then fresh entries up to the map's capacity.
	const retained = renewedOldBinding(freshBinding(directory), 23 * HOUR_MS);
	expect(registerScopeBinding(retained).ok).toBe(true);
	const aged = renewedOldBinding(freshBinding(directory), 25 * HOUR_MS);
	expect(registerScopeBinding(aged).ok).toBe(true);
	for (let i = 0; i < MAX_PENDING_SCOPE_BINDINGS - 2; i += 1) {
		expect(registerScopeBinding(freshBinding(directory)).ok).toBe(true);
	}
	// The next declare_scope must be admitted: sweepExpired runs at the top
	// of registerScopeBinding and must evict the 25h entry instead of
	// leaving them to accumulate toward SCOPE_BINDING_CAPACITY.
	const reopened = registerScopeBinding(freshBinding(directory));
	expect(reopened.ok).toBe(true);
	// The 25h entry is gone; the 23h entry is retained; the new binding
	// resolves under its own identity.
	expect(lookup(directory, aged)).toBeNull();
	expect(lookup(directory, retained)?.generationId).toBe(retained.generationId);
	expect(reopened.ok && lookup(directory, reopened.binding)).not.toBeNull();
});

test('boundary: declared age exactly at the cap is retained, over the cap is evicted', () => {
	// `now - declaredAt > MAX` is strict: an entry declared exactly MAX ago
	// survives the sweep; one MAX+1h ago does not.
	const atCap = renewedOldBinding(
		freshBinding(directory),
		MAX_SCOPE_BINDING_AGE_MS,
	);
	expect(registerScopeBinding(atCap).ok).toBe(true);
	const overCap = renewedOldBinding(
		freshBinding(directory),
		MAX_SCOPE_BINDING_AGE_MS + HOUR_MS,
	);
	expect(registerScopeBinding(overCap).ok).toBe(true);
	for (let i = 0; i < MAX_PENDING_SCOPE_BINDINGS - 2; i += 1) {
		expect(registerScopeBinding(freshBinding(directory)).ok).toBe(true);
	}
	const reopened = registerScopeBinding(freshBinding(directory));
	expect(reopened.ok).toBe(true);
	expect(lookup(directory, atCap)?.generationId).toBe(atCap.generationId);
	expect(lookup(directory, overCap)).toBeNull();
});

test('the real refreshScopeBindingLease re-sets the in-memory entry (the renewal leak line)', async () => {
	const original = freshBinding(directory);
	const persisted = await persistAndRegisterScopeBinding(directory, original);
	expect(persisted.ok).toBe(true);
	if (!persisted.ok) throw new Error('persistAndRegisterScopeBinding failed');
	const refreshed = await refreshScopeBindingLease({
		directory,
		bindingId: persisted.value.bindingId,
		generationId: persisted.value.generationId,
		expectedRevision: persisted.value.revision,
		activeSessionId: persisted.value.ownerSessionId,
		taskId: persisted.value.taskId,
	});
	expect(refreshed.ok).toBe(true);
	if (!refreshed.ok) throw new Error('refreshScopeBindingLease failed');
	// Deterministic under the frozen clock: the renewal extends the lease to
	// now + 1h, bumps the revision, and preserves the ORIGINAL declaredAt.
	expect(refreshed.value.revision).toBe(persisted.value.revision + 1);
	expect(refreshed.value.expiresAt).toBe(FIXED_NOW + HOUR_MS);
	expect(refreshed.value.declaredAt).toBe(persisted.value.declaredAt);
	// The leak line: updateExactScopeBinding re-set the in-process admission
	// map entry, so the map now carries the extended expiresAt while the
	// declared age keeps growing.
	const inMemory = lookup(directory, refreshed.value);
	expect(inMemory?.generationId).toBe(refreshed.value.generationId);
	expect(inMemory?.expiresAt).toBe(FIXED_NOW + HOUR_MS);
	expect(inMemory?.revision).toBe(refreshed.value.revision);
});

test('sweep eviction records an expired (non-deliberate) deny tombstone', () => {
	const aged = renewedOldBinding(freshBinding(directory), 25 * HOUR_MS);
	expect(registerScopeBinding(aged).ok).toBe(true);
	// Any later admission triggers the sweep, which evicts the aged entry.
	expect(registerScopeBinding(freshBinding(directory)).ok).toBe(true);
	expect(lookup(directory, aged)).toBeNull();
	// The eviction wrote an 'expired' tombstone: it denies re-admission of
	// the stale snapshot...
	expect(hasScopeBindingDenyOverlay(aged)).toBe(true);
	// ...but it is a time-based sweep tombstone, not a deliberate revocation
	// (deliberate overlays are only 'revoked'/'superseded').
	expect(hasDeliberateScopeBindingDenyOverlay(aged)).toBe(false);
});
