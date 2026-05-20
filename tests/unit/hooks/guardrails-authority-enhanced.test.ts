/**
 * Tests for enhanced file authority system
 *
 * Covers:
 * - normalizePathWithCache: cross-platform path normalization with caching
 * - getGlobMatcher: picomatch glob pattern matching with caching
 * - checkFileAuthorityWithRules: DENY-first authority evaluation
 * - checkFileAuthority: public API for authority checking
 * - Default agent authority rules
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	classifyFile,
	type FileZone,
} from '../../../src/context/zone-classifier';
import {
	type AuthorityConfig,
	checkFileAuthority,
	DEFAULT_AGENT_AUTHORITY_RULES,
} from '../../../src/hooks/guardrails';

const TEST_CWD = path.join(os.tmpdir(), 'test-project');

describe('normalizePathWithCache', () => {
	test('normalizes relative paths to absolute', () => {
		const result = checkFileAuthority('architect', 'src/index.ts', TEST_CWD);
		// Should return allowed: true (path exists and is allowed)
		expect(result.allowed).toBe(true);
	});

	test('architect blocks absolute paths outside cwd (containment)', () => {
		// Updated for the rule-level cwd containment check added after
		// removing coder.allowedPrefix (#496 final). Absolute paths outside
		// the working directory are rejected for every agent, including
		// architect, as defense-in-depth.
		const result = checkFileAuthority(
			'architect',
			'/home/user/project/src/index.ts',
			TEST_CWD,
		);
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.reason).toContain('resolves outside the working directory');
		}
	});

	test('architect blocks paths with .. segments that escape cwd (containment)', () => {
		// Updated for the rule-level cwd containment check. `../parent/file.ts`
		// resolves outside TEST_CWD and is rejected for every agent.
		const result = checkFileAuthority(
			'architect',
			'../parent/file.ts',
			TEST_CWD,
		);
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.reason).toContain('resolves outside the working directory');
		}
	});
});

describe('getGlobMatcher - via checkFileAuthority', () => {
	test('blockedGlobs blocks matching paths', () => {
		const authorityConfig: AuthorityConfig = {
			enabled: true,
			rules: {
				test_agent: {
					blockedGlobs: ['**/node_modules/**', '**/.git/**'],
				},
			},
		};

		const result = checkFileAuthority(
			'test_agent',
			'node_modules/package/index.js',
			TEST_CWD,
			authorityConfig,
		);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('blocked (glob');
	});

	test('allowedGlobs allows matching paths when otherwise blocked', () => {
		const authorityConfig: AuthorityConfig = {
			enabled: true,
			rules: {
				coder: {
					// Override to allow specific glob that would normally be blocked
					blockedPrefix: ['src/'],
					allowedGlobs: ['src/allowed/*'],
				},
			},
		};

		const result = checkFileAuthority(
			'coder',
			'src/allowed/file.ts',
			TEST_CWD,
			authorityConfig,
		);
		expect(result.allowed).toBe(true);
	});

	test('glob matching with wildcards', () => {
		const authorityConfig: AuthorityConfig = {
			enabled: true,
			rules: {
				test_agent: {
					blockedGlobs: ['*.test.ts', '*.spec.ts'],
				},
			},
		};

		// These should be blocked by glob pattern
		const blocked1 = checkFileAuthority(
			'test_agent',
			'foo.test.ts',
			TEST_CWD,
			authorityConfig,
		);
		expect(blocked1.allowed).toBe(false);

		const blocked2 = checkFileAuthority(
			'test_agent',
			'bar.spec.ts',
			TEST_CWD,
			authorityConfig,
		);
		expect(blocked2.allowed).toBe(false);

		// Non-matching should be allowed (no allowedPrefix = default allow)
		const allowed = checkFileAuthority(
			'test_agent',
			'foo.ts',
			TEST_CWD,
			authorityConfig,
		);
		expect(allowed.allowed).toBe(true);
	});

	test('glob caching works correctly', () => {
		const authorityConfig: AuthorityConfig = {
			enabled: true,
			rules: {
				test_agent: {
					blockedGlobs: ['node_modules/**'],
				},
			},
		};

		// Test that the same pattern produces consistent results
		const result1 = checkFileAuthority(
			'test_agent',
			'node_modules/foo/index.js',
			TEST_CWD,
			authorityConfig,
		);
		const result2 = checkFileAuthority(
			'test_agent',
			'node_modules/bar/index.js',
			TEST_CWD,
			authorityConfig,
		);

		// Both should be blocked (same glob pattern)
		expect(result1.allowed).toBe(false);
		expect(result2.allowed).toBe(false);
	});

	test('malformed blockedGlobs pattern does not crash and allows access', () => {
		const authorityConfig: AuthorityConfig = {
			enabled: true,
			rules: {
				test_agent: {
					blockedGlobs: ['[invalid(glob'], // unclosed bracket — picomatch throws
				},
			},
		};

		const result = checkFileAuthority(
			'test_agent',
			'any/path.ts',
			TEST_CWD,
			authorityConfig,
		);

		// malformed pattern compiles to () => false → never blocks → allowed
		expect(result.allowed).toBe(true);
		// Note: warn() only logs when OPENCODE_SWARM_DEBUG=1 (module-level gate)
		// The important behavior is that malformed patterns don't crash and allow access
	});
});

describe('checkFileAuthorityWithRules - DENY-first evaluation', () => {
	describe('Step 1: readOnly', () => {
		test('blocks all writes for read-only agents', () => {
			const result = checkFileAuthority('explorer', 'src/index.ts', TEST_CWD);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('read-only');
		});

		test('sme is read-only by default', () => {
			const result = checkFileAuthority('sme', 'src/index.ts', TEST_CWD);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('read-only');
		});
	});

	describe('Step 2: blockedExact', () => {
		test('architect blocked exact plan files', () => {
			const result = checkFileAuthority(
				'architect',
				'.swarm/plan.md',
				TEST_CWD,
			);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('blocked (exact)');
		});

		test('architect blocked exact plan.json', () => {
			const result = checkFileAuthority(
				'architect',
				'.swarm/plan.json',
				TEST_CWD,
			);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('blocked (exact)');
		});

		test('reviewer blocked exact plan files', () => {
			const result = checkFileAuthority('reviewer', '.swarm/plan.md', TEST_CWD);
			expect(result.allowed).toBe(false);
		});
	});

	describe('Step 3: blockedGlobs', () => {
		test('blocks paths matching blockedGlobs', () => {
			const authorityConfig: AuthorityConfig = {
				enabled: true,
				rules: {
					test_agent: {
						blockedGlobs: ['**/secrets/**', '**/credentials/*'],
					},
				},
			};

			const result = checkFileAuthority(
				'test_agent',
				'src/secrets/api-key.txt',
				TEST_CWD,
				authorityConfig,
			);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('blocked (glob');
		});
	});

	describe('Architect default blockedGlobs (#894)', () => {
		// v7.x (#894): architect has blockedGlobs for known verifier/linter config files
		// to prevent bypassing lint gates by editing config instead of fixing source.

		test('blocks oxlintrc (root level)', () => {
			const result = checkFileAuthority('architect', 'oxlintrc', TEST_CWD);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('blocked (glob');
		});

		test('blocks .oxlintrc (dotfile)', () => {
			const result = checkFileAuthority('architect', '.oxlintrc', TEST_CWD);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('blocked (glob');
		});

		test('blocks .eslintrc (any variant)', () => {
			const result = checkFileAuthority('architect', '.eslintrc', TEST_CWD);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('blocked (glob');
		});

		test('blocks .eslintrc.js (with extension)', () => {
			const result = checkFileAuthority('architect', '.eslintrc.js', TEST_CWD);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('blocked (glob');
		});

		test('blocks eslint.config.js (flat config)', () => {
			const result = checkFileAuthority(
				'architect',
				'eslint.config.js',
				TEST_CWD,
			);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('blocked (glob');
		});

		test('blocks eslint.config.mjs (ESM flat config)', () => {
			const result = checkFileAuthority(
				'architect',
				'eslint.config.mjs',
				TEST_CWD,
			);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('blocked (glob');
		});

		test('blocks .prettierrc (dotfile)', () => {
			const result = checkFileAuthority('architect', '.prettierrc', TEST_CWD);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('blocked (glob');
		});

		test('blocks .prettierrc.json (with format)', () => {
			const result = checkFileAuthority(
				'architect',
				'.prettierrc.json',
				TEST_CWD,
			);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('blocked (glob');
		});

		test('blocks biome.jsonc (biome config)', () => {
			const result = checkFileAuthority('architect', 'biome.jsonc', TEST_CWD);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('blocked (glob');
		});

		test('blocks .secretscanignore', () => {
			const result = checkFileAuthority(
				'architect',
				'.secretscanignore',
				TEST_CWD,
			);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('blocked (glob');
		});

		test('blocks .golangci.toml (golangci-lint toml config)', () => {
			const result = checkFileAuthority(
				'architect',
				'.golangci.toml',
				TEST_CWD,
			);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('blocked (glob');
		});

		test('blocks .golangci.yaml (golangci-lint yaml config)', () => {
			const result = checkFileAuthority(
				'architect',
				'.golangci.yaml',
				TEST_CWD,
			);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('blocked (glob');
		});

		test('blocks nested .eslintrc (e.g., in subdir/)', () => {
			const result = checkFileAuthority(
				'architect',
				'subdir/.eslintrc',
				TEST_CWD,
			);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('blocked (glob');
		});

		test('blocks eslint.config.js in subdir/', () => {
			const result = checkFileAuthority(
				'architect',
				'packages/eslint.config.js',
				TEST_CWD,
			);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('blocked (glob');
		});

		test('does NOT block biome.json (not biome.jsonc)', () => {
			// biome.json is NOT in the blockedGlobs; it's blocked by config zone instead
			// This test verifies the glob pattern specificity
			const result = checkFileAuthority('architect', 'biome.json', TEST_CWD);
			// Should still be blocked but by config zone, not glob
			expect(result.allowed).toBe(false);
			if (!result.allowed) {
				// Blocked by zone, not glob
				expect(result.reason).toContain('config');
			}
		});

		test('does NOT block regular source files (no overblocking)', () => {
			const result = checkFileAuthority('architect', 'src/app.ts', TEST_CWD);
			expect(result.allowed).toBe(true);
		});

		test('does NOT block test files (no overblocking)', () => {
			const result = checkFileAuthority(
				'architect',
				'tests/unit/app.test.ts',
				TEST_CWD,
			);
			expect(result.allowed).toBe(true);
		});

		test('does NOT block documentation files (no overblocking)', () => {
			const result = checkFileAuthority('architect', 'docs/guide.md', TEST_CWD);
			expect(result.allowed).toBe(true);
		});

		test('regression: architect still blocked from generated zone', () => {
			// Ensure we did not accidentally remove generated zone blocking
			const result = checkFileAuthority(
				'architect',
				'src/dist/bundle.js',
				TEST_CWD,
			);
			expect(result.allowed).toBe(false);
			if (!result.allowed) {
				expect(result.zone).toBe('generated');
			}
		});

		test('regression: coder still blocked from config zone', () => {
			// Ensure we did not accidentally affect coder's config zone blocking
			const result = checkFileAuthority('coder', 'package.json', TEST_CWD);
			expect(result.allowed).toBe(false);
			if (!result.allowed) {
				expect(result.zone).toBe('config');
			}
		});
	});

	describe('Step 4: allowedExact', () => {
		test('allows exact paths even if would be blocked by prefix', () => {
			const authorityConfig: AuthorityConfig = {
				enabled: true,
				rules: {
					coder: {
						blockedPrefix: ['src/'],
						allowedExact: ['src/specific-file.ts'],
					},
				},
			};

			const result = checkFileAuthority(
				'coder',
				'src/specific-file.ts',
				TEST_CWD,
				authorityConfig,
			);
			expect(result.allowed).toBe(true);
		});

		test('blockedExact takes precedence over allowedExact', () => {
			const authorityConfig: AuthorityConfig = {
				enabled: true,
				rules: {
					test_agent: {
						blockedExact: ['secret.txt'],
						allowedExact: ['secret.txt'],
					},
				},
			};

			const result = checkFileAuthority(
				'test_agent',
				'secret.txt',
				TEST_CWD,
				authorityConfig,
			);
			// blockedExact should take precedence (comes first in evaluation order)
			expect(result.allowed).toBe(false);
		});
	});

	describe('Step 5: allowedGlobs', () => {
		test('allows paths matching allowedGlobs even if blocked by prefix', () => {
			const authorityConfig: AuthorityConfig = {
				enabled: true,
				rules: {
					coder: {
						blockedPrefix: ['src/'],
						allowedGlobs: ['src/generated/*'],
					},
				},
			};

			const result = checkFileAuthority(
				'coder',
				'src/generated/file.ts',
				TEST_CWD,
				authorityConfig,
			);
			expect(result.allowed).toBe(true);
		});
	});

	describe('Step 6: allowedPrefix', () => {
		test('coder allowed prefix - src directory', () => {
			const result = checkFileAuthority('coder', 'src/index.ts', TEST_CWD);
			// Default coder has allowedPrefix: ['src/', 'tests/', ...]
			// Path should be allowed
			expect(result.allowed).toBe(true);
		});

		test('coder blocked by config zone', () => {
			const result = checkFileAuthority(
				'coder',
				'config/settings.json',
				TEST_CWD,
			);
			// Default coder no longer has allowedPrefix (#496) but still
			// blocks the config zone. config/settings.json is .json => config zone.
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('config zone');
		});

		test('test_engineer allowed prefix - tests directory', () => {
			const result = checkFileAuthority(
				'test_engineer',
				'tests/unit/example.test.ts',
				TEST_CWD,
			);
			expect(result.allowed).toBe(true);
		});
	});

	describe('Step 7: blockedPrefix', () => {
		test('coder blockedPrefix blocks .swarm/', () => {
			const result = checkFileAuthority('coder', '.swarm/state.json', TEST_CWD);
			// Coder still has blockedPrefix: ['.swarm/'] after #496.
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('Path blocked');
		});

		test('reviewer blockedPrefix blocks src directory', () => {
			const result = checkFileAuthority('reviewer', 'src/index.ts', TEST_CWD);
			// Reviewer default: allowedPrefix: ['.swarm/evidence/', '.swarm/outputs/']
			// So src/ should be blocked by blockedPrefix: ['src/']
			expect(result.allowed).toBe(false);
		});

		test('test_engineer blockedPrefix blocks src', () => {
			const result = checkFileAuthority(
				'test_engineer',
				'src/index.ts',
				TEST_CWD,
			);
			expect(result.allowed).toBe(false);
		});
	});

	describe('Step 8: blockedZones', () => {
		test('architect with explicit blocked zones - generated zone', () => {
			const authorityConfig: AuthorityConfig = {
				enabled: true,
				rules: {
					architect: {
						blockedZones: ['generated'],
					},
				},
			};

			// Test with a path that would be classified as generated
			const result = checkFileAuthority(
				'architect',
				'dist/bundle.js',
				TEST_CWD,
				authorityConfig,
			);
			// dist/ is typically in production zone, not generated
			// This depends on zone classification
			expect(result.allowed).toBe(true);
		});

		test('coder blocked config zone - opencode.json', () => {
			// Default coder has blockedZones: ['generated', 'config'].
			// After #496 coder no longer has allowedPrefix, so opencode.json
			// is blocked directly by the config-zone rule.
			const result = checkFileAuthority('coder', 'opencode.json', TEST_CWD);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('config zone');
		});

		test('zone check happens when path passes prefix checks', () => {
			// Create a config file that passes allowedPrefix
			const authorityConfig: AuthorityConfig = {
				enabled: true,
				rules: {
					coder: {
						allowedPrefix: ['src/', 'config/'],
						blockedZones: ['config'],
					},
				},
			};

			const result = checkFileAuthority(
				'coder',
				'config/settings.json',
				TEST_CWD,
				authorityConfig,
			);
			// Path passes prefix check but blocked by zone
			expect(result.allowed).toBe(false);
			expect(result.zone).toBe('config');
		});
	});

	describe('Priority: allowedExact over blockedGlobs', () => {
		test('blockedGlobs blocks before allowedExact check', () => {
			const authorityConfig: AuthorityConfig = {
				enabled: true,
				rules: {
					test_agent: {
						// No prefix rules, so it's allow-by-default
						blockedGlobs: ['**/*.log'],
						allowedExact: ['error.log'],
					},
				},
			};

			const result = checkFileAuthority(
				'test_agent',
				'error.log',
				TEST_CWD,
				authorityConfig,
			);
			// blockedGlobs blocks first, allowedExact is not checked for blocked paths
			// error.log matches **/*.log glob pattern
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('blocked (glob');
		});

		test('allowedExact works when not matched by blockedGlobs', () => {
			const authorityConfig: AuthorityConfig = {
				enabled: true,
				rules: {
					test_agent: {
						blockedGlobs: ['logs/*.log'],
						allowedExact: ['error.log'],
					},
				},
			};

			const result = checkFileAuthority(
				'test_agent',
				'error.log',
				TEST_CWD,
				authorityConfig,
			);
			// error.log does NOT match logs/*.log (not in logs/ directory)
			// so allowedExact allows it
			expect(result.allowed).toBe(true);
		});
	});

	describe('Priority: allowedGlobs over blockedPrefix', () => {
		test('allowedGlobs takes precedence over blockedPrefix', () => {
			const authorityConfig: AuthorityConfig = {
				enabled: true,
				rules: {
					test_agent: {
						blockedPrefix: ['src/'],
						allowedGlobs: ['src/special/*'],
					},
				},
			};

			const result = checkFileAuthority(
				'test_agent',
				'src/special/file.ts',
				TEST_CWD,
				authorityConfig,
			);
			// allowedGlobs should allow even though blockedPrefix would block
			expect(result.allowed).toBe(true);
		});
	});
});

