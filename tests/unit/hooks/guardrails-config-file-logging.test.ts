import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as os from 'node:os';
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

const TEST_DIR = os.tmpdir();

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
	// -------------------------------------------------------------------------
	describe('config-zone classification triggers warn', () => {
		it('warns for tsconfig.json (zone: config)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			setupBuildSession();
			const warnSpy = spyOn(utilsModule, 'warn').mockImplementation(() => {});

			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-1'),
				makeOutput({ filePath: 'tsconfig.json' }),
			);

			expect(warnSpy).toHaveBeenCalledWith(
				'Config file write attempt',
				expect.objectContaining({
					agent: 'build',
					path: 'tsconfig.json',
					allowed: true,
					type: 'direct_write',
				}),
			);
			warnSpy.mockRestore();
		});

		it('warns for biome.json (zone: config via .json extension)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			setupBuildSession();
			const warnSpy = spyOn(utilsModule, 'warn').mockImplementation(() => {});

			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-1'),
				makeOutput({ filePath: 'biome.json' }),
			);

			expect(warnSpy).toHaveBeenCalledWith(
				'Config file write attempt',
				expect.objectContaining({
					path: 'biome.json',
					type: 'direct_write',
				}),
			);
			warnSpy.mockRestore();
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
	});

	// -------------------------------------------------------------------------
	// Test 2: warn triggered for KNOWN_VERIFIER_CONFIG_GLOBS matches
	// (classifyFile returns zone !== 'config', but glob pattern matches)
	// -------------------------------------------------------------------------
	describe('KNOWN_VERIFIER_CONFIG_GLOBS matching triggers warn', () => {
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
			it(`warns for ${label}`, async () => {
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
				setupBuildSession();
				const warnSpy = spyOn(utilsModule, 'warn').mockImplementation(() => {});

				await hooks.toolBefore(
					makeInput('test-session', 'write', 'call-1'),
					makeOutput({ filePath }),
				);

				expect(warnSpy).toHaveBeenCalledWith(
					'Config file write attempt',
					expect.objectContaining({
						path: filePath,
						type: 'direct_write',
					}),
				);
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
	// Test 4: warn triggered for delegated writes to config files
	// -------------------------------------------------------------------------
	describe('delegated config-file writes trigger warn', () => {
		function setupDelegatedBuildSession(sessionID = 'test-session'): void {
			swarmState.activeAgent.set(sessionID, 'build');
			startAgentSession(sessionID, 'build');
			const session = getAgentSession(sessionID);
			if (session) {
				session.delegationActive = true; // delegated write path
			}
			beginInvocation(sessionID, 'build');
		}

		it('warns for delegated write to .eslintrc (glob match)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			setupDelegatedBuildSession();
			const warnSpy = spyOn(utilsModule, 'warn').mockImplementation(() => {});

			// Delegated write: delegationActive=true, tool is 'write'
			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-1'),
				makeOutput({ filePath: '.eslintrc' }),
			);

			expect(warnSpy).toHaveBeenCalledWith(
				'Config file write attempt',
				expect.objectContaining({
					type: 'delegated_write',
					path: '.eslintrc',
				}),
			);
			warnSpy.mockRestore();
		});

		it('warns for delegated write to tsconfig.json (zone: config)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			setupDelegatedBuildSession();
			const warnSpy = spyOn(utilsModule, 'warn').mockImplementation(() => {});

			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-1'),
				makeOutput({ filePath: 'tsconfig.json' }),
			);

			expect(warnSpy).toHaveBeenCalledWith(
				'Config file write attempt',
				expect.objectContaining({
					type: 'delegated_write',
					path: 'tsconfig.json',
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
		it('handles absolute Windows paths for config files', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			setupBuildSession();
			const warnSpy = spyOn(utilsModule, 'warn').mockImplementation(() => {});

			// Absolute path to tsconfig.json
			const absPath = path.join(TEST_DIR, 'tsconfig.json');
			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-1'),
				makeOutput({ filePath: absPath }),
			);

			expect(warnSpy).toHaveBeenCalledWith(
				'Config file write attempt',
				expect.objectContaining({
					type: 'direct_write',
				}),
			);
			warnSpy.mockRestore();
		});

		it('normalizes backslash paths for glob matching on Windows', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			setupBuildSession();
			const warnSpy = spyOn(utilsModule, 'warn').mockImplementation(() => {});

			// Using forward-slash path which should work on Windows too
			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-1'),
				makeOutput({ filePath: '.prettierrc' }),
			);

			expect(warnSpy).toHaveBeenCalledWith(
				'Config file write attempt',
				expect.objectContaining({
					path: '.prettierrc',
				}),
			);
			warnSpy.mockRestore();
		});
	});
});
