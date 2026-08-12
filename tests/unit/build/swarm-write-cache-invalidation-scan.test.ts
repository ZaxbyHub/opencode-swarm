/**
 * G2 guardrail (issue #1729 follow-up) — assertions. The scanner machinery
 * lives in tests/helpers/swarm-write-cache-scan.ts; read its docblock for the
 * rules, the deliberate exclusions and the known limitations.
 *
 * This file holds the whole-tree scan: every `.swarm/` cached-artifact write in
 * src/ must invalidate the swarm-artifact-cache — plus the meta-assertions that
 * keep the ENUMERATION honest, which is what four consecutive missed writers
 * (#1619 rounds 1-4) proved was the real defect.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	blankedSource,
	CACHED_READER_SIGNATURES,
	CACHED_READER_WRAPPER,
	collectCachedArtifactFilenames,
	collectExportedCacheReaders,
	collectWriteSitesFromSource,
	harvestCachedArtifacts,
	isSpecificName,
	listScannedSourceFiles,
	mentionsEvidencePath,
	readScannedSource,
	registryKey,
	resolveRegistryPatterns,
	scanTree,
	UNRESOLVED_READER_REGISTRY,
	WHOLE_TREE_SCAN_TIMEOUT_MS,
} from '../../helpers/swarm-write-cache-scan';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

describe('G2 — .swarm/ cached-artifact writers must invalidate the swarm-artifact-cache (#1729)', () => {
	test(
		'every rename/direct-write/transactFile over a cached artifact invalidates it',
		() => {
			const cachedFilenames = collectCachedArtifactFilenames();
			expect(cachedFilenames.size).toBeGreaterThan(0); // falsifiability

			const violations = scanTree(cachedFilenames);
			if (violations.length > 0) {
				const report = violations
					.map(
						(v) =>
							`  [rule ${v.rule}] ${v.file}:${v.line} — ${v.detail} (artifact: ${v.filename})`,
					)
					.join('\n');
				throw new Error(
					`Found ${violations.length} cached .swarm/ artifact write(s) with no invalidateCachedArtifact(...) call:\n${report}\n\n` +
						`Cached artifact names (from readSwarmFileAsync / readCachedTextFile(Sync) / readCachedParsedFile(Sync) call sites plus UNRESOLVED_READER_REGISTRY): ${[...cachedFilenames].sort().join(', ')}\n\n` +
						`Fix: call invalidateCachedArtifact(<targetPath>) immediately after the SUCCESSFUL write (see src/evidence/task-file.ts:atomicWriteFile for the reference pattern).`,
				);
			}
			expect(violations).toEqual([]);
		},
		WHOLE_TREE_SCAN_TIMEOUT_MS,
	);

	test('sanity: the cached-artifact name set includes every artifact this scan is about', () => {
		const cachedFilenames = collectCachedArtifactFilenames();
		for (const name of [
			'plan.md',
			'plan.json',
			'context.md',
			'handoff.md',
			'curator-summary.json',
			'curator-briefing.md',
			'session/state.json',
			'session/budget-state.json',
			// Added 2026-08-10 (#1619 round 5). Each is a PATTERN — an artifact
			// whose basename is built by interpolation — and each was structurally
			// unrepresentable before the harvester folded `${…}` to `*` instead of
			// deleting it. `drift-report-phase-*.json` is the round-4 miss itself.
			'summaries/*.json',
			'evidence/*.json',
			'drift-report-phase-*.json',
		]) {
			expect(cachedFilenames.has(name), `missing '${name}'`).toBe(true);
		}
	});

	// #1619 F1: the harvester used to read ONLY `readSwarmFileAsync(...)` call
	// sites, contradicting its own docblock — so `spec-staleness.json`, which
	// src/hooks/system-enhancer.ts:152 consumes through `readCachedParsedFileSync`
	// and src/plan/manager.ts writes with a bare `fsPromises.writeFile`, was
	// invisible to every rule above regardless of R/W/T coverage. Pinning the
	// name here means a regression in `collectCachedArtifactFilenames` fails
	// LOUDLY instead of quietly shrinking the scan's blast radius to zero.
	test('the name set covers artifacts reached through the non-readSwarmFileAsync cached readers', () => {
		const cachedFilenames = collectCachedArtifactFilenames();
		expect(
			cachedFilenames.has('spec-staleness.json'),
			"missing 'spec-staleness.json' — collectCachedArtifactFilenames must " +
				'harvest the first argument of readCachedTextFile(Sync) / ' +
				'readCachedParsedFile(Sync), not just readSwarmFileAsync',
		).toBe(true);
	});

	/**
	 * Degenerate names are the flood hazard that mirrors the blindness hazard.
	 * Two real leaks were produced while building the pattern engine (`*.json/*`
	 * from a bare wildcard basename, `evidence/*.json/*` from a multi-line call's
	 * trailing comma); both were caught by eye, which is exactly the detection
	 * method that failed four rounds. This makes the check automatic.
	 */
	test('no harvested artifact name is degenerate enough to flood the scan', () => {
		const forbidden = new Set([
			'*',
			'.json',
			'.md',
			'.jsonl',
			'*.json',
			'*.md',
			'*.jsonl',
		]);
		for (const name of collectCachedArtifactFilenames()) {
			expect(forbidden.has(name), `degenerate cached name '${name}'`).toBe(
				false,
			);
			expect(isSpecificName(name), `non-specific cached name '${name}'`).toBe(
				true,
			);
		}
	});
});

