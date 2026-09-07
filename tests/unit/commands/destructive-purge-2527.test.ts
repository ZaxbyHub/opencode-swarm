/**
 * Issue #2527 / #2508 — the shared two-step destructive-purge confirmation
 * primitive (`previewDestructivePurge` / `issueConfirmToken` /
 * `executeDestructivePurge`).
 *
 * THE PLAN-CRIT ROUND-2 ITEM-4 OBLIGATION: the token is bound to the digest
 * of the exact candidate SET — (a) a wrong token is rejected; (b) shrinking
 * the scope after issuance REJECTS the original token (digest changed);
 * (c) a re-issued token over the full two-candidate scope executes BOTH;
 * (d) replaying the consumed token is rejected; (e) a new issuance
 * overwrites the single slot and the previous token can never execute.
 * Preview must be side-effect-free and advertise '--confirm=<token>'.
 *
 * The clock is pinned through `_internals.now` — no Date.now in this file.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	executeDestructivePurge,
	issueConfirmToken,
	type PurgeCandidate,
	previewDestructivePurge,
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
		expect(execution.reason).toContain('confirm token mismatch');
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

	test('(e) a new issuance overwrites the single slot — the previous token can never execute', () => {
		const first = issueConfirmToken(c1, root, { candidates: candidates() });
		const second = issueConfirmToken(c1, root, { candidates: candidates() });

		// The slot now holds `second`; executing with `first` must fail.
		// (The implementation distinguishes tokens by exact match, so the
		// overwritten token surfaces as a mismatch — same fail-closed
		// outcome as "no pending purge".)
		const withFirst = executeDestructivePurge(c1, root, first, {
			candidates: candidates(),
		});
		expect(withFirst.ok).toBe(false);
		expect(existsSync(c1)).toBe(true);
		expect(existsSync(c2)).toBe(true);

		const withSecond = executeDestructivePurge(c1, root, second, {
			candidates: candidates(),
		});
		expect(withSecond.ok).toBe(true);
		expect(existsSync(c1)).toBe(false);
	});
});
