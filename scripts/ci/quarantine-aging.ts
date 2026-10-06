#!/usr/bin/env bun
/**
 * Quarantine aging tracker (issue #2905, Workstream I8).
 *
 * Weekly routing for the expiry-aware quarantine census: computes how many
 * active ledger entries expire within 21 days and maintains exactly ONE
 * deduplicated tracking issue titled
 *   `Quarantine aging: <n> entries expire within 21 days`
 * — adopted only when bot-authored (a human- or third-party-titled issue is
 * never absorbed; host-contract routeDrift precedent). Bot identity is
 * matched structurally (`author.is_bot`) or against the known Actions bot
 * logins, because the gh CLI renders the Actions app actor as
 * `app/github-actions` while older surfaces used `github-actions[bot]`
 * (observed on this repo's own GITHUB_TOKEN-created issues #3055/#3056).
 * n=0 closes every adopted tracking issue, and is refused when any ledger
 * file is missing (an unreadable tree must not close the tracker).
 * `--dry-run` makes NO network calls; the only nonzero exits are usage
 * errors (exit 2).
 *
 * gh failures are ::warning:: lines that never fail the run (flake-detector
 * precedent): the aging view is advisory. Warning text is annotation-escaped.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
	DEFAULT_QUARANTINE_LEDGERS,
	type QuarantineCensus,
	type QuarantineTrend,
	buildQuarantineCensus,
	collectAddRetireTrend,
	formatQuarantineCensus,
	readLedgerContents,
} from './quarantine-census';

export const TRACKING_TITLE_PREFIX = 'Quarantine aging:';

/** Logins the Actions bot has used across gh/API renderings. */
const KNOWN_BOT_LOGINS = new Set(['github-actions[bot]', 'app/github-actions']);
const MAX_ANCHOR_LOOKUPS = 20;
const GH_TIMEOUT_MS = 30_000;

export interface ExistingIssue {
	number: number;
	title: string;
	author?: { login?: string; is_bot?: boolean };
}

export type AgingAction = 'open' | 'update' | 'close';

export interface AgingDecision {
	action: AgingAction;
	title: string;
	adopted: ExistingIssue[];
	n: number;
}

/**
 * Bot-authored detection that survives gh's actor-login rendering (the gh
 * CLI prefixes GitHub-app actors with `app/`; classic Actions content used
 * the `github-actions[bot]` login). Structural `is_bot` wins when present.
 */
export function isBotAuthored(issue: ExistingIssue): boolean {
	if (issue.author?.is_bot === true) return true;
	const login = issue.author?.login;
	return typeof login === 'string' && KNOWN_BOT_LOGINS.has(login);
}

/** GitHub annotation text: %, CR and LF must be percent-encoded. */
export function escapeAnnotation(text: string): string {
	return text
		.replace(/%/g, '%25')
		.replace(/\r/g, '%0D')
		.replace(/\n/g, '%0A');
}

function resolveRepo(): string {
	const env = process.env.GH_REPO && process.env.GH_REPO.trim() !== ''
		? process.env.GH_REPO.trim()
		: 'ZaxbyHub/opencode-swarm';
	return env;
}

/** Markdown table cell: pipes must be escaped or they break the column. */
function cell(text: string): string {
	return text.replace(/\|/g, '\\|');
}

/** Pure decision core — no IO, unit-testable. */
export function decideAgingAction(
	census: QuarantineCensus,
	existingOpenIssues: ExistingIssue[],
): AgingDecision {
	const n = census.expiringSoon.length;
	const title = `${TRACKING_TITLE_PREFIX} ${n} entries expire within 21 days`;
	const adopted = existingOpenIssues.filter(
		(issue) =>
			issue.title.startsWith(TRACKING_TITLE_PREFIX) && isBotAuthored(issue),
	);
	let action: AgingAction;
	if (n > 0) {
		action = adopted.length > 0 ? 'update' : 'open';
	} else {
		action = 'close';
	}
	return { action, title, adopted, n };
}

