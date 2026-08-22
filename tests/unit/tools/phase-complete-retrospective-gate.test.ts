import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureAgentSession, resetSwarmState } from '../../../src/state.js';

const { phase_complete } = await import('../../../src/tools/phase-complete.js');

describe('phase_complete retrospective gate', () => {
	let tempDir: string;
	let originalCwd: string;

	function git(args: string[]): void {
		const result = spawnSync('git', args, {
			cwd: tempDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 15_000,
			maxBuffer: 1024 * 1024,
			windowsHide: true,
		});
		if (result.error || result.status !== 0) {
			throw new Error(result.error?.message ?? result.stderr);
		}
	}

	beforeEach(() => {
		resetSwarmState();
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'phase-complete-retro-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		git(['init']);
		git(['config', '--local', 'commit.gpgsign', 'false']);
		git(['config', 'user.email', 'test@test.com']);
		git(['config', 'user.name', 'Test']);
		fs.writeFileSync(path.join(tempDir, 'initial.txt'), 'initial');
		git(['add', '--', 'initial.txt']);
		git(['commit', '-m', 'initial']);

		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'warn',
				},
			}),
		);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
		resetSwarmState();
	});

	function writeRetroBundle(
		phaseNumber: number,
		verdict: 'pass' | 'fail',
	): void {
		const retroDir = path.join(
			tempDir,
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
					entries: [
						{
							task_id: `retro-${phaseNumber}`,
							type: 'retrospective',
							timestamp: new Date().toISOString(),
							agent: 'architect',
							verdict,
							summary: `Phase ${phaseNumber} retrospective`,
							phase_number: phaseNumber,
							total_tool_calls: 4,
							coder_revisions: 0,
							reviewer_rejections: verdict === 'fail' ? 1 : 0,
							test_failures: verdict === 'fail' ? 1 : 0,
							security_findings: 0,
							integration_issues: 0,
							task_count: 1,
							task_complexity: 'simple',
							top_rejection_reasons: [],
							lessons_learned: ['One lesson'],
							user_directives: [],
							approaches_tried: [],
						},
					],
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				},
				null,
				2,
			),
		);
	}

	test('surfaces schema_valid and gate_pass when retrospective verdict is fail', async () => {
		const sessionId = 'retro-fail-session';
		ensureAgentSession(sessionId);
		writeRetroBundle(1, 'fail');

		const raw = await phase_complete.execute({
			phase: 1,
			sessionID: sessionId,
		});
		const parsed = JSON.parse(raw);

		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('RETROSPECTIVE_FAILED');
		expect(parsed.retrospective_gate).toEqual({
			schema_valid: true,
			gate_pass: false,
			verdict: 'fail',
		});
		expect(parsed.message).toContain('verdict "fail"');
	});

	test('surfaces schema_valid=false when retrospective schema is malformed', async () => {
		const sessionId = 'retro-invalid-session';
		ensureAgentSession(sessionId);
		const retroDir = path.join(tempDir, '.swarm', 'evidence', 'retro-1');
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
						timestamp: new Date().toISOString(),
						agent: 'architect',
						summary: 'Malformed retrospective',
						phase_number: 1,
					},
				],
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			}),
		);

		const raw = await phase_complete.execute({
			phase: 1,
			sessionID: sessionId,
		});
		const parsed = JSON.parse(raw);

		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('RETROSPECTIVE_SCHEMA_INVALID');
		expect(parsed.retrospective_gate).toEqual({
			schema_valid: false,
			gate_pass: false,
		});
	});
});
