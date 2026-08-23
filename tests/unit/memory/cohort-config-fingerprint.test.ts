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
import { LocalJsonlMemoryProvider } from '../../../src/memory/local-jsonl-provider';
import {
	buildMemoryCohortFingerprintInput,
	classifyStoredFingerprintAlgorithmVersion,
	computeMemoryCohortFingerprint,
	computeRedactionPolicyVersion,
	FINGERPRINT_ALGORITHM_VERSION,
	_internals as fingerprintInternals,
	LEGACY_FINGERPRINT_ALGORITHM_VERSION,
	type MemoryCohortFingerprintInput,
} from '../../../src/memory/redaction';
import { SQLiteMemoryProvider } from '../../../src/memory/sqlite-provider';

function makeTmp(prefix: string): string {
	return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

describe('#1850 cohort config fingerprint inputs (acceptance #10, #13)', () => {
	test('computeRedactionPolicyVersion is deterministic', () => {
		const a = computeRedactionPolicyVersion({ rejectDurableSecrets: true });
		const b = computeRedactionPolicyVersion({ rejectDurableSecrets: true });
		expect(a).toBe(b);
	});

	test('rejectDurableSecrets=true differs from false', () => {
		const withReject = computeRedactionPolicyVersion({
			rejectDurableSecrets: true,
		});
		const withoutReject = computeRedactionPolicyVersion({
			rejectDurableSecrets: false,
		});
		expect(withReject).not.toBe(withoutReject);
		expect(withReject).toBeGreaterThan(withoutReject);
	});

	test('#1466 PII settings change the policy version', () => {
		const base = computeRedactionPolicyVersion({ rejectDurableSecrets: true });
		const withDetect = computeRedactionPolicyVersion({
			rejectDurableSecrets: true,
			detectPii: true,
		});
		const withReject = computeRedactionPolicyVersion({
			rejectDurableSecrets: true,
			rejectDurablePii: true,
		});
		const withNer = computeRedactionPolicyVersion({
			rejectDurableSecrets: true,
			piiDetector: 'ner',
		});
		expect(withDetect).not.toBe(base);
		expect(withReject).not.toBe(base);
		expect(withNer).not.toBe(base);
		expect(withDetect).not.toBe(withReject);
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

	/**
	 * #2062 F-007: golden digest. `computeMemoryCohortFingerprint` uses
	 * `node:crypto` `createHash('sha256')` (redaction.ts) — NOT the
	 * runtime-dependent `bunHash` — so the digest is byte-identical under Bun
	 * and Node and a literal can be pinned safely.
	 *
	 * The input is hand-built rather than derived from DEFAULT_MEMORY_CONFIG on
	 * purpose: `redaction_policy_version` is derived from `SECRET_PATTERNS.length`,
	 * so a config-derived golden would break whenever an unrelated secret pattern
	 * is added. This literal pins the ALGORITHM (canonicalization + sha256 +
	 * 12-char truncation), which is what `FINGERPRINT_ALGORITHM_VERSION` claims.
	 *
	 * The value below was recorded BEFORE the #2062 F-008 undefined-to-null
	 * change to `stableCanonicalStringify` and is unchanged after it — empirical
	 * proof that the change did not invalidate persisted fingerprints.
	 *
	 * #1466: version 2 of the algorithm — the digest changes for unchanged
	 * user config because REDACTION_POLICY_SALT went 1→2 (PII policy fields
	 * joined computeRedactionPolicyVersion) and a secret-pattern family was
	 * added. Per the FINGERPRINT_ALGORITHM_VERSION bump rule this is an
	 * algorithm bump: legacy v1 cohort files fail open via the version gate
	 * with a "re-run /swarm memory link" advisory instead of a false
	 * config-mismatch throw. The golden below pins the v2 algorithm.
	 */
	test('golden digest pins the fingerprint algorithm (version 2)', () => {
		const golden: MemoryCohortFingerprintInput = {
			provider: 'sqlite',
			redaction_policy_version: 2000029,
			embedding_model: 'test-model',
			embedding_dimension: 384,
			embedding_version: 'v1',
		};
		expect(computeMemoryCohortFingerprint(golden)).toBe('125223b54843');
		expect(FINGERPRINT_ALGORITHM_VERSION).toBe(2);
	});

	test('golden digest is independent of key insertion order', () => {
		const reordered = {
			embedding_version: 'v1',
			embedding_dimension: 384,
			embedding_model: 'test-model',
			redaction_policy_version: 2000029,
			provider: 'sqlite',
		} as MemoryCohortFingerprintInput;
		expect(computeMemoryCohortFingerprint(reordered)).toBe('125223b54843');
	});
});

/**
 * #2062 F-012 (R3 fix): the version gate as a pure function. `currentVersion`
 * is what makes a FUTURE bump testable today — the original defect (absent
 * field defaulting to the current version) is invisible while it is still 1.
 */
describe('#2062 F-012 classifyStoredFingerprintAlgorithmVersion', () => {
	test('legacy constant is a standalone literal, and the seam defaults to real', () => {
		// Pins the value, and catches someone editing the literal to a new number.
		// It CANNOT catch `= FINGERPRINT_ALGORITHM_VERSION` aliasing: while that
		// constant is still 1 an alias evaluates to 1 and this passes. The only
		// guard is the `: 1` type in redaction.ts, and it fails `tsc` at the next
		// bump ONLY if that annotation is kept — dropping it typechecks clean.
		expect(LEGACY_FINGERPRINT_ALGORITHM_VERSION).toBe(1);
		expect(fingerprintInternals.currentAlgorithmVersion).toBe(
			FINGERPRINT_ALGORITHM_VERSION,
		);
	});

	test('absent version is legacy v1, NOT the current version', () => {
		// The core bug. With an explicit current an absent field must resolve
		// to 1 and therefore MISMATCH — not silently equal current and
		// byte-compare.
		expect(classifyStoredFingerprintAlgorithmVersion(undefined, 2)).toEqual({
			status: 'mismatch',
			storedVersion: 1,
			currentVersion: 2,
		});
		// #1466 made the real current version 2 (REDACTION_POLICY_SALT bump),
		// so the no-arg call — which compares against the CURRENT version —
		// now also reports a mismatch for absent fields: legacy v1 files fail
		// open with the re-link advisory instead of byte-comparing against a
		// v2 digest.
		expect(classifyStoredFingerprintAlgorithmVersion(undefined)).toEqual({
			status: 'mismatch',
			storedVersion: 1,
			currentVersion: 2,
		});
	});

	test('present but non-numeric version is unknown, never assumed current', () => {
		for (const raw of ['not-a-number', null, true, {}, Number.NaN]) {
			expect(classifyStoredFingerprintAlgorithmVersion(raw)).toEqual({
				status: 'unknown',
			});
			// ...and still unknown under a bump — it never collapses to legacy.
			expect(classifyStoredFingerprintAlgorithmVersion(raw, 2)).toEqual({
				status: 'unknown',
			});
		}
	});

	test('present numeric version compares against the current version', () => {
		expect(classifyStoredFingerprintAlgorithmVersion(2, 2)).toEqual({
			status: 'comparable',
		});
		expect(classifyStoredFingerprintAlgorithmVersion(1, 2)).toEqual({
			status: 'mismatch',
			storedVersion: 1,
			currentVersion: 2,
		});
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
		// Write a cohort-config.json carrying the CURRENT algorithm version
		// with a DELIBERATELY wrong fingerprint. (#1466: without
		// algorithm_version the file is legacy v1, which now takes the
		// version-mismatch fail-open path — see the legacy tests below.)
		writeFileSync(
			path.join(cohortRoot, 'memory-cohort-config.json'),
			JSON.stringify({
				fingerprint: 'deadbeefdead',
				algorithm_version: 2,
			}),
			'utf-8',
		);
		const provider = new SQLiteMemoryProvider(
			dir,
			DEFAULT_MEMORY_CONFIG,
			cohortRoot,
		);
		// initialize MUST throw — the stored fingerprint does not match what
		// this worktree's config computes.
		await expect(provider.initialize()).rejects.toThrow(/fingerprint mismatch/);
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

/**
 * #2062 F-012: the persisted config gained an `algorithm_version` field.
 * Readers must (a) keep validating legacy files that predate the field, and
 * (b) stop byte-comparing digests produced by a DIFFERENT algorithm version,
 * warning and failing open instead of raising the generic "config differs"
 * mismatch error that would be actively misleading in that case.
 */
describe('#2062 F-012 cohort config algorithm_version handling', () => {
	const dirs: string[] = [];
	let prevXdg: string | undefined;
	let prevHome: string | undefined;

	beforeEach(() => {
		prevXdg = process.env.XDG_DATA_HOME;
		prevHome = process.env.HOME;
		const dataDir = makeTmp('fpv-data-');
		dirs.push(dataDir);
		process.env.XDG_DATA_HOME = dataDir;
		process.env.HOME = dataDir;
	});

	afterEach(() => {
		// Restore the bump seam here (not in a per-test try/finally): a throwing
		// test would otherwise leave a simulated version behind and poison every
		// later test in this Bun process.
		fingerprintInternals.currentAlgorithmVersion =
			FINGERPRINT_ALGORITHM_VERSION;
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

	// `warn()` (src/utils/logger.ts) is gated behind OPENCODE_SWARM_DEBUG=1 and
	// writes to console.warn, so capturing console.warn asserts the real
	// operator-facing text without `mock.module` (AGENTS.md section 7).
	async function captureCohortWarnings(
		fn: () => Promise<void>,
	): Promise<string[]> {
		const lines: string[] = [];
		const prevConsoleWarn = console.warn;
		const prevDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		console.warn = (...args: unknown[]) => {
			lines.push(args.map((a) => String(a)).join(' '));
		};
		try {
			await fn();
		} finally {
			console.warn = prevConsoleWarn;
			if (prevDebug === undefined) delete process.env.OPENCODE_SWARM_DEBUG;
			else process.env.OPENCODE_SWARM_DEBUG = prevDebug;
		}
		return lines.filter((l) => l.includes('[memory-cohort]'));
	}

	const hasWarn = (warnings: string[], re: RegExp): boolean =>
		warnings.some((w) => re.test(w));
	const NON_NUMERIC_WARN = /non-numeric `algorithm_version`/;
	const BUMP_WARN =
		/fingerprinted with algorithm version 1, but this worktree computes version 2/;

	function writeStoredConfig(stored: Record<string, unknown>): string {
		const cohortRoot = makeTmp('fpv-cohort-');
		dirs.push(cohortRoot);
		writeFileSync(
			path.join(cohortRoot, 'memory-cohort-config.json'),
			JSON.stringify(stored),
			'utf-8',
		);
		return cohortRoot;
	}

	function worktree(): string {
		const dir = makeTmp('fpv-worktree-');
		dirs.push(dir);
		return dir;
	}

	const matchingFingerprint = (): string =>
		computeMemoryCohortFingerprint(
			buildMemoryCohortFingerprintInput(DEFAULT_MEMORY_CONFIG),
		);

	test('legacy file with no algorithm_version still validates when the fingerprint matches', async () => {
		// Backward-compat guard: files written before the field existed were
		// produced by algorithm version 1, which is the current version, so the
		// byte comparison must still run and still pass. No forced re-link.
		const cohortRoot = writeStoredConfig({
			fingerprint: matchingFingerprint(),
		});
		const provider = new SQLiteMemoryProvider(
			worktree(),
			DEFAULT_MEMORY_CONFIG,
			cohortRoot,
		);
		await provider.initialize();
		provider.close();
	});

	test('legacy file with no algorithm_version fails open after the #1466 v2 bump (no strand)', async () => {
		// Pre-#1466 this test asserted a fail-closed throw for absent-version
		// files. FINGERPRINT_ALGORITHM_VERSION is now 2, so an absent version
		// means legacy v1: digests are not comparable, and the sanctioned
		// upgrade path is fail-open with the re-link advisory (memory is
		// never stranded over an algorithm bump alone).
		const cohortRoot = writeStoredConfig({ fingerprint: 'deadbeefdead' });
		const provider = new SQLiteMemoryProvider(
			worktree(),
			DEFAULT_MEMORY_CONFIG,
			cohortRoot,
		);
		// Opens (warns) instead of throwing.
		await provider.initialize();
		provider.close();
	});

	test('matching algorithm_version keeps the fail-closed mismatch throw', async () => {
		const cohortRoot = writeStoredConfig({
			fingerprint: 'deadbeefdead',
			algorithm_version: FINGERPRINT_ALGORITHM_VERSION,
		});
		const provider = new SQLiteMemoryProvider(
			worktree(),
			DEFAULT_MEMORY_CONFIG,
			cohortRoot,
		);
		await expect(provider.initialize()).rejects.toThrow(/fingerprint mismatch/);
	});

	test('differing algorithm_version fails OPEN instead of throwing the generic mismatch (sqlite)', async () => {
		// The stored fingerprint is deliberately wrong for this config. Under the
		// same algorithm version that is a hard error; across versions the digests
		// are not comparable, so the provider must open and warn instead.
		const cohortRoot = writeStoredConfig({
			fingerprint: 'deadbeefdead',
			algorithm_version: FINGERPRINT_ALGORITHM_VERSION + 1,
		});
		const provider = new SQLiteMemoryProvider(
			worktree(),
			DEFAULT_MEMORY_CONFIG,
			cohortRoot,
		);
		await provider.initialize();
		provider.close();
	});

	test('differing algorithm_version fails OPEN instead of throwing the generic mismatch (local-jsonl)', async () => {
		const cohortRoot = writeStoredConfig({
			fingerprint: 'deadbeefdead',
			algorithm_version: FINGERPRINT_ALGORITHM_VERSION + 1,
		});
		const provider = new LocalJsonlMemoryProvider(
			worktree(),
			DEFAULT_MEMORY_CONFIG,
			cohortRoot,
		);
		await provider.initialize();
	});

	test('local-jsonl still fails closed on a same-version fingerprint mismatch', async () => {
		const cohortRoot = writeStoredConfig({
			fingerprint: 'deadbeefdead',
			algorithm_version: FINGERPRINT_ALGORITHM_VERSION,
		});
		const provider = new LocalJsonlMemoryProvider(
			worktree(),
			DEFAULT_MEMORY_CONFIG,
			cohortRoot,
		);
		await expect(provider.initialize()).rejects.toThrow(/fingerprint mismatch/);
	});

	// Both fail-closed readers must behave identically, so the two cases below
	// run against each of them.
	const PROVIDERS: Array<{
		name: string;
		init: (root: string) => Promise<void>;
	}> = [
		{
			name: 'sqlite',
			init: async (root) => {
				const p = new SQLiteMemoryProvider(
					worktree(),
					DEFAULT_MEMORY_CONFIG,
					root,
				);
				await p.initialize();
				p.close();
			},
		},
		{
			name: 'local-jsonl',
			init: (root) =>
				new LocalJsonlMemoryProvider(
					worktree(),
					DEFAULT_MEMORY_CONFIG,
					root,
				).initialize(),
		},
	];

	for (const { name, init } of PROVIDERS) {
		test(`non-numeric algorithm_version warns and skips, never throws (${name})`, async () => {
			// A present-but-uninterpretable value cannot be attributed to any
			// algorithm, so the digest is not comparable. Assuming "current" would
			// byte-compare on a guess and raise the misleading generic mismatch.
			const cohortRoot = writeStoredConfig({
				fingerprint: 'deadbeefdead',
				algorithm_version: 'not-a-number',
			});
			const warnings = await captureCohortWarnings(() => init(cohortRoot));
			expect(hasWarn(warnings, NON_NUMERIC_WARN)).toBe(true);
			// Distinct from the version-mismatch message, which names two versions.
			expect(hasWarn(warnings, /was fingerprinted with algorithm/)).toBe(false);
		});

		/**
		 * The regression the closeout critic caught. Every reader defaulted an
		 * ABSENT `algorithm_version` to `FINGERPRINT_ALGORITHM_VERSION`, so the
		 * gate could never fire for a legacy file: the first bump to 2 would make
		 * every pre-field file on disk claim version 2, skip the gate, and
		 * byte-compare a v1 digest against a v2 expected value — a hard throw in
		 * the SQLite provider. The stored digest is deliberately wrong, standing
		 * in for a real v1 digest that cannot equal the v2 expectation.
		 */
		test(`legacy file under a simulated version bump warns, never throws (${name})`, async () => {
			fingerprintInternals.currentAlgorithmVersion = 2;
			const cohortRoot = writeStoredConfig({ fingerprint: 'deadbeefdead' });
			const warnings = await captureCohortWarnings(() => init(cohortRoot));
			// The message must name the LEGACY version (1), proving the absent
			// field resolved to the literal, not to the simulated current version.
			expect(hasWarn(warnings, BUMP_WARN)).toBe(true);
		});
	}
});