export function renderAgingBody(
	census: QuarantineCensus,
	trend: QuarantineTrend,
	anchorStates: Map<string, string>,
): string {
	const lines: string[] = [];
	lines.push(
		`Weekly quarantine-aging view (issue #2905). Entries whose EXPIRY lands within 21 days:`,
		'',
		...formatQuarantineCensus(census, trend),
		'',
		'## Entries entering their last 21 days',
		'',
	);
	if (census.expiringSoon.length === 0) {
		lines.push('None this week.');
	} else {
		lines.push('| Entry | Ledger | EXPIRY | Hard-fail wall | Owner | Anchor issues |');
		lines.push('|---|---|---|---|---|---|');
		for (const entry of census.expiringSoon) {
			const anchors =
				entry.ownerIssueRefs.length > 0
					? entry.ownerIssueRefs
							.map(
								(ref) =>
									`${ref} (${anchorStates.get(ref) ?? 'state unknown'})`,
							)
							.join(', ')
					: 'none';
			lines.push(
				`| ${cell(entry.path)} | ${cell(entry.ledger)} | ${entry.expiry} | ${entry.wallDate} | ${cell(entry.ownerHandle ?? 'none')} | ${anchors} |`,
			);
		}
	}
	lines.push(
		'',
		'Tracking: renewal cohort #2973 · census/aging workstream #2905 · renewal policy requires an OWNER issue reference on any later-dated EXPIRY.',
	);
	return lines.join('\n');
}

interface GhResult {
	ok: boolean;
	stdout: string;
	error?: string;
}

/** Bounded, fail-open gh invocation (array form, timeout, bounded output). */
function runGh(args: string[]): GhResult {
	try {
		const result = spawnSync('gh', args, {
			cwd: process.cwd(),
			timeout: GH_TIMEOUT_MS,
			encoding: 'utf8',
			maxBuffer: 4 * 1024 * 1024,
			env: process.env,
			stdin: 'ignore',
		});
		if (result.error) {
			return { ok: false, stdout: '', error: String(result.error) };
		}
		if (result.status !== 0) {
			return {
				ok: false,
				stdout: result.stdout ?? '',
				error: `gh exit ${result.status}: ${(result.stderr ?? '').slice(0, 200)}`,
			};
		}
		return { ok: true, stdout: result.stdout ?? '' };
	} catch (error) {
		return { ok: false, stdout: '', error: String(error) };
	}
}

export const _internals = {
	runGh,
	isBotAuthored,
};

export async function lookupAnchorStates(refs: string[]): Promise<Map<string, string>> {
	const states = new Map<string, string>();
	const repo = resolveRepo();
	for (const ref of refs.slice(0, MAX_ANCHOR_LOOKUPS)) {
		const res = _internals.runGh([
			'issue',
			'view',
			ref.replace('#', ''),
			'--repo',
			repo,
			'--json',
			'state',
		]);
		if (!res.ok) {
			console.log(
				`::warning::quarantine-aging: anchor state lookup failed for ${ref}: ${escapeAnnotation(res.error ?? 'unknown error')}`,
			);
			continue;
		}
		try {
			const parsed = JSON.parse(res.stdout) as { state?: string };
			if (typeof parsed.state === 'string') states.set(ref, parsed.state);
		} catch {
			console.log(
				`::warning::quarantine-aging: anchor state lookup for ${ref} returned unparseable output.`,
			);
		}
	}
	return states;
}

