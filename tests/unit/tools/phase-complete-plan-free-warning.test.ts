import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
} from '../../../src/state';
import {
	writeGateEvidence,
	writeRetroBundle,
} from './_phase-complete-test-helpers';

const { phase_complete } = await import('../../../src/tools/phase-complete');

describe('phase_complete tool', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();

		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'phase-complete-test-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });

		writeRetroBundle(tempDir, 1, 'pass');
		writeRetroBundle(tempDir, 2, 'pass');
		writeGateEvidence(tempDir, 1);
		writeGateEvidence(tempDir, 2);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		resetSwarmState();
	});

	describe('plan-free warning', () => {
		test('warns when plan-free and neither reviewer nor test_engineer dispatched', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'warn',
					},
				}),
			);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(
				parsed.warnings.some((w: string) =>
					w.includes(
						'Plan-free phase 1: no independent reviewer or test_engineer',
					),
				),
			).toBe(true);
		});

		test('does NOT warn when plan-free and reviewer was dispatched', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'warn',
					},
				}),
			);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');
			recordPhaseAgentDispatch('sess1', 'reviewer');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(
				parsed.warnings.some((w: string) =>
					w.includes(
						'Plan-free phase 1: no independent reviewer or test_engineer',
					),
				),
			).toBe(false);
		});

		test('does NOT warn when plan-free and test_engineer was dispatched', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'warn',
					},
				}),
			);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');
			recordPhaseAgentDispatch('sess1', 'test_engineer');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(
				parsed.warnings.some((w: string) =>
					w.includes(
						'Plan-free phase 1: no independent reviewer or test_engineer',
					),
				),
			).toBe(false);
		});

		test('does NOT warn when plan.json exists even if reviewer/test_engineer are missing', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'warn',
					},
				}),
			);

			const swarmDir = path.join(tempDir, '.swarm');
			fs.mkdirSync(swarmDir, { recursive: true });
			fs.writeFileSync(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Plan-backed warning fixture',
					swarm: 'test-swarm',
					current_phase: 1,
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
			expect(fs.existsSync(path.join(tempDir, '.swarm', 'plan.json'))).toBe(
				true,
			);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(
				parsed.warnings.some((w: string) =>
					w.includes(
						'Plan-free phase 1: no independent reviewer or test_engineer',
					),
				),
			).toBe(false);
		});
	});
});
