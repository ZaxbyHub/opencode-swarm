import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	listCoordinationStateRowsRaw,
	transitionCoordinationState,
} from '../../../src/db/coordination-store';
import { createScopeGuardHook } from '../../../src/hooks/scope-guard';
import { flushScopeBindingMaintenance } from '../../../src/scope/scope-persistence';
import {
	ensureAgentSession,
	recordSessionWorkspaceRoot,
	resetSwarmState,
} from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

describe('issue #2096 direct scope diagnostic advisories', () => {
	let directory = '';
	let cleanup = () => {};
	let advisories: string[] = [];

	beforeEach(() => {
		resetSwarmState();
		const created = createSafeTestDir('scope-diagnostic-advisory-2096-');
		directory = created.dir;
		cleanup = created.cleanup;
		advisories = [];
		ensureAgentSession('architect-session', 'architect', directory);
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	function hook() {
		return createScopeGuardHook(
			{ enabled: true },
			directory,
			(_sessionId, message) => advisories.push(message),
		);
	}

	test('missing binding names architect recovery and injects the same advisory', async () => {
		const coder = ensureAgentSession('coder-missing', 'coder', directory);
		coder.currentTaskId = '1.1';
		const operation = hook().toolBefore(
			{ tool: 'write', sessionID: 'coder-missing', callID: 'missing' },
			{ args: { path: 'src/a.ts', content: 'x' } },
		);
		await expect(operation).rejects.toThrow(
			/SCOPE_NOT_DECLARED.*ACTION\[architect\].*declare_scope.*new Task call/i,
		);
		expect(advisories).toHaveLength(1);
		expect(advisories[0]).toContain('SCOPE_NOT_DECLARED');
	});

	test('expired durable generation reports when and injects recovery advisory', async () => {
		ensureAgentSession('coder-expired', 'coder', directory);
		installActiveScopeBinding({
			directory,
			childSessionId: 'coder-expired',
			taskId: '1.1',
			files: ['src/a.ts'],
		});
		const scopes = path.join(directory, '.swarm', 'scopes');
		const bindingPath = fs
			.readdirSync(scopes)
			.map((name) => path.join(scopes, name))
			.find((candidate) => path.basename(candidate).startsWith('binding-'));
		if (!bindingPath) throw new Error('durable fixture missing');
		const persisted = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
		transitionCoordinationState(directory, {
			namespace: 'scope-binding',
			entityKey: persisted.generationId,
			expectedRevision: null,
			generation: 1,
			status: persisted.lifecycleState,
			payload: JSON.stringify(persisted),
		});
		// Issue #3889: an explicit terminal tombstone now collects the
		// generation at once (immediate collection, no row retention floor),
		// so the durable expiry is produced the way production meets it — a
		// live row whose lease lapsed beyond the idle-revival window
		// (issue #2271) and can therefore no longer be revived. A fixed past
		// instant is enough for that: the resolver classifies expiry only by
		// "lapsed beyond the window", never by how long ago, so no clock is read.
		const expiresAt = 1_700_000_000_000; // 2023-11-14T22:13:20Z
		const seededRevision = listCoordinationStateRowsRaw(
			directory,
			'scope-binding',
			10,
		).find((row) => row.entityKey === persisted.generationId)?.revision;
		if (seededRevision === undefined)
			throw new Error('durable fixture row missing');
		transitionCoordinationState(directory, {
			namespace: 'scope-binding',
			entityKey: persisted.generationId,
			expectedRevision: seededRevision,
			generation: 1,
			status: 'live',
			payload: JSON.stringify({
				...persisted,
				revision: seededRevision + 1,
				// All three lease timestamps move together: a declaredAt that
				// postdates the lapsed lease is the "future declaredAt" row
				// shape AC4 classifies as store_unreadable.
				declaredAt: expiresAt - 60 * 60 * 1000,
				leaseStartedAt: expiresAt - 60 * 60 * 1000,
				updatedAt: expiresAt,
				expiresAt,
			}),
		});
		const operation = hook().toolBefore(
			{ tool: 'write', sessionID: 'coder-expired', callID: 'expired' },
			{ args: { path: 'src/a.ts', content: 'x' } },
		);
		await expect(operation).rejects.toThrow(
			/SCOPE_BINDING_EXPIRED.*expiredAt=.*ACTION\[architect\]/,
		);
		expect(advisories).toHaveLength(1);
		expect(advisories[0]).toContain('SCOPE_BINDING_EXPIRED');

		// Disclosed bound (issue #3889 AC2): once maintenance has collected
		// the past-window row there is no generation left to describe, and
		// the generic recovery text replaces the expiry report.
		await flushScopeBindingMaintenance(directory);
		await expect(
			hook().toolBefore(
				{ tool: 'write', sessionID: 'coder-expired', callID: 'collected' },
				{ args: { path: 'src/a.ts', content: 'x' } },
			),
		).rejects.toThrow(/SCOPE_NOT_DECLARED.*ACTION\[architect\]/);
		expect(advisories).toHaveLength(2);
		expect(advisories[1]).toContain('SCOPE_NOT_DECLARED');
	});

	test('lane root escape reports a detected safe relative retry and advisory', async () => {
		const lane = path.join(directory, 'lane-a');
		fs.mkdirSync(lane, { recursive: true });
		ensureAgentSession('coder-lane', 'coder', lane);
		recordSessionWorkspaceRoot('coder-lane', lane);
		installActiveScopeBinding({
			directory: lane,
			childSessionId: 'coder-lane',
			taskId: '1.1',
			files: ['src/a.ts'],
		});
		const attempted = path.join(directory, 'src', 'a.ts');
		const operation = hook().toolBefore(
			{ tool: 'write', sessionID: 'coder-lane', callID: 'root-escape' },
			{ args: { path: attempted, content: 'x' } },
		);
		await expect(operation).rejects.toThrow(
			/SCOPE_ROOT_ESCAPE.*attempted target.*active root.*detected workspace-relative path "src\/a\.ts".*retry exactly/i,
		);
		expect(advisories).toHaveLength(1);
		expect(advisories[0]).toContain('ACTION[architect]');
	});

	test('wrong gate root emits workspace mismatch and architect advisory (FB-007)', async () => {
		const lane = path.join(directory, 'lane-mismatch');
		fs.mkdirSync(lane, { recursive: true });
		ensureAgentSession('coder-mismatch', 'coder', directory);
		installActiveScopeBinding({
			directory: lane,
			childSessionId: 'coder-mismatch',
			taskId: '1.1',
			files: ['src/a.ts'],
		});
		const operation = hook().toolBefore(
			{ tool: 'write', sessionID: 'coder-mismatch', callID: 'mismatch' },
			{ args: { path: 'src/a.ts', content: 'x' } },
		);
		await expect(operation).rejects.toThrow(
			/SCOPE_WORKSPACE_MISMATCH.*rooted at.*gate resolved.*ACTION\[architect\]/i,
		);
		expect(advisories).toHaveLength(1);
		expect(advisories[0]).toContain('SCOPE_WORKSPACE_MISMATCH');
	});
});