export function routeDecision(
	decision: AgingDecision,
	body: string,
	repo: string = resolveRepo(),
): void {
	if (decision.action === 'open') {
		const res = _internals.runGh([
			'issue',
			'create',
			'--repo',
			repo,
			'--title',
			decision.title,
			'--body',
			body,
			'--label',
			'area:ci',
		]);
		console.log(
			res.ok
				? 'quarantine-aging: opened tracking issue'
				: `::warning::quarantine-aging: gh issue create failed: ${escapeAnnotation(res.error ?? 'unknown error')} (run unaffected)`,
		);
		return;
	}
	if (decision.action === 'update') {
		const primary = decision.adopted[0];
		if (!primary) return;
		const comment = _internals.runGh([
			'issue',
			'comment',
			String(primary.number),
			'--repo',
			repo,
			'--body',
			body,
		]);
		if (!comment.ok) {
			console.log(
				`::warning::quarantine-aging: gh issue comment failed: ${escapeAnnotation(comment.error ?? 'unknown error')}`,
			);
		}
		if (primary.title !== decision.title) {
			const retitle = _internals.runGh([
				'issue',
				'edit',
				String(primary.number),
				'--repo',
				repo,
				'--title',
				decision.title,
			]);
			if (!retitle.ok) {
				console.log(
					`::warning::quarantine-aging: gh issue edit (retitle) failed: ${escapeAnnotation(retitle.error ?? 'unknown error')}`,
				);
			}
		}
		// Close duplicate adopted tracking issues — exactly one stays open.
		for (const duplicate of decision.adopted.slice(1)) {
			const closeRes = _internals.runGh([
				'issue',
				'close',
				String(duplicate.number),
				'--repo',
				repo,
				'--comment',
				`Closing duplicate quarantine-aging tracking issue; #${primary.number} is the live one (issue #2905).`,
			]);
			if (!closeRes.ok) {
				console.log(
					`::warning::quarantine-aging: duplicate close failed for #${duplicate.number}: ${escapeAnnotation(closeRes.error ?? 'unknown error')}`,
				);
			}
		}
		return;
	}
	// action === 'close': n=0 — close every adopted tracking issue.
	for (const adoptedIssue of decision.adopted) {
		const closeRes = _internals.runGh([
			'issue',
			'close',
			String(adoptedIssue.number),
			'--repo',
			repo,
			'--comment',
			'Quarantine census: 0 entries expire within 21 days — closing the aging tracking issue (issue #2905).',
		]);
		console.log(
			closeRes.ok
				? `quarantine-aging: closed tracking issue #${adoptedIssue.number} (0 entries within 21 days)`
				: `::warning::quarantine-aging: gh issue close failed for #${adoptedIssue.number}: ${escapeAnnotation(closeRes.error ?? 'unknown error')}`,
		);
	}
}

/** Ledgers that are absent OR unreadable at `root` (a close decision on a
 * tree the census cannot fully read would silently retire the tracker, so
 * callers must refuse — an existsSync-only check misses the existing-but-
 * unreadable case, reviewer round on the feedback fixes). */
export function missingLedgers(root: string): string[] {
	return DEFAULT_QUARANTINE_LEDGERS.filter((ledger) => {
		const full = path.join(root, ...ledger.split('/'));
		if (!fs.existsSync(full)) return true;
		try {
			fs.readFileSync(full);
			return false;
		} catch {
			return true;
		}
	});
}

function parseArgs(argv: string[]) {
	const options = { root: process.cwd(), now: null as string | null, dryRun: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--root' && argv[i + 1]) {
			options.root = path.resolve(argv[i + 1] as string);
			i += 1;
		} else if (arg === '--now' && argv[i + 1]) {
			options.now = argv[i + 1] as string;
			i += 1;
		} else if (arg === '--dry-run') {
			options.dryRun = true;
		}
	}
	return options;
}

