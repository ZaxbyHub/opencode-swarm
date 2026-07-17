import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	installLegacyScopeGuardTargetSeam,
	installScopeGuardBindingSeam,
} from '../../tests/helpers/scope-guard-binding-seam';
import type { AgentSessionState } from '../state';
import { swarmState } from '../state';
import {
	createScopeGuardHook,
	_internals as scopeGuardInternals,
} from './scope-guard';

const SID = 'adv-test-session';
let restoreScopeBindingSeam: (() => void) | undefined;
let restoreTargetSeam: (() => void) | undefined;

beforeEach(() => {
	restoreScopeBindingSeam = installScopeGuardBindingSeam(scopeGuardInternals);
	restoreTargetSeam = installLegacyScopeGuardTargetSeam(scopeGuardInternals);
	swarmState.agentSessions.set(SID, {
		agentName: 'mega_coder',
		declaredCoderScope: ['src/tools/update-task-status.ts'],
		currentTaskId: '1.1',
		pendingAdvisoryMessages: [],
		modifiedFilesThisCoderTask: [],
		sessionRehydratedAt: 0,
	} as unknown as AgentSessionState);
	swarmState.activeAgent.set(SID, 'mega_coder');
});

afterEach(() => {
	restoreScopeBindingSeam?.();
	restoreTargetSeam?.();
	swarmState.agentSessions.delete(SID);
	swarmState.activeAgent.delete(SID);
});

const makeHook = () => createScopeGuardHook({ enabled: true }, '/test');

describe('scope-guard adversarial', () => {
	it('namespace-stripped tool: opencode:write blocked correctly', async () => {
		const hook = makeHook();
		const input = { tool: 'opencode:write', sessionID: SID, callID: 'c1' };
		const output = { args: { path: 'src/hooks/attack.ts' } };
		await expect(async () => hook.toolBefore(input, output)).toThrow(
			'SCOPE VIOLATION',
		);
	});

	it('namespace-stripped tool: mcp.edit blocked correctly', async () => {
		const hook = makeHook();
		const input = { tool: 'mcp.edit', sessionID: SID, callID: 'c2' };
		const output = { args: { path: 'src/hooks/attack.ts' } };
		await expect(async () => hook.toolBefore(input, output)).toThrow(
			'SCOPE VIOLATION',
		);
	});

	it('path with null byte: sanitized (no crash, no injection)', async () => {
		const hook = makeHook();
		const input = { tool: 'write', sessionID: SID, callID: 'c3' };
		const output = { args: { path: 'src/hooks/foo\x00.ts' } };
		// Should throw (out of scope) but not crash with null byte
		await expect(async () => hook.toolBefore(input, output)).toThrow(
			'SCOPE VIOLATION',
		);
	});

	it('traversal path: src/tools/../hooks/attack.ts blocked', async () => {
		const hook = makeHook();
		const input = { tool: 'write', sessionID: SID, callID: 'c4' };
		const output = { args: { path: 'src/tools/../hooks/attack.ts' } };
		await expect(async () => hook.toolBefore(input, output)).toThrow(
			'SCOPE VIOLATION',
		);
	});

	it('empty args {}: returns early without throw', async () => {
		const hook = makeHook();
		const input = { tool: 'write', sessionID: SID, callID: 'c5' };
		const output = { args: {} };
		await hook.toolBefore(input, output); // should not throw
		expect(true).toBe(true);
	});

	it('ANSI escape in path: sanitized to underscores', async () => {
		const hook = makeHook();
		const input = { tool: 'write', sessionID: SID, callID: 'c6' };
		const output = { args: { path: 'src/hooks/\x1B[31mfoo\x1B[0m.ts' } };
		// Should throw with sanitized path (no raw ANSI in message)
		let caught: Error | null = null;
		try {
			await hook.toolBefore(input, output);
		} catch (e) {
			caught = e as Error;
		}
		expect(caught).not.toBeNull();
		expect(caught!.message).not.toContain('\x1B');
		expect(caught!.message).toContain('SCOPE VIOLATION');
	});

	it('very long path (10KB): no crash or memory issue', async () => {
		const hook = makeHook();
		const longPath = `src/hooks/${'a'.repeat(10000)}.ts`;
		const input = { tool: 'write', sessionID: SID, callID: 'c7' };
		const output = { args: { path: longPath } };
		await expect(async () => hook.toolBefore(input, output)).toThrow(
			'SCOPE VIOLATION',
		);
	});
});
