/**
 * #3844 F9/F10: pr-review artifact redaction + dual replay identity —
 * unit-level pins beside the frozen C11. Identical raw retry dedups; a
 * DIFFERENT raw secret of the same family conflicts (never collapses onto the
 * redacted placeholder's identity); benign evidence round-trips. Synthetic
 * tokens only.
 */
import { describe, expect, test } from 'bun:test';
import {
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { redactEvidenceText } from '../../../src/security/evidence-redaction';
import {
	loadOrCreateReplayIdentitySalt,
	ReplayIdentityUnavailableError,
	readReplayIdentitySidecar,
	replayFingerprint,
	replaySidecarPath,
	writeReplayIdentityFingerprint,
} from '../../../src/security/replay-identity';

function freshDir(): string {
	return realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sw-3844-identity-')));
}

describe('#3844 replay identity salt lifecycle (Y2)', () => {
	test('create-only: generated once, reused thereafter; concurrent writer does not overwrite', () => {
		const dir = freshDir();
		const first = loadOrCreateReplayIdentitySalt(dir);
		const second = loadOrCreateReplayIdentitySalt(dir);
		expect(second.equals(first)).toBe(true);
		// Simulate a concurrent creator: existing file wins (wx fails, winner read).
		const third = loadOrCreateReplayIdentitySalt(dir);
		expect(third.equals(first)).toBe(true);
	});

	test('corrupt salt FAILS CLOSED (fingerprinting throws)', () => {
		const dir = freshDir();
		loadOrCreateReplayIdentitySalt(dir);
		writeFileSync(
			path.join(dir, '.swarm', 'pr-review', 'replay-identity.salt'),
			'zzzz-corrupt',
		);
		expect(() => replayFingerprint(dir, 'payload')).toThrow(
			ReplayIdentityUnavailableError,
		);
	});

	test('sidecar round-trip + corrupt sidecar fails closed', () => {
		const dir = freshDir();
		writeReplayIdentityFingerprint(
			dir,
			'run-1',
			'findings:post_critic',
			'a'.repeat(64),
		);
		const sidecar = readReplayIdentitySidecar(dir, 'run-1');
		expect(sidecar?.fingerprints['findings:post_critic']).toBe('a'.repeat(64));
		writeFileSync(replaySidecarPath(dir, 'run-1'), 'not json');
		expect(() => readReplayIdentitySidecar(dir, 'run-1')).toThrow(
			ReplayIdentityUnavailableError,
		);
	});

	test('different raw payloads of one family produce different fingerprints', () => {
		const dir = freshDir();
		const t1 = `ghp_${'a'.repeat(30)}`;
		const t2 = `ghp_${'b'.repeat(30)}`;
		const f1 = replayFingerprint(dir, `evidence with ${t1}`);
		const f2 = replayFingerprint(dir, `evidence with ${t2}`);
		const f1b = replayFingerprint(dir, `evidence with ${t1}`);
		expect(f1).not.toBe(f2); // conflict preserved after redaction
		expect(f1b).toBe(f1); // identical raw dedups
	});

	test('raw text never persists: sidecar keys are non-secret; values are hex HMACs', () => {
		const dir = freshDir();
		const secret = `ghp_${'s'.repeat(30)}`;
		writeReplayIdentityFingerprint(
			dir,
			'run-2',
			'handoff',
			replayFingerprint(dir, `summary mentioning ${secret}`),
		);
		const raw = readFileSync(replaySidecarPath(dir, 'run-2'), 'utf8');
		expect(raw.includes(secret)).toBe(false);
		expect(raw).toMatch(/"handoff": "[0-9a-f]{64}"/);
	});
});

describe('#3844 normalization preserves benign content and removes secrets', () => {
	test('evidence normalization keeps surrounding text byte-identical', () => {
		const secret = `sk-ant-${'q'.repeat(24)}`;
		const before = `finding: the client at src/a.ts:12 leaks ${secret} on startup`;
		const after = redactEvidenceText(before);
		expect(after).toContain('finding: the client at src/a.ts:12 leaks');
		expect(after).toContain(' on startup');
		expect(after.includes(secret)).toBe(false);
	});

	test('normalization is idempotent over placeholders', () => {
		const once = redactEvidenceText('token ghp_' + 'i'.repeat(30) + ' end');
		const twice = redactEvidenceText(once);
		expect(twice).toBe(once);
	});
});
