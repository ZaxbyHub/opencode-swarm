/**
 * Engine repository facade for swarm lane creation.
 *
 * The public command is `repo lane create`. The hidden handler name
 * `lane-create` is not a swarm spawn argument.
 *
 * Next callers that should use `findRepoRoot` and must not spawn `lane-create`:
 * `gitExec` in `src/git/branch.ts` and `runGit` in `src/worktree/merge.ts`.
 * Future Engine reads are `repo vcs status`, `repo vcs diff`, `repo vcs log`,
 * and `repo lane list`. Engine has no `repo vcs workspace-create`.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bunSpawn, type BunCompatSubprocess } from '../utils/bun-compat';

const LANE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]+$/;
const LANE_CREATE_TIMEOUT_MS = 120_000;
const REPO_LANE_MARKER = 'opencode-swarm-repo-lane';
const REPO_LANE_MARKER_REL = path.join('.swarm', 'repo-lane.json');

export interface RepoLaneMarker {
	kind: typeof REPO_LANE_MARKER;
	parentProjectPath: string;
	sessionId: string;
	id: string;
}

export const _internals: {
	spawn: (
		cmd: string[],
		options?: {
			cwd?: string;
			timeout?: number;
			stdin?: 'ignore';
			stdout?: 'pipe';
			stderr?: 'pipe';
			env?: NodeJS.ProcessEnv;
		},
	) => BunCompatSubprocess;
} = {
	spawn: bunSpawn,
};

export function repoLaneCreateArgs(name: string, objective: string): string[] {
	return ['lane', 'create', name, '--objective', objective, '--scope', 'repository'];
}

export function parseRepoLaneCreateStdout(
	stdout: string,
): { name: string; path: string } | null {
	const match = stdout.match(/created=(\S+)\s+path=(\S+)/);
	if (!match) return null;
	const name = match[1];
	const lanePath = match[2];
	if (!name || !lanePath || !path.isAbsolute(lanePath)) return null;
	return { name, path: lanePath };
}

export function laneNameFromSwarmId(
	sessionId: string,
	id: string,
): string | null {
	if (sessionId.includes('..') || id.includes('..')) return null;
	const cleaned = `swarm-${sessionId}-${id}`
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.replace(/^-+/, '')
		.replace(/-+$/, '');
	if (!LANE_NAME.test(cleaned) || cleaned === 'default') return null;
	return cleaned;
}

function isExecutableFile(filePath: string): boolean {
	try {
		const stat = statSync(filePath);
		return stat.isFile() && (stat.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

function isEngineRepoRoot(dir: string): boolean {
	return (
		existsSync(path.join(dir, '.jj')) &&
		existsSync(path.join(dir, '.purpose', 'commands.json')) &&
		isExecutableFile(path.join(dir, 'bin', 'repo'))
	);
}

export function writeRepoLaneMarker(
	lanePath: string,
	marker: Omit<RepoLaneMarker, 'kind'>,
): void {
	const body: RepoLaneMarker = { kind: REPO_LANE_MARKER, ...marker };
	const filePath = path.join(lanePath, REPO_LANE_MARKER_REL);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(body)}\n`, 'utf-8');
}

function parseRepoLaneMarker(raw: string): RepoLaneMarker | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const record = parsed as Record<string, unknown>;
	if (record.kind !== REPO_LANE_MARKER) return null;
	if (typeof record.parentProjectPath !== 'string' || !path.isAbsolute(record.parentProjectPath)) {
		return null;
	}
	if (typeof record.sessionId !== 'string' || !SESSION_ID_PATTERN.test(record.sessionId)) {
		return null;
	}
	if (typeof record.id !== 'string' || record.id.length === 0 || record.id.includes('..')) {
		return null;
	}
	return {
		kind: REPO_LANE_MARKER,
		parentProjectPath: path.resolve(record.parentProjectPath),
		sessionId: record.sessionId,
		id: record.id,
	};
}

/**
 * Recognize a swarm-owned Engine lane. The marker is the ownership signal:
 * the workspace is not a git worktree and does not live under `.swarm-worktrees`.
 * The parent must itself be an Engine root and must not be the lane.
 */