describe('Rule merging with defaults', () => {
	test('merges user rules with defaults', () => {
		const authorityConfig: AuthorityConfig = {
			enabled: true,
			rules: {
				coder: {
					allowedExact: ['custom/path.txt'],
				},
			},
		};

		// Should have both custom and default properties
		// Test via authority check
		const result = checkFileAuthority(
			'coder',
			'custom/path.txt',
			TEST_CWD,
			authorityConfig,
		);
		expect(result.allowed).toBe(true);
	});

	test('user rules override defaults for new properties', () => {
		const authorityConfig: AuthorityConfig = {
			enabled: true,
			rules: {
				architect: {
					blockedExact: ['custom/blocked.txt'],
				},
			},
		};

		// Both custom and default should be present (merged)
		const result = checkFileAuthority(
			'architect',
			'custom/blocked.txt',
			TEST_CWD,
			authorityConfig,
		);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('blocked (exact)');
	});

	test('returns defaults when no rules provided', () => {
		const result = checkFileAuthority('architect', 'src/file.ts', TEST_CWD);
		// Architect should have default rules
		expect(result.allowed).toBe(true);
	});

	test('handles disabled authority', () => {
		const authorityConfig: AuthorityConfig = { enabled: false };
		// When disabled, should use defaults
		const result = checkFileAuthority(
			'architect',
			'src/file.ts',
			TEST_CWD,
			authorityConfig,
		);
		expect(result.allowed).toBe(true);
	});

	test('normalizes agent names to lowercase', () => {
		const authorityConfig: AuthorityConfig = {
			enabled: true,
			rules: {
				CODER: {
					allowedExact: ['test.txt'],
				},
			},
		};

		// lowercase version should work
		const result = checkFileAuthority(
			'coder',
			'test.txt',
			TEST_CWD,
			authorityConfig,
		);
		expect(result.allowed).toBe(true);
	});
});

