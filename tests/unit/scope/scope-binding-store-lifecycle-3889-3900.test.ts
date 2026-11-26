import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import type { Plan } from '../../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	clearScopeBindings,
	clearSweepTombstoneForRevival,
	createScopeBinding,
	hasDeliberateScopeBindingDenyOverlay,
	hasScopeBindingDenyOverlay,
	installFailedRevocationOverlay,
	installScopeBindingTombstone,
	registerScopeBinding,
	type ScopeBinding,
	updateExactScopeBinding,
} from '../../../src/scope/scope-binding';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const plan: Plan = {
	schema_version: '1.0.0',
	title: 'battery',
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

function fixture(): string {
	const root = canonicalMkdtemp('scope-lifecycle-3889-3900-');
	roots.push(root);
	return root;
}

function baseBinding(root: string): ScopeBinding {
	const binding = createScopeBinding({
		directory: root,
		plan,
		taskId: '1.1',
		files: ['src/a.ts'],
		ownerSessionId: 'parent',
		ownerMessageId: 'declare',
		source: 'declare_scope',
	});
	if (!binding) throw new Error('fixture failed');
	return binding;
}

/** Drive one generation to the sweep edge under the given trigger. */
function lapseGeneration(
	binding: ScopeBinding,
	trigger: 'lease' | 'age',
): void {
	if (trigger === 'lease') {
		const lapsed: ScopeBinding = {
			...binding,
			revision: binding.revision + 1,
			expiresAt: Date.now() - 1000,
		};
		if (!updateExactScopeBinding(lapsed).ok) throw new Error('lapse failed');
		return;
	}
	// 24h age trigger: the lease is still live, but declaredAt is >24h old.
	const aged: ScopeBinding = {
		...binding,
		declaredAt: Date.now() - 25 * 60 * 60 * 1000,
		leaseStartedAt: Date.now() - 25 * 60 * 60 * 1000,
	};
	// Re-admit at the aged shape (admission checks expiry, not age), then
	// hand the sweep an entry whose declaredAt is past the cap.
	if (!registerScopeBinding(aged).ok)
		throw new Error('aged re-admission failed');
}

function sweepTrigger(root: string): void {
	const trigger = createScopeBinding({
		directory: root,
		plan,
		taskId: '9.9',
		files: ['src/t.ts'],
		ownerSessionId: 'other',
		ownerMessageId: 'declare-other',
		source: 'declare_scope',
	});
	if (!trigger) throw new Error('trigger fixture failed');
	registerScopeBinding(trigger); // runs sweepExpired()
}

let restoreClock: Restore | undefined;

beforeEach(() => {
	// Deterministic clock: the battery builds fixture times relative to a
	// frozen now (check:test-clock contract for new test files).
	restoreClock = freezeClock();
});

afterEach(() => {
	restoreClock?.();
	clearScopeBindings();
	closeAllProjectDbs();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe.each([
	'revoked',
	'superseded',
] as const)('deliberate tombstone survives the sweep (%s)', (kind) => {
	test.each([
		'lease',
		'age',
	] as const)('%s trigger: deny covers the revived revision (#3900 AC6/AC7/AC8)', (trigger) => {
		const root = fixture();
		const base = baseBinding(root);
		if (!registerScopeBinding(base).ok) throw new Error('admission failed');

		let evicted: ScopeBinding;
		if (kind === 'revoked') {
			// Failed durable retirement -> 'revoked' overlay (durable row
			// stays live on disk because the retirement failed).
			expect(installFailedRevocationOverlay(base, 'revoked')).toBe(true);
			const reclaimed = {
				...base,
				revision: base.revision + 1,
				leaseStartedAt: Date.now(),
				expiresAt: Date.now() + 60 * 60 * 1000,
			};
			if (!registerScopeBinding(reclaimed).ok)
				throw new Error('re-claim failed');
			evicted = reclaimed;
		} else {
			// Direct superseded tombstone over an admitted generation, then
			// the same re-claim door production uses (registerScopeBinding
			// admits a fresh revision without consulting tombstones).
			const supersededTombstone: ScopeBinding = {
				...base,
				revision: base.revision + 1,
				lifecycleState: 'superseded',
				updatedAt: Date.now(),
				expiresAt: Math.min(base.expiresAt, Date.now()),
			};
			installScopeBindingTombstone(supersededTombstone);
			const reclaimed = {
				...base,
				revision: base.revision + 1,
				leaseStartedAt: Date.now(),
				expiresAt: Date.now() + 60 * 60 * 1000,
			};
			if (!registerScopeBinding(reclaimed).ok)
				throw new Error('re-claim failed');
			evicted = reclaimed;
		}

		lapseGeneration(evicted, trigger);
		sweepTrigger(root);

		// The revived revision the sweep would have stamped (revision+1
		// past the evicted entry) must stay denied by the PRESERVED
		// deliberate tombstone — before and after the revival clear.
		const revived: ScopeBinding = {
			...evicted,
			revision: evicted.revision + 1,
			leaseStartedAt: Date.now(),
			expiresAt: Date.now() + 60 * 60 * 1000,
		};
		expect(hasDeliberateScopeBindingDenyOverlay(revived)).toBe(true);
		expect(hasScopeBindingDenyOverlay(revived)).toBe(true);
		clearSweepTombstoneForRevival(revived);
		expect(hasDeliberateScopeBindingDenyOverlay(revived)).toBe(true);
		expect(hasScopeBindingDenyOverlay(revived)).toBe(true);
	}, 60_000);
});

describe('explicit new declaration is allowed after the deny', () => {
	test('a fresh generation of the same binding is not blocked (AC8)', () => {
		const root = fixture();
		const base = baseBinding(root);
		if (!registerScopeBinding(base).ok) throw new Error('admission failed');
		expect(installFailedRevocationOverlay(base, 'revoked')).toBe(true);

		// A NEW declaration = new generationId; the tombstone keys by
		// generation, so the fresh generation admits cleanly.
		const fresh = createScopeBinding({
			directory: root,
			plan,
			taskId: '1.1',
			files: ['src/a.ts'],
			ownerSessionId: 'parent',
			ownerMessageId: 'declare-2',
			source: 'declare_scope',
		});
		if (!fresh) throw new Error('fresh fixture failed');
		expect(registerScopeBinding(fresh).ok).toBe(true);
		expect(hasDeliberateScopeBindingDenyOverlay(fresh)).toBe(false);
	});
});
