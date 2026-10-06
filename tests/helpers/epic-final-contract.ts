/**
 * Shared fixture for the FINAL Epic v2 lifecycle contract (C8):
 * `tests/integration/epic-lifecycle-contract-final.test.ts` (Epic on, the
 * whole lifecycle) and `…-final-off.test.ts` (the config-off twin).
 *
 * A real git repository in a canonical temp dir (`.swarm/` and the
 * worktree base ignored), a project config, a controllable frozen clock
 * (`setClock` re-freezes both `Date.now()` and `toISOString()`), git
 * commit dates pinned to that clock (so commit SHAs are reproducible), and
 * the two-phase plan both twins save through the real `save_plan`.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReviewModelDispatcher } from '../../src/review/contracts';
import type { executeSavePlan } from '../../src/tools/save-plan';
import { freezeClock, type Restore } from './test-clock.js';
import { canonicalMkdtemp } from './tmpdir';

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

export const FINAL_T0 = Date.parse('2026-10-01T10:00:00.000Z');
/**
 * ISO instant `minutes` after {@link FINAL_T0}. Formatted by hand: the
 * frozen clock spies `Date.prototype.toISOString` (every date would print
 * as the frozen instant).
 */
export function atMinute(minutes: number): string {
	const d = new Date(FINAL_T0 + minutes * 60_000);
	const p = (n: number, w = 2) => String(n).padStart(w, '0');
	return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}Z`;
}

export interface FinalContractRepo {
	dir: string;
	git: (args: string[]) => string;
	/** Re-freeze the clock at `minutes` after T0 (git dates follow it). */
	setClock: (minutes: number) => void;
	/** Restore the real clock (another repo may then freeze it). */
	releaseClock: () => void;
	cleanup: () => void;
}

/** The plan both twins run: 7 tasks, 2 phases, one cross-phase edge. */
export const FINAL_PHASES: Array<
	Array<{ id: string; files: string[]; depends?: string[] }>
> = [
	[
		{ id: '1.1', files: ['src/sum.ts', 'tests/sum.test.ts'] },
		{ id: '1.2', files: ['src/b.ts'] },
		{ id: '1.3', files: ['src/c.ts'], depends: ['1.1'] },
		{ id: '1.4', files: ['src/d.ts'] },
	],
	[
		{ id: '2.1', files: ['src/use.ts'], depends: ['1.3'] },
		{ id: '2.2', files: ['src/e.ts'] },
		{ id: '2.3', files: ['src/f.ts'] },
	],
];

export const finalTask = (id: string) => {
	const task = FINAL_PHASES.flat().find((t) => t.id === id);
	if (!task) throw new Error(`no task ${id}`);
	return task;
};

/** The identifier a task's file exports (`completion_verify` checks it). */
export const finalIdent = (id: string): string =>
	id === '1.1' ? 'sum' : `task_${id.replace('.', '_')}`;

/** A task's description (and so its commit subject). */
export const finalDescription = (id: string): string =>
	`Create ${finalTask(id).files[0]} exporting \`${finalIdent(id)}\``;

/** Content of a task's file that satisfies `completion_verify`. */
export const finalContent = (id: string): string =>
	`export const ${finalIdent(id)} = '${id}';\n`;

export function finalSavePlanArgs(
	dir: string,
): Parameters<typeof executeSavePlan>[0] {
	return {
		title: 'Contract Final',
		swarm_id: 'contract-swarm',
		working_directory: dir,
		phases: FINAL_PHASES.map((tasks, index) => ({
			id: index + 1,
			name: `Phase ${index + 1}`,
			tasks: tasks.map((t) => ({
				id: t.id,
				description: finalDescription(t.id),
				files_touched: t.files,
				depends: t.depends ?? [],
			})),
		})),
	};
}

/**
 * A real repo + config. `epic` is the `turbo.epic` block (absent ⇒ no
 * Epic configuration at all, the upstream-equivalent baseline).
 */
