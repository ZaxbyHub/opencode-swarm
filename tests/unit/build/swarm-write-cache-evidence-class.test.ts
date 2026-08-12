/**
 * G2 guardrail (issue #1619 round 6) — the `.swarm/evidence/**` CLASS.
 *
 * SCOPE CORRECTION (round 7). The heading here, and the describe block below,
 * used to read "the `.swarm/evidence/** ` class is closed". Both now say what is
 * actually true, because the unqualified form was falsified: the PATH-PATTERN
 * side of the class is closed
 * (`evidence/**` is the reader's real blast radius, and every layout below it
 * matches), and the WRITE side is closed only over the call heads in
 * `WRITE_HEADS`, the files `mentionsEvidencePath` selects, and the targets
 * `looksLikePathExpression` accepts. Round 7 falsified the unqualified version
 * by injecting five unguarded evidence writers whose heads nobody recognized —
 * `copyFileSync`, `cpSync`, `open(p,'w')`, `createWriteStream` and `Bun.write` —
 * and watching every gate stay green. The head axis now has its own file,
 * tests/unit/build/swarm-write-cache-write-heads.test.ts, including the closure
 * statement against the `node:fs` surface this repo actually calls.
 *
 * Rounds 2-6 each found one more cached-artifact writer the guard could not
 * see, and round 6 found two whose invisibility came from the guard's own
 * SCOPE CLAIMS rather than from a demonstrated stale read:
 *
 *   1. an inline path expression (`writeFile(path.join(dir, name), …)`) was
 *      skipped by construction, while the docblock claimed no such shape could
 *      exist on the write side;
 *   2. the knowledge-curator reader was registered as reading
 *      `evidence/*.json` + `evidence.json`, while its real trigger filter
 *      (`isEvidencePath`, src/hooks/knowledge-curator.ts) is unrestricted below
 *      `.swarm/evidence/` — so every two-level layout was outside the guard.
 *
 * The fix is not two patches. It is (a) `evidence/**` declared as the reader's
 * real blast radius so the whole directory is one closed class, and (b) this
 * file: a bucket for write sites the pattern engine cannot fold, mirroring
 * `UNRESOLVED_READER_REGISTRY` on the read side. It is exhaustive WITHIN its
 * scope — files that construct a `.swarm/evidence/` path, call sites outside
 * template literals, call sites outside a RULE H helper body — and that scope
 * is spelled out in the scanner's KNOWN LIMITATIONS rather than implied.
 *
 * The shape fixtures below are the durable half. The revert-check ("delete one
 * invalidation, watch the scan fail") proves each rule bites TODAY; a fixture
 * keeps it biting after someone refactors the live instance away, which is the
 * actual recurrence mechanism.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	blindSpotKey,
	cachedNameMatchesPath,
	checkExplicitInvalidation,
	collectCachedArtifactFilenames,
	collectEvidenceBlindSpots,
	collectWriteSitesFromSource,
	EVIDENCE_WRITE_BLIND_SPOTS,
	isSpecificName,
	mentionsEvidencePath,
	scanFile,
} from '../../helpers/swarm-write-cache-scan';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

/** The cached set every fixture is scanned against. */
const EVIDENCE_SET = new Set(['evidence/**']);

