import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	clearScopeBindings,
	createClaimedScopeBinding,
	createScopeBinding,
} from '../../../src/scope/scope-binding';
import {
	claimScopeBindingForChildDurably,
	clearScopeBindingFromDisk,
	persistAndRegisterScopeBinding,
	readScopeBindingFromDisk,
	refreshScopeBindingLease,
	resolveAuthorizedScopeBindingDetailed,
	tombstoneScopeBinding,
	writeScopeBindingToDisk,
} from '../../../src/scope/scope-persistence';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

function fixture(): { directory: string; plan: Plan } {
	const directory = canonicalMkdtemp('scope-generation-');
	roots.push(directory);
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Binding durability',
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
						description: 'Implement binding durability',
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

function pending(directory: string, plan: Plan, call = 'task-call') {
	const binding = createScopeBinding({
		directory,
		plan,
		taskId: '1.1',
		files: ['src/a.ts'],
		ownerSessionId: 'architect-session',
		ownerMessageId: call,
		dispatchCallId: call,
		activation: 'pending_child',
		source: 'plan',
	});
	if (!binding) throw new Error('binding fixture failed');
	return binding;
}

afterEach(() => {
	clearScopeBindings();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe('generation-safe scope persistence', () => {
	test('claims successor-first and makes repeated same-child claim idempotent', async () => {
		const { directory, plan } = fixture();
		const predecessor = pending(directory, plan);
		expect(
			await persistAndRegisterScopeBinding(directory, predecessor),
		).toMatchObject({
			ok: true,
		});

		const first = await claimScopeBindingForChildDurably({
			directory,
			parentSessionId: 'architect-session',
			childSessionId: 'coder-session',
			dispatchCallId: 'task-call',
		});
		expect(first.ok).toBeTrue();
		if (!first.ok) throw new Error(first.message);
		expect(first.value.claimed.bindingId).toBe(predecessor.bindingId);
		expect(first.value.claimed.generationId).not.toBe(predecessor.generationId);
		expect(first.value.claimed.predecessorGenerationId).toBe(
			predecessor.generationId,
		);

		clearScopeBindings();
		const repeated = await claimScopeBindingForChildDurably({
			directory,
			parentSessionId: 'architect-session',
			childSessionId: 'coder-session',
			dispatchCallId: 'task-call',
		});
		expect(repeated).toMatchObject({ ok: true });
		if (!repeated.ok) throw new Error(repeated.message);
		expect(repeated.value.claimed.generationId).toBe(
			first.value.claimed.generationId,
		);
	});

	test('two child contenders produce one winner and one typed denial', async () => {
		const { directory, plan } = fixture();
		expect(
			await persistAndRegisterScopeBinding(directory, pending(directory, plan)),
		).toMatchObject({ ok: true });
		const results = await Promise.all([
			claimScopeBindingForChildDurably({
				directory,
				parentSessionId: 'architect-session',
				childSessionId: 'coder-a',
				dispatchCallId: 'task-call',
			}),
			claimScopeBindingForChildDurably({
				directory,
				parentSessionId: 'architect-session',
				childSessionId: 'coder-b',
				dispatchCallId: 'task-call',
			}),
		]);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.filter((result) => !result.ok)[0]).toMatchObject({
			ok: false,
			code: 'SCOPE_BINDING_ALREADY_CLAIMED',
		});
	});

	test('orphan winner receipt leaves pending authority fail-closed', async () => {
		const { directory, plan } = fixture();
		const predecessor = pending(directory, plan);
		await persistAndRegisterScopeBinding(directory, predecessor);
		const digest = createHash('sha256')
			.update(
				`${predecessor.bindingId}\0${predecessor.generationId}\0task-call`,
			)
			.digest('hex')
			.slice(0, 40);
		fs.writeFileSync(
			path.join(directory, '.swarm', 'scopes', `claim-${digest}.json`),
			JSON.stringify({
				version: 1,
				predecessorGenerationId: predecessor.generationId,
				winnerGenerationId: '33333333-3333-4333-a333-333333333333',
				childSessionId: 'coder-session',
				dispatchCallId: 'task-call',
				createdAt: predecessor.declaredAt,
			}),
		);
		expect(
			await claimScopeBindingForChildDurably({
				directory,
				parentSessionId: 'architect-session',
				childSessionId: 'coder-session',
				dispatchCallId: 'task-call',
			}),
		).toMatchObject({
			ok: false,
			code: 'SCOPE_BINDING_PERSISTENCE_FAILED',
		});
	});

	test('lease refresh is exact-generation CAS and tombstone stays denied', async () => {
		const { directory, plan } = fixture();
		const predecessor = pending(directory, plan);
		await persistAndRegisterScopeBinding(directory, predecessor);
		const claimed = await claimScopeBindingForChildDurably({
			directory,
			parentSessionId: 'architect-session',
			childSessionId: 'coder-session',
			dispatchCallId: 'task-call',
		});
		if (!claimed.ok) throw new Error(claimed.message);
		const active = claimed.value.claimed;
		const refreshed = await refreshScopeBindingLease({
			directory,
			bindingId: active.bindingId,
			generationId: active.generationId,
			expectedRevision: active.revision,
			activeSessionId: 'coder-session',
			taskId: '1.1',
		});
		expect(refreshed).toMatchObject({ ok: true });
		if (!refreshed.ok) throw new Error(refreshed.message);
		expect(refreshed.value.revision).toBe(active.revision + 1);
		expect(
			await refreshScopeBindingLease({
				directory,
				bindingId: active.bindingId,
				generationId: active.generationId,
				expectedRevision: active.revision,
				activeSessionId: 'coder-session',
				taskId: '1.1',
			}),
		).toMatchObject({ ok: false, code: 'SCOPE_BINDING_STALE' });
		expect(
			await tombstoneScopeBinding(directory, refreshed.value, 'expired'),
		).toMatchObject({ ok: true });
		clearScopeBindings();
		expect(
			resolveAuthorizedScopeBindingDetailed({
				directory,
				taskId: '1.1',
				activeSessionId: 'coder-session',
			}),
		).toMatchObject({ status: 'expired' });
	});

	test('exact cleanup cannot remove a sibling generation', async () => {
		const { directory, plan } = fixture();
		const first = pending(directory, plan, 'call-one');
		const second = createScopeBinding({
			directory,
			plan,
			taskId: '1.1',
			files: ['src/a.ts'],
			ownerSessionId: 'other-architect',
			ownerMessageId: 'call-two',
			source: 'declare_scope',
		});
		if (!second) throw new Error('second binding fixture failed');
		await persistAndRegisterScopeBinding(directory, first);
		await persistAndRegisterScopeBinding(directory, second);
		clearScopeBindingFromDisk({
			directory,
			binding: first,
		});
		expect(
			readScopeBindingFromDisk({
				directory,
				taskId: '1.1',
				plan,
				ownerSessionId: 'other-architect',
				requireDeclaration: true,
			}),
		).toMatchObject({ generationId: second.generationId });
	});

	test('durable deletion cannot be bypassed by a live memory cache', async () => {
		const { directory, plan } = fixture();
		await persistAndRegisterScopeBinding(directory, pending(directory, plan));
		const claimed = await claimScopeBindingForChildDurably({
			directory,
			parentSessionId: 'architect-session',
			childSessionId: 'coder-session',
			dispatchCallId: 'task-call',
		});
		if (!claimed.ok) throw new Error(claimed.message);
		const active = claimed.value.claimed;
		const exactPath = path.join(
			directory,
			'.swarm',
			'scopes',
			`binding-${active.taskId}-${active.bindingId}-${active.generationId}.json`,
		);
		fs.unlinkSync(exactPath);
		expect(
			resolveAuthorizedScopeBindingDetailed({
				directory,
				taskId: active.taskId,
				activeSessionId: active.ownerSessionId,
			}),
		).toEqual({ status: 'not_declared' });
	});

	test('cleanup follows a refreshed revision and permanently defeats renewal', async () => {
		const { directory, plan } = fixture();
		await persistAndRegisterScopeBinding(directory, pending(directory, plan));
		const claimed = await claimScopeBindingForChildDurably({
			directory,
			parentSessionId: 'architect-session',
			childSessionId: 'coder-session',
			dispatchCallId: 'task-call',
		});
		if (!claimed.ok) throw new Error(claimed.message);
		const active = claimed.value.claimed;
		const refreshed = await refreshScopeBindingLease({
			directory,
			bindingId: active.bindingId,
			generationId: active.generationId,
			expectedRevision: active.revision,
			activeSessionId: active.ownerSessionId,
			taskId: active.taskId,
		});
		if (!refreshed.ok) throw new Error(refreshed.message);
		const retired = clearScopeBindingFromDisk({ directory, binding: active });
		expect(retired).toMatchObject({
			ok: true,
			value: {
				lifecycleState: 'revoked',
				revision: refreshed.value.revision + 1,
			},
		});
		expect(
			await refreshScopeBindingLease({
				directory,
				bindingId: active.bindingId,
				generationId: active.generationId,
				expectedRevision: refreshed.value.revision,
				activeSessionId: active.ownerSessionId,
				taskId: active.taskId,
			}),
		).toMatchObject({ ok: false, code: 'SCOPE_BINDING_EXPIRED' });
	});

	test('refresh of a deleted generation leaves no data or lock-target orphan', async () => {
		const { directory, plan } = fixture();
		const active = createClaimedScopeBinding(pending(directory, plan), {
			parentSessionId: 'architect-session',
			childSessionId: 'coder-session',
			dispatchCallId: 'task-call',
		});
		const exactPath = path.join(
			directory,
			'.swarm',
			'scopes',
			`binding-${active.taskId}-${active.bindingId}-${active.generationId}.json`,
		);
		fs.mkdirSync(path.dirname(exactPath), { recursive: true });
		expect(
			await refreshScopeBindingLease({
				directory,
				bindingId: active.bindingId,
				generationId: active.generationId,
				expectedRevision: active.revision,
				activeSessionId: active.ownerSessionId,
				taskId: active.taskId,
			}),
		).toMatchObject({ ok: false, code: 'SCOPE_BINDING_STALE' });
		expect(fs.existsSync(exactPath)).toBeFalse();
		expect(fs.existsSync(`${exactPath}.generation-lock`)).toBeFalse();
	});

	test('a revoked failed successor and its receipt do not poison retry', async () => {
		const { directory, plan } = fixture();
		const predecessor = pending(directory, plan);
		await persistAndRegisterScopeBinding(directory, predecessor);
		const failed = createClaimedScopeBinding(predecessor, {
			parentSessionId: 'architect-session',
			childSessionId: 'coder-session',
			dispatchCallId: 'task-call',
		});
		await writeScopeBindingToDisk(directory, failed);
		await tombstoneScopeBinding(directory, failed, 'revoked');
		const digest = createHash('sha256')
			.update(
				`${predecessor.bindingId}\0${predecessor.generationId}\0task-call`,
			)
			.digest('hex')
			.slice(0, 40);
		fs.writeFileSync(
			path.join(directory, '.swarm', 'scopes', `claim-${digest}.json`),
			JSON.stringify({
				version: 1,
				predecessorGenerationId: predecessor.generationId,
				winnerGenerationId: failed.generationId,
				childSessionId: 'coder-session',
				dispatchCallId: 'task-call',
				createdAt: failed.declaredAt,
			}),
		);
		const retry = await claimScopeBindingForChildDurably({
			directory,
			parentSessionId: 'architect-session',
			childSessionId: 'coder-session',
			dispatchCallId: 'task-call',
		});
		expect(retry).toMatchObject({ ok: true });
		if (!retry.ok) throw new Error(retry.message);
		expect(retry.value.claimed.generationId).not.toBe(failed.generationId);
	});

	test('restart authorization never selects between two live generations', async () => {
		const { directory, plan } = fixture();
		for (const [parentSessionId, dispatchCallId] of [
			['architect-a', 'call-a'],
			['architect-b', 'call-b'],
		] as const) {
			const parent = createScopeBinding({
				directory,
				plan,
				taskId: '1.1',
				files: ['src/a.ts'],
				ownerSessionId: parentSessionId,
				ownerMessageId: dispatchCallId,
				dispatchCallId,
				activation: 'pending_child',
				source: 'plan',
			});
			if (!parent) throw new Error('ambiguous parent fixture failed');
			const active = createClaimedScopeBinding(parent, {
				parentSessionId,
				childSessionId: 'shared-child',
				dispatchCallId,
			});
			expect(
				await persistAndRegisterScopeBinding(directory, active),
			).toMatchObject({ ok: true });
		}
		clearScopeBindings();
		expect(
			resolveAuthorizedScopeBindingDetailed({
				directory,
				taskId: '1.1',
				activeSessionId: 'shared-child',
			}),
		).toMatchObject({ status: 'ambiguous' });
	});
});
