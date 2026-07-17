import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import type {
	AuthorityConfig,
	GuardrailsConfig,
} from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	dcSplitSegments,
	dcStripOneWrapper,
} from '../../../src/hooks/guardrails/destructive-command';
import {
	claimScopeBindingForChild,
	createScopeBinding,
	registerScopeBinding,
} from '../../../src/scope/scope-binding';
import {
	getAgentSession,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

/**
 * Issue #1778 H3: the last-line-of-defense shell guards were bypassable.
 * These integration tests exercise the real toolBefore hook to prove each
 * bypass is closed while legitimate commands (fd-redirects) still pass.
 */

let testDir = '';
let cleanup = () => {};
const plan: Plan = {
	schema_version: '1.0.0',
	title: 'Shell guard fixture',
	swarm: 'test',
	phases: [
		{
			id: 1,
			name: 'Test',
			status: 'in_progress',
			tasks: [
				{
					id: '1.1',
					phase: 1,
					status: 'pending',
					size: 'small',
					description: 'Shell guard',
					depends: [],
					files_touched: ['src'],
				},
			],
		},
	],
};

function defaultConfig(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
	};
}

function makeBashInput(sessionID: string) {
	return { tool: 'bash' as const, sessionID, callID: 'call-1' };
}
function makeOutput(command: string) {
	return { args: { command } };
}
function coderSession(id: string): void {
	startAgentSession(id, 'coder', testDir);
	swarmState.activeAgent.set(id, 'coder');
}
function setDeclaredScope(sessionId: string, scope: string[]): void {
	const session = getAgentSession(sessionId);
	if (!session) throw new Error('test session missing');
	session.currentTaskId = '1.1';
	session.declaredCoderScope = scope;
	const parentSessionId = `${sessionId}-parent`;
	const callId = `${sessionId}-call`;
	const pending = createScopeBinding({
		directory: testDir,
		plan,
		taskId: '1.1',
		files: scope,
		ownerSessionId: parentSessionId,
		ownerMessageId: callId,
		dispatchCallId: callId,
		source: 'plan',
	});
	if (!pending) throw new Error('scope fixture was not created');
	registerScopeBinding(pending);
	if (
		!claimScopeBindingForChild({
			directory: testDir,
			parentSessionId,
			childSessionId: sessionId,
			dispatchCallId: callId,
		})
	)
		throw new Error('scope fixture was not activated');
}

