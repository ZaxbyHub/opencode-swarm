import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	createScopeBinding,
	type ScopeBinding,
} from '../../../src/scope/scope-binding';
import {
	claimScopeBindingForChildDurably,
	persistAndRegisterScopeBinding,
	readScopeBindingFromDisk,
	resolveAuthorizedScopeBindingForSessionDetailed,
	writeScopeBindingToDisk,
} from '../../../src/scope/scope-persistence';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const cleanups: Array<() => void> = [];

function fixture(): { directory: string; plan: Plan } {
	const created = createSafeTestDir('scope-fastpath-regression-');
	cleanups.push(created.cleanup);
	fs.mkdirSync(path.join(created.dir, '.git'), { recursive: true });
	fs.mkdirSync(path.join(created.dir, '.swarm', 'scopes'), { recursive: true });
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Scope fast-path regression',
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
						description: 'preserve durable-first scope authority',
						depends: [],
						files_touched: ['src/scope/scope-persistence.ts'],
					},
				],
			},
		],
	};
	fs.writeFileSync(
		path.join(created.dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	return {
		directory: created.dir,
		plan,
	};
}

function pendingBinding(directory: string, plan: Plan): ScopeBinding {
	const binding = createScopeBinding({
		directory,
		plan,
		taskId: '1.1',
		files: ['src/a.ts'],
		ownerSessionId: 'architect-session',
		ownerMessageId: 'task-call',
		dispatchCallId: 'task-call',
		source: 'plan',
	});
	if (!binding) throw new Error('pending binding fixture failed');
	return binding;
}

afterEach(() => {
	closeAllProjectDbs();
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe('scope binding durable-first resolution — regression: stale in-memory fast path (MR-001)', () => {
	for (const lifecycleState of ['revoked', 'superseded'] as const) {
		test(`foreign durable ${lifecycleState} outranks a stale in-memory active binding`, async () => {
			const { directory, plan } = fixture();
			const pending = pendingBinding(directory, plan);
			expect(
				await persistAndRegisterScopeBinding(directory, pending),
			).toMatchObject({ ok: true });
			const claimedResult = await claimScopeBindingForChildDurably({
				directory,
				parentSessionId: 'architect-session',
				childSessionId: 'coder-session',
				dispatchCallId: 'task-call',
			});
			expect(claimedResult).toMatchObject({ ok: true });
			if (!claimedResult.ok) throw new Error('claim failed');
			const claimed = claimedResult.value.claimed;

			// Previous resolution returned the locally admitted binding before reading
			// SQLite, so a foreign durable retire left the stale in-memory active
			// binding authorized for writes.
			const retired: ScopeBinding = {
				...claimed,
				revision: claimed.revision + 1,
				lifecycleState,
				updatedAt: claimed.updatedAt + 1,
				expiresAt: Math.min(claimed.expiresAt, claimed.updatedAt + 1),
			};
			expect(await writeScopeBindingToDisk(directory, retired)).toMatchObject({
				ok: true,
				value: {
					generationId: claimed.generationId,
					lifecycleState,
				},
			});

			expect(
				readScopeBindingFromDisk({
					directory,
					taskId: '1.1',
					plan,
					ownerSessionId: claimed.ownerSessionId,
					parentCallId: 'task-call',
				}),
			).toBeNull();

			const sessionResolution = resolveAuthorizedScopeBindingForSessionDetailed(
				{
					directory,
					activeSessionId: claimed.ownerSessionId,
				},
			);
			expect(sessionResolution).toMatchObject({
				status: 'expired',
				totalCandidates: 1,
			});
			if (sessionResolution.status !== 'expired') {
				throw new Error('authoritative retirement did not fail closed');
			}
			expect(sessionResolution.candidates[0]).toMatchObject({
				generationId: claimed.generationId,
				lifecycleState,
			});
		});
	}
});
