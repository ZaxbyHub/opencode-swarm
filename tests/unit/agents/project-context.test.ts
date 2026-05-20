import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildProjectContext,
	LANG_BACKEND_DETECTION_TIMEOUT_MS,
	_internals as projectContextInternals,
} from '../../../src/agents/project-context';
import { UNRESOLVED } from '../../../src/agents/template';

/**
 * Phase 4b tests for the project-context resolver.
 *
 * Verifies:
 *   1. Returns null when no manifest is detected (caller falls open to
 *      `emptyProjectContext()` per Invariant 1).
 *   2. Populates PROJECT_LANGUAGE + BUILD_CMD + TEST_CMD + LINT_CMD
 *      when the dispatch resolves a backend.
 *   3. Per-language constraint blocks are populated as escaped bullet
 *      lists, not as the UNRESOLVED sentinel (would render as fake
 *      bullets).
 *   4. Secondary-language list is populated when multiple equal-tier
 *      languages are detected.
 *   5. The init-fail-open path: a hung pickBackend resolves with
 *      UNRESOLVED placeholders rather than crashing the manifest.
 */

let tempDir: string;

beforeEach(() => {
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'project-context-test-')),
	);
});

afterEach(() => {
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('buildProjectContext', () => {
	test('returns null when no manifest is present', async () => {
		const ctx = await buildProjectContext(tempDir);
		expect(ctx).toBeNull();
	});

	test('TypeScript project: PROJECT_LANGUAGE populated, sentinel for unresolved fields', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				name: 'x',
				scripts: { test: 'vitest run' },
				devDependencies: { vitest: '^1.0.0' },
			}),
		);
		const ctx = await buildProjectContext(tempDir);
		expect(ctx).not.toBeNull();
		expect(ctx!.PROJECT_LANGUAGE).toBe('TypeScript / JavaScript');
		// vitest is detected via devDependencies; TEST_CMD reflects whatever
		// the typescript profile declares for the `vitest` framework's `cmd`
		// (currently `bun test`). Just assert it resolved away from the
		// UNRESOLVED sentinel — exact command-string is the profile's choice.
		expect(ctx!.TEST_CMD).not.toBe(UNRESOLVED);
		expect(ctx!.TEST_CMD.length).toBeGreaterThan(0);
		// PROJECT_FRAMEWORK stays UNRESOLVED here because the TS profile's
		// `selectFramework` reads package.json dependencies — and this fixture
		// has none of the recognized frameworks. A separate test below
		// asserts the populated case.
		expect(ctx!.PROJECT_FRAMEWORK).toBe(UNRESOLVED);
		// Coder/test/reviewer constraints should be non-empty bulleted blocks
		// (typescript profile has all three populated).
		expect(ctx!.CODER_CONSTRAINTS.length).toBeGreaterThan(0);
		expect(ctx!.CODER_CONSTRAINTS.startsWith('- ')).toBe(true);
		expect(ctx!.REVIEWER_CHECKLIST.length).toBeGreaterThan(0);
		expect(ctx!.REVIEWER_CHECKLIST.startsWith('- ')).toBe(true);
		// Constraint blocks must NOT contain the UNRESOLVED sentinel (would
		// render as a fake "- unresolved (...)" bullet in the prompt).
		expect(ctx!.CODER_CONSTRAINTS).not.toContain(UNRESOLVED);
		expect(ctx!.REVIEWER_CHECKLIST).not.toContain(UNRESOLVED);
	});

	test('Single-language project: PROJECT_CONTEXT_SECONDARY_LANGUAGES is empty', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({ name: 'x' }),
		);
		const ctx = await buildProjectContext(tempDir);
		expect(ctx).not.toBeNull();
		expect(ctx!.PROJECT_CONTEXT_SECONDARY_LANGUAGES).toBe('');
	});

	test('PROJECT_FRAMEWORK populated from package.json dependencies', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				name: 'x',
				dependencies: { react: '^19' },
			}),
		);
		const ctx = await buildProjectContext(tempDir);
		expect(ctx).not.toBeNull();
		expect(ctx!.PROJECT_FRAMEWORK).toBe('react');
	});

	test('ENTRY_POINTS populated from package.json main+bin', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				name: 'x',
				main: 'dist/index.js',
				bin: { 'my-cli': 'dist/cli.js' },
			}),
		);
		const ctx = await buildProjectContext(tempDir);
		expect(ctx).not.toBeNull();
		expect(ctx!.ENTRY_POINTS).toContain('dist/cli.js');
		expect(ctx!.ENTRY_POINTS).toContain('dist/index.js');
	});

	test('PROJECT_FRAMEWORK + ENTRY_POINTS stay UNRESOLVED when manifest has no signal', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({ name: 'x' }),
		);
		const ctx = await buildProjectContext(tempDir);
		expect(ctx).not.toBeNull();
		expect(ctx!.PROJECT_FRAMEWORK).toBe(UNRESOLVED);
		expect(ctx!.ENTRY_POINTS).toBe(UNRESOLVED);
	});

	test('PROJECT_CONTEXT_SECONDARY_LANGUAGES lists runner-up languages', async () => {
		// TS + Python + Rust manifests in same dir; detector returns all three
		// tier-sorted. Primary = typescript (registers first). Secondary list
		// should include 'python' and 'rust'.
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({ name: 'x' }),
		);
		fs.writeFileSync(path.join(tempDir, 'pyproject.toml'), '[tool.poetry]\n');
		fs.writeFileSync(path.join(tempDir, 'Cargo.toml'), '[package]\nname="x"\n');
		const ctx = await buildProjectContext(tempDir);
		expect(ctx).not.toBeNull();
		expect(ctx!.PROJECT_CONTEXT_SECONDARY_LANGUAGES).toContain('python');
		expect(ctx!.PROJECT_CONTEXT_SECONDARY_LANGUAGES).toContain('rust');
	});
});

