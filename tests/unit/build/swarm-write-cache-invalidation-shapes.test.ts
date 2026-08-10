/**
 * G2 guardrail (issue #1729 follow-up) — assertions. The scanner machinery
 * lives in tests/helpers/swarm-write-cache-scan.ts; read its docblock for the
 * rules, the deliberate exclusions and the known limitation.
 *
 * This file holds the falsifiability fixtures: proof that each covered write
 * shape is actually detected, and that each deliberately-excluded shape is not.
 */
import { describe, expect, test } from 'bun:test';
import {
	cachedNameMatchesPath,
	collectCachedArtifactFilenames,
	harvestCachedArtifactsFromSource,
	scanFile,
} from '../../helpers/swarm-write-cache-scan';

describe('G2 scanner — covered write shapes are actually detected (#1729)', () => {
	/**
	 * Falsifiability. Each fixture is the EXACT shape of a real fixed site; the
	 * scan is worthless if deleting an invalidation call leaves it green, which
	 * is precisely what the previous rename-only version did for four of the six
	 * sites. Fixtures are scanned through the same `scanFile` entry point the
	 * tree scan uses.
	 */
	describe('falsifiability: each covered write shape is actually detected', () => {
		const names = new Set([
			'handoff.md',
			'context.md',
			'session/budget-state.json',
			'curator-summary.json',
			'curator-briefing.md',
			'evidence.json',
			// Patterns — artifacts whose basename is built by interpolation. Added
			// 2026-08-10 (#1619 round 5); before the harvester folded `${…}` to `*`
			// these three could not be represented at all.
			'drift-report-phase-*.json',
			'summaries/*.json',
			'evidence/*.json',
		]);

		const shapes: ReadonlyArray<{
			label: string;
			unsafe: string;
			safe: string;
		}> = [
			{
				label:
					'R — renameSync over a validateSwarmPath-declared target (src/commands/handoff.ts)',
				unsafe: [
					'export async function h(directory: string) {',
					"\tconst resolvedPath = validateSwarmPath(directory, 'handoff.md');",
					'\tconst tempPath = `${resolvedPath}.tmp`;',
					'\tawait bunWrite(tempPath, "x");',
					'\trenameSync(tempPath, resolvedPath);',
					'}',
				].join('\n'),
				safe: [
					'export async function h(directory: string) {',
					"\tconst resolvedPath = validateSwarmPath(directory, 'handoff.md');",
					'\tconst tempPath = `${resolvedPath}.tmp`;',
					'\tawait bunWrite(tempPath, "x");',
					'\trenameSync(tempPath, resolvedPath);',
					'\tinvalidateCachedArtifact(resolvedPath);',
					'}',
				].join('\n'),
			},
			{
				label:
					'W — bunWrite over a validateSwarmPath-declared target (src/services/context-budget-service.ts)',
				unsafe: [
					'async function w(directory: string, state: unknown) {',
					"\tconst resolvedPath = validateSwarmPath(directory, 'session/budget-state.json');",
					'\tawait bunWrite(resolvedPath, JSON.stringify(state));',
					'}',
				].join('\n'),
				safe: [
					'async function w(directory: string, state: unknown) {',
					"\tconst resolvedPath = validateSwarmPath(directory, 'session/budget-state.json');",
					'\tawait bunWrite(resolvedPath, JSON.stringify(state));',
					'\tinvalidateCachedArtifact(resolvedPath);',
					'}',
				].join('\n'),
			},
			{
				label:
					'W — member-form writeFileSync over a path.join target (src/hooks/skill-propagation-gate.ts)',
				unsafe: [
					'export async function g(directory: string, updatedContent: string) {',
					"\tconst contextPath = path.join(directory, '.swarm', 'context.md');",
					"\t_internals.writeFileSync(contextPath, updatedContent, 'utf-8');",
					'}',
				].join('\n'),
				safe: [
					'export async function g(directory: string, updatedContent: string) {',
					"\tconst contextPath = path.join(directory, '.swarm', 'context.md');",
					"\t_internals.writeFileSync(contextPath, updatedContent, 'utf-8');",
					'\tinvalidateCachedArtifact(contextPath);',
					'}',
				].join('\n'),
			},
			{
				label:
					'W — promise-form writeFile over a path.join target (src/hooks/phase-monitor.ts)',
				unsafe: [
					'export async function p(directory: string, briefing: string) {',
					"\tconst briefingPath = path.join(directory, '.swarm', 'curator-briefing.md');",
					"\tawait writeFile(briefingPath, briefing, 'utf-8');",
					'}',
				].join('\n'),
				safe: [
					'export async function p(directory: string, briefing: string) {',
					"\tconst briefingPath = path.join(directory, '.swarm', 'curator-briefing.md');",
					"\tawait writeFile(briefingPath, briefing, 'utf-8');",
					'\tinvalidateCachedArtifact(briefingPath);',
					'}',
				].join('\n'),
			},
			{
				label:
					'R — await fs.rename over a two-hop transitive path.join target (src/evidence/manager.ts, #1619 FIX-3)',
				unsafe: [
					'export async function saveEvidence(directory: string, taskId: string) {',
					"\tconst relativePath = path.join('evidence', taskId, 'evidence.json');",
					'\tconst evidencePath = validateSwarmPath(directory, relativePath);',
					'\tconst tempPath = `${evidencePath}.tmp`;',
					'\tawait bunWrite(tempPath, "{}");',
					'\tawait fs.rename(tempPath, evidencePath);',
					'}',
				].join('\n'),
				safe: [
					'export async function saveEvidence(directory: string, taskId: string) {',
					"\tconst relativePath = path.join('evidence', taskId, 'evidence.json');",
					'\tconst evidencePath = validateSwarmPath(directory, relativePath);',
					'\tconst tempPath = `${evidencePath}.tmp`;',
					'\tawait bunWrite(tempPath, "{}");',
					'\tawait fs.rename(tempPath, evidencePath);',
					'\tinvalidateCachedArtifact(evidencePath);',
					'}',
				].join('\n'),
			},
			{
				label:
					'T — transactFile write callback that never invalidates (src/hooks/curator.ts)',
				unsafe: [
					'async function writeState(filePath: string, state: unknown) {',
					'\tawait bunWrite(filePath, JSON.stringify(state));',
					'}',
					'export async function t(directory: string) {',
					"\tconst resolvedPath = validateSwarmPath(directory, 'curator-summary.json');",
					'\tawait _internals.transactFile<S>(resolvedPath, readState, _internals.writeState, (s) => s);',
					'}',
				].join('\n'),
				safe: [
					'async function writeState(filePath: string, state: unknown) {',
					'\tawait bunWrite(filePath, JSON.stringify(state));',
					'\tinvalidateCachedArtifact(filePath);',
					'}',
					'export async function t(directory: string) {',
					"\tconst resolvedPath = validateSwarmPath(directory, 'curator-summary.json');",
					'\tawait _internals.transactFile<S>(resolvedPath, readState, _internals.writeState, (s) => s);',
					'}',
				].join('\n'),
			},
			{
				label:
					'W — interpolated-template target folded through a string constant (src/hooks/curator-drift.ts, #1619 round 5)',
				unsafe: [
					"const DRIFT_REPORT_PREFIX = 'drift-report-phase-';",
					'export async function w(directory: string, report: { phase: number }) {',
					'\tconst filename = `${DRIFT_REPORT_PREFIX}${report.phase}.json`;',
					'\tconst filePath = validateSwarmPath(directory, filename);',
					"\tawait fs.promises.writeFile(filePath, '{}', 'utf-8');",
					'}',
				].join('\n'),
				safe: [
					"const DRIFT_REPORT_PREFIX = 'drift-report-phase-';",
					'export async function w(directory: string, report: { phase: number }) {',
					'\tconst filename = `${DRIFT_REPORT_PREFIX}${report.phase}.json`;',
					'\tconst filePath = validateSwarmPath(directory, filename);',
					"\tawait fs.promises.writeFile(filePath, '{}', 'utf-8');",
					'\tinvalidateCachedArtifact(filePath);',
					'}',
				].join('\n'),
			},
			{
				label:
					'R — renameSync over a directory-qualified wildcard target (src/summaries/manager.ts, #1619 round 5)',
				unsafe: [
					'export async function s(directory: string, sanitizedId: string, json: string) {',
					"\tconst relativePath = path.join('summaries', `${sanitizedId}.json`);",
					'\tconst summaryPath = validateSwarmPath(directory, relativePath);',
					'\tconst tempPath = `${summaryPath}.tmp`;',
					'\tawait bunWrite(tempPath, json);',
					'\trenameSync(tempPath, summaryPath);',
					'}',
				].join('\n'),
				safe: [
					'export async function s(directory: string, sanitizedId: string, json: string) {',
					"\tconst relativePath = path.join('summaries', `${sanitizedId}.json`);",
					'\tconst summaryPath = validateSwarmPath(directory, relativePath);',
					'\tconst tempPath = `${summaryPath}.tmp`;',
					'\tawait bunWrite(tempPath, json);',
					'\trenameSync(tempPath, summaryPath);',
					'\tinvalidateCachedArtifact(summaryPath);',
					'}',
				].join('\n'),
			},
			{
				label:
					'W — writeFileSync under a `.swarm/`-prefixed directory constant (src/tools/req-coverage.ts, #1619 round 5)',
				unsafe: [
					"const EVIDENCE_DIR = '.swarm/evidence';",
					'export function r(cwd: string, phase: number, result: unknown) {',
					'\tconst evidenceDir = path.join(cwd, EVIDENCE_DIR);',
					'\tconst reportFilename = `req-coverage-phase-${phase}.json`;',
					'\tconst reportPath = path.join(evidenceDir, reportFilename);',
					"\tfs.writeFileSync(reportPath, JSON.stringify(result), 'utf-8');",
					'}',
				].join('\n'),
				safe: [
					"const EVIDENCE_DIR = '.swarm/evidence';",
					'export function r(cwd: string, phase: number, result: unknown) {',
					'\tconst evidenceDir = path.join(cwd, EVIDENCE_DIR);',
					'\tconst reportFilename = `req-coverage-phase-${phase}.json`;',
					'\tconst reportPath = path.join(evidenceDir, reportFilename);',
					"\tfs.writeFileSync(reportPath, JSON.stringify(result), 'utf-8');",
					'\tinvalidateCachedArtifact(reportPath);',
					'}',
				].join('\n'),
			},
		];

		for (const shape of shapes) {
			test(`flags the unsafe form and clears the safe form: ${shape.label}`, () => {
				expect(scanFile('src/fixture.ts', shape.unsafe, names).length).toBe(1);
				expect(scanFile('src/fixture.ts', shape.safe, names)).toEqual([]);
			});
		}

		test('does NOT flag the deliberately-excluded shapes', () => {
			// Append: size always grows, so the stat stamp always differs.
			const appendSrc = [
				'export function a(directory: string, event: unknown) {',
				"\tconst eventsPath = validateSwarmPath(directory, 'events.jsonl');",
				'\tfs.appendFileSync(eventsPath, JSON.stringify(event));',
				'}',
			].join('\n');
			expect(
				scanFile('src/fixture.ts', appendSrc, new Set(['events.jsonl'])),
			).toEqual([]);

			// atomicWriteFile invalidates internally.
			const atomicSrc = [
				'export async function b(directory: string, updated: string) {',
				"\tconst p = path.join(directory, '.swarm', 'context.md');",
				'\tawait atomicWriteFile(p, updated);',
				'}',
			].join('\n');
			expect(
				scanFile('src/fixture.ts', atomicSrc, new Set(['context.md'])),
			).toEqual([]);

			// Cached artifact is the rename SOURCE — the file is removed, and a
			// missing file yields a null stamp that bypasses the cache.
			const removeSrc = [
				'export function c(directory: string) {',
				"\tconst handoffPath = validateSwarmPath(directory, 'handoff.md');",
				"\tconst consumedPath = validateSwarmPath(directory, 'handoff-consumed.md');",
				'\tfs.renameSync(handoffPath, consumedPath);',
				'}',
			].join('\n');
			expect(
				scanFile('src/fixture.ts', removeSrc, new Set(['handoff.md'])),
			).toEqual([]);

			// A write to a NON-cached artifact declared near a cached-artifact read
			// must not be misattributed (the fixed-line-window false positive).
			const unrelatedSrc = [
				'export async function d(directory: string, report: string) {',
				"\tconst reportPath = validateSwarmPath(directory, 'escalation-report.md');",
				'\ttry {',
				"\t\tconst planPath = validateSwarmPath(directory, 'plan.json');",
				"\t\tfs.readFileSync(planPath, 'utf-8');",
				'\t} catch {}',
				"\tfs.writeFileSync(reportPath, report, 'utf-8');",
				'}',
			].join('\n');
			expect(
				scanFile('src/fixture.ts', unrelatedSrc, new Set(['plan.json'])),
			).toEqual([]);
		});

		test('collectCachedArtifactFilenames discovers a NON-literal readSwarmFileAsync second argument (#1619 FIX-3)', () => {
			// The real src/evidence/manager.ts shape: readSwarmFileAsync's second
			// argument is a variable built by path.join(...) rather than a string
			// literal in the call itself, so the original literal-only regex never
			// saw 'evidence.json' at all — the cached-filename set didn't even
			// contain it, which made scanFile blind regardless of RULE R/W/T.
			const cachedFilenames = collectCachedArtifactFilenames();
			expect(cachedFilenames.has('evidence.json')).toBe(true);
		});

		test('comment prose can neither satisfy nor trip a check', () => {
			const commentedSrc = [
				'export async function e(directory: string, body: string) {',
				"\tconst p = validateSwarmPath(directory, 'handoff.md');",
				'\t// remember to call invalidateCachedArtifact(p) here one day',
				'\tawait bunWrite(p, body);',
				'}',
			].join('\n');
			expect(
				scanFile('src/fixture.ts', commentedSrc, new Set(['handoff.md']))
					.length,
			).toBe(1);
		});
	});
});

