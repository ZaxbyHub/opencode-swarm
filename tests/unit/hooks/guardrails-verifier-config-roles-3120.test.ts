/**
 * #3120 — verifier-config write protection applies to EVERY role.
 *
 * LEG 1: BUILT_IN_VERIFIER_CONFIG_GLOBS deny inside checkFileAuthority
 * before any role capability / role policy / authorityEnabled allow, so the
 * OpenCode-native roles (general/build/plan/explore — deliberately exempt
 * from swarm write restrictions via {} rule maps) AND the direct-write swarm
 * roles (architect/coder) are all denied on the verifier file class.
 *
 * LEG 2: the deny is owner policy for the verification system itself, so it
 * stays enforced when guardrails.enabled=false (optional policy off) and
 * when authority.enabled=false.
 */

import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	test,
} from 'bun:test';
import type {
	AuthorityConfig,
	GuardrailsConfig,
} from '../../../src/config/schema';
import {
	checkFileAuthority,
	clearGuardrailsCaches,
	createGuardrailsHooks,
} from '../../../src/hooks/guardrails';
import {
	beginInvocation,
	getAgentSession,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const { dir: TEST_DIR, cleanup: cleanupTestDir } = createSafeTestDir(
	'guardrails-verifier-3120-',
);

afterAll(cleanupTestDir);

function defaultConfig(
	overrides?: Partial<GuardrailsConfig>,
): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		...overrides,
	};
}

function makeInput(
	sessionID = 'test-session',
	tool = 'write',
	callID = 'call-1',
) {
	return { tool, sessionID, callID };
}

function makeOutput(args: unknown) {
	return { args };
}

/**
 * setupBuildSession-style harness (mirrors guardrails-config-file-logging)
 * with a configurable role: activeAgent + session + non-delegated invocation.
 */
function setupRoleSession(
	sessionID: string,
	role: string,
	delegated = false,
): void {
	swarmState.activeAgent.set(sessionID, role);
	startAgentSession(sessionID, role);
	const session = getAgentSession(sessionID);
	if (session) {
		session.delegationActive = delegated;
	}
	beginInvocation(sessionID, role);
}