export function createFinalContractRepo(
	prefix: string,
	epic: Record<string, unknown> | undefined,
): FinalContractRepo {
	const dir = canonicalMkdtemp(prefix);
	let restore: Restore | null = null;
	let gitDate = atMinute(0);
	const savedDates = {
		author: process.env.GIT_AUTHOR_DATE,
		committer: process.env.GIT_COMMITTER_DATE,
	};
	const setClock = (minutes: number) => {
		restore?.();
		const iso = atMinute(minutes);
		restore = freezeClock({ isoNow: iso, fixedNow: Date.parse(iso) });
		gitDate = iso;
		// Production git calls inherit process.env: pin their commit dates.
		process.env.GIT_AUTHOR_DATE = iso;
		process.env.GIT_COMMITTER_DATE = iso;
	};
	const git = (args: string[]): string => {
		const r = spawnSync('git', args, {
			cwd: dir,
			encoding: 'utf-8',
			timeout: 30_000,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
			env: {
				...process.env,
				GIT_CONFIG_GLOBAL: NULL_DEVICE,
				GIT_AUTHOR_DATE: gitDate,
				GIT_COMMITTER_DATE: gitDate,
			},
		});
		if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
		return r.stdout;
	};
	setClock(0);
	git(['init', '-q', '-b', 'main']);
	git(['config', 'user.email', 'test@example.com']);
	git(['config', 'user.name', 'Test User']);
	git(['config', 'commit.gpgsign', 'false']);
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			phase_complete: {
				enabled: true,
				required_agents: ['coder'],
				require_docs: false,
				policy: 'enforce',
			},
			curator: { enabled: false },
			turbo: { strategy: 'standard' },
			...(epic ? { epic } : {}),
		}),
	);
	// The config stays untracked (ignored) so both twins' commits — and so
	// their SHAs — are identical whatever the config says.
	fs.writeFileSync(
		path.join(dir, '.gitignore'),
		'.swarm/\n.swarm-worktrees/\n.opencode/\n',
	);
	git(['add', '.']);
	git(['commit', '-q', '-m', 'seed']);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	const releaseClock = () => {
		restore?.();
		restore = null;
	};
	return {
		dir,
		git,
		setClock,
		releaseClock,
		cleanup: () => {
			releaseClock();
			for (const [key, value] of [
				['GIT_AUTHOR_DATE', savedDates.author],
				['GIT_COMMITTER_DATE', savedDates.committer],
			] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			try {
				for (const line of git(['worktree', 'list', '--porcelain']).split(
					'\n',
				)) {
					const lane = line.startsWith('worktree ') ? line.slice(9) : '';
					if (lane && path.resolve(lane) !== path.resolve(dir)) {
						git(['worktree', 'remove', '--force', lane]);
					}
				}
			} catch {
				// best-effort
			}
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** Phase evidence `phase_complete` requires (retrospective + drift). */
export function writeFinalPhaseEvidence(
	dir: string,
	phase: number,
	timestamp: string,
): void {
	const evidence = path.join(dir, '.swarm', 'evidence');
	fs.mkdirSync(path.join(evidence, `retro-${phase}`), { recursive: true });
	fs.writeFileSync(
		path.join(evidence, `retro-${phase}`, 'evidence.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: `retro-${phase}`,
			entries: [
				{
					task_id: `retro-${phase}`,
					type: 'retrospective',
					timestamp,
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase retrospective',
					metadata: {},
					phase_number: phase,
					total_tool_calls: 10,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: FINAL_PHASES[phase - 1].length,
					task_complexity: 'simple',
					top_rejection_reasons: [],
					lessons_learned: [],
				},
			],
			created_at: timestamp,
			updated_at: timestamp,
		}),
	);
	fs.mkdirSync(path.join(evidence, String(phase)), { recursive: true });
	fs.writeFileSync(
		path.join(evidence, String(phase), 'drift-verifier.json'),
		JSON.stringify({
			entries: [
				{
					type: 'drift-verification',
					verdict: 'approved',
					summary: 'Drift check',
					timestamp,
				},
			],
		}),
	);
}

/** A review dispatcher that approves without a model call. */
export const approvingReviewDispatcher: ReviewModelDispatcher = {
	dispatch: async (request) => ({
		status: 'completed',
		agentName: request.agentName,
		text: 'VERDICT: APPROVED\nREASON: the waves integrate cleanly',
		durationMs: 1,
		promptBytes: 0,
		responseBytes: 0,
	}),
};

/**
 * Every file under `root` (relative, `/`-separated, sorted) except those
 * `skip` matches — the `.swarm` tree comparison of the config-off twin.
 */
export function listTree(
	root: string,
	skip: (relative: string) => boolean = () => false,
): string[] {
	const out: string[] = [];
	const walk = (current: string) => {
		if (!fs.existsSync(current)) return;
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			const relative = path.relative(root, full).split(path.sep).join('/');
			if (skip(relative)) continue;
			if (entry.isDirectory()) walk(full);
			else out.push(relative);
		}
	};
	walk(root);
	return out.sort();
}
