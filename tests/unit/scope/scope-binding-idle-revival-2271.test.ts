/**
 * Idle scope-binding auto-recovery — issue #2271 bug 5.
 *
 * A v2 scope binding expires after a fixed 1 h wall-clock TTL that only
 * verified scoped-file mutations extend, so a binding left idle while the
 * user interacts, edits config, or commits dies of old age and the next coder
 * dispatch wastes an attempt on SCOPE_BINDING_EXPIRED. When the single
 * unambiguous generation is merely expired (still `live` in its durable
 * payload, inside the 24 h revival window, no deny overlay), the
 * authorization gate now revives it via a serialized CAS instead of failing.
 * Deliberate revocations (tombstoned/revoked/superseded) still fail closed.
 *
 * The expired durable state is fabricated by rewriting the generation file
 * directly: `writeScopeBindingToDisk` legitimately refuses to write a
 * live-but-already-expired payload, because real expiry is wall-clock drift
 * AFTER a valid write — this mirrors exactly that on-disk state.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	clearScopeBindings,
	createScopeBinding,
	installScopeBindingTombstone,
	type ScopeBinding,
} from '../../../src/scope/scope-binding';
import {
	claimScopeBindingForChildDurably,
	persistAndRegisterScopeBinding,
	resolveAuthorizedScopeBindingDetailed,
} from '../../../src/scope/scope-persistence';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

function fixture(): { directory: string; plan: Plan } {
	const directory = canonicalMkdtemp('scope-revive-2271-');
	roots.push(directory);
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Idle revival',
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
						description: 'Implement idle revival',
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

async function claimedActiveBinding(
	directory: string,
	plan: Plan,
): Promise<ScopeBinding> {
	const declaration = createScopeBinding({
		directory,
		plan,
		taskId: '1.1',
		files: ['src/a.ts'],
		ownerSessionId: 'architect-session',
		ownerMessageId: 'task-call',
		dispatchCallId: 'task-call',
		activation: 'pending_child',
		source: 'plan',
	});
	if (!declaration) throw new Error('declaration fixture failed');
	expect(
		await persistAndRegisterScopeBinding(directory, declaration),
	).toMatchObject({ ok: true });
	const claim = await claimScopeBindingForChildDurably({
		directory,
		parentSessionId: 'architect-session',
		childSessionId: 'coder-session',
		dispatchCallId: 'task-call',
	});
	if (!claim.ok) throw new Error(claim.message);
	return claim.value.claimed;
}

function durableFilePath(directory: string, binding: ScopeBinding): string {
	const scopesDir = path.join(directory, '.swarm', 'scopes');
	const match = fs
		.readdirSync(scopesDir)
		.filter((entry) => entry.endsWith('.json'))
		.find((entry) => {
			try {
				const parsed = JSON.parse(
					fs.readFileSync(path.join(scopesDir, entry), 'utf-8'),
				) as Partial<ScopeBinding>;
				return parsed.generationId === binding.generationId;
			} catch {
				return false;
			}
		});
	if (!match) throw new Error('durable generation file not found');
	return path.join(scopesDir, match);
}

function patchDurable(
	directory: string,
	binding: ScopeBinding,
	patch: Partial<ScopeBinding>,
): void {
	const filePath = durableFilePath(directory, binding);
	const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<
		string,
		unknown
	>;
	fs.writeFileSync(filePath, JSON.stringify({ ...parsed, ...patch }, null, 2));
}

afterEach(() => {
	clearScopeBindings();
	restoreClock();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

// Every expiry/window computation in this file is a function of Date.now();
// freeze the clock so the relative offsets (idle 1 h, beyond-window 25 h) are
// exact and the revival TTL assertion cannot flake on a tick (issue #1782).
let restoreClock: Restore = () => {};
beforeEach(() => {
	restoreClock = freezeClock();
});

describe('issue #2271 bug 5 — idle scope-binding auto-revival', () => {
	test('an expired-but-live latest generation within the window is revived', async () => {
		const { directory, plan } = fixture();
		const claimed = await claimedActiveBinding(directory, plan);
		// Simulate the binding expiring while the session sat idle: the durable
		// payload is still `live`, only the wall clock moved past expiresAt.
		patchDurable(directory, claimed, {
			expiresAt: Date.now() - 60 * 60 * 1000,
		});
		clearScopeBindings();

		const resolution = resolveAuthorizedScopeBindingDetailed({
			directory,
			taskId: '1.1',
			activeSessionId: 'coder-session',
		});
		expect(resolution.status).toBe('found');
		if (resolution.status !== 'found') throw new Error('revival failed');
		expect(resolution.binding.bindingId).toBe(claimed.bindingId);
		expect(resolution.binding.generationId).toBe(claimed.generationId);
		expect(resolution.binding.revision).toBe(claimed.revision + 1);
		expect(resolution.binding.expiresAt).toBeGreaterThan(Date.now());

		// The revival is auditable in the session ledger (plan-promised event).
		const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
		expect(fs.existsSync(eventsPath)).toBe(true);
		const revivalEvents = fs
			.readFileSync(eventsPath, 'utf-8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((event) => event.type === 'scope_binding_auto_recovered');
		expect(revivalEvents.length).toBe(1);
		expect(revivalEvents[0]?.taskId).toBe('1.1');
		expect(revivalEvents[0]?.generationId).toBe(claimed.generationId);
	});

	test('same-process revival survives an in-memory sweep tombstone', async () => {
		const { directory, plan } = fixture();
		const claimed = await claimedActiveBinding(directory, plan);
		patchDurable(directory, claimed, {
			expiresAt: Date.now() - 60 * 60 * 1000,
		});
		// In the SAME process, any scope read after expiry installs a sweep
		// tombstone (revision+1, lifecycle 'expired'). Deliberately do NOT
		// clearScopeBindings — this is the live-session idle scenario.
		installScopeBindingTombstone({
			...claimed,
			revision: claimed.revision + 1,
			lifecycleState: 'expired',
			updatedAt: Date.now(),
			expiresAt: Math.min(claimed.expiresAt, Date.now()),
		});

		const resolution = resolveAuthorizedScopeBindingDetailed({
			directory,
			taskId: '1.1',
			activeSessionId: 'coder-session',
		});
		expect(resolution.status).toBe('found');

		// The sweep tombstone is cleared with the revival, so the NEXT
		// resolution still finds the live generation instead of denying it.
		const again = resolveAuthorizedScopeBindingDetailed({
			directory,
			taskId: '1.1',
			activeSessionId: 'coder-session',
		});
		expect(again.status).toBe('found');
	});

	test('a deliberate in-memory revocation overlay still blocks revival', async () => {
		const { directory, plan } = fixture();
		const claimed = await claimedActiveBinding(directory, plan);
		patchDurable(directory, claimed, {
			expiresAt: Date.now() - 60 * 60 * 1000,
		});
		// A deliberate revocation-class overlay (not a sweep signature).
		installScopeBindingTombstone({
			...claimed,
			revision: claimed.revision + 1,
			lifecycleState: 'revoked',
			updatedAt: Date.now(),
			expiresAt: Math.min(claimed.expiresAt, Date.now()),
		});
		const resolution = resolveAuthorizedScopeBindingDetailed({
			directory,
			taskId: '1.1',
			activeSessionId: 'coder-session',
		});
		expect(resolution.status).toBe('expired');
	});

	test('a tombstoned (revoked) generation is never revived', async () => {
		const { directory, plan } = fixture();
		const claimed = await claimedActiveBinding(directory, plan);
		patchDurable(directory, claimed, {
			lifecycleState: 'revoked',
			revision: claimed.revision + 1,
			expiresAt: Date.now() - 1000,
		});
		clearScopeBindings();

		const resolution = resolveAuthorizedScopeBindingDetailed({
			directory,
			taskId: '1.1',
			activeSessionId: 'coder-session',
		});
		expect(resolution.status).toBe('expired');
	});

	test('a binding idle beyond the 24 h revival window still fails closed', async () => {
		const { directory, plan } = fixture();
		const claimed = await claimedActiveBinding(directory, plan);
		patchDurable(directory, claimed, {
			expiresAt: Date.now() - 25 * 60 * 60 * 1000,
		});
		clearScopeBindings();

		const resolution = resolveAuthorizedScopeBindingDetailed({
			directory,
			taskId: '1.1',
			activeSessionId: 'coder-session',
		});
		expect(resolution.status).toBe('expired');
	});

	test('multiple expired candidates are ambiguous and never revived', async () => {
		const { directory, plan } = fixture();
		const claimed = await claimedActiveBinding(directory, plan);
		patchDurable(directory, claimed, {
			expiresAt: Date.now() - 60 * 1000,
		});
		// A second expired candidate for the same identity (valid identity
		// format, distinct generation) makes revival ambiguous. The file name
		// must follow the durable-store convention
		// `binding-<taskId>-<bindingId>-<generationId>.json` or the reader
		// ignores it.
		const siblingId = randomUUID();
		const siblingGeneration = randomUUID();
		const siblingPath = path.join(
			path.dirname(durableFilePath(directory, claimed)),
			`binding-1.1-${siblingId}-${siblingGeneration}.json`,
		);
		const raw = JSON.parse(
			fs.readFileSync(durableFilePath(directory, claimed), 'utf-8'),
		) as Record<string, unknown>;
		fs.writeFileSync(
			siblingPath,
			JSON.stringify(
				{
					...raw,
					bindingId: siblingId,
					generationId: siblingGeneration,
				},
				null,
				2,
			),
		);
		clearScopeBindings();

		const resolution = resolveAuthorizedScopeBindingDetailed({
			directory,
			taskId: '1.1',
			activeSessionId: 'coder-session',
		});
		expect(resolution.status).toBe('expired');
		if (resolution.status === 'expired') {
			expect(resolution.totalCandidates).toBe(2);
		}
	});
});
