/**
 * Shared fixture for the `/swarm epic start` suites: a real temp project
 * (optional git repo with `.swarm/` ignored and a committed config) and a
 * real saved plan (ledger + plan.json) via `savePlan`.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { savePlan } from '../../../src/plan/manager';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

export function git(dir: string, args: string[]): string {
	const r = spawnSync('git', args, {
		cwd: dir,
		encoding: 'utf-8',
		timeout: 30_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
		env: { ...process.env, GIT_CONFIG_GLOBAL: NULL_DEVICE },
	});
	if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
	return r.stdout;
}

export function writeProjectConfig(
	dir: string,
	config: Record<string, unknown>,
): void {
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(config),
	);
}

export const EPIC_ON_CONFIG = {
	epic: { mode: { enabled: true } },
};

/** A plan with `count` pending tasks in one phase, each on its own file. */
export function sizedPlan(
	title: string,
	count: number,
	options: { scoped?: number } = {},
): Plan {
	const scoped = options.scoped ?? count;
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'start-swarm',
		current_phase: 1,
		migration_status: 'native',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: Array.from({ length: count }, (_, index) => ({
					id: `1.${index + 1}`,
					phase: 1,
					status: 'pending' as const,
					size: 'small' as const,
					description: `task ${index + 1}`,
					depends: [],
					files_touched: index < scoped ? [`src/file-${index + 1}.ts`] : [],
				})),
			},
		],
	};
}

export async function createStartProject(
	prefix: string,
	options: {
		git: boolean;
		config?: Record<string, unknown>;
		plan?: Plan | null;
	},
): Promise<string> {
	const dir = canonicalMkdtemp(prefix);
	writeProjectConfig(dir, options.config ?? EPIC_ON_CONFIG);
	if (options.git) {
		git(dir, ['init', '-q']);
		git(dir, ['config', 'user.email', 'test@example.com']);
		git(dir, ['config', 'user.name', 'Test User']);
		git(dir, ['config', 'commit.gpgsign', 'false']);
		fs.writeFileSync(path.join(dir, '.gitignore'), '.swarm/\n');
		git(dir, ['add', '.']);
		git(dir, ['commit', '-q', '-m', 'seed']);
	}
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	const plan =
		options.plan === undefined ? sizedPlan('Start Plan', 6) : options.plan;
	if (plan) await savePlan(dir, plan);
	return dir;
}
