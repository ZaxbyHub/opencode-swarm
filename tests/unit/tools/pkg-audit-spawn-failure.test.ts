import { afterEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { _internals, pkg_audit } from '../../../src/tools/pkg-audit';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// NO `mock.module` HERE, deliberately. An earlier revision force-mocked
// `isCommandAvailable` to `true` at file scope. `mock.module` registers
// process-wide and `mock.restore()` does NOT unregister it, so that leaked into
// every file loaded afterwards in the same Bun process, skipping the real
// "tool not installed" early returns in `runGoAudit`, `runBundleAudit` and
// `runDartAudit` and failing three `pkg-audit.test.ts` tests in BOTH orders.
// Inside a security-audit tool's suite that is a false-green generator.
//
// It was also unnecessary: neither `runCargoAudit` nor `runNpmAudit` consults
// `isCommandAvailable` at all (only the go/dotnet/bundle/dart/composer paths
// do), so these tests reach the spawn without any availability stub.

// Regression coverage for #2236 Sweep A, FIX 2 (security-relevant): a `cargo
// audit` process-creation failure must be reported with `incomplete: true`
// and a `note`, never as `{clean: true, totalCount: 0}` indistinguishable
// from "cargo audit ran, zero vulnerabilities found."
//
// Drives the failure through the `_internals.bunSpawn` DI seam (not
// `mock.module`, and not a real bad `cwd` — that throws pre-merge and
// returns `spawnError` post-merge, so a real spawn is runtime-dependent).

describe('pkg_audit (cargo) — spawn failure surfaces as incomplete, not clean (#2236 FIX 2)', () => {
	const originalBunSpawn = _internals.bunSpawn;
	let tempDir: string;

	afterEach(() => {
		_internals.bunSpawn = originalBunSpawn;
		mock.restore();
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function getMockContext(directory: string): ToolContext {
		return {
			sessionID: 'test-session',
			messageID: 'test-message',
			agent: 'test-agent',
			directory,
			worktree: directory,
			abort: new AbortController().signal,
			metadata: () => ({}),
			ask: async () => undefined,
		} as ToolContext;
	}

	it('spawnError set (process never started, empty stdout) is reported as incomplete with a note', async () => {
		tempDir = canonicalMkdtemp('pkg-audit-spawn-');
		fs.writeFileSync(
			path.join(tempDir, 'Cargo.toml'),
			'[package]\nname = "test"',
		);

		_internals.bunSpawn = (() => ({
			stdout: { text: async () => '' },
			stderr: { text: async () => '' },
			exited: Promise.resolve(1),
			exitCode: null,
			spawnError: new Error('spawn cargo ENOENT'),
			kill() {},
		})) as typeof _internals.bunSpawn;

		const result = await pkg_audit.execute(
			{ ecosystem: 'cargo' },
			getMockContext(tempDir),
		);
		const parsed = JSON.parse(result);

		// The bug this guards against: empty stdout on a spawn failure falling
		// through to `{clean: true, totalCount: 0}` with no `incomplete` flag —
		// a false clean security audit indistinguishable from "zero vulns found."
		expect(parsed.clean).toBe(true);
		expect(parsed.incomplete).toBe(true);
		expect(parsed.note).toBeDefined();
		expect(parsed.note).toContain('spawn cargo ENOENT');
		expect(parsed.totalCount).toBe(0);
	});

	it('auto ecosystem: cargo spawn failure forces the combined result clean:false via ecosystemsIncomplete', async () => {
		tempDir = canonicalMkdtemp('pkg-audit-spawn-auto-');
		fs.writeFileSync(
			path.join(tempDir, 'Cargo.toml'),
			'[package]\nname = "test"',
		);

		_internals.bunSpawn = (() => ({
			stdout: { text: async () => '' },
			stderr: { text: async () => '' },
			exited: Promise.resolve(1),
			exitCode: null,
			spawnError: new Error('spawn cargo ENOENT'),
			kill() {},
		})) as typeof _internals.bunSpawn;

		const result = await pkg_audit.execute(
			{ ecosystem: 'auto' },
			getMockContext(tempDir),
		);
		const parsed = JSON.parse(result);

		expect(parsed.clean).toBe(false);
		expect(parsed.ecosystemsIncomplete).toContain('cargo');
	});
});

// npm counterpart of FIX 2. Before this guard, a spawn failure survived only
// by accident: empty stdout fell through to `JSON.parse('')`, which threw and
// was caught as "output could not be parsed". That is a parser side effect,
// not a check — it disappears the moment the parse becomes lenient, and the
// reported reason was wrong even while it worked.
describe('pkg_audit (npm) — spawn failure is reported explicitly, not via a JSON.parse accident (#2236)', () => {
	const originalBunSpawn = _internals.bunSpawn;
	let tempDir: string;

	afterEach(() => {
		_internals.bunSpawn = originalBunSpawn;
		mock.restore();
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function ctx(directory: string): ToolContext {
		return {
			sessionID: 'test-session',
			messageID: 'test-message',
			agent: 'test-agent',
			directory,
			worktree: directory,
			abort: new AbortController().signal,
			metadata: () => ({}),
			ask: async () => undefined,
		} as ToolContext;
	}

	it('reports the spawn failure reason rather than a parse error', async () => {
		tempDir = canonicalMkdtemp('pkg-audit-npm-spawn-');
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({ name: 'test', version: '1.0.0' }),
		);

		_internals.bunSpawn = (() => ({
			stdout: { text: async () => '' },
			stderr: { text: async () => '' },
			exited: Promise.resolve(1),
			exitCode: null,
			spawnError: new Error('spawn npm ENOENT'),
			kill() {},
		})) as typeof _internals.bunSpawn;

		const parsed = JSON.parse(
			await pkg_audit.execute({ ecosystem: 'npm' }, ctx(tempDir)),
		);

		expect(parsed.incomplete).toBe(true);
		expect(parsed.totalCount).toBe(0);
		// The reason must name the spawn failure, not a JSON parse problem.
		expect(parsed.note).toContain('spawn npm ENOENT');
		expect(parsed.note).not.toContain('could not be parsed');
	});
});
