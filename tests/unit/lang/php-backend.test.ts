/**
 * PHP backend tests (DD-C009). Verifies the Laravel framework detection
 * (previously dead code) is wired into the dispatch layer via the PHP
 * backend's `selectFramework` hook, using the real fixture projects.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildPhpBackend } from '../../../src/lang/backends/php';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

describe('PHP backend selectFramework (DD-C009)', () => {
	test('detects Laravel for the laravel-baseline fixture', async () => {
		const backend = buildPhpBackend();
		expect(backend.selectFramework).toBeDefined();
		const sel = await backend.selectFramework?.(
			path.join(FIXTURES, 'laravel-baseline'),
		);
		expect(sel).not.toBeNull();
		expect(sel?.name).toBe('laravel');
	});

	test('returns null for a generic (non-Laravel) Composer project', async () => {
		const backend = buildPhpBackend();
		const sel = await backend.selectFramework?.(
			path.join(FIXTURES, 'generic-composer'),
		);
		expect(sel ?? null).toBeNull();
	});

	test('backend is built from the php profile (id + displayName)', () => {
		const backend = buildPhpBackend();
		expect(backend.id).toBe('php');
		expect(backend.displayName).toBe('PHP');
	});
});

// ============ Edge-case Laravel detection layouts (F-002c) ============

describe('PHP backend selectFramework — edge-case layouts (F-002c)', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'php-backend-edge-')),
		);
	});

	afterEach(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	test('detects Laravel when artisan is capitalized but composer.json + config/app.php are present (2 signals)', async () => {
		// Capitalized "Artisan" is NOT the artisan signal (case-sensitive check),
		// but laravel/framework dep + config/app.php still gives 2 signals → detected.
		fs.writeFileSync(path.join(tmpDir, 'Artisan'), '#!/usr/bin/env php');
		fs.writeFileSync(
			path.join(tmpDir, 'composer.json'),
			JSON.stringify({ require: { 'laravel/framework': '^11.0' } }),
		);
		fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, 'config', 'app.php'),
			'<?php return [];',
		);

		const backend = buildPhpBackend();
		const sel = await backend.selectFramework?.(tmpDir);
		expect(sel).not.toBeNull();
		expect(sel?.name).toBe('laravel');
	});

	test('returns null when only one signal present (artisan only, no composer.json)', async () => {
		// Only 1 of 3 signals present → below the ≥2 threshold → not Laravel.
		fs.writeFileSync(path.join(tmpDir, 'artisan'), '#!/usr/bin/env php');

		const backend = buildPhpBackend();
		const sel = await backend.selectFramework?.(tmpDir);
		expect(sel ?? null).toBeNull();
	});

	test('returns null and does not throw for a malformed composer.json', async () => {
		// Artisan present; composer.json present but malformed JSON — dep signal fails
		// gracefully. With only 1 signal (artisan) the result must be null, not an error.
		fs.writeFileSync(path.join(tmpDir, 'artisan'), '#!/usr/bin/env php');
		fs.writeFileSync(path.join(tmpDir, 'composer.json'), '{ invalid json ');

		const backend = buildPhpBackend();
		let caughtError: unknown;
		let sel:
			| Awaited<ReturnType<NonNullable<typeof backend.selectFramework>>>
			| undefined;
		try {
			sel = await backend.selectFramework?.(tmpDir);
		} catch (e) {
			caughtError = e;
		}
		expect(caughtError).toBeUndefined();
		expect(sel ?? null).toBeNull();
	});

	test('returns null for a completely empty directory', async () => {
		const backend = buildPhpBackend();
		const sel = await backend.selectFramework?.(tmpDir);
		expect(sel ?? null).toBeNull();
	});

	test('detects Laravel with artisan + composer.json laravel/framework (no config/app.php)', async () => {
		// Artisan + dep = 2 signals → meets the ≥2 threshold even without config/app.php.
		fs.writeFileSync(path.join(tmpDir, 'artisan'), '#!/usr/bin/env php');
		fs.writeFileSync(
			path.join(tmpDir, 'composer.json'),
			JSON.stringify({ require: { 'laravel/framework': '^11.0' } }),
		);

		const backend = buildPhpBackend();
		const sel = await backend.selectFramework?.(tmpDir);
		expect(sel).not.toBeNull();
		expect(sel?.name).toBe('laravel');
	});

	test('case-sensitivity: ARTISAN (uppercase) should NOT count as artisan signal', async () => {
		// Only the lowercase "artisan" filename is the artisan signal.
		// ARTISAN (uppercase) or Artisan (mixed case) must NOT count.
		fs.writeFileSync(path.join(tmpDir, 'ARTISAN'), '#!/usr/bin/env php');
		// With only 1 signal (uppercase ARTISAN, not lowercase artisan) → below threshold.
		const backend = buildPhpBackend();
		const sel = await backend.selectFramework?.(tmpDir);
		expect(sel ?? null).toBeNull();
	});
});
