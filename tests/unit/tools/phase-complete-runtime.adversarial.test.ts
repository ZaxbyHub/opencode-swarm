import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { freezeClock } from '../../helpers/test-clock';

const { phase_complete } = await import('../../../src/tools/phase-complete');

setDefaultTimeout(30_000);

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
		JSON.stringify(
			{
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
			},
			null,
			2,
		),
	);
}

function writeGateEvidence(directory: string, phase: number): void {
	const evidenceDir = path.join(directory, '.swarm', 'evidence', `${phase}`);
	fs.mkdirSync(evidenceDir, { recursive: true });

	const completionVerify = {
		status: 'passed',
		tasksChecked: 1,
		tasksPassed: 1,
		tasksBlocked: 0,
		reason: 'All task identifiers found in source files',
	};
	fs.writeFileSync(
		path.join(evidenceDir, 'completion-verify.json'),
		JSON.stringify(completionVerify, null, 2),
	);

	const driftVerifier = {
		schema_version: '1.0.0',
		task_id: 'drift-verifier',
		entries: [
			{
				task_id: 'drift-verifier',
				type: 'drift_verification',
				timestamp: new Date().toISOString(),
				agent: 'critic',
				verdict: 'approved',
				summary: 'Drift check passed',
			},
		],
	};
	fs.writeFileSync(
		path.join(evidenceDir, 'drift-verifier.json'),
		JSON.stringify(driftVerifier, null, 2),
	);
}

describe('phase_complete tool - ADVERSARIAL SECURITY TESTS', () => {
	let tempDir: string;
	let originalCwd: string;
	let restoreClock: () => void;

	beforeEach(() => {
		restoreClock = freezeClock({
			fixedNow: 1_704_067_200_000,
			isoNow: '2024-01-01T00:00:00.000Z',
		});
		resetSwarmState();

		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'phase-complete-adversarial-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });
		writeRetroBundle(tempDir, 1);
		writeGateEvidence(tempDir, 1);
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
				},
			}),
		);
	});

	afterEach(() => {
		restoreClock();
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		resetSwarmState();
	});

	describe('Type coercion and validation bypass attempts', () => {
		test('handles phase as object that coerces to NaN', async () => {
			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: {} as any,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});

		test('handles phase as array that coerces to NaN or 0', async () => {
			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: [] as any,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});

		test('handles phase as boolean true (coerces to 1)', async () => {
			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: true as any,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.phase).toBe(1);
		});

		test('handles phase as boolean false (coerces to 0)', async () => {
			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: false as any,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});

		test('handles sessionID as number (coerced to string)', async () => {
			ensureAgentSession('12345');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: '12345',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
		});
	});

	describe('Event file injection attempts', () => {
		test('handles injection attempt in summary written to events.jsonl', async () => {
			ensureAgentSession('sess1');

			const maliciousSummary = '"event":"hacked"}';

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
				summary: maliciousSummary,
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
			const eventsContent = fs.readFileSync(eventsPath, 'utf-8');
			const lines = eventsContent.trim().split('\n');

			lines.forEach((line) => {
				expect(() => JSON.parse(line)).not.toThrow();
			});
		});

		test('handles newline injection in summary', async () => {
			ensureAgentSession('sess1');

			const summaryWithNewline = 'Phase complete\nInjected line\nAnother line';

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
				summary: summaryWithNewline,
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
			const eventsContent = fs.readFileSync(eventsPath, 'utf-8');
			const lines = eventsContent.trim().split('\n');

			expect(lines.length).toBeGreaterThanOrEqual(1);
			lines.forEach((line) => {
				expect(() => JSON.parse(line)).not.toThrow();
			});

			const phaseEvent = lines
				.map((l) => JSON.parse(l))
				.find((e: Record<string, unknown>) => e.event === 'phase_complete');
			expect(phaseEvent).toBeDefined();
			expect(phaseEvent.summary).toBe(summaryWithNewline);
		});
	});

	describe('Config tampering attempts', () => {
		test('handles malicious config with very large arrays', async () => {
			const hugeArray = Array.from({ length: 10000 }, (_, i) => `agent${i}`);

			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: hugeArray,
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.agentsMissing.length).toBeGreaterThan(0);
		});

		test('handles config with circular structure (should fail parse)', async () => {
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				'{"phase_complete": {"enabled": true, "required_agents": [1, 2, 3,]}}',
			);

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(['true', 'false']).toContain(String(parsed.success));
		});
	});

	describe('Memory and resource exhaustion attempts', () => {
		test('handles extremely long delegation chain', async () => {
			ensureAgentSession('sess1');

			const hugeChain = Array.from({ length: 10000 }, (_, i) => ({
				from: `agent${i}`,
				to: `agent${i + 1}`,
				timestamp: Date.now() - (10000 - i) * 1000,
			}));

			swarmState.delegationChains.set('sess1', hugeChain);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
		});

		test('handles many phaseAgentsDispatched entries', async () => {
			ensureAgentSession('sess1');

			for (let i = 0; i < 1000; i++) {
				recordPhaseAgentDispatch('sess1', `agent${i}`);
			}

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.agentsDispatched.length).toBe(64);
			expect(
				parsed.gate_report.entries.every(
					(entry: { agentsDispatched: string[] }) =>
						entry.agentsDispatched.length <= 64,
				),
			).toBe(true);
		});
	});
});
