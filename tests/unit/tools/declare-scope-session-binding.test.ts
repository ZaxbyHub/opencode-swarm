import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	clearScopeBindings,
	getScopeBinding,
} from '../../../src/scope/scope-binding';
import {
	flushScopeBindingMaintenance,
	readScopeBindingFromDisk,
	readScopeFromDisk,
} from '../../../src/scope/scope-persistence';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { executeDeclareScope } from '../../../src/tools/declare-scope';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let cleanup: (() => void) | undefined;

function setup(): { directory: string; plan: any } {
	const created = createSafeTestDir('declare-session-binding-');
	cleanup = created.cleanup;
	const plan = {
		schema_version: '1.0.0',
		title: 'Scope binding',
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
						description: 'fix',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	};
	fs.mkdirSync(path.join(created.dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(created.dir, '.swarm', 'plan.json'),
		JSON.stringify(plan),
	);
	return { directory: created.dir, plan };
}

afterEach(async () => {
	resetSwarmState();
	clearScopeBindings();
	await flushScopeBindingMaintenance();
	cleanup?.();
	cleanup = undefined;
});

describe('declare_scope session ownership', () => {
	test('updates only the calling session and clears its prior violation', async () => {
		const { directory, plan } = setup();
		ensureAgentSession('owner', 'architect', directory);
		ensureAgentSession('other', 'architect', directory);
		const owner = swarmState.agentSessions.get('owner');
		if (owner) owner.lastScopeViolation = 'prior violation';
		const result = await executeDeclareScope(
			{
				taskId: '1.1',
				files: ['src/a.ts'],
				whitelist: ['src/allowed.ts'],
			},
			directory,
			{ sessionID: 'owner', messageID: 'message-1' },
		);
		expect(result.success).toBe(true);
		expect(result.fileCount).toBe(2);
		expect(swarmState.agentSessions.get('owner')?.declaredCoderScope).toEqual([
			'src/a.ts',
			'src/allowed.ts',
		]);
		expect(owner?.lastScopeViolation).toBeNull();
		expect(
			swarmState.agentSessions.get('other')?.declaredCoderScope,
		).toBeNull();
		expect(
			getScopeBinding({
				directory,
				plan,
				taskId: '1.1',
				ownerSessionId: 'owner',
			}),
		).not.toBeNull();
	});

	test('ownerless direct invocation never mutates a live session', async () => {
		const { directory, plan } = setup();
		ensureAgentSession('only-session', 'architect', directory);
		const result = await executeDeclareScope(
			{ taskId: '1.1', files: ['src/a.ts'] },
			directory,
		);
		expect(result.success).toBe(true);
		expect(
			swarmState.agentSessions.get('only-session')?.declaredCoderScope,
		).toBeNull();
		expect(
			getScopeBinding({
				directory,
				plan,
				taskId: '1.1',
				ownerSessionId: 'only-session',
			}),
		).toBeNull();
		expect(
			fs.existsSync(path.join(directory, '.swarm', 'scopes', 'scope-1.1.json')),
		).toBe(false);
	});

	test('persists v2 identity and rejects it through the legacy v1 reader', async () => {
		const { directory, plan } = setup();
		const result = await executeDeclareScope(
			{ taskId: '1.1', files: ['src/a.ts'] },
			directory,
			{ sessionID: 'owner', messageID: 'message-v2' },
		);
		expect(result.success).toBe(true);
		expect(readScopeFromDisk(directory, '1.1')).toBeNull();
		expect(
			readScopeBindingFromDisk({
				directory,
				taskId: '1.1',
				plan,
				ownerSessionId: 'owner',
			}),
		).toMatchObject({
			version: 2,
			ownerMessageId: 'message-v2',
			files: ['src/a.ts'],
		});
	});

	test('normalizes an absolute path before storing the owner scope', async () => {
		const { directory } = setup();
		ensureAgentSession('owner', 'architect', directory);
		const absolutePath = path.join(
			directory,
			'src',
			'services',
			'price-calculator.ts',
		);

		const result = await executeDeclareScope(
			{ taskId: '1.1', files: [absolutePath] },
			directory,
			{ sessionID: 'owner', messageID: 'message-absolute' },
		);

		expect(result.success).toBe(true);
		const warnings = result.warnings ?? [];
		const normalizationWarning = warnings.find((warning) =>
			warning.includes('Absolute path normalized to relative'),
		);
		expect(normalizationWarning).toContain('src/services/price-calculator.ts');
		expect(swarmState.agentSessions.get('owner')?.declaredCoderScope).toEqual([
			'src/services/price-calculator.ts',
		]);
	});

	test('normalizes only the absolute path in a mixed owner scope', async () => {
		const { directory } = setup();
		ensureAgentSession('owner', 'architect', directory);
		const absolutePath = path.join(directory, 'src', 'auth.ts');

		const result = await executeDeclareScope(
			{ taskId: '1.1', files: ['src/index.ts', absolutePath] },
			directory,
			{ sessionID: 'owner', messageID: 'message-mixed' },
		);

		expect(result.success).toBe(true);
		expect(result.fileCount).toBe(2);
		expect(
			(result.warnings ?? []).some((warning) =>
				warning.includes('Absolute path normalized'),
			),
		).toBe(true);
		expect(swarmState.agentSessions.get('owner')?.declaredCoderScope).toEqual([
			'src/index.ts',
			'src/auth.ts',
		]);
	});

	test('persists same-task declarations independently for concurrent sessions', async () => {
		const { directory, plan } = setup();
		await executeDeclareScope(
			{ taskId: '1.1', files: ['src/a.ts'] },
			directory,
			{ sessionID: 'session-a', messageID: 'message-a' },
		);
		await executeDeclareScope(
			{ taskId: '1.1', files: ['src/b.ts'] },
			directory,
			{ sessionID: 'session-b', messageID: 'message-b' },
		);
		expect(
			readScopeBindingFromDisk({
				directory,
				taskId: '1.1',
				plan,
				ownerSessionId: 'session-a',
			})?.files,
		).toEqual(['src/a.ts']);
		expect(
			readScopeBindingFromDisk({
				directory,
				taskId: '1.1',
				plan,
				ownerSessionId: 'session-b',
			})?.files,
		).toEqual(['src/b.ts']);
	});
});
