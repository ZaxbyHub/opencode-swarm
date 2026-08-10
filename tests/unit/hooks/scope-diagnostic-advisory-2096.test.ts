import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createScopeGuardHook } from '../../../src/hooks/scope-guard';
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
		const expiredAt = persisted.declaredAt;
		fs.writeFileSync(
			bindingPath,
			JSON.stringify({
				...persisted,
				revision: persisted.revision + 1,
				lifecycleState: 'expired',
				updatedAt: expiredAt,
				expiresAt: expiredAt,
			}),
		);
		const operation = hook().toolBefore(
			{ tool: 'write', sessionID: 'coder-expired', callID: 'expired' },
			{ args: { path: 'src/a.ts', content: 'x' } },
		);
		await expect(operation).rejects.toThrow(
			/SCOPE_BINDING_EXPIRED.*expiredAt=.*ACTION\[architect\]/,
		);
		expect(advisories).toHaveLength(1);
		expect(advisories[0]).toContain('SCOPE_BINDING_EXPIRED');
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
});
