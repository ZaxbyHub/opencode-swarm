/**
 * Issue #2483 (fix-plan §8, frozen check C3 companion): every one of the
 * nine capped durable writers actually CLAMPS at the effective cap.
 *
 * The writers' production defaults (200–10 000 entries / 64 KiB–8 MiB bytes)
 * are impractical to exceed in a unit test, so this suite shrinks every cap
 * through the test seam (`setRetentionCapOverrides`) to 8 entries / 512
 * bytes, writes override+5 records through the PRODUCTION writers, and
 * asserts the durable artifact stays at or under the override. A writer that
 * reads only its own exported constant cannot pass this suite.
 *
 * Also covers: crash-atomicity of the compaction rewrite (valid JSONL, no
 * `.tmp` residue), a genuine process-restart reopen (a fresh module instance
 * in a spawned bun child reads the bounded file), and the shared tail
 * reader's malformed-line/missing-file behavior.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import * as delegateAckCollector from '../../../src/hooks/delegate-ack-collector';
import * as receiptLedger from '../../../src/hooks/knowledge-receipt-ledger';
import * as knowledgeStore from '../../../src/hooks/knowledge-store';
import * as curationPolicy from '../../../src/knowledge/curation-policy';
import * as consolidationLog from '../../../src/memory/consolidation-log';
import {
	clearRetentionCapOverrides,
	setRetentionCapOverrides,
} from '../../../src/retention/caps';
import { readTailJsonl } from '../../../src/retention/jsonl-cap';
import * as compactionServiceMod from '../../../src/services/compaction-service';
import * as skillChangelog from '../../../src/services/skill-changelog';
import * as state from '../../../src/state';
import * as historyStore from '../../../src/test-impact/history-store';
import * as calibration from '../../../src/turbo/epic/calibration';
import * as divergenceRecorder from '../../../src/turbo/epic/divergence-recorder';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const OVERRIDE_COUNT_CAP = 8;
const OVERRIDE_BYTES_CAP = 512;
const WRITE_ENTRIES = OVERRIDE_COUNT_CAP + 5;

const tempRoots: string[] = [];

function makeRoot(label: string): string {
	const root = canonicalMkdtemp(`bounded-2483-${label}-`);
	tempRoots.push(root);
	// Pre-create `.swarm` SYNCHRONOUSLY. The production writers under test
	// create it through `node:fs/promises` mkdir — which a sibling test file
	// (e.g. tests/unit/config/default-agent-config.test.ts) may have replaced
	// process-wide with a leaked no-op `mock.module('node:fs/promises')`
	// (Bun's shared test-runner process, AGENTS.md invariant 7). Sync fs is
	// never mocked, so seeding the directory here keeps this file green in
	// co-runs regardless of another file's mock hygiene.
	mkdirSync(path.join(root, '.swarm'), { recursive: true });
	return root;
}

function countJsonlLines(filePath: string): number {
	return readFileSync(filePath, 'utf-8')
		.split('\n')
		.filter((line) => line.trim().length > 0).length;
}

/** Every non-empty line must JSON.parse — a torn compaction fails this. */
function assertValidJsonl(filePath: string): number {
	const lines = readFileSync(filePath, 'utf-8')
		.split('\n')
		.filter((line) => line.trim().length > 0);
	for (const line of lines) {
		expect(() => JSON.parse(line)).not.toThrow();
	}
	return lines.length;
}

/** Crash-atomicity residue check: no temp+rename leftovers in the dir. */
function assertNoTmpResidue(dir: string): void {
	if (!existsSync(dir)) return;
	const residue = readdirSync(dir).filter((name) => name.includes('.tmp-'));
	expect(residue).toEqual([]);
}

