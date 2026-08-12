import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalWorkspaceIdentity, type ScopeBinding } from './scope-binding';
import { clearScopeBindingFromDisk } from './scope-persistence';

let workspace: string;
let external: string;

function bindingFile(
	directory: string,
	taskId: string,
	bindingId: string,
	generationId: string,
): string {
	return path.join(
		directory,
		'.swarm',
		'scopes',
		`binding-${taskId}-${bindingId}-${generationId}.json`,
	);
}

const bindingId = '11111111-1111-4111-a111-111111111111';
const generationId = '22222222-2222-4222-a222-222222222222';

function binding(directory: string): ScopeBinding {
	const workspaceIdentity = canonicalWorkspaceIdentity(directory);
	if (!workspaceIdentity) throw new Error('workspace fixture missing');
	const now = Date.now();
	return {
		version: 2,
		bindingId,
		generationId,
		revision: 1,
		lifecycleState: 'live',
		workspaceIdentity,
		planId: 'plan-test',
		planStructureHash: 'hash-test',
		taskId: '1.1',
		ownerSessionId: 'owner',
		ownerMessageId: 'call',
		dispatchCallId: 'call',
		activation: 'pending_child',
		source: 'plan',
		files: ['src/a.ts'],
		declaredAt: now,
		updatedAt: now,
		leaseStartedAt: now,
		expiresAt: now + 60_000,
	};
}

beforeEach(() => {
	workspace = fs.mkdtempSync(
		path.join(os.tmpdir(), 'scope-cleanup-workspace-'),
	);
	external = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-cleanup-external-'));
});

afterEach(() => {
	fs.rmSync(workspace, { recursive: true, force: true });
	fs.rmSync(external, { recursive: true, force: true });
});

describe('clearScopeBindingFromDisk containment', () => {
	test('retires a regular binding in the canonical scopes directory', () => {
		const target = bindingFile(workspace, '1.1', bindingId, generationId);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const active = binding(workspace);
		fs.writeFileSync(target, JSON.stringify(active));

		const retired = clearScopeBindingFromDisk({
			directory: workspace,
			binding: active,
		});
		expect(retired).toMatchObject({ ok: true });

		expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toMatchObject({
			lifecycleState: 'revoked',
			revision: 2,
		});
	});

	test('fails closed when scopes is swapped to a symlink or junction', () => {
		const originalTarget = bindingFile(
			workspace,
			'1.1',
			bindingId,
			generationId,
		);
		const scopesDir = path.dirname(originalTarget);
		const displacedScopes = path.join(workspace, '.swarm', 'scopes-original');
		fs.mkdirSync(scopesDir, { recursive: true });
		fs.writeFileSync(originalTarget, 'original');
		fs.renameSync(scopesDir, displacedScopes);

		const externalTarget = bindingFile(
			external,
			'1.1',
			bindingId,
			generationId,
		);
		fs.mkdirSync(path.dirname(externalTarget), { recursive: true });
		fs.writeFileSync(externalTarget, 'outside');
		fs.symlinkSync(
			path.dirname(externalTarget),
			scopesDir,
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		clearScopeBindingFromDisk({
			directory: workspace,
			binding: binding(workspace),
		});

		expect(fs.readFileSync(externalTarget, 'utf8')).toBe('outside');
		expect(
			fs.readFileSync(
				path.join(displacedScopes, path.basename(originalTarget)),
				'utf8',
			),
		).toBe('original');
	});

	test('fails closed when the binding leaf is a symlink or junction', () => {
		const target = bindingFile(workspace, '1.1', bindingId, generationId);
		const externalTarget = path.join(external, 'outside-binding');
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.mkdirSync(externalTarget);
		fs.writeFileSync(path.join(externalTarget, 'sentinel.txt'), 'outside');
		fs.symlinkSync(
			externalTarget,
			target,
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		clearScopeBindingFromDisk({
			directory: workspace,
			binding: binding(workspace),
		});

		expect(
			fs.readFileSync(path.join(externalTarget, 'sentinel.txt'), 'utf8'),
		).toBe('outside');
		expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
	});
});
