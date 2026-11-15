import { execFileSync } from 'node:child_process';

const MAX_CHECK_PAGES = 20;
const CHECK_PAGE_SIZE = 50;
const MAX_CHECK_PAGE_SIZE = 100;
// The aggregate GitHub endpoint omits suites beyond this documented limit.
const MAX_CHECK_SUITES = 1_000;
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i;

interface CheckRun {
	id: number;
	headSha: string;
	name: string;
	status: string;
	conclusion: string | null;
}

interface CheckPage {
	totalCount: number;
	checks: CheckRun[];
	hasNext: boolean;
}

export async function collectCheckRuns(
	headSha: string,
	fetchPage: (page: number) => Promise<CheckPage>,
) {
	const checks: CheckRun[] = [];
	const observedIds = new Set<number>();
	let totalCount: number | null = null;
	const incomplete = (reason: string) => ({
		state: 'incomplete' as const,
		checks,
		totalCount,
		reason,
	});
	if (!SHA.test(headSha)) return incomplete('invalid-head');

	for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
		let next: CheckPage;
		try {
			next = await fetchPage(page);
		} catch {
			return incomplete('page-unavailable');
		}
		if (
			!next ||
			!Number.isSafeInteger(next.totalCount) ||
			next.totalCount < 0 ||
			(totalCount !== null && next.totalCount !== totalCount)
		) {
			return incomplete('inconsistent-count');
		}
		totalCount = next.totalCount;
		if (
			!Array.isArray(next.checks) ||
			next.checks.length > MAX_CHECK_PAGE_SIZE ||
			typeof next.hasNext !== 'boolean'
		) {
			return incomplete('invalid-page');
		}
		for (const check of next.checks) {
			if (
				!check ||
				!Number.isSafeInteger(check.id) ||
				check.id < 1 ||
				check.headSha !== headSha ||
				typeof check.name !== 'string' ||
				typeof check.status !== 'string' ||
				(check.conclusion !== null && typeof check.conclusion !== 'string') ||
				observedIds.has(check.id)
			) {
				return incomplete('invalid-check');
			}
			observedIds.add(check.id);
			checks.push(check);
		}
		if (!next.hasNext) {
			return checks.length === totalCount
				? { state: 'complete' as const, checks, totalCount, reason: null }
				: incomplete('inconsistent-count');
		}
		if (next.checks.length === 0 || checks.length >= totalCount)
			return incomplete('invalid-pagination');
	}
	return incomplete('page-limit');
}

interface PullIdentity {
	repository: string;
	number: number;
	headSha: string;
	baseRefName: string;
}

interface PullSnapshot extends PullIdentity {
	state: 'OPEN' | 'CLOSED' | 'MERGED';
	mergeCommitSha: string | null;
}

interface QueueCandidate {
	headSha: string;
	status: string;
	conclusion: string | null;
}

function samePull(expected: PullIdentity, observed: PullIdentity): boolean {
	return (
		SHA.test(expected.headSha) &&
		expected.repository.toLowerCase() === observed.repository.toLowerCase() &&
		expected.number === observed.number &&
		expected.headSha === observed.headSha &&
		expected.baseRefName === observed.baseRefName
	);
}

export async function resolveMergeObservation(
	expected: PullIdentity,
	pr: PullSnapshot,
	candidate: QueueCandidate | null,
	verifyOnBase: (mergeSha: string, baseRefName: string) => Promise<boolean>,
) {
	const observation = { ...expected, candidate };
	const unconfirmed = (reason: string) => ({
		...observation,
		state: 'unconfirmed' as const,
		mergeCommitSha: null,
		reason,
	});
	if (!samePull(expected, pr)) return unconfirmed('pull-identity-changed');
	if (pr.state !== 'MERGED') return unconfirmed('pull-not-merged');
	if (!pr.mergeCommitSha || !SHA.test(pr.mergeCommitSha))
		return unconfirmed('invalid-merge-commit');
	try {
		if (await verifyOnBase(pr.mergeCommitSha, expected.baseRefName)) {
			return {
				...observation,
				state: 'merged' as const,
				mergeCommitSha: pr.mergeCommitSha,
				reason: null,
			};
		}
	} catch {
		return unconfirmed('base-proof-unavailable');
	}
	return unconfirmed('base-proof-unavailable');
}

type ReadCommand = (program: 'gh' | 'git', argv: string[]) => string;

interface ObservationRequest {
	repository: string;
	number: number;
	headSha: string;
	candidateRunId?: number;
}

function positiveInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