describe('G2 enumeration — the scan cannot go silently blind (#1619 round 5)', () => {
	/**
	 * The mechanism fix. Every cached-reader call site must land in EXACTLY one
	 * bucket: folded to an artifact name, or registered with a stated reason. A
	 * site that lands in neither — which is what happened to
	 * `drift-report-phase-<N>.json` — used to disappear silently.
	 */
	test('every cached-reader call site is either resolved or registered', () => {
		const harvest = harvestCachedArtifacts();
		expect(harvest.totalCallSites).toBeGreaterThan(0);
		expect(harvest.resolvedCallSites + harvest.unresolved.length).toBe(
			harvest.totalCallSites,
		);
	});

	test('the unresolved-reader registry matches the discovered sites exactly', () => {
		const harvest = harvestCachedArtifacts();
		const discovered = new Set(harvest.unresolved.map(registryKey));
		const registered = new Set(UNRESOLVED_READER_REGISTRY.map(registryKey));

		const unregistered = [...discovered].filter((k) => !registered.has(k));
		expect(
			unregistered,
			'A cached reader whose path argument cannot be resolved statically is ' +
				'INVISIBLE to every write rule. Add it to UNRESOLVED_READER_REGISTRY ' +
				'in tests/helpers/swarm-write-cache-scan.ts with a category, a reason, ' +
				'and — if it reads a cached artifact — the artifact patterns it reads.',
		).toEqual([]);

		const stale = [...registered].filter((k) => !discovered.has(k));
		expect(
			stale,
			'UNRESOLVED_READER_REGISTRY entries that no longer match any call site. ' +
				'A stale entry can inject a cached-name pattern nothing reads any ' +
				'more; delete it.',
		).toEqual([]);
	});

	/**
	 * A hand-declared pattern is a new silent-failure surface: rename the thing
	 * it was derived from and the rule goes dead with a green test. Every
	 * declared pattern must therefore be tied to something the scan can still
	 * see, one of exactly two ways:
	 *
	 *   a. it interpolates a constant (`${DRIFT_REPORT_PREFIX}*.json`), in which
	 *      case `resolveRegistryPatterns` throws if the constant is gone and
	 *      every literal fragment of the resolved pattern must still appear in
	 *      the registered file; or
	 *   b. it is INDEPENDENTLY harvested from a resolvable reader elsewhere in
	 *      src/, in which case the entry adds no coverage of its own and dies
	 *      the moment that other reader stops naming the artifact; or
	 *   c. (#1619 round 6) it is a DIRECTORY-CLASS pattern ending in `**`. Such
	 *      a pattern is deliberately BROADER than anything a resolvable reader
	 *      names — that is the whole point of it, so (b) can never hold — and it
	 *      is tethered instead by requiring every literal segment before the
	 *      `**` to still appear in the registered file. That proves the
	 *      directory the reader walks is still spelled that way there; it does
	 *      NOT prove the reader's filter is still that broad, which is why the
	 *      entry's reason must quote the filter it was derived from.
	 */
	test('registry-declared patterns are cross-checked against a live source', () => {
		const harvested = harvestCachedArtifacts().names;
		for (const entry of UNRESOLVED_READER_REGISTRY) {
			expect(
				entry.reason.length,
				`${registryKey(entry)} has no reason`,
			).toBeGreaterThan(40);
			if (entry.category === 'declared-patterns') {
				expect(
					entry.patterns.length,
					`${registryKey(entry)} is 'declared-patterns' but declares none`,
				).toBeGreaterThan(0);
			} else {
				expect(
					entry.patterns,
					`${registryKey(entry)} is '${entry.category}' and must declare no patterns`,
				).toEqual([]);
			}
			const source = readFileSync(join(REPO_ROOT, entry.file), 'utf-8');
			const resolvedPatterns = resolveRegistryPatterns(entry);
			for (const [i, resolved] of resolvedPatterns.entries()) {
				const declared = entry.patterns[i] as string;
				if (declared.includes('${')) {
					for (const fragment of resolved.split('*')) {
						if (fragment.length < 2) continue;
						expect(
							source.includes(fragment),
							`${registryKey(entry)} declares '${declared}' (resolving to ` +
								`'${resolved}'), but the literal fragment '${fragment}' no ` +
								`longer appears in ${entry.file}`,
						).toBe(true);
					}
					continue;
				}
				if (resolved.endsWith('/**')) {
					// The segment must appear as a PATH segment — a quoted
					// `'evidence'` argument or inside a `'…/evidence/…'` literal — not
					// merely as the word "evidence" somewhere in the file, which
					// occurs 74 times in knowledge-curator.ts and would make the
					// tether vacuous.
					const blanked = blankedSource(source).text;
					for (const segment of resolved.split('/').slice(0, -1)) {
						const asSegment = new RegExp(
							`['"\`/]${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`/]`,
						);
						expect(
							asSegment.test(blanked),
							`${registryKey(entry)} declares the directory-class pattern ` +
								`'${resolved}', but '${segment}' no longer appears as a PATH ` +
								`SEGMENT in ${entry.file}. A '**' pattern is broader than ` +
								'anything a resolvable reader names, so its only tether is ' +
								'that the directory it walks is still spelled this way in the ' +
								'file that walks it.',
						).toBe(true);
					}
					continue;
				}
				expect(
					harvested.has(resolved),
					`${registryKey(entry)} declares the fixed pattern '${resolved}', ` +
						'which is no longer harvested from any resolvable reader in src/. ' +
						'Either tie it to a constant in its own file with ${IDENT}, or ' +
						'drop it — an untethered hand-written pattern can silently stop ' +
						'describing anything real.',
				).toBe(true);
			}
		}
	});

	/**
	 * Round 3's miss (`spec-staleness.json`) happened because the harvester knew
	 * about the wrapper but not the cache module's own readers. Deriving the list
	 * from the module's exports makes a fifth cached reader fail the gate instead
	 * of shrinking the blast radius to zero.
	 */
	/**
	 * #1619 round 6. Every check in this scan runs on comment-blanked source, so
	 * the blanker losing sync is a silent whole-file failure: a regex literal
	 * containing an odd number of backticks (src/tools/completion-verify.ts has
	 * one) used to flip template-literal parity and leave every comment after it
	 * UNBLANKED, at which point a commented-out `invalidateCachedArtifact(...)`
	 * satisfied the guard. The lexer now models regex literals; this assertion
	 * makes any future gap loud instead of silent.
	 */
	test('the comment blanker ends in code state for every file in src/', () => {
		const files = listScannedSourceFiles();
		expect(files.length).toBeGreaterThan(100);
		const desynced = files
			.map((rel) => [rel, blankedSource(readScannedSource(rel))] as const)
			.filter(([, blanked]) => blanked.terminalMode !== 'code')
			.map(([rel, blanked]) => `${rel} -> ${blanked.terminalMode}`);
		expect(
			desynced,
			'blankComments lost sync on these files. Everything after the desync ' +
				'point is scanned in the wrong lexer state, so comments there are ' +
				'never blanked and prose can satisfy or trip any check.',
		).toEqual([]);
	});

	test('the blanker treats a regex literal as code, not as a string', () => {
		const withBacktickRegex = [
			'const backtickRegex = /`([^`]+)`/g;',
			'// invalidateCachedArtifact(planPath);',
			'const x = 1;',
		].join('\n');
		const blanked = blankedSource(withBacktickRegex);
		expect(blanked.terminalMode).toBe('code');
		expect(blanked.text).not.toContain('invalidateCachedArtifact');
		// Division must NOT be read as a regex.
		const division = blankedSource(
			'const ratio = a / b; // note\nconst c = 2;',
		);
		expect(division.terminalMode).toBe('code');
		expect(division.text).not.toContain('note');
	});

	/**
	 * The write-side candidate filter is deliberately generous: it matches IMPORT
	 * SPECIFIERS too (`from '../evidence/lock.js'`), which is why several
	 * registered blind spots are not evidence writers at all. Over-inclusion
	 * costs a longer registry; under-inclusion recreates the blindness.
	 *
	 * Round 7 widened it to IDENTIFIERS. Through round 6 it required a QUOTED
	 * LITERAL containing `evidence`, so a module importing an evidence-path
	 * constant or helper from another module — `import { EVIDENCE_DIR } from
	 * '../paths.js'` — was dropped from the enumeration entirely, and because
	 * resolution is single-file its target folded to null anyway. That is the
	 * same "invisible to the rules AND to the enumeration" shape the head table
	 * closes on the head axis, so it is closed here too. The cost was measured
	 * before the change: 124 -> 237 candidate files, +8 registered blind spots.
	 */
	test('mentionsEvidencePath matches path segments, import specifiers and identifiers', () => {
		expect(mentionsEvidencePath("path.join(dir, 'evidence', id)")).toBe(true);
		expect(mentionsEvidencePath("path.join('evidence/gate-audit')")).toBe(true);
		expect(
			mentionsEvidencePath("import { x } from '../evidence/lock.js';"),
		).toBe(true);
		// The round-7 widening. These used to be `false`, which is exactly how a
		// cross-module evidence-path import escaped the enumeration.
		expect(mentionsEvidencePath('const evidence = collect();')).toBe(true);
		expect(
			mentionsEvidencePath("import { EVIDENCE_DIR } from '../paths.js';"),
		).toBe(true);
		expect(mentionsEvidencePath('const p = resolveEvidencePath(dir);')).toBe(
			true,
		);
		// Still bounded: comments are blanked first, and an unrelated identifier
		// that merely CONTAINS the letters is not matched across a boundary.
		expect(mentionsEvidencePath("// writes to 'evidence/x.json'")).toBe(false);
		expect(mentionsEvidencePath('const planPath = join(dir, x);')).toBe(false);
	});

	test('collectWriteSitesFromSource records folded and unfoldable targets', () => {
		const source = [
			'function write(directory: string) {',
			"	const p = path.join(directory, '.swarm', 'evidence', 'a.json');",
			'	const other = resolveSomehow(directory);',
			'	writeFileSync(p, body);',
			'	writeFileSync(other, body);',
			'	handle.writeFile(JSON.stringify(payload));',
			'}',
		].join('\n');
		const sites = collectWriteSitesFromSource('src/fixture.ts', source);
		// The FileHandle payload argument is not a path expression and is dropped.
		expect(sites.map((s) => s.target)).toEqual(['p', 'other']);
		expect(sites[0]?.writePath).toBe('evidence/a.json');
		expect(sites[1]?.writePath).toBeNull();
	});

	test('CACHED_READER_SIGNATURES covers every exported reader of the cache module', () => {
		const exported = collectExportedCacheReaders();
		expect(exported.size).toBeGreaterThan(0);
		const known = new Set(CACHED_READER_SIGNATURES.map((sig) => sig.name));
		const missing = [...exported].filter((name) => !known.has(name));
		expect(
			missing,
			'src/utils/swarm-artifact-cache.ts exports a cached reader this scan ' +
				'does not harvest. Add it to CACHED_READER_SIGNATURES with the index ' +
				'of its path argument.',
		).toEqual([]);
		const extra = [...known].filter((name) => !exported.has(name));
		expect(
			extra,
			'The only reader outside the cache module is the readSwarmFileAsync ' +
				'wrapper in src/hooks/utils.ts.',
		).toEqual([CACHED_READER_WRAPPER]);
	});
});
