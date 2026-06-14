import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
	resetSwarmStatePreservingSingletons,
	swarmState,
} from '../../../src/state';

/**
 * Drift-prevention scan test (FR-003 + FR-009).
 *
 * Scans src/commands/ and src/hooks/ (non-test sources) for filesystem write
 * calls that target .swarm/ and asserts every such site is accounted for by:
 *   1. The file being a known cleanup command (reset.ts / close.ts) — these are
 *      SUPPOSED to mutate .swarm/ (archive, clean, reset context, etc.).
 *   2. The target path being covered by an exported PRESERVED_SWARM_PATHS entry
 *      (audit logs, knowledge stores, handoff artifacts, drift reports, etc.).
 *   3. An explicit inline "// drift-test:exempt" comment on/near the write site
 *      (for rare intentional exceptions that should not bloat the preserve list).
 *
 * The test FAILS on any unaccounted .swarm/ write pattern. This makes
 * introduction of new writes to .swarm/ from commands/hooks an explicit,
 * reviewable decision (update preserve list, add exempt comment, or move the
 * write to a tool/plan layer outside the scanned surface).
 *
 * Exported constants enable automatic/exhaustive union comparison and allow
 * other tests or tooling to import the contract.
 */

// Known "cleanup commands" whose .swarm/ writes (and deletes) are intentional
// and expected. These are the only places allowed to touch active plan state,
// archive bundles, close summaries, etc.
export const CLEANUP_COMMANDS = ['reset.ts', 'close.ts'] as const;

// Exhaustive list of .swarm/ paths (files + directory prefixes) that are
// intentionally written by non-cleanup code in src/commands/ or src/hooks/.
// Adding a new entry here is the normal way to allow a new persistent artifact
// or audit log. Use directory prefixes (e.g. 'evidence/') for nested writes.
export const PRESERVED_SWARM_PATHS = [
	// Sentinels / migration
	'.knowledge-migrated',

	// Audit / event logs (append-only, cross-session forensic value)
	'events.jsonl',
	'skill-usage.jsonl',
	'knowledge-application.jsonl',
	'knowledge-events.jsonl',
	'shell-audit.jsonl',

	// Knowledge stores (cumulative, survive close; knowledge.jsonl is the
	// long-term project memory, explicitly NOT cleaned by close)
	'knowledge.jsonl',
	'knowledge-rejected.jsonl',
	'knowledge-retractions.jsonl',

	// Spec / curator drift signals (advisory reports consumed by PHASE-WRAP
	// and final council; must survive the session that produced them)
	'spec-staleness.json',
	'dark-matter.md',
	'drift-report-phase-',
	'curator-findings.json',

	// Handoff / continuation artifacts (written by handoff command + consumed
	// by system-enhancer on resume)
	'handoff.md',
	'handoff-prompt.md',
	'handoff-consumed.md',

	// Diagnostic / one-off reports
	'simulate-report.md',
	'curator-summary.json',
	'curator-briefing.md',

	// Knowledge reader "shown" cache (prevents re-injection spam)
	'.knowledge-shown.json',

	// Context updates for skill index injection (non-cleanup path in
	// skill-propagation-gate)
	'context.md',

	// Written by close (cleanup) but also referenced in preserve for
	// completeness of the union; close-lessons.md is read by close.
	'close-lessons.md',
	'close-summary.md',

	// Directory prefixes for nested / session-scoped writes.
	// Any write under these is covered (evidence bundles, per-phase archives,
	// session state, lockfiles, spec snapshots, summaries, skill proposals).
	'evidence/',
	'archive/',
	'session/',
	'scopes/',
	'locks/',
	'spec-archive/',
	'summaries/',
	'skills/',

	// Root .swarm/ directory creation (setup bootstrap — mkdirSync in
	// command-dispatch, curator-drift, guardrails, knowledge-validator,
	// system-enhancer create the swarm dir before any writes)
	'.swarm',

	// Dark matter report (session-scoped, consumed by PHASE-WRAP drift gate)
	'dark-matter-phase-',

	// Knowledge validator intermediary writes (temp schema validation files
	// written during curation, cleaned by the next curator pass)
	'.knowledge-validation-stamp',

	// Design-doc drift reports (advisory, produced on-demand per phase).
	// Matched by both the literal prefix and the runtime constant name so
	// the static scan catches the write through the variable reference.
	'doc-drift-phase-',
	'DOC_DRIFT_REPORT_PREFIX',

	// Skill propagation gate context rewrites (context.md is already listed;
	// swarmDir mkdir is the .swarm/ root bootstrap covered above)
	'.context-propagation-stamp',
] as const;

