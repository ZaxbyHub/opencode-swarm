/**
 * Issue #2041 — unit tests for the trajectory-store usage ratchet
 * (`scripts/check-trajectory-store-usage.ts`), mirroring the #2040
 * shell-audit ratchet's test shape.
 */

import { describe, expect, test } from 'bun:test';
import {
	findViolations,
	stripComments,
	TRAJECTORY_LITERAL,
	TRAJECTORY_MENTION_ALLOWLIST,
	TRAJECTORY_STORE_IMPORT,
	TRAJECTORY_STORE_IMPORT_ALLOWLIST,
} from '../../../scripts/check-trajectory-store-usage';

describe('stripComments', () => {
	test('removes line and block comments but preserves string literals', () => {
		const source = [
			"// comment with 'trajectories' literal",
			'const a = "trajectories";',
			'/* block with trajectories */',
			'const b = 1;',
		].join('\n');
		const stripped = stripComments(source);
		expect(stripped).toContain('const a = "trajectories";');
		expect(stripped).toContain('const b = 1;');
		expect(stripped).not.toContain('comment with');
		expect(stripped).not.toContain('block with');
	});
});

describe('pattern constants', () => {
	test('the import pattern matches static, dynamic, .js, and double-quoted imports', () => {
		expect(TRAJECTORY_STORE_IMPORT.test("from './trajectory-store'")).toBe(
			true,
		);
		expect(
			TRAJECTORY_STORE_IMPORT.test("from '../prm/trajectory-store.js'"),
		).toBe(true);
		expect(TRAJECTORY_STORE_IMPORT.test('from "./trajectory-store"')).toBe(
			true,
		);
		expect(
			TRAJECTORY_STORE_IMPORT.test("import('./prm/trajectory-store.js')"),
		).toBe(true);
		expect(TRAJECTORY_STORE_IMPORT.test("from './replay'")).toBe(false);
	});

	test('the literal pattern matches quoted directory segments only', () => {
		expect(TRAJECTORY_LITERAL.test("path.join(dir, 'trajectories')")).toBe(
			true,
		);
		expect(TRAJECTORY_LITERAL.test('const x = "trajectories";')).toBe(true);
		expect(TRAJECTORY_LITERAL.test('const trajectories = 1;')).toBe(false);
		expect(TRAJECTORY_LITERAL.test('const x = trajectories;')).toBe(false);
	});
});

describe('findViolations', () => {
	const noAllowlists = {};

	test('flags an unregistered importer of the store', () => {
		const violations = findViolations(
			[
				{
					file: 'src/some/new-module.ts',
					source: "import { readTrajectory } from '../prm/trajectory-store';",
				},
			],
			noAllowlists,
			noAllowlists,
		);
		expect(violations).toHaveLength(1);
		expect(violations[0].text).toContain('outside the approved caller set');
	});

	test('flags a raw trajectories/ path literal outside the seam', () => {
		const violations = findViolations(
			[
				{
					file: 'src/some/reader.ts',
					source:
						"const root = path.join(directory, '.swarm', 'trajectories');",
				},
			],
			noAllowlists,
			noAllowlists,
		);
		expect(violations).toHaveLength(1);
		expect(violations[0].line).toBe(1);
		expect(violations[0].text).toContain('path-literal mention');
	});

	test('comment-only mentions do not violate (the gate is fail-closed for CODE)', () => {
		const violations = findViolations(
			[
				{
					file: 'src/some/module.ts',
					source: [
						'/**',
						' * Reads .swarm/trajectories/ for docs.',
						' */',
						'export const x = 1;',
					].join('\n'),
				},
			],
			noAllowlists,
			noAllowlists,
		);
		expect(violations).toHaveLength(0);
	});

	test('a file on BOTH allowlists is exempt from both rules', () => {
		const seamSource =
			"import { x } from './trajectory-store'; const p = 'trajectories';";
		expect(
			findViolations(
				[{ file: 'src/prm/trajectory-store.ts', source: seamSource }],
				TRAJECTORY_STORE_IMPORT_ALLOWLIST,
				TRAJECTORY_MENTION_ALLOWLIST,
			),
		).toHaveLength(0);
	});

	test('an import-allowlisted file is still ratcheted for raw path literals (de-nest regression, maintainer review #2395)', () => {
		// trajectory-logger.ts is an APPROVED importer but NOT on the mention
		// allowlist: a raw .swarm/trajectories literal there must be caught
		// even though the import rule exempts the file.
		const callerSource =
			"import { appendTrajectoryEntry } from '../prm/trajectory-store';\nconst root = path.join(dir, 'trajectories');";
		const violations = findViolations(
			[{ file: 'src/hooks/trajectory-logger.ts', source: callerSource }],
			TRAJECTORY_STORE_IMPORT_ALLOWLIST,
			TRAJECTORY_MENTION_ALLOWLIST,
		);
		expect(violations).toHaveLength(1);
		expect(violations[0].text).toContain('path-literal mention');
	});

	test('the two rules gate on INDEPENDENT allowlists (de-nest property)', () => {
		// A file on the mention allowlist but absent from a given import
		// allowlist must still be import-ratcheted, and vice versa — the
		// literal rule must never be shadowed by import-allowlist membership
		// (maintainer review #2395, finding 1).
		const source =
			"import { readTrajectory } from '../prm/trajectory-store';\nconst p = 'trajectories';";
		const violations = findViolations(
			[{ file: 'src/some/other.ts', source }],
			{ 'src/unrelated.ts': {} }, // empty import allowlist
			{ 'src/some/other.ts': {} }, // file IS mention-allowlisted
		);
		expect(violations).toHaveLength(1);
		expect(violations[0].text).toContain('outside the approved caller set');
	});
});

describe('allowlist integrity (the repo contract)', () => {
	test('every allowlisted importer has a reason and class', () => {
		for (const [file, entry] of Object.entries(
			TRAJECTORY_STORE_IMPORT_ALLOWLIST,
		)) {
			expect(file).toMatch(/^src\/.+\.ts$/);
			expect(entry.reason.length).toBeGreaterThan(10);
			expect(entry.cls.length).toBeGreaterThan(0);
		}
	});

	test('the production caller set is exactly the documented seam', () => {
		// Growing this list is a visible review-time action (issue #2041).
		expect(Object.keys(TRAJECTORY_STORE_IMPORT_ALLOWLIST).sort()).toEqual([
			'src/consensus/corpus.ts',
			'src/hooks/trajectory-logger.ts',
			'src/index.ts',
			'src/prm/index.ts',
			'src/prm/trajectory-store.ts',
			'src/state.ts',
		]);
	});
});