/**
 * Matching is ONE-DIRECTIONAL: the cached name is the matcher and the write
 * path is the subject, with a wildcard in the WRITE path replaced by a
 * character no literal cached segment can match. Getting this backwards is easy
 * and expensive in both directions — too loose floods the report with every
 * `${x}.json` write, too tight re-hides the round-4 miss.
 */
describe('G2 scanner — cached-name/write-path matching direction (#1619 round 5)', () => {
	const cases: ReadonlyArray<{
		cached: string;
		write: string;
		matches: boolean;
		why: string;
	}> = [
		{
			cached: 'drift-report-phase-*.json',
			write: 'drift-report-phase-*.json',
			matches: true,
			why: 'the round-4 miss: an interpolated basename with a resolvable literal prefix',
		},
		{
			cached: 'plan.json',
			write: '*.json',
			matches: false,
			why: 'a literal cached name must NOT swallow a fully dynamic write basename',
		},
		{
			cached: 'evidence/*.json',
			write: 'evidence/*/evidence.json',
			matches: false,
			why: '.swarm/evidence/<id>.json and .swarm/evidence/<id>/evidence.json are different artifacts',
		},
		{
			cached: 'evidence.json',
			write: 'evidence/*/evidence.json',
			matches: true,
			why: "the manager layout's own basename still matches on the tail",
		},
		{
			cached: 'session/budget-state.json',
			write: 'session/budget-state.json',
			matches: true,
			why: 'a multi-segment literal name matches segment-for-segment',
		},
		{
			cached: 'session/budget-state.json',
			write: 'budget-state.json',
			matches: false,
			why: 'a cached name longer than the write path cannot match',
		},
		{
			cached: 'summaries/*.json',
			write: 'summaries/*.json',
			matches: true,
			why: 'a wildcard basename qualified by a literal directory',
		},
	];

	for (const c of cases) {
		test(`${c.cached} vs ${c.write} -> ${c.matches} (${c.why})`, () => {
			expect(cachedNameMatchesPath(c.cached, c.write)).toBe(c.matches);
		});
	}
});

