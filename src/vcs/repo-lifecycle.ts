/**
 * Engine `repo` CLI lifecycle automation for swarm.
 *
 * Declarative rules in config (`repo.lifecycle.automation`) use either structured
 * `when` objects or CEL-shaped strings over a fixed context (subset — no calls,
 * no loops). Defaults open a Forgejo PR (and push the lane) instead of git
 * merge-back on Engine roots.
 */

import { loadPluginConfig } from '../config/loader.js';
import { matchSwarmLaneBranch } from '../config/swarm-branch.js';
import type { MergeStrategy } from '../worktree/types.js';
import {
	findRepoRoot,
	laneNameFromSwarmId,
	parseRepoJsonStdout,
	readRepoLaneIds,
	repoIssueCreateArgs,
	repoIssueUpdateArgs,
	repoLanePublishArgs,
	repoLanePushArgs,
	repoPrCreateArgs,
	runRepo,
} from './repo-facade.js';

export type RepoLifecycleEvent =
	| 'land_lane'
	| 'file_issue'
	| 'close_issue'
	| 'integrate_lane';

export type RepoLifecycleAction =
	| 'lane_push'
	| 'pr_create'
	| 'issue_create'
	| 'issue_close'
	| 'lane_publish';

export type RepoLifecycleWhen =
	| string
	| {
			engine?: boolean;
			event?: RepoLifecycleEvent;
	  };

export interface RepoLifecycleRule {
	id?: string;
	when: RepoLifecycleWhen;
	do: RepoLifecycleAction[];
}

export interface RepoLifecycleContext {
	engineRepo: boolean;
	event: RepoLifecycleEvent;
	laneName: string | null;
	title: string;
	body?: string;
	issueNumber?: number;
	prBase: string;
}

export interface RepoLifecycleRunResult {
	ok: boolean;
	error?: string;
	prNumber?: number;
	prUrl?: string;
	issueNumber?: number;
	executed: RepoLifecycleAction[];
}

export const DEFAULT_REPO_LIFECYCLE_RULES: RepoLifecycleRule[] = [
	{
		id: 'engine_land_review',
		when: { engine: true, event: 'land_lane' },
		do: ['lane_push', 'pr_create'],
	},
	{
		id: 'engine_integrate',
		when: 'engine_repo && event == integrate_lane',
		do: ['lane_publish'],
	},
	{
		id: 'engine_file_issue',
		when: { engine: true, event: 'file_issue' },
		do: ['issue_create'],
	},
	{
		id: 'engine_close_issue',
		when: { engine: true, event: 'close_issue' },
		do: ['issue_close'],
	},
];

const CONTEXT_KEYS = new Set([
	'engine_repo',
	'event',
	'land_lane',
	'file_issue',
	'close_issue',
	'integrate_lane',
	'true',
	'false',
]);

/** Evaluate a small CEL-shaped expression (equality / boolean ops only). */
export function evaluateRepoLifecycleWhen(
	when: RepoLifecycleWhen,
	ctx: RepoLifecycleContext,
): boolean {
	if (typeof when === 'object') {
		if (when.engine !== undefined && when.engine !== ctx.engineRepo) return false;
		if (when.event !== undefined && when.event !== ctx.event) return false;
		return true;
	}
	return evaluateCelSubset(when, ctx);
}

function tokenizeCel(expr: string): string[] {
	return expr
		.trim()
		.replace(/\(/g, ' ( ')
		.replace(/\)/g, ' ) ')
		.split(/\s+/)
		.filter((t) => t.length > 0);
}

function evaluateCelSubset(expr: string, ctx: RepoLifecycleContext): boolean {
	const tokens = tokenizeCel(expr);
	let index = 0;

	const parseOr = (): boolean => {
		let value = parseAnd();
		while (index < tokens.length && tokens[index] === '||') {
			index += 1;
			value = value || parseAnd();
		}
		return value;
	};

	const parseAnd = (): boolean => {
		let value = parseAtom();
		while (index < tokens.length && tokens[index] === '&&') {
			index += 1;
			value = value && parseAtom();
		}
		return value;
	};

	const parseAtom = (): boolean => {
		if (tokens[index] === '(') {
			index += 1;
			const inner = parseOr();
			if (tokens[index] !== ')') return false;
			index += 1;
			return inner;
		}
		if (index + 2 < tokens.length && tokens[index + 1] === '==') {
			const left = tokens[index];
			const right = tokens[index + 2];
			index += 3;
			return resolveCelValue(left, ctx) === resolveCelValue(right, ctx);
		}
		if (index + 2 < tokens.length && tokens[index + 1] === '!=') {
			const left = tokens[index];
			const right = tokens[index + 2];
			index += 3;
			return resolveCelValue(left, ctx) !== resolveCelValue(right, ctx);
		}
		const atom = tokens[index];
		index += 1;
		return Boolean(resolveCelValue(atom, ctx));
	};

	try {
		const result = parseOr();
		return index === tokens.length ? result : false;
	} catch {
		return false;
	}
}

function resolveCelValue(token: string | undefined, ctx: RepoLifecycleContext): unknown {
	if (token === undefined || !CONTEXT_KEYS.has(token)) return undefined;
	if (token === 'true') return true;
	if (token === 'false') return false;
	if (token === 'engine_repo') return ctx.engineRepo;
	if (token === 'event') return ctx.event;
	if (token === 'land_lane') return 'land_lane';
	if (token === 'file_issue') return 'file_issue';
	if (token === 'close_issue') return 'close_issue';
	if (token === 'integrate_lane') return 'integrate_lane';
	return undefined;
}

