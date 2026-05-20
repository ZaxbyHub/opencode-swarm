/**
 * PHP Language Profile — Command Surface Tests
 *
 * Validates the complete command surface of the PHP language profile:
 * build commands, test framework detection, lint/static-analysis tools,
 * audit command, and prompt guidance fields.
 *
 * Drift note: If build.commands, test.frameworks, or lint.linters change,
 * update these tests to match. Tests protect command selection behavior,
 * not just field existence.
 */

import { describe, expect, it } from 'bun:test';
import { LANGUAGE_REGISTRY } from '../../../src/lang/profiles';

describe('PHP Language Profile', () => {
	const phpProfile = LANGUAGE_REGISTRY.getById('php');

	it('profile is registered with id php', () => {
		expect(phpProfile).toBeDefined();
		expect(phpProfile!.id).toBe('php');
	});

	describe('build', () => {
		it('build.commands is non-empty', () => {
			expect(phpProfile!.build.commands.length).toBeGreaterThanOrEqual(1);
		});

		it('first build command is Composer Install', () => {
			const cmd = phpProfile!.build.commands[0];
			expect(cmd.name).toBe('Composer Install');
			// Behavioral: verify the resolved command includes both --no-interaction and --prefer-dist
			// (CI-appropriate flags, not just any composer install command)
			expect(cmd.cmd).toContain('composer install');
			expect(cmd.cmd).toContain('--no-interaction');
			expect(cmd.cmd).toContain('--prefer-dist');
		});

		it('build.detectFiles includes composer.json', () => {
			expect(phpProfile!.build.detectFiles).toContain('composer.json');
		});
	});

	describe('test', () => {
		it('test.detectFiles includes phpunit.xml and phpunit.xml.dist', () => {
			expect(phpProfile!.test.detectFiles).toContain('phpunit.xml');
			expect(phpProfile!.test.detectFiles).toContain('phpunit.xml.dist');
		});

		it('test.frameworks has PHPUnit with vendor/bin/phpunit command', () => {
			const phpunit = phpProfile!.test.frameworks.find(
				(f) => f.name === 'PHPUnit' && f.cmd === 'vendor/bin/phpunit',
			);
			expect(phpunit).toBeDefined();
		});
	});

	describe('test framework selection', () => {
		// Drift: protects profile.test.frameworks Pest entry.
		// If Pest detect file changes from 'Pest.php' or cmd changes, update this test.
		it('test.frameworks includes Pest with vendor/bin/pest command', () => {
			const pest = phpProfile!.test.frameworks.find((f) => f.name === 'Pest');
			expect(pest).toBeDefined();
			expect(pest!.cmd).toBe('vendor/bin/pest');
			expect(pest!.detect).toBe('Pest.php');
		});

		// Drift: Pest priority > PHPUnit priority ensures Pest wins in mixed
		// repos (PR #825: profile priorities now use HIGH-IS-HIGHER convention
		// project-wide; PHP was previously the lone low-is-higher holdout).
		// If priority ordering changes, update test and docs/releases/v6.49.0.md.
		it('Pest has higher priority number than PHPUnit (Pest preferred in mixed repos)', () => {
			const pest = phpProfile!.test.frameworks.find((f) => f.name === 'Pest');
			const phpunit = phpProfile!.test.frameworks.find(
				(f) => f.name === 'PHPUnit',
			);
			expect(pest).toBeDefined();
			expect(phpunit).toBeDefined();
			expect(pest!.priority).toBeGreaterThan(phpunit!.priority);
		});

		it('test.detectFiles includes Pest.php detection signal', () => {
			expect(phpProfile!.test.detectFiles).toContain('Pest.php');
		});

		it('test.frameworks has at least 3 entries (Pest + 2x PHPUnit)', () => {
			expect(phpProfile!.test.frameworks.length).toBeGreaterThanOrEqual(3);
		});
	});

	describe('lint', () => {
		it('lint.linters has at least 2 entries', () => {
			expect(phpProfile!.lint.linters.length).toBeGreaterThanOrEqual(2);
		});

		it('lint.linters contains PHP-CS-Fixer entry with detect .php-cs-fixer.php', () => {
			const fixer = phpProfile!.lint.linters.find(
				(l) => l.name === 'PHP-CS-Fixer' && l.detect === '.php-cs-fixer.php',
			);
			expect(fixer).toBeDefined();
		});

		it('lint.linters contains PHPStan entry with detect phpstan.neon', () => {
			const phpstanNeon = phpProfile!.lint.linters.find(
				(l) => l.name === 'PHPStan' && l.detect === 'phpstan.neon',
			);
			expect(phpstanNeon).toBeDefined();
		});
	});

	describe('lint tool precedence', () => {
		it('lint.linters contains PHPStan entry (phpstan.neon) at priority 10 (highest)', () => {
			const phpstanNeon = phpProfile!.lint.linters.find(
				(l) => l.name === 'PHPStan' && l.detect === 'phpstan.neon',
			);
			expect(phpstanNeon).toBeDefined();
			expect(phpstanNeon!.priority).toBe(10);
			expect(phpstanNeon!.cmd).toContain('phpstan');
		});

		it('lint.linters contains Pint entry with detect pint.json', () => {
			const pint = phpProfile!.lint.linters.find((l) => l.name === 'Pint');
			expect(pint).toBeDefined();
			expect(pint!.detect).toBe('pint.json');
			expect(pint!.cmd).toContain('pint');
		});

		// Drift: phpstan.neon (priority 10) > phpstan.neon.dist (priority 9) — .neon preferred over .neon.dist.
		// If precedence changes, update framework-detector.ts getLaravelCommandOverlay() and this test.
		it('phpstan.neon preferred over phpstan.neon.dist (higher priority number wins)', () => {
			const phpstanNeon = phpProfile!.lint.linters.find(
				(l) => l.name === 'PHPStan' && l.detect === 'phpstan.neon',
			);
			const phpstanDist = phpProfile!.lint.linters.find(
				(l) => l.name === 'PHPStan' && l.detect === 'phpstan.neon.dist',
			);
			expect(phpstanNeon).toBeDefined();
			expect(phpstanDist).toBeDefined();
			expect(phpstanNeon!.priority).toBeGreaterThan(phpstanDist!.priority);
		});

		// Drift: Pint priority 8 > PHP-CS-Fixer priority 7 ensures Pint wins when pint.json present.
		// If Pint detectFile ('pint.json') or priority changes, update getLaravelCommandOverlay() to match.
		it('Pint has higher priority number than PHP-CS-Fixer (Pint preferred when present)', () => {
			const pint = phpProfile!.lint.linters.find((l) => l.name === 'Pint');
			const fixer = phpProfile!.lint.linters.find(
				(l) => l.name === 'PHP-CS-Fixer',
			);
			expect(pint).toBeDefined();
			expect(fixer).toBeDefined();
			expect(pint!.priority).toBeGreaterThan(fixer!.priority);
		});

		it('lint.linters has exactly 4 entries (PHPStan x2, Pint, PHP-CS-Fixer)', () => {
			expect(phpProfile!.lint.linters).toHaveLength(4);
		});

		it('lint.detectFiles includes pint.json detection signal', () => {
			expect(phpProfile!.lint.detectFiles).toContain('pint.json');
		});
	});

	describe('audit', () => {
		// Drift: protects profile.audit.command --locked --format=json flags.
		// If Composer audit flags change, update pkg-audit.ts runComposerAudit() to match.
		it('audit.command is composer audit --locked --format=json', () => {
			expect(phpProfile!.audit.command).toBe(
				'composer audit --locked --format=json',
			);
		});

		it('audit.detectFiles includes composer.lock', () => {
			expect(phpProfile!.audit.detectFiles).toContain('composer.lock');
		});
	});

	describe('sast', () => {
		it('sast.nativeRuleSet is php', () => {
			expect(phpProfile!.sast.nativeRuleSet).toBe('php');
		});

		it('sast.semgrepSupport is ga', () => {
			expect(phpProfile!.sast.semgrepSupport).toBe('ga');
		});
	});

	describe('prompts', () => {
		it('prompts.coderConstraints has at least 4 entries', () => {
			expect(
				phpProfile!.prompts.coderConstraints.length,
			).toBeGreaterThanOrEqual(4);
		});

		it('prompts.reviewerChecklist has at least 4 entries', () => {
			expect(
				phpProfile!.prompts.reviewerChecklist.length,
			).toBeGreaterThanOrEqual(4);
		});
	});

	describe('adversarial', () => {
		it('getByExtension(.PHP) returns undefined — case sensitive', () => {
			const result = LANGUAGE_REGISTRY.getByExtension('.PHP');
			expect(result).toBeUndefined();
		});
	});

	describe('Blade file support', () => {
		it('.blade.php is in PHP profile extensions', () => {
			expect(phpProfile!.extensions).toContain('.blade.php');
		});

		it('getByExtension(.blade.php) returns PHP profile', () => {
			const profile = LANGUAGE_REGISTRY.getByExtension('.blade.php');
			expect(profile).toBeDefined();
			expect(profile!.id).toBe('php');
		});

		it('getByExtension(.php) still returns PHP profile (no regression)', () => {
			const profile = LANGUAGE_REGISTRY.getByExtension('.php');
			expect(profile).toBeDefined();
			expect(profile!.id).toBe('php');
		});
	});
});
