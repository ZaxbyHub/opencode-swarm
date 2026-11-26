/**
 * #3822 promotion-record lookup semantics — indeterminate causes (FB-101 /
 * RP-001 / IA-001), revoked-record shadowing (FB-102), and the per-call
 * scope index (RP-002).
 *
 * Lookup-level contract under test:
 *
 *   - ENOENT on the store readdir is `not-found`; any OTHER error code is
 *     `indeterminate` with reason `unreadable-store` (IA-001).
 *   - A corrupt / oversized / unreadable record file is `indeterminate` with
 *     a DISTINCT reason and the bounded record file NAME as detail — never
 *     content (FB-101/RP-001).
 *   - Records whose current `evaluation_verdict` is not `promoted` (e.g. a
 *     successful revoke stamps `revoked`) NEVER bind a path; when several
 *     records match one path the `promoted` one wins regardless of readdir
 *     order (FB-102).
 *   - `withPromotionRecordIndex` builds ONE bounded index per scope: N
 *     lookups inside a scope cost one scan, the index is discarded at scope
 *     exit, and two sequential top-level calls observe in-place record edits
 *     (RP-002 — no cross-call persistence).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals as identityInternals,
	lookupPromotionRecordByPathSync,
	MAX_PROMOTION_RECORD_FILES,
	PROMOTION_RECORD_MAX_BYTES,
	type PromotionRecordLookup,
	readBoundedFileSync,
	withPromotionRecordIndex,
} from '../../../src/services/external-skill-identity.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const HEX64 =
	'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function candidatesDir(projectDir: string): string {
	return path.join(projectDir, '.swarm', 'skills', 'candidates');
}

function recordPath(projectDir: string, name: string): string {
	return path.join(candidatesDir(projectDir), `${name}.json`);
}

/** A minimal promoted record bound to `targetPath` with hash `hash`. */
function promotedRecordJson(
	targetPath: string,
	hash: string,
	verdict: string = 'promoted',
): string {
	return JSON.stringify({
		id: '00000000-0000-4000-a000-000000000001',
		evaluation_verdict: verdict,
		evaluation_history: [
			{
				verdict: 'promoted',
				timestamp: '2026-01-15T12:00:00.000Z',
				actor: 'user',
				reason: 'promoted for lookup tests',
				target_path: targetPath,
				promoted_content_hash: hash,
			},
		],
	});
}

function writeRecord(projectDir: string, name: string, json: string): void {
	fs.mkdirSync(candidatesDir(projectDir), { recursive: true });
	fs.writeFileSync(recordPath(projectDir, name), json, 'utf-8');
}

function lookup(
	projectDir: string,
	artifactPath: string,
): PromotionRecordLookup {
	return lookupPromotionRecordByPathSync(projectDir, artifactPath);
}