export function resolveRepoLaneName(
	primaryDir: string,
	branchName: string,
): string | null {
	const ids = readRepoLaneIds(primaryDir);
	if (ids) return laneNameFromSwarmId(ids.sessionId, ids.id);
	const branch = matchSwarmLaneBranch(branchName);
	if (!branch) return null;
	return laneNameFromSwarmId(branch.sessionId, branch.id);
}

function loadLifecycleRules(directory: string): RepoLifecycleRule[] {
	try {
		const config = loadPluginConfig(directory) as {
			repo?: { lifecycle?: { automation?: RepoLifecycleRule[] } };
		};
		const custom = config.repo?.lifecycle?.automation;
		if (Array.isArray(custom) && custom.length > 0) return custom;
	} catch {
		// fall through to defaults
	}
	return DEFAULT_REPO_LIFECYCLE_RULES;
}

function loadPrBase(directory: string): string {
	try {
		const config = loadPluginConfig(directory) as {
			repo?: { lifecycle?: { pr_base?: string } };
		};
		return config.repo?.lifecycle?.pr_base ?? 'main';
	} catch {
		return 'main';
	}
}

function rulesForEvent(
	rules: RepoLifecycleRule[],
	ctx: RepoLifecycleContext,
): RepoLifecycleAction[] {
	const actions: RepoLifecycleAction[] = [];
	for (const rule of rules) {
		if (!evaluateRepoLifecycleWhen(rule.when, ctx)) continue;
		for (const action of rule.do) {
			if (!actions.includes(action)) actions.push(action);
		}
	}
	return actions;
}

export async function runRepoLifecycle(
	root: string,
	ctx: RepoLifecycleContext,
): Promise<RepoLifecycleRunResult> {
	const rules = loadLifecycleRules(root);
	const actions = rulesForEvent(rules, ctx);
	if (actions.length === 0) {
		return { ok: false, error: 'no repo lifecycle rule matched', executed: [] };
	}
	if (
		(actions.includes('lane_push') ||
			actions.includes('pr_create') ||
			actions.includes('lane_publish')) &&
		!ctx.laneName
	) {
		return {
			ok: false,
			error: 'repo lifecycle requires a resolved lane name',
			executed: [],
		};
	}

	const executed: RepoLifecycleAction[] = [];
	let prNumber: number | undefined;
	let prUrl: string | undefined;
	let issueNumber: number | undefined;

	for (const action of actions) {
		executed.push(action);
		let result: { exitCode: number; stdout: string; stderr: string };
		switch (action) {
			case 'lane_push':
				result = await runRepo(root, repoLanePushArgs(ctx.laneName as string));
				break;
			case 'pr_create':
				result = await runRepo(
					root,
					repoPrCreateArgs({
						title: ctx.title,
						head: ctx.laneName as string,
						base: ctx.prBase,
						body: ctx.body,
					}),
				);
				break;
			case 'issue_create':
				result = await runRepo(
					root,
					repoIssueCreateArgs(ctx.title, ctx.body),
				);
				break;
			case 'issue_close':
				if (ctx.issueNumber === undefined) {
					return {
						ok: false,
						error: 'issue_close requires issueNumber in context',
						executed,
					};
				}
				result = await runRepo(
					root,
					repoIssueUpdateArgs(ctx.issueNumber, { state: 'closed' }),
				);
				break;
			case 'lane_publish':
				result = await runRepo(
					root,
					repoLanePublishArgs(ctx.laneName as string, ctx.prBase),
				);
				break;
			default:
				return { ok: false, error: `unknown action ${action}`, executed };
		}
		if (result.exitCode !== 0) {
			const tail = result.stderr.trim().slice(-500);
			return {
				ok: false,
				error: `repo ${action} failed (exit ${result.exitCode}): ${tail || result.stdout.trim()}`,
				executed,
			};
		}
		const record = parseRepoJsonStdout(result.stdout);
		if (record) {
			if (typeof record.number === 'number') {
				if (action === 'pr_create') prNumber = record.number;
				if (action === 'issue_create') issueNumber = record.number;
			}
			if (typeof record.html_url === 'string') prUrl = record.html_url;
		}
	}

	return { ok: true, executed, prNumber, prUrl, issueNumber };
}

/** Human-facing routing hint for reflection menus (not a shell invocation). */
export function repoIssueCreateRoutingHint(): string {
	return 'repo issue create --title "<title>" [--body "<body>"]';
}

export function repoIssueCloseRoutingHint(issueNumber: number): string {
	return `repo issue update ${issueNumber} --state closed`;
}

export function repoPrCreateRoutingHint(laneName: string, base = 'main'): string {
	return `repo pr create --title "<title>" --head ${laneName} --base ${base}`;
}

/**
 * Engine-root land path: push lane + open PR (or custom automation) instead of
 * git merge-back.
 */
export async function repoFacadeLandLane(
	primaryDir: string,
	branchName: string,
	strategy: MergeStrategy,
	commitMessage?: string,
): Promise<
	| { merged: true; strategy: MergeStrategy; repo: RepoLifecycleRunResult }
	| { error: string }
> {
	const root = findRepoRoot(primaryDir);
	if (!root) {
		return { error: 'repo facade land: not an Engine repository root' };
	}
	const laneName = resolveRepoLaneName(primaryDir, branchName);
	const title =
		(commitMessage?.trim() || branchName).slice(0, 200) ||
		`swarm lane ${laneName ?? branchName}`;
	const lifecycle = await runRepoLifecycle(root, {
		engineRepo: true,
		event: 'land_lane',
		laneName,
		title,
		body: commitMessage,
		prBase: loadPrBase(primaryDir),
	});
	if (!lifecycle.ok) {
		return {
			error: lifecycle.error ?? 'repo lifecycle land_lane failed',
		};
	}
	return {
		merged: true,
		strategy,
		repo: lifecycle,
	};
}
