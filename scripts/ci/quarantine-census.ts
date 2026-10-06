#!/usr/bin/env bun
/**
 * Expiry-aware quarantine-ledger census (issue #2905, Workstream I8).
 *
 * Single owner of the quarantine-ledger grammar (the #2477 OWNER/EXPIRY
 * metadata format Check 7 enforces): parsing, aggregate census, the
 * renewal-requires-issue policy, and the 30-day add/retire trend. Consumers:
 * `scripts/check-invariants.ts` Check 7 (census block + wall warning +
 * renewal gate) and `scripts/drift-check.ts` (census block in the PR
 * comment), plus `scripts/ci/quarantine-aging.ts` (weekly tracking issue).
 *
 * Grammar (must stay byte-compatible with the pre-#2905 Check 7 parser):
 *   # OWNER: <owner> — <issue ref / context>
 *   # EXPIRY: YYYY-MM-DD — <retirement criterion>
 * An active entry is a non-blank, non-`#` line; metadata is the contiguous
 * comment block above it (the block walk breaks on blank/non-comment lines).
 * Within a block, the TOPMOST `# OWNER:` and valid `# EXPIRY:` lines win and
 * the LOWEST malformed `# EXPIRY:` line is reported — replicating the
 * upward-walk overwrite order of the original implementation.
 *
 * OWNER value = the `# OWNER:` line's text plus the continuation `#` lines
 * directly below it, stopping at the next keyed line
 * (`# OWNER:` / `# EXPIRY:` / `# Renewed`) or block end. `# Renewed …`
 * provenance lines are never part of the OWNER value, so a renewal anchored
 * only to its own provenance note does not satisfy the renewal policy.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGit } from '../gate-utils';

export const QUARANTINE_EXPIRY_GRACE_DAYS = 14;

/** First hard-fail day is expiry + GRACE + 1 (Check 7 fails on day 15). */
export const QUARANTINE_HARD_FAIL_OFFSET_DAYS = QUARANTINE_EXPIRY_GRACE_DAYS + 1;

export const DEFAULT_QUARANTINE_LEDGERS: readonly string[] = [
	'scripts/ci/quarantined-tests.txt',
	'scripts/ci/quarantined-tests-windows.txt',
	'scripts/ci/quarantined-tests-macos.txt',
	'scripts/ci/quarantined-integration-tests.txt',
];

const OWNER_PATTERN = /^#\s*OWNER:\s*(\S.*)$/;
const EXPIRY_PATTERN = /^#\s*EXPIRY:\s*(\d{4})-(\d{2})-(\d{2})\b/;
const EXPIRY_LOOSE_PATTERN = /^#\s*EXPIRY:\s*(\S.*)$/;
/** Known keyed comment lines: they terminate an OWNER continuation run. */
const KEYED_COMMENT_PATTERN = /^#\s*(OWNER|EXPIRY|Renewed)\b/;
/** Provenance lines are never part of the OWNER value, with or without a colon. */
const RENEWED_PROVENANCE_PATTERN = /^#\s*Renewed\b/;
const ISSUE_REF_PATTERN = /#(\d+)/g;

export interface QuarantineEntry {
	ledger: string;
	/** Repo-relative active entry path line (the entry identity). */
	path: string;
	ownerRaw: string | null;
	/** Leading handle token of the OWNER value (up to whitespace/em-dash). */
	ownerHandle: string | null;
	/** Every `#<digits>` ref in the OWNER value (line + continuations). */
	ownerIssueRefs: string[];
	expiry: string | null;
	expiryMalformed: string | null;
}

export interface QuarantineLedgerContent {
	ledger: string;
	content: string;
}

export interface QuarantineCensus {
	perLedger: { ledger: string; active: number }[];
	totalActive: number;
	/** EXPIRY date -> entry count, ascending by date (parseable EXPIRYs only). */
	histogram: { date: string; count: number }[];
	firstHardFailDate: string | null;
	daysToFirstWall: number | null;
	/** Deduped, sorted owner handles of entries that carry an OWNER line. */
	owners: string[];
	/** Active entries whose OWNER value carries no `#N` reference. */
	unlinkedOwnerEntries: { ledger: string; path: string }[];
	/** Entries with 0 <= daysToExpiry <= 21 ("expire within 21 days"). */
	expiringSoon: {
		ledger: string;
		path: string;
		expiry: string;
		wallDate: string;
		daysToExpiry: number;
		ownerHandle: string | null;
		ownerIssueRefs: string[];
	}[];
	entries: QuarantineEntry[];
}

