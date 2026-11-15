/**
 * #3700 item 1 — the shared diff-base resolver memo must not serve a stale
 * committed hop after a candidate ref MOVES while HEAD stays fixed.
 *
 * The memo is keyed by (directory, headSha) and self-invalidates on any HEAD
 * move, but `git fetch` can move `zaxbyhub/main` WITHOUT moving HEAD. A
 * direct exported-consumer call (`getChangedLineRanges`) that runs after such
 * a fetch must resolve FRESH state — the committed hop
 * `<moved zaxbyhub/main>..HEAD` now contains real changes, and a SAST finding
 * on one of those changed lines must classify NEW, not PRE-EXISTING.
 *
 * This test asserts BEHAVIOR ONLY (the exported consumer surface): no memo
 * field access, no internal API shape. It must be RED at the code that
 * disclosed the residual (the second map serves the pre-move HEAD-equal
 * envelope: empty committed hop, so a.txt:2 classifies PRE-EXISTING and the
 * ambiguity consumer stays fail-closed null).
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	classifySastFindings,
	getChangedLineAmbiguousFiles,
	getChangedLineRanges,
} from '../../../src/tools/pre-check-batch.js';
import {
	canonicalMkdtemp,
	canonicalTmpDir,
	removeTreeWithRetry,
} from '../../helpers/tmpdir.js';

// FB-014: the fixture must never inherit the host's global git config (a
// host `commit.gpgsign=true` with no reachable gpg program fails every
// commit). Point GIT_CONFIG_GLOBAL at an EMPTY file so every global key is
// isolated; identity is supplied inline per commit instead.
const isolatedGlobalConfigPaths = new Map<string, string>();
let isolatedGlobalConfigCounter = 0;
function isolatedGlobalConfig(cwd: string): string {
	const existing = isolatedGlobalConfigPaths.get(cwd);
	if (existing !== undefined) return existing;
	isolatedGlobalConfigCounter += 1;
	const target = path.join(
		canonicalTmpDir(),
		`swarm-fixture-global-config-${process.pid}-${isolatedGlobalConfigCounter}`,
	);
	writeFileSync(target, '');
	isolatedGlobalConfigPaths.set(cwd, target);
	return target;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		stdio: ['ignore', 'pipe', 'pipe'],
		encoding: 'utf-8',
		timeout: 20_000,
		windowsHide: true,
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_CONFIG_GLOBAL: isolatedGlobalConfig(cwd),
		},
	});
}

const IDENTITY = [
	'-c',
	'user.email=test@example.com',
	'-c',
	'user.name=Test',
] as const;

function sastFinding(file: string, line: number) {
	return {
		rule_id: 'probe',
		severity: 'high' as const,
		message: 'probe',
		location: { file, line },
	};
}

describe('diff-base memo staleness after a candidate ref move (#3700 item 1)', () => {
	test('a direct getChangedLineRanges call resolves fresh state after zaxbyhub/main is force-moved under a fixed HEAD', async () => {
		const root = canonicalMkdtemp('pre-check-memo-staleness-3700-');
		const repo = path.join(root, 'repo');
		const bare = path.join(root, 'zaxbyhub.git');
		try {
			git(root, 'init', '-q', '-b', 'main', repo);
			git(root, 'init', '-q', '--bare', '-b', 'main', bare);
			git(repo, 'remote', 'add', 'zaxbyhub', bare);
			git(repo, 'config', 'core.autocrlf', 'false');

			// Base: a.txt with two lines, pushed so zaxbyhub/main == base.
			writeFileSync(path.join(repo, 'a.txt'), 'line one\nline two\n');
			git(repo, 'add', 'a.txt');
			git(repo, ...IDENTITY, 'commit', '-q', '-m', 'base');
			const baseSha = git(repo, 'rev-parse', 'HEAD').trim();
			git(repo, 'push', '-q', 'zaxbyhub', 'main');

			// Edit commit changes a.txt line 2, pushed so zaxbyhub/main == HEAD.
			writeFileSync(path.join(repo, 'a.txt'), 'line one\nline two EDITED\n');
			git(repo, 'add', 'a.txt');
			git(repo, ...IDENTITY, 'commit', '-q', '-m', 'edit');
			git(repo, 'push', '-q', 'zaxbyhub', 'HEAD:main');

			// First direct consumer call: the committed hop is HEAD-equal (empty)
			// — acceptable. What matters is that this call seeds the resolver memo
			// for (repo, HEAD) that the second call below must NOT reuse after the
			// candidate ref moves.
			const first = await getChangedLineRanges(repo);
			expect(first).not.toBeNull();

			// Move the candidate ref WITHOUT moving HEAD: force zaxbyhub/main
			// back to the base commit and fetch, so the committed hop
			// zaxbyhub/main..HEAD now contains the a.txt line-2 edit.
			git(repo, 'push', '-q', '--force', 'zaxbyhub', `${baseSha}:main`);
			git(repo, 'fetch', '-q', 'zaxbyhub');

			const second = await getChangedLineRanges(repo);
			expect(second).not.toBeNull();
			// The fresh resolution must see the moved committed hop: a.txt line 2
			// is a changed line. RED at the stale-memo code: the map is the
			// pre-move HEAD-equal envelope (empty), so `second.get('a.txt')` is
			// undefined.
			expect([...(second?.get('a.txt') ?? [])]).toContain(2);
			expect(second?.get('a.txt')).toBeDefined();

			// The classifier is the consumer of the map: a finding on the changed
			// line must be NEW. RED at the stale-memo code: pre-existing.
			const classified = classifySastFindings(
				[sastFinding('a.txt', 2)],
				second,
				repo,
			);
			expect(classified.newFindings).toHaveLength(1);
			expect(classified.preexistingFindings).toHaveLength(0);

			// The ambiguity consumer resolves through the same shared resolver,
			// so it must equally reflect the moved ref: pre-move the HEAD-equal
			// base made it fail closed (null); post-move the merge base is the
			// base commit (not HEAD-equal), so it must resolve to a Set — RED at
			// the stale-memo code, which serves the pre-move null answer again.
			const ambiguous = await getChangedLineAmbiguousFiles(repo);
			expect(ambiguous).not.toBeNull();
		} finally {
			removeTreeWithRetry(root);
		}
	}, 60_000);

	// C1 (critic amendment): the leg above runs its post-move
	// getChangedLineAmbiguousFiles call AFTER a post-move getChangedLineRanges
	// call, so a fix that only refreshed the memo on the ranges path (or one
	// whose fresh ranges call repopulated the memo) would let the ambiguity
	// assertion pass without the ambiguity consumer itself resolving fresh
	// state. This leg isolates the ambiguity consumer: a FRESH fixture
	// directory (the module-global memo is keyed by directory, so a fresh repo
	// cannot inherit the previous test's envelope), the memo seeded through
	// the AMBIGUITY consumer itself, and the ONLY post-move consumer call is
	// getChangedLineAmbiguousFiles — no ranges call anywhere in this test.
	test('C1: getChangedLineAmbiguousFiles called FIRST after the ref move resolves the fresh (non-stale) answer', async () => {
		const root = canonicalMkdtemp('pre-check-memo-staleness-3700-amb-');
		const repo = path.join(root, 'repo');
		const bare = path.join(root, 'zaxbyhub.git');
		try {
			git(root, 'init', '-q', '-b', 'main', repo);
			git(root, 'init', '-q', '--bare', '-b', 'main', bare);
			git(repo, 'remote', 'add', 'zaxbyhub', bare);
			git(repo, 'config', 'core.autocrlf', 'false');

			// Base pushed, then the edit commit pushed so zaxbyhub/main == HEAD.
			writeFileSync(path.join(repo, 'a.txt'), 'line one\nline two\n');
			git(repo, 'add', 'a.txt');
			git(repo, ...IDENTITY, 'commit', '-q', '-m', 'base');
			const baseSha = git(repo, 'rev-parse', 'HEAD').trim();
			git(repo, 'push', '-q', 'zaxbyhub', 'main');
			writeFileSync(path.join(repo, 'a.txt'), 'line one\nline two EDITED\n');
			git(repo, 'add', 'a.txt');
			git(repo, ...IDENTITY, 'commit', '-q', '-m', 'edit');
			git(repo, 'push', '-q', 'zaxbyhub', 'HEAD:main');

			// Seed the memo through the AMBIGUITY consumer: pre-move the
			// HEAD-equal base makes it fail closed (null is the correct
			// pre-move answer, and the resolver memo is now populated for
			// (repo, HEAD)).
			const before = await getChangedLineAmbiguousFiles(repo);
			expect(before).toBeNull();

			// Move the candidate ref WITHOUT moving HEAD, then dirty a.txt in
			// the worktree so the FRESH answer is unambiguous: the committed
			// hop (base..HEAD, containing a.txt) plus the unstaged edit makes
			// a.txt genuinely multi-hop => the fresh ambiguity answer is a Set
			// containing a.txt.
			git(repo, 'push', '-q', '--force', 'zaxbyhub', `${baseSha}:main`);
			git(repo, 'fetch', '-q', 'zaxbyhub');
			writeFileSync(
				path.join(repo, 'a.txt'),
				'line ONE EDITED\nline two EDITED\n',
			);

			// The ONLY consumer call after the ref move. RED at the stale-memo
			// code: the memo hit re-serves the pre-move HEAD-equal envelope and
			// the consumer returns null again instead of {a.txt}.
			const after = await getChangedLineAmbiguousFiles(repo);
			expect(after).not.toBeNull();
			expect(after?.has('a.txt')).toBe(true);
		} finally {
			removeTreeWithRetry(root);
		}
	}, 60_000);
});
