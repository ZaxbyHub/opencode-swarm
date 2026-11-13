/**
 * #3652 disclosed bounds (frozen checks C10-C13): the four intentionally
 * bounded dispositions of the #3648 write/delete gate fixes — the quoted-time
 * cd-composition over-deny stays BLOCKED (C10, reserved for the AC16
 * re-spec), the D6 login-shell safe-direction bound keeps the no-write login
 * shell and the quoted `>`-word shapes BLOCKED (C11), a NEW-file write
 * through a lexical link that escapes the workspace stays ADMITTED until
 * scope-root + target canonicalization land together (C12), and GNU rm's
 * rejection of ambiguous option abbreviations keeps `rm --v` ADMITTED under
 * blockDestructive (C13 — nothing deletes either way, safe direction).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { resetSwarmState } from '../../../src/state';
import { gate, linkDir, outsideRoot } from './_shell-write-3616-fixtures';

const T = 60_000;

afterEach(() => {
	resetSwarmState();
});

/** C12 prep: src/leaf is a link to an outside sibling tree. */
function leafLinkPrep(ws: string): void {
	mkdirSync(outsideRoot(ws), { recursive: true });
	linkDir(outsideRoot(ws), path.join(ws, 'src', 'leaf'));
}

describe('#3652 disclosed bounds C10-C13', () => {
	test(
		'C10: env - time sh -c with an in-scope write stays BLOCKED (quoted-time over-deny bound)',
		async () => {
			const r = await gate('env - time sh -c "cd src && echo x > ok.txt"');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		"C11: sudo -i sh -c 'echo hi' stays BLOCKED (login-shell safe-direction bound)",
		async () => {
			const r = await gate("sudo -i sh -c 'echo hi'");
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		"C11: sudo -i echo 'x>y' stays BLOCKED (quoted >-word is not a redirection)",
		async () => {
			const r = await gate("sudo -i echo 'x>y'");
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'C12: echo x > src/leaf/new through a lexical link stays ADMITTED (disclosed bound)',
		async () => {
			// src/leaf is a junction/symlink to an outside sibling; the write
			// lands OUTSIDE the workspace but stays admitted — the disclosed
			// lexical-link bound (full fix needs scope-root + target
			// canonicalization together).
			const r = await gate('echo x > src/leaf/new', { prep: leafLinkPrep });
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'C13: rm --v src/x.txt stays ADMITTED under blockDestructive (GNU rejects ambiguous abbreviations)',
		async () => {
			const r = await gate('rm --v src/x.txt', { blockDestructive: true });
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);
});