export type QuarantineTrend =
	| { available: true; added: number; retired: number }
	| { available: false; reason: string };

export interface QuarantineRenewalResult {
	messages: string[];
	violations: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcMidnight(date: Date): number {
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function isoToUtcMs(iso: string): number {
	return Date.UTC(
		Number(iso.slice(0, 4)),
		Number(iso.slice(5, 7)) - 1,
		Number(iso.slice(8, 10)),
	);
}

function utcMsToIso(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

export function parseQuarantineLedger(
	content: string,
	ledger: string,
): QuarantineEntry[] {
	const lines = content.split(/\r?\n/);
	const entries: QuarantineEntry[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined) continue;
		if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
		// Collect the contiguous comment block above the entry (indices
		// blockTop..index-1), then walk it top-down. The original upward walk
		// means the TOPMOST OWNER/EXPIRY match wins and the LOWEST malformed
		// EXPIRY line is captured — replicated here explicitly.
		let blockTop = index;
		while (blockTop > 0) {
			const above = lines[blockTop - 1];
			if (
				above === undefined ||
				above.trim() === '' ||
				!above.trimStart().startsWith('#')
			) {
				break;
			}
			blockTop -= 1;
		}
		let ownerRaw: string | null = null;
		let ownerLineIndex = -1;
		let expiry: string | null = null;
		let expiryMalformed: string | null = null;
		for (let i = blockTop; i < index; i += 1) {
			const blockLine = lines[i];
			if (blockLine === undefined) continue;
			const ownerMatch = blockLine.match(OWNER_PATTERN);
			if (ownerMatch && ownerRaw === null) {
				// The original upward walk overwrites per match, so the TOPMOST
				// OWNER/EXPIRY line wins; top-down, that is first-encounter-wins.
				ownerRaw = ownerMatch[1].trim();
				ownerLineIndex = i;
			}
			const expiryMatch = blockLine.match(EXPIRY_PATTERN);
			if (expiryMatch && expiry === null) {
				expiry = `${expiryMatch[1]}-${expiryMatch[2]}-${expiryMatch[3]}`;
			}
			const expiryLoose = blockLine.match(EXPIRY_LOOSE_PATTERN);
			if (expiryLoose && !EXPIRY_PATTERN.test(blockLine)) {
				// The original upward walk keeps the LOWEST malformed line via
				// its null guard; top-down, that is last-encounter-wins.
				expiryMalformed = expiryLoose[1].trim();
			}
		}
		// OWNER value: the OWNER line's text plus continuation comment lines
		// below it, stopping at the next keyed line or the block end. Renewed
		// provenance lines are excluded entirely.
		const ownerValueParts: string[] = [];
		if (ownerRaw !== null && ownerLineIndex >= 0) {
			ownerValueParts.push(ownerRaw);
			for (let i = ownerLineIndex + 1; i < index; i += 1) {
				const cont = lines[i];
				if (cont === undefined) continue;
				if (KEYED_COMMENT_PATTERN.test(cont)) break;
				if (RENEWED_PROVENANCE_PATTERN.test(cont)) continue;
				ownerValueParts.push(cont.replace(/^\s*#\s?/, ''));
			}
		}
		const ownerValue = ownerValueParts.join(' ');
		const ownerIssueRefs = Array.from(
			ownerValue.matchAll(ISSUE_REF_PATTERN),
			(match) => `#${match[1]}`,
		);
		const ownerHandle =
			ownerRaw === null
				? null
				: (ownerRaw.split(/[\s—-]/)[0] ?? ownerRaw).trim() || ownerRaw.trim();
		entries.push({
			ledger,
			path: line.trim(),
			ownerRaw,
			ownerHandle,
			ownerIssueRefs,
			expiry,
			expiryMalformed,
		});
	}
	return entries;
}

export function buildQuarantineCensus(
	ledgerContents: QuarantineLedgerContent[],
	now: Date,
): QuarantineCensus {
	const perLedger: { ledger: string; active: number }[] = [];
	const entries: QuarantineEntry[] = [];
	for (const { ledger, content } of ledgerContents) {
		const parsed = parseQuarantineLedger(content, ledger);
		entries.push(...parsed);
		perLedger.push({ ledger, active: parsed.length });
	}
	const nowUtc = utcMidnight(now);
	const histogramMap = new Map<string, number>();
	for (const entry of entries) {
		if (entry.expiry === null) continue;
		histogramMap.set(entry.expiry, (histogramMap.get(entry.expiry) ?? 0) + 1);
	}
	const histogram = Array.from(histogramMap.entries())
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.map(([date, count]) => ({ date, count }));
	let firstHardFailDate: string | null = null;
	let daysToFirstWall: number | null = null;
	if (histogram.length > 0 && histogram[0]) {
		const firstExpiry = histogram[0].date;
		const wallUtc = isoToUtcMs(firstExpiry) + QUARANTINE_HARD_FAIL_OFFSET_DAYS * DAY_MS;
		firstHardFailDate = utcMsToIso(wallUtc);
		daysToFirstWall = Math.floor((wallUtc - nowUtc) / DAY_MS);
	}
	const ownerSet = new Set<string>();
	for (const entry of entries) {
		if (entry.ownerHandle !== null) ownerSet.add(entry.ownerHandle);
	}
	const unlinkedOwnerEntries = entries
		.filter((entry) => entry.ownerIssueRefs.length === 0)
		.map((entry) => ({ ledger: entry.ledger, path: entry.path }));
	const expiringSoon = entries
		.filter((entry) => {
			if (entry.expiry === null) return false;
			const daysToExpiry = Math.floor(
				(isoToUtcMs(entry.expiry) - nowUtc) / DAY_MS,
			);
			return daysToExpiry >= 0 && daysToExpiry <= 21;
		})
		.map((entry) => {
			const expiryUtc = isoToUtcMs(entry.expiry as string);
			return {
				ledger: entry.ledger,
				path: entry.path,
				expiry: entry.expiry as string,
				wallDate: utcMsToIso(expiryUtc + QUARANTINE_HARD_FAIL_OFFSET_DAYS * DAY_MS),
				daysToExpiry: Math.floor((expiryUtc - nowUtc) / DAY_MS),
				ownerHandle: entry.ownerHandle,
				ownerIssueRefs: entry.ownerIssueRefs,
			};
		});
	return {
		perLedger,
		totalActive: entries.length,
		histogram,
		firstHardFailDate,
		daysToFirstWall,
		owners: Array.from(ownerSet).sort(),
		unlinkedOwnerEntries,
		expiringSoon,
		entries,
	};
}

/**
 * The one census block rendered by the census CLI, Check 7, the drift PR
 * comment, and the aging issue body. Deterministic: ledgers in
 * DEFAULT_QUARANTINE_LEDGERS order, histogram ascending, and a fixed
 * fail-open trend line when no trend is supplied.
 */
export function formatQuarantineCensus(
	census: QuarantineCensus,
	trend: QuarantineTrend | null = null,
): string[] {
	const lines: string[] = ['Quarantine census'];
	for (const { ledger, active } of census.perLedger) {
		lines.push(`ledger ${ledger}: ${active} active`);
	}
	lines.push(`total active: ${census.totalActive}`);
	for (const { date, count } of census.histogram) {
		lines.push(`histogram ${date}: ${count}`);
	}
	lines.push(`first hard-fail date: ${census.firstHardFailDate ?? 'none'}`);
	lines.push(`days-to-first-wall: ${
		census.daysToFirstWall === null ? 'n/a' : census.daysToFirstWall
	}`);
	lines.push(`owners: ${census.owners.length > 0 ? census.owners.join(', ') : 'none'}`);
	for (const { path } of census.unlinkedOwnerEntries) {
		lines.push(`owner missing issue ref: ${path}`);
	}
	lines.push(
		trend && trend.available
			? `trend: +${trend.added}/-${trend.retired} over 30d`
			: `trend: unavailable (${
					trend && trend.reason ? trend.reason : 'ledger history not readable'
				})`,
	);
	return lines;
}

/**
 * Renewal-requires-issue policy (issue #2905 AC3). Entry identity is the
 * active path line, GLOBAL across the four ledgers: a path moved between
 * ledgers with a later EXPIRY is still a renewal. Enforced findings print
 * ERROR lines and count; soft-warn findings print WARNING lines and do not.
 */
export function checkQuarantineRenewal(options: {
	headLedgerContents: QuarantineLedgerContent[];
	baseLedgerContents: QuarantineLedgerContent[];
	enforce: boolean;
}): QuarantineRenewalResult {
	const headByPath = new Map<string, QuarantineEntry[]>();
	for (const { ledger, content } of options.headLedgerContents) {
		for (const entry of parseQuarantineLedger(content, ledger)) {
			const list = headByPath.get(entry.path) ?? [];
			list.push(entry);
			headByPath.set(entry.path, list);
		}
	}
	const baseByPath = new Map<string, QuarantineEntry[]>();
	for (const { ledger, content } of options.baseLedgerContents) {
		for (const entry of parseQuarantineLedger(content, ledger)) {
			const list = baseByPath.get(entry.path) ?? [];
			list.push(entry);
			baseByPath.set(entry.path, list);
		}
	}
	const messages: string[] = [];
	let violations = 0;
	for (const [entryPath, headEntries] of headByPath) {
		const baseEntries = baseByPath.get(entryPath);
		if (!baseEntries || baseEntries.length === 0) continue; // new quarantine
		// The path's baseline is its LATEST base expiry: taking the maximum
		// keeps a duplicated path in another ledger from shadowing a real
		// renewal, while a non-renewed duplicate compares equal (no violation).
		const baseExpiry = baseEntries
			.map((entry) => entry.expiry)
			.filter((expiry): expiry is string => expiry !== null)
			.sort()
			.at(-1);
		if (baseExpiry === undefined) continue;
		for (const headEntry of headEntries) {
			if (headEntry.expiry === null) continue;
			if (!(headEntry.expiry > baseExpiry)) continue;
			if (headEntry.ownerIssueRefs.length > 0) continue;
			const moved = headEntry.ledger !== baseEntries[0].ledger;
			const wasText = moved
				? `${baseExpiry}, previously quarantined in ${baseEntries[0].ledger}`
				: baseExpiry;
			const detail = `entry '${entryPath}' renewed EXPIRY ${headEntry.expiry} (was ${wasText}) without an OWNER issue reference — link an open tracking issue (e.g. #2973) or revert the renewal.`;
			if (options.enforce) {
				messages.push(`ERROR: ${headEntry.ledger} ${detail}`);
				violations += 1;
			} else {
				messages.push(
					`WARNING: ${headEntry.ledger} ${detail} (QUARANTINE_RENEWAL_ENFORCE is off — soft-warn, non-blocking.)`,
				);
			}
		}
	}
	return { messages, violations };
}

async function runGitFailOpen(args: string[], cwd: string) {
	try {
		return await runGit(args, cwd, 30_000);
	} catch {
		return { exitCode: 1, stdout: '', stderr: '' };
	}
}

export const _internals = {
	runGit: runGitFailOpen,
	collectTrendGitLog: async (
		root: string,
		sinceIso: string,
	): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
		// Routed through _internals so tests can capture the argv (PRR-029).
		_internals.runGit(
			[
				'log',
				`--since=${sinceIso}`,
				'--max-count=200',
				'-p',
				'--unified=0',
				'--',
				...DEFAULT_QUARANTINE_LEDGERS,
			],
			root,
		),
};

function isActiveEntryDiffLine(rawLine: string): boolean {
	const body = rawLine.slice(1);
	return body.trim() !== '' && !body.trimStart().startsWith('#');
}

/** 30-day add/retire trend over active ledger-entry lines. Fail-open. */
export async function collectAddRetireTrend(
	repoRoot: string,
	now: Date = new Date(),
	days = 30,
): Promise<QuarantineTrend> {
	const sinceIso = utcMsToIso(utcMidnight(now) - days * DAY_MS);
	const result = await _internals.collectTrendGitLog(repoRoot, sinceIso);
	if (result.exitCode !== 0) {
		return {
			available: false,
			reason: 'git log over the quarantine ledgers failed',
		};
	}
	let added = 0;
	let retired = 0;
	for (const line of result.stdout.split('\n')) {
		if (line.startsWith('+') && !line.startsWith('+++')) {
			if (isActiveEntryDiffLine(line)) added += 1;
		} else if (line.startsWith('-') && !line.startsWith('---')) {
			if (isActiveEntryDiffLine(line)) retired += 1;
		}
	}
	return { available: true, added, retired };
}

export function resolveRenewalEnforce(raw: string | undefined): boolean {
	if (raw === undefined) return true;
	switch (raw.toLowerCase()) {
		case '0':
		case 'false':
		case 'no':
		case 'off':
			return false;
		default:
			return true;
	}
}

export function readLedgerContents(
	repoRoot: string,
	ledgers: readonly string[] = DEFAULT_QUARANTINE_LEDGERS,
): QuarantineLedgerContent[] {
	const contents: QuarantineLedgerContent[] = [];
	for (const ledger of ledgers) {
		const full = path.join(repoRoot, ledger);
		let content = '# ledger missing\n';
		if (fs.existsSync(full)) {
			// Fail-open on unreadable files (permissions, EISDIR, ...): census
			// consumers must see a parseable empty ledger, never a throw that
			// fails an advisory run.
			try {
				content = fs.readFileSync(full, 'utf8');
			} catch {
				content = '# ledger missing\n';
			}
		}
		contents.push({ ledger, content });
	}
	return contents;
}

function parseArgs(argv: string[]) {
	const options = {
		root: process.cwd(),
		now: null as string | null,
		baselineRoot: null as string | null,
		checkRenewal: false,
		json: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--root' && argv[i + 1]) {
			options.root = path.resolve(argv[i + 1] as string);
			i += 1;
		} else if (arg === '--now' && argv[i + 1]) {
			options.now = argv[i + 1] as string;
			i += 1;
		} else if (arg === '--baseline-root' && argv[i + 1]) {
			options.baselineRoot = path.resolve(argv[i + 1] as string);
			i += 1;
		} else if (arg === '--check-renewal') {
			options.checkRenewal = true;
		} else if (arg === '--json') {
			options.json = true;
		}
	}
	return options;
}

async function main(argv: string[]): Promise<number> {
	const options = parseArgs(argv);
	if (
		options.now !== null &&
		Number.isNaN(new Date(`${options.now}T00:00:00.000Z`).getTime())
	) {
		console.error(
			`invalid --now '${options.now}' (expected YYYY-MM-DD); refusing to run.`,
		);
		return 2;
	}
	const now = options.now
		? new Date(`${options.now}T00:00:00.000Z`)
		: new Date();
	const ledgerContents = readLedgerContents(options.root);
	const census = buildQuarantineCensus(ledgerContents, now);
	const trend = await collectAddRetireTrend(options.root, now);
	let renewal: QuarantineRenewalResult | null = null;
	if (options.checkRenewal) {
		if (!options.baselineRoot) {
			console.error('--check-renewal requires --baseline-root');
			return 2;
		}
		renewal = checkQuarantineRenewal({
			headLedgerContents: ledgerContents,
			baseLedgerContents: readLedgerContents(options.baselineRoot),
			enforce: resolveRenewalEnforce(process.env.QUARANTINE_RENEWAL_ENFORCE),
		});
	}
	if (options.json) {
		console.log(JSON.stringify({ census, trend, renewal }, null, 2));
	} else {
		for (const line of formatQuarantineCensus(census, trend)) {
			console.log(line);
		}
		if (renewal) {
			for (const line of renewal.messages) {
				console.log(line);
			}
		}
	}
	if (renewal && renewal.violations > 0) {
		console.error(
			`${renewal.violations} quarantine renewal violation(s) found.`,
		);
		return 1;
	}
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