describe('DEFAULT_AGENT_AUTHORITY_RULES', () => {
	test('architect has correct defaults', () => {
		const rules = DEFAULT_AGENT_AUTHORITY_RULES;
		expect(rules.architect.blockedExact).toEqual([
			'.swarm/plan.md',
			'.swarm/plan.json',
		]);
		expect(rules.architect.blockedZones).toContain('generated');
	});

	test('coder has correct defaults', () => {
		const rules = DEFAULT_AGENT_AUTHORITY_RULES;
		expect(rules.coder.blockedPrefix).toContain('.swarm/');
		// #496: coder no longer ships with a language-specific allowedPrefix
		// whitelist. Writes are constrained by DENY rules only.
		expect(rules.coder.allowedPrefix).toBeUndefined();
		expect(rules.coder.blockedZones).toContain('generated');
		expect(rules.coder.blockedZones).toContain('config');
	});

	test('explorer is read-only', () => {
		const rules = DEFAULT_AGENT_AUTHORITY_RULES;
		expect(rules.explorer.readOnly).toBe(true);
	});

	test('test_engineer has correct defaults', () => {
		const rules = DEFAULT_AGENT_AUTHORITY_RULES;
		expect(rules.test_engineer.blockedExact).toContain('.swarm/plan.md');
		expect(rules.test_engineer.allowedPrefix).toContain('tests/');
		expect(rules.test_engineer.blockedPrefix).toContain('src/');
	});
});

