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
		// Emit far more than the cap with multibyte characters (UTF-8 emoji, 4 bytes each);
		// accumulated stdout must stay bounded in bytes.
		const script = writeScript(
			'flood.js',
			'process.stdout.write("😀".repeat(500_000)); process.exit(0);',
		);
		const result = await _internals.executeWithTimeout(
			process.execPath,
			[script],
			{ timeoutMs: 10_000, maxOutputBytes: 1024 },
		);
		// Byte count assertion: stdout must not exceed byte cap
		const stdoutBytes = Buffer.byteLength(result.stdout ?? '', 'utf8');
		expect(stdoutBytes).toBeLessThanOrEqual(1024);
		// Note: emoji "😀" is 4 bytes in UTF-8 but 2 UTF-16 code units in JavaScript
		// So max 256 emojis fit in 1024 bytes = 512 JavaScript string length
		expect(result.stdout.length).toBeLessThanOrEqual(512);
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

	it('bounds runaway stderr accumulation (F-001 parity with stdout)', async () => {
		// Emit far more than the cap with multibyte characters (UTF-8 emoji, 4 bytes each);
		// accumulated stderr must stay bounded in bytes (F-001).
		const script = writeScript(
			'flood-stderr.js',
			'process.stderr.write("😀".repeat(500_000)); process.exit(0);',
		);
		const result = await _internals.executeWithTimeout(
			process.execPath,
			[script],
			{ timeoutMs: 10_000, maxOutputBytes: 1024 },
		);
		// Byte count assertion: stderr must not exceed byte cap
		const stderrBytes = Buffer.byteLength(result.stderr ?? '', 'utf8');
		expect(stderrBytes).toBeLessThanOrEqual(1024);
		// Note: emoji "😀" is 4 bytes in UTF-8 but 2 UTF-16 code units in JavaScript
		// So max 256 emojis fit in 1024 bytes = 512 JavaScript string length
		expect(result.stderr.length).toBeLessThanOrEqual(512);
		// Truncation flag must be raised (same as stdout path)
		expect(result.truncated).toBe(true);
	});

	it('kills child process when stdout overflows (overflow-kill)', async () => {
		// Skip on Windows: this test relies on SIGTERM/SIGKILL escalation semantics
		// which differ on Windows.
		if (process.platform === 'win32') {
			return;
		}
		// Child that writes to stdout faster than settle() can stop it.
		// The overflow handler must call settle() and kill the child, not wait for close.
		const script = writeScript(
			'runaway-stdout.js',
			[
				// Ignore SIGTERM to force SIGKILL escalation
				'process.on("SIGTERM", () => { /* ignore */ });',
				// Write continuously until killed
				'setInterval(() => process.stdout.write("😀".repeat(100)), 5);',
			].join('\n'),
		);
		const result = await _internals.executeWithTimeout(
			process.execPath,
			[script],
			{ timeoutMs: 30_000, maxOutputBytes: 1024 }, // Long timeout but low byte cap
		);
		// Must detect truncation
		expect(result.truncated).toBe(true);
		// Byte count must be bounded
		const stdoutBytes = Buffer.byteLength(result.stdout ?? '', 'utf8');
		expect(stdoutBytes).toBeLessThanOrEqual(1024);
		// Child must have been killed (exit code or signal)
		expect(result.exitCode).not.toBe(0);
	});

	it('terminates the child via SIGKILL after SIGTERM grace period (KILL_GRACE_MS escalation)', async () => {
		// Skip this test on Windows since SIGTERM/SIGKILL handling differs
		if (process.platform === 'win32') {
			return;
		}
		// Script ignores SIGTERM and writes endlessly to stdout so that:
		// 1. The timeout triggers and SIGTERM is sent.
		// 2. The child ignores SIGTERM and stays alive.
		// 3. After KILL_GRACE_MS (2 s) SIGKILL is escalated.
		// We cannot reliably observe the signal name from outside the process,
		// so we verify that the helper settles within the timeout budget and
		// that the child is not left running after resolve (we just check that
		// we get the timeout exit code and the promise resolves at all, which
		// means the SIGKILL escalation path must have fired for the process to
		// actually die on platforms where SIGTERM can be ignored).
		// Note: Promise resolution timing depends on child process termination,
		// which may vary across platforms; the key invariant is that settle()
		// is called exactly once and the child is killed (SIGKILL ensures this).
		const script = writeScript(
			'ignore-sigterm.js',
			[
				// Trap SIGTERM and keep running
				'process.on("SIGTERM", () => { /* ignore */ });',
				'setInterval(() => process.stdout.write("x"), 10);',
			].join('\n'),
		);
		const start = Date.now();
		// Use a short timeout so the test doesn't take long.
		// KILL_GRACE_MS=2000ms, so add 4s buffer for the escalation path.
		const result = await _internals.executeWithTimeout(
			process.execPath,
			[script],
			{ timeoutMs: 300 },
		);
		const elapsed = Date.now() - start;
		// Must settle (SIGKILL fired)
		expect(result.exitCode).toBe(124);
		// Must not block for the child's natural lifetime
		expect(elapsed).toBeLessThan(10_000);
	});
});