export async function observeCi(
	request: ObservationRequest,
	read: ReadCommand,
) {
	const { repository, number, headSha, candidateRunId } = request;
	const repoName = repository.split('/')[1];
	if (
		!REPOSITORY.test(repository) ||
		repoName === '.' ||
		repoName === '..' ||
		!positiveInteger(number) ||
		!SHA.test(headSha) ||
		(candidateRunId !== undefined && !positiveInteger(candidateRunId))
	) {
		throw new Error('invalid observation request');
	}
	const api = (resource: string, projection: string) =>
		JSON.parse(
			read('gh', [
				'api',
				'--hostname',
				'github.com',
				`repos/${repository}/${resource}`,
				'--jq',
				projection,
			]),
		);
	const readPull = (): PullSnapshot => {
		const pr = api(
			`pulls/${number}`,
			'{repository: .base.repo.full_name, number, headSha: .head.sha, baseRefName: .base.ref, state: (if .merged then "MERGED" else (.state | ascii_upcase) end), mergeCommitSha: .merge_commit_sha}',
		) as PullSnapshot;
		if (
			typeof pr.repository !== 'string' ||
			!positiveInteger(pr.number) ||
			!SHA.test(pr.headSha) ||
			typeof pr.baseRefName !== 'string' ||
			!pr.baseRefName ||
			!['OPEN', 'CLOSED', 'MERGED'].includes(pr.state)
		) {
			throw new Error('invalid pull request response');
		}
		return pr;
	};
	const initial = readPull();
	const expected = {
		repository,
		number,
		headSha,
		baseRefName: initial.baseRefName,
	};
	let census: Awaited<ReturnType<typeof collectCheckRuns>> = {
		state: 'incomplete',
		checks: [],
		totalCount: null,
		reason: 'pull-identity-changed',
	};
	if (samePull(expected, initial)) {
		try {
			const suites = api(
				`commits/${headSha}/check-suites?per_page=1`,
				'.total_count',
			) as number;
			if (!Number.isSafeInteger(suites) || suites < 0)
				throw new Error('invalid suite count');
			if (suites > MAX_CHECK_SUITES) {
				census.reason = 'suite-limit';
			} else {
				census = await collectCheckRuns(headSha, async (page) => {
					const result = api(
						`commits/${headSha}/check-runs?per_page=${CHECK_PAGE_SIZE}&page=${page}`,
						'{totalCount: .total_count, checks: [.check_runs[] | {id, headSha: .head_sha, name, status, conclusion}]}',
					) as Omit<CheckPage, 'hasNext'>;
					return {
						...result,
						hasNext: page * CHECK_PAGE_SIZE < result.totalCount,
					};
				});
			}
		} catch {
			census.reason = 'suite-count-unavailable';
		}
	}

	let candidate: QueueCandidate | null = null;
	let candidateReason: string | null = null;
	if (candidateRunId !== undefined && samePull(expected, initial)) {
		try {
			const run = api(
				`actions/runs/${candidateRunId}`,
				'{id, repository: .repository.full_name, event, branch: .head_branch, headSha: .head_sha, status, conclusion}',
			) as QueueCandidate & {
				id: number;
				repository: string;
				event: string;
				branch: string;
			};
			const prefix = `gh-readonly-queue/${expected.baseRefName}/pr-${number}-`;
			if (
				run.id === candidateRunId &&
				run.repository.toLowerCase() === repository.toLowerCase() &&
				run.event === 'merge_group' &&
				run.branch.startsWith(prefix) &&
				SHA.test(run.branch.slice(prefix.length)) &&
				SHA.test(run.headSha) &&
				run.headSha !== headSha &&
				(run.status == null || typeof run.status === 'string') &&
				(run.conclusion == null || typeof run.conclusion === 'string')
			) {
				candidate = {
					headSha: run.headSha,
					status: run.status || 'UNKNOWN',
					conclusion: run.conclusion ?? null,
				};
			} else {
				candidateReason = 'candidate-identity-mismatch';
			}
		} catch {
			candidateReason = 'candidate-unavailable';
		}
	}

	let latest: PullSnapshot;
	try {
		latest = readPull();
	} catch {
		return {
			census: {
				...census,
				state: 'incomplete',
				reason: 'pull-refresh-unavailable',
			},
			merge: {
				...expected,
				candidate,
				state: 'unconfirmed',
				mergeCommitSha: null,
				reason: 'pull-refresh-unavailable',
			},
			candidateRunId: candidateRunId ?? null,
			candidateReason,
		};
	}
	if (!samePull(expected, latest))
		census = {
			...census,
			state: 'incomplete',
			reason: 'pull-identity-changed',
		};
	const merge = await resolveMergeObservation(
		expected,
		latest,
		candidate,
		async (mergeSha, base) => {
			const ref = `refs/heads/${base}`;
			const [tip, advertised] = read('git', [
				'ls-remote',
				'--exit-code',
				`https://github.com/${repository}.git`,
				ref,
			])
				.trim()
				.split('\t');
			if (advertised !== ref || !SHA.test(tip)) return false;
			read('git', [
				'--no-replace-objects',
				'merge-base',
				'--is-ancestor',
				mergeSha,
				tip,
			]);
			return true;
		},
	);
	return {
		census,
		merge,
		candidateRunId: candidateRunId ?? null,
		candidateReason,
	};
}

async function main(args: string[]): Promise<void> {
	const [repository, number, headSha, flag, runId] = args;
	if (
		(args.length !== 3 && (args.length !== 5 || flag !== '--candidate-run')) ||
		!/^\d+$/.test(number) ||
		(runId !== undefined && !/^\d+$/.test(runId))
	) {
		console.error(
			'Usage: bun observe-ci.ts OWNER/REPO PR_NUMBER HEAD_SHA [--candidate-run RUN_ID]',
		);
		process.exitCode = 2;
		return;
	}
	const cwd = process.cwd();
	try {
		const result = await observeCi(
			{
				repository,
				number: Number(number),
				headSha,
				candidateRunId: runId === undefined ? undefined : Number(runId),
			},
			(program, argv) =>
				execFileSync(program, program === 'git' ? ['-C', cwd, ...argv] : argv, {
					cwd,
					timeout: 10_000,
					maxBuffer: 256 * 1024,
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
					windowsHide: true,
					env: {
						...process.env,
						GH_PROMPT_DISABLED: '1',
						GIT_TERMINAL_PROMPT: '0',
						GIT_NO_LAZY_FETCH: '1',
					},
				}),
		);
		console.log(JSON.stringify(result));
	} catch {
		console.error(
			'CI observation unavailable: verify the PR identifier, head SHA, and GitHub read access.',
		);
		process.exitCode = 1;
	}
}

if (import.meta.main) await main(process.argv.slice(2));
