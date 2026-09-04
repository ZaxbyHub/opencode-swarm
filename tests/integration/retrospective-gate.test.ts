import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../src/db/project-db.js';
import { buildRetroInjection } from '../../src/hooks/system-enhancer';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
} from '../../src/state';

import { executePhaseComplete } from '../../src/tools/phase-complete';

describe('retrospective gate integration tests', () => {
	let tempDir: string;
	let sessionID: string;

	function writeConfig(config: Record<string, unknown>): void {
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify(config, null, 2),
		);
	}

	function writeRetro(
		phase: number,
		userDirectives?: Array<{
			directive: string;
			category: string;
			scope: string;
		}>,
	): void {
		const evidence = {
			schema_version: '1.0.0',
			task_id: `retro-${phase}`,
			entries: [
				{
					task_id: `retro-${phase}`,
					type: 'retrospective',
					timestamp: new Date().toISOString(),
					agent: 'architect',
					verdict: 'pass',
					summary: `Phase ${phase} completed with lessons learned`,
					phase_number: phase,
					total_tool_calls: 10,
					coder_revisions: 2,
					reviewer_rejections: 1,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 2,
					task_complexity: 'moderate',
					top_rejection_reasons: ['Missing edge case handling'],
					lessons_learned: ['Always validate inputs', 'Write tests first'],
					user_directives: userDirectives ?? [],
					approaches_tried: [],
				},
			],
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};
		const retroDir = path.join(tempDir, '.swarm', 'evidence', `retro-${phase}`);
		fs.mkdirSync(retroDir, { recursive: true });
		fs.writeFileSync(
			path.join(retroDir, 'evidence.json'),
			JSON.stringify(evidence, null, 2),
		);
	}

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-gate-int-'));

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
		closeAllProjectDbs();
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
		resetSwarmState();
	});

	describe('phase_complete blocks without retrospective', () => {
		it('should return status blocked with RETROSPECTIVE_MISSING reason when no retro bundle exists', async () => {
			// No agents dispatched, no retro written - only retro gate should matter
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

	describe('phase_complete succeeds after retrospective is written', () => {
		it('should succeed after a valid retrospective bundle is written', async () => {
			// First call without retro - should block
			const result1 = await executePhaseComplete(
				{ phase: 1, sessionID },
				tempDir,
			);
			const parsed1 = JSON.parse(result1);
			expect(parsed1.success).toBe(false);
			expect(parsed1.status).toBe('blocked');
			expect(parsed1.reason).toBe('RETROSPECTIVE_MISSING');

			// Write retro bundle
			writeRetro(1);

			// Second call with retro - should succeed
			const result2 = await executePhaseComplete(
				{ phase: 1, sessionID },
				tempDir,
			);
			const parsed2 = JSON.parse(result2);
			expect(parsed2.success).toBe(true);
			expect(parsed2.status).toBe('success');
		});
	});

	describe('buildRetroInjection returns retro content after Phase 1 retro is written', () => {
		it('should contain Phase 1 retro content in injection for Phase 2', async () => {
			// Write Phase 1 retro
			writeRetro(1);

			// Get injection for Phase 2 (should include Phase 1 retro)
			const injection = await buildRetroInjection(tempDir, 2);

			expect(injection).not.toBeNull();
			expect(injection).toContain('Phase 1');
			expect(injection).toContain('Always validate inputs');
			expect(injection).toContain('Missing edge case handling');
		});
	});

	describe('user_directives from Phase 1 retro appear in Phase 2 injection', () => {
		it('should include user_directives from Phase 1 retro in Phase 2 injection', async () => {
			// Write Phase 1 retro with user_directives
			writeRetro(1, [
				{
					directive: 'Always use strict TypeScript',
					category: 'code_style',
					scope: 'project',
				},
			]);

			// Get injection for Phase 2
			const injection = await buildRetroInjection(tempDir, 2);

			expect(injection).not.toBeNull();
			expect(injection).toContain('Always use strict TypeScript');
			expect(injection).toMatch(/code_style|\[code_style\]/);
		});
	});
});
