import { describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import fs, { rm, symlink } from 'node:fs/promises';
import path from 'node:path';

import { createCloseFinalizerHarness } from './close-finalizer.fixture.js';

const harness = await createCloseFinalizerHarness();
const {
	handleCloseCommand,
	swarmDir,
	writePlan,
	mockExecuteWriteRetro,
	mockGetGitRepositoryStatus,
	mockResetToRemoteBranch,
	mockResetToMainAfterMerge,
	mockRunSkillImprover,
	mockResetSwarmStatePreservingSingletons,
} = harness;

describe('handleCloseCommand — context, summary, and guards', () => {
	describe('Context reset', () => {
		it('resets context.md with "Session closed" content and finalization type', async () => {
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'context.md'),
				'# Old context\nStale data here.',
			);

			await handleCloseCommand(harness.testDir, []);

			const contextPath = path.join(swarmDir(), 'context.md');
			expect(existsSync(contextPath)).toBe(true);
			const content = readFileSync(contextPath, 'utf-8');
			expect(content).toContain('Session closed');
			expect(content).toContain('Finalization: normal');
			expect(content).toContain('No active plan');
		});

		it('marks finalization as "forced" when --force is used', async () => {
			await writePlan();

			await handleCloseCommand(harness.testDir, ['--force']);

			const content = readFileSync(
				path.join(swarmDir(), 'context.md'),
				'utf-8',
			);
			expect(content).toContain('Finalization: forced');
		});

		it('marks finalization as "plan-already-done" when all phases are terminal', async () => {
			await writePlan({
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'completed',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'completed',
								description: 'Task A',
								size: 'small',
							},
						],
					},
				],
			});

			await handleCloseCommand(harness.testDir, []);

			const content = readFileSync(
				path.join(swarmDir(), 'context.md'),
				'utf-8',
			);
			expect(content).toContain('Finalization: plan-already-done');
		});
	});

	describe('Close summary', () => {
		it('includes archive result and finalization type in close-summary.md', async () => {
			writeFileSync(
				path.join(swarmDir(), 'close-summary.md'),
				'# stale previous-session summary',
			);
			await writePlan();

			await handleCloseCommand(harness.testDir, []);

			const summaryPath = path.join(swarmDir(), 'close-summary.md');
			expect(existsSync(summaryPath)).toBe(true);
			const summary = readFileSync(summaryPath, 'utf-8');
			expect(summary).toContain('Archived');
			expect(summary).toContain('.swarm/archive/swarm-');
			expect(summary).toContain('Normal finalization');
			const archiveName = readdirSync(path.join(swarmDir(), 'archive')).find(
				(name) => name.startsWith('swarm-'),
			);
			expect(archiveName).toBeDefined();
			const archivedSummary = readFileSync(
				path.join(swarmDir(), 'archive', archiveName!, 'close-summary.md'),
				'utf-8',
			);
			expect(archivedSummary).toBe(summary);
			expect(archivedSummary).not.toContain('stale previous-session');
		});

		it('distinguishes normal finalization from forced closure in the summary', async () => {
			await writePlan();

			await handleCloseCommand(harness.testDir, ['--force']);

			const summary = readFileSync(
				path.join(swarmDir(), 'close-summary.md'),
				'utf-8',
			);
			expect(summary).toContain('Forced closure');
		});

		it('return message includes archive and git status info', async () => {
			await writePlan();

			const result = await handleCloseCommand(harness.testDir, []);

			expect(result).toContain('**Archive:**');
			expect(result).toContain('**Git:**');
			expect(result).toContain('Not a git repository');
		});

		it('forced closure return message differs from normal', async () => {
			await writePlan();

			const normalResult = await handleCloseCommand(harness.testDir, []);

			mkdirSync(path.join(swarmDir(), 'session'), { recursive: true });
			await writePlan();

			const forcedResult = await handleCloseCommand(harness.testDir, [
				'--force',
			]);

			expect(normalResult).toContain('Swarm finalized');
			expect(forcedResult).toContain('Swarm finalized');
		});
	});

	describe('Align stage', () => {
		it('regression: detects a git repo and runs aggressive reset during finalize', async () => {
			mockGetGitRepositoryStatus.mockImplementation(() => ({ isRepo: true }));
			mockResetToMainAfterMerge.mockImplementation(() => ({
				success: true,
				targetBranch: 'origin/main',
				previousBranch: 'feature/finalize',
				message: 'Reset to origin/main',
				branchDeleted: false,
				changesDiscarded: false,
				warnings: [],
			}));
			await writePlan();

			const result = await handleCloseCommand(harness.testDir, []);

			expect(mockGetGitRepositoryStatus).toHaveBeenCalledWith(harness.testDir);
			expect(mockResetToMainAfterMerge).toHaveBeenCalledWith(harness.testDir, {
				pruneBranches: false,
			});
			expect(mockResetToRemoteBranch).not.toHaveBeenCalled();
			expect(result).toContain('**Git:** Reset to origin/main');
			expect(result).not.toContain('Not a git repository');

			const summary = readFileSync(
				path.join(swarmDir(), 'close-summary.md'),
				'utf-8',
			);
			expect(summary).toContain('- **Git:** Reset to origin/main');
		});

		it('reports git execution failures without misclassifying them as non-git repos', async () => {
			mockGetGitRepositoryStatus.mockImplementation(() => ({
				isRepo: false,
				reason: 'git_unavailable',
				message: 'git executable is not available on PATH',
			}));
			await writePlan();

			const result = await handleCloseCommand(harness.testDir, []);

			expect(result).toContain('Git executable unavailable');
			expect(result).toContain('git executable is not available on PATH');
			expect(result).not.toContain('Not a git repository');
			expect(mockResetToMainAfterMerge).not.toHaveBeenCalled();
			expect(mockResetToRemoteBranch).not.toHaveBeenCalled();
		});

		it('reports git_error in warnings when repository check fails (F-001)', async () => {
			mockGetGitRepositoryStatus.mockImplementation(() => ({
				isRepo: false,
				reason: 'git_error',
				message: 'spawnSync git ETIMEDOUT',
			}));
			await writePlan();

			const result = await handleCloseCommand(harness.testDir, []);

			expect(result).toContain('Git repository check failed');
			expect(result).toContain('spawnSync git ETIMEDOUT');
			expect(result).toContain('**Warnings:**');
			expect(mockResetToMainAfterMerge).not.toHaveBeenCalled();
			expect(mockResetToRemoteBranch).not.toHaveBeenCalled();
		});

		it('falls back to resetToRemoteBranch when resetToMainAfterMerge returns success:false (F-004)', async () => {
			mockGetGitRepositoryStatus.mockImplementation(() => ({ isRepo: true }));
			mockResetToMainAfterMerge.mockImplementation(() => ({
				success: false,
				targetBranch: 'origin/main',
				previousBranch: 'main',
				message: 'Nothing to reset',
				branchDeleted: false,
				changesDiscarded: false,
				warnings: [] as string[],
			}));
			await writePlan();

			await handleCloseCommand(harness.testDir, []);

			expect(mockResetToRemoteBranch).toHaveBeenCalledTimes(1);
		});
	});

	describe('Plan already terminal', () => {
		it('skips retro writing but still archives and cleans', async () => {
			await writePlan({
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'completed',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'completed',
								description: 'Task A',
								size: 'small',
							},
						],
					},
				],
			});
			writeFileSync(path.join(swarmDir(), 'events.jsonl'), '{"e":1}\n');

			const result = await handleCloseCommand(harness.testDir, []);

			expect(mockExecuteWriteRetro).toHaveBeenCalledTimes(0);

			const archiveBase = path.join(swarmDir(), 'archive');
			const entries = readdirSync(archiveBase);
			expect(entries.length).toBeGreaterThanOrEqual(1);

			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(false);
			expect(result).toContain('already in a terminal state');
		});
	});

	describe('Session-level retrospective (plan-free)', () => {
		it('writes session retro with task_id "retro-session" and session_scope "plan_free" when no plan.json exists', async () => {
			const result = await handleCloseCommand(harness.testDir, []);

			expect(mockExecuteWriteRetro).toHaveBeenCalledTimes(1);
			const retroCall = mockExecuteWriteRetro.mock.calls[0];
			const retroArgs = retroCall[0] as {
				phase?: number;
				task_id?: string;
				summary?: string;
				task_count?: number;
				task_complexity?: string;
				metadata?: { session_scope?: string; session_start?: string };
			};
			expect(retroArgs.task_id).toBe('retro-session');
			expect(retroArgs.metadata?.session_scope).toBe('plan_free');
			expect(retroArgs.phase).toBe(1);
			expect(retroArgs.summary).toBe(
				'Plan-free session closed via /swarm close',
			);
			expect(retroCall[1]).toBe(harness.testDir);
			expect(result).toContain('finalized');
		});

		it('does not write the session retro when a plan exists and phases are closed (phase retro written instead)', async () => {
			await writePlan();
			await handleCloseCommand(harness.testDir, []);

			expect(mockExecuteWriteRetro).toHaveBeenCalledTimes(1);
			const retroCall = mockExecuteWriteRetro.mock.calls[0];
			const retroArgs = retroCall[0] as { task_id?: string; phase?: number };
			expect(retroArgs.task_id).toBeUndefined();
			expect(retroArgs.phase).toBe(1);

			const hadSessionRetroCall = mockExecuteWriteRetro.mock.calls.some((c) => {
				const a = c[0] as { task_id?: string };
				return a.task_id === 'retro-session';
			});
			expect(hadSessionRetroCall).toBe(false);
		});
	});

	describe('Junction/symlink guard', () => {
		it('trips guard and returns refusal when .swarm/ is a junction or symlink', async () => {
			const targetDir = path.join(harness.testDir, 'real-swarm-target');
			mkdirSync(targetDir, { recursive: true });

			try {
				await rm(swarmDir(), { recursive: true, force: true });
				await fs.symlink(targetDir, swarmDir(), 'junction');
			} catch {
				return;
			}

			const closeResult = await handleCloseCommand(harness.testDir, []);

			expect(closeResult).toContain('symlink');
			expect(closeResult).toContain('junction');
			expect(closeResult).toContain('Refused');
			expect(closeResult).toContain('.swarm/ is a symlink or junction');
		});

		it('does not trip guard for normal (non-symlink) .swarm/ and proceeds normally', async () => {
			await writePlan();

			const closeResult = await handleCloseCommand(harness.testDir, []);

			expect(closeResult).not.toContain('Refused');
			expect(closeResult).not.toContain('symlink');
			expect(closeResult).not.toContain('junction');
			expect(closeResult).toContain('finalized');
			expect(mockResetSwarmStatePreservingSingletons).toHaveBeenCalled();
		});
	});

	describe('Skill review flag path', () => {
		it('calls runSkillImprover (via mock.calls) when --skill-review is passed', async () => {
			await writePlan();

			await handleCloseCommand(harness.testDir, ['--skill-review']);

			expect(mockRunSkillImprover.mock.calls.length).toBe(1);
		});

		it('does NOT call runSkillImprover when no args passed', async () => {
			await writePlan();

			await handleCloseCommand(harness.testDir, []);

			expect(mockRunSkillImprover.mock.calls.length).toBe(0);
		});

		it('includes the skill review summary in the command output when flag present', async () => {
			await writePlan();

			const result = await handleCloseCommand(harness.testDir, [
				'--skill-review',
			]);

			expect(result).toContain('**Skill Review:**');
			expect(result).toContain('Skill review proposal generated');
			expect(result).toContain('test-skill-review.md');
		});
	});
});
