/**
 * Shared fixture seeding for test trees that run the check-invariants gate.
 *
 * `checkQuarantineMetadata` (Check 7, issue #2477) fail-closes when a
 * quarantine list file is missing, so every fixture tree that executes the
 * gate must carry the four lists. Header-only content has no active entries
 * and passes the metadata check. The Bash owner (the archived
 * scripts/check-invariants.sh) never reads these files, so seeding is inert
 * on bash-leg runs.
 *
 * Kept as one shared helper because the list set must stay in sync with
 * QUARANTINE_LIST_FILES in scripts/check-invariants.ts — a fixture that
 * misses a list would fail Check 7 for a reason unrelated to the regression
 * it exists to detect.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { QUARANTINE_LIST_FILES } from '../../scripts/check-invariants';

// Derived from the gate's own constant (single source of truth) so a list
// added to or removed from Check 7 cannot drift out of the fixtures
// (review F-006/PRR-010).
export const QUARANTINE_LIST_FILE_NAMES: readonly string[] =
	QUARANTINE_LIST_FILES.map((rel) => rel.slice(rel.lastIndexOf('/') + 1));

export function seedQuarantineListFiles(fixtureDir: string): void {
	fs.mkdirSync(path.join(fixtureDir, 'scripts', 'ci'), { recursive: true });
	for (const listName of QUARANTINE_LIST_FILE_NAMES) {
		fs.writeFileSync(
			path.join(fixtureDir, 'scripts', 'ci', listName),
			'# fixture quarantine list — header only, no active entries\n',
			'utf8',
		);
	}
}

/**
 * Expected check-invariants output for the #2094 legacy-oracle fixture
 * (1 seeded process.cwd() violation, header-only quarantine lists).
 *
 * The TS owner gained Check 7 (quarantine OWNER/EXPIRY metadata, issue
 * #2477) — a TS-only check the archived Bash owner can never emit — so the
 * oracle's full-output byte parity is intentionally superseded: the TS leg
 * pins this seven-check output exactly; the archived owner keeps its frozen
 * six-check diagnostics (legacyExpected).
 */
const SIX_CHECK_BLOCK = [
	'=== Check 1: Subprocess timeout required (advisory) ===',
	'=== Check 2: process.cwd() ban in tools/hooks ===',
	'ERROR: src/tools/cwd-violation.ts uses process.cwd() — tools must use ctx.directory via resolveWorkingDirectory',
	'=== Check 3: mock.module allowlist ===',
	'',
	'=== Check 4: mock.module allowlist growth ratchet (issue #1666) ===',
	'Base entries: 0 | Head entries: 0 | Added in this PR: 0 | Approved-new markers found: 0 | Unapproved: 0',
	'',
	'=== Check 5: knowledge array dedup guardrail (issue #1821 Lane 0b) ===',
	'Scope: src/tools/knowledge-*.ts src/hooks/knowledge-*.ts src/hooks/curator.ts src/hooks/micro-reflector.ts src/knowledge/*.ts src/learning/*.ts src/services/recommendation-ledger.ts src/consensus/*.ts',
	'Files scanned: 8',
	'Unguarded positional caps: 0 (expected 0 — no exempt list by design)',
	'=== Check 6: no raw pendingAdvisoryMessages.push outside the helper (issue #1976) ===',
	'=== Check: no raw pendingAdvisoryMessages.push outside src/utils/advisory-queue.ts (issue #1976) ===',
	'OK — all advisory pushes route through pushAdvisory().',
];

export function buildInvariantsOracleExpected(): {
	tsExpected: string;
	legacyExpected: string;
} {
	const tsExpected = [
		...SIX_CHECK_BLOCK,
		'=== Check 7: quarantine entries carry OWNER + EXPIRY metadata (issue #2477) ===',
		'All active quarantine entries carry OWNER + EXPIRY metadata.',
		'',
		'=== Summary ===',
		'Checks run: 1 (subprocess timeout, advisory) | 2 (process.cwd ban) |',
		'            3 (mock.module allowlist) | 4 (allowlist growth ratchet) |',
		'            5 (knowledge array dedup guardrail) | 6 (advisory-injection ratchet) |',
		'            7 (quarantine OWNER/EXPIRY metadata)',
		'1 invariant violation(s) found.',
	].join('\n');
	const legacyExpected = [
		...SIX_CHECK_BLOCK,
		'',
		'=== Summary ===',
		'Checks run: 1 (subprocess timeout, advisory) | 2 (process.cwd ban) |',
		'            3 (mock.module allowlist) | 4 (allowlist growth ratchet) |',
		'            5 (knowledge array dedup guardrail) | 6 (advisory-injection ratchet)',
		'1 invariant violation(s) found.',
	].join('\n');
	return { tsExpected, legacyExpected };
}