describe('lookupPromotionRecordByPathSync — indeterminate causes (FB-101/RP-001/IA-001)', () => {
	let projectDir: string;
	let artifactPath: string;
	const originalReaddir = identityInternals.readdirSync;
	const originalOpen = identityInternals.openSync;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('ext-skill-lookup-');
		artifactPath = path.join(
			projectDir,
			'.opencode',
			'skills',
			'generated',
			'lookup-target',
			'SKILL.md',
		);
	});

	afterEach(() => {
		identityInternals.readdirSync = originalReaddir;
		identityInternals.openSync = originalOpen;
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test('ENOENT (no store) is not-found, not indeterminate', () => {
		const result = lookup(projectDir, artifactPath);
		expect(result).toEqual({ status: 'not-found' });
	});

	test('any other readdir error code is indeterminate unreadable-store naming the code', () => {
		identityInternals.readdirSync = ((dir: unknown) => {
			throw Object.assign(new Error(String(dir)), { code: 'EACCES' });
		}) as typeof fs.readdirSync;
		fs.mkdirSync(candidatesDir(projectDir), { recursive: true });

		const result = lookup(projectDir, artifactPath);
		expect(result.status).toBe('indeterminate');
		if (result.status === 'indeterminate') {
			expect(result.reason).toBe('unreadable-store');
			expect(result.detail).toBe('EACCES');
		}
	});

	test('a corrupt record is indeterminate corrupt-record naming the record file', () => {
		writeRecord(projectDir, 'corrupt-one', '{ this is not json');
		const result = lookup(projectDir, artifactPath);
		expect(result.status).toBe('indeterminate');
		if (result.status === 'indeterminate') {
			expect(result.reason).toBe('corrupt-record');
			expect(result.detail).toBe('corrupt-one.json');
		}
	});

	test('an oversized record is indeterminate oversized-record naming the record file', () => {
		fs.mkdirSync(candidatesDir(projectDir), { recursive: true });
		// Over the per-file bound by exactly one byte; valid JSON shape is
		// irrelevant because the bound fires before parsing.
		fs.writeFileSync(
			recordPath(projectDir, 'huge-one'),
			`${'x'.repeat(PROMOTION_RECORD_MAX_BYTES + 1)}`,
			'utf-8',
		);
		const result = lookup(projectDir, artifactPath);
		expect(result.status).toBe('indeterminate');
		if (result.status === 'indeterminate') {
			expect(result.reason).toBe('oversized-record');
			expect(result.detail).toBe('huge-one.json');
		}
	});

	test('a record at EXACTLY the byte bound still parses and binds', () => {
		// The bound is strict (`size > limit`), so an at-boundary record is
		// readable. Pad with trailing whitespace after the JSON — JSON.parse
		// tolerates it — to hit exactly PROMOTION_RECORD_MAX_BYTES bytes.
		const base = promotedRecordJson(artifactPath, HEX64);
		expect(base.length).toBeLessThan(PROMOTION_RECORD_MAX_BYTES);
		writeRecord(
			projectDir,
			'at-boundary',
			`${base}${' '.repeat(PROMOTION_RECORD_MAX_BYTES - base.length)}`,
		);
		const result = lookup(projectDir, artifactPath);
		expect(result.status).toBe('found');
	});

	test('an unopenable record is indeterminate unreadable-record naming the record file', () => {
		writeRecord(
			projectDir,
			'locked-one',
			promotedRecordJson(artifactPath, HEX64),
		);
		identityInternals.openSync = ((p: unknown, ...rest: unknown[]) => {
			if (typeof p === 'string' && p.endsWith('locked-one.json')) {
				throw Object.assign(new Error(String(p)), { code: 'EBUSY' });
			}
			return originalOpen(p as never, ...(rest as [never]));
		}) as typeof fs.openSync;

		const result = lookup(projectDir, artifactPath);
		expect(result.status).toBe('indeterminate');
		if (result.status === 'indeterminate') {
			expect(result.reason).toBe('unreadable-record');
			expect(result.detail).toBe('locked-one.json');
		}
	});

	test('more record files than the scan cap is indeterminate over-cap', () => {
		// Report cap+1 files through the readdir seam (restored in afterEach)
		// rather than writing ~1000 real files, which is slow and
		// timing-flaky on Windows; the cap is checked on the listing alone.
		const names = Array.from(
			{ length: MAX_PROMOTION_RECORD_FILES + 1 },
			(_, i) => `filler-${i}.json`,
		);
		identityInternals.readdirSync = (() =>
			names) as unknown as typeof fs.readdirSync;
		const result = lookup(projectDir, artifactPath);
		expect(result.status).toBe('indeterminate');
		if (result.status === 'indeterminate') {
			expect(result.reason).toBe('over-cap');
		}
	});

	test('a readable matching record WINS over a later corrupt unrelated record', () => {
		writeRecord(
			projectDir,
			'aaa-good',
			promotedRecordJson(artifactPath, HEX64),
		);
		writeRecord(projectDir, 'zzz-corrupt', '{ nope');
		const result = lookup(projectDir, artifactPath);
		expect(result.status).toBe('found');
	});
});

describe('lookupPromotionRecordByPathSync — revoked-record shadowing (FB-102)', () => {
	let projectDir: string;
	let artifactPath: string;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('ext-skill-revoke-shadow-');
		artifactPath = path.join(
			projectDir,
			'.opencode',
			'skills',
			'generated',
			'shadowed',
			'SKILL.md',
		);
	});

	afterEach(() => {
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test('a revoked record never binds the path (skipped entirely)', () => {
		// A successful revoke stamps evaluation_verdict 'revoked' and APPENDS a
		// revoked history entry; the older promoted entry still carries the
		// target_path. Pre-fix, the path-first lookup matched that stale entry
		// and permanently shadowed the slug.
		writeRecord(
			projectDir,
			'revoked-candidate',
			JSON.stringify({
				id: '00000000-0000-4000-a000-000000000002',
				evaluation_verdict: 'revoked',
				evaluation_history: [
					{
						verdict: 'promoted',
						timestamp: '2026-01-15T12:00:00.000Z',
						actor: 'user',
						target_path: artifactPath,
						promoted_content_hash: HEX64,
					},
					{
						verdict: 'revoked',
						timestamp: '2026-02-15T12:00:00.000Z',
						actor: 'user',
					},
				],
			}),
		);
		const result = lookup(projectDir, artifactPath);
		expect(result).toEqual({ status: 'not-found' });
	});

	test('a promoted record is preferred regardless of readdir order (revoke -> re-promote)', () => {
		// Re-promotion of the same slug creates a SECOND record (new candidate
		// id) bound to the same target path. Whichever order readdir returns,
		// the promoted record — not the revoked one — must win.
		const newHash = 'f' + HEX64.slice(1);
		writeRecord(
			projectDir,
			'aaa-revoked',
			promotedRecordJson(artifactPath, HEX64, 'revoked'),
		);
		writeRecord(
			projectDir,
			'zzz-promoted',
			promotedRecordJson(artifactPath, newHash),
		);

		const natural = lookup(projectDir, artifactPath);
		expect(natural.status).toBe('found');
		if (natural.status === 'found') {
			expect(natural.record.promotedContentHash).toBe(newHash);
		}

		// Force the opposite readdir order through the seam.
		const originalReaddir = identityInternals.readdirSync;
		try {
			identityInternals.readdirSync = ((
				dir: fs.PathLike,
				options?: unknown,
			) => {
				const entries = originalReaddir(dir, options as never) as string[];
				return [...entries].sort().reverse();
			}) as typeof fs.readdirSync;
			const reversed = lookup(projectDir, artifactPath);
			expect(reversed.status).toBe('found');
			if (reversed.status === 'found') {
				expect(reversed.record.promotedContentHash).toBe(newHash);
			}
		} finally {
			identityInternals.readdirSync = originalReaddir;
		}
	});
});