beforeEach(() => {
	setRetentionCapOverrides({
		MAX_RETRACTION_RECORDS: OVERRIDE_COUNT_CAP,
		MAX_UNACKNOWLEDGED_CRITICALS: OVERRIDE_COUNT_CAP,
		MAX_CURATION_PROPOSALS: OVERRIDE_COUNT_CAP,
		MAX_CONSOLIDATION_LOG_ENTRIES: OVERRIDE_COUNT_CAP,
		MAX_CONTEXT_SNAPSHOT_BYTES: OVERRIDE_BYTES_CAP,
		MAX_CALIBRATION_MODULES: OVERRIDE_COUNT_CAP,
		MAX_DIVERGENCE_BYTES: OVERRIDE_BYTES_CAP,
		MAX_TEST_HISTORY_ENTRIES: OVERRIDE_COUNT_CAP,
		MAX_TEST_HISTORY_KEYS: OVERRIDE_COUNT_CAP,
		MAX_SKILL_CHANGELOG_GLOBAL_ENTRIES: OVERRIDE_COUNT_CAP,
		MAX_SKILL_CHANGELOG_ENTRIES_PER_SKILL: OVERRIDE_COUNT_CAP,
	});
});

afterEach(() => {
	clearRetentionCapOverrides();
	for (const root of tempRoots) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			/* best-effort teardown */
		}
	}
	tempRoots.length = 0;
});