describe('Cross-platform path handling', () => {
	test('handles Windows-style paths', () => {
		// Test with Windows-style separators (should be normalized)
		const result = checkFileAuthority('architect', 'src\\index.ts', TEST_CWD);
		// Should be normalized and allowed (architect has no prefix restrictions)
		expect(result.allowed).toBe(true);
	});

	test('handles mixed separators', () => {
		const result = checkFileAuthority('coder', 'src/subdir\\file.ts', TEST_CWD);
		// Path should be normalized
		expect(result.allowed).toBe(true);
	});
});

describe('Edge cases', () => {
	test('returns unknown agent for unrecognized agents', () => {
		const result = checkFileAuthority('unknown_agent', 'src/file.ts', TEST_CWD);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('Unknown agent');
	});

	test('empty file path is allowed for architect (no prefix restrictions)', () => {
		const result = checkFileAuthority('architect', '', TEST_CWD);
		// Architect has no prefix restrictions, empty path is allowed
		expect(result.allowed).toBe(true);
	});

	test('allows path with no rules configured - default allow', () => {
		const authorityConfig: AuthorityConfig = {
			enabled: true,
			rules: {
				new_agent: {},
			},
		};

		const result = checkFileAuthority(
			'new_agent',
			'any/path.txt',
			TEST_CWD,
			authorityConfig,
		);
		// Empty rules means no restrictions, so allow by default
		expect(result.allowed).toBe(true);
	});

	test('empty allowedPrefix blocks all paths', () => {
		const authorityConfig: AuthorityConfig = {
			enabled: true,
			rules: {
				test_agent: {
					allowedPrefix: [],
				},
			},
		};

		const result = checkFileAuthority(
			'test_agent',
			'src/file.ts',
			TEST_CWD,
			authorityConfig,
		);
		// Empty allowedPrefix array means nothing is allowed
		expect(result.allowed).toBe(false);
	});
});

