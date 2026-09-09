/**
 * Issue #2527 / #2508 — the shared two-step destructive-purge confirmation
 * primitive (`previewDestructivePurge` / `issueConfirmToken` /
 * `executeDestructivePurge`).
 *
 * THE PLAN-CRIT ROUND-2 ITEM-4 OBLIGATION: the token is bound to the digest
 * of the exact candidate SET — (a) a wrong token is rejected; (b) shrinking
 * the scope after issuance REJECTS the original token (digest changed);
 * (c) a re-issued token over the full two-candidate scope executes BOTH;
 * (d) replaying the consumed token is rejected; (e) token-addressed records
 * do not clobber one another and each exact token remains single-use.
 * Preview must be side-effect-free and advertise '--confirm=<token>'.
 *
 * The clock is pinned through `_internals.now` — no Date.now in this file.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	claimDestructivePurge,
	cleanupExpiredDestructivePurgeClaims,
	consumeDestructivePurgeClaim,
	executeDestructivePurge,
	issueConfirmToken,
	type PurgeCandidate,
	previewDestructivePurge,
	verifyDestructivePurgeClaim,
} from '../../../src/commands/destructive-purge';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const PINNED_NOW = 1_800_000_000_000;
const realNow = _internals.now;

let root: string;
let c1: string;
let c2: string;

function candidates(): PurgeCandidate[] {
	return [
		{ path: c1, reason: 'uncommitted or live-owned work' },
		{ path: c2, reason: 'uncommitted or live-owned work' },
	];
}

beforeEach(() => {
	root = canonicalMkdtemp('purge-2527-');
	_internals.now = () => PINNED_NOW;
	c1 = path.join(root, 'lane-1');
	c2 = path.join(root, 'lane-2');
	for (const dir of [c1, c2]) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, 'work.txt'), 'uncommitted\n');
	}
});

afterEach(() => {
	_internals.now = realNow;
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		// Best-effort teardown.
	}
});

describe('destructive purge two-step confirmation (issue #2527 / #2508)', () => {
	test('preview is side-effect-free and advertises the exact option label', () => {
		const plan = previewDestructivePurge(c1, root, {
			candidates: candidates(),
		});

		expect(plan.counts.total).toBe(2);
		expect(plan.optionLabel).toBe('--confirm=<token>');
		expect(plan.previewLines.some((l) => l.includes(c1))).toBe(true);
		expect(plan.previewLines.some((l) => l.includes(c2))).toBe(true);
		expect(plan.previewLines.join('\n')).toContain('DESTROYED');
		// Strictly read-only: no pending record armed, nothing deleted.
		expect(existsSync(path.join(root, '.swarm', 'pending-purge.json'))).toBe(
			false,
		);
		expect(existsSync(c1)).toBe(true);
		expect(existsSync(c2)).toBe(true);
	});

	test('(a) wrong token is rejected and nothing is purged', () => {
		const token = issueConfirmToken(c1, root, { candidates: candidates() });

		const execution = executeDestructivePurge(c1, root, '0'.repeat(24), {
			candidates: candidates(),
		});

		expect(execution.ok).toBe(false);
		expect(execution.reason).toContain('no pending purge');
		expect(existsSync(c1)).toBe(true);
		expect(existsSync(c2)).toBe(true);
		expect(token.length).toBe(24);
	});

	test('(b) shrinking the candidate set after issuance rejects the token (set digest changed)', () => {
		const token = issueConfirmToken(c1, root, { candidates: candidates() });

		// Operator removed one lane from the scope between preview and
		// confirm — the recorded digest covered BOTH lanes.
		const shrunk = executeDestructivePurge(c1, root, token, {
			candidates: [{ path: c1, reason: 'uncommitted or live-owned work' }],
		});

		expect(shrunk.ok).toBe(false);
		expect(shrunk.reason).toContain('purge scope changed');
		expect(existsSync(c1)).toBe(true);
		expect(existsSync(c2)).toBe(true);
	});

	test('binds an explicit purge kind even when candidate paths are identical', () => {
		const token = issueConfirmToken(c1, root, {
			kind: 'close',
			candidates: candidates(),
		});

		const crossKind = executeDestructivePurge(c1, root, token, {
			kind: 'reset-session',
			candidates: candidates(),
		});

		expect(crossKind.ok).toBe(false);
		expect(crossKind.reason).toContain('purge scope changed');
		expect(existsSync(c1)).toBe(true);
		expect(existsSync(c2)).toBe(true);
	});

	test('(c) re-issued token over the full scope purges BOTH; (d) replay is rejected', () => {
		const staleToken = issueConfirmToken(c1, root, {
			candidates: candidates(),
		});
		// A fresh arming over the SAME full scope (e.g. operator re-ran the
		// preview): the new token is the live one.
		const token = issueConfirmToken(c1, root, { candidates: candidates() });
		expect(token).not.toBe(staleToken);

		const execution = executeDestructivePurge(c1, root, token, {
			candidates: candidates(),
		});

		expect(execution.ok).toBe(true);
		expect(execution.purged).toHaveLength(2);
		expect(existsSync(c1)).toBe(false);
		expect(existsSync(c2)).toBe(false);

		// (d) Single use: the pending record was consumed on execution.
		const replay = executeDestructivePurge(c1, root, token, {
			candidates: candidates(),
		});
		expect(replay.ok).toBe(false);
		expect(replay.reason).toContain('no pending purge');
	});

	test('(e) independent token records do not clobber one another', () => {
		const first = issueConfirmToken(c1, root, { candidates: candidates() });
		const second = issueConfirmToken(c1, root, { candidates: candidates() });

		// Each token has an independent token-addressed record. Claiming the
		// first token must not consume or overwrite the second record.
		const withFirst = executeDestructivePurge(c1, root, first, {
			candidates: candidates(),
		});
		expect(withFirst.ok).toBe(true);
		expect(withFirst.purged).toHaveLength(2);

		const withSecond = executeDestructivePurge(c1, root, second, {
			candidates: candidates(),
		});
		expect(withSecond.ok).toBe(true);
		expect(withSecond.purged).toHaveLength(0);
		expect(
			executeDestructivePurge(c1, root, second, { candidates: candidates() })
				.ok,
		).toBe(false);
	});

	test('claim-only authorization does not delete and consumes exactly once', () => {
		const token = issueConfirmToken(c1, root, { candidates: candidates() });
		const claimed = claimDestructivePurge(c1, root, token, {
			candidates: candidates(),
		});
		expect(claimed.ok).toBe(true);
		expect(claimed.claim).toBeDefined();
		expect(existsSync(c1)).toBe(true);
		expect(existsSync(c2)).toBe(true);

		const verified = verifyDestructivePurgeClaim(claimed.claim!, c1, root, {
			candidates: candidates(),
		});
		expect(verified.ok).toBe(true);
		const consumed = consumeDestructivePurgeClaim(claimed.claim!, root);
		expect(consumed.ok).toBe(true);
		expect(consumeDestructivePurgeClaim(claimed.claim!, root).ok).toBe(false);
		expect(existsSync(c1)).toBe(true);
		expect(existsSync(c2)).toBe(true);
	});

	test('claim verification rejects changed inventory without mutation', () => {
		const token = issueConfirmToken(c1, root, { candidates: candidates() });
		const claimed = claimDestructivePurge(c1, root, token, {
			candidates: candidates(),
		});
		expect(claimed.ok).toBe(true);
		const c3 = path.join(root, 'lane-3');
		mkdirSync(c3, { recursive: true });
		writeFileSync(path.join(c3, 'work.txt'), 'new work\n');
		const changed = verifyDestructivePurgeClaim(claimed.claim!, c1, root, {
			candidates: [
				...candidates(),
				{ path: c3, reason: 'newly discovered work' },
			],
		});
		expect(changed.ok).toBe(false);
		expect(changed.reason).toContain('scope changed');
		expect(existsSync(c1)).toBe(true);
		expect(existsSync(c2)).toBe(true);
		expect(existsSync(c3)).toBe(true);
	});

	test('only one claimant wins the atomic rename', () => {
		const token = issueConfirmToken(c1, root, { candidates: candidates() });
		const first = claimDestructivePurge(c1, root, token, {
			candidates: candidates(),
		});
		const second = claimDestructivePurge(c1, root, token, {
			candidates: candidates(),
		});
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(false);
		expect(existsSync(c1)).toBe(true);
		expect(existsSync(c2)).toBe(true);
	});

	test('claimed residue is non-executable and TTL-cleanable', () => {
		const token = issueConfirmToken(c1, root, { candidates: candidates() });
		const pendingPath = path.join(
			root,
			'.swarm',
			`pending-purge-${token}.json`,
		);
		const pending = JSON.parse(readFileSync(pendingPath, 'utf8')) as {
			scopeDigest: string;
		};
		const claimPath = path.join(
			root,
			'.swarm',
			`pending-purge-${token}-${pending.scopeDigest}.claimed.json`,
		);
		_internals.renameSync(pendingPath, claimPath);

		const execution = executeDestructivePurge(c1, root, token, {
			candidates: candidates(),
		});
		expect(execution.ok).toBe(false);
		expect(execution.reason).toContain('no pending purge');
		expect(existsSync(c1)).toBe(true);
		expect(existsSync(c2)).toBe(true);
		expect(existsSync(claimPath)).toBe(true);

		_internals.now = () => PINNED_NOW + 15 * 60 * 1000 + 1;
		expect(cleanupExpiredDestructivePurgeClaims(root)).toBe(1);
		expect(existsSync(claimPath)).toBe(false);
	});
});
