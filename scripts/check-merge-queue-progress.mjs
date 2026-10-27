#!/usr/bin/env node
/**
 * Merge-queue entry progress detector (issue #3265).
 *
 * A queue entry can be accepted by GitHub (`added_to_merge_queue` /
 * `auto_merge_enabled` on the issue timeline) yet never scheduled — the PR
 * shows green checks and an armed auto-merge while the queue silently never
 * builds it. This tool turns the field-tested detection model into one
 * verdict line:
 *
 *   node scripts/check-merge-queue-progress.mjs --pr <n> [--threshold <minutes>]
 *
 * Detection authority (recorded on #3265 from the 2026-10 field evidence):
 * - the LAST issue-timeline event matching /queue|auto_merge/ is the entry
 *   state (the entry stays continuously in-queue even while
 *   autoMergeRequest flickers null);
 * - a >=100-run `gh run list` window filtered on the
 *   `gh-readonly-queue/main/pr-<n>-` head-branch prefix is the active-build
 *   oracle — a smaller window false-positives when branch-CI churn pushes
 *   group runs out of view;
 * - `removed_from_merge_queue` fires for merges, evictions AND closes, so the
 *   PR state must be cross-checked before any action is suggested — a MERGED
 *   PR consumed its entry legitimately;
 * - the `reviewDecision` rollup reads EMPTY even with live approvals; the
 *   reviews API is authoritative (protocol doc, not fetched here).
 *
 * ORPHANED requires ALL of: the last queue event is `added_to_merge_queue`
 * or `auto_merge_enabled`, its age exceeds the threshold (default 150
 * minutes), and ZERO queue builds are in progress. Any in-progress queue
 * build wins (`BUILDING`) — force-cycling over an active build is strictly
 * worse than waiting, and ghost-concurrency zombies hold the workflow's
 * concurrency group, so recovery must cancel only runs that PREDATE the
 * current entry, never blanket-cancel.
 */

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const QUEUE_EVENT_PATTERN = /queue|auto_merge/;
/** Exit code reserved for the actionable verdict (issue #3265 design). */
const ORPHANED_EXIT_CODE = 2;
const GH_TIMEOUT_MS = 60_000;
const GH_MAX_BUFFER = 16 * 1024 * 1024;
const RUN_LIST_WINDOW = 100;

/**
 * @typedef {Object} QueueTimelineEvent
 * @property {string} event
 * @property {string} [created_at]
 *
 * @typedef {Object} QueueRunRef
 * @property {string} [headBranch]
 * @property {string} status
 *
 * @typedef {Object} ClassifyOptions
 * @property {number} now epoch milliseconds
 * @property {number} [thresholdMinutes]
 * @property {number} pr
 */

/**
 * Pure classifier for a merge-queue entry's progress.
 *
 * @param {QueueTimelineEvent[]} timelineEvents issue-timeline payload
 * @param {QueueRunRef[]} runs `gh run list --limit 100` payload
 * @param {ClassifyOptions} options
 * @returns {{ verdict: 'ORPHANED'|'BUILDING'|'IDLE'|'UNKNOWN', ageMinutes: number|null, lastEvent: string|null }}
 */
export function classify(timelineEvents, runs, options) {
	const thresholdMinutes = options.thresholdMinutes ?? 150;
	const queueEvents = (Array.isArray(timelineEvents) ? timelineEvents : []).filter(
		(e) => e && typeof e.event === 'string' && QUEUE_EVENT_PATTERN.test(e.event),
	);
	if (queueEvents.length === 0) {
		return { verdict: 'UNKNOWN', ageMinutes: null, lastEvent: null };
	}
	// Timeline payloads arrive oldest-first; still sort defensively so the
	// "last" event is the newest one regardless of page assembly order.
	queueEvents.sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
	const last = queueEvents[queueEvents.length - 1];
	const createdAt = Date.parse(String(last.created_at ?? ''));
	const ageMinutes =
		Number.isFinite(createdAt) && Number.isFinite(options.now)
			? Math.max(0, Math.floor((options.now - createdAt) / 60000))
			: 0;
	const prefix = `gh-readonly-queue/main/pr-${options.pr}-`;
	const activeBuild = (Array.isArray(runs) ? runs : []).some(
		(run) =>
			run &&
			run.status === 'in_progress' &&
			typeof run.headBranch === 'string' &&
			run.headBranch.startsWith(prefix),
	);
	if (activeBuild) return { verdict: 'BUILDING', ageMinutes, lastEvent: last.event };
	if (
		(last.event === 'added_to_merge_queue' || last.event === 'auto_merge_enabled') &&
		ageMinutes > thresholdMinutes
	) {
		return { verdict: 'ORPHANED', ageMinutes, lastEvent: last.event };
	}
	if (last.event === 'added_to_merge_queue' || last.event === 'auto_merge_enabled') {
		return { verdict: 'IDLE', ageMinutes, lastEvent: last.event };
	}
	// removed_from_merge_queue (and any future queue event): the entry was
	// consumed — merge, eviction, or close. Never recommend the power-cycle
	// from timeline shape alone; the CLI cross-checks PR state.
	return { verdict: 'UNKNOWN', ageMinutes, lastEvent: last.event };
}

/** @param {string} verdict */
export function exitCodeFor(verdict) {
	return verdict === 'ORPHANED' ? ORPHANED_EXIT_CODE : 0;
}

/** @typedef {{ ghJson: (args: string[]) => any, log: (line: string) => void, err: (line: string) => void, now?: () => number }} CliIo */

