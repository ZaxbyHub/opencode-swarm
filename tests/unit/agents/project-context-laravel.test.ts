/**
 * DD-C009: buildProjectContext applies the Laravel command overlay for PHP
 * projects, and the PHP backend surfaces PROJECT_FRAMEWORK = laravel. This is
 * the production wiring that makes the previously-dead framework-detector live.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// Importing the backends barrel registers the PHP backend in the registry.
import '../../../src/lang/backends';
import { buildProjectContext } from '../../../src/agents/project-context';
import { clearDispatchCache } from '../../../src/lang/dispatch';

let tempDir: string;

beforeEach(() => {
	clearDispatchCache();
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'project-context-laravel-')),
	);
});

afterEach(() => {
	clearDispatchCache();
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

function writeLaravelProject(dir: string): void {
	// 2 of 3 Laravel signals: artisan file + laravel/framework in require.
	fs.writeFileSync(path.join(dir, 'artisan'), '#!/usr/bin/env php\n');
	fs.writeFileSync(
		path.join(dir, 'composer.json'),
		JSON.stringify({ require: { 'laravel/framework': '^11.0' } }),
	);
}

describe('buildProjectContext — Laravel overlay (DD-C009)', () => {
	test('Laravel project: TEST_CMD becomes "php artisan test"', async () => {
		writeLaravelProject(tempDir);
		const ctx = await buildProjectContext(tempDir);
		expect(ctx).not.toBeNull();
		expect(ctx!.PROJECT_LANGUAGE).toBe('PHP');
		expect(ctx!.TEST_CMD).toBe('php artisan test');
		expect(ctx!.PROJECT_FRAMEWORK).toBe('laravel');
	});

	test('generic Composer (non-Laravel) project keeps the profile default test command', async () => {
		// composer.json without laravel/framework + no artisan → not Laravel.
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({ require: { 'monolog/monolog': '^3.0' } }),
		);
		fs.writeFileSync(path.join(tempDir, 'phpunit.xml'), '<phpunit></phpunit>');
		const ctx = await buildProjectContext(tempDir);
		expect(ctx).not.toBeNull();
		expect(ctx!.PROJECT_LANGUAGE).toBe('PHP');
		// PHPUnit default, NOT the artisan overlay.
		expect(ctx!.TEST_CMD).not.toBe('php artisan test');
	});
});