export async function main(argv: string[]): Promise<number> {
	const options = parseArgs(argv);
	if (
		options.now !== null &&
		Number.isNaN(new Date(`${options.now}T00:00:00.000Z`).getTime())
	) {
		console.error(
			`quarantine-aging: invalid --now '${options.now}' (expected YYYY-MM-DD); refusing to run.`,
		);
		return 2;
	}
	const now = options.now
		? new Date(`${options.now}T00:00:00.000Z`)
		: new Date();
	const census = buildQuarantineCensus(readLedgerContents(options.root), now);
	const trend = await collectAddRetireTrend(options.root, now);
	if (options.dryRun) {
		console.log('quarantine-aging dry-run (no GitHub calls)');
		console.log(`aging: n=${census.expiringSoon.length}`);
		// Dry-run cannot list issues (no network), so the decision is computed
		// against an empty adoption set through the SAME routing core the real
		// mode uses — ONE decision source for both paths; n=0 maps to `close`
		// (a no-op when nothing is adopted).
		const decision = decideAgingAction(census, []);
		console.log(`decision: ${decision.action}`);
		console.log(`title: ${decision.title}`);
		for (const line of formatQuarantineCensus(census, trend)) {
			console.log(line);
		}
		return 0;
	}
	const repo = resolveRepo();
	const list = _internals.runGh([
		'issue',
		'list',
		'--repo',
		repo,
		'--state',
		'open',
		'--json',
		'number,title,author',
		'--limit',
		'500',
	]);
	let existing: ExistingIssue[] = [];
	if (list.ok) {
		try {
			const parsed: unknown = JSON.parse(list.stdout);
			if (!Array.isArray(parsed)) {
				console.log(
					'::warning::quarantine-aging: gh issue list returned non-array output (no routing this run)',
				);
				return 0;
			}
			existing = parsed as ExistingIssue[];
		} catch (error) {
			console.log(
				`::warning::quarantine-aging: gh issue list output unparseable: ${escapeAnnotation(String(error))} (no routing this run)`,
			);
			return 0;
		}
	} else {
		console.log(
			`::warning::quarantine-aging: gh issue list failed: ${escapeAnnotation(list.error ?? 'unknown error')} (no routing this run)`,
		);
		return 0;
	}
	const decision = decideAgingAction(census, existing);
	// Canary for silent-dedup failure: an open, same-titled issue that the
	// author filter did NOT adopt means the tracker will duplicate — say so.
	if (
		decision.action === 'open' &&
		decision.n > 0 &&
		existing.some(
			(issue) =>
				issue.title.startsWith(TRACKING_TITLE_PREFIX) &&
				!decision.adopted.includes(issue),
		)
	) {
		const skipped = existing
			.filter(
				(issue) =>
					issue.title.startsWith(TRACKING_TITLE_PREFIX) &&
					!decision.adopted.includes(issue),
			)
			.map((issue) => `#${issue.number} (${issue.author?.login ?? 'unknown author'})`)
			.join(', ');
		console.log(
			`::warning::quarantine-aging: existing 'Quarantine aging:'-titled issue(s) not adopted: ${escapeAnnotation(skipped)} — opening would duplicate; check the bot-author filter`,
		);
	}
	const anchorRefs = Array.from(
		new Set(census.expiringSoon.flatMap((entry) => entry.ownerIssueRefs)),
	);
	if (anchorRefs.length > MAX_ANCHOR_LOOKUPS) {
		console.log(
			`::warning::quarantine-aging: ${anchorRefs.length - MAX_ANCHOR_LOOKUPS} anchor refs beyond the first ${MAX_ANCHOR_LOOKUPS} were not looked up (capped)`,
		);
	}
	const anchorStates = await lookupAnchorStates(anchorRefs);
	const body = renderAgingBody(census, trend, anchorStates);
	if (decision.action === 'close' && missingLedgers(options.root).length > 0) {
		console.log(
			`::warning::quarantine-aging: ledger file(s) missing under ${options.root} — census may be blind; refusing to close tracking issue(s) this run`,
		);
		return 0;
	}
	console.log(`aging: n=${decision.n}`);
	console.log(`decision: ${decision.action}`);
	routeDecision(decision, body, repo);
	return 0;
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const isDirectRun =
	typeof process.argv[1] === 'string' &&
	path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH);

if (isDirectRun) {
	void main(process.argv.slice(2))
		.then((exitCode) => {
			process.exit(exitCode);
		})
		.catch((error) => {
			throw error;
		});
}
