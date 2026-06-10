import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals } from '../../../src/sast/semgrep';

/**
 * Tests for the hardened `executeWithTimeout` subprocess helper
 * (DD-C001/DD-C002/DD-C004). These exercise the AGENTS.md invariant-3
 * properties: bounded stdio, a guaranteed timeout, and best-effort kill.
 *
 * The child is the bun runtime itself (`process.execPath`) running a tiny
 * inline script, so the test is cross-platform and needs no external binary.
 */
describe('executeWithTimeout subprocess hardening', () => {
	let tmpDir: string;

	const writeScript = (name: string, body: string): string => {
		const p = path.join(tmpDir, name);
		fs.writeFileSync(p, body, 'utf8');
		return p;
	};

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semgrep-exec-test-'));
	});

	afterAll(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it('returns stdout and exit code for a normal run', async () => {
		const script = writeScript(
			'ok.js',
			'process.stdout.write("hello-world"); process.exit(0);',
		);
		const result = await _internals.executeWithTimeout(
			process.execPath,
			[script],
			{ timeoutMs: 10_000 },
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('hello-world');
	});

	it('terminates a long-running child at the timeout (DD-C002)', async () => {
		// Child stays alive 60s; with a 300ms budget the helper must kill it and
		// settle promptly rather than waiting for the child to exit on its own.
		const script = writeScript('hang.js', 'setTimeout(() => {}, 60_000);');
		const start = Date.now();
		const result = await _internals.executeWithTimeout(
			process.execPath,
			[script],
			{ timeoutMs: 300 },
		);
		const elapsed = Date.now() - start;
		expect(result.exitCode).toBe(124);
		expect(result.stderr).toBe('Process timed out');
		// Settled near the deadline, nowhere near the child's 60s lifetime.
		expect(elapsed).toBeLessThan(10_000);
	});

	it('does not hang when stdin is never closed (DD-C001)', async () => {
		// With stdio stdin: 'ignore', a child that reads stdin sees immediate EOF
		// instead of an open pipe that could block exit under Bun on Windows.
		const script = writeScript(
			'stdin.js',
			[
				'const chunks = [];',
				'process.stdin.on("data", (d) => chunks.push(d));',
				'process.stdin.on("end", () => { process.stdout.write("eof"); process.exit(0); });',
				'process.stdin.resume();',
			].join('\n'),
		);
		const result = await _internals.executeWithTimeout(
			process.execPath,
			[script],
			{ timeoutMs: 10_000 },
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('eof');
	});

	it('bounds runaway stdout accumulation (DD-C004)', async () => {
		// Emit far more than the cap; accumulated stdout must stay bounded.
		const script = writeScript(
			'flood.js',
			'process.stdout.write("x".repeat(500_000)); process.exit(0);',
		);
		const result = await _internals.executeWithTimeout(
			process.execPath,
			[script],
			{ timeoutMs: 10_000, maxOutputBytes: 1024 },
		);
		expect(result.stdout.length).toBeLessThanOrEqual(1024);
		// Truncation must be signaled so runSemgrep does not fail open.
		expect(result.truncated).toBe(true);
	});

	it('does not flag truncation for output within the cap', async () => {
		const script = writeScript(
			'small.js',
			'process.stdout.write("ok"); process.exit(0);',
		);
		const result = await _internals.executeWithTimeout(
			process.execPath,
			[script],
			{ timeoutMs: 10_000, maxOutputBytes: 1024 },
		);
		expect(result.truncated).toBe(false);
	});
});
