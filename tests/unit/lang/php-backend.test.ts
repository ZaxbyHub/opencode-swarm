/**
 * PHP backend tests (DD-C009). Verifies the Laravel framework detection
 * (previously dead code) is wired into the dispatch layer via the PHP
 * backend's `selectFramework` hook, using the real fixture projects.
 */

import { describe, expect, test } from 'bun:test';
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
