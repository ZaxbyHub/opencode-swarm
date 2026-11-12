/**
 * #3131: getChangedLineRanges accepts the first merge-base candidate that
 * resolves, so a stale-but-resolvable `zaxbyhub/main` short-circuits the
 * fresher `origin/main` behind it; the oversized stale..HEAD diff trips the
 * 200k-line parser cap and silently nulls the whole changed-line map.
 *
 * Fixture geometry (probe-3131.ts):
 *   A  base commit — stale `zaxbyhub/main` points here (ancestor of HEAD)
 *   B  bulk commit — adds big.txt with 210,000 lines (fresh `origin/main`)
 *   C  HEAD — small edit on base.txt
 * diff(A..HEAD) exceeds MAX_CHANGED_LINE_ENTRIES (200_000) -> parser null ->
 * map null at base. diff(B..HEAD) is one small hunk -> the usable map.
 *
 * Legs (issue AC2/AC3/AC4):
 *   - cap-overflow fall-through ............ RED at base, GREEN after the fix
 *   - stale-first candidate, fresh fallback  RED at base, GREEN after the fix
 *   - named diagnostic on all-candidates-fail RED at base, GREEN after the fix
 *   - fresh-ref path unchanged .............. GREEN at base (no-regression pin)
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	getChangedLineAmbiguousFiles,
	getChangedLineRanges,
	_internals as preCheckInternals,
} from '../../../src/tools/pre-check-batch';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/** Over MAX_CHANGED_LINE_ENTRIES (200_000) so the committed diff trips the cap. */
const BULK_LINES = 210_000;
/**
 * Short bulk mode: 210,000 one-char lines (~420 KB total) — over the 200k
 * parser cap but UNDER runGit's 2 MB stdout guard, so the failure reaches
 * parseDiffLineRangesChecked itself instead of stdout truncation.
 */
const SHORT_BULK_LINES = 210_000;

let repo: string;

function git(...args: string[]): void {
	execFileSync('git', args, {
		cwd: repo,
		stdio: ['ignore', 'ignore', 'pipe'],
		timeout: 10_000,
		windowsHide: true,
	});
}

function revParseHead(): string {
	return execFileSync('git', ['rev-parse', 'HEAD'], {
		cwd: repo,
		stdio: ['ignore', 'pipe', 'pipe'],
		encoding: 'utf8',
		timeout: 10_000,
		windowsHide: true,
	}).trim();
}

function updateRef(ref: string, sha: string): void {
	execFileSync('git', ['update-ref', ref, sha], {
		cwd: repo,
		stdio: ['ignore', 'ignore', 'pipe'],
		timeout: 10_000,
		windowsHide: true,
	});
}

function commitAll(message: string): void {
	git('add', '-A');
	git('commit', '-q', '-m', message);
}

function initRepo(branch: string): void {
	mkdirSync(repo, { recursive: true });
	git('init', '-q', '-b', branch);
	git('config', 'user.email', 'tests@example.com');
	git('config', 'user.name', 'tests');
	git('config', 'core.autocrlf', 'false');
}

/** Build the A/B/C history on a fresh repo. Returns stale (A) and fresh (B). */
function buildAbcHistory(shortBulk = false): { stale: string; fresh: string } {
	initRepo('trunk');
	// A: base content
	writeFileSync(path.join(repo, 'base.txt'), 'line1\nline2\nline3\n');
	commitAll('A: base');
	const stale = revParseHead();

	// B: bulk commit — long mode (~2.7 MB, over runGit's 2 MB stdout guard)
	// or short mode (~420 KB, under the guard but over the 200k parser cap).
	const bulk = shortBulk
		? Array.from({ length: SHORT_BULK_LINES }, () => 'x').join('\n')
		: Array.from({ length: BULK_LINES }, (_, i) => `bulk ${i}`).join('\n');
	writeFileSync(path.join(repo, 'big.txt'), `${bulk}\n`);
	commitAll('B: bulk');
	const fresh = revParseHead();

	// C: HEAD with a small edit
	writeFileSync(path.join(repo, 'base.txt'), 'line1\nline2 edited\nline3\n');
	commitAll('C: small edit');
	return { stale, fresh };
}

beforeEach(() => {
	repo = canonicalMkdtemp('pcb-merge-base-3131-');
});

afterEach(() => {
	safeRmRecursive(repo);
});

