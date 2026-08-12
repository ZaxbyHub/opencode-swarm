/**
 * G2 guardrail (issue #1619 round 7) — the WRITE HEAD table.
 *
 * Round 7's review did not read code to find its blocker. It INJECTED six
 * unguarded `.swarm/evidence/` writers into a probe file under src/ and ran the
 * gates: `copyFileSync(src, evidencePath)`, `cpSync(src, planPath,
 * {force:true})`, `open(evidencePath,'w')` + `handle.write(...)`,
 * `createWriteStream(evidencePath)` + `.write()`, `await Bun.write(evidencePath,
 * data)`, and `writeFileSync(paths[i], data)`. ALL SIX stayed green while a
 * class-method `writeFileSync` control went red.
 *
 * The root cause was not five missing patterns. Through round 6 the ENUMERATION
 * (`collectWriteSitesFromSource`, which feeds `EVIDENCE_WRITE_BLIND_SPOTS`)
 * reused the two RULE recognizers as its own, so both axes shared one blind
 * spot: a target that was merely UNRESOLVABLE failed the gate, but a head that
 * was UNRECOGNISED disappeared from resolution AND enumeration at the same
 * time. That is precisely the double blindness the round-6 redesign existed to
 * end.
 *
 * The fix is `WRITE_HEADS` — one table, consumed by the rules, the enumeration,
 * the whole-file early-out, the RULE H helper detector and the blind-spot
 * cross-check alike. This file holds the assertions that keep the table honest:
 * its compile-time invariants, one fixture per head family, the both-directions
 * flag predicates, and the CLOSURE statement that every file-mutating `node:fs`
 * API src/ actually calls is either a governed head or a reasoned exclusion.
 */

import { describe, expect, test } from 'bun:test';
import {
	collectUsedFileMutatingApis,
	collectWriteSitesFromSource,
	countCaptureGroups,
	EXCLUDED_WRITE_HEADS,
	FILE_MUTATING_APIS,
	GOVERNED_WRITE_HEAD_NAMES,
	HEAD_BOUNDARY,
	isGovernedWriteHead,
	scanFile,
	WHOLE_TREE_SCAN_TIMEOUT_MS,
	WRITE_HEAD_SOURCES,
} from '../../helpers/swarm-write-cache-scan';

/** The cached set every fixture is scanned against. */
const EVIDENCE_SET = new Set(['evidence/**']);