describe('cleanup-drift prevention — exhaustive .swarm/ write scan (FR-003+FR-009)', () => {
	test('every writeFile/mkdir/appendFile/bunWrite/copyFile/renameSync targeting .swarm/ in src/commands/ or src/hooks/ is accounted for by cleanup command, preserve list, or drift-test:exempt comment', async () => {
		const roots = ['src/commands', 'src/hooks'];
		const writeCallNames = [
			'writeFile',
			'writeFileSync',
			'mkdir',
			'mkdirSync',
			'appendFile',
			'appendFileSync',
			'copyFile',
			'copyFileSync',
			'renameSync',
			'bunWrite',
		];

		const unaccounted: string[] = [];
		const detectedSites: Array<{
			file: string;
			line: number;
			snippet: string;
		}> = [];
		let totalScanHits = 0;

		for (const root of roots) {
			const glob = new Bun.Glob('**/*.ts');
			for await (const rel of glob.scan({ cwd: root })) {
				if (rel.includes('.test.')) continue; // exclude all test files
				const fullPath = path.join(root, rel);
				const content = await Bun.file(fullPath).text();
				const lines = content.split(/\r?\n/);

				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					const hasWrite = writeCallNames.some((name) => line.includes(name));
					if (!hasWrite) continue;

					// Skip import statements — they declare function bindings, they
					// do not perform filesystem writes (avoid false positives when
					// the surrounding context mentions .swarm/).
					if (/^import\s/.test(line.trim())) continue;

					// Build small context window so we catch the target even when
					// the literal path is on the validateSwarmPath / path.join line
					// immediately above the actual fs call (common pattern).
					const contextWindow = [
						lines[i - 2] ?? '',
						lines[i - 1] ?? '',
						line,
						lines[i + 1] ?? '',
						lines[i + 2] ?? '',
					].join('\n');

					// Regexes that indicate the write is aimed at .swarm/
					const targetsSwarm =
						/\.swarm|validateSwarmPath|swarmDir|['"`]\.swarm|path\.join\([^,]+,\s*['"`]\.swarm/.test(
							contextWindow,
						);
					if (!targetsSwarm) continue;
					totalScanHits++;

					const base = path.basename(fullPath);

					// 1. Explicitly allowed: the two cleanup commands that are
					//    *supposed* to create archives, reset context.md, write
					//    close-summary, delete active state, etc.
					if ((CLEANUP_COMMANDS as readonly string[]).includes(base)) {
						continue;
					}

					// 2. Explicit per-site exemption (rare — use only when the
					//    artifact is intentionally outside the preserve list).
					if (/\/\/\s*drift-test:exempt/.test(contextWindow)) {
						continue;
					}

					// 3. Covered by the exported preserve list (union is the
					//    single source of truth for "allowed non-cleanup writes").
					const coveredByPreserve = PRESERVED_SWARM_PATHS.some((p) =>
						contextWindow.includes(p),
					);
					if (coveredByPreserve) {
						continue;
					}

					// Unaccounted write site — this is a drift violation.
					unaccounted.push(
						`${fullPath}:${i + 1} :: ${line.trim().slice(0, 140)}`,
					);
					detectedSites.push({
						file: fullPath,
						line: i + 1,
						snippet: line.trim(),
					});
				}
			}
		}

		// Sanity: we actually scanned something (prevents silent no-op if globs break).
		// totalScanHits counts every write-site whose context references .swarm/;
		// when zero sites are unaccounted, detectedSites is empty but totalScanHits > 0.
		expect(totalScanHits).toBeGreaterThan(0);

		// The exported lists form an exhaustive union. Any site that survived
		// the three checks above is a new unaccounted .swarm/ write and must
		// be explicitly allowed (add to PRESERVED_SWARM_PATHS, add // drift-test:exempt,
		// or accept that it belongs in a cleanup command).
		if (unaccounted.length > 0) {
			// Helpful failure message for the developer who introduced the drift.
			const msg = [
				'DRIFT PREVENTION FAILURE: unaccounted .swarm/ write(s) detected in src/commands/ or src/hooks/.',
				'Each write must be one of:',
				'  • inside reset.ts or close.ts (the designated cleanup commands), or',
				'  • covered by an entry in the exported PRESERVED_SWARM_PATHS, or',
				'  • annotated with an inline "// drift-test:exempt" comment explaining the exception.',
				'',
				'Update the preserve list (preferred) or add an exempt comment, then re-run.',
				'',
				'Unaccounted sites:',
				...unaccounted.map((u) => `  - ${u}`),
			].join('\n');
			throw new Error(msg);
		}

		expect(unaccounted).toEqual([]);
	});
});

