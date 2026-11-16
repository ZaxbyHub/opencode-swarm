/**
 * Interpreter eval detection must key on the NORMALIZED interpreter name, not
 * the exact lower-cased first command word (issue #3343).
 *
 * Versioned (`python3.11`), path-qualified (`/usr/bin/python3`), and
 * env-wrapped (`env python`, `/usr/bin/env python3.12`, `command`, `exec`,
 * env flags + VAR=VALUE assignments) spellings with inline-code flags
 * (-c/-e/-r/…) are `interpreter_eval` writes exactly like the bare spelling,
 * while non-eval invocations (`-m`, `--version`, script-file argument) stay
 * unclassified (#1901 carve-out).
 *
 * RED at base, GREEN after the fix (#3343).
 */

import { describe, expect, it } from 'bun:test';
import { detectPosixWrites } from '../../../src/hooks/shell-write-detect';

function expectEvalDetected(command: string): void {
	const analysis = detectPosixWrites(command);
	expect(
		analysis.writes.some((w) => w.category === 'interpreter_eval'),
		`expected interpreter_eval write for: ${command}`,
	).toBe(true);
}

function expectNoEvalWrite(command: string): void {
	const analysis = detectPosixWrites(command);
	expect(
		analysis.writes.some((w) => w.category === 'interpreter_eval'),
		`expected NO interpreter_eval write for: ${command}`,
	).toBe(false);
}

describe('interpreter spelling variants', () => {
	it('detects versioned python3.11 -c as interpreter_eval', () => {
		expectEvalDetected(`python3.11 -c "open('f','w').write('x')"`);
	});

	it('detects versioned ruby3.2 -e as interpreter_eval', () => {
		expectEvalDetected(`ruby3.2 -e "File.write('f','x')"`);
	});

	it('detects versioned perl5.34 -e as interpreter_eval', () => {
		expectEvalDetected(`perl5.34 -e "print 1"`);
	});

	it('detects versioned php8.3 -r as interpreter_eval', () => {
		expectEvalDetected(`php8.3 -r "echo 1;"`);
	});

	it('detects multi-segment versioned node22.0.0 -e as interpreter_eval', () => {
		expectEvalDetected(
			`node22.0.0 -e "require('fs').writeFileSync('out.txt','x')"`,
		);
	});

	it('keeps detecting the bare spelling (anchor, unaffected by the fix)', () => {
		expectEvalDetected(`python -c "open('f','w').write('x')"`);
	});
});

describe('interpreter path and env wrappers', () => {
	it('detects /usr/bin/python3 -c (path-qualified) as interpreter_eval', () => {
		expectEvalDetected(`/usr/bin/python3 -c "print(1)"`);
	});

	it('detects env python -c as interpreter_eval', () => {
		expectEvalDetected(`env python -c "print(1)"`);
	});

	it('detects /usr/bin/env python3.12 -c (versioned behind env path) as interpreter_eval', () => {
		expectEvalDetected(`/usr/bin/env python3.12 -c "print(1)"`);
	});

	it('detects command python -c (transparent command prefix) as interpreter_eval', () => {
		expectEvalDetected(`command python -c "print(1)"`);
	});

	it('detects exec python -c (transparent exec prefix) as interpreter_eval', () => {
		expectEvalDetected(`exec python -c "print(1)"`);
	});

	it('detects env -i VAR=1 python -c (env flags plus assignment) as interpreter_eval', () => {
		expectEvalDetected(`env -i VAR=1 python -c "print(1)"`);
	});
});

describe('interpreter non-eval spellings stay unclassified', () => {
	it('does NOT classify python3.11 -m pytest as interpreter_eval (#1901 carve-out)', () => {
		expectNoEvalWrite('python3.11 -m pytest tests/');
	});

	it('does NOT classify python3.11 --version as interpreter_eval', () => {
		expectNoEvalWrite('python3.11 --version');
	});

	it('does NOT classify /usr/bin/python3 script.py as interpreter_eval', () => {
		expectNoEvalWrite('/usr/bin/python3 script.py');
	});
});