describe('bounded writers clamp at the overridden cap (issue #2483)', () => {
	it('knowledge-store retractions: durable records <= override after override+5 appends', async () => {
		const root = makeRoot('retractions');
		for (let i = 0; i < WRITE_ENTRIES; i++) {
			await knowledgeStore.appendRetractionRecord(root, {
				id: `retr-${i}`,
				retracted_lesson: `lesson ${i}`,
				normalized_lesson: `lesson ${i}`,
				recorded_at: new Date().toISOString(),
				reported_by: 'bounded-test',
				matched_swarm_ids: [],
				matched_hive_ids: [],
			});
		}
		const records = await knowledgeStore.readRetractionRecords(root);
		expect(records.length).toBeLessThanOrEqual(OVERRIDE_COUNT_CAP);
		expect(records.length).toBeGreaterThan(0);
		const filePath = path.join(root, '.swarm', 'knowledge-retractions.jsonl');
		expect(assertValidJsonl(filePath)).toBeLessThanOrEqual(OVERRIDE_COUNT_CAP);
		assertNoTmpResidue(path.dirname(filePath));
	});

	it('delegate-ack-collector unacknowledged-criticals: driven end-to-end through commitDisplayedMembership + collectDelegateAcks', async () => {
		const root = makeRoot('unack');
		const sessionId = 'sess-bounded-2483';
		let fired = 0;
		for (let i = 0; i < WRITE_ENTRIES; i++) {
			const traceId = `bounded-trace-${i}`;
			const entryId = `bounded-crit-${i}`;
			const committed = await receiptLedger.commitDisplayedMembership(root, {
				trace_id: traceId,
				session_id: sessionId,
				entries: [{ entry_id: entryId, critical: true }],
			});
			if (!committed || committed.ok !== true) continue;
			const prompt =
				'<delegate_knowledge_directives>\n' +
				`trace_id: ${traceId}\n` +
				`- id: ${entryId}\n` +
				'  priority: critical\n' +
				'</delegate_knowledge_directives>';
			const result = await delegateAckCollector.collectDelegateAcks({
				directory: root,
				prompt,
				transcript: '',
				agent: 'coder',
				sessionId,
			});
			if (Array.isArray(result?.unacknowledgedCriticals)) {
				fired += result.unacknowledgedCriticals.length;
			}
		}
		expect(fired).toBeGreaterThan(0);
		const filePath = path.join(
			root,
			'.swarm',
			'unacknowledged-criticals.jsonl',
		);
		expect(countJsonlLines(filePath)).toBeLessThanOrEqual(OVERRIDE_COUNT_CAP);
		expect(assertValidJsonl(filePath)).toBeLessThanOrEqual(OVERRIDE_COUNT_CAP);
		assertNoTmpResidue(path.dirname(filePath));
	});

	it('curation-policy proposals: entry-not-found path persists a capped audit stream', async () => {
		const root = makeRoot('curation');
		for (let i = 0; i < WRITE_ENTRIES; i++) {
			const result = await curationPolicy.authorizeCuration(
				{
					directory: root,
					action: 'retire',
					entryId: `missing-entry-${i}`,
					evidenceScope: 'local-session',
				},
				{ config: {}, entry: null },
			);
			expect(result?.basis).toBe('entry-not-found');
		}
		// persistProposal defers through queueMicrotask + async fs — flush the
		// microtask/macrotask chain (bounded, mirrors frozen check C3).
		for (let k = 0; k < 50; k++) {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		const storeDir = curationPolicy._internals.resolveKnowledgeStoreDir(root);
		const filePath = path.join(storeDir, 'curation-proposals.jsonl');
		expect(assertValidJsonl(filePath)).toBeLessThanOrEqual(OVERRIDE_COUNT_CAP);
		assertNoTmpResidue(storeDir);
	});

	it('consolidation-log: reader returns <= override after override+5 appends', async () => {
		const root = makeRoot('consolidation');
		for (let i = 0; i < WRITE_ENTRIES; i++) {
			await consolidationLog.appendConsolidationLog(root, {
				phaseNumber: i + 1,
				runId: `run-${i}`,
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
				clusterCount: 1,
				clustersDeferred: 0,
				decisionsEmitted: 1,
				added: 1,
				superseded: 0,
				contradictionsDetected: 0,
				deduped: 0,
				proposed: 0,
				memoriesDecayed: 0,
				errored: 0,
				processedProposalIds: [],
			});
		}
		const records = await consolidationLog.readConsolidationLog(root);
		expect(records.length).toBeLessThanOrEqual(OVERRIDE_COUNT_CAP);
		expect(records.length).toBeGreaterThan(0);
		const filePath = path.join(
			root,
			'.swarm',
			'memory',
			'consolidation-log.jsonl',
		);
		expect(assertValidJsonl(filePath)).toBeLessThanOrEqual(OVERRIDE_COUNT_CAP);
		assertNoTmpResidue(path.dirname(filePath));
	});

	it('compaction-service context-snapshot: byte cap clamps and never empties a non-empty snapshot', async () => {
		const root = makeRoot('snapshot');
		// appendSnapshot appends without mkdir-ing .swarm (production assumes
		// plugin init created it) — mirror that precondition (frozen check C3).
		const svc = compactionServiceMod.createCompactionService(
			{
				enabled: true,
				observationThreshold: 10,
				reflectionThreshold: 30,
				emergencyThreshold: 90,
				preserveLastNTurns: 3,
			},
			root,
			() => {},
		);
		for (let i = 0; i < WRITE_ENTRIES + 2; i++) {
			const sessionId = `bounded-snap-session-${i}`;
			state.setFinalPromptPressure(sessionId, {
				pct: 50,
				usedTokens: 50000,
				limitTokens: 100000,
				estimatorSource: 'bounded-test',
				providerReported: false,
			});
			await svc.toolAfter({ tool: 'Read', sessionID: sessionId }, {});
		}
		const filePath = path.join(root, '.swarm', 'context-snapshot.md');
		expect(existsSync(filePath)).toBe(true);
		const bytes = statSync(filePath).size;
		expect(bytes).toBeLessThanOrEqual(OVERRIDE_BYTES_CAP);
		// Whole-record floor: a non-empty snapshot is never emptied by the cap.
		expect(bytes).toBeGreaterThan(0);
		assertNoTmpResidue(path.dirname(filePath));
	});

	it('calibration hotModuleAdditions: persisted list truncated to the cap on save+load', () => {
		const root = makeRoot('calibration');
		const persist = {
			...calibration.emptyCalibrationState(),
			hotModuleAdditions: Array.from(
				{ length: WRITE_ENTRIES },
				(_, i) => `src/mod-${i}.ts`,
			).sort(),
		};
		calibration.saveCalibrationState(root, persist);
		const reloaded = calibration.loadCalibrationState(root);
		expect(reloaded).not.toBeNull();
		const hot = reloaded?.hotModuleAdditions;
		expect(Array.isArray(hot)).toBe(true);
		expect(hot.length).toBeLessThanOrEqual(OVERRIDE_COUNT_CAP);
		// The eviction rule keeps the lexicographically SMALLEST prefix.
		const expected = persist.hotModuleAdditions.slice(0, OVERRIDE_COUNT_CAP);
		expect(hot).toEqual(expected);
		assertNoTmpResidue(path.join(root, '.swarm', 'epic'));
	});

	it('divergence-recorder: byte cap clamps with a whole-record floor', () => {
		const root = makeRoot('divergence');
		for (let i = 0; i < WRITE_ENTRIES; i++) {
			const res = divergenceRecorder.recordTaskDivergence({
				directory: root,
				sessionID: 'bounded-div-session',
				taskId: `T1.${i}`,
				declaredScope: ['src/declared-a.ts'],
				actualFiles: [`src/undeclared-${i}.ts`, 'src/undeclared-other.ts'],
			});
			expect(res).not.toBeNull();
		}
		const filePath = path.join(root, '.swarm', 'epic', 'divergence.jsonl');
		expect(existsSync(filePath)).toBe(true);
		const bytes = statSync(filePath).size;
		expect(bytes).toBeLessThanOrEqual(OVERRIDE_BYTES_CAP);
		// Floor: at least the newest single whole record always survives.
		expect(assertValidJsonl(filePath)).toBeGreaterThan(0);
		assertNoTmpResidue(path.dirname(filePath));
	});

	it('test-impact history-store: GLOBAL entry count clamps on every append', () => {
		const root = makeRoot('test-history');
		// appendTestRun validates the working dir is a project root (direct
		// .git marker per invariant 4) before writing under .swarm/.
		mkdirSync(path.join(root, '.git'), { recursive: true });
		for (let i = 0; i < WRITE_ENTRIES; i++) {
			historyStore.appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: `4.${(i % 5) + 1}`,
					testFile: `tests/unit/bounded-${i}.test.ts`,
					testName: `bounded test ${i}`,
					result: 'pass',
					durationMs: 1,
					changedFiles: [],
				},
				root,
			);
		}
		const total = historyStore.getAllHistory(root);
		expect(total.length).toBeLessThanOrEqual(OVERRIDE_COUNT_CAP);
		expect(total.length).toBeGreaterThan(0);
	});

	it('skill-changelog: GLOBAL entry ceiling across distinct slugs clamps on every append', async () => {
		const root = makeRoot('skill-changelog');
		for (let i = 0; i < WRITE_ENTRIES; i++) {
			await skillChangelog.appendSkillChangelog(root, `bounded-skill-${i}`, {
				version: 1,
				timestamp: new Date().toISOString(),
				action: 'generated',
				reason: `bounded test ${i}`,
			});
		}
		let total = 0;
		for (let i = 0; i < WRITE_ENTRIES; i++) {
			const entries = await skillChangelog.readSkillChangelog(
				root,
				`bounded-skill-${i}`,
			);
			total += entries.length;
		}
		expect(total).toBeLessThanOrEqual(OVERRIDE_COUNT_CAP);
		expect(total).toBeGreaterThan(0);
		assertNoTmpResidue(path.join(root, '.swarm', 'skill-changelogs'));
	});
});

