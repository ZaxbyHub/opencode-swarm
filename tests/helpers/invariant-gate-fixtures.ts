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