export function readRepoLaneContext(
	start: string,
): { lanePath: string; parentProjectPath: string } | null {
	let dir = path.resolve(start);
	for (let depth = 0; depth < 32; depth += 1) {
		const filePath = path.join(dir, REPO_LANE_MARKER_REL);
		if (existsSync(filePath)) {
			let raw: string;
			try {
				raw = readFileSync(filePath, 'utf-8');
			} catch {
				return null;
			}
			const marker = parseRepoLaneMarker(raw);
			if (!marker) return null;
			if (marker.parentProjectPath === dir) return null;
			if (findRepoRoot(marker.parentProjectPath) !== marker.parentProjectPath) return null;
			return { lanePath: dir, parentProjectPath: marker.parentProjectPath };
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

/** Walk parents. An Engine root has `.jj`, `.purpose/commands.json`, and executable `bin/repo`. */
export function findRepoRoot(start: string): string | null {
	let dir = path.resolve(start);
	for (let depth = 0; depth < 32; depth += 1) {
		if (isEngineRepoRoot(dir)) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

/** Map a plain git read onto `repo vcs`. Unknown or flagged git argv stays on git. */
export function repoVcsReadArgs(gitArgs: readonly string[]): string[] | null {
	const [command, ...rest] = gitArgs;
	if (command !== 'status' && command !== 'diff' && command !== 'log') return null;
	if (rest.some((arg) => arg.startsWith('-'))) return null;
	return ['vcs', command, ...rest];
}

export async function runRepo(
	root: string,
	repoArgs: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	let proc: BunCompatSubprocess;
	try {
		proc = _internals.spawn(['direnv', 'exec', root, 'repo', ...repoArgs], {
			cwd: root,
			timeout: LANE_CREATE_TIMEOUT_MS,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env, LC_ALL: 'C' },
		});
	} catch (error) {
		return {
			exitCode: 127,
			stdout: '',
			stderr: error instanceof Error ? error.message : String(error),
		};
	}
	try {
		const exitCode = await proc.exited;
		const stdout = await proc.stdout.text();
		const stderr = await proc.stderr.text();
		return { exitCode, stdout, stderr };
	} finally {
		proc.kill();
	}
}

export async function runRepoLaneCreate(
	root: string,
	name: string,
	objective: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return runRepo(root, repoLaneCreateArgs(name, objective));
}

export function readRepoLaneIds(
	start: string,
): { sessionId: string; id: string; lanePath: string; parentProjectPath: string } | null {
	const ctx = readRepoLaneContext(start);
	if (!ctx) return null;
	const filePath = path.join(ctx.lanePath, REPO_LANE_MARKER_REL);
	let raw: string;
	try {
		raw = readFileSync(filePath, 'utf-8');
	} catch {
		return null;
	}
	const marker = parseRepoLaneMarker(raw);
	if (!marker) return null;
	return {
		sessionId: marker.sessionId,
		id: marker.id,
		lanePath: ctx.lanePath,
		parentProjectPath: ctx.parentProjectPath,
	};
}

export function repoLanePushArgs(name: string): string[] {
	return ['lane', 'push', name];
}

export function repoLanePublishArgs(name: string, base = 'main'): string[] {
	return ['lane', 'publish', name, base];
}

export function repoPrCreateArgs(input: {
	title: string;
	head: string;
	base: string;
	body?: string;
}): string[] {
	const args = [
		'pr',
		'create',
		'--title',
		input.title,
		'--head',
		input.head,
		'--base',
		input.base,
	];
	if (input.body !== undefined && input.body.length > 0) {
		args.push('--body', input.body);
	}
	return args;
}

export function repoIssueCreateArgs(title: string, body?: string): string[] {
	const args = ['issue', 'create', '--title', title];
	if (body !== undefined && body.length > 0) {
		args.push('--body', body);
	}
	return args;
}

export function repoIssueUpdateArgs(
	index: number,
	updates: { title?: string; body?: string; state?: string },
): string[] {
	const args = ['issue', 'update', String(index)];
	if (updates.title !== undefined) args.push('--title', updates.title);
	if (updates.body !== undefined) args.push('--body', updates.body);
	if (updates.state !== undefined) args.push('--state', updates.state);
	return args;
}

/** First JSON object line on stdout from `repo pr|issue` emit(). */
export function parseRepoJsonStdout(stdout: string): Record<string, unknown> | null {
	for (const line of stdout.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			continue;
		}
	}
	return null;
}