describe('Security: path traversal protection', () => {
	test('architect blocks .. paths that escape cwd (containment)', () => {
		// Updated for the rule-level cwd containment check added after
		// removing coder.allowedPrefix (#496 final). `../../../etc/passwd`
		// resolves outside TEST_CWD and is rejected for every agent.
		const result = checkFileAuthority(
			'architect',
			'../../../etc/passwd',
			TEST_CWD,
		);
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.reason).toContain('resolves outside the working directory');
		}
	});

	test('coder blocks absolute paths outside project (containment)', () => {
		// After #496 coder no longer has allowedPrefix. The defense-in-depth
		// rule-level containment check rejects paths whose normalized
		// location escapes cwd — so `/etc/passwd` is blocked explicitly by
		// the rule layer (no longer relying on the hook-level lstat guard).
		const result = checkFileAuthority('coder', '/etc/passwd', TEST_CWD);
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.reason).toContain('resolves outside the working directory');
		}
	});
});

describe('Classification integration', () => {
	test('classifyFile returns object with zone property', () => {
		const result = classifyFile('package.json');
		// classifyFile returns an object with zone property
		expect(result.zone).toBe('config');
	});

	test('classifyFile identifies source files', () => {
		const result = classifyFile('src/index.ts');
		// src/ is typically classified as production zone
		expect(result.zone).toBe('production');
	});

	test('classifyFile identifies config files', () => {
		const result = classifyFile('tsconfig.json');
		expect(result.zone).toBe('config');
	});
});
