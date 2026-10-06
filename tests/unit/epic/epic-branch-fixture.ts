/**
 * Shared fixture for the Epic v2 C1b epic-branch suites: a real git project
 * with a saved epic-sized plan, an epic opened through the production
 * `startEpic` (epic-branch policy by default), and small git helpers.
 *
 * Process-global start inputs (in-memory Turbo sessions, worktree dispatch
 * maps) go through the start module's `_internals` seam; callers restore it
 * with {@link restoreStartInternals} in `afterEach`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EpicRecordV1 } from '../../../src/epic/lifecycle';
import {
	startEpic,
	_internals as startInternals,
} from '../../../src/epic/start';
import { savePlan } from '../../../src/plan/manager';
import { createStartProject, git, sizedPlan } from './start-fixture';

export { git } from './start-fixture';

const realStartInternals = { ...startInternals };

export function stubStartGlobals(): void {
	startInternals.hasActiveTurboMode = () => false;
	startInternals.countTrackedWorktreeDispatches = () => 0;
}

export function restoreStartInternals(): void {
	Object.assign(startInternals, realStartInternals);
}

export function headBranch(dir: string): string {
	return git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

export function headSha(dir: string, ref = 'HEAD'): string {
	return git(dir, ['rev-parse', ref]).trim();
}

/** Porcelain status lines outside `.swarm/` (empty ⇒ clean). */
export function dirtyLines(dir: string): string[] {
	return git(dir, ['status', '--porcelain=v1', '--untracked-files=normal'])
		.split('\n')
		.filter((line) => line.length > 0 && !line.slice(3).startsWith('.swarm'));
}

export function stagedFiles(dir: string): string[] {
	return git(dir, ['diff', '--cached', '--name-only'])
		.split('\n')
		.filter((line) => line.length > 0)
		.sort();
}

export function mergeHeadExists(dir: string): boolean {
	return fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'));
}

/** Write + commit files on the checked-out branch. */
export function commitFiles(
	dir: string,
	files: Record<string, string>,
	message: string,
): void {
	for (const [rel, content] of Object.entries(files)) {
		const target = path.join(dir, rel);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
		git(dir, ['add', '--', rel]);
	}
	git(dir, ['commit', '-q', '-m', message]);
}

/** Mark every task of the fixture plan completed (same plan identity). */
export async function completeAllTasks(dir: string, count = 6): Promise<void> {
	const plan = sizedPlan('Start Plan', count);
	for (const task of plan.phases[0].tasks) task.status = 'completed';
	await savePlan(dir, plan);
}

export interface StartedEpic {
	dir: string;
	record: EpicRecordV1;
	originalBranch: string;
	epicBranch: string;
}

/** A git project with an epic opened by `startEpic` on its epic branch. */
export async function startedGitEpic(
	prefix: string,
	config?: Record<string, unknown>,
): Promise<StartedEpic> {
	const dir = await createStartProject(prefix, { git: true, config });
	const originalBranch = headBranch(dir);
	const result = await startEpic({
		directory: dir,
		sessionID: 'ses_branch',
		force: false,
	});
	if (result.status !== 'started') {
		throw new Error(`startedGitEpic: ${JSON.stringify(result)}`);
	}
	const epicBranch = result.record.git.epicBranch;
	if (!epicBranch) throw new Error('startedGitEpic: no epic branch recorded');
	return { dir, record: result.record, originalBranch, epicBranch };
}
