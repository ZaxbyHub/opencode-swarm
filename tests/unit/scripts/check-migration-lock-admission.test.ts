/**
 * Pure-function coverage for `checkMigrationLockAdmission` (check:invariants
 * Check 8, issue #2577) — runs against temp fixture trees instead of spawning
 * the full invariant script. Pins the catch-shape scan on PRESENT engine
 * files (the shared oracle fixture only exercises the file-absent NOTE
 * branch), including the CRLF normalization: a Windows autocrlf working copy
 * must not let a swallowing catch scan past its own catch body.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkMigrationLockAdmission } from '../../../scripts/check-invariants';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		try {
			fs.rmSync(root, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup.
		}
	}
});

function makeRepoWithEngine(
	engineBody: string,
	newline: '\n' | '\r\n',
): string {
	const repoDir = canonicalMkdtemp('migration-lock-admission-2577-');
	const enginePath = path.join(
		repoDir,
		'src',
		'memory',
		'memory-family-migration.ts',
	);
	fs.mkdirSync(path.dirname(enginePath), { recursive: true });
	fs.writeFileSync(enginePath, engineBody.split('\n').join(newline), 'utf-8');
	// Minimal fail-closed knowledge-engine stub so the engine-under-test is
	// the only variable: Check 8 now fails closed on missing engine files.
	const stubPath = path.join(
		repoDir,
		'src',
		'knowledge',
		'family-migration.ts',
	);
	fs.mkdirSync(path.dirname(stubPath), { recursive: true });
	fs.writeFileSync(
		stubPath,
		[
			'export async function migrateKnowledgeFamily() {',
			'\tlet destRelease: (() => Promise<void>) | null = null;',
			'\tdestRelease = await lockfile.lock(destinationDir, {});',
			'\ttry {',
			'\t\tawait runMerge();',
			'\t} catch (error) {',
			'\t\tthrow error;',
			'\t} finally {',
			'\t\tif (destRelease) await destRelease();',
			'\t}',
			'}',
		]
			.join('\n')
			.split('\n')
			.join(newline),
		'utf-8',
	);
	tempRoots.push(repoDir);
	return repoDir;
}

const FAIL_CLOSED_ENGINE = [
	'export async function migrateMemoryFamily() {',
	'\tlet destRelease: (() => Promise<void>) | null = null;',
	'\ttry {',
	'\t\tdestRelease = await _internals.lockfile.lock(destStoragePath, {',
	'\t\t\tstale: MIGRATION_LOCK_STALE_MS,',
	'\t\t});',
	'\t} catch (error) {',
	'\t\tthrow makeAdmissionError(error);',
	'\t}',
	'\ttry {',
	'\t\tthrow new Error("late validation failure");',
	'\t} finally {',
	'\t\tif (destRelease) await destRelease();',
	'\t}',
	'}',
].join('\n');

// The FUNCTIONAL-6 defect shape: a later, unrelated throw must NOT satisfy
// the admission catch's fail-closed requirement.
const SWALLOWING_ENGINE = [
	'export async function migrateMemoryFamily() {',
	'\tlet destRelease: (() => Promise<void>) | null = null;',
	'\ttry {',
	'\t\tdestRelease = await _internals.lockfile.lock(destStoragePath, {',
	'\t\t\tstale: MIGRATION_LOCK_STALE_MS,',
	'\t\t});',
	'\t} catch {',
	'\t\t// Local roots may not be lockable; proceed unlocked.',
	'\t}',
	'\tthrow new Error("late validation failure");',
	'}',
].join('\n');

// The live engine's post-fix shape with the real throw mutated away: the
// catch comment still says "This throw stays", and that word inside the
// comment must NOT satisfy the fail-closed scan (Round-2 reviewer finding).
const COMMENT_THROW_SWALLOWING_ENGINE = [
	'export async function migrateMemoryFamily() {',
	'\tlet destRelease: (() => Promise<void>) | null = null;',
	'\ttry {',
	'\t\tdestRelease = await _internals.lockfile.lock(destStoragePath, {',
	'\t\t\tstale: MIGRATION_LOCK_STALE_MS,',
	'\t\t});',
	'\t} catch (error) {',
	'\t\t// #2577 (FUNCTIONAL-6): admission is fail-closed. This throw stays',
	'\t\t// syntactically INSIDE this catch - do not relocate it.',
	'\t\tvoid makeAdmissionError(error);',
	'\t}',
	'\tthrow new Error("late validation failure");',
	'}',
].join('\n');

describe('checkMigrationLockAdmission (Check 8, issue #2577)', () => {
	test('passes a present engine whose admission catch throws (LF)', () => {
		const result = checkMigrationLockAdmission(
			makeRepoWithEngine(FAIL_CLOSED_ENGINE, '\n'),
		);
		expect(result.violations).toBe(0);
		expect(
			result.messages.some((m) =>
				m.includes('destination lock admission fails closed.'),
			),
		).toBe(true);
	});

	test('flags a present engine that swallows the admission failure (LF)', () => {
		const result = checkMigrationLockAdmission(
			makeRepoWithEngine(SWALLOWING_ENGINE, '\n'),
		);
		expect(result.violations).toBe(1);
		expect(
			result.messages.some((m) =>
				m.includes('destination lock acquisition failure is swallowed'),
			),
		).toBe(true);
	});

	test('flags the swallowing engine on a CRLF (autocrlf) working copy', () => {
		// Regression pin for the reviewer-found false negative: the strict
		// catch-close match must not be defeated by trailing CR bytes.
		const result = checkMigrationLockAdmission(
			makeRepoWithEngine(SWALLOWING_ENGINE, '\r\n'),
		);
		expect(result.violations).toBe(1);
		expect(
			result.messages.some((m) =>
				m.includes('destination lock acquisition failure is swallowed'),
			),
		).toBe(true);
	});

	test('flags a swallow whose catch comment merely says "throw" (Round-2 finding)', () => {
		const result = checkMigrationLockAdmission(
			makeRepoWithEngine(COMMENT_THROW_SWALLOWING_ENGINE, '\n'),
		);
		expect(result.violations).toBe(1);
		expect(
			result.messages.some((m) =>
				m.includes('destination lock acquisition failure is swallowed'),
			),
		).toBe(true);
	});

	test('skips with NOTEs when neither engine is present (fixture trees)', () => {
		const repoDir = canonicalMkdtemp('migration-lock-admission-empty-');
		tempRoots.push(repoDir);
		const result = checkMigrationLockAdmission(repoDir);
		// A tree with NO family-migration surface has nothing to scan.
		expect(result.violations).toBe(0);
		expect(result.messages.filter((m) => m.startsWith('NOTE: ')).length).toBe(
			2,
		);
	});

	test('fails closed when exactly one engine file is missing (PRR-R1)', () => {
		// One engine present, the other gone: a rename/move must not silently
		// silence the guardrail's half of the scan.
		const repoDir = canonicalMkdtemp('migration-lock-admission-half-');
		const stubPath = path.join(
			repoDir,
			'src',
			'knowledge',
			'family-migration.ts',
		);
		fs.mkdirSync(path.dirname(stubPath), { recursive: true });
		fs.writeFileSync(
			stubPath,
			[
				'export async function migrateKnowledgeFamily() {',
				'\tlet destRelease: (() => Promise<void>) | null = null;',
				'\tdestRelease = await lockfile.lock(destinationDir, {});',
				'\ttry {',
				'\t\tawait runMerge();',
				'\t} catch (error) {',
				'\t\tthrow error;',
				'\t} finally {',
				'\t\tif (destRelease) await destRelease();',
				'\t}',
				'}',
			].join('\n'),
			'utf-8',
		);
		tempRoots.push(repoDir);
		const result = checkMigrationLockAdmission(repoDir);
		expect(result.violations).toBe(1);
		expect(
			result.messages.some((m) =>
				m.includes(
					'memory-family-migration.ts not found - Check 8 cannot verify destination lock admission',
				),
			),
		).toBe(true);
	});

	test('fails closed when a present engine has no recognizable acquire (PRR-T3)', () => {
		// A renamed release variable makes the acquire pattern match nothing;
		// the guardrail must not pass vacuously.
		const renamed = FAIL_CLOSED_ENGINE.replace(/destRelease/g, 'cohortRelease');
		const result = checkMigrationLockAdmission(
			makeRepoWithEngine(renamed, '\n'),
		);
		expect(result.violations).toBe(1);
		expect(
			result.messages.some((m) =>
				m.includes(
					'contains no recognizable destination lock acquire (destRelease = await ...lock()) - re-anchor Check 8.',
				),
			),
		).toBe(true);
	});

	test('flags an acquire with no adjacent catch within the scan window (PRR-T2)', () => {
		// The acquire exists but its catch is beyond the 12-line forward
		// window: the scanner must report the re-anchor error, not pass.
		const noCatch = [
			'export async function migrateMemoryFamily() {',
			'\tlet destRelease: (() => Promise<void>) | null = null;',
			'\tdestRelease = await lockfile.lock(destStoragePath);',
			'\tconst perMember: string[] = [];',
			'\tfor (const member of MEMORY_FAMILY) {',
			'\t\tperMember.push(member.filename);',
			'\t}',
			'\tif (perMember.length === 0) {',
			'\t\tthrow new Error("nothing to migrate");',
			'\t}',
			'\tawait commitAll(perMember);',
			'\t// ... more than 12 lines pass before any catch appears ...',
			'\t// ... more than 12 lines pass before any catch appears ...',
			'\t// ... more than 12 lines pass before any catch appears ...',
			'\ttry {',
			'\t\tawait finalize();',
			'\t} catch (err) {',
			'\t\tthrow err;',
			'\t}',
			'}',
		].join('\n');
		const result = checkMigrationLockAdmission(
			makeRepoWithEngine(noCatch, '\n'),
		);
		expect(result.violations).toBe(1);
		expect(
			result.messages.some((m) =>
				m.includes('destination lock acquire has no adjacent catch'),
			),
		).toBe(true);
	});
});
