import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { COMMAND_REGISTRY } from '../../../src/commands/registry';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	capturePhaseGateReport,
	_internals as storeInternals,
} from '../../../src/evidence/receipt-store';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { executePhaseComplete } from '../../../src/tools/phase-complete';
import { computePhaseEvidenceSnapshot } from '../../../src/tools/phase-complete/snapshot-identity';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const STATIC_TIME = '2026-11-02T00:00:00.000Z';

function makeDir(): string {
	const dir = canonicalMkdtemp('receipt-capture-');
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
	return dir;
}

/** Minimal persisted-report seed (registry-dispatch test only; static dates). */
function seedReferencePhase(dir: string): {
	schemaVersion: number;
	phase: number;
	outcome: string;
	reportHash: string;
	entries: Array<Record<string, unknown>>;
} {
	fs.writeFileSync(
		path.join(dir, '.swarm', 'spec.md'),
		'# Spec\n\n## FR-01\nRequirement.\n',
	);
	const entries = [
		{
			id: 'snapshot_identity',
			code: 'SNAP_OK',
			outcome: 'pass' as const,
			evidenceRefs: [
				`plan-structure:${'a'.repeat(64)}`,
				`policy:${'b'.repeat(64)}`,
				`phase-evidence:${'c'.repeat(64)}`,
			],
			responsibleActor: 'architect',
			agentsDispatched: [],
			agentsMissing: [],
			warnings: [],
		},
	];
	return {
		schemaVersion: 1,
		phase: 1,
		outcome: 'pass',
		reportHash: createHash('sha256')
			.update(JSON.stringify({ schemaVersion: 1, phase: 1, entries }))
			.digest('hex'),
		entries,
	};
}

/**
 * Capture integration (#2968): the real phase_complete success path persists
 * the commit-boundary gate report, fail-open. Split from receipt-emission
 * per the FR-006 500-line cap; no frozen-check -t filter matches these
 * titles (see the acceptance table in the trace).
 */
describe('receipt capture integration (#2968)', () => {
	test('fail-open: an injected capture failure never fails a real phase_complete success path', async () => {
		const dir = makeDir();
		try {
			seedIntegrationFixture(dir);
			const originalWrite = storeInternals.writeImmutableArtifact;
			storeInternals.writeImmutableArtifact = async () => {
				throw new Error('INJECTED_CAPTURE_FAILURE');
			};
			let result: { success: boolean; status: string };
			try {
				result = JSON.parse(
					await executePhaseComplete(
						{ phase: 1, sessionID: 'test-session' },
						dir,
					),
				);
			} finally {
				storeInternals.writeImmutableArtifact = originalWrite;
			}
			expect(result.success).toBe(true);
			expect(result.status).toBe('success');
		} finally {
			closeAllProjectDbs();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('real phase_complete success path persists the commit-boundary gate report', async () => {
		const dir = makeDir();
		try {
			seedIntegrationFixture(dir);
			const result = JSON.parse(
				await executePhaseComplete(
					{ phase: 1, sessionID: 'test-session' },
					dir,
				),
			);
			expect(result.success).toBe(true);
			const receiptsDir = path.join(dir, '.swarm', 'evidence', 'receipts');
			const captured = fs
				.readdirSync(receiptsDir)
				.filter((name) => /^phase-1-[0-9a-f]{64}\.json$/.test(name));
			expect(captured).toHaveLength(1);
			const report = JSON.parse(
				fs.readFileSync(path.join(receiptsDir, captured[0]), 'utf8'),
			);
			const snapEntry = report.entries.find(
				(entry: { id: string }) => entry.id === 'snapshot_identity',
			);
			// F3 (implementation review): DISCRIMINATE the capture target. In
			// this fixture phase_complete writes evidence state (the phase-close
			// intent ledger) between the first collection (preflightReport,
			// carried by the response) and the commit collection
			// (commitPreflight) — deterministically changing the snapshot hash.
			// The persisted capture must therefore hash DIFFERENTLY from the
			// response's first collection: capturing the stale first
			// collection instead (reviewer mutant) makes these equal and this
			// assertion RED.
			expect(report.reportHash).not.toBe(result.gate_report.reportHash);
			for (const prefix of ['plan-structure:', 'policy:', 'phase-evidence:']) {
				expect(
					snapEntry.evidenceRefs.some(
						(ref: string) =>
							ref.startsWith(prefix) &&
							/^[0-9a-f]{64}$/.test(ref.slice(prefix.length)),
					),
				).toBe(true);
			}
		} finally {
			closeAllProjectDbs();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('registry handler dispatches the receipt command (chat surface)', async () => {
		const dir = makeDir();
		try {
			await capturePhaseGateReport(dir, seedReferencePhase(dir));
			const entry = (
				COMMAND_REGISTRY as Record<
					string,
					{
						handler: (ctx: {
							directory: string;
							args: string[];
						}) => Promise<string | { text: string }>;
					}
				>
			).receipt;
			const result = await entry.handler({
				directory: dir,
				args: ['phase', '1'],
			});
			expect(typeof result).toBe('string');
			expect(result as string).toContain('receipt emitted: phase 1');
		} finally {
			closeAllProjectDbs();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** Minimal phase_complete success fixture (phase-completion-e2e pattern, static dates). */
function seedIntegrationFixture(dir: string): void {
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			phase_complete: {
				enabled: true,
				required_agents: ['coder'],
				require_docs: false,
				policy: 'enforce',
				regression_sweep: { enforce: false },
			},
			curator: { enabled: false, phase_enabled: false },
		}),
	);
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Receipt Test Plan',
			swarm: 'mega',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'pending',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'completed',
							description: 'Test task',
						},
					],
				},
			],
		}),
	);
	fs.writeFileSync(
		path.join(dir, '.swarm', 'spec.md'),
		'# Spec\n\n## FR-01\nR.\n',
	);
	const driftDir = path.join(dir, '.swarm', 'evidence', '1');
	fs.mkdirSync(driftDir, { recursive: true });
	fs.writeFileSync(
		path.join(driftDir, 'drift-verifier.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: 'drift-verifier-1',
			entries: [
				{
					task_id: 'drift-verifier-1',
					type: 'drift',
					timestamp: STATIC_TIME,
					agent: 'critic',
					provenance: { agent_name: 'critic', session_id: 'test-session' },
					verdict: 'approved',
					summary: 'No drift detected.',
				},
			],
			created_at: STATIC_TIME,
			updated_at: STATIC_TIME,
		}),
	);
	const retroDir = path.join(dir, '.swarm', 'evidence', 'retro-1');
	fs.mkdirSync(retroDir, { recursive: true });
	fs.writeFileSync(
		path.join(retroDir, 'evidence.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: 'retro-1',
			entries: [
				{
					task_id: 'retro-1',
					type: 'retrospective',
					timestamp: STATIC_TIME,
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase 1 retrospective',
					phase_number: 1,
					total_tool_calls: 10,
					coder_revisions: 1,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 1,
					task_complexity: 'simple',
					top_rejection_reasons: [],
					lessons_learned: ['Test lesson'],
				},
			],
			created_at: STATIC_TIME,
			updated_at: STATIC_TIME,
		}),
	);
	ensureAgentSession('test-session');
	recordPhaseAgentDispatch('test-session', 'coder');
	swarmState.agentSessions.get('test-session')!.turboMode = false;
}
