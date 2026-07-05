/**
 * PHP/Laravel Command Selection Integration Tests (Task 4.2)
 *
 * Fixture-driven tests verifying that the actual resolved command paths
 * are correct for all four PHP project types — not just static profile assertions.
 *
 * Drift note: If fixture files change or profile command selection logic changes,
 * these tests must be updated to match. Tests protect command selection BEHAVIOR,
 * not just profile field declarations.
 */

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverBuildCommands } from '../../src/build/discovery';
import {
	detectLaravelProject,
	getLaravelCommandOverlay,
} from '../../src/lang/framework-detector';
import { LANGUAGE_REGISTRY } from '../../src/lang/profiles';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

// Resolve which PHP test framework would be selected for a given project directory.
// Mimics the profile-driven test framework selection logic.
// Drift note: If profile.test.frameworks or detect file names change, update this.
function resolveTestFramework(
	projectDir: string,
): { name: string; cmd: string } | null {
	const profile = LANGUAGE_REGISTRY.getById('php');
	if (!profile) return null;
	const sorted = [...profile.test.frameworks].sort(
		(a, b) => a.priority - b.priority,
	);
	for (const framework of sorted) {
		const detectPath = path.join(projectDir, framework.detect);
		if (fs.existsSync(detectPath)) {
			return { name: framework.name, cmd: framework.cmd };
		}
	}
	return null;
}

describe('PHP command selection — generic-composer fixture', () => {
	const fixtureDir = path.join(FIXTURES, 'generic-composer');

	it('fixture directory exists', () => {
		expect(fs.existsSync(fixtureDir)).toBe(true);
	});

	it('build: Composer install is detected or skipped (not silently ignored)', async () => {
		const result = await discoverBuildCommands(fixtureDir, { scope: 'all' });
		const hasComposer =
			result.commands.some(
				(c) => c.ecosystem === 'php' || c.ecosystem === 'php-composer',
			) ||
			result.skipped.some(
				(s) => s.ecosystem === 'php' || s.ecosystem === 'php-composer',
			);
		expect(hasComposer).toBe(true);
	});

	it('test: no framework detected (no phpunit.xml, no Pest.php)', () => {
		const resolved = resolveTestFramework(fixtureDir);
		expect(resolved).toBeNull();
	});

	it('is not detected as a Laravel project', () => {
		expect(detectLaravelProject(fixtureDir)).toBe(false);
	});
});

describe('PHP command selection — phpunit-project fixture', () => {
	const fixtureDir = path.join(FIXTURES, 'phpunit-project');

	it('fixture directory exists', () => {
		expect(fs.existsSync(fixtureDir)).toBe(true);
	});

	it('phpunit.xml is present (detection signal)', () => {
		expect(fs.existsSync(path.join(fixtureDir, 'phpunit.xml'))).toBe(true);
	});

	// Drift: PHPUnit resolution protected by phpunit.xml detect file presence.
	// If PHPUnit detectFile or cmd changes in profiles.ts, update this integration test.
	it('test: resolves to PHPUnit with vendor/bin/phpunit command', () => {
		const resolved = resolveTestFramework(fixtureDir);
		expect(resolved).not.toBeNull();
		expect(resolved!.name).toBe('PHPUnit');
		expect(resolved!.cmd).toBe('vendor/bin/phpunit');
	});

	it('is not detected as a Laravel project', () => {
		expect(detectLaravelProject(fixtureDir)).toBe(false);
	});
});

describe('PHP command selection — pest-project fixture', () => {
	const fixtureDir = path.join(FIXTURES, 'pest-project');

	it('fixture directory exists', () => {
		expect(fs.existsSync(fixtureDir)).toBe(true);
	});

	it('Pest.php is present (detection signal)', () => {
		expect(fs.existsSync(path.join(fixtureDir, 'Pest.php'))).toBe(true);
	});

	// Drift: Pest resolution protected by Pest.php detect file presence and priority 1.
	// If Pest detectFile ('Pest.php') or priority changes in profiles.ts, update this test.
	it('test: resolves to Pest with vendor/bin/pest command (priority 1 beats PHPUnit)', () => {
		const resolved = resolveTestFramework(fixtureDir);
		expect(resolved).not.toBeNull();
		expect(resolved!.name).toBe('Pest');
		expect(resolved!.cmd).toBe('vendor/bin/pest');
	});

	it('is not detected as a Laravel project', () => {
		expect(detectLaravelProject(fixtureDir)).toBe(false);
	});
});

describe('PHP command selection — laravel-baseline fixture', () => {
	const fixtureDir = path.join(FIXTURES, 'laravel-baseline');

	it('fixture directory exists', () => {
		expect(fs.existsSync(fixtureDir)).toBe(true);
	});

	it('artisan file is present (Laravel detection signal 1)', () => {
		expect(fs.existsSync(path.join(fixtureDir, 'artisan'))).toBe(true);
	});

	it('is detected as a Laravel project (2-of-3 signals)', () => {
		expect(detectLaravelProject(fixtureDir)).toBe(true);
	});

	// Drift: Laravel always uses php artisan test regardless of profile.test.frameworks.
	// getLaravelCommandOverlay() takes precedence over profile framework resolution.
	it('test: Laravel command overlay returns php artisan test (overrides Pest/PHPUnit)', () => {
		const overlay = getLaravelCommandOverlay(fixtureDir);
		expect(overlay).not.toBeNull();
		expect(overlay!.testCommand).toBe('php artisan test');
	});

	it('audit: Laravel command overlay returns composer audit --locked --format=json', () => {
		const overlay = getLaravelCommandOverlay(fixtureDir);
		expect(overlay!.auditCommand).toBe('composer audit --locked --format=json');
	});

	it('supportsParallel: true for Laravel projects', () => {
		const overlay = getLaravelCommandOverlay(fixtureDir);
		expect(overlay!.supportsParallel).toBe(true);
	});
});

describe('PHP command selection — cross-fixture assertions', () => {
	it('Pest is preferred over PHPUnit in mixed repos (priority check)', () => {
		const profile = LANGUAGE_REGISTRY.getById('php');
		const pest = profile!.test.frameworks.find((f) => f.name === 'Pest');
		const phpunit = profile!.test.frameworks.find((f) => f.name === 'PHPUnit');
		expect(pest!.priority).toBeGreaterThan(phpunit!.priority);
	});

	it('Laravel command always wins over Pest and PHPUnit (artisan test wraps both)', () => {
		// In a Laravel project, even if Pest.php exists, getLaravelCommandOverlay
		// always returns php artisan test (not vendor/bin/pest)
		const laravelDir = path.join(FIXTURES, 'laravel-baseline');
		const overlay = getLaravelCommandOverlay(laravelDir);
		// The overlay command is artisan regardless of what's in test.frameworks
		expect(overlay!.testCommand).toBe('php artisan test');
		expect(overlay!.testCommand).not.toContain('pest');
		expect(overlay!.testCommand).not.toContain('phpunit');
	});
});
