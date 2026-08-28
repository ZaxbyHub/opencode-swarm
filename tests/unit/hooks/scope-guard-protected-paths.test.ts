import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	createScopeGuardHook,
} from '../../../src/hooks/scope-guard';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { installScopeGuardBindingSeam } from '../../helpers/scope-guard-binding-seam';

describe('scope guard hard protected authority — regression: declared scope cannot bypass protected policy (FB-013)', () => {
	let directory = '';
	let cleanup = () => {};
	let restoreBindingSeam = () => {};

	beforeEach(() => {
		resetSwarmState();
		const created = createSafeTestDir('scope-guard-protected-');
		directory = created.dir;
		cleanup = created.cleanup;
		fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(directory, 'packages', 'core', '.git'), {
			recursive: true,
		});
	});

	afterEach(() => {
		restoreBindingSeam();
		restoreBindingSeam = () => {};
		resetSwarmState();
		cleanup();
	});

	function startCoder(sessionID: string, scope: string[]): void {
		startAgentSession(sessionID, 'coder');
		swarmState.activeAgent.set(sessionID, 'coder');
		const session = swarmState.agentSessions.get(sessionID);
		if (!session) throw new Error('session was not created');
		session.currentTaskId = '1.1';
		session.declaredCoderScope = scope;
		restoreBindingSeam = installScopeGuardBindingSeam(_internals);
	}

	test.each([
		{
			label: 'write to nested .git control state',
			tool: 'write',
			scope: ['packages/core/.git/config'],
			args: { path: 'packages/core/.git/config', content: 'blocked' },
			code: 'AUTHORITY_PROTECTED_PATH',
		},
		{
			label: 'edit to .swarm state',
			tool: 'edit',
			scope: ['.swarm/runtime.json'],
			args: { path: '.swarm/runtime.json' },
			code: 'AUTHORITY_PROTECTED_PATH',
		},
		{
			label: 'write to verifier-owned policy config',
			tool: 'write',
			scope: ['biome.json'],
			args: { path: 'biome.json', content: '{}' },
			code: 'AUTHORITY_VERIFIER_CONFIG',
		},
		{
			label: 'write to central security source',
			tool: 'write',
			scope: ['src/security/example.ts'],
			args: { path: 'src/security/example.ts', content: 'blocked' },
			code: 'AUTHORITY_PROTECTED_PATH',
		},
		{
			label: 'edit to guardrails source',
			tool: 'edit',
			scope: ['src/hooks/guardrails/tool-before.ts'],
			args: { path: 'src/hooks/guardrails/tool-before.ts' },
			code: 'AUTHORITY_PROTECTED_PATH',
		},
	] as const)('denies coder $label even when declared', async (fixture) => {
		// Previous behavior: once the path appeared in declared scope,
		// scope-guard returned before the shared protected-path authority
		// layer could reject repository control state or verifier-owned policy.
		startCoder(`coder-${fixture.tool}-${fixture.code}`, [...fixture.scope]);
		const hook = createScopeGuardHook({ enabled: true }, directory);

		await expect(
			hook.toolBefore(
				{
					tool: fixture.tool,
					sessionID: `coder-${fixture.tool}-${fixture.code}`,
					callID: `call-${fixture.tool}-${fixture.code}`,
				},
				{ args: fixture.args },
			),
		).rejects.toThrow(fixture.code);
	});

	test.each([
		'package.json',
		'bun.lock',
		'dist/index.js',
	])('allows exact coder scope for configurable policy path %s', async (scopedPath) => {
		// Previous review finding targeted central protected prefixes only.
		// Config/generated files that are intentionally grantable by exact
		// scope must remain writable through this hook.
		startCoder(`coder-allowed-${scopedPath}`, [scopedPath]);
		const hook = createScopeGuardHook({ enabled: true }, directory);

		await expect(
			hook.toolBefore(
				{
					tool: 'write',
					sessionID: `coder-allowed-${scopedPath}`,
					callID: `call-allowed-${scopedPath}`,
				},
				{ args: { path: scopedPath, content: 'ok' } },
			),
		).resolves.toBeUndefined();
	});
});