describe('G2 — the .swarm/evidence/** PATH class (#1619 round 6)', () => {
	test('evidence/** is in the authoritative cached-artifact set', () => {
		const cached = collectCachedArtifactFilenames();
		expect(
			cached.has('evidence/**'),
			"missing 'evidence/**' — the knowledge-curator reader's blast radius is " +
				'every path below .swarm/evidence/, and declaring anything narrower is ' +
				'what let evidence/<phase>/drift-verifier.json escape rounds 1-5.',
		).toBe(true);
		expect(isSpecificName('evidence/**')).toBe(true);
	});

	test('evidence/** covers every layout that previously escaped', () => {
		for (const layout of [
			'evidence/agent-tools-*.json',
			'evidence/*/phase-council.json',
			'evidence/*/drift-verifier.json',
			'evidence/*/lean-turbo/lean-turbo-phase.json',
			'evidence/*/reviewer.json',
			'evidence/*/evidence.json',
			'evidence/sbom/*.json',
		]) {
			expect(
				cachedNameMatchesPath('evidence/**', layout),
				`evidence/** must cover '${layout}'`,
			).toBe(true);
		}
	});

	test('evidence/** does not reach outside the directory it names', () => {
		for (const outside of [
			'evidence.json',
			'evidence',
			'plan.json',
			'summaries/*.json',
		]) {
			expect(
				cachedNameMatchesPath('evidence/**', outside),
				`evidence/** must NOT match '${outside}'`,
			).toBe(false);
		}
	});

	/**
	 * The enumeration gate. Set equality in both directions: an unfoldable write
	 * site under an evidence-path file that nobody registered fails here, and a
	 * registration whose site is gone fails here too.
	 */
	test('every unfoldable evidence-file write site is registered', () => {
		const discovered = new Set(collectEvidenceBlindSpots().map(blindSpotKey));
		const registered = new Set(EVIDENCE_WRITE_BLIND_SPOTS.map(blindSpotKey));

		expect(
			[...discovered].filter((key) => !registered.has(key)).sort(),
			'A write call site in a file that constructs a .swarm/evidence/ path has ' +
				'a target expression the pattern engine cannot fold, so NO rule can see ' +
				'it. Either give the target a shape the engine resolves (a local const ' +
				'from path.join / validateSwarmPath / a single-return helper), or add it ' +
				'to EVIDENCE_WRITE_BLIND_SPOTS with a status and a reason.',
		).toEqual([]);

		expect(
			[...registered].filter((key) => !discovered.has(key)).sort(),
			'EVIDENCE_WRITE_BLIND_SPOTS entries that no longer match any site. A ' +
				'stale entry documents a hazard that no longer exists; delete it.',
		).toEqual([]);
	});

	test('registered blind spots state a reason and back their status with source', () => {
		for (const entry of EVIDENCE_WRITE_BLIND_SPOTS) {
			expect(
				entry.reason.length,
				`${blindSpotKey(entry)} has no reason`,
			).toBeGreaterThan(40);
			if (entry.status !== 'invalidates-explicitly') continue;
			// Comment-blind and position-aware on purpose: a raw substring search
			// over unblanked source is satisfied by a COMMENTED-OUT call, and this
			// check is the only thing guarding a site no static rule can see.
			expect(
				checkExplicitInvalidation(entry.file, entry.target),
				`${blindSpotKey(entry)} is registered as 'invalidates-explicitly' but ` +
					'the source does not back that up. This site is invisible to every ' +
					'static rule, so that call is the ONLY thing standing between it and ' +
					'a stale read.',
			).toBeNull();
		}
	});
});