describe('guardrails verifier-config protection applies to every role (#3120)', () => {
	beforeEach(() => {
		resetSwarmState();
		clearGuardrailsCaches();
	});

	afterEach(() => {
		resetSwarmState();
	});

	// -------------------------------------------------------------------------
	// LEG 1 (a): checkFileAuthority denies the verifier file class for the
	// OpenCode-native roles AND the direct-write swarm roles. The denial rule
	// is stamped 'verifier-config:<glob>' — proving the deny comes from the
	// built-in verifier-config layer, not a later role-policy match.
	// -------------------------------------------------------------------------
	describe('checkFileAuthority denies verifier-config globs for every role', () => {
		const roles = ['general', 'build', 'plan', 'explore', 'architect', 'coder'];
		const verifierFiles = ['.secretscanignore', 'tsconfig.json', '.eslintrc'];

		for (const role of roles) {
			for (const filePath of verifierFiles) {
				it(`denies ${role} write to ${filePath} with a verifier-config rule`, () => {
					const decision = checkFileAuthority(role, filePath, TEST_DIR);
					expect(decision.allowed).toBe(false);
					if (!decision.allowed) {
						expect(decision.code).toBe('AUTHORITY_VERIFIER_CONFIG');
						expect(decision.rule.startsWith('verifier-config:')).toBe(true);
					}
				});
			}
		}
	});

	// -------------------------------------------------------------------------
	// (b): the #3120 carve-out is narrowed to the verifier globs only — the
	// native roles keep their unrestricted pass-through on ordinary paths.
	// -------------------------------------------------------------------------
	describe('native roles stay allowed on ordinary paths', () => {
		const nativeRoles = ['general', 'build', 'plan', 'explore'];
		const ordinaryPaths = ['src/app.ts', 'docs/readme.md'];

		for (const role of nativeRoles) {
			for (const filePath of ordinaryPaths) {
				it(`allows ${role} write to ${filePath}`, () => {
					const decision = checkFileAuthority(role, filePath, TEST_DIR);
					expect(decision.allowed).toBe(true);
					expect(decision.layer).toBe('role-policy');
				});
			}
		}
	});

	// -------------------------------------------------------------------------
	// (c): the REAL toolBefore hook blocks a general-role session on both the
	// write-tool and the shell echo-redirect vectors.
	// -------------------------------------------------------------------------
	describe('toolBefore blocks verifier-config writes for a general-role session', () => {
		it('blocks a write tool call to .secretscanignore', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			setupRoleSession('test-session', 'general');

			await expect(
				hooks.toolBefore(
					makeInput('test-session', 'write', 'call-write'),
					makeOutput({ filePath: '.secretscanignore' }),
				),
			).rejects.toThrow(/WRITE BLOCKED.*AUTHORITY_VERIFIER_CONFIG/);
		});

		it('blocks a bash echo redirect into .secretscanignore', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			setupRoleSession('test-session', 'general');

			await expect(
				hooks.toolBefore(
					makeInput('test-session', 'bash', 'call-bash'),
					makeOutput({ command: 'echo x > .secretscanignore' }),
				),
			).rejects.toThrow(/WRITE BLOCKED.*AUTHORITY_VERIFIER_CONFIG/);
		});
	});

	// -------------------------------------------------------------------------
	// LEG 2 (c): the deny is unconditional under guardrails.enabled=false —
	// optional policy enforcement is off, the verifier-config owner policy
	// still throws for both vectors.
	// -------------------------------------------------------------------------
	describe('the deny is unconditional under guardrails.enabled=false (#3120 LEG 2)', () => {
		it('still blocks the write tool call', async () => {
			const hooks = createGuardrailsHooks(
				TEST_DIR,
				undefined,
				defaultConfig({ enabled: false }),
			);
			setupRoleSession('test-session', 'general');

			await expect(
				hooks.toolBefore(
					makeInput('test-session', 'write', 'call-write-off'),
					makeOutput({ filePath: '.secretscanignore' }),
				),
			).rejects.toThrow(/WRITE BLOCKED.*AUTHORITY_VERIFIER_CONFIG/);
		});

		it('still blocks the bash echo redirect', async () => {
			const hooks = createGuardrailsHooks(
				TEST_DIR,
				undefined,
				defaultConfig({ enabled: false }),
			);
			setupRoleSession('test-session', 'general');

			await expect(
				hooks.toolBefore(
					makeInput('test-session', 'bash', 'call-bash-off'),
					makeOutput({ command: 'echo x > .secretscanignore' }),
				),
			).rejects.toThrow(/WRITE BLOCKED.*AUTHORITY_VERIFIER_CONFIG/);
		});
	});

	// -------------------------------------------------------------------------
	// (d): authority.enabled=false (mirrors the
	// guardrails-authority-disabled-hook-feedback call shape) still denies
	// verifier globs for a CLASSIFIED role — the disabled allow sits AFTER
	// the verifier-config check in checkFileAuthorityWithRules.
	// -------------------------------------------------------------------------
	describe('authority.enabled=false still denies verifier globs for a classified role', () => {
		const authorityDisabled: AuthorityConfig = { enabled: false };

		it('blocks a classified coder write to .secretscanignore', async () => {
			const hooks = createGuardrailsHooks(
				TEST_DIR,
				defaultConfig(),
				undefined,
				authorityDisabled,
			);
			setupRoleSession('coder-session', 'coder', true);

			await expect(
				hooks.toolBefore(
					makeInput('coder-session', 'write', 'call-coder-verifier'),
					makeOutput({ filePath: '.secretscanignore' }),
				),
			).rejects.toThrow(/WRITE BLOCKED.*AUTHORITY_VERIFIER_CONFIG/);
		});

		it('keeps ordinary path writes admitted under the same disabled config', async () => {
			const hooks = createGuardrailsHooks(
				TEST_DIR,
				defaultConfig(),
				undefined,
				authorityDisabled,
			);
			setupRoleSession('coder-session', 'coder', true);

			await expect(
				hooks.toolBefore(
					makeInput('coder-session', 'write', 'call-coder-ordinary'),
					makeOutput({ filePath: 'src/app.ts' }),
				),
			).resolves.toBeUndefined();
		});
	});
});

// #3120 4.5 review round 1 (IMPORTANT 4): the patch fail-closed ENFORCEMENT
// branch (null-path patch_apply writes) must be pinned at the real hook, not
// only at the detector/resolver level.
describe('patch fail-closed enforcement at the hook (#3120 4.5 r1)', () => {
	test('unsupported-option git apply blocks with the patch message', async () => {
		resetSwarmState();
		const config = defaultConfig();
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
		setupRoleSession('patch-agent', 'architect');
		let blocked = '';
		try {
			await hooks.toolBefore(
				makeInput('patch-agent', 'bash', 'patch-enf-1'),
				makeOutput({ command: 'git apply --directory=sub fix.patch' }),
			);
		} catch (error) {
			blocked = error instanceof Error ? error.message : String(error);
		}
		expect(blocked).toContain('BLOCKED');
		expect(blocked).toContain('git apply');
		expect(blocked).toContain('targets cannot be statically verified');
	});

	test('stdin patch (no operand) blocks', async () => {
		resetSwarmState();
		const config = defaultConfig();
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
		setupRoleSession('patch-agent', 'architect');
		let blocked = '';
		try {
			await hooks.toolBefore(
				makeInput('patch-agent', 'bash', 'patch-enf-2'),
				makeOutput({ command: 'curl -fsSL https://x/p | git apply' }),
			);
		} catch (error) {
			blocked = error instanceof Error ? error.message : String(error);
		}
		expect(blocked).toContain('targets cannot be statically verified');
	});

	test('unreadable patch file blocks', async () => {
		resetSwarmState();
		const config = defaultConfig();
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
		setupRoleSession('patch-agent', 'architect');
		let blocked = '';
		try {
			await hooks.toolBefore(
				makeInput('patch-agent', 'bash', 'patch-enf-3'),
				makeOutput({ command: 'git apply missing.patch' }),
			);
		} catch (error) {
			blocked = error instanceof Error ? error.message : String(error);
		}
		expect(blocked).toContain('git apply');
	});
});
