/**
 * Issue #3681 item 3b — differential `diff-base fall-through accepted`
 * signal with a per-directory cooldown (frozen acceptance probe C5).
 *
 * Prior buggy behavior: when an overflowing earlier diff-base candidate
 * fell through to a LATER non-HEAD intermediate commit, the acceptance was
 * SILENT — the committed hop was narrowed without any operator signal, so
 * committed changes between the skipped candidate and the accepted base
 * silently classified PRE-EXISTING. The fix emits one console.warn
 * (criticalWarn channel) per directory per 60 s.
 *
 * Legs:
 *  - Positive + cooldown: zaxbyhub/main@A whose committed diff overflows
 *    the 2 MB stdout guard (single >2 MB file), falling through to
 *    origin/main@B (intermediate, non-HEAD) accepted at HEAD=C. Two calls
 *    in the SAME directory: the fall-through acceptance must surface
 *    exactly ONE warning containing the token across both calls (the
 *    second acceptance inside the cooldown window is suppressed).
 *  - Negative: the common stale-upstream geometry (earlier candidate
 *    UNRESOLVABLE — the ref does not exist, later candidate accepted)
 *    emits NO such warning.
 *
 * Console capture uses closure reassignment + finally restore (NOT
 * spyOn). The cooldown record is module-level but keyed per directory, and
 * every leg builds its own fresh temp directory, so leg order cannot
 * suppress another leg's emission.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { getChangedLineRanges } from '../../../src/tools/pre-check-batch.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

const TOKEN = 'diff-base fall-through accepted';
/** ~210k x 12-byte lines ≈ 2.6 MB — over runGit's 2 MB stdout guard. */
const BULK_LINES = 210_000;

function git(cwd: string, ...args: string[]): void {
	execFileSync('git', args, {
		cwd,
		stdio: ['ignore', 'ignore', 'pipe'],
		timeout: 30_000,
		windowsHide: true,
	});
}

function write(root: string, file: string, content: string): void {
	const target = path.join(root, file);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, content);
}

function revParseHead(cwd: string): string {
	return execFileSync('git', ['rev-parse', 'HEAD'], {
		cwd,
		stdio: ['ignore', 'pipe', 'pipe'],
		encoding: 'utf8',
		timeout: 10_000,
		windowsHide: true,
	}).trim();
}

function plantRef(cwd: string, ref: string, sha: string): void {
	execFileSync('git', ['update-ref', ref, sha], {
		cwd,
		stdio: ['ignore', 'ignore', 'pipe'],
		timeout: 10_000,
		windowsHide: true,
	});
}

/** A -> B(bulk) -> C history with zaxbyhub/main@A and origin/main@B. */
function buildAbcHistory(repo: string): void {
	git(repo, 'init', '-q', '-b', 'trunk');
	git(repo, 'config', 'user.email', 'test@example.com');
	git(repo, 'config', 'user.name', 'Test');
	git(repo, 'config', 'core.autocrlf', 'false');
	write(repo, 'base.txt', 'line1\nline2\nline3\n');
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', 'A: base');
	const stale = revParseHead(repo);
	// B: bulk commit — one >2 MB file so diff(A..HEAD) overflows the guard.
	const bulk = Array.from({ length: BULK_LINES }, (_, i) => `bulk ${i}`).join(
		'\n',
	);
	write(repo, 'big.txt', `${bulk}\n`);
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', 'B: bulk');
	const intermediate = revParseHead(repo);
	// C: HEAD — small edit.
	write(repo, 'base.txt', 'line1\nline2 edited\nline3\n');
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', 'C: small edit');
	plantRef(repo, 'refs/remotes/origin/main', intermediate);
	plantRef(repo, 'refs/remotes/zaxbyhub/main', stale);
}

interface WarnCapture {
	warns: string[];
	install(): void;
	restore(): void;
}

function captureWarn(): WarnCapture {
	const original = console.warn;
	const warns: string[] = [];
	return {
		warns,
		install(): void {
			console.warn = (...args: unknown[]) => {
				warns.push(String(args[0] ?? ''));
			};
		},
		restore(): void {
			console.warn = original;
		},
	};
}

function renderMap(map: Map<string, Set<number>> | null): string {
	return map === null ? 'null' : `keys=[${[...map.keys()].sort().join(',')}]`;
}

describe('getChangedLineRanges — diff-base fall-through warning (#3681, C5)', () => {
	test('overflow fall-through to a later non-HEAD base warns exactly once per directory (cooldown across two calls)', async () => {
		const repo = canonicalMkdtemp('pcb-fallthrough-3681-');
		const spy = captureWarn();
		try {
			buildAbcHistory(repo);
			spy.install();
			// Under a cold filesystem the FIRST walk can hit the resolver's
			// spawn timeout on the >2 MB overflow diff and return null
			// without memoizing; the second (warm) walk then performs the
			// fall-through acceptance — so acceptance is asserted across
			// the two calls, and the cooldown across the same two.
			const first = await getChangedLineRanges(repo);
			const second = await getChangedLineRanges(repo);
			const allWarns = [...spy.warns];
			spy.restore();

			const maps = [first, second];
			const accepted = maps.some(
				(map) => map !== null && map.has('base.txt') && !map.has('big.txt'),
			);
			expect(accepted).toBe(true);
			const hits = allWarns.filter((line) => line.includes(TOKEN));
			expect(hits.length).toBe(1);
		} finally {
			spy.restore();
			try {
				removeTreeWithRetry(repo);
			} catch {
				// Windows EBUSY-class teardown noise must not fail the leg.
			}
		}
	}, 120_000);

	test('unresolvable-only skip (missing earlier candidate) stays silent', async () => {
		const repo = canonicalMkdtemp('pcb-staleupstream-3681-');
		const spy = captureWarn();
		try {
			buildAbcHistory(repo);
			// The common geometry: zaxbyhub/main does not exist at all
			// (unresolvable, NOT overflowing) — origin/main@B is accepted
			// directly with no prior unusable attempt, so the differential
			// signal must not fire.
			execFileSync('git', ['update-ref', '-d', 'refs/remotes/zaxbyhub/main'], {
				cwd: repo,
				stdio: ['ignore', 'ignore', 'pipe'],
				timeout: 10_000,
				windowsHide: true,
			});
			spy.install();
			const map = await getChangedLineRanges(repo);
			const warns = [...spy.warns];
			spy.restore();

			expect(map).not.toBeNull();
			expect(map?.has('base.txt')).toBe(true);
			const hits = warns.filter((line) => line.includes(TOKEN));
			expect(hits.length).toBe(0);
		} finally {
			spy.restore();
			try {
				removeTreeWithRetry(repo);
			} catch {
				// Windows EBUSY-class teardown noise must not fail the leg.
			}
		}
	}, 120_000);
});
