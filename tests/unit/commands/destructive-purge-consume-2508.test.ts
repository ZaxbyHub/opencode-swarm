import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	consumeConfirmToken,
	executeDestructivePurge,
	issueConfirmToken,
	previewDestructivePurge,
} from '../../../src/commands/destructive-purge';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const tempRoots: string[] = [];
const REAL_NOW = _internals.now;

function makeProject(name: string): { root: string; target: string } {
	const root = canonicalMkdtemp(`2508-consume-${name}-`);
	tempRoots.push(root);
	fs.mkdirSync(path.join(root, '.swarm'), { recursive: true });
	const target = path.join(root, 'lane-a');
	fs.mkdirSync(target, { recursive: true });
	fs.writeFileSync(path.join(target, 'work.txt'), 'lane work\n');
	return { root, target };
}

function restore(): void {
	_internals.now = REAL_NOW;
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

afterEach(restore);

describe('#2508 consumeConfirmToken (token-gate without deletion)', () => {
	test('exact token passes, consumes the record, and deletes nothing', () => {
		const { root, target } = makeProject('pass');
		const token = issueConfirmToken(target, root, {
			kind: 'swarm-close',
			candidates: [{ path: target, reason: 'confirmed scope' }],
		});
		const verdict = consumeConfirmToken(target, root, token, {
			kind: 'swarm-close',
			candidates: [{ path: target, reason: 'confirmed scope' }],
		});
		expect(verdict.ok).toBe(true);
		// consumeConfirmToken never deletes: the caller owns the work.
		expect(fs.existsSync(target)).toBe(true);
	});

	test('wrong token is rejected without consuming', () => {
		const { root, target } = makeProject('wrong');
		const token = issueConfirmToken(target, root, {
			kind: 'swarm-close',
			candidates: [{ path: target, reason: 'confirmed scope' }],
		});
		const verdict = consumeConfirmToken(target, root, `${token}x`, {
			kind: 'swarm-close',
			candidates: [{ path: target, reason: 'confirmed scope' }],
		});
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toMatch(/mismatch/);
		// The record survives a failed attempt: the correct token still works.
		const retry = consumeConfirmToken(target, root, token, {
			kind: 'swarm-close',
			candidates: [{ path: target, reason: 'confirmed scope' }],
		});
		expect(retry.ok).toBe(true);
	});

	test('replay after successful consumption is rejected (one-shot)', () => {
		const { root, target } = makeProject('replay');
		const token = issueConfirmToken(target, root, {
			kind: 'swarm-close',
			candidates: [{ path: target, reason: 'confirmed scope' }],
		});
		const first = consumeConfirmToken(target, root, token, {
			kind: 'swarm-close',
			candidates: [{ path: target, reason: 'confirmed scope' }],
		});
		expect(first.ok).toBe(true);
		const replay = consumeConfirmToken(target, root, token, {
			kind: 'swarm-close',
			candidates: [{ path: target, reason: 'confirmed scope' }],
		});
		expect(replay.ok).toBe(false);
		expect(replay.reason).toMatch(/no pending purge/);
	});

	test('scope change between issuance and confirmation is rejected', () => {
		const { root, target } = makeProject('scope');
		const other = path.join(root, 'lane-b');
		fs.mkdirSync(other, { recursive: true });
		const token = issueConfirmToken(target, root, {
			kind: 'swarm-close',
			candidates: [{ path: target, reason: 'confirmed scope' }],
		});
		// A different candidate set at confirmation time: digest mismatch.
		const verdict = consumeConfirmToken(target, root, token, {
			kind: 'swarm-close',
			candidates: [
				{ path: target, reason: 'confirmed scope' },
				{ path: other, reason: 'added later' },
			],
		});
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toMatch(/scope changed/);
	});

	test('kind binds the digest: a token minted for one surface cannot be consumed by another', () => {
		const { root, target } = makeProject('kind');
		const token = issueConfirmToken(target, root, {
			kind: 'swarm-close',
			candidates: [{ path: target, reason: 'confirmed scope' }],
		});
		// Same candidate paths, DIFFERENT destructive surface (reset-session):
		// the digest is kind-bound, so the token is rejected.
		const verdict = consumeConfirmToken(target, root, token, {
			kind: 'reset-session',
			candidates: [{ path: target, reason: 'confirmed scope' }],
		});
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toMatch(/scope changed/);
		// The matching kind still consumes it (one-shot).
		const same = consumeConfirmToken(target, root, token, {
			kind: 'swarm-close',
			candidates: [{ path: target, reason: 'confirmed scope' }],
		});
		expect(same.ok).toBe(true);
	});

	test('expired TTL reads as absent (no pending purge)', () => {
		const { root, target } = makeProject('ttl');
		const PINNED_NOW = 1_800_000_000_000;
		_internals.now = () => PINNED_NOW;
		const token = issueConfirmToken(target, root, {
			kind: 'swarm-close',
			candidates: [{ path: target, reason: 'confirmed scope' }],
		});
		// 16 minutes later: past the 15-minute TTL.
		_internals.now = () => PINNED_NOW + 16 * 60_000;
		const verdict = consumeConfirmToken(target, root, token, {
			kind: 'swarm-close',
			candidates: [{ path: target, reason: 'confirmed scope' }],
		});
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toMatch(/no pending purge/);
	});

	test('executeDestructivePurge semantics unchanged by the refactor (C4 parity)', () => {
		const { root, target } = makeProject('exec');
		const preview = previewDestructivePurge(target, root, {
			kind: 'swarm-close',
			candidates: [{ path: target, reason: 'confirmed scope' }],
		});
		expect(preview.counts.total).toBe(1);
		expect(preview.optionLabel).toBe('--confirm=<token>');
		const token = issueConfirmToken(target, root, {
			kind: 'swarm-close',
			candidates: [{ path: target, reason: 'confirmed scope' }],
		});
		const executed = executeDestructivePurge(target, root, token, {
			kind: 'swarm-close',
			candidates: [{ path: target, reason: 'confirmed scope' }],
		});
		expect(executed.ok).toBe(true);
		expect(executed.purged).toEqual([target]);
		expect(fs.existsSync(target)).toBe(false);
	});
});