describe('reopen: a fresh module instance reads the bounded durable file', () => {
	it('spawned bun child re-imports knowledge-store and consolidation-log and reads <= cap', async () => {
		const root = makeRoot('reopen');
		for (let i = 0; i < WRITE_ENTRIES; i++) {
			await knowledgeStore.appendRetractionRecord(root, {
				id: `reopen-${i}`,
				retracted_lesson: `lesson ${i}`,
				normalized_lesson: `lesson ${i}`,
				recorded_at: new Date().toISOString(),
				reported_by: 'bounded-test',
				matched_swarm_ids: [],
				matched_hive_ids: [],
			});
			await consolidationLog.appendConsolidationLog(root, {
				phaseNumber: i + 1,
				runId: `run-${i}`,
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
				clusterCount: 1,
				clustersDeferred: 0,
				decisionsEmitted: 1,
				added: 1,
				superseded: 0,
				contradictionsDetected: 0,
				deduped: 0,
				proposed: 0,
				memoriesDecayed: 0,
				errored: 0,
				processedProposalIds: [],
			});
		}
		// Same-module-registry dynamic imports return the cached instance in
		// Bun (verified: a query string does not bust the cache), so a genuine
		// reopen requires a child process. The child re-imports both writer
		// modules fresh and reports the counts its production readers see.
		const childScript =
			'(async () => {' +
			'const { pathToFileURL } = require("node:url");' +
			'const ks = await import(pathToFileURL(process.env.BOUNDED_KS_PATH).href);' +
			'const cl = await import(pathToFileURL(process.env.BOUNDED_CL_PATH).href);' +
			'const root = process.env.BOUNDED_ROOT;' +
			'const retractions = await ks.readRetractionRecords(root);' +
			'const consolidation = await cl.readConsolidationLog(root);' +
			'console.log(JSON.stringify({ retractions: retractions.length, consolidation: consolidation.length }));' +
			'})().catch((err) => { console.error(String(err)); process.exit(1); });';
		const result = await new Promise<{ code: number; output: string }>(
			(resolve) => {
				const child = spawn(process.execPath, ['-e', childScript], {
					cwd: process.cwd(),
					env: {
						...process.env,
						BOUNDED_KS_PATH: path.resolve('src/hooks/knowledge-store.ts'),
						BOUNDED_CL_PATH: path.resolve('src/memory/consolidation-log.ts'),
						BOUNDED_ROOT: root,
					},
					stdio: ['ignore', 'pipe', 'pipe'],
					windowsHide: true,
				});
				let output = '';
				const collect = (chunk: Buffer): void => {
					if (output.length < 64 * 1024) output += chunk.toString('utf-8');
				};
				child.stdout.on('data', collect);
				child.stderr.on('data', collect);
				const timer = setTimeout(() => child.kill(), 60_000);
				child.on('error', (err) => {
					clearTimeout(timer);
					resolve({ code: -1, output: `${output}\n${String(err)}` });
				});
				child.on('close', (code) => {
					clearTimeout(timer);
					resolve({ code: code ?? -1, output });
				});
			},
		);
		expect(result.code).toBe(0);
		const counts = JSON.parse(
			result.output.slice(result.output.indexOf('{')),
		) as { retractions: number; consolidation: number };
		expect(counts.retractions).toBeLessThanOrEqual(OVERRIDE_COUNT_CAP);
		expect(counts.consolidation).toBeLessThanOrEqual(OVERRIDE_COUNT_CAP);
	});
});

describe('readTailJsonl boundedness (shared tail reader)', () => {
	it('skips malformed lines and honors maxEntries', async () => {
		const root = makeRoot('tail-reader');
		const filePath = path.join(root, 'stream.jsonl');
		const lines = ['{"n":1}', 'NOT JSON', '{"n":3}', '', '   ', '{"n":6}'];
		writeFileSync(filePath, `${lines.join('\n')}\n`);
		const records = await readTailJsonl<{ n: number }>(filePath, {
			maxEntries: 2,
		});
		expect(records).toEqual([{ n: 3 }, { n: 6 }]);
	});

	it('returns [] for a missing file', async () => {
		const root = makeRoot('tail-missing');
		const records = await readTailJsonl(path.join(root, 'absent.jsonl'), {
			maxEntries: 5,
		});
		expect(records).toEqual([]);
	});
});
