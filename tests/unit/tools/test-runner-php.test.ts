import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearDispatchCache } from '../../../src/lang/dispatch';
import {
	buildTestCommandViaDispatch,
	detectTestFramework,
	detectTestFrameworkViaDispatch,
} from '../../../src/tools/test-runner';

let tempDir: string;

beforeEach(() => {
	clearDispatchCache();
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-php-')),
	);
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
	clearDispatchCache();
});

describe('PHP test_runner support', () => {
	test('detects PHPUnit through legacy and dispatch paths', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({ name: 'acme/app' }),
		);
		fs.writeFileSync(path.join(tempDir, 'phpunit.xml'), '<phpunit />');

		expect(await detectTestFramework(tempDir)).toBe('phpunit');
		expect(await detectTestFrameworkViaDispatch(tempDir)).toBe('phpunit');
	});

	test('builds file-scoped PHPUnit commands through dispatch', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({ name: 'acme/app' }),
		);
		fs.writeFileSync(path.join(tempDir, 'phpunit.xml'), '<phpunit />');

		const cmd = await buildTestCommandViaDispatch(
			'phpunit',
			'convention',
			['tests/Feature/HealthTest.php'],
			false,
			tempDir,
			false,
		);

		expect(cmd).toEqual([
			path.join(
				'vendor',
				'bin',
				process.platform === 'win32' ? 'phpunit.bat' : 'phpunit',
			),
			'tests/Feature/HealthTest.php',
		]);
	});

	test('detects Laravel (php-artisan) through legacy and dispatch paths', async () => {
		// Laravel projects have an `artisan` file and `composer.json`
		fs.writeFileSync(
			path.join(tempDir, 'artisan'),
			'#!/usr/bin/env php\n<?php\n',
		);
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({
				name: 'laravel/laravel',
				require: { 'laravel/framework': '^10.0' },
			}),
		);

		expect(await detectTestFramework(tempDir)).toBe('php-artisan');
		expect(await detectTestFrameworkViaDispatch(tempDir)).toBe('php-artisan');
	});

	test('detects Pest through legacy and dispatch paths', async () => {
		// Pest projects have a Pest.php file in the project root
		fs.writeFileSync(path.join(tempDir, 'Pest.php'), '<?php\n');
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({ name: 'pest/pest' }),
		);

		expect(await detectTestFramework(tempDir)).toBe('pest');
		expect(await detectTestFrameworkViaDispatch(tempDir)).toBe('pest');
	});
});