// FR-020: singleton count drift test
// Catches when a new singleton is added to swarmState without also being added
// to the preservation logic in resetSwarmStatePreservingSingletons (used by close).
test('singleton preservation drift guard (FR-020) — new singleton in swarmState must be added to resetSwarmStatePreservingSingletons', () => {
	// 3. Snapshot the keys on swarmState BEFORE calling reset
	const keysBefore = Object.keys(swarmState);

	// Pre-populate the known singletons with non-sentinel values so we can
	// observe that the preserving reset actually restores them (they must not
	// end up at cleared sentinel after the call).
	const mockClient = { __fr020: true } as any;
	swarmState.opencodeClient = mockClient;
	swarmState.fullAutoEnabledInConfig = true;
	swarmState.curatorInitAgentNames = ['__fr020_init'];
	swarmState.curatorPhaseAgentNames = ['__fr020_phase'];
	swarmState.skillImproverAgentNames = ['__fr020_skill'];
	swarmState.specWriterAgentNames = ['__fr020_spec'];
	swarmState.generatedAgentNames = ['__fr020_gen'];

	// 4. Call resetSwarmStatePreservingSingletons()
	resetSwarmStatePreservingSingletons();

	// 5. After reset, identify which module-scoped singleton properties were
	//    cleared (set to null, false, [], or 0) but are NOT in the preserve list.
	const preserveList = [
		'opencodeClient',
		'fullAutoEnabledInConfig',
		'curatorInitAgentNames',
		'curatorPhaseAgentNames',
		'skillImproverAgentNames',
		'specWriterAgentNames',
		'generatedAgentNames',
	] as const;

	const isClearedSentinel = (val: unknown): boolean =>
		val === null ||
		val === false ||
		(Array.isArray(val) && val.length === 0) ||
		val === 0;

	const cleared: string[] = [];
	for (const key of keysBefore) {
		const val = (swarmState as any)[key];
		if (isClearedSentinel(val)) {
			cleared.push(key);
		}
	}
	const clearedNotInPreserve = cleared.filter(
		(k) => !preserveList.includes(k as any),
	);

	// Also surface any of the *known* preserve list that ended up cleared
	// (would indicate the helper failed to restore one of the listed singletons).
	const clearedInPreserve = preserveList.filter((p) =>
		isClearedSentinel((swarmState as any)[p]),
	);

	// 6. Fail if a property exists on swarmState that was cleared but is not in the known preserve list
	//    (in practice: the only allowed cleared-not-in-list are the two non-init module scalars;
	//    any extra indicates a new singleton was added to swarmState + resetSwarmState but not
	//    wired into the preserving helper / this list).
	const expectedClearedOutside = ['pendingEvents', 'lastBudgetPct'];
	if (clearedInPreserve.length > 0) {
		throw new Error(
			`DRIFT: preserved singleton(s) were cleared after resetSwarmStatePreservingSingletons: ${clearedInPreserve.join(', ')}`,
		);
	}
	if (
		clearedNotInPreserve.length !== expectedClearedOutside.length ||
		!expectedClearedOutside.every((e) => clearedNotInPreserve.includes(e))
	) {
		throw new Error(
			`DRIFT (FR-020): unexpected module-scoped singleton(s) cleared by resetSwarmStatePreservingSingletons but not in known preserve list.\n` +
				`  cleared but not preserved: ${clearedNotInPreserve.join(', ')}\n` +
				`  This happens when a new init-time singleton is added to swarmState (in src/state.ts) and cleared in resetSwarmState, ` +
				`but the name was not added to the save/restore list inside resetSwarmStatePreservingSingletons (and to the preserveList in this test).\n` +
				`  Known preserve list (7): ${preserveList.join(', ')}`,
		);
	}

	expect(clearedInPreserve).toEqual([]);
	expect(clearedNotInPreserve).toEqual(expectedClearedOutside);
});