describe('G2 shapes — write targets round 6 made visible (#1619)', () => {
	/** Blocker 1: an inline `path.join(...)` argument, not a bare identifier. */
	test('an INLINE path expression write is caught', () => {
		const source = [
			'function run(directory: string, sid: string) {',
			"	const evidenceDir = path.join(directory, '.swarm', 'evidence');",
			'	const filename = `agent-tools-${sid}.json`;',
			'	writeFile(path.join(evidenceDir, filename), data);',
			'}',
		].join('\n');
		const violations = scanFile('src/fixture.ts', source, EVIDENCE_SET);
		expect(violations.map((v) => v.rule)).toEqual(['W']);
		expect(violations[0]?.filename).toBe('evidence/**');
	});

	test('an inline write IS accepted when the same expression is invalidated', () => {
		const source = [
			'function run(directory: string, sid: string) {',
			"	const evidenceDir = path.join(directory, '.swarm', 'evidence');",
			'	const filename = `agent-tools-${sid}.json`;',
			'	writeFile(path.join(evidenceDir, filename), data);',
			'	invalidateCachedArtifact(path.join(evidenceDir, filename));',
			'}',
		].join('\n');
		expect(scanFile('src/fixture.ts', source, EVIDENCE_SET)).toEqual([]);
	});

	/**
	 * Two different dynamic targets in the same directory fold to the same
	 * pattern (`evidence/*`), so folded-path equality alone would let an
	 * invalidation of one excuse a write of the other.
	 */
	test('a SAME-PATTERN but different inline expression does not satisfy the write', () => {
		const source = [
			'function run(directory: string, a: string, b: string) {',
			"	const evidenceDir = path.join(directory, '.swarm', 'evidence');",
			'	writeFile(path.join(evidenceDir, a), data);',
			'	invalidateCachedArtifact(path.join(evidenceDir, b));',
			'}',
		].join('\n');
		expect(scanFile('src/fixture.ts', source, EVIDENCE_SET)).toHaveLength(1);
	});

	test('an UNRELATED nearby invalidation does not satisfy an inline write', () => {
		const source = [
			'function run(directory: string, sid: string) {',
			"	const evidenceDir = path.join(directory, '.swarm', 'evidence');",
			'	const filename = `agent-tools-${sid}.json`;',
			"	const other = path.join(directory, '.swarm', 'evidence', 'other.json');",
			'	writeFile(path.join(evidenceDir, filename), data);',
			'	invalidateCachedArtifact(other);',
			'}',
		].join('\n');
		expect(scanFile('src/fixture.ts', source, EVIDENCE_SET)).toHaveLength(1);
	});

	/** Finding 3: the path comes from a repo-local single-return helper. */
	test('a path from a same-file single-return helper is resolved', () => {
		const source = [
			'function phaseEvidencePath(dir: string, phase: number): string {',
			'	return path.join(',
			'		dir,',
			"		'.swarm',",
			"		'evidence',",
			'		String(phase),',
			"		'phase-council.json',",
			'	);',
			'}',
			'function write(dir: string, phase: number) {',
			'	const evidenceFile = phaseEvidencePath(dir, phase);',
			'	renameSync(tempFile, evidenceFile);',
			'}',
		].join('\n');
		const violations = scanFile('src/fixture.ts', source, EVIDENCE_SET);
		expect(violations.map((v) => v.rule)).toEqual(['R']);
	});

	test('a two-hop same-file helper chain is resolved', () => {
		const source = [
			'function evidenceDir(dir: string, phase: number): string {',
			"	return path.join(dir, '.swarm', 'evidence', String(phase), 'lean-turbo');",
			'}',
			'function phasePath(dir: string, phase: number): string {',
			"	return path.join(evidenceDir(dir, phase), 'lean-turbo-phase.json');",
			'}',
			'function write(dir: string, phase: number) {',
			'	const target = phasePath(dir, phase);',
			'	writeFileSync(target, body);',
			'}',
		].join('\n');
		expect(scanFile('src/fixture.ts', source, EVIDENCE_SET)).toHaveLength(1);
	});

	/** Finding 4: `let p: string;` then `p = validateSwarmPath(...)`. */
	test('an assignment with no initializer on the declaration is resolved', () => {
		const source = [
			'function write(directory: string, phase: number) {',
			"	const relativePath = path.join('evidence', String(phase), 'drift.json');",
			'	let validatedPath: string;',
			'	validatedPath = validateSwarmPath(directory, relativePath);',
			'	renameSync(tempPath, validatedPath);',
			'}',
		].join('\n');
		const violations = scanFile('src/fixture.ts', source, EVIDENCE_SET);
		expect(violations.map((v) => v.rule)).toEqual(['R']);
	});

	/** RULE H: the target arrives as a parameter of a same-file write helper. */
	test('a same-file helper that writes to its parameter is caught at the CALL site', () => {
		const source = [
			'async function atomicWriteJson(filePath: string, data: unknown) {',
			'	const tempPath = `${filePath}.tmp`;',
			'	await bunWrite(tempPath, JSON.stringify(data));',
			'	await fs.rename(tempPath, filePath);',
			'}',
			'async function writePhase(directory: string, phase: number) {',
			"	const targetPath = path.join(directory, '.swarm', 'evidence', String(phase), 'x.json');",
			'	await atomicWriteJson(targetPath, {});',
			'}',
		].join('\n');
		const violations = scanFile('src/fixture.ts', source, EVIDENCE_SET);
		expect(violations.map((v) => v.rule)).toEqual(['H']);
	});

	test('RULE H is satisfied by invalidating the parameter inside the helper', () => {
		const source = [
			'async function atomicWriteJson(filePath: string, data: unknown) {',
			'	const tempPath = `${filePath}.tmp`;',
			'	await bunWrite(tempPath, JSON.stringify(data));',
			'	await fs.rename(tempPath, filePath);',
			'	invalidateCachedArtifact(filePath);',
			'}',
			'async function writePhase(directory: string, phase: number) {',
			"	const targetPath = path.join(directory, '.swarm', 'evidence', String(phase), 'x.json');",
			'	await atomicWriteJson(targetPath, {});',
			'}',
		].join('\n');
		expect(scanFile('src/fixture.ts', source, EVIDENCE_SET)).toEqual([]);
	});

	test('RULE H rejects an invalidation placed BEFORE the write', () => {
		const source = [
			'async function atomicWriteJson(filePath: string, data: unknown) {',
			'	invalidateCachedArtifact(filePath);',
			'	const tempPath = `${filePath}.tmp`;',
			'	await bunWrite(tempPath, JSON.stringify(data));',
			'	await fs.rename(tempPath, filePath);',
			'}',
			'async function writePhase(directory: string, phase: number) {',
			"	const targetPath = path.join(directory, '.swarm', 'evidence', String(phase), 'x.json');",
			'	await atomicWriteJson(targetPath, {});',
			'}',
		].join('\n');
		const violations = scanFile('src/fixture.ts', source, EVIDENCE_SET);
		expect(violations.map((v) => v.rule)).toEqual(['H']);
	});

	test('RULE H rejects an invalidation keyed on a different value', () => {
		const source = [
			'async function atomicWriteJson(filePath: string, other: string) {',
			'	const tempPath = `${filePath}.tmp`;',
			'	await bunWrite(tempPath, content);',
			'	await fs.rename(tempPath, filePath);',
			'	invalidateCachedArtifact(other);',
			'}',
			'async function writePhase(directory: string, phase: number) {',
			"	const targetPath = path.join(directory, '.swarm', 'evidence', String(phase), 'x.json');",
			'	await atomicWriteJson(targetPath, other);',
			'}',
		].join('\n');
		expect(scanFile('src/fixture.ts', source, EVIDENCE_SET)).toHaveLength(1);
	});

	/**
	 * `swarmPath` is in `PATH_PRODUCER_RE` rather than folded as a single-return
	 * helper, because its rest parameter would swallow the caller's literal
	 * segments. That is only sound while every `swarmPath` in src/ really is a
	 * `path.join(directory, '.swarm', ...segments)` pass-through, so the next
	 * test checks exactly that against live source.
	 */
	test('swarmPath(...) is treated as a path producer', () => {
		const source = [
			'function write(directory: string, runId: string) {',
			"	const target = swarmPath(directory, 'evidence', 'gate-audit', runId, 'r.json');",
			'	writeFileSync(target, body);',
			'}',
		].join('\n');
		expect(scanFile('src/fixture.ts', source, EVIDENCE_SET)).toHaveLength(1);
	});

	test('every swarmPath() in src/ really is a join pass-through', () => {
		const definitions = [
			'src/evaluation/store.ts',
			'src/consensus/store.ts',
		] as const;
		let found = 0;
		for (const file of definitions) {
			const source = readFileSync(join(REPO_ROOT, file), 'utf-8');
			const match =
				/function swarmPath\([^)]*\)\s*:\s*string\s*\{\s*return\s+path\.join\(\s*directory\s*,\s*'\.swarm'\s*,\s*\.\.\.segments\s*\);?\s*\}/.exec(
					source,
				);
			expect(
				match,
				`${file} no longer defines swarmPath as ` +
					"path.join(directory, '.swarm', ...segments). PATH_PRODUCER_RE treats " +
					'swarmPath as a join pass-through; if its semantics changed, remove it ' +
					'from PATH_PRODUCER_RE or the engine will fold callers to the wrong path.',
			).not.toBeNull();
			found++;
		}
		expect(found).toBe(2);
	});

	/**
	 * The over-approximation guard. `evidence/**` matches temp files under
	 * `.swarm/evidence/` too, and demanding an invalidation for a path that is
	 * renamed away one line later would be exactly the unwired-code noise this
	 * repo forbids.
	 */
	test('a temp write that is renamed away is not a violation', () => {
		const source = [
			'async function write(directory: string, phase: number) {',
			"	const evidencePath = path.join(directory, '.swarm', 'evidence', String(phase), 'x.json');",
			'	const tempPath = `${evidencePath}.tmp`;',
			'	await fs.writeFile(tempPath, content);',
			'	await fs.rename(tempPath, evidencePath);',
			'	invalidateCachedArtifact(evidencePath);',
			'}',
		].join('\n');
		expect(scanFile('src/fixture.ts', source, EVIDENCE_SET)).toEqual([]);
	});

	/**
	 * The near-miss the exclusion has to survive: two independent
	 * write-then-rename blocks reusing the same variable names (the real shape in
	 * src/tools/sast-baseline.ts). If only the SECOND block renames, the first
	 * write must not be excused by the second block's rename.
	 */
	test('a second write to the same target before the rename is not excused', () => {
		const source = [
			'async function write(directory: string, phase: number) {',
			"	const evidencePath = path.join(directory, '.swarm', 'evidence', String(phase), 'x.json');",
			'	const tempPath = `${evidencePath}.tmp`;',
			'	await fs.writeFile(tempPath, first);',
			'	await fs.writeFile(tempPath, second);',
			'	await fs.rename(tempPath, evidencePath);',
			'	invalidateCachedArtifact(evidencePath);',
			'}',
		].join('\n');
		const violations = scanFile('src/fixture.ts', source, EVIDENCE_SET);
		expect(violations.map((v) => v.rule)).toEqual(['W']);
		expect(violations[0]?.line).toBe(4);
	});

	/**
	 * The rename-away exclusion is scoped to `**` matches on purpose. A write to
	 * a SPECIFICALLY named cached artifact is still reported even when a rename
	 * mentions it nearby, because that rename may be conditional and the
	 * artifact may survive at the written path.
	 */
	test('a CONDITIONAL rename of the written artifact does not excuse the write', () => {
		const source = [
			'async function write(directory: string, phase: number) {',
			"	const evidencePath = path.join(directory, '.swarm', 'evidence', String(phase), 'x.json');",
			'	await fs.writeFile(evidencePath, content);',
			'	if (shouldArchive) await fs.rename(evidencePath, archivePath);',
			'}',
		].join('\n');
		expect(scanFile('src/fixture.ts', source, EVIDENCE_SET)).toHaveLength(1);
	});

	test('a CATCH-branch rename of the written artifact does not excuse the write', () => {
		const source = [
			'async function write(directory: string, phase: number) {',
			"	const evidencePath = path.join(directory, '.swarm', 'evidence', String(phase), 'x.json');",
			'	try {',
			'		await fs.writeFile(evidencePath, content);',
			'	} catch (err) {',
			'		await fs.rename(evidencePath, quarantinePath);',
			'	}',
			'}',
		].join('\n');
		expect(scanFile('src/fixture.ts', source, EVIDENCE_SET)).toHaveLength(1);
	});

	test('an invalidation of a DIFFERENT variable with a shared prefix does not count', () => {
		const source = [
			'async function write(directory: string, phase: number) {',
			"	const p = path.join(directory, '.swarm', 'evidence', String(phase), 'x.json');",
			'	await fs.writeFile(p, content);',
			'	invalidateCachedArtifact(pOther);',
			'}',
		].join('\n');
		expect(scanFile('src/fixture.ts', source, EVIDENCE_SET)).toHaveLength(1);
	});

	test('RULE H sees an ARROW-function write helper', () => {
		const source = [
			'const atomicWriteJson = async (filePath: string, data: unknown) => {',
			'	const tempPath = `${filePath}.tmp`;',
			'	await bunWrite(tempPath, JSON.stringify(data));',
			'	await fs.rename(tempPath, filePath);',
			'};',
			'async function writePhase(directory: string, phase: number) {',
			"	const targetPath = path.join(directory, '.swarm', 'evidence', String(phase), 'x.json');",
			'	await atomicWriteJson(targetPath, {});',
			'}',
		].join('\n');
		expect(
			scanFile('src/fixture.ts', source, EVIDENCE_SET).map((v) => v.rule),
		).toEqual(['H']);
	});

	test('rename-away does NOT excuse a write to a specifically named artifact', () => {
		const source = [
			'async function write(directory: string) {',
			"	const planPath = path.join(directory, '.swarm', 'plan.json');",
			'	await fs.writeFile(planPath, content);',
			'	if (shouldArchive) await fs.rename(planPath, archivePath);',
			'}',
		].join('\n');
		const violations = scanFile(
			'src/fixture.ts',
			source,
			new Set(['plan.json']),
		);
		expect(violations.map((v) => v.rule)).toEqual(['W']);
	});
});
