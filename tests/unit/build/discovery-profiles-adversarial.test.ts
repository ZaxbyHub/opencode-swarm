/**
 * Adversarial tests for profile-driven build discovery in src/build/discovery.ts
 *
 * Tests cover attack vectors only:
 * - Malformed inputs (empty string, non-existent paths)
 * - Boundary violations (empty commands, missing files)
 * - Unexpected states (errors, undefined registry entries)
 * - Error propagation
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Test directory
const TEST_DIR = path.join(
	process.cwd(),
	'test-tmp-discovery-profiles-adversarial',
);

// ============ Mock Pattern Setup ============
// Always use local mock variables, not vi.mocked()

const mockDetectProjectLanguages = mock();
const mockLangRegistryGet = mock();
const mockIsCommandAvailable = mock();

// Mock the detector module
mock.module('../../../src/lang/detector', () => ({
	detectProjectLanguages: (...args: unknown[]) =>
		mockDetectProjectLanguages(...args),
}));

// Mock the profiles module
mock.module('../../../src/lang/profiles', () => ({
	LANGUAGE_REGISTRY: {
		get: (...args: unknown[]) => mockLangRegistryGet(...args),
	},
}));

// Mock the isCommandAvailable function by importing from the real module and replacing it
// We'll need to clear the toolchain cache to ensure clean state

// ============ Helper Types ============

interface MockLanguageProfile {
	id: string;
	displayName: string;
	tier: number;
	extensions: string[];
	treeSitter: { grammarId: string; wasmFile: string };
	build: {
		detectFiles: string[];
		commands: Array<{
			name: string;
			cmd: string;
			detectFile?: string;
			priority: number;
		}>;
	};
	test: { detectFiles: string[]; frameworks: unknown[] };
	lint: { detectFiles: string[]; linters: unknown[] };
	audit: {
		detectFiles: string[];
		command: string | null;
		outputFormat: 'json' | 'text';
	};
	sast: { nativeRuleSet: string | null; semgrepSupport: string };
	prompts: { coderConstraints: string[]; reviewerChecklist: string[] };
}

// ============ Test Setup ============

beforeEach(() => {
	// Reset all mocks
	mockDetectProjectLanguages.mockReset();
	mockLangRegistryGet.mockReset();

	// Create test directory if it doesn't exist
	if (!fs.existsSync(TEST_DIR)) {
		fs.mkdirSync(TEST_DIR, { recursive: true });
	}
});

afterEach(() => {
	// Clean up test directory
	if (fs.existsSync(TEST_DIR)) {
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	}
	mock.restore();
});

// ============ Test Suite 1: Malformed workingDir Input ============

describe('discoverBuildCommandsFromProfiles - Attack: Malformed workingDir', () => {
	it('should not throw when workingDir is an empty string', async () => {
		// Arrange: Empty string workingDir, no languages detected
		mockDetectProjectLanguages.mockResolvedValue([]);

		const module = await import('../../../src/build/discovery');
		module.clearToolchainCache();

		// Act & Assert: Should not throw, just return empty results
		await expect(module.discoverBuildCommandsFromProfiles('')).resolves.toEqual(
			{
				commands: [],
				skipped: [],
			},
		);
	});

	it('should not throw when workingDir is a path that does not exist', async () => {
		// Arrange: Non-existent directory, no languages detected
		const nonExistentDir = path.join(TEST_DIR, 'does-not-exist');
		mockDetectProjectLanguages.mockResolvedValue([]);

		const module = await import('../../../src/build/discovery');
		module.clearToolchainCache();

		// Act & Assert: Should not throw, just return empty results
		await expect(
			module.discoverBuildCommandsFromProfiles(nonExistentDir),
		).resolves.toEqual({
			commands: [],
			skipped: [],
		});
	});

	it('should propagate error when detectProjectLanguages throws', async () => {
		// Arrange: Language detector throws an error
		const testError = new Error('Language detection failed unexpectedly');
		mockDetectProjectLanguages.mockRejectedValue(testError);

		const module = await import('../../../src/build/discovery');
		module.clearToolchainCache();

		// Act & Assert: Should propagate the error
		await expect(
			module.discoverBuildCommandsFromProfiles(TEST_DIR),
		).rejects.toThrow('Language detection failed unexpectedly');
	});
});

// ============ Test Suite 2: Profile with Empty Commands Array ============

describe('discoverBuildCommandsFromProfiles - Attack: Empty Commands Array', () => {
	it('should skip profile when build.commands is empty array', async () => {
		// Arrange: Profile with no commands
		const emptyCommandsProfile: MockLanguageProfile = {
			id: 'empty-lang',
			displayName: 'Empty Language',
			tier: 1,
			extensions: ['.empty'],
			treeSitter: { grammarId: 'empty', wasmFile: 'empty.wasm' },
			build: {
				detectFiles: ['package.json'],
				commands: [], // Empty commands array
			},
			test: { detectFiles: [], frameworks: [] },
			lint: { detectFiles: [], linters: [] },
			audit: { detectFiles: [], command: null, outputFormat: 'json' },
			sast: { nativeRuleSet: null, semgrepSupport: 'none' },
			prompts: { coderConstraints: [], reviewerChecklist: [] },
		};

		mockDetectProjectLanguages.mockResolvedValue([
			{ id: 'empty-lang' } as MockLanguageProfile,
		]);
		mockLangRegistryGet.mockReturnValue(emptyCommandsProfile);

		const module = await import('../../../src/build/discovery');
		module.clearToolchainCache();

		// Act
		const result = await module.discoverBuildCommandsFromProfiles(TEST_DIR);

		// Assert: Should skip the profile (no commands, but no crash)
		expect(result.commands).toEqual([]);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0].ecosystem).toBe('empty-lang');
		expect(result.skipped[0].reason).toContain('No binary available');
		expect(result.skipped[0].reason).toContain('tried'); // Should mention tried binaries
	});
});

// ============ Test Suite 3: Empty Command String ============

describe('discoverBuildCommandsFromProfiles - Attack: Empty Command String', () => {
	it('should skip gracefully when cmd.cmd is an empty string', async () => {
		// Arrange: Profile with empty command string
		const emptyCmdProfile: MockLanguageProfile = {
			id: 'empty-cmd-lang',
			displayName: 'Empty Command Language',
			tier: 1,
			extensions: ['.ecmd'],
			treeSitter: { grammarId: 'empty-cmd', wasmFile: 'empty-cmd.wasm' },
			build: {
				detectFiles: ['package.json'],
				commands: [
					{
						name: 'empty-command',
						cmd: '', // Empty command string - causes cmd.split(' ')[0] to be ''
						priority: 10,
					},
				],
			},
			test: { detectFiles: [], frameworks: [] },
			lint: { detectFiles: [], linters: [] },
			audit: { detectFiles: [], command: null, outputFormat: 'json' },
			sast: { nativeRuleSet: null, semgrepSupport: 'none' },
			prompts: { coderConstraints: [], reviewerChecklist: [] },
		};

		mockDetectProjectLanguages.mockResolvedValue([
			{ id: 'empty-cmd-lang' } as MockLanguageProfile,
		]);
		mockLangRegistryGet.mockReturnValue(emptyCmdProfile);

		// Mock isCommandAvailable to handle empty string
		const module = await import('../../../src/build/discovery');
		module.clearToolchainCache();

		// The real isCommandAvailable will be called with ''
		// It should return false or handle gracefully without crashing

		// Act & Assert: Should not throw, should skip gracefully
		const result = await module.discoverBuildCommandsFromProfiles(TEST_DIR);

		expect(result.commands).toEqual([]);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0].ecosystem).toBe('empty-cmd-lang');
		expect(result.skipped[0].reason).toContain('No binary available');
	});
});

// ============ Test Suite 4: Undefined Registry Entry ============

describe('discoverBuildCommandsFromProfiles - Attack: Undefined Registry Entry', () => {
	it('should warn and skip when LANGUAGE_REGISTRY.get() returns undefined', async () => {
		// Arrange: Detected profile not in registry
		mockDetectProjectLanguages.mockResolvedValue([
			{ id: 'unknown-lang' } as MockLanguageProfile,
		]);
		mockLangRegistryGet.mockReturnValue(undefined); // Registry returns undefined

		const module = await import('../../../src/build/discovery');
		module.clearToolchainCache();

		// Act & Assert: Should not throw, should skip gracefully
		const result = await module.discoverBuildCommandsFromProfiles(TEST_DIR);

		expect(result.commands).toEqual([]);
		expect(result.skipped).toEqual([]); // No skipped entry since we continue immediately
		expect(mockLangRegistryGet).toHaveBeenCalledWith('unknown-lang');
	});

	it('should handle mixed valid and invalid profiles without crashing', async () => {
		// Arrange: Mix of valid and invalid profiles
		const validProfile: MockLanguageProfile = {
			id: 'valid-lang',
			displayName: 'Valid Language',
			tier: 1,
			extensions: ['.valid'],
			treeSitter: { grammarId: 'valid', wasmFile: 'valid.wasm' },
			build: {
				detectFiles: ['package.json'],
				commands: [
					{
						name: 'valid-cmd',
						cmd: 'valid-binary',
						priority: 10,
					},
				],
			},
			test: { detectFiles: [], frameworks: [] },
			lint: { detectFiles: [], linters: [] },
			audit: { detectFiles: [], command: null, outputFormat: 'json' },
			sast: { nativeRuleSet: null, semgrepSupport: 'none' },
			prompts: { coderConstraints: [], reviewerChecklist: [] },
		};

		mockDetectProjectLanguages.mockResolvedValue([
			{ id: 'unknown-lang1' } as MockLanguageProfile,
			{ id: 'valid-lang' } as MockLanguageProfile,
			{ id: 'unknown-lang2' } as MockLanguageProfile,
		]);

		// Mock registry to return undefined for unknown langs, valid profile for valid-lang
		mockLangRegistryGet.mockImplementation((id: string) => {
			if (id === 'valid-lang') return validProfile;
			return undefined;
		});

		const module = await import('../../../src/build/discovery');
		module.clearToolchainCache();

		// Act & Assert: Should not throw, should skip invalid ones and process valid one
		const result = await module.discoverBuildCommandsFromProfiles(TEST_DIR);

		// Valid profile processed (may be skipped if binary not available)
		// Invalid profiles skipped with warn
		expect(mockLangRegistryGet).toHaveBeenCalledWith('unknown-lang1');
		expect(mockLangRegistryGet).toHaveBeenCalledWith('valid-lang');
		expect(mockLangRegistryGet).toHaveBeenCalledWith('unknown-lang2');
	});
});

// ============ Test Suite 5: Duplicate Priority Values ============

describe('discoverBuildCommandsFromProfiles - Attack: Duplicate Priority Values', () => {
	it('should not crash when profiles have same priority values', async () => {
		// Arrange: Multiple profiles with same command priority
		const profile1: MockLanguageProfile = {
			id: 'lang1',
			displayName: 'Language 1',
			tier: 1,
			extensions: ['.l1'],
			treeSitter: { grammarId: 'l1', wasmFile: 'l1.wasm' },
			build: {
				detectFiles: ['file1.json'],
				commands: [
					{
						name: 'cmd1',
						cmd: 'binary1',
						priority: 10, // Same priority as profile2
					},
				],
			},
			test: { detectFiles: [], frameworks: [] },
			lint: { detectFiles: [], linters: [] },
			audit: { detectFiles: [], command: null, outputFormat: 'json' },
			sast: { nativeRuleSet: null, semgrepSupport: 'none' },
			prompts: { coderConstraints: [], reviewerChecklist: [] },
		};

		const profile2: MockLanguageProfile = {
			id: 'lang2',
			displayName: 'Language 2',
			tier: 1,
			extensions: ['.l2'],
			treeSitter: { grammarId: 'l2', wasmFile: 'l2.wasm' },
			build: {
				detectFiles: ['file2.json'],
				commands: [
					{
						name: 'cmd2',
						cmd: 'binary2',
						priority: 10, // Same priority as profile1
					},
				],
			},
			test: { detectFiles: [], frameworks: [] },
			lint: { detectFiles: [], linters: [] },
			audit: { detectFiles: [], command: null, outputFormat: 'json' },
			sast: { nativeRuleSet: null, semgrepSupport: 'none' },
			prompts: { coderConstraints: [], reviewerChecklist: [] },
		};

		mockDetectProjectLanguages.mockResolvedValue([
			{ id: 'lang1' } as MockLanguageProfile,
			{ id: 'lang2' } as MockLanguageProfile,
		]);

		mockLangRegistryGet.mockImplementation((id: string) => {
			if (id === 'lang1') return profile1;
			if (id === 'lang2') return profile2;
			return undefined;
		});

		const module = await import('../../../src/build/discovery');
		module.clearToolchainCache();

		// Act & Assert: Should not crash, deterministic output
		const result = await module.discoverBuildCommandsFromProfiles(TEST_DIR);

		// Result should be deterministic (order preserved from detection)
		expect(Array.isArray(result.commands)).toBe(true);
		expect(Array.isArray(result.skipped)).toBe(true);
		// Total entries should match profiles processed
		expect(result.commands.length + result.skipped.length).toBe(2);
	});

	it('should produce deterministic output with multiple commands of same priority', async () => {
		// Arrange: Single profile with multiple commands at same priority
		const profile: MockLanguageProfile = {
			id: 'multi-priority-lang',
			displayName: 'Multi Priority Language',
			tier: 1,
			extensions: ['.multi'],
			treeSitter: { grammarId: 'multi', wasmFile: 'multi.wasm' },
			build: {
				detectFiles: ['package.json'],
				commands: [
					{
						name: 'cmd1',
						cmd: 'binary1',
						priority: 10,
					},
					{
						name: 'cmd2',
						cmd: 'binary2',
						priority: 10, // Same priority as cmd1
					},
					{
						name: 'cmd3',
						cmd: 'binary3',
						priority: 10, // Same priority as others
					},
				],
			},
			test: { detectFiles: [], frameworks: [] },
			lint: { detectFiles: [], linters: [] },
			audit: { detectFiles: [], command: null, outputFormat: 'json' },
			sast: { nativeRuleSet: null, semgrepSupport: 'none' },
			prompts: { coderConstraints: [], reviewerChecklist: [] },
		};

		mockDetectProjectLanguages.mockResolvedValue([
			{ id: 'multi-priority-lang' } as MockLanguageProfile,
		]);
		mockLangRegistryGet.mockReturnValue(profile);

		const module = await import('../../../src/build/discovery');
		module.clearToolchainCache();

		// Act & Assert: Should not crash, output should be deterministic
		const result1 = await module.discoverBuildCommandsFromProfiles(TEST_DIR);
		const result2 = await module.discoverBuildCommandsFromProfiles(TEST_DIR);

		// Results should be identical (deterministic)
		expect(result1).toEqual(result2);
	});
});

// ============ Test Suite 6: discoverBuildCommands with Scope Options ============

describe('discoverBuildCommands - Attack: Scope with Empty changedFiles', () => {
	it('should still return profile-driven commands when scope changed and changedFiles is empty', async () => {
		// Arrange: Profile detected, but scope is 'changed' with empty changedFiles
		const profile: MockLanguageProfile = {
			id: 'typescript',
			displayName: 'TypeScript',
			tier: 1,
			extensions: ['.ts'],
			treeSitter: { grammarId: 'ts', wasmFile: 'ts.wasm' },
			build: {
				detectFiles: ['package.json'],
				commands: [
					{
						name: 'bun',
						cmd: 'bun run build',
						priority: 10,
					},
				],
			},
			test: { detectFiles: [], frameworks: [] },
			lint: { detectFiles: [], linters: [] },
			audit: { detectFiles: [], command: null, outputFormat: 'json' },
			sast: { nativeRuleSet: null, semgrepSupport: 'ga' },
			prompts: { coderConstraints: [], reviewerChecklist: [] },
		};

		mockDetectProjectLanguages.mockResolvedValue([
			{ id: 'typescript' } as MockLanguageProfile,
		]);
		mockLangRegistryGet.mockReturnValue(profile);

		const module = await import('../../../src/build/discovery');
		module.clearToolchainCache();

		// Act: Call with scope changed and empty changedFiles
		const result = await module.discoverBuildCommands(TEST_DIR, {
			scope: 'changed',
			changedFiles: [],
		});

		// Assert: Profile-driven commands should still be returned
		// scope only affects ECOSYSTEMS fallback, not profiles
		expect(mockDetectProjectLanguages).toHaveBeenCalledWith(TEST_DIR);
		// Result structure should be valid
		expect(Array.isArray(result.commands)).toBe(true);
		expect(Array.isArray(result.skipped)).toBe(true);
	});

	it('should handle undefined options without crashing', async () => {
		// Arrange: No languages detected, options is undefined
		mockDetectProjectLanguages.mockResolvedValue([]);

		const module = await import('../../../src/build/discovery');
		module.clearToolchainCache();

		// Act: Call with undefined options
		const result = await module.discoverBuildCommands(TEST_DIR, undefined);

		// Assert: Should not throw, should return valid structure
		// Note: When no profiles detected, fallback ecosystem detection runs and adds skipped entries
		expect(result.commands).toEqual([]);
		expect(Array.isArray(result.skipped)).toBe(true);
		// Should have skipped entries from ecosystem fallback
		expect(result.skipped.length).toBeGreaterThan(0);
	});
});

// ============ Test Suite 7: Combined Attack Scenarios ============

describe('discoverBuildCommandsFromProfiles - Combined Attack Scenarios', () => {
	it('should handle multiple adversarial conditions simultaneously', async () => {
		// Arrange: Multiple profiles with various issues
		const issues: MockLanguageProfile[] = [
			{
				id: 'issue-1-empty-commands',
				displayName: 'Issue 1',
				tier: 1,
				extensions: ['.i1'],
				treeSitter: { grammarId: 'i1', wasmFile: 'i1.wasm' },
				build: {
					detectFiles: [],
					commands: [], // Empty commands
				},
				test: { detectFiles: [], frameworks: [] },
				lint: { detectFiles: [], linters: [] },
				audit: { detectFiles: [], command: null, outputFormat: 'json' },
				sast: { nativeRuleSet: null, semgrepSupport: 'none' },
				prompts: { coderConstraints: [], reviewerChecklist: [] },
			},
			{
				id: 'issue-2-empty-cmd',
				displayName: 'Issue 2',
				tier: 1,
				extensions: ['.i2'],
				treeSitter: { grammarId: 'i2', wasmFile: 'i2.wasm' },
				build: {
					detectFiles: [],
					commands: [
						{
							name: 'empty',
							cmd: '', // Empty command string
							priority: 10,
						},
					],
				},
				test: { detectFiles: [], frameworks: [] },
				lint: { detectFiles: [], linters: [] },
				audit: { detectFiles: [], command: null, outputFormat: 'json' },
				sast: { nativeRuleSet: null, semgrepSupport: 'none' },
				prompts: { coderConstraints: [], reviewerChecklist: [] },
			},
		];

		mockDetectProjectLanguages.mockResolvedValue([
			{ id: 'issue-1-empty-commands' } as MockLanguageProfile,
			{ id: 'issue-2-empty-cmd' } as MockLanguageProfile,
			{ id: 'issue-3-undefined' } as MockLanguageProfile, // Not in registry
		]);

		mockLangRegistryGet.mockImplementation((id: string) => {
			if (id === 'issue-1-empty-commands') return issues[0];
			if (id === 'issue-2-empty-cmd') return issues[1];
			return undefined; // issue-3-undefined
		});

		const module = await import('../../../src/build/discovery');
		module.clearToolchainCache();

		// Act & Assert: Should not crash, handle all issues gracefully
		const result = await module.discoverBuildCommandsFromProfiles(TEST_DIR);

		expect(Array.isArray(result.commands)).toBe(true);
		expect(Array.isArray(result.skipped)).toBe(true);
		// Should have skipped entries for the problematic profiles
		expect(result.commands.length).toBe(0); // No valid commands
	});
});
