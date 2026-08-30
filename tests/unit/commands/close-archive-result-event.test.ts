/**
 * Tests that runArchiveStage emits exactly one `close_archive_result` telemetry
 * event carrying the structured per-artifact fields, and that the user-facing
 * archive prose is derived from the SAME result array so the two cannot
 * disagree (issue #2030 items 6, 9).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { CloseStageContext } from '../../../src/commands/close.js';
import { KnowledgeConfigSchema } from '../../../src/config/schema.js';
import { loadDatabaseCtor } from '../../../src/db/sqlite-loader.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let testDir: string;
let emitMock: ReturnType<typeof mock>;
let realEmit: typeof import('../../../src/telemetry.js').emit;

beforeEach(async () => {
	testDir = canonicalMkdtemp('close-archive-event-');
	mkdirSync(path.join(testDir, '.swarm'), { recursive: true });

	emitMock = mock(() => {});
	const telemetry = await import('../../../src/telemetry.js');
	realEmit = telemetry._internals.emit;
	telemetry._internals.emit = emitMock as unknown as typeof realEmit;
});

afterEach(async () => {
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {}
	const telemetry = await import('../../../src/telemetry.js');
	telemetry._internals.emit = realEmit;
	await mock.restore();
});

function makeCtx(): CloseStageContext {
	return {
		directory: testDir,
		swarmDir: path.join(testDir, '.swarm'),
		planData: { title: 'test', phases: [] },
		planExists: false,
		planAlreadyDone: false,
		config: KnowledgeConfigSchema.parse({}),
		projectName: 'test',
		warnings: [],
		closedPhases: [],
		closedTasks: [],
		sessionStart: undefined,
		isForced: false,
		runSkillReview: false,
		options: {},
		phases: [],
		inProgressPhases: [],
		curationSucceeded: false,
		curationResult: undefined,
		allLessons: [],
		explicitLessons: [],
		retroLessons: [],
		knowledgeSkillHint: '',
		skillReviewSummary: '',
		postMortemSummary: '',
		hivePromoted: 0,
		sessionKnowledgeCreated: 0,
		fallbackKnowledgeCreated: 0,
		originalStatuses: new Map(),
		guaranteeResult: { closedPhaseIds: [], closedTaskIds: [] },
		archiveResult: '',
		archivedFileCount: 0,
		archivedActiveStateFiles: new Set<string>(),
		archivedActiveStateDirs: new Set<string>(),
		archiveFailureReasons: new Map<string, string>(),
		archiveResults: [],
		archiveStageFailed: false,
		timestamp: '',
		archiveDir: '',
		archiveSuffix: '',
		args: [],
	};
}

function createRealWalSource(committedRows: number): void {
	const Db = loadDatabaseCtor();
	const srcPath = path.join(testDir, '.swarm', 'swarm.db');
	const db = new Db(srcPath);
	db.run('PRAGMA journal_mode = WAL;');
	db.run(`CREATE TABLE project_constraints (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		constraint_type TEXT NOT NULL,
		content TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	);`);
	db.run(`CREATE TABLE schema_migrations (
		version INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	);`);
	for (let i = 0; i < committedRows; i++) {
		db.run(
			'INSERT INTO project_constraints (constraint_type, content) VALUES (?, ?)',
			['type_a', `row-${i}`],
		);
	}
	db.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [
		1,
		'create_project_constraints',
	]);
	db.close();
}

async function importClose() {
	const mod = await import('../../../src/commands/close.js');
	const ci = mod._internals;
	const emitCloseArchiveResult = mod.emitCloseArchiveResult;
	const realArchiveEvidence = ci.archiveEvidence;
	const realLoadPluginConfigWithMeta = ci.loadPluginConfigWithMeta;
	const realFlush = ci.flushAndDrainTelemetry;
	ci.loadPluginConfigWithMeta = () => ({
		config: {
			knowledge: { enabled: true, hive_enabled: false },
			curator: { enabled: false, postmortem_enabled: false },
			skill_improver: { enabled: false },
			evidence: {},
		},
		loadedFromFile: null,
	});
	ci.archiveEvidence = mock(async () => []);
	ci.flushAndDrainTelemetry = async () => {};
	return {
		ci,
		emitCloseArchiveResult,
		restore() {
			ci.archiveEvidence = realArchiveEvidence;
			ci.loadPluginConfigWithMeta = realLoadPluginConfigWithMeta;
			ci.flushAndDrainTelemetry = realFlush;
		},
	};
}

describe('close_archive_result telemetry event (issue #2030)', () => {
	it('emits exactly one close_archive_result event with structured fields', async () => {
		createRealWalSource(2);
		// Also stage a flat artifact so the result array is non-trivial.
		writeFileSync(
			path.join(testDir, '.swarm', 'telemetry.jsonl'),
			'{"event":"heartbeat"}\n',
		);
		const { ci, emitCloseArchiveResult, restore } = await importClose();
		try {
			const ctx = makeCtx();
			await ci.runArchiveStage(ctx);
			// The event is emitted after clean; mirror the production call order.
			// cleanedFiles includes the succeeded artifacts → their disposition
			// is finalized to 'removed' (the only producer of 'removed').
			emitCloseArchiveResult(ctx, {
				cleanedFiles: ['swarm.db', 'telemetry.jsonl'],
				configBackupsRemoved: 0,
				swarmPlanFilesRemoved: 0,
				residueQuarantined: 0,
				residuePreserved: 0,
			});

			const archiveEvents = emitMock.mock.calls.filter(
				(c: unknown[]) => c[0] === 'close_archive_result',
			);
			expect(archiveEvents.length).toBe(1);

			const payload = archiveEvents[0]![1] as Record<string, unknown>;
			expect(payload.archive_valid).toBe(true);
			expect(payload.archive_empty).toBe(false);
			expect(typeof payload.file_count).toBe('number');
			expect(typeof payload.bundle).toBe('string');

			const artifacts = payload.artifacts as Array<Record<string, unknown>>;
			// swarm.db present with vacuum_into method + row_counts. Cleaned →
			// source_disposition finalized to 'removed' (F-002).
			const dbArt = artifacts.find((a) => a.artifact === 'swarm.db');
			expect(dbArt).toBeDefined();
			expect(dbArt!.method).toBe('vacuum_into');
			expect(dbArt!.attempt).toBe('succeeded');
			expect(dbArt!.validation).toBe('passed');
			expect(dbArt!.source_disposition).toBe('removed');
			expect(dbArt!.row_counts).toBeDefined();
			expect(
				(dbArt!.row_counts as { project_constraints: number })
					.project_constraints,
			).toBe(2);

			// telemetry.jsonl present with copy method; also cleaned → 'removed'.
			const telArt = artifacts.find((a) => a.artifact === 'telemetry.jsonl');
			expect(telArt).toBeDefined();
			expect(telArt!.method).toBe('copy');
		} finally {
			restore();
		}
	});

	it('prose and event agree: a failure makes both report partial/invalid', async () => {
		// Create a corrupt swarm.db so the snapshot fails validation.
		writeFileSync(
			path.join(testDir, '.swarm', 'swarm.db'),
			Buffer.from('not a sqlite database'.padEnd(4096, ' ')),
		);
		const { ci, emitCloseArchiveResult, restore } = await importClose();
		try {
			const ctx = makeCtx();
			await ci.runArchiveStage(ctx);
			emitCloseArchiveResult(ctx, {
				cleanedFiles: [],
				configBackupsRemoved: 0,
				swarmPlanFilesRemoved: 0,
				residueQuarantined: 0,
				residuePreserved: 0,
			});

			// Prose reflects the failure.
			expect(ctx.archiveResult).toContain('failed');

			// Event reflects the same failure.
			const archiveEvents = emitMock.mock.calls.filter(
				(c: unknown[]) => c[0] === 'close_archive_result',
			);
			expect(archiveEvents.length).toBe(1);
			const payload = archiveEvents[0]![1] as Record<string, unknown>;
			expect(payload.archive_valid).toBe(false);

			const artifacts = payload.artifacts as Array<Record<string, unknown>>;
			const dbArt = artifacts.find((a) => a.artifact === 'swarm.db');
			expect(dbArt).toBeDefined();
			expect(dbArt!.attempt).toBe('failed');
			expect(['snapshot_failed', 'validation_failed']).toContain(
				dbArt!.reason_code,
			);
		} finally {
			restore();
		}
	});

	it('archive_empty=true when the only sqlite snapshot has zero domain rows', async () => {
		// Create a valid DB with schema_migrations but no domain rows.
		const Db = loadDatabaseCtor();
		const srcPath = path.join(testDir, '.swarm', 'swarm.db');
		const db = new Db(srcPath);
		db.run('PRAGMA journal_mode = WAL;');
		db.run(
			'CREATE TABLE project_constraints (id INTEGER PRIMARY KEY, x TEXT);',
		);
		db.run(
			'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT);',
		);
		db.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [
			1,
			'init',
		]);
		db.close();

		const { ci, emitCloseArchiveResult, restore } = await importClose();
		try {
			const ctx = makeCtx();
			await ci.runArchiveStage(ctx);
			emitCloseArchiveResult(ctx, {
				cleanedFiles: [],
				configBackupsRemoved: 0,
				swarmPlanFilesRemoved: 0,
				residueQuarantined: 0,
				residuePreserved: 0,
			});

			const archiveEvents = emitMock.mock.calls.filter(
				(c: unknown[]) => c[0] === 'close_archive_result',
			);
			expect(archiveEvents.length).toBe(1);
			const payload = archiveEvents[0]![1] as Record<string, unknown>;
			expect(payload.archive_valid).toBe(true);
			expect(payload.archive_empty).toBe(true);
		} finally {
			restore();
		}
	});

	it('dynamic artifacts (post-mortem/drift-report) appear in the event artifacts[]', async () => {
		// Stage a dynamic artifact that runArchiveStage discovers via readdir
		// (post-mortem-<id>.md). It must be counted in file_count AND appear in
		// the close_archive_result event's artifacts[] array with method:'copy'
		// — otherwise prose (which reflects file_count) and the event disagree
		// (issue #2030 item 6: single source of truth).
		writeFileSync(
			path.join(testDir, '.swarm', 'post-mortem-2030-probe.md'),
			'# Post-mortem\n',
		);
		// Also stage a drift-report so both regex branches are exercised.
		writeFileSync(
			path.join(testDir, '.swarm', 'drift-report-phase-1.json'),
			'{"phase":1}',
		);

		const { ci, emitCloseArchiveResult, restore } = await importClose();
		try {
			const ctx = makeCtx();
			await ci.runArchiveStage(ctx);
			emitCloseArchiveResult(ctx, {
				cleanedFiles: [
					'post-mortem-2030-probe.md',
					'drift-report-phase-1.json',
				],
				configBackupsRemoved: 0,
				swarmPlanFilesRemoved: 0,
				residueQuarantined: 0,
				residuePreserved: 0,
			});

			// Structured result array includes both dynamic artifacts.
			const pmResult = ctx.archiveResults.find(
				(r) => r.artifact === 'post-mortem-2030-probe.md',
			);
			expect(pmResult).toBeDefined();
			expect(pmResult!.attempt).toBe('succeeded');
			expect(pmResult!.method).toBe('copy');

			const driftResult = ctx.archiveResults.find(
				(r) => r.artifact === 'drift-report-phase-1.json',
			);
			expect(driftResult).toBeDefined();
			expect(driftResult!.attempt).toBe('succeeded');

			// Event payload mirrors the same entries.
			const archiveEvents = emitMock.mock.calls.filter(
				(c: unknown[]) => c[0] === 'close_archive_result',
			);
			expect(archiveEvents.length).toBe(1);
			const payload = archiveEvents[0]![1] as Record<string, unknown>;
			const artifacts = payload.artifacts as Array<Record<string, unknown>>;
			expect(
				artifacts.find((a) => a.artifact === 'post-mortem-2030-probe.md'),
			).toBeDefined();
			expect(
				artifacts.find((a) => a.artifact === 'drift-report-phase-1.json'),
			).toBeDefined();
		} finally {
			restore();
		}
	});

	it('wholesale archive-stage failure → archive_valid=false (not vacuously true)', async () => {
		// Regression for swarm-critic F-003: if fs.mkdir(archiveDir) throws,
		// archiveResults stays empty and failedCount === 0, which would make
		// archive_valid=true — inverting the alarm signal. The archiveStageFailed
		// flag must force archive_valid=false.
		const { ci, emitCloseArchiveResult, restore } = await importClose();
		try {
			const ctx = makeCtx();
			ctx.archiveStageFailed = true;
			ctx.archiveResults = []; // empty — as it would be after a mkdir throw
			ctx.archiveResult = 'Archive creation failed (see warnings)';
			emitCloseArchiveResult(ctx, {
				cleanedFiles: [],
				configBackupsRemoved: 0,
				swarmPlanFilesRemoved: 0,
				residueQuarantined: 0,
				residuePreserved: 0,
			});

			const archiveEvents = emitMock.mock.calls.filter(
				(c: unknown[]) => c[0] === 'close_archive_result',
			);
			expect(archiveEvents.length).toBe(1);
			const payload = archiveEvents[0]![1] as Record<string, unknown>;
			expect(payload.archive_valid).toBe(false);
		} finally {
			restore();
		}
	});

	it('failed-archive terminal file unlinked → (failed, removed, copy_failed) tuple', async () => {
		// Regression for swarm-critic F-003: terminal-state files (plan.json etc.)
		// are unlinked unconditionally even when archiving failed. The event must
		// report source_disposition:'removed' (the file IS gone) — NOT 'retained'
		// — with the archive failure carried by attempt/reason_code.
		const { ci, emitCloseArchiveResult, restore } = await importClose();
		try {
			const ctx = makeCtx();
			// plan.json archive failed (copy_failed), but the clean stage removed it.
			ctx.archiveResults = [
				{
					artifact: 'plan.json',
					requiredness: 'required',
					attempt: 'failed',
					validation: 'not_applicable',
					source_disposition: 'retained', // archive-time disposition
					method: 'copy',
					reason_code: 'copy_failed',
					detail: 'EBUSY',
				},
			];
			emitCloseArchiveResult(ctx, {
				cleanedFiles: ['plan.json'], // clean stage removed it anyway
				configBackupsRemoved: 0,
				swarmPlanFilesRemoved: 0,
				residueQuarantined: 0,
				residuePreserved: 0,
			});

			const archiveEvents = emitMock.mock.calls.filter(
				(c: unknown[]) => c[0] === 'close_archive_result',
			);
			expect(archiveEvents.length).toBe(1);
			const payload = archiveEvents[0]![1] as Record<string, unknown>;
			expect(payload.archive_valid).toBe(false);
			const artifacts = payload.artifacts as Array<Record<string, unknown>>;
			const planArt = artifacts.find((a) => a.artifact === 'plan.json');
			expect(planArt).toBeDefined();
			expect(planArt!.attempt).toBe('failed');
			expect(planArt!.source_disposition).toBe('removed');
			expect(planArt!.reason_code).toBe('copy_failed');
		} finally {
			restore();
		}
	});
});

describe('close-summary archive copy', () => {
	it('copies the freshly written summary into a healthy archive bundle', async () => {
		const { ci, restore } = await importClose();
		try {
			const summaryPath = path.join(testDir, '.swarm', 'close-summary.md');
			const archiveDir = path.join(testDir, '.swarm', 'archive', 'swarm-test');
			mkdirSync(archiveDir, { recursive: true });
			writeFileSync(summaryPath, '# current summary');
			const ctx = {
				archiveStageFailed: false,
				archiveDir,
				warnings: [] as string[],
			};

			await ci.archiveCloseSummary(ctx, summaryPath);

			const archivedPath = path.join(archiveDir, 'close-summary.md');
			expect(existsSync(archivedPath)).toBe(true);
			expect(readFileSync(archivedPath, 'utf-8')).toBe('# current summary');
			expect(ctx.warnings).toEqual([]);
		} finally {
			restore();
		}
	});

	it('skips the archive copy when archive creation failed', async () => {
		const { ci, restore } = await importClose();
		try {
			const summaryPath = path.join(testDir, '.swarm', 'close-summary.md');
			const archiveDir = path.join(testDir, '.swarm', 'archive', 'missing');
			writeFileSync(summaryPath, '# current summary');
			const ctx = {
				archiveStageFailed: true,
				archiveDir,
				warnings: [] as string[],
			};

			await ci.archiveCloseSummary(ctx, summaryPath);

			expect(existsSync(path.join(archiveDir, 'close-summary.md'))).toBe(false);
			expect(ctx.warnings).toEqual([]);
		} finally {
			restore();
		}
	});

	it('reports archive-copy failures separately from the primary write', async () => {
		const { ci, restore } = await importClose();
		try {
			const summaryPath = path.join(testDir, '.swarm', 'close-summary.md');
			const archiveDir = path.join(testDir, '.swarm', 'archive', 'missing');
			writeFileSync(summaryPath, '# current summary');
			const ctx = {
				archiveStageFailed: false,
				archiveDir,
				warnings: [] as string[],
			};

			await ci.archiveCloseSummary(ctx, summaryPath);

			expect(ctx.warnings[0]).toContain('Failed to archive close-summary.md:');
			expect(ctx.warnings[0]).not.toContain('Failed to write close-summary.md');
		} finally {
			restore();
		}
	});
});
