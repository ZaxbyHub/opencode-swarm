import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type AuthorityConfig,
	GuardrailsConfigSchema,
} from '../../../src/config/schema';
import {
	checkFileAuthority,
	createGuardrailsHooks,
} from '../../../src/hooks/guardrails';
import {
	beginInvocation,
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

describe('authority.enabled=false hard-policy hook coverage (FB-006)', () => {
	let directory = '';
	let cleanup = () => {};

	beforeEach(() => {
		resetSwarmState();
		const created = createSafeTestDir('authority-disabled-feedback-');
		directory = created.dir;
		cleanup = created.cleanup;
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		const session = ensureAgentSession('coder-disabled', 'coder', directory);
		session.delegationActive = true;
		swarmState.activeAgent.set('coder-disabled', 'coder');
		beginInvocation('coder-disabled', 'coder');
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('keeps universal, swarm-state, and verifier denies active', async () => {
		const authority: AuthorityConfig = {
			enabled: false,
			universal_deny_prefixes: ['secrets/'],
			verifier_config_paths: ['**/biome.json'],
		};
		const hook = createGuardrailsHooks(
			directory,
			GuardrailsConfigSchema.parse({ enabled: true }),
			undefined,
			authority,
		).toolBefore;
		const cases = [
			['secrets/token.txt', 'AUTHORITY_UNIVERSAL_DENY'],
			['.swarm/state.json', 'AUTHORITY_PROTECTED_PATH'],
			['biome.json', 'AUTHORITY_VERIFIER_CONFIG'],
		] as const;
		for (const [filePath, code] of cases) {
			await expect(
				hook(
					{
						tool: 'write',
						sessionID: 'coder-disabled',
						callID: `write-${code}`,
					},
					{ args: { filePath } },
				),
			).rejects.toThrow(code);
		}
	});

	test('allows custom or unknown host agent writes when authority.enabled is false', async () => {
		const authority: AuthorityConfig = {
			enabled: false,
			universal_deny_prefixes: ['secrets/'],
		};
		const hook = createGuardrailsHooks(
			directory,
			GuardrailsConfigSchema.parse({ enabled: true }),
			undefined,
			authority,
		).toolBefore;

		const customSession = ensureAgentSession(
			'sre-session',
			'sre-planner',
			directory,
		);
		customSession.delegationActive = true;
		swarmState.activeAgent.set('sre-session', 'sre-planner');
		beginInvocation('sre-session', 'sre-planner');

		// Unknown / host agent write to regular path succeeds when authority is disabled
		await expect(
			hook(
				{
					tool: 'write',
					sessionID: 'sre-session',
					callID: 'write-sre-test',
				},
				{ args: { filePath: 'tests/unit/test_smart_router.py' } },
			),
		).resolves.toBeUndefined();

		// Universal deny still protects secrets even when authority is disabled
		await expect(
			hook(
				{
					tool: 'write',
					sessionID: 'sre-session',
					callID: 'write-sre-secret',
				},
				{ args: { filePath: 'secrets/token.txt' } },
			),
		).rejects.toThrow('AUTHORITY_UNIVERSAL_DENY');
	});

	test('checkFileAuthority allows custom agent when authority is disabled or configured in rules', () => {
		// 1. When authority is disabled, unknown agents are allowed for normal paths
		const disabledResult = checkFileAuthority(
			'sre-planner',
			'tests/unit/test.py',
			directory,
			{
				enabled: false,
			},
		);
		expect(disabledResult.allowed).toBe(true);
		expect(disabledResult.layer).toBe('role-policy');

		// 2. When authority is enabled, configured custom agent in rules is allowed
		const configuredResult = checkFileAuthority(
			'builder',
			'src/file.py',
			directory,
			{
				enabled: true,
				rules: { builder: {} },
			},
		);
		expect(configuredResult.allowed).toBe(true);

		// 3. When authority is enabled, unconfigured custom agent is denied with AUTHORITY_UNKNOWN_AGENT
		const unknownResult = checkFileAuthority(
			'builder',
			'src/file.py',
			directory,
			{
				enabled: true,
			},
		);
		expect(unknownResult.allowed).toBe(false);
		expect(unknownResult.code).toBe('AUTHORITY_UNKNOWN_AGENT');
	});

	test('an unclassified agent admitted by authority.enabled=false never writes .git or .swarm control state', () => {
		for (const target of [
			'.git/hooks/pre-commit',
			'.git/config',
			'.swarm/evidence/gate.json',
			'.swarm/plan.json',
		]) {
			const decision = checkFileAuthority('sre-planner', target, directory, {
				enabled: false,
			});
			expect(decision.allowed).toBe(false);
			if (!decision.allowed) {
				expect(decision.code).toBe('AUTHORITY_PROTECTED_PATH');
				expect(decision.layer).toBe('protected-path');
				expect(decision.rule).toBe(
					'unclassified-agent-control-state-protection',
				);
			}
		}
		// Normal workspace paths stay writable for the same agent.
		expect(
			checkFileAuthority('sre-planner', 'src/app.py', directory, {
				enabled: false,
			}).allowed,
		).toBe(true);
	});

	test('control-state protection for unclassified agents is not applied when authority is enabled or the agent is classified', () => {
		// Enabled: the unknown-agent denial still wins, with its original code.
		const enabled = checkFileAuthority(
			'sre-planner',
			'.swarm/state.json',
			directory,
			{
				enabled: true,
			},
		);
		expect(enabled.allowed).toBe(false);
		if (!enabled.allowed) {
			expect(enabled.code).toBe('AUTHORITY_UNKNOWN_AGENT');
		}
		// No authority config at all: authority is enabled by default, so the
		// unknown-agent denial applies (only an explicit enabled:false admits).
		for (const config of [undefined, {}]) {
			const unconfigured = checkFileAuthority(
				'sre-planner',
				'src/app.py',
				directory,
				config,
			);
			expect(unconfigured.allowed).toBe(false);
			if (!unconfigured.allowed) {
				expect(unconfigured.code).toBe('AUTHORITY_UNKNOWN_AGENT');
			}
		}
		// Classified architect behavior while disabled is unchanged (allowed).
		expect(
			checkFileAuthority('architect', '.swarm/state.json', directory, {
				enabled: false,
			}).allowed,
		).toBe(true);
	});

	test("the literal 'unknown' sentinel agent is still denied when authority is disabled", () => {
		for (const target of ['src/app.py', '.swarm/state.json']) {
			const decision = checkFileAuthority('unknown', target, directory, {
				enabled: false,
			});
			expect(decision.allowed).toBe(false);
			if (!decision.allowed) {
				expect(decision.code).toBe('AUTHORITY_UNKNOWN_AGENT');
			}
		}
	});

	test('decision codes and layers keep their original values around the disabled allow', () => {
		// Enabled + unknown agent on a universal-deny path keeps the unknown-agent code.
		const unknownOnDeniedPath = checkFileAuthority(
			'sre-planner',
			'secrets/token.txt',
			directory,
			{ enabled: true, universal_deny_prefixes: ['secrets/'] },
		);
		expect(unknownOnDeniedPath.allowed).toBe(false);
		if (!unknownOnDeniedPath.allowed) {
			expect(unknownOnDeniedPath.code).toBe('AUTHORITY_UNKNOWN_AGENT');
		}
		// Disabled + coder inside its declared scope keeps the declared-scope layer.
		const scoped = checkFileAuthority(
			'coder',
			'package.json',
			directory,
			{ enabled: false },
			{ declaredScope: ['package.json'] },
		);
		expect(scoped.allowed).toBe(true);
		expect(scoped.layer).toBe('declared-scope');
		// Disabled mode ignores per-agent rules (including readOnly) for unclassified agents.
		const ignoredRule = checkFileAuthority('builder', 'src/app.py', directory, {
			enabled: false,
			rules: { builder: { readOnly: true } },
		});
		expect(ignoredRule.allowed).toBe(true);
		expect(ignoredRule.layer).toBe('role-policy');
	});
});
