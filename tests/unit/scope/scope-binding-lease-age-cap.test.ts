import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Plan } from '../../../src/config/plan-schema';
import {
	clearScopeBindings,
	createScopeBinding,
	MAX_PENDING_SCOPE_BINDINGS,
	MAX_SCOPE_BINDING_AGE_MS,
	registerScopeBinding,
} from '../../../src/scope/scope-binding';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const HOUR_MS = 60 * 60 * 1000;
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

/** One live declaration with a unique task/session identity (unique map key). */
function freshBinding(directory: string, planFixture: Plan, index: number) {
	const binding = createScopeBinding({
		directory,
		plan: planFixture,
		taskId: `1.${index + 1}`,
		files: ['src/a.ts'],
		ownerSessionId: `ses_lease_age_${index + 1}`,
		ownerMessageId: `msg_lease_age_${index + 1}`,
		source: 'declare_scope',
	});
	if (!binding) throw new Error(`createScopeBinding returned null for index ${index}`);
	return binding;
}

/**
 * Simulate a binding that was continuously lease-renewed: `expiresAt` is in
 * the future (as refreshScopeBindingLease keeps it), but `declaredAt` is old
 * (the renewal spreads `...current` and preserves it).
 */
function renewedOldBinding(binding: ReturnType<typeof freshBinding>): ReturnType<typeof freshBinding> {
	const now = Date.now();
	return {
		...binding,
		declaredAt: now - (25 * HOUR_MS),
		updatedAt: now,
		leaseStartedAt: now,
		expiresAt: now + HOUR_MS,
	};
}

describe('scope binding in-memory admission age cap (issue #3889)', () => {
	let directory: string;
	const planFixture = plan();

	beforeEach(() => {
		clearScopeBindings();
		directory = workspace('scope-lease-age');
	});

	afterEach(() => {
		clearScopeBindings();
	});

	test('exported hard age cap is 24h', () => {
		expect(MAX_SCOPE_BINDING_AGE_MS).toBe(24 * HOUR_MS);
	});

	test('fresh entries at capacity still fail closed (the cap must not evict fresh entries)', () => {
		for (let i = 0; i < MAX_PENDING_SCOPE_BINDINGS; i += 1) {
			const result = registerScopeBinding(freshBinding(directory, planFixture, i));
			expect(result.ok).toBe(true);
		}
		const blocked = registerScopeBinding(freshBinding(directory, planFixture, 9001));
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) expect(blocked.code).toBe('SCOPE_BINDING_CAPACITY');
	});

	test('renewed entries older than the cap are swept, reopening admission (issue #3889)', () => {
		// Fill the admission map with entries that look exactly like
		// continuously-renewed live bindings: expiresAt in the future, but
		// declared 25h ago.
		for (let i = 0; i < MAX_PENDING_SCOPE_BINDINGS; i += 1) {
			const result = registerScopeBinding(
				renewedOldBinding(freshBinding(directory, planFixture, i)),
			);
			expect(result.ok).toBe(true);
		}
		// The next declare_scope must be admitted: sweepExpired runs at the
		// top of registerScopeBinding and must evict the aged entries instead
		// of refusing with SCOPE_BINDING_STORE_OVERLOADED (the child-seen
		// diagnosis of this capacity failure).
		const reopened = registerScopeBinding(freshBinding(directory, planFixture, 9101));
		expect(reopened.ok).toBe(true);
	});
});

afterEach(() => {
	while (cleanups.length > 0) {
		cleanups.pop()?.();
	}
});
