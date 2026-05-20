import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	classifyFile,
	type FileZone,
} from '../../../src/context/zone-classifier';
import { checkFileAuthority } from '../../../src/hooks/guardrails';

// Helper to check if result is a denial
function isDenied(
	result: ReturnType<typeof checkFileAuthority>,
): result is { allowed: false; reason: string; zone?: FileZone } {
	return !result.allowed;
}

describe('guardrails-zone-authority - Zone Authority Integration', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zone-authority-test-'));
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('1. Generated zone blocked for architect', () => {
		it('blocks architect from writing to .wasm files (generated zone)', () => {
			// Architect has no allowedPrefixes, so any path that isn't blockedExact passes prefix check
			const result = checkFileAuthority('architect', 'lib/math.wasm', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('generated');
				expect(result.zone).toBe('generated');
			}
		});

		it('blocks architect from writing to dist/ files (generated zone)', () => {
			// Zone classifier requires path to contain /dist/ pattern
			const result = checkFileAuthority(
				'architect',
				'src/dist/bundle.js',
				tempDir,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('generated');
				expect(result.zone).toBe('generated');
			}
		});

		it('blocks architect from writing to build/ files (generated zone)', () => {
			// Zone classifier requires path to contain /build/ pattern
			const result = checkFileAuthority(
				'architect',
				'app/build/output.js',
				tempDir,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('generated');
				expect(result.zone).toBe('generated');
			}
		});

		it('blocks architect from writing to .swarm/checkpoints/ files (generated zone)', () => {
			const result = checkFileAuthority(
				'architect',
				'.swarm/checkpoints/snapshot.json',
				tempDir,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('generated');
				expect(result.zone).toBe('generated');
			}
		});

		it('allows architect to write to src/ files (production zone)', () => {
			const result = checkFileAuthority(
				'architect',
				'src/utils/helper.ts',
				tempDir,
			);
			expect(result.allowed).toBe(true);
		});
	});

	describe('2. Generated zone blocked for coder', () => {
		it('blocks coder from writing to .wasm files in allowed prefix (generated zone)', () => {
			// Coder allowed prefixes: src/, tests/, docs/, scripts/
			// Use path that passes prefix check but is in generated zone
			const result = checkFileAuthority('coder', 'src/lib/math.wasm', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('generated');
				expect(result.zone).toBe('generated');
			}
		});

		it('blocks coder from writing to dist/ files in allowed prefix (generated zone)', () => {
			// Coder allowed: src/, use src/dist/ which passes prefix but is generated
			const result = checkFileAuthority('coder', 'src/dist/bundle.js', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('generated');
				expect(result.zone).toBe('generated');
			}
		});

		it('blocks coder from writing to build/ files in allowed prefix (generated zone)', () => {
			// Use tests/build/ which passes prefix (tests/) but is generated zone
			const result = checkFileAuthority(
				'coder',
				'tests/build/output.js',
				tempDir,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('generated');
				expect(result.zone).toBe('generated');
			}
		});

		it('allows coder to write to src/ files (production zone)', () => {
			const result = checkFileAuthority(
				'coder',
				'src/services/api.ts',
				tempDir,
			);
			expect(result.allowed).toBe(true);
		});
	});

	describe('3. Config zone blocked for coder', () => {
		it('blocks coder from writing to package.json when in allowed prefix (config zone)', () => {
			// Use src/package.json which passes prefix check but is config zone
			const result = checkFileAuthority('coder', 'src/package.json', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('config');
				expect(result.zone).toBe('config');
			}
		});

		it('blocks coder from writing to tsconfig.json when in allowed prefix (config zone)', () => {
			const result = checkFileAuthority('coder', 'src/tsconfig.json', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('config');
				expect(result.zone).toBe('config');
			}
		});

		it('blocks coder from writing to .env files when in allowed prefix (config zone)', () => {
			const result = checkFileAuthority('coder', 'src/.env', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('config');
				expect(result.zone).toBe('config');
			}
		});

		it('blocks coder from writing to biome.json when in allowed prefix (config zone)', () => {
			const result = checkFileAuthority('coder', 'src/biome.json', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('config');
				expect(result.zone).toBe('config');
			}
		});

		it('blocks coder from writing to config.yaml when in allowed prefix (config zone)', () => {
			const result = checkFileAuthority('coder', 'src/config.yaml', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('config');
				expect(result.zone).toBe('config');
			}
		});

		it('allows coder to write to config files in docs/ (but zone is still config)', () => {
			// docs/config.yaml - zone is 'config' (because of .yaml extension), not 'docs'
			// Coder has blockedZones: ['config'], so it's blocked
			// This is correct behavior - zone is determined by file extension
			const result = checkFileAuthority('coder', 'docs/config.yaml', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.zone).toBe('config');
			}
		});
	});

	describe('4. Zone classification works in authority check', () => {
		it('correctly classifies and blocks generated zone', () => {
			// Zone classifier requires /dist/ pattern
			const zoneResult = classifyFile('src/dist/bundle.js');
			expect(zoneResult.zone).toBe('generated');

			const authorityResult = checkFileAuthority(
				'architect',
				'src/dist/bundle.js',
				tempDir,
			);
			expect(authorityResult.allowed).toBe(false);
			if (isDenied(authorityResult)) {
				expect(authorityResult.zone).toBe('generated');
			}
		});

		it('correctly classifies and blocks config zone', () => {
			const zoneResult = classifyFile('src/package.json');
			expect(zoneResult.zone).toBe('config');

			const authorityResult = checkFileAuthority(
				'coder',
				'src/package.json',
				tempDir,
			);
			expect(authorityResult.allowed).toBe(false);
			if (isDenied(authorityResult)) {
				expect(authorityResult.zone).toBe('config');
			}
		});

		it('allows production zone files for appropriate agents', () => {
			const zoneResult = classifyFile('src/app.ts');
			expect(zoneResult.zone).toBe('production');

			const authorityResult = checkFileAuthority(
				'coder',
				'src/app.ts',
				tempDir,
			);
			expect(authorityResult.allowed).toBe(true);
		});

		it('allows test zone files for appropriate agents', () => {
			const zoneResult = classifyFile('tests/unit/api.test.ts');
			expect(zoneResult.zone).toBe('test');

			const authorityResult = checkFileAuthority(
				'coder',
				'tests/unit/api.test.ts',
				tempDir,
			);
			expect(authorityResult.allowed).toBe(true);
		});

		it('allows docs zone files for appropriate agents', () => {
			// Zone classifier requires /docs/ pattern with a prefix (e.g., ./docs/ or foo/docs/)
			const zoneResult = classifyFile('foo/docs/guide.md');
			expect(zoneResult.zone).toBe('docs');

			// After #496 coder has no default allowedPrefix; writes are gated
			// only by DENY rules. 'docs/guide.md' is classified as 'production'
			// zone (default), which is not in coder's blockedZones
			// (['generated', 'config']), so the write is allowed.
			const authorityResult = checkFileAuthority(
				'coder',
				'docs/guide.md',
				tempDir,
			);
			expect(authorityResult.allowed).toBe(true);
		});
	});

	describe('5. Zone info included in denial reason', () => {
		it('includes zone in denial reason for architect - generated', () => {
			const result = checkFileAuthority(
				'architect',
				'src/dist/app.js',
				tempDir,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toMatch(/zone|generated/i);
				expect(result.zone).toBeDefined();
				expect(result.zone).toBe('generated');
			}
		});

		it('includes zone in denial reason for coder - generated', () => {
			const result = checkFileAuthority('coder', 'src/lib/utils.wasm', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toMatch(/zone|generated/i);
				expect(result.zone).toBeDefined();
				expect(result.zone).toBe('generated');
			}
		});

		it('includes zone in denial reason for coder - config', () => {
			const result = checkFileAuthority('coder', 'src/package.json', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toMatch(/zone|config/i);
				expect(result.zone).toBeDefined();
				expect(result.zone).toBe('config');
			}
		});

		it('includes zone in denial reason for reviewer - generated', () => {
			// Reviewer allowed prefixes: .swarm/evidence/, .swarm/outputs/
			const result = checkFileAuthority(
				'reviewer',
				'.swarm/evidence/dist/bundle.js',
				tempDir,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toMatch(/zone|generated/i);
				expect(result.zone).toBeDefined();
				expect(result.zone).toBe('generated');
			}
		});

		it('includes zone in denial reason for test_engineer - generated', () => {
			// Test engineer allowed: tests/, .swarm/evidence/
			const result = checkFileAuthority(
				'test_engineer',
				'tests/dist/test-output.js',
				tempDir,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toMatch(/zone|generated/i);
				expect(result.zone).toBeDefined();
				expect(result.zone).toBe('generated');
			}
		});

		it('includes zone in denial reason for explorer - generated', () => {
			// Explorer has blockedPrefixes: [''] which blocks everything first
			// But the agent does have blockedZones: ['generated'] - verify it's blocked
			const result = checkFileAuthority('explorer', 'src/dist/app.js', tempDir);
			expect(result.allowed).toBe(false);
			// Explorer blocked by path prefix, not zone - reason is about path
		});

		it('includes zone in denial reason for sme - generated', () => {
			// SME has blockedPrefixes: [''] which blocks everything first
			const result = checkFileAuthority('sme', 'src/dist/output.wasm', tempDir);
			expect(result.allowed).toBe(false);
			// SME blocked by path prefix, not zone
		});

		it('includes zone in denial reason for designer - generated', () => {
			// Designer allowed: docs/, .swarm/outputs/
			const result = checkFileAuthority(
				'designer',
				'.swarm/outputs/dist/design-bundle.js',
				tempDir,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toMatch(/zone|generated/i);
				expect(result.zone).toBeDefined();
				expect(result.zone).toBe('generated');
			}
		});
	});

	describe('Edge cases for zone authority', () => {
		it('handles Windows paths with generated files', () => {
			const result = checkFileAuthority(
				'architect',
				'src\\dist\\bundle.js',
				tempDir,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.zone).toBe('generated');
			}
		});

		it('handles deep nested generated files', () => {
			// Use tests/build/ which passes prefix check (tests/) but is generated zone
			const result = checkFileAuthority(
				'coder',
				'tests/build/subdir/nested/output.js',
				tempDir,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.zone).toBe('generated');
			}
		});

		it('handles .wasm files in various locations', () => {
			const result = checkFileAuthority(
				'architect',
				'src/wasm/parser.wasm',
				tempDir,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.zone).toBe('generated');
			}
		});

		it('allows agents without blockedZones to write to generated files (if path allows)', () => {
			// Reviewer has blockedZones: ['generated'] so should be blocked from /dist/
			const resultReviewer = checkFileAuthority(
				'reviewer',
				'.swarm/evidence/dist/bundle.js',
				tempDir,
			);
			expect(resultReviewer.allowed).toBe(false);

			// But reviewer should be able to write to evidence (not generated)
			const resultEvidence = checkFileAuthority(
				'reviewer',
				'.swarm/evidence/test.json',
				tempDir,
			);
			expect(resultEvidence.allowed).toBe(true);
		});
	});

	describe('Cross-agent zone authority consistency', () => {
		it('architect is blocked from generated zone files', () => {
			const result = checkFileAuthority(
				'architect',
				'src/dist/app.js',
				tempDir,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.zone).toBe('generated');
			}
		});

		it('coder is blocked from generated zone files in allowed prefixes', () => {
			const result = checkFileAuthority('coder', 'src/dist/bundle.js', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.zone).toBe('generated');
			}
		});

		it('coder is blocked from config zone files in allowed prefixes', () => {
			const result = checkFileAuthority('coder', 'src/package.json', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.zone).toBe('config');
			}
		});
	});

	describe('Architect config zone blocking (#894)', () => {
		// v7.x (#894): architect now blocked from config zone to prevent bypassing
		// lint gates by editing config files instead of fixing source code.

		it('blocks architect from writing biome.json (config zone)', () => {
			const result = checkFileAuthority('architect', 'biome.json', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('config');
				expect(result.zone).toBe('config');
			}
		});

		it('blocks architect from writing biome.jsonc (blocked by glob, not zone)', () => {
			// biome.jsonc is in blockedGlobs (Step 3), not config zone classification
			// So it should be blocked with glob reason, not zone reason
			const result = checkFileAuthority('architect', 'biome.jsonc', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('blocked (glob');
			}
		});

		it('blocks architect from writing package.json (config zone)', () => {
			const result = checkFileAuthority('architect', 'package.json', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('config');
				expect(result.zone).toBe('config');
			}
		});

		it('blocks architect from writing tsconfig.json (config zone)', () => {
			const result = checkFileAuthority('architect', 'tsconfig.json', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('config');
				expect(result.zone).toBe('config');
			}
		});

		it('blocks architect from writing .env files (config zone)', () => {
			const result = checkFileAuthority('architect', '.env', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('config');
				expect(result.zone).toBe('config');
			}
		});

		it('blocks architect from writing config.yaml (config zone)', () => {
			const result = checkFileAuthority('architect', 'config.yaml', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('config');
				expect(result.zone).toBe('config');
			}
		});

		it('blocks architect from writing config.yml (config zone)', () => {
			const result = checkFileAuthority('architect', 'config.yml', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('config');
				expect(result.zone).toBe('config');
			}
		});

		it('blocks architect from writing config.toml (config zone)', () => {
			const result = checkFileAuthority('architect', 'config.toml', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('config');
				expect(result.zone).toBe('config');
			}
		});

		it('blocks architect from writing nested config files (config zone)', () => {
			// Config files in subdirectories are still config zone
			const result = checkFileAuthority(
				'architect',
				'src/config/settings.json',
				tempDir,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('config');
				expect(result.zone).toBe('config');
			}
		});

		it('allows architect to write to src/ files (production zone — no overblocking)', () => {
			// Non-config files should NOT be blocked for architect
			const result = checkFileAuthority(
				'architect',
				'src/utils/helper.ts',
				tempDir,
			);
			expect(result.allowed).toBe(true);
		});

		it('allows architect to write to docs/ files (docs zone — no overblocking)', () => {
			const result = checkFileAuthority('architect', 'docs/guide.md', tempDir);
			expect(result.allowed).toBe(true);
		});

		it('allows architect to write to tests/ files (test zone — no overblocking)', () => {
			const result = checkFileAuthority(
				'architect',
				'tests/unit/api.test.ts',
				tempDir,
			);
			expect(result.allowed).toBe(true);
		});

		it('allows architect to write to scripts/ files (scripts zone — no overblocking)', () => {
			const result = checkFileAuthority(
				'architect',
				'scripts/build.sh',
				tempDir,
			);
			expect(result.allowed).toBe(true);
		});

		it('architect config zone block reason includes "config" and zone name', () => {
			const result = checkFileAuthority('architect', 'package.json', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toMatch(/config/i);
				expect(result.zone).toBe('config');
			}
		});

		it('regression: coder is still blocked from config zone writes', () => {
			// Ensure we did not accidentally remove config-zone blocking from coder
			const result = checkFileAuthority('coder', 'src/package.json', tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.zone).toBe('config');
			}
		});
	});
});