describe('G2 — the write-head table (#1619 round 7)', () => {
	/**
	 * The head table is compiled into one alternation whose Nth capture group
	 * identifies the Nth head, with the shared identifier boundary factored out
	 * in front. Both properties are load-bearing and both fail SILENTLY: a head
	 * written `(a|b)` instead of `(?:a|b)` shifts every later group, so matches
	 * are dispatched to the wrong rule and — worse — to the wrong path-argument
	 * index; a head missing the boundary would have it applied anyway by the
	 * factored prefix, changing what it matches.
	 */
	test('every write head is capture-group-free and identifier-boundary anchored', () => {
		expect(WRITE_HEAD_SOURCES.length).toBeGreaterThanOrEqual(6);
		for (const source of WRITE_HEAD_SOURCES) {
			expect(
				countCaptureGroups(source),
				`write head /${source}/ contains a CAPTURING group. The combined ` +
					'matcher identifies a head by capture-group index, so an inner group ' +
					'shifts every head after it — matches are then attributed to the ' +
					'wrong rule and the wrong path-argument index. Use (?:…).',
			).toBe(0);
			expect(
				source.startsWith(HEAD_BOUNDARY),
				`write head /${source}/ must start with the shared identifier ` +
					`boundary ${HEAD_BOUNDARY}; the combined matcher factors it out and ` +
					'would otherwise apply it to a pattern that never asked for it.',
			).toBe(true);
		}
	});

	/**
	 * The round-7 blocker in one assertion. Each shape below is a real write head
	 * that left every gate GREEN before the head table existed. `collectWriteSitesFromSource`
	 * is the ENUMERATION axis; if it cannot see a head, that head's writers are
	 * invisible to resolution and to the blind-spot registry simultaneously,
	 * which is the double blindness the whole round-6 redesign was meant to end.
	 */
	test('the enumeration recognizes every write-head family', () => {
		const shapes: Array<[string, string, string]> = [
			[
				'copyFileSync',
				'fs.copyFileSync(srcPath, evidencePath);',
				'evidencePath',
			],
			['cpSync', 'fs.cpSync(srcPath, planPath, { force: true });', 'planPath'],
			[
				'file handle',
				"const h = await open(evidencePath, 'w');",
				'evidencePath',
			],
			[
				'write stream',
				'const s = fs.createWriteStream(evidencePath);',
				'evidencePath',
			],
			['Bun.write', 'await Bun.write(evidencePath, data);', 'evidencePath'],
			['bracketed target', 'fs.writeFile(paths[i], data);', 'paths[i]'],
		];
		for (const [label, statement, target] of shapes) {
			const sites = collectWriteSitesFromSource(
				'src/fixture.ts',
				`function run() {\n\t${statement}\n}`,
			);
			expect(
				sites.map((s) => s.target),
				`the ${label} shape is invisible to collectWriteSitesFromSource, so a ` +
					'writer using it can never reach EVIDENCE_WRITE_BLIND_SPOTS — it ' +
					'disappears from resolution and enumeration at the same time.',
			).toEqual([target]);
		}
	});

	/**
	 * The round-9 preventer. Round 7's finding was "you recognize two write heads
	 * and the repo uses six"; the fix for THAT class is not five more heads, it is
	 * a statement that the head set is CLOSED against the write-capable surface
	 * this repo actually calls. Every `node:fs` mutator used in src/ must be a
	 * governed head or a reasoned exclusion — adding a call to a new one fails
	 * here until somebody decides which.
	 *
	 * Bound honestly: the universe is the standard-library API list, so a
	 * repo-local write helper or a shelled-out `cp` is outside it.
	 */
	test(
		'the write-head table is closed against the node:fs surface src/ uses',
		() => {
			// The universe the closure is stated over. A duplicate would mean a
			// name sits in both the governed list and the exclusion list, or twice
			// in one — either way the closure below checks a contradiction.
			expect(
				FILE_MUTATING_APIS.length,
				'FILE_MUTATING_APIS contains a duplicate name',
			).toBe(new Set(FILE_MUTATING_APIS).size);
			expect(FILE_MUTATING_APIS.length).toBeGreaterThan(
				GOVERNED_WRITE_HEAD_NAMES.length,
			);

			const used = collectUsedFileMutatingApis();
			expect(used.size).toBeGreaterThan(10); // falsifiability

			const excluded = new Map(
				EXCLUDED_WRITE_HEADS.map((entry) => [entry.name, entry.reason]),
			);
			const ungoverned = [...used]
				.filter((name) => !isGovernedWriteHead(name) && !excluded.has(name))
				.sort();
			expect(
				ungoverned,
				'src/ calls a file-mutating API that WRITE_HEADS does not recognize and ' +
					'EXCLUDED_WRITE_HEADS does not excuse. An unrecognized head is invisible ' +
					'to the rules AND to collectWriteSitesFromSource at the same time, which ' +
					'is exactly how round 7 found five unguarded .swarm/evidence/ writers ' +
					'sitting behind five green gates. Add it to WRITE_HEADS with the index ' +
					'of its destination argument, or to EXCLUDED_WRITE_HEADS with the ' +
					'argument for why it cannot serve a stale read.',
			).toEqual([]);
			// `collectUsedFileMutatingApis` is the third whole-tree pass in this file.

			// The name lists must describe the compiled patterns, both directions.
			for (const name of GOVERNED_WRITE_HEAD_NAMES) {
				expect(
					isGovernedWriteHead(name),
					`GOVERNED_WRITE_HEAD_NAMES claims '${name}' is a head, but the ` +
						'compiled matcher does not dispatch it — the pattern and the list ' +
						'have drifted.',
				).toBe(true);
			}
			for (const entry of EXCLUDED_WRITE_HEADS) {
				expect(
					entry.reason.length,
					`excluded head '${entry.name}' has no real reason`,
				).toBeGreaterThan(40);
				expect(
					isGovernedWriteHead(entry.name),
					`'${entry.name}' is both governed and excluded. One of the two is ` +
						'wrong, and the exclusion reason is documenting a hazard the rules ' +
						'are actually reporting.',
				).toBe(false);
			}
		},
		WHOLE_TREE_SCAN_TIMEOUT_MS,
	);

	/**
	 * The both-directions check for the flag predicates. An append strictly
	 * increases file size so the stat stamp always differs (the same reasoning
	 * that excludes `appendFile`), and a read-only open writes nothing — but a
	 * NON-LITERAL flag must fire, because a false positive is a report a human
	 * resolves while a false negative is the bug class.
	 */
	test('open/createWriteStream heads fire on truncating flags only', () => {
		const fire = (statement: string): string[] =>
			collectWriteSitesFromSource(
				'src/fixture.ts',
				`function run() {\n\t${statement}\n}`,
			).map((s) => s.target);

		expect(fire("const fd = fs.openSync(p, 'w');")).toEqual(['p']);
		expect(fire("const fd = fs.openSync(p, 'wx');")).toEqual(['p']);
		expect(fire("const fd = fs.openSync(p, 'r+');")).toEqual(['p']);
		expect(fire('const fd = fs.openSync(p, flags);')).toEqual(['p']);
		expect(fire("const fd = fs.openSync(p, 'r');")).toEqual([]);
		expect(fire("const fd = fs.openSync(p, 'a');")).toEqual([]);
		expect(fire("const fd = fs.openSync(p, 'a+');")).toEqual([]);
		expect(fire('const fd = fs.openSync(p);')).toEqual([]);

		expect(fire('const s = createWriteStream(p);')).toEqual(['p']);
		expect(fire("const s = createWriteStream(p, { flags: 'w' });")).toEqual([
			'p',
		]);
		expect(fire("const s = createWriteStream(p, { flags: 'a' });")).toEqual([]);
	});
});

