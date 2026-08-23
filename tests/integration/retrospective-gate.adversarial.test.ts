import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRetroInjection } from '../../src/hooks/system-enhancer';
import { ensureAgentSession, resetSwarmState } from '../../src/state';

import { executePhaseComplete } from '../../src/tools/phase-complete';

describe('retrospective gate adversarial tests', () => {
	let tempDir: string;
	let sessionID: string;

	const validEntry = {
		task_id: 'retro-1',
		type: 'retrospective' as const,
		timestamp: '2026-01-01T00:00:00.000Z',
		agent: 'architect',
		verdict: 'pass' as const,
		summary: 'Phase 1 completed',
		phase_number: 1,
		total_tool_calls: 0,
		coder_revisions: 0,
		reviewer_rejections: 0,
		test_failures: 0,
		security_findings: 0,
		integration_issues: 0,
		task_count: 1,
		task_complexity: 'simple' as const,
		top_rejection_reasons: [],
		lessons_learned: [],
		user_directives: [],
		approaches_tried: [],
	};

	function writeConfig(config: Record<string, unknown>): void {
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify(config, null, 2),
		);
	}

	function writeRetroEvidenceFile(evidenceDir: string, content: string): void {
		const retroDir = path.join(tempDir, '.swarm', 'evidence', evidenceDir);
		fs.mkdirSync(retroDir, { recursive: true });
		fs.writeFileSync(path.join(retroDir, 'evidence.json'), content);
	}

	function writeValidBundle(
		phase: number,
		modifications: Record<string, unknown> = {},
	): void {
		const evidence = {
			schema_version: '1.0.0',
			task_id: `retro-${phase}`,
			entries: [
				{
					...validEntry,
					...modifications,
					task_id: `retro-${phase}`,
					phase_number: phase,
				},
			],
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};
		writeRetroEvidenceFile(`retro-${phase}`, JSON.stringify(evidence, null, 2));
	}

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-gate-adv-'));

		// Create required directories
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });

		// Write minimal config to enable retro gate only
		writeConfig({
			phase_complete: {
				enabled: true,
				required_agents: [],
				require_docs: false,
				policy: 'enforce',
			},
		});

		// Reset swarm state
		resetSwarmState();

		// Setup session
		sessionID = `test-session-${Date.now()}`;
		ensureAgentSession(sessionID, 'architect');
	});

	afterEach(() => {
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
		resetSwarmState();
	});

	describe('attack vector 1: malformed evidence bundle', () => {
		it('should block phase_complete when evidence.json contains invalid JSON', async () => {
			// Write malformed JSON (missing closing brace, invalid syntax)
			writeRetroEvidenceFile('retro-1', '{not json');

			const result = await executePhaseComplete(
				{ phase: 1, sessionID },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('RETROSPECTIVE_SCHEMA_INVALID');
			expect(parsed.message).toMatch(/retrospective/i);
		});
	});

	describe('attack vector 2: wrong type in bundle', () => {
		it('should block phase_complete when bundle has type: "review" instead of "retrospective"', async () => {
			// Write valid bundle with wrong type
			writeValidBundle(1, { type: 'review' });

			const result = await executePhaseComplete(
				{ phase: 1, sessionID },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('RETROSPECTIVE_SCHEMA_INVALID');
			expect(parsed.message).toMatch(/retrospective/i);
		});
	});

	describe('attack vector 3: verdict: "fail"', () => {
		it('should block phase_complete when retro bundle has verdict: "fail"', async () => {
			// Write valid bundle but with failing verdict
			writeValidBundle(1, { verdict: 'fail' });

			const result = await executePhaseComplete(
				{ phase: 1, sessionID },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('RETROSPECTIVE_FAILED');
			expect(parsed.message).toMatch(/retrospective/i);
		});
	});

	describe('attack vector 4: wrong phase_number', () => {
		it('should block phase_complete when bundle has phase_number: 2 but trying to complete phase 1', async () => {
			// Write Phase 2 retro but trying to complete Phase 1
			writeValidBundle(2);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('RETROSPECTIVE_MISSING');
			expect(parsed.message).toMatch(/retrospective/i);
		});
	});

	describe('attack vector 5: buildRetroInjection with no retro', () => {
		it('should return null when calling buildRetroInjection with no retro bundle present', async () => {
			// No retro written - call buildRetroInjection for Phase 2
			const injection = await buildRetroInjection(tempDir, 2);

			expect(injection).toBeNull();
		});
	});

	describe('attack vector 6: session-scoped user_directives excluded', () => {
		it('should exclude session-scoped user_directives from buildRetroInjection output', async () => {
			// Write Phase 1 retro with session-scoped directive
			writeValidBundle(1, {
				user_directives: [
					{ directive: 'session only', category: 'process', scope: 'session' },
					{ directive: 'project wide', category: 'process', scope: 'project' },
				],
			});

			// Get injection for Phase 2
			const injection = await buildRetroInjection(tempDir, 2);

			expect(injection).not.toBeNull();
			// Session-scope directive should be excluded
			expect(injection).not.toContain('session only');
			// Project-scope directive should be included
			expect(injection).toContain('project wide');
		});
	});
});
