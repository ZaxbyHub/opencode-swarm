/**
 * Adversarial security tests for the directive verification predicate runner
 * (Swarm Learning System, Change 2 / Task 2.2).
 *
 * A predicate string is treated as UNTRUSTED. These tests prove:
 *   - Path traversal / absolute paths in grep & file_* handlers are rejected
 *     (result:'error'), never executed against files outside the working dir.
 *   - Command injection in `tool:` cannot run a second command — there is no
 *     shell, so metacharacters are inert and side-effect files are never created.
 *   - Non-allowlisted and path-qualified binaries are rejected.
 *   - Null bytes are rejected.
 *
 * Weak "didn't crash" assertions are intentionally avoided: each case asserts
 * the exact defensive outcome (error/fail) AND, for injection, the ABSENCE of
 * the side effect.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDirectivePredicate } from '../../../src/services/directive-predicate-runner.js';

describe('directive predicate runner — adversarial', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'predicate-adv-'));
		fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'const a = 1;\n');
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// ---- Path traversal ----

	describe('path traversal is blocked', () => {
		for (const glob of [
			'../../../etc/passwd',
			'../outside.ts',
			'src/../../escape.ts',
			'/etc/passwd',
			'/absolute/path.ts',
		]) {
			it(`grep rejects traversal/absolute glob "${glob}"`, async () => {
				const out = await runDirectivePredicate(`grep:root:${glob}`, dir);
				expect(out.result).toBe('error');
			});

			it(`file_modified rejects traversal/absolute path "${glob}"`, async () => {
				const out = await runDirectivePredicate(`file_modified:${glob}`, dir);
				expect(out.result).toBe('error');
			});
		}

		it('does not read a file outside the working directory', async () => {
			// Create a secret OUTSIDE the working dir; ensure no predicate can match it.
			const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-'));
			try {
				fs.writeFileSync(path.join(secretDir, 'secret.txt'), 'TOPSECRET\n');
				const rel = path.relative(dir, path.join(secretDir, 'secret.txt'));
				const out = await runDirectivePredicate(`grep:TOPSECRET:${rel}`, dir);
				// rel starts with ../ → rejected before any execution.
				expect(out.result).toBe('error');
			} finally {
				fs.rmSync(secretDir, { recursive: true, force: true });
			}
		});
	});

	// ---- Command injection ----

	describe('command injection cannot execute a second command', () => {
		const sentinel = () => path.join(dir, 'INJECTED');

		for (const payload of [
			'git --version; touch INJECTED',
			'git --version && touch INJECTED',
			'git --version | touch INJECTED',
			'git $(touch INJECTED)',
			'git `touch INJECTED`',
			'git --version\ntouch INJECTED',
		]) {
			it(`tool: payload "${payload.replace(/\n/g, '\\n')}" creates no side-effect file`, async () => {
				const out = await runDirectivePredicate(`tool:${payload}`, dir);
				// THE security invariant: no shell ran, so the second command
				// (`touch INJECTED`) never executed — the sentinel must not exist.
				// The metacharacters were passed as inert literal args to git.
				expect(fs.existsSync(sentinel())).toBe(false);
				// Sanity: a well-formed enum result (no crash to undefined).
				expect(['pass', 'fail', 'error']).toContain(out.result);
			});
		}
	});

	// ---- Binary allowlist & path-qualified rejection ----

	describe('binary restrictions', () => {
		for (const cmd of [
			'bash -c "rm -rf /"',
			'sh -c "echo pwned"',
			'node -e "process.exit(0)"',
			'python -c "print(1)"',
			'deno eval "Deno.exit(0)"',
		]) {
			it(`tool: rejects non-allowlisted binary in "${cmd}"`, async () => {
				const out = await runDirectivePredicate(`tool:${cmd}`, dir);
				expect(out.result).toBe('error');
				expect(out.detail).toContain('allowlist');
			});
		}

		for (const cmd of ['/bin/sh', './evil.sh', '../bin/git', 'sub/dir/rg']) {
			it(`tool: rejects path-qualified binary "${cmd}"`, async () => {
				const out = await runDirectivePredicate(`tool:${cmd} --version`, dir);
				expect(out.result).toBe('error');
			});
		}
	});

	// ---- Null bytes & flag injection ----

	it('rejects null bytes in a tool command', async () => {
		const out = await runDirectivePredicate('tool:git\0--version', dir);
		expect(out.result).toBe('error');
	});

	it('grep regex beginning with a dash is treated as a pattern, not a flag', async () => {
		// Without the `--` separator a leading-dash regex would be parsed by
		// ripgrep as an unknown flag (a "ripgrep error (exit 2)" outcome). With it,
		// this is a normal search → pass/fail.
		const out = await runDirectivePredicate('grep:-x:src/**/*.ts', dir);
		// On hosts where ripgrep is installed, the `--` separator must make `-x` a
		// pattern, so the predicate completes as pass or fail — never a flag-parse
		// error. On CI runners without ripgrep on PATH, the predicate degrades
		// gracefully to a "ripgrep (rg) not found" error; accept that environment
		// skip but still reject any other (e.g. flag-parse) error.
		const ranAsPattern = out.result === 'pass' || out.result === 'fail';
		const rgUnavailable =
			out.result === 'error' && /not found/i.test(out.detail ?? '');
		expect(ranAsPattern || rgUnavailable).toBe(true);
	});
});
