/**
 * #1850: cohort config fingerprint computation (acceptance #10, #13).
 * Verifies the redaction policy version + config fingerprint inputs AND the
 * fail-closed enforcement path in the SQLite provider (final-critic blocking
 * gap: the mismatch throw was previously untested).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DEFAULT_MEMORY_CONFIG } from '../../../src/memory/config';
import {
	buildMemoryCohortFingerprintInput,
	computeMemoryCohortFingerprint,
	computeRedactionPolicyVersion,
} from '../../../src/memory/redaction';
import { SQLiteMemoryProvider } from '../../../src/memory/sqlite-provider';

function makeTmp(prefix: string): string {
	return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

describe('#1850 cohort config fingerprint inputs (acceptance #10, #13)', () => {
	test('computeRedactionPolicyVersion is deterministic', () => {
		const a = computeRedactionPolicyVersion(true);
		const b = computeRedactionPolicyVersion(true);
		expect(a).toBe(b);
	});

	test('rejectDurableSecrets=true differs from false', () => {
		const withReject = computeRedactionPolicyVersion(true);
		const withoutReject = computeRedactionPolicyVersion(false);
		expect(withReject).not.toBe(withoutReject);
		expect(withReject).toBeGreaterThan(withoutReject);
	});

	test('version is a positive integer', () => {
		const v = computeRedactionPolicyVersion(true);
		expect(Number.isInteger(v)).toBe(true);
		expect(v).toBeGreaterThan(0);
	});

	test('computeMemoryCohortFingerprint is deterministic + 12 hex chars', () => {
		const input = buildMemoryCohortFingerprintInput(DEFAULT_MEMORY_CONFIG);
		const a = computeMemoryCohortFingerprint(input);
		const b = computeMemoryCohortFingerprint(input);
		expect(a).toBe(b);
		expect(a).toMatch(/^[a-f0-9]{12}$/);
	});

	test('different provider configs produce different fingerprints', () => {
		const sqliteFp = computeMemoryCohortFingerprint(
			buildMemoryCohortFingerprintInput({
				...DEFAULT_MEMORY_CONFIG,
				provider: 'sqlite',
			}),
		);
		const jsonlFp = computeMemoryCohortFingerprint(
			buildMemoryCohortFingerprintInput({
				...DEFAULT_MEMORY_CONFIG,
				provider: 'local-jsonl',
			}),
		);
		expect(sqliteFp).not.toBe(jsonlFp);
	});
});

describe('#1850 SQLite provider fingerprint enforcement (acceptance #10 fail-closed)', () => {
	const dirs: string[] = [];
	let prevXdg: string | undefined;
	let prevHome: string | undefined;

	beforeEach(() => {
		prevXdg = process.env.XDG_DATA_HOME;
		prevHome = process.env.HOME;
		const dataDir = makeTmp('fp-data-');
		dirs.push(dataDir);
		process.env.XDG_DATA_HOME = dataDir;
		process.env.HOME = dataDir;
	});

	afterEach(() => {
		process.env.XDG_DATA_HOME = prevXdg;
		process.env.HOME = prevHome;
		for (const d of dirs.splice(0)) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	});

	test('F-24: provider opens when no cohort-config.json exists (first-link permissive)', async () => {
		const cohortRoot = makeTmp('fp-cohort-empty-');
		dirs.push(cohortRoot);
		const dir = makeTmp('fp-worktree-');
		dirs.push(dir);
		const provider = new SQLiteMemoryProvider(
			dir,
			DEFAULT_MEMORY_CONFIG,
			cohortRoot,
		);
		// Should not throw — absent config file is the first-link case.
		await provider.initialize();
		provider.close();
	});

	test('F-25: provider throws on fingerprint mismatch (fail-closed, acceptance #10)', async () => {
		const cohortRoot = makeTmp('fp-cohort-mismatch-');
		dirs.push(cohortRoot);
		const dir = makeTmp('fp-worktree-mismatch-');
		dirs.push(dir);
		// Write a cohort-config.json with a DELIBERATELY wrong fingerprint.
		writeFileSync(
			path.join(cohortRoot, 'memory-cohort-config.json'),
			JSON.stringify({ fingerprint: 'deadbeefdead' }),
			'utf-8',
		);
		const provider = new SQLiteMemoryProvider(
			dir,
			DEFAULT_MEMORY_CONFIG,
			cohortRoot,
		);
		// initialize MUST throw — the stored fingerprint does not match what
		// this worktree's config computes.
		expect(provider.initialize()).rejects.toThrow(/fingerprint mismatch/);
	});

	test('F-26: provider opens when fingerprint matches', async () => {
		const cohortRoot = makeTmp('fp-cohort-match-');
		dirs.push(cohortRoot);
		const dir = makeTmp('fp-worktree-match-');
		dirs.push(dir);
		// Write a cohort-config.json with the CORRECT fingerprint for this config.
		const fp = computeMemoryCohortFingerprint(
			buildMemoryCohortFingerprintInput(DEFAULT_MEMORY_CONFIG),
		);
		writeFileSync(
			path.join(cohortRoot, 'memory-cohort-config.json'),
			JSON.stringify({ fingerprint: fp }),
			'utf-8',
		);
		const provider = new SQLiteMemoryProvider(
			dir,
			DEFAULT_MEMORY_CONFIG,
			cohortRoot,
		);
		await provider.initialize();
		provider.close();
	});
});
