/**
 * Trailing adversarial lock tests split out of phase-complete.lock-adversarial.test.ts
 * to keep the diff-scoped FR-006 cap under control while preserving the same setup.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resetSwarmState, swarmState } from '../../../src/state';
import { executePhaseComplete } from '../../../src/tools/phase-complete';

vi.mock('../../../src/parallel/file-locks', () => ({
	tryAcquireLock: vi.fn(),
}));

vi.mock('../../../src/evidence/manager', () => ({
	listEvidenceTaskIds: vi.fn().mockResolvedValue([]),
	loadEvidence: vi.fn().mockImplementation((_dir: string, taskId: string) => {
		if (taskId.startsWith('retro-')) {
			try {
				const retroPath = path.join(
					_dir,
					'.swarm',
					'evidence',
					taskId,
					'evidence.json',
				);
				if (fs.existsSync(retroPath)) {
					const content = fs.readFileSync(retroPath, 'utf-8');
					return { status: 'found', bundle: JSON.parse(content) };
				}
			} catch {
				// fall through
			}
		}
		return { status: 'not_found' };
	}),
}));

vi.mock('../../../src/hooks/curator', () => ({
	runCuratorPhase: vi.fn().mockResolvedValue({
		digest: { summary: 'test' },
		knowledge_recommendations: [],
		compliance: [],
	}),
	applyCuratorKnowledgeUpdates: vi.fn().mockResolvedValue({
		applied: 0,
		skipped: 0,
	}),
}));

vi.mock('../../../src/hooks/curator-llm-factory.js', () => ({
	createCuratorLLMDelegate: vi.fn().mockReturnValue({
		delegate: vi.fn().mockResolvedValue({ summary: 'test' }),
	}),
}));

vi.mock('../../../src/hooks/knowledge-curator.js', () => ({
	curateAndStoreSwarm: vi.fn().mockResolvedValue({
		stored: 0,
		skipped: 0,
		rejected: 0,
	}),
}));

vi.mock('../../../src/hooks/knowledge-reader.js', () => ({
	updateRetrievalOutcome: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/hooks/review-receipt.js', () => ({
	buildApprovedReceipt: vi.fn().mockReturnValue({}),
	buildRejectedReceipt: vi.fn().mockReturnValue({}),
	persistReviewReceipt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/plan/checkpoint', () => ({
	writeCheckpoint: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/plan/ledger', () => ({
	ledgerExists: vi.fn().mockResolvedValue(false),
	replayFromLedger: vi.fn().mockResolvedValue(null),
	takeSnapshotEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/plan/manager', () => ({
	loadPlan: vi.fn().mockResolvedValue({
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		migration_status: 'migrated',
		phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
	}),
	savePlan: vi.fn().mockResolvedValue(undefined),
	closePlanTerminalState: async () => {},
	_snapshot_test_exports: {},
}));

vi.mock('../../../src/session/snapshot-writer', () => ({
	flushPendingSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/telemetry', () => ({
	telemetry: {
		phaseChanged: vi.fn(),
		sessionStarted: vi.fn(),
		agentActivated: vi.fn(),
	},
}));

vi.mock('../../../src/tools/completion-verify', () => ({
	executeCompletionVerify: vi
		.fn()
		.mockResolvedValue(JSON.stringify({ status: 'passed' })),
}));

vi.mock('../../../src/hooks/utils', () => ({
	validateSwarmPath: vi
		.fn()
		.mockImplementation((_dir: string, file: string) =>
			path.join(_dir, '.swarm', file),
		),
}));

vi.mock('../../../src/config', () => ({
	loadPluginConfigWithMeta: vi.fn().mockReturnValue({
		config: {
			phase_complete: {
				enabled: true,
				required_agents: [],
				policy: 'warn',
			},
			curator: { enabled: false },
			knowledge: {},
		},
	}),
}));

vi.mock('../../../src/config/schema', () => ({
	PhaseCompleteConfigSchema: {
		parse: vi.fn().mockImplementation((cfg) => ({
			enabled: cfg?.enabled ?? true,
			required_agents: cfg?.required_agents ?? [],
			policy: cfg?.policy ?? 'warn',
		})),
	},
	CuratorConfigSchema: {
		parse: vi.fn().mockReturnValue({ enabled: false, phase_enabled: false }),
	},
	KnowledgeConfigSchema: {
		parse: vi.fn().mockReturnValue({}),
	},
	stripKnownSwarmPrefix: vi.fn().mockImplementation((name: string) => name),
}));

import { tryAcquireLock } from '../../../src/parallel/file-locks';
import { ensureAgentSession } from '../../../src/state';

const mockTryAcquireLock = tryAcquireLock as ReturnType<typeof vi.fn>;

function writeRetroBundle(directory: string, phaseNumber: number): void {
	const retroDir = path.join(
		directory,
		'.swarm',
		'evidence',
		`retro-${phaseNumber}`,
	);
	fs.mkdirSync(retroDir, { recursive: true });
	fs.writeFileSync(
		path.join(retroDir, 'evidence.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: `retro-${phaseNumber}`,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			entries: [
				{
					task_id: `retro-${phaseNumber}`,
					type: 'retrospective',
					timestamp: new Date().toISOString(),
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase retrospective',
					phase_number: phaseNumber,
					total_tool_calls: 10,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 1,
					task_complexity: 'simple',
					top_rejection_reasons: [],
					lessons_learned: ['test lesson'],
				},
			],
		}),
	);
}

describe('phase_complete adversarial trailing groups', () => {
	let tempDir: string;
	let originalCwd: string;
	let eventsPath: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'phase-adversarial-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });

		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				migration_status: 'migrated',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [],
					},
				],
			}),
		);

		eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
		fs.writeFileSync(eventsPath, '', 'utf-8');

		writeRetroBundle(tempDir, 1);

		resetSwarmState();
		swarmState.activeAgent.set('current', 'test-agent');

		const session = ensureAgentSession('test-session', 'test-agent', tempDir);
		session.phaseAgentsDispatched = new Set();
		session.lastPhaseCompleteTimestamp = 0;

		vi.clearAllMocks();
		mockTryAcquireLock.mockImplementation((_dir: string, filePath: string) => ({
			acquired: true,
			lock: {
				filePath,
				agent: 'phase-complete',
				taskId: `phase-complete-${filePath}`,
				timestamp: new Date().toISOString(),
				expiresAt: Date.now() + 300000,
				_release: vi.fn().mockResolvedValue(undefined),
			},
		}));
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		resetSwarmState();
	});

	describe('Oversized summary — event log truncation verification', () => {
		test('10KB summary is truncated to 500 chars in BOTH message and event log', async () => {
			const hugeSummary = 'A'.repeat(10 * 1024);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session', summary: hugeSummary },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const afterPrefix = parsed.message.replace('Phase 1 completed: ', '');
			expect(afterPrefix.length).toBe(500);
			expect(afterPrefix).toBe('A'.repeat(500));

			const content = fs.readFileSync(eventsPath, 'utf-8').trim();
			const event = JSON.parse(content);
			expect(event.event).toBe('phase_complete');
			expect(event.summary).toBe('A'.repeat(500));
			expect(event.summary.length).toBe(500);
		});

		test('1MB summary is truncated to 500 chars in event log', async () => {
			const hugeSummary = 'X'.repeat(1024 * 1024);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session', summary: hugeSummary },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const content = fs.readFileSync(eventsPath, 'utf-8').trim();
			const event = JSON.parse(content);
			expect(event.summary).toBe('X'.repeat(500));
			expect(event.summary.length).toBe(500);
		});

		test('summary at exactly 500 chars — no truncation', async () => {
			const exactSummary = 'B'.repeat(500);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session', summary: exactSummary },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const content = fs.readFileSync(eventsPath, 'utf-8').trim();
			const event = JSON.parse(content);
			expect(event.summary).toBe(exactSummary);
			expect(event.summary.length).toBe(500);
		});

		test('summary longer than 500 chars with whitespace — trim THEN slice', async () => {
			const whitespace = '   ';
			const content = 'C'.repeat(600);
			const fullSummary = whitespace + content + whitespace;

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session', summary: fullSummary },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const content2 = fs.readFileSync(eventsPath, 'utf-8').trim();
			const event = JSON.parse(content2);
			expect(event.summary).toBe('C'.repeat(500));
		});

		test('summary is only whitespace — trim makes it empty, event logs null', async () => {
			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session', summary: '     ' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const content = fs.readFileSync(eventsPath, 'utf-8').trim();
			const event = JSON.parse(content);
			expect(event.summary).toBe('');
		});

		test('null summary — event logs null, not the string "null"', async () => {
			const result = await executePhaseComplete(
				{
					phase: 1,
					sessionID: 'test-session',
					summary: null as unknown as string,
				},
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const content = fs.readFileSync(eventsPath, 'utf-8').trim();
			const event = JSON.parse(content);
			expect(event.summary).toBeNull();
		});
	});

	describe('Lock release in finally block (non-throwing guarantee)', () => {
		test('when appendFileSync throws, _release() is still called for all acquired locks', async () => {
			const eventsRelease = vi.fn().mockResolvedValue(undefined);
			const planRelease = vi.fn().mockResolvedValue(undefined);
			mockTryAcquireLock.mockImplementation(
				(_dir: string, filePath: string) => {
					if (filePath === 'events.jsonl') {
						return {
							acquired: true,
							lock: {
								filePath: 'events.jsonl',
								agent: 'phase-complete',
								taskId: 'phase-complete-test',
								timestamp: new Date().toISOString(),
								expiresAt: Date.now() + 300000,
								_release: eventsRelease,
							},
						};
					}
					return {
						acquired: true,
						lock: {
							filePath: 'plan.json',
							agent: 'phase-complete',
							taskId: 'phase-complete-plan-test',
							timestamp: new Date().toISOString(),
							expiresAt: Date.now() + 300000,
							_release: planRelease,
						},
					};
				},
			);

			fs.rmSync(eventsPath);
			fs.mkdirSync(eventsPath);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(eventsRelease).toHaveBeenCalledTimes(1);
			expect(planRelease).toHaveBeenCalledTimes(1);
		});

		test('when _release() itself throws, the error is caught and logged, not thrown', async () => {
			const release = vi
				.fn()
				.mockImplementation(() => Promise.reject(new Error('_release failed')));
			mockTryAcquireLock.mockResolvedValue({
				acquired: true,
				lock: {
					filePath: 'events.jsonl',
					agent: 'phase-complete',
					taskId: 'phase-complete-test',
					timestamp: new Date().toISOString(),
					expiresAt: Date.now() + 300000,
					_release: release,
				},
			});

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);

			expect(() => JSON.parse(result)).not.toThrow();
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
		});
	});

	describe('Multi-session phase isolation under adversarial calls', () => {
		test('two different sessions, same phase — both succeed with correct agent sets', async () => {
			const sessionA = ensureAgentSession('session-A', 'architect', tempDir);
			sessionA.phaseAgentsDispatched = new Set(['coder']);
			sessionA.lastPhaseCompleteTimestamp = 0;

			const sessionB = ensureAgentSession('session-B', 'architect', tempDir);
			sessionB.phaseAgentsDispatched = new Set(['reviewer']);
			sessionB.lastPhaseCompleteTimestamp = 0;

			const [rA, rB] = await Promise.all([
				executePhaseComplete({ phase: 1, sessionID: 'session-A' }, tempDir),
				executePhaseComplete({ phase: 1, sessionID: 'session-B' }, tempDir),
			]);

			const pA = JSON.parse(rA);
			const pB = JSON.parse(rB);

			expect(pA.success).toBe(true);
			expect(pB.success).toBe(true);
		});
	});
});
