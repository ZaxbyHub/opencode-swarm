import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import '../../../src/lang/backends';
import {
	clearDispatchCache,
	_internals as dispatchInternals,
	pickBackend,
} from '../../../src/lang/dispatch';

/**
 * Regression tests for the PR #825 adversarial-review fixes in
 * src/lang/dispatch.ts:
 *
 *   - A1: findManifestRoot iterates the small MANIFEST_FILES set and
 *     checks against the readdir Set, not the reverse.
 *   - A2: manifestRootCache + short-circuit cache hit on repeat
 *     no-manifest calls.
 *   - D1: walk stops at `.git` boundary so it cannot escape into ancestor
 *     directories.
 */

let tempDir: string;

beforeEach(() => {
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-adv-fixes-')),
	);
	clearDispatchCache();
});

afterEach(() => {
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

describe('pickBackend — adversarial-review fixes', () => {
	test('A2: short-circuit cache HITS on repeat no-manifest call', async () => {
		const first = await pickBackend(tempDir);
		expect(first).toBeNull();

		let detectCalls = 0;
		const realDetect = dispatchInternals.detectProjectLanguages;
		dispatchInternals.detectProjectLanguages = async (dir) => {
			detectCalls++;
			return realDetect(dir);
		};
		try {
			const second = await pickBackend(tempDir);
			expect(second).toBeNull();
			// '' === '' hits the cache; detect not called this time.
			expect(detectCalls).toBe(0);
		} finally {
			dispatchInternals.detectProjectLanguages = realDetect;
		}
	});

	test('D1: findManifestRoot stops at .git boundary, returns null fast', async () => {
		// Project boundary at tempDir; no manifest inside the boundary.
		fs.mkdirSync(path.join(tempDir, '.git'));
		const deep = path.join(tempDir, 'a', 'b', 'c');
		fs.mkdirSync(deep, { recursive: true });
		const t0 = Date.now();
		const result = await pickBackend(deep);
		const elapsed = Date.now() - t0;
		expect(result).toBeNull();
		// Sanity: walk must not have escaped past .git into /tmp and beyond.
		// Even on a slow filesystem this should complete well under 200ms.
		expect(elapsed).toBeLessThan(200);
	});

	test('A1: no false-positive backend selection when ancestor has a manifest', async () => {
		// Parent has package.json; subdir has .git boundary; subdir should
		// resolve as its own project (not inherit the parent's backend).
		fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
		const subProject = path.join(tempDir, 'sub');
		fs.mkdirSync(subProject);
		fs.mkdirSync(path.join(subProject, '.git'));
		// subProject has no manifest of its own. The walk stops at .git
		// without inheriting tempDir's package.json.
		const result = await pickBackend(subProject);
		expect(result).toBeNull();
	});
});