const USAGE = 'usage: check-merge-queue-progress.mjs --pr <n> [--threshold <minutes>]';

/**
 * Injectable CLI. Returns the process exit code; performs no I/O of its own.
 *
 * @param {string[]} argv
 * @param {CliIo} io
 * @returns {number}
 */
export function runCli(argv, io) {
	let pr = 0;
	let threshold;
	const rest = [...(Array.isArray(argv) ? argv : [])];
	while (rest.length > 0) {
		const arg = rest.shift();
		if (arg === '--pr') {
			pr = Number.parseInt(String(rest.shift() ?? ''), 10);
		} else if (arg === '--threshold') {
			threshold = Number.parseInt(String(rest.shift() ?? ''), 10);
		} else {
			io.err(USAGE);
			return 1;
		}
	}
	if (!Number.isInteger(pr) || pr <= 0 || (threshold !== undefined && (!Number.isInteger(threshold) || threshold <= 0))) {
		io.err(USAGE);
		return 1;
	}

	/** @type {any} */
	let repo;
	/** @type {any} */
	let timeline;
	/** @type {any} */
	let runList;
	/** @type {any} */
	let prState;
	try {
		repo = io.ghJson(['repo', 'view', '--json', 'nameWithOwner']);
		// --slurp wraps each --paginate page in an outer array ([[...p1],[...p2]]);
		// a bare JSON.parse of un-slurped multi-page output would throw.
		timeline = io.ghJson([
			'api',
			'--paginate',
			'--slurp',
			`repos/${repo?.nameWithOwner}/issues/${pr}/timeline`,
		]);
		runList = io.ghJson(['run', 'list', '--limit', String(RUN_LIST_WINDOW), '--json', 'headBranch,status']);
		prState = io.ghJson(['pr', 'view', String(pr), '--json', 'state']);
	} catch (error) {
		io.err(`gh call failed: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}

	if (!Array.isArray(timeline)) {
		io.err('timeline payload was not a slurped array; refusing to classify on partial data');
		return 1;
	}
	const events = timeline.flat();
	const runs = Array.isArray(runList) ? runList : [];
	const state = typeof prState?.state === 'string' ? prState.state : 'UNKNOWN';

	const result = classify(events, runs, {
		now: typeof io.now === 'function' ? io.now() : Date.now(),
		thresholdMinutes: threshold,
		pr,
	});
	io.log(`${result.verdict} pr=${pr} age=${result.ageMinutes ?? 'unknown'} state=${state}`);
	if (result.verdict === 'ORPHANED') {
		io.log(
			`recovery: gh pr close ${pr} --comment "orphaned queue entry" && gh pr reopen ${pr} && gh pr merge ${pr}`,
		);
		io.log(
			'caution: cancel only runs that PREDATE the current entry — blanket-cancelling non-completed runs is harmful',
		);
	} else if (result.verdict === 'UNKNOWN' && result.lastEvent === 'removed_from_merge_queue') {
		if (state === 'MERGED') {
			io.log('entry consumed by merge; nothing to do');
		} else {
			io.log(
				'entry was removed (eviction or close). If checks are green and the PR is OPEN, recovery is a plain re-enqueue (gh pr merge --auto); verify the check rollup manually — this tool does not fetch it',
			);
		}
	}
	return exitCodeFor(result.verdict);
}

/**
 * Wires the real bounded `gh` adapter (array-form argv, explicit cwd, ignored
 * stdin, bounded buffer, timeout) and propagates runCli's exit code.
 *
 * @param {Partial<CliIo>} [io]
 * @param {string[]} [argv]
 */
export function main(io = {}, argv = process.argv.slice(2)) {
	const cwd = process.cwd();
	/** @param {string[]} args */
	const ghJson = (args) =>
		JSON.parse(
			execFileSync('gh', args, {
				cwd,
				encoding: 'utf8',
				maxBuffer: GH_MAX_BUFFER,
				timeout: GH_TIMEOUT_MS,
				stdio: ['ignore', 'pipe', 'pipe'],
			}),
		);
	const wired = {
		ghJson: io.ghJson ?? ghJson,
		log: io.log ?? ((line) => console.log(line)),
		err: io.err ?? ((line) => console.error(line)),
	};
	process.exitCode = runCli(argv, wired);
}

/**
 * Entry-URL comparison used by the Node fallback of `invokedAsMain`.
 * Exported for the entry-guard contract test (under Bun the boolean
 * `import.meta.main` branch decides and this helper never runs in-process).
 * @param {string} entry process.argv[1] as given
 * @param {string} moduleUrl the module's own import.meta.url
 */
export function entryMatchesModuleUrl(entry, moduleUrl) {
	const entryUrl = pathToFileURL(path.resolve(entry)).href;
	return process.platform === 'win32'
		? moduleUrl.toLowerCase() === entryUrl.toLowerCase()
		: moduleUrl === entryUrl;
}

/**
 * Main-entry guard: works under Bun (`import.meta.main` boolean) and Node
 * 22.13+ (entry-URL comparison; `import.meta.main` is undefined before Node
 * 22.18 — pattern adopted from scripts/repro-2910-v2-host.mjs).
 */
export function invokedAsMain() {
	if (typeof import.meta.main === 'boolean') return import.meta.main;
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return entryMatchesModuleUrl(entry, import.meta.url);
	} catch {
		return false;
	}
}

if (invokedAsMain()) {
	main();
}
