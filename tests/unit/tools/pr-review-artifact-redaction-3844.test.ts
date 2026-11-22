/**
 * #3844 F9/F10: pr-review artifact redaction + dual replay identity —
 * unit-level pins beside the frozen C11. Identical raw retry dedups; a
 * DIFFERENT raw secret of the same family conflicts (never collapses onto the
 * redacted placeholder's identity); benign evidence round-trips. Synthetic
 * tokens only.
 */
import { describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
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
	loadOrCreateReplayIdentitySalt as loadOrCreateWithSeam,
	ReplayIdentityUnavailableError,
	readReplayIdentitySidecar,
	replayFingerprint,
	_internals as replayIdentityInternals,
	replaySidecarPath,
	writeReplayIdentityFingerprint,
} from '../../../src/security/replay-identity';
import { _internals as atomicWriteInternals } from '../../../src/utils/atomic-write';

function freshDir(): string {
	return realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sw-3844-identity-')));
}

describe('#3844 replay identity salt lifecycle (Y2)', () => {
	test('create-only: generated once, reused thereafter', () => {
		const dir = freshDir();
		const first = loadOrCreateReplayIdentitySalt(dir);
		const second = loadOrCreateReplayIdentitySalt(dir);
		expect(second.equals(first)).toBe(true);
	});

	test('an interrupted salt write leaves NO residue and the next call succeeds', () => {
		// The salt is published by linking a complete, fsync'd temp file into
		// place, so a failure during the write never leaves a partial (or
		// empty) salt at the final path. A writer that opened the final path
		// first would leave a 0-byte salt that fails the 64-hex check on every
		// later call - a project-wide wedge needing operator repair.
		const dir = freshDir();
		const target = path.join(
			dir,
			'.swarm',
			'pr-review',
			'replay-identity.salt',
		);
		const realWrite = atomicWriteInternals.writeSync;
		atomicWriteInternals.writeSync = () => {
			throw Object.assign(new Error('ENOSPC sim'), { code: 'ENOSPC' });
		};
		try {
			expect(() => loadOrCreateReplayIdentitySalt(dir)).toThrow();
		} finally {
			atomicWriteInternals.writeSync = realWrite;
		}
		expect(existsSync(target)).toBe(false);
		// No manual repair: the next call publishes a whole salt.
		const salt = loadOrCreateReplayIdentitySalt(dir);
		expect(salt.toString('hex')).toMatch(/^[0-9a-f]{64}$/);
	});

	test('EEXIST race: first read misses, wx collides with a concurrent VALID winner — winner is used', () => {
		// The salt is published by LINKING a complete, fsync'd temp file into
		// place, so the final path never exists in a partial state.
		const dir = freshDir();
		const winner = 'ab'.repeat(32); // 64-hex valid salt
		const target = path.join(
			dir,
			'.swarm',
			'pr-review',
			'replay-identity.salt',
		);
		mkdirSync(path.dirname(target), { recursive: true });
		// Between our missed read and the wx create, the concurrent writer
		// lands the file (simulated via the read seam: first call misses).
		let firstRead = true;
		const realRead = replayIdentityInternals.readSaltFileSync;
		replayIdentityInternals.readSaltFileSync = (p: string): string => {
			if (firstRead) {
				firstRead = false;
				throw Object.assign(new Error('ENOENT sim'), { code: 'ENOENT' });
			}
			return realRead(p);
		};
		try {
			// Pre-place the winner so the wx open fails with EEXIST.
			writeFileSync(target, `${winner}\n`, 'utf8');
			const salt = loadOrCreateWithSeam(dir);
			expect(salt.toString('hex')).toBe(winner);
		} finally {
			replayIdentityInternals.readSaltFileSync = realRead;
		}
	});

	test('EEXIST race with a corrupt concurrent winner FAILS CLOSED', () => {
		const dir = freshDir();
		const target = path.join(
			dir,
			'.swarm',
			'pr-review',
			'replay-identity.salt',
		);
		mkdirSync(path.dirname(target), { recursive: true });
		let firstRead = true;
		const realRead = replayIdentityInternals.readSaltFileSync;
		replayIdentityInternals.readSaltFileSync = (p: string): string => {
			if (firstRead) {
				firstRead = false;
				throw Object.assign(new Error('ENOENT sim'), { code: 'ENOENT' });
			}
			return realRead(p);
		};
		try {
			writeFileSync(target, 'not-hex-corrupt\n', 'utf8');
			expect(() => loadOrCreateWithSeam(dir)).toThrow(
				ReplayIdentityUnavailableError,
			);
		} finally {
			replayIdentityInternals.readSaltFileSync = realRead;
		}
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