describe('G2 harvester — reader path arguments fold to the right artifact (#1619 round 5)', () => {
	test('a multi-segment literal name is kept verbatim, never truncated to its basename', () => {
		const source = [
			'export async function b(directory: string) {',
			"\treturn readSwarmFileAsync(directory, 'session/budget-state.json');",
			'}',
		].join('\n');
		const harvest = harvestCachedArtifactsFromSource('src/fixture.ts', source);
		expect([...harvest.names]).toEqual(['session/budget-state.json']);
		expect(harvest.unresolved).toEqual([]);
	});

	/**
	 * A trailing comma in a multi-line call yields an empty final argument. While
	 * building the pattern engine that empty argument folded to `*`, appending a
	 * phantom path segment that turned the resolvable `.swarm/evidence/<id>.json`
	 * into the wholly dynamic `evidence/*.json/*` — i.e. it moved a real artifact
	 * OUT of the cached set, the exact failure this scan exists to prevent.
	 */
	test('a trailing comma in a multi-line path.join does not make the target look dynamic', () => {
		const source = [
			'export function e(directory: string, taskId: string) {',
			'\tconst evidencePath = path.join(',
			'\t\tdirectory,',
			"\t\t'.swarm',",
			"\t\t'evidence',",
			'\t\t`${taskId}.json`,',
			'\t);',
			'\treturn readCachedTextFileSync(evidencePath, () => null);',
			'}',
		].join('\n');
		const harvest = harvestCachedArtifactsFromSource('src/fixture.ts', source);
		expect([...harvest.names]).toEqual(['evidence/*.json']);
		expect(harvest.unresolved).toEqual([]);
	});

	test('an unresolvable path argument is bucketed as unresolved, never dropped', () => {
		const source = [
			'export async function d(directory: string, files: string[]) {',
			'\tfor (const filename of files) {',
			'\t\tawait readSwarmFileAsync(directory, filename);',
			'\t}',
			'}',
		].join('\n');
		const harvest = harvestCachedArtifactsFromSource('src/fixture.ts', source);
		expect([...harvest.names]).toEqual([]);
		expect(harvest.totalCallSites).toBe(1);
		expect(harvest.resolvedCallSites).toBe(0);
		expect(harvest.unresolved).toEqual([
			{
				file: 'src/fixture.ts',
				callee: 'readSwarmFileAsync',
				arg: 'filename',
				line: 3,
			},
		]);
	});
});
