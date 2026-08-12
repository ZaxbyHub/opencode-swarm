import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	clearScopeBindings,
	createClaimedScopeBinding,
	createScopeBinding,
	type ScopeBinding,
} from '../../../src/scope/scope-binding';
import {
	_scopePersistenceInternals,
	pruneScopeBindingTombstones,
	resolveScopeBindingFromDisk,
	writeScopeBindingToDisk,
} from '../../../src/scope/scope-persistence';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];
const originalLiveCapacity = _scopePersistenceInternals.liveBindingCapacity;
const originalScanCapacity = _scopePersistenceInternals.bindingFileScanCapacity;
const originalMaintenanceCapacity =
	_scopePersistenceInternals.maintenanceFileScanCapacity;

function fixture(): { directory: string; plan: Plan } {
	const directory = canonicalMkdtemp('scope-overload-');
	roots.push(directory);
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Bounded scope maintenance',
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
						description: 'Exercise maintenance',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	};
	return { directory, plan };
}

function declaration(
	directory: string,
	plan: Plan,
	ownerSessionId: string,
): ScopeBinding {
	const binding = createScopeBinding({
		directory,
		plan,
		taskId: '1.1',
		files: ['src/a.ts'],
		ownerSessionId,
		ownerMessageId: `${ownerSessionId}-declare`,
		source: 'declare_scope',
	});
	if (!binding) throw new Error('declaration fixture failed');
	return binding;
}

afterEach(() => {
	_scopePersistenceInternals.liveBindingCapacity = originalLiveCapacity;
	_scopePersistenceInternals.bindingFileScanCapacity = originalScanCapacity;
	_scopePersistenceInternals.maintenanceFileScanCapacity =
		originalMaintenanceCapacity;
	clearScopeBindings();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe('bounded durable scope recovery', () => {
	test('maintenance recovers a just-over-cap store and removes generation sidecars', async () => {
		const { directory, plan } = fixture();
		const target = declaration(directory, plan, 'target-owner');
		const sibling = declaration(directory, plan, 'sibling-owner');
		const staleSource = declaration(directory, plan, 'stale-owner');
		const old = 1;
		const stale: ScopeBinding = {
			...staleSource,
			lifecycleState: 'revoked',
			declaredAt: old,
			updatedAt: old,
			leaseStartedAt: old,
			expiresAt: old,
		};
		for (const binding of [target, sibling, stale])
			expect(await writeScopeBindingToDisk(directory, binding)).toMatchObject({
				ok: true,
			});
		_scopePersistenceInternals.bindingFileScanCapacity = 5;
		_scopePersistenceInternals.maintenanceFileScanCapacity = 12;
		expect(
			resolveScopeBindingFromDisk({
				directory,
				taskId: '1.1',
				plan,
				ownerSessionId: 'target-owner',
				requireDeclaration: true,
			}),
		).toEqual({ status: 'overloaded' });
		expect(await pruneScopeBindingTombstones(directory)).toMatchObject({
			ok: true,
		});
		const names = fs.readdirSync(path.join(directory, '.swarm', 'scopes'));
		expect(names.some((name) => name.includes(stale.generationId))).toBeFalse();
		expect(names.length).toBeLessThanOrEqual(5);
		expect(
			resolveScopeBindingFromDisk({
				directory,
				taskId: '1.1',
				plan,
				ownerSessionId: 'target-owner',
				requireDeclaration: true,
			}),
		).toMatchObject({ status: 'found' });
	});

	test('ambiguous diagnostics retain exact total while candidates stay bounded', async () => {
		const { directory, plan } = fixture();
		_scopePersistenceInternals.liveBindingCapacity = 20;
		_scopePersistenceInternals.bindingFileScanCapacity = 25;
		for (let index = 0; index < 10; index++) {
			const dispatchCallId = `call-${index}`;
			const parent = createScopeBinding({
				directory,
				plan,
				taskId: '1.1',
				files: ['src/a.ts'],
				ownerSessionId: `parent-${index}`,
				ownerMessageId: dispatchCallId,
				dispatchCallId,
				activation: 'pending_child',
				source: 'plan',
			});
			if (!parent) throw new Error('pending fixture failed');
			const active = createClaimedScopeBinding(parent, {
				parentSessionId: `parent-${index}`,
				childSessionId: 'shared-child',
				dispatchCallId,
			});
			await writeScopeBindingToDisk(directory, active);
		}
		const resolution = resolveScopeBindingFromDisk({
			directory,
			taskId: '1.1',
			plan,
			ownerSessionId: 'shared-child',
			requireDispatchCorrelation: true,
		});
		expect(resolution).toMatchObject({
			status: 'ambiguous',
			totalCandidates: 10,
		});
		if (resolution.status !== 'ambiguous')
			throw new Error('expected ambiguity');
		expect(resolution.candidates).toHaveLength(8);
	});
});
