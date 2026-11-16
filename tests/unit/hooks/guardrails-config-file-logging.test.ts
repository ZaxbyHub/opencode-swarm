import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	spyOn,
} from 'bun:test';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import {
	clearGuardrailsCaches,
	createGuardrailsHooks,
} from '../../../src/hooks/guardrails';
import {
	beginInvocation,
	ensureAgentSession,
	getAgentSession,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import * as utilsModule from '../../../src/utils';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const { dir: TEST_DIR, cleanup: cleanupTestDir } = createSafeTestDir(
	'guardrails-config-logging-',
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
	tool = 'read',
	callID = 'call-1',
) {
	return { tool, sessionID, callID };
}

function makeOutput(args: unknown = { filePath: '/test.ts' }) {
	return { args };
}

describe('guardrails config-file logging', () => {
	beforeEach(() => {
		resetSwarmState();
		clearGuardrailsCaches();
	});

	afterEach(() => {
		resetSwarmState();
	});

	// -------------------------------------------------------------------------
	// Helper: set up build agent session for config-file write testing.
	// build agent has empty authority rules {} — no blocked zones, no prefix
	// restrictions. This allows config files to pass the authority check,
	// enabling tests for the warn-call in the direct write path.
	// -------------------------------------------------------------------------
	function setupBuildSession(sessionID = 'test-session'): void {
		swarmState.activeAgent.set(sessionID, 'build');
		startAgentSession(sessionID, 'build');
		const session = getAgentSession(sessionID);
		if (session) {
			session.delegationActive = false; // test direct write path (not delegated)
		}
		beginInvocation(sessionID, 'build');
	}

	// -------------------------------------------------------------------------
	// Test 1: warn triggered for config-zone files
	// (classifyFile returns zone: 'config')
	//
	// #3120: files matching BUILT_IN_VERIFIER_CONFIG_GLOBS (tsconfig.json,
	// biome.json, …) are now hard-blocked for EVERY role — the authority
	// throw in toolBefore happens BEFORE the config-file warn, so blocked
	// writes never reach the warn. Only NON-verifier config-zone files
	// (config/settings.yml) keep the warn path.
	// -------------------------------------------------------------------------
	describe('config-zone classification triggers warn', () => {
		it('blocks tsconfig.json write for build (verifier-config glob, #3120)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			setupBuildSession();
			const warnSpy = spyOn(utilsModule, 'warn').mockImplementation(() => {});

			await expect(
				hooks.toolBefore(
					makeInput('test-session', 'write', 'call-1'),
					makeOutput({ filePath: 'tsconfig.json' }),
				),
			).rejects.toThrow(/WRITE BLOCKED.*AUTHORITY_VERIFIER_CONFIG/);

			// The authority throw fires first: the config-file warn never runs.
			const configFileWarnings = warnSpy.mock.calls.filter(
				([msg]) => msg === 'Config file write attempt',
			);
			expect(configFileWarnings).toHaveLength(0);
			warnSpy.mockRestore();
		});

		it('blocks biome.json write for build (verifier-config glob, #3120)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			setupBuildSession();

			await expect(
				hooks.toolBefore(
					makeInput('test-session', 'write', 'call-1'),
					makeOutput({ filePath: 'biome.json' }),
				),
			).rejects.toThrow(/WRITE BLOCKED.*AUTHORITY_VERIFIER_CONFIG/);
		});

		it('warns for nested config/settings.yml (zone: config)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			setupBuildSession();
			const warnSpy = spyOn(utilsModule, 'warn').mockImplementation(() => {});

			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-1'),
				makeOutput({ filePath: 'config/settings.yml' }),
			);

			expect(warnSpy).toHaveBeenCalledWith(
				'Config file write attempt',
				expect.objectContaining({
					path: 'config/settings.yml',
					type: 'direct_write',
				}),
			);
			warnSpy.mockRestore();
		});

		it('preserves direct_patch audit type for native apply_patch', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			setupBuildSession();
			const warnSpy = spyOn(utilsModule, 'warn').mockImplementation(() => {});

			// #3120: tsconfig.json is a verifier-config glob and now hard-blocks,
			// so the audit-type pin uses a NON-verifier config-zone file.
			await hooks.toolBefore(
				makeInput('test-session', 'apply_patch', 'call-patch'),
				makeOutput({
					input:
						'*** Begin Patch\n*** Update File: config/settings.yml\n@@\n-old\n+new\n*** End Patch',
				}),
			);

			expect(warnSpy).toHaveBeenCalledWith(
				'Config file write attempt',
				expect.objectContaining({
					path: 'config/settings.yml',
					type: 'direct_patch',
				}),
			);
			warnSpy.mockRestore();
		});
	});

	// -------------------------------------------------------------------------
	// Test 2: KNOWN_VERIFIER_CONFIG_GLOBS matches now hard-block (#3120).
	// Every case below is in BUILT_IN_VERIFIER_CONFIG_GLOBS, so a build-role
	// write toolBefore REJECTS with AUTHORITY_VERIFIER_CONFIG before the
	// config-file warn can fire (pre-#3120 these warned with allowed: true).
	// -------------------------------------------------------------------------
	describe('KNOWN_VERIFIER_CONFIG_GLOBS matching hard-blocks writes (#3120)', () => {
		const globCases = [
			{ filePath: '.eslintrc', label: '.eslintrc (root dotfile)' },
			{ filePath: '.eslintrc.js', label: '.eslintrc.js' },
			{ filePath: 'eslint.config.mjs', label: 'eslint.config.mjs' },
			{ filePath: '.prettierrc', label: '.prettierrc' },
			{ filePath: '.prettierrc.yml', label: '.prettierrc.yml' },
			{ filePath: 'oxlintrc', label: 'oxlintrc (no dot)' },
			{ filePath: '.oxlintrc', label: '.oxlintrc' },
			{ filePath: 'biome.jsonc', label: 'biome.jsonc (glob only, not zone)' },
			{ filePath: '.secretscanignore', label: '.secretscanignore' },
			{ filePath: '.golangci.toml', label: '.golangci.toml' },
			{ filePath: '.golangci.yaml', label: '.golangci.yaml' },
		];

		for (const { filePath, label } of globCases) {
			it(`blocks write to ${label} (AUTHORITY_VERIFIER_CONFIG)`, async () => {
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
				setupBuildSession();
				const warnSpy = spyOn(utilsModule, 'warn').mockImplementation(() => {});

				await expect(
					hooks.toolBefore(
						makeInput('test-session', 'write', 'call-1'),
						makeOutput({ filePath }),
					),
				).rejects.toThrow(/WRITE BLOCKED.*AUTHORITY_VERIFIER_CONFIG/);

				const configFileWarnings = warnSpy.mock.calls.filter(
					([msg]) => msg === 'Config file write attempt',
				);
				expect(configFileWarnings).toHaveLength(0);
				warnSpy.mockRestore();
			});
		}
	});

	// -------------------------------------------------------------------------
	// Test 3: warn NOT triggered for non-config files
	// -------------------------------------------------------------------------
	describe('non-config files do NOT trigger config-file warn', () => {
		const nonConfigCases = [
			{ filePath: 'src/index.ts', label: 'source file (.ts) in src/' },
			{ filePath: 'src/app.js', label: 'source file (.js) in src/' },
			{ filePath: 'lib/helpers.py', label: 'source file in lib/' },
			{ filePath: 'README.md', label: 'README (docs zone)' },
			{ filePath: 'docs/guide.md', label: 'doc file in docs/' },
			{ filePath: 'test/unit/example.test.ts', label: 'test file (test zone)' },
			{
				filePath: 'dist/index.js',
				label: 'generated file in dist/ (generated zone)',
			},
			{
				filePath: 'build/output.wasm',
				label: 'generated .wasm file (generated zone)',
			},
			{
				filePath: '.github/workflows/ci.yml',
				label: '.github file (build zone)',
			},
		];

		for (const { filePath, label } of nonConfigCases) {
			it(`does NOT warn for ${label}`, async () => {
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
				setupBuildSession();
				const warnSpy = spyOn(utilsModule, 'warn').mockImplementation(() => {});

				await hooks.toolBefore(
					makeInput('test-session', 'write', 'call-1'),
					makeOutput({ filePath }),
				);

				const configFileWarnings = warnSpy.mock.calls.filter(
					([msg]) => msg === 'Config file write attempt',
				);
				expect(configFileWarnings).toHaveLength(0);
				warnSpy.mockRestore();
			});
		}
	});

	// -------------------------------------------------------------------------
	// Test 4: delegated context — verifier-config globs hard-block (#3120);
	// the delegated_write / delegated_patch audit types stay pinned via a
	// NON-verifier config-zone file (config/settings.yml).
	// -------------------------------------------------------------------------
	describe('delegated config-file writes trigger the canonical warn', () => {
		function setupDelegatedBuildSession(sessionID = 'test-session'): void {
			swarmState.activeAgent.set(sessionID, 'build');
			startAgentSession(sessionID, 'build');
			beginInvocation(sessionID, 'build');
			const session = getAgentSession(sessionID);
			if (session) {
				session.delegationActive = true; // delegated write path
			}
		}

		it('blocks delegated write to .eslintrc (glob match, #3120)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			setupDelegatedBuildSession();

			// Delegated write: delegationActive=true, tool is 'write'
			await expect(
				hooks.toolBefore(
					makeInput('test-session', 'write', 'call-1'),
					makeOutput({ filePath: '.eslintrc' }),
				),
			).rejects.toThrow(/WRITE BLOCKED.*AUTHORITY_VERIFIER_CONFIG/);
		});

		it('blocks delegated write to tsconfig.json (zone: config, #3120)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			setupDelegatedBuildSession();

			await expect(
				hooks.toolBefore(
					makeInput('test-session', 'write', 'call-1'),
					makeOutput({ filePath: 'tsconfig.json' }),
				),
			).rejects.toThrow(/WRITE BLOCKED.*AUTHORITY_VERIFIER_CONFIG/);
		});

		it('blocks delegated native apply_patch to tsconfig.json (#3120)', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			setupDelegatedBuildSession();

			await expect(
				hooks.toolBefore(
					makeInput('test-session', 'apply_patch', 'call-patch'),
					makeOutput({
						input:
							'*** Begin Patch\n*** Update File: tsconfig.json\n@@\n-old\n+new\n*** End Patch',
					}),
				),
			).rejects.toThrow(/WRITE BLOCKED.*AUTHORITY_VERIFIER_CONFIG/);
		});

		it('preserves delegated audit types for non-verifier config files', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			setupDelegatedBuildSession();
			const warnSpy = spyOn(utilsModule, 'warn').mockImplementation(() => {});

			// #3120: verifier-config globs hard-block, so the delegated_write and
			// delegated_patch audit-type pins use a NON-verifier config-zone file.
			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-delegated-write'),
				makeOutput({ filePath: 'config/settings.yml' }),
			);
			expect(warnSpy).toHaveBeenCalledWith(
				'Config file write attempt',
				expect.objectContaining({
					type: 'delegated_write',
					path: 'config/settings.yml',
				}),
			);

			await hooks.toolBefore(
				makeInput('test-session', 'apply_patch', 'call-delegated-patch'),
				makeOutput({
					input:
						'*** Begin Patch\n*** Update File: config/settings.yml\n@@\n-old\n+new\n*** End Patch',
				}),
			);
			expect(warnSpy).toHaveBeenCalledWith(
				'Config file write attempt',
				expect.objectContaining({
					path: 'config/settings.yml',
					type: 'delegated_patch',
				}),
			);
			warnSpy.mockRestore();
		});
	});

	// -------------------------------------------------------------------------
	// Test 5: warn NOT triggered for non-write tools
	// -------------------------------------------------------------------------
	describe('non-write tools do NOT trigger config-file warn', () => {
		it('does NOT warn for read tool with config file', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			setupBuildSession();
			const warnSpy = spyOn(utilsModule, 'warn').mockImplementation(() => {});

			await hooks.toolBefore(
				makeInput('test-session', 'read', 'call-1'),
				makeOutput({ filePath: 'tsconfig.json' }),
			);

			const configFileWarnings = warnSpy.mock.calls.filter(
				([msg]) => msg === 'Config file write attempt',
			);
			expect(configFileWarnings).toHaveLength(0);
			warnSpy.mockRestore();
		});

		it('does NOT warn for lint tool with config file', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			setupBuildSession();
			const warnSpy = spyOn(utilsModule, 'warn').mockImplementation(() => {});

			await hooks.toolBefore(
				makeInput('test-session', 'lint', 'call-1'),
				makeOutput({ filePath: '.eslintrc' }),
			);

			const configFileWarnings = warnSpy.mock.calls.filter(
				([msg]) => msg === 'Config file write attempt',
			);
			expect(configFileWarnings).toHaveLength(0);
			warnSpy.mockRestore();
		});
	});

	// -------------------------------------------------------------------------
	// Edge cases: path normalization
	// -------------------------------------------------------------------------
	describe('path normalization edge cases', () => {
		it('handles absolute Windows paths for verifier config files (#3120 block)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			setupBuildSession();

			// Absolute path to tsconfig.json — the authority check normalizes it
			// back to the workspace-relative form before the verifier glob match.
			const absPath = path.join(TEST_DIR, 'tsconfig.json');
			await expect(
				hooks.toolBefore(
					makeInput('test-session', 'write', 'call-1'),
					makeOutput({ filePath: absPath }),
				),
			).rejects.toThrow(/WRITE BLOCKED.*AUTHORITY_VERIFIER_CONFIG/);
		});

		it('blocks .prettierrc via glob matching on Windows paths (#3120)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			setupBuildSession();

			// Using forward-slash path which should work on Windows too
			await expect(
				hooks.toolBefore(
					makeInput('test-session', 'write', 'call-1'),
					makeOutput({ filePath: '.prettierrc' }),
				),
			).rejects.toThrow(/WRITE BLOCKED.*AUTHORITY_VERIFIER_CONFIG/);
		});
	});
});
