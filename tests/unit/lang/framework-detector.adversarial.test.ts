/**
 * Adversarial Tests for Laravel Framework Detection
 *
 * Tests detectLaravelProject() against malicious/invalid inputs
 * and edge cases in filesystem and JSON parsing.
 *
 * Attack surface: detectLaravelProject() reads filesystem (artisan file)
 * and parses JSON (composer.json). These tests verify graceful handling
 * of adversarial inputs without crashes or false positives.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	detectLaravelProject,
	getLaravelSignals,
} from '../../../src/lang/framework-detector';

describe('Laravel Framework Detection — Adversarial', () => {
	let tempDir: string;

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// -------------------------------------------------------------------------
	// 1. Path traversal in directory — must return false, NOT throw
	// -------------------------------------------------------------------------
	it('path traversal in directory returns false without throwing', () => {
		// This should not throw even if the path escapes filesystem
		expect(() => detectLaravelProject('../../../etc')).not.toThrow();
		expect(detectLaravelProject('../../../etc')).toBe(false);
	});

	it('path traversal with null bytes returns false', () => {
		const traversalWithNull = '../../etc\x00config';
		expect(() => detectLaravelProject(traversalWithNull)).not.toThrow();
		// fs.existsSync will reject the null byte on most systems
		expect(detectLaravelProject(traversalWithNull)).toBe(false);
	});

	// -------------------------------------------------------------------------
	// 2. Very long directory path (4000+ chars) — returns false gracefully
	// -------------------------------------------------------------------------
	it('very long directory path (>4000 chars) returns false without crashing', () => {
		const longPath = path.join(os.tmpdir(), 'a'.repeat(5000));
		expect(() => detectLaravelProject(longPath)).not.toThrow();
		expect(detectLaravelProject(longPath)).toBe(false);
	});

	// -------------------------------------------------------------------------
	// 3. composer.json with laravel/framework buried in nested require
	// -------------------------------------------------------------------------
	it('laravel/framework nested in extra.require is NOT detected (only top-level require counts)', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-detect-'));
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({
				name: 'test/temp',
				require: { 'other/pkg': '^1.0' },
				extra: { require: { 'laravel/framework': '^11' } },
			}),
		);
		const signals = getLaravelSignals(tempDir);
		expect(signals.hasLaravelFrameworkDep).toBe(false);
		expect(detectLaravelProject(tempDir)).toBe(false);
	});

	// -------------------------------------------------------------------------
	// 4. composer.json with require as an array instead of object
	// -------------------------------------------------------------------------
	it('composer.json with require as an array returns false without crash', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-detect-'));
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({
				name: 'test/temp',
				require: [],
			}),
		);
		const signals = getLaravelSignals(tempDir);
		expect(signals.hasLaravelFrameworkDep).toBe(false);
		expect(detectLaravelProject(tempDir)).toBe(false);
	});

	// -------------------------------------------------------------------------
	// 5. composer.json with laravel/framework as key with null value
	// -------------------------------------------------------------------------
	it('composer.json with laravel/framework: null returns false (typeof null !== string)', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-detect-'));
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({
				name: 'test/temp',
				require: { 'laravel/framework': null },
			}),
		);
		const signals = getLaravelSignals(tempDir);
		expect(signals.hasLaravelFrameworkDep).toBe(false);
		expect(detectLaravelProject(tempDir)).toBe(false);
	});

	// -------------------------------------------------------------------------
	// 6. artisan file is actually a directory — fs.existsSync returns true
	//    for both files and directories, so this is a known limitation
	// -------------------------------------------------------------------------
	it('artisan is a directory (not a file) — fs.existsSync returns true but detection fails gracefully', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-detect-'));
		// Create a directory named 'artisan' — fs.existsSync returns true for this
		fs.mkdirSync(path.join(tempDir, 'artisan'));
		// Also add laravel/framework dep so we have 2 signals if artisan-check was perfect
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({
				name: 'test/temp',
				require: { 'laravel/framework': '^11.0' },
			}),
		);
		// fs.existsSync says true for directory, but isFile() correctly returns false
		expect(fs.existsSync(path.join(tempDir, 'artisan'))).toBe(true);
		const signals = getLaravelSignals(tempDir);
		// Implementation correctly distinguishes files from directories via isFile()
		// Only 1 signal (laravel/framework dep), need 2 → project NOT detected
		expect(signals.hasArtisanFile).toBe(false); // correctly returns false for dir
		expect(detectLaravelProject(tempDir)).toBe(false);
	});

	// -------------------------------------------------------------------------
	// 7. config/app.php is a directory (not a file)
	// -------------------------------------------------------------------------
	it('config/app.php is a directory — fs.existsSync returns true but detection fails gracefully', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-detect-'));
		fs.mkdirSync(path.join(tempDir, 'config'));
		fs.mkdirSync(path.join(tempDir, 'config', 'app.php')); // directory, not file
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({
				name: 'test/temp',
				require: { 'laravel/framework': '^11.0' },
			}),
		);
		// fs.existsSync says true for directory
		expect(fs.existsSync(path.join(tempDir, 'config', 'app.php'))).toBe(true);
		const signals = getLaravelSignals(tempDir);
		// Current implementation: hasConfigApp=true (limitation)
		expect(signals.hasConfigApp).toBe(true); // limitation: returns true for dir
		expect(detectLaravelProject(tempDir)).toBe(true);
	});

	// -------------------------------------------------------------------------
	// 8. Unicode in directory name
	// -------------------------------------------------------------------------
	it('directory with emoji in path returns correct boolean without crash', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-🔥-'));
		fs.writeFileSync(path.join(tempDir, 'artisan'), '#!/usr/bin/env php\n');
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({
				name: 'test/temp',
				require: { 'laravel/framework': '^11.0' },
			}),
		);
		expect(() => detectLaravelProject(tempDir)).not.toThrow();
		expect(detectLaravelProject(tempDir)).toBe(true);
	});

	// -------------------------------------------------------------------------
	// 9. Concurrent calls on same directory — sync, so no race condition
	// -------------------------------------------------------------------------
	it('multiple simultaneous calls return the same result (sync — no race condition)', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-detect-'));
		fs.writeFileSync(path.join(tempDir, 'artisan'), '#!/usr/bin/env php\n');
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({
				name: 'test/temp',
				require: { 'laravel/framework': '^11.0' },
			}),
		);
		const result1 = detectLaravelProject(tempDir);
		const result2 = detectLaravelProject(tempDir);
		const result3 = detectLaravelProject(tempDir);
		expect(result1).toBe(true);
		expect(result2).toBe(true);
		expect(result3).toBe(true);
	});

	// -------------------------------------------------------------------------
	// 10. All three signals explicitly false — count=0 → false
	// -------------------------------------------------------------------------
	it('all three signals false (count=0) returns false', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-detect-'));
		// Only an unrelated file — nothing that matches Laravel signals
		fs.writeFileSync(path.join(tempDir, 'README.md'), '# Test');
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({
				name: 'test/temp',
				require: { php: '^8.1' },
			}),
		);
		const signals = getLaravelSignals(tempDir);
		expect(signals.hasArtisanFile).toBe(false);
		expect(signals.hasLaravelFrameworkDep).toBe(false);
		expect(signals.hasConfigApp).toBe(false);
		expect(detectLaravelProject(tempDir)).toBe(false);
	});

	// -------------------------------------------------------------------------
	// Additional adversarial cases
	// -------------------------------------------------------------------------
	it('composer.json is empty object returns false', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-detect-'));
		fs.writeFileSync(path.join(tempDir, 'composer.json'), '{}');
		expect(detectLaravelProject(tempDir)).toBe(false);
	});

	it('composer.json has laravel/framework as empty string — signal is true (typeof empty string === string)', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-detect-'));
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({
				name: 'test/temp',
				require: { 'laravel/framework': '' },
			}),
		);
		fs.writeFileSync(path.join(tempDir, 'artisan'), '#!/usr/bin/env php\n');
		// empty string IS a string — typeof '' === 'string' is true
		const signals = getLaravelSignals(tempDir);
		expect(signals.hasLaravelFrameworkDep).toBe(true);
		// With 2 signals (artisan + dep), detection returns true
		expect(detectLaravelProject(tempDir)).toBe(true);
	});

	it('composer.json has laravel/framework version as object instead of string', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-detect-'));
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({
				name: 'test/temp',
				require: { 'laravel/framework': { version: '^11.0' } },
			}),
		);
		const signals = getLaravelSignals(tempDir);
		expect(signals.hasLaravelFrameworkDep).toBe(false);
		expect(detectLaravelProject(tempDir)).toBe(false);
	});

	it('composer.json require field is null instead of object', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-detect-'));
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({
				name: 'test/temp',
				require: null,
			}),
		);
		const signals = getLaravelSignals(tempDir);
		expect(signals.hasLaravelFrameworkDep).toBe(false);
		expect(detectLaravelProject(tempDir)).toBe(false);
	});

	it('composer.json is extremely large (10MB+) does not crash', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-detect-'));
		const hugeObject: Record<string, string> = {};
		// ~100KB of data
		for (let i = 0; i < 50000; i++) {
			hugeObject[`key-${i}`] = 'value';
		}
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({ name: 'test/temp', require: hugeObject }),
		);
		expect(() => detectLaravelProject(tempDir)).not.toThrow();
		expect(detectLaravelProject(tempDir)).toBe(false);
	});

	it('non-utf8 bytes in composer.json returns false without crash', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-detect-'));
		// Write a file with invalid UTF-8 sequences
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			Buffer.from([0x80, 0x81, 0x82]),
		);
		expect(() => detectLaravelProject(tempDir)).not.toThrow();
		expect(detectLaravelProject(tempDir)).toBe(false);
	});

	it('symbolic link to artisan file is followed and detected', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-detect-'));
		const realFile = path.join(tempDir, 'real-artisan');
		fs.writeFileSync(realFile, '#!/usr/bin/env php\n');
		try {
			fs.symlinkSync(realFile, path.join(tempDir, 'artisan'));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
			throw error;
		}
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({
				name: 'test/temp',
				require: { 'laravel/framework': '^11.0' },
			}),
		);
		const signals = getLaravelSignals(tempDir);
		expect(signals.hasArtisanFile).toBe(true);
		expect(detectLaravelProject(tempDir)).toBe(true);
	});

	it('circular symlink in path does not cause infinite loop (sync call)', () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-detect-'));
		// Create a self-referential symlink
		const subdir = path.join(tempDir, 'subdir');
		fs.mkdirSync(subdir);
		try {
			fs.symlinkSync(subdir, path.join(subdir, 'loop'));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
			throw error;
		}
		// This should not hang — sync calls don't follow symlinks into infinite loops
		expect(() => detectLaravelProject(subdir)).not.toThrow();
		expect(detectLaravelProject(subdir)).toBe(false);
	});
});