describe('shell guard bypasses closed (#1778 H3)', () => {
	beforeEach(() => {
		resetSwarmState();
		const created = createSafeTestDir('shell-guard-');
		testDir = created.dir;
		cleanup = created.cleanup;
		fs.mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(testDir, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	it('blocks a write hidden inside bash -c that is outside declared scope', async () => {
		const hooks = createGuardrailsHooks(testDir, undefined, defaultConfig());
		coderSession('h3-bashc');
		setDeclaredScope('h3-bashc', ['src/']);

		await expect(
			hooks.toolBefore(
				makeBashInput('h3-bashc'),
				makeOutput(`bash -c "echo pwn > outside-scope.txt"`),
			),
		).rejects.toThrow(/outside declared scope|not authorised|unresolvable/);
	});

	it('blocks a write hidden inside eval that is outside declared scope', async () => {
		const hooks = createGuardrailsHooks(testDir, undefined, defaultConfig());
		coderSession('h3-eval');
		setDeclaredScope('h3-eval', ['src/']);

		await expect(
			hooks.toolBefore(
				makeBashInput('h3-eval'),
				makeOutput(`eval "echo pwn > outside-scope.txt"`),
			),
		).rejects.toThrow(/outside declared scope|not authorised|unresolvable/);
	});

	it('fails closed before any coder shell write when scope is absent', async () => {
		const authority: AuthorityConfig = {
			universal_deny_prefixes: ['.git'],
		} as AuthorityConfig;
		const hooks = createGuardrailsHooks(
			testDir,
			undefined,
			defaultConfig(),
			authority,
		);
		coderSession('h3-noscope');
		// No active Task-correlated scope exists.

		await expect(
			hooks.toolBefore(
				makeBashInput('h3-noscope'),
				makeOutput('echo pwn > ordinary-output.txt'),
			),
		).rejects.toThrow(/SCOPE_NOT_DECLARED/);
	});

	it('blocks rm with stacked non-rf flags (rm -rfv) on an unsafe path', async () => {
		const hooks = createGuardrailsHooks(testDir, undefined, defaultConfig());
		coderSession('h3-rmrfv');
		setDeclaredScope('h3-rmrfv', ['src/']);

		await expect(
			hooks.toolBefore(
				makeBashInput('h3-rmrfv'),
				makeOutput('rm -rfv /etc/passwd'),
			),
		).rejects.toThrow(/destructive|not authorised|unsafe/i);
	});

	it('blocks rm -vrf (flag order variant) on an unsafe path', async () => {
		const hooks = createGuardrailsHooks(testDir, undefined, defaultConfig());
		coderSession('h3-rmvrf');
		setDeclaredScope('h3-rmvrf', ['src/']);

		await expect(
			hooks.toolBefore(
				makeBashInput('h3-rmvrf'),
				makeOutput('rm -vrf /etc/passwd'),
			),
		).rejects.toThrow(/destructive|not authorised|unsafe/i);
	});

	it('blocks a destructive command hidden after a lone & separator', async () => {
		const hooks = createGuardrailsHooks(testDir, undefined, defaultConfig());
		coderSession('h3-amp');
		setDeclaredScope('h3-amp', ['src/']);

		await expect(
			hooks.toolBefore(
				makeBashInput('h3-amp'),
				makeOutput('echo hi & rm -rf /etc/passwd'),
			),
		).rejects.toThrow(/destructive|not authorised|unsafe/i);
	});

	it('allows an in-scope write with a trailing fd-redirect (2>&1)', async () => {
		const hooks = createGuardrailsHooks(testDir, undefined, defaultConfig());
		coderSession('h3-fd');
		setDeclaredScope('h3-fd', ['src/']);

		// In-scope write with a stderr->stdout redirect; the `&` in 2>&1 must not
		// be treated as a command separator.
		await expect(
			hooks.toolBefore(
				makeBashInput('h3-fd'),
				makeOutput('echo hi > src/log.txt 2>&1'),
			),
		).resolves.toBeUndefined();
	});

	describe('dcSplitSegments — lone & vs fd-redirects (R8 regression)', () => {
		it('splits a lone & command separator', () => {
			expect(dcSplitSegments('echo hi & rm -rf /home')).toEqual([
				'echo hi',
				'rm -rf /home',
			]);
		});

		it('does NOT split fd-duplication redirects', () => {
			expect(dcSplitSegments('echo x 2>&1 > log')).toEqual([
				'echo x 2>&1 > log',
			]);
			expect(dcSplitSegments('echo x >& log')).toEqual(['echo x >& log']);
			expect(dcSplitSegments('echo x &> log')).toEqual(['echo x &> log']);
		});

		it('still splits && without treating it as a lone &', () => {
			expect(dcSplitSegments('a && b')).toEqual(['a', 'b']);
		});
	});

	describe('dcStripOneWrapper — eval handler (R10)', () => {
		it('unwraps eval with single quotes', () => {
			expect(dcStripOneWrapper("eval 'rm -rf /home'")).toBe('rm -rf /home');
		});
		it('unwraps eval with double quotes', () => {
			expect(dcStripOneWrapper('eval "rm -rf /home"')).toBe('rm -rf /home');
		});
		it('unwraps bare eval', () => {
			expect(dcStripOneWrapper('eval rm')).toBe('rm');
		});
	});

	describe('rm flag detection preserves OR-semantics (R9)', () => {
		// -r alone and -f alone must still be caught on unsafe paths (no narrowing).
		for (const cmd of ['rm -r /etc', 'rm -f /etc/passwd', 'rm -R /etc']) {
			it(`blocks "${cmd}"`, async () => {
				const hooks = createGuardrailsHooks(
					testDir,
					undefined,
					defaultConfig(),
				);
				const id = `h3-${cmd.replace(/\W+/g, '')}`;
				coderSession(id);
				setDeclaredScope(id, ['src/']);
				// On macOS /etc is itself a symlink (-> /private/etc), so the
				// more specific symlink/junction ancestor guard fires instead of
				// the generic destructive-command message — both are correct
				// rejections of the same unsafe command, so accept either.
				await expect(
					hooks.toolBefore(makeBashInput(id), makeOutput(cmd)),
				).rejects.toThrow(
					/destructive|not authorised|unsafe|symlink\/junction/i,
				);
			});
		}
	});
});