describe('getChangedLineRanges — merge-base candidate selection (#3131)', () => {
	test('cap-overflow fall-through: an over-cap first candidate no longer nulls the whole map (RED at base, GREEN after the fix)', async () => {
		// AC2: a candidate whose committed diff exceeds
		// MAX_CHANGED_LINE_ENTRIES must not null the map without trying the
		// remaining candidates. At base the stale zaxbyhub/main wins, its
		// A..HEAD diff trips the 200k cap, and the union step nulls everything.
		const { stale, fresh } = buildAbcHistory();
		updateRef('refs/remotes/zaxbyhub/main', stale);
		updateRef('refs/remotes/origin/main', fresh);

		const map = await getChangedLineRanges(repo, undefined, []);

		expect(map).not.toBeNull();
	});

	test('stale-first candidate with fresh fallback yields a usable map from the fresh base (RED at base, GREEN after the fix)', async () => {
		// AC1 as a named test: the map must come from the FRESH base (B) —
		// base.txt's C edit is visible from B, while big.txt (added in B
		// itself) is NOT part of the changed set.
		const { stale, fresh } = buildAbcHistory();
		updateRef('refs/remotes/zaxbyhub/main', stale);
		updateRef('refs/remotes/origin/main', fresh);

		const map = await getChangedLineRanges(repo, undefined, []);

		expect(map).not.toBeNull();
		expect(map?.has('base.txt')).toBe(true);
		expect(map?.has('big.txt')).toBe(false);
	});

	test('all-candidates-failed null carries a named diagnostic identifying what was tried (RED at base, GREEN after the fix)', async () => {
		// AC3: with NO usable candidate (no remote-tracking refs, no local
		// main/master — branch is `trunk`), the null return must be
		// accompanied by a diagnostic naming the failure, not a silent null.
		//
		// Capture-seam choice (documented per the check contract): the repo's
		// established logger-capture pattern is spyOn(console, ...) with
		// OPENCODE_SWARM_DEBUG=1 — see tests/unit/commands/registry-warning-output.test.ts.
		// src/utils/logger.ts emits its debug-gated log()/warn() through
		// console.log/console.warn, so spying on both captures a diagnostic
		// routed through either level without mock.module (allowlist-gated,
		// issue #1666). No diagnostic-recording hook exists in
		// src/tools/pre-check-batch.ts _internals at authoring time, so the
		// console seam is the only test-accessible surface.
		initRepo('trunk');
		writeFileSync(path.join(repo, 'base.txt'), 'line1\n');
		commitAll('seed');

		const savedDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {});
		const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const map = await getChangedLineRanges(repo, undefined, []);
			expect(map).toBeNull();
			const captured = [...logSpy.mock.calls, ...warnSpy.mock.calls]
				.map((call) => String(call[0] ?? ''))
				.join('\n');
			expect(captured).toMatch(/base|candidate|merge-base/i);
			// Strengthened per plan-critic round 1 (F2): the diagnostic must
			// name the candidates actually tried, not any matching word.
			expect(captured).toContain('zaxbyhub/main');
		} finally {
			logSpy.mockRestore();
			warnSpy.mockRestore();
			if (savedDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = savedDebug;
			}
		}
	});

	test('fresh-ref path unchanged: a first candidate that is already fresh keeps producing the same map shape (GREEN at base — no-regression pin)', async () => {
		// AC4 fresh-ref leg / AC5: when the FIRST candidate (zaxbyhub/main) is
		// already fresh, behavior is identical to today — non-null map keyed
		// by the small C edit only. This leg passes at base and must stay
		// green after the fix.
		const { fresh } = buildAbcHistory();
		updateRef('refs/remotes/zaxbyhub/main', fresh);

		const map = await getChangedLineRanges(repo, undefined, []);

		expect(map).not.toBeNull();
		expect(map?.has('base.txt')).toBe(true);
		expect(map?.has('big.txt')).toBe(false);
	});

	test('parser-cap path: short-line bulk under the 2MB stdout guard still falls through to the fresh base (RED at base, GREEN after the fix)', async () => {
		// Plan-critic round 1 (F1): the long-bulk fixture's committed diff is
		// ~2.7MB, so runGit's 2MB stdout guard nulls it BEFORE parsing. This
		// leg uses one-char lines (~420KB) so the failure reaches
		// parseDiffLineRangesChecked's 200k-entry cap itself.
		const { stale, fresh } = buildAbcHistory(true);
		updateRef('refs/remotes/zaxbyhub/main', stale);
		updateRef('refs/remotes/origin/main', fresh);

		const map = await getChangedLineRanges(repo, undefined, []);

		expect(map).not.toBeNull();
		expect(map?.has('base.txt')).toBe(true);
		expect(map?.has('big.txt')).toBe(false);
	});

	test('getChangedLineAmbiguousFiles selects the same fresh base on the stale-first fixture (RED at base, GREEN after the fix)', async () => {
		// Plan-critic round 1 (F3): both consumers must resolve the same
		// usable base. big.txt is committed in B (so it is inside the stale
		// A..HEAD committed hop) AND left unstaged-dirty at HEAD — under the
		// stale base it lands in the ambiguous set; under the fresh base B it
		// is outside the committed hop and must NOT be ambiguous.
		const { stale, fresh } = buildAbcHistory();
		updateRef('refs/remotes/zaxbyhub/main', stale);
		updateRef('refs/remotes/origin/main', fresh);
		// Unstaged edit on big.txt at HEAD (NOT committed).
		writeFileSync(path.join(repo, 'big.txt'), 'dirty tail\n');

		const ambiguous = await getChangedLineAmbiguousFiles(repo, undefined, []);

		expect(ambiguous).not.toBeNull();
		expect(ambiguous?.has('big.txt')).toBe(false);
	});

	test('overflow-then-HEAD candidate still fails closed through the #3092 PRR-002 guard (RED at base, GREEN after the fix)', async () => {
		// Plan-critic round 1 (F3): a merge-base equal to HEAD means the
		// committed hop is empty and NON-AUTHORITATIVE. Stale A overflows the
		// resolver, origin/main sits AT HEAD — the resolver must fall through
		// to it, and the HEAD guard must then refuse the discount (null). At
		// base the stale A wins first-valid-wins and the guard never fires,
		// so this leg returns a non-null set and fails here.
		const { stale } = buildAbcHistory();
		const head = revParseHead();
		updateRef('refs/remotes/zaxbyhub/main', stale);
		updateRef('refs/remotes/origin/main', head);

		const ambiguous = await getChangedLineAmbiguousFiles(repo, undefined, []);

		expect(ambiguous).toBeNull();
	});

	test('overflow-then-HEAD candidate fails closed for the RANGES consumer too, not only the ambiguity consumer (GREEN at base, GREEN after the 4.5-review fix)', async () => {
		// 4.5 review F1: the same geometry through getChangedLineRanges —
		// an accepted HEAD-equal base yields an EMPTY committed map that
		// classifySastFindings treats as authoritative (every finding
		// PRE-EXISTING, gate fails OPEN). Base nulls here (stdout-guard on
		// the stale diff); the HEAD-shadow rejection in the resolver must
		// keep it null for this consumer as well.
		const { stale } = buildAbcHistory();
		const head = revParseHead();
		updateRef('refs/remotes/zaxbyhub/main', stale);
		updateRef('refs/remotes/origin/main', head);

		const map = await getChangedLineRanges(repo, undefined, []);

		expect(map).toBeNull();
	});

	test('a systemic merge-base failure stops the walk after ONE spawn instead of fanning six (RED at base, GREEN after the fix)', async () => {
		// Plan-critic round 2 (finding 2): a spawn-level failure (not a
		// per-candidate unresolvable exit) is systemic — every later candidate
		// would fail identically. The resolver must stop after ONE spawn (the
		// upfront rev-parse HEAD leg since the 4.5-review HEAD-shadow check)
		// and return null. At base runGit collapses the failure to
		// "unresolvable" and walks all six candidates after the rev-parse.
		initRepo('trunk');
		writeFileSync(path.join(repo, 'base.txt'), 'line1\n');
		commitAll('seed');

		const savedRun = preCheckInternals.runExternalTool;
		let totalSpawns = 0;
		preCheckInternals.runExternalTool = (async () => {
			totalSpawns++;
			return { status: 'spawn-error' } as never;
		}) as never;
		try {
			const map = await getChangedLineRanges(repo, undefined, []);
			expect(map).toBeNull();
		} finally {
			preCheckInternals.runExternalTool = savedRun;
		}
		expect(totalSpawns).toBe(1);
	});

	test('all-candidates-failed diagnostic is visible WITHOUT OPENCODE_SWARM_DEBUG and names the whole candidate list (RED at base, GREEN after the fix)', async () => {
		// Plan-critic round 2 (finding 6): the named diagnostic must ride an
		// always-visible operational channel (criticalWarn writes to stderr
		// un-gated), not only the debug logger — otherwise production keeps
		// the silent null AC3 rejects. Also asserts the walk covered the full
		// candidate list (first and last refs named).
		initRepo('trunk');
		writeFileSync(path.join(repo, 'base.txt'), 'line1\n');
		commitAll('seed');

		const savedDebug = process.env.OPENCODE_SWARM_DEBUG;
		delete process.env.OPENCODE_SWARM_DEBUG;
		const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const map = await getChangedLineRanges(repo, undefined, []);
			expect(map).toBeNull();
			const captured = warnSpy.mock.calls
				.map((call) => String(call[0] ?? ''))
				.join('\n');
			expect(captured).toContain('zaxbyhub/main');
			expect(captured).toContain('master');
		} finally {
			warnSpy.mockRestore();
			if (savedDebug !== undefined) {
				process.env.OPENCODE_SWARM_DEBUG = savedDebug;
			}
		}
	});
});