describe('G2 shapes — the six write-head families (#1619 round 7)', () => {
	/**
	 * Round 7's six probe shapes, as durable fixtures. Each of these was injected
	 * into a real file under src/ that wrote a cached `.swarm/evidence/` artifact
	 * without invalidating, and each left EVERY gate green — because the
	 * enumeration reused the two rule recognizers, so a head nobody recognized
	 * vanished from resolution and from `EVIDENCE_WRITE_BLIND_SPOTS` at the same
	 * time. The revert-check proves the rules bite today; these keep them biting.
	 */
	test('RULE C catches a copy ONTO a cached evidence artifact', () => {
		const source = [
			'function run(directory: string, phase: number) {',
			"	const evidencePath = path.join(directory, '.swarm', 'evidence', String(phase), 'x.json');",
			'	fs.copyFileSync(stagedPath, evidencePath);',
			'}',
		].join('\n');
		const violations = scanFile('src/fixture.ts', source, EVIDENCE_SET);
		expect(violations.map((v) => v.rule)).toEqual(['C']);
		expect(violations[0]?.filename).toBe('evidence/**');
	});

	test('RULE C catches a recursive cpSync ONTO a cached evidence artifact', () => {
		const source = [
			'function run(directory: string, phase: number) {',
			"	const planPath = path.join(directory, '.swarm', 'evidence', String(phase), 'p.json');",
			'	fs.cpSync(stagedPath, planPath, { recursive: true, force: true });',
			'}',
		].join('\n');
		expect(
			scanFile('src/fixture.ts', source, EVIDENCE_SET).map((v) => v.rule),
		).toEqual(['C']);
	});

	test('RULE C is satisfied by invalidating the destination', () => {
		const source = [
			'function run(directory: string, phase: number) {',
			"	const evidencePath = path.join(directory, '.swarm', 'evidence', String(phase), 'x.json');",
			'	fs.copyFileSync(stagedPath, evidencePath);',
			'	invalidateCachedArtifact(evidencePath);',
			'}',
		].join('\n');
		expect(scanFile('src/fixture.ts', source, EVIDENCE_SET)).toEqual([]);
	});

	test('RULE C keys on the DESTINATION, not the source', () => {
		const source = [
			'function run(directory: string, phase: number) {',
			"	const evidencePath = path.join(directory, '.swarm', 'evidence', String(phase), 'x.json');",
			'	fs.copyFileSync(evidencePath, backupPath);',
			'}',
			'',
			'// A copy READ from the artifact leaves it untouched — nothing to invalidate.',
		].join('\n');
		expect(scanFile('src/fixture.ts', source, EVIDENCE_SET)).toEqual([]);
	});

	test('RULE S catches a truncating open + FileHandle write', () => {
		const source = [
			'async function run(directory: string, phase: number) {',
			"	const evidencePath = path.join(directory, '.swarm', 'evidence', String(phase), 'x.json');",
			"	const handle = await open(evidencePath, 'w');",
			'	await handle.write(data);',
			'}',
		].join('\n');
		expect(
			scanFile('src/fixture.ts', source, EVIDENCE_SET).map((v) => v.rule),
		).toEqual(['S']);
	});

	test('RULE S catches a createWriteStream over a cached evidence artifact', () => {
		const source = [
			'function run(directory: string, phase: number) {',
			"	const evidencePath = path.join(directory, '.swarm', 'evidence', String(phase), 'x.json');",
			'	const stream = fs.createWriteStream(evidencePath);',
			'	stream.write(data);',
			'}',
		].join('\n');
		expect(
			scanFile('src/fixture.ts', source, EVIDENCE_SET).map((v) => v.rule),
		).toEqual(['S']);
	});

	/**
	 * The both-directions half of RULE S. A read-only open writes nothing and an
	 * append always grows the file, so the stat stamp always differs — the same
	 * reasoning that keeps `appendFile` out of the rules. Without this the head
	 * would demand a pointless invalidation at every `openSync(p, 'r')` in src/.
	 */
	test('RULE S does not fire on a read-only open or an appending stream', () => {
		const readOnly = [
			'function run(directory: string, phase: number) {',
			"	const evidencePath = path.join(directory, '.swarm', 'evidence', String(phase), 'x.json');",
			"	const fd = fs.openSync(evidencePath, 'r');",
			'}',
		].join('\n');
		expect(scanFile('src/fixture.ts', readOnly, EVIDENCE_SET)).toEqual([]);

		const appending = [
			'function run(directory: string, phase: number) {',
			"	const evidencePath = path.join(directory, '.swarm', 'evidence', String(phase), 'x.json');",
			"	const stream = fs.createWriteStream(evidencePath, { flags: 'a' });",
			'}',
		].join('\n');
		expect(scanFile('src/fixture.ts', appending, EVIDENCE_SET)).toEqual([]);
	});

	test('RULE W catches a bare Bun.write over a cached evidence artifact', () => {
		const source = [
			'async function run(directory: string, phase: number) {',
			"	const evidencePath = path.join(directory, '.swarm', 'evidence', String(phase), 'x.json');",
			'	await Bun.write(evidencePath, data);',
			'}',
		].join('\n');
		expect(
			scanFile('src/fixture.ts', source, EVIDENCE_SET).map((v) => v.rule),
		).toEqual(['W']);
	});

	/**
	 * The Bun head is anchored on the RECEIVER. A bare `write` head would read
	 * the payload argument of every `handle.write(data)` as a path.
	 */
	test('a bare handle.write payload is not treated as a path', () => {
		const source = [
			'async function run(directory: string, phase: number) {',
			"	const evidencePath = path.join(directory, '.swarm', 'evidence', String(phase), 'x.json');",
			'	await handle.write(JSON.stringify(payload));',
			'}',
		].join('\n');
		expect(scanFile('src/fixture.ts', source, EVIDENCE_SET)).toEqual([]);
		expect(collectWriteSitesFromSource('src/fixture.ts', source)).toEqual([]);
	});

	/**
	 * The looksLikePathExpression escape. A bracketed target has no shape the
	 * engine can fold, so it cannot be GOVERNED — but it must still be ENUMERATED,
	 * or it is invisible on both axes at once.
	 */
	test('a bracketed write target is reported as a blind spot, not dropped', () => {
		const source = [
			'function run(directory: string, phase: number) {',
			"	const evidencePath = path.join(directory, '.swarm', 'evidence', String(phase), 'x.json');",
			'	const paths = [evidencePath];',
			'	fs.writeFileSync(paths[i], data);',
			'}',
		].join('\n');
		const sites = collectWriteSitesFromSource('src/fixture.ts', source);
		expect(sites.map((s) => s.target)).toEqual(['paths[i]']);
		expect(sites[0]?.writePath).toBeNull();
	});
});