describe('withPromotionRecordIndex — per-call scope (RP-002)', () => {
	let projectDir: string;
	let artifactPath: string;
	let otherArtifactPath: string;
	const originalReaddir = identityInternals.readdirSync;
	let readdirCalls: number;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('ext-skill-index-');
		artifactPath = path.join(
			projectDir,
			'.opencode',
			'skills',
			'generated',
			'indexed-a',
			'SKILL.md',
		);
		otherArtifactPath = path.join(
			projectDir,
			'.opencode',
			'skills',
			'generated',
			'indexed-b',
			'SKILL.md',
		);
		writeRecord(projectDir, 'rec-a', promotedRecordJson(artifactPath, HEX64));
		writeRecord(
			projectDir,
			'rec-b',
			promotedRecordJson(otherArtifactPath, `f${HEX64.slice(1)}`),
		);
		readdirCalls = 0;
		identityInternals.readdirSync = ((dir: fs.PathLike, options?: unknown) => {
			readdirCalls += 1;
			return originalReaddir(dir, options as never);
		}) as typeof fs.readdirSync;
	});

	afterEach(() => {
		identityInternals.readdirSync = originalReaddir;
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test('N references over M records inside one scope cost ONE scan', () => {
		const results = withPromotionRecordIndex(projectDir, () => {
			const out: PromotionRecordLookup[] = [];
			for (let i = 0; i < 6; i++) {
				out.push(lookup(projectDir, artifactPath));
				out.push(lookup(projectDir, otherArtifactPath));
			}
			return out;
		});
		expect(readdirCalls).toBe(1);
		expect(results.length).toBe(12);
		expect(results.every((r) => r.status === 'found')).toBe(true);
	});

	test('without a scope every lookup rescans', () => {
		for (let i = 0; i < 3; i++) {
			lookup(projectDir, artifactPath);
		}
		expect(readdirCalls).toBe(3);
	});

	test('two sequential top-level calls observe an in-place record edit', () => {
		const before = lookup(projectDir, artifactPath);
		expect(before.status).toBe('found');

		// In-place edit: flip the verdict to revoked (what a revoke does).
		writeRecord(
			projectDir,
			'rec-a',
			promotedRecordJson(artifactPath, HEX64, 'revoked'),
		);

		const after = lookup(projectDir, artifactPath);
		expect(after.status).toBe('not-found');
	});

	test('scope exit discards the index (edit visible to the next scope)', () => {
		withPromotionRecordIndex(projectDir, () => {
			expect(lookup(projectDir, artifactPath).status).toBe('found');
		});
		writeRecord(
			projectDir,
			'rec-a',
			promotedRecordJson(artifactPath, HEX64, 'revoked'),
		);
		withPromotionRecordIndex(projectDir, () => {
			expect(lookup(projectDir, artifactPath).status).toBe('not-found');
		});
	});
});

describe('readBoundedFileSync — growth during read (Stage B F-006)', () => {
	let projectDir: string;
	const originalReadSync = identityInternals.readSync;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('ext-skill-grow-');
	});

	afterEach(() => {
		identityInternals.readSync = originalReadSync;
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test('a stable file reads back its exact bytes', () => {
		const file = path.join(projectDir, 'stable.json');
		fs.writeFileSync(file, '{"ok":true}', 'utf-8');
		const result = readBoundedFileSync(file, 1024);
		expect(result).toEqual({
			ok: true,
			content: '{"ok":true}',
			size: 11,
		});
	});

	test('bytes arriving past the fstat size fail closed as changed-during-read', () => {
		const file = path.join(projectDir, 'growing.json');
		fs.writeFileSync(file, '{"ok":true}', 'utf-8');
		// Simulate growth after the fstat: the fake readSync never signals EOF
		// and always delivers the full requested length, so the extra byte the
		// bounded read probes for arrives. Pre-fix, the read returned success
		// with exactly st.size bytes and the growth went undetected.
		identityInternals.readSync = ((
			_fd: number,
			buffer: Buffer,
			offset: number,
			length: number,
		) => {
			for (let i = 0; i < length; i++) buffer[offset + i] = 0x78; // 'x'
			return length;
		}) as typeof fs.readSync;

		const result = readBoundedFileSync(file, 1024);
		expect(result).toEqual({ ok: false, code: 'changed-during-read' });
	});

	test('an over-limit file is still rejected before any read', () => {
		const file = path.join(projectDir, 'huge.json');
		fs.writeFileSync(file, 'x'.repeat(65), 'utf-8');
		expect(readBoundedFileSync(file, 64)).toEqual({
			ok: false,
			code: 'exceeds-bound',
		});
	});
});
