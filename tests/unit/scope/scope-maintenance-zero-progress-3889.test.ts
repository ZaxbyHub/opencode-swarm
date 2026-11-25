import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import type { Plan } from '../../../src/config/plan-schema';
import {
	closeAllProjectDbs,
	listCoordinationStateRowsRaw,
	transitionCoordinationState,
} from '../../../src/db';
import { _internals as coordinationInternals } from '../../../src/db/coordination-store.js';
import { createScopeBinding } from '../../../src/scope/scope-binding';
import {
	flushScopeBindingMaintenance,
	replaceExistingScopeDeclaration,
	resolveScopeBindingFromDisk,
} from '../../../src/scope/scope-persistence';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const plan: Plan = {
	schema_version: '1.0.0',
	title: 'zero-progress',
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
	const root = canonicalMkdtemp('scope-zero-progress-');
	roots.push(root);
	return root;
}

function decl(root: string, owner: string, message: string) {
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

function seedLegacy(root: string, count: number, prefix: string): string[] {
	// Static 2020-01-01 base: every legacy row sits unconditionally past
	// the retention horizon without reading the wall clock (check:test-clock
	// forbids raw clock reads in test files).
	const now = 1_577_836_800_000;
	const ids: string[] = [];
	for (let i = 0; i < count; i += 1) {
		const hex = i.toString(16).padStart(12, '0');
		// Keep the 8-4-4-4-12 id shape per isScopeBindingIdentity.
		const generationId = `${prefix}${'a'.repeat(8 - prefix.length)}-0000-4000-a000-${hex}`;
		ids.push(generationId);
		const row = {
			...decl(root, `${prefix}-old-${i}`, `msg-${i}`),
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
	return ids;
}

afterEach(() => {
	coordinationInternals.coordinationFaultInjector = undefined;
	closeAllProjectDbs();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe('maintenance zero-progress guard (#3889, 4.5 round-4 finding)', () => {
	test('faulted sink: one read + one flush stays quiet, then drains after recovery', async () => {
		const root = fixture();
		const live = decl(root, 'owner', 'live');
		expect(
			await replaceExistingScopeDeclaration({
				directory: root,
				binding: live,
				replaceExisting: true,
			}),
		).toMatchObject({ ok: true });
		// 200 legacy rows: at least one full 128-row batch + remainder, so a
		// zero-progress chain would re-arm itself on the pre-fix code.
		seedLegacy(root, 200, 'eeeeeeee');

		// Persistent coordination-write fault: every collection delete fails
		// while reads still work. faultFirings counts every injector visit so
		// the zero-progress bound below is deterministic, not wall-clock-only.
		let faultFirings = 0;
		coordinationInternals.coordinationFaultInjector = (point) => {
			faultFirings += 1;
			if (point === 'before_outer_commit') {
				throw new Error('injected coordination write failure');
			}
		};

		expect(
			resolveScopeBindingFromDisk({
				directory: root,
				taskId: '1.1',
				plan,
				ownerSessionId: 'owner',
				requireDeclaration: true,
			}),
		).toMatchObject({ status: 'found' });
		// Elapsed bound uses performance.now() — freezeClock would freeze
		// the Date clock and make the elapsed measurement vacuous, and the
		// measurement is the thing under test.
		const flushStart = performance.now();
		await flushScopeBindingMaintenance(root);
		const flushMs = performance.now() - flushStart;
		// Zero-progress guard: the flush must NOT spin through the full
		// round budget (pre-fix measured ~19.5s for 159 faulted rounds;
		// one round completes in well under 2s).
		expect(flushMs).toBeLessThan(2000);
		// The fault actually engaged during the faulted pass — a vacuous
		// probe (fixture never reaching the injector) fails here instead
		// of passing green.
		expect(faultFirings).toBeGreaterThan(0);
		// Deterministic zero-progress bound: no further faulted transactions
		// may arrive once the flush settles (the pre-fix chain re-armed
		// ~14 background rounds per 3 s).
		const firingsAtFlush = faultFirings;
		await new Promise((resolve) => setTimeout(resolve, 1500));
		expect(faultFirings).toBe(firingsAtFlush);

		// Nothing collected under the fault.
		const rowsUnderFault = listCoordinationStateRowsRaw(
			root,
			'scope-binding',
			500,
		);
		expect(
			rowsUnderFault.filter((row) => row.entityKey.startsWith('eeeeeeee-')),
		).toHaveLength(200);

		// Recovery: fault cleared, one more read + flush drains everything.
		coordinationInternals.coordinationFaultInjector = undefined;
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
		const rowsAfter = listCoordinationStateRowsRaw(root, 'scope-binding', 500);
		expect(
			rowsAfter.filter((row) => row.entityKey.startsWith('eeeeeeee-')),
		).toHaveLength(0);
		expect(rowsAfter).toHaveLength(1);
	}, 120_000);
});