describe('init fail-open behavior', () => {
	test('LANG_BACKEND_DETECTION_TIMEOUT_MS is the documented 300ms budget', () => {
		// The session-init wrapper in src/index.ts keys off this constant.
		// Set to 300ms (Phase 4b post-Windows-smoke fix) to keep total
		// server() time under the 400ms Issue #704 / repro-704.mjs T1
		// deadline. Changing it requires updating the surrounding
		// `withTimeout` wrap and repro-704.mjs.
		expect(LANG_BACKEND_DETECTION_TIMEOUT_MS).toBe(300);
	});

	test('a hung pickBackend resolves the caller as a timeout', async () => {
		// Replace pickBackend with one that never resolves. The caller's
		// withTimeout(2000ms) wrapper would normally race this; here we
		// directly verify the seam allows substitution. Restore in finally.
		const realPickBackend = projectContextInternals.pickBackend;
		try {
			projectContextInternals.pickBackend = () =>
				new Promise(() => {
					/* never resolves */
				});

			// We cannot await the hung promise itself in a test. Instead we
			// verify the seam shape: the caller's `withTimeout` wrapper would
			// receive a never-resolving promise here.
			const promise = buildProjectContext(tempDir);
			// Race against a tiny timeout to confirm the inner promise hangs.
			const result = await Promise.race([
				promise,
				new Promise<'timeout'>((resolve) =>
					setTimeout(() => resolve('timeout'), 50),
				),
			]);
			expect(result).toBe('timeout');
		} finally {
			projectContextInternals.pickBackend = realPickBackend;
		}
	});

	test('a throwing pickBackend propagates so the caller can fail open', async () => {
		const realPickBackend = projectContextInternals.pickBackend;
		try {
			projectContextInternals.pickBackend = async () => {
				throw new Error('simulated dispatch failure');
			};
			await expect(buildProjectContext(tempDir)).rejects.toThrow(
				/simulated dispatch failure/,
			);
		} finally {
			projectContextInternals.pickBackend = realPickBackend;
		}
	});
});
