/**
 * Integration test for the design-doc drift advisory injected by phase_complete
 * (issue #1080 / F-6 coverage gap from PR #1096 adversarial review).
 *
 * Verifies that when design_docs.enabled=true and runDesignDocDriftCheck returns
 * DOC_STALE, phase_complete:
 *   (a) still returns success=true  — the advisory NEVER blocks completion
 *   (b) pushes a [DESIGN-DOC DRIFT] advisory to pendingAdvisoryMessages
 *
 * And when DOC_FRESH, no advisory is pushed.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

// Mock runDesignDocDriftCheck BEFORE importing phase_complete.
// Configurable via mockDocDriftImpl so individual tests can change the verdict.
let mockDocDriftImpl: () => Promise<unknown> = async () => null;

mock.module('../../../src/hooks/design-doc-drift', () => ({
	runDesignDocDriftCheck: mock(async (...args: unknown[]) =>
		mockDocDriftImpl(...args),
	),
}));

// Mock curator, knowledge, and drift dependencies to isolate the design-docs path.
mock.module('../../../src/hooks/curator', () => ({
	runCuratorPhase: mock(async () => ({
		phase: 1,
		agents_dispatched: [],
		compliance: [],
		knowledge_recommendations: [],
		summary: 'skipped',
		timestamp: new Date().toISOString(),
	})),
	applyCuratorKnowledgeUpdates: mock(async () => ({ applied: 0, skipped: 0 })),
}));

mock.module('../../../src/hooks/curator-drift', () => ({
	runDeterministicDriftCheck: mock(async () => ({
		phase: 1,
		report: {
			schema_version: 1,
			phase: 1,
			timestamp: new Date().toISOString(),
			alignment: 'ALIGNED',
			drift_score: 0,
			first_deviation: null,
			compounding_effects: [],
			corrections: [],
			requirements_checked: 0,
			requirements_satisfied: 0,
			scope_additions: [],
			injection_summary: '',
		},
		report_path: '',
		injection_text: '',
	})),
	readPriorDriftReports: mock(async () => []),
}));

mock.module('../../../src/hooks/knowledge-curator.js', () => ({
	curateAndStoreSwarm: mock(async () => {}),
}));

const { phase_complete } = await import('../../../src/tools/phase-complete');

// ─── helpers ────────────────────────────────────────────────────────────────

function writeRetroBundle(dir: string, phaseNum: number): void {
	const retroDir = path.join(dir, '.swarm', 'evidence', `retro-${phaseNum}`);
	fs.mkdirSync(retroDir, { recursive: true });
	fs.writeFileSync(
		path.join(retroDir, 'evidence.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: `retro-${phaseNum}`,
			entries: [
				{
					task_id: `retro-${phaseNum}`,
					type: 'retrospective',
					timestamp: new Date().toISOString(),
					agent: 'architect',
					verdict: 'pass',
					summary: 'Test phase',
					metadata: {},
					phase_number: phaseNum,
					total_tool_calls: 5,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 1,
					task_complexity: 'simple',
					top_rejection_reasons: [],
					lessons_learned: [],
				},
			],
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		}),
	);
}

function writeGateEvidence(dir: string, phaseNum: number): void {
	const evidenceDir = path.join(dir, '.swarm', 'evidence', `${phaseNum}`);
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, 'completion-verify.json'),
		JSON.stringify({
			status: 'passed',
			tasksChecked: 1,
			tasksPassed: 1,
			tasksBlocked: 0,
			reason: 'All task identifiers found in source files',
		}),
	);
	fs.writeFileSync(
		path.join(evidenceDir, 'drift-verifier.json'),
		JSON.stringify({
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
		}),
	);
}

function makeDesignDocsConfig(enabled: boolean): string {
	return JSON.stringify({
		phase_complete: {
			enabled: true,
			required_agents: [],
			require_docs: false,
			policy: 'enforce',
		},
		curator: { enabled: false },
		design_docs: { enabled, out_dir: 'docs' },
	});
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('phase_complete — design-doc drift advisory (F-6 coverage)', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();

		tempDir = fs.realpathSync(
			fs.mkdtempSync(
				path.join(os.tmpdir(), 'phase-complete-design-docs-test-'),
			),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
		writeRetroBundle(tempDir, 1);
		writeGateEvidence(tempDir, 1);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			/* ignore cleanup */
		}
		resetSwarmState();
		mock.restore();
	});

	test('DOC_STALE: phase completes (success=true) and advisory is pushed', async () => {
		// Arrange — drift check returns DOC_STALE with one stale section.
		mockDocDriftImpl = async () => ({
			schema_version: 1,
			phase: 1,
			timestamp: new Date().toISOString(),
			out_dir: 'docs',
			verdict: 'DOC_STALE',
			stale_sections: [
				{
					section_id: 'S-001',
					doc: 'technical-spec',
					reason: 'code anchor src/foo.ts changed after the doc',
				},
			],
			missing_docs: [],
			checked_docs: ['docs/technical-spec.md'],
		});

		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			makeDesignDocsConfig(true),
		);
		ensureAgentSession('sess-doc-stale');

		// Act
		const raw = await phase_complete.execute({
			phase: 1,
			sessionID: 'sess-doc-stale',
		});
		const result = JSON.parse(raw);

		// Assert — advisory NEVER blocks completion (F-6 claim: "never blocks")
		expect(result.success).toBe(true);

		// Assert — advisory was pushed to the session
		const session = swarmState.agentSessions.get('sess-doc-stale');
		expect(session?.pendingAdvisoryMessages?.length).toBeGreaterThan(0);
		const advisory = session?.pendingAdvisoryMessages?.find((m) =>
			m.includes('[DESIGN-DOC DRIFT'),
		);
		expect(advisory).toBeDefined();
		expect(advisory).toContain('S-001');
		expect(advisory).toContain('/swarm design-docs --update');
	});

	test('DOC_FRESH: phase completes and NO advisory is pushed', async () => {
		mockDocDriftImpl = async () => ({
			schema_version: 1,
			phase: 1,
			timestamp: new Date().toISOString(),
			out_dir: 'docs',
			verdict: 'DOC_FRESH',
			stale_sections: [],
			missing_docs: [],
			checked_docs: ['docs/technical-spec.md'],
		});

		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			makeDesignDocsConfig(true),
		);
		ensureAgentSession('sess-doc-fresh');

		const raw = await phase_complete.execute({
			phase: 1,
			sessionID: 'sess-doc-fresh',
		});
		const result = JSON.parse(raw);

		expect(result.success).toBe(true);

		const session = swarmState.agentSessions.get('sess-doc-fresh');
		const driftAdvisory = session?.pendingAdvisoryMessages?.find((m) =>
			m.includes('[DESIGN-DOC DRIFT'),
		);
		expect(driftAdvisory).toBeUndefined();
	});

	test('drift check error: phase still completes (fail-open)', async () => {
		mockDocDriftImpl = async () => {
			throw new Error('simulated drift check failure');
		};

		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			makeDesignDocsConfig(true),
		);
		ensureAgentSession('sess-drift-error');

		const raw = await phase_complete.execute({
			phase: 1,
			sessionID: 'sess-drift-error',
		});
		const result = JSON.parse(raw);

		// Fail-open: error in the drift check must NOT prevent phase completion.
		expect(result.success).toBe(true);
	});

	test('design_docs disabled: drift check is NOT invoked', async () => {
		let invoked = false;
		mockDocDriftImpl = async () => {
			invoked = true;
			return null;
		};

		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			makeDesignDocsConfig(false), // disabled
		);
		ensureAgentSession('sess-disabled');

		await phase_complete.execute({ phase: 1, sessionID: 'sess-disabled' });

		expect(invoked).toBe(false);
	});
});
