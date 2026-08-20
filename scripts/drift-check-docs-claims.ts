import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QA_GATE_PIPELINE_STEP_COUNT } from '../src/config/qa-gate-pipeline';
import { MAX_LANES } from '../src/tools/dispatch-lanes';
import {
	DELEGATION_COMPACTION_HIGH_WATER_BYTES,
	MAX_CHECKPOINT_BYTES,
	MAX_CHECKPOINT_RECORDS,
	TOMBSTONE_MIN_AGE_MS,
} from '../src/background/pending-delegations';
import { MAX_RECOVERY_LEDGER_BYTES } from '../src/background/delegation-health';

type DriftSeverity = 'error' | 'warning' | 'notice';

interface DriftFinding {
	category: string;
	severity: DriftSeverity;
	message: string;
	file?: string;
}

interface DocsNumericClaim {
	readonly file: string;
	readonly label: string;
	readonly regex: RegExp;
	readonly expected: number;
	/** Identifier of the imported source-of-truth constant, for messages/docs. */
	readonly sourceName: string;
}

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);

const DOCS_NUMERIC_CLAIMS = [
	{
		file: 'docs/planning.md',
		label: 'planning QA gate count',
		regex: /full\s+(\d+)-step\s+QA gate/i,
		expected: QA_GATE_PIPELINE_STEP_COUNT,
		sourceName: 'QA_GATE_PIPELINE_STEPS',
	},
	{
		file: 'docs/swarm-briefing.md',
		label: 'briefing QA gate count',
		regex: /a\s+(\d+)-step\s+QA\s+gate/i,
		expected: QA_GATE_PIPELINE_STEP_COUNT,
		sourceName: 'QA_GATE_PIPELINE_STEPS',
	},
	{
		file: 'docs/swarm-briefing.md',
		label: 'briefing pipeline heading count',
		regex: /## Pipeline \((\d+) Steps\)/,
		expected: QA_GATE_PIPELINE_STEP_COUNT,
		sourceName: 'QA_GATE_PIPELINE_STEPS',
	},
	// dispatch_lanes MAX_LANES prose citations (issue #1645). The lane batch cap
	// is hand-copied into skill guidance prose in several phrasings; when
	// MAX_LANES changes, these copies must be updated in the same commit or
	// this detector flags them. Patterns anchor on stable surrounding prose,
	// not on the bare number.
	{
		file: '.opencode/skills/pre-phase-briefing/SKILL.md',
		label: 'pre-phase-briefing dispatch lane cap',
		regex: /dispatch cap of (\d+) lanes per batch/,
		expected: MAX_LANES,
		sourceName: 'MAX_LANES',
	},
	{
		file: '.claude/skills/pre-phase-briefing/SKILL.md',
		label: 'pre-phase-briefing mirror dispatch lane cap',
		regex: /dispatch cap of (\d+) lanes per batch/,
		expected: MAX_LANES,
		sourceName: 'MAX_LANES',
	},
	{
		file: '.opencode/skills/swarm-pr-review/SKILL.md',
		label: 'swarm-pr-review dispatch lane cap',
		regex: /accepts a maximum of (\d+) lanes per call/,
		expected: MAX_LANES,
		sourceName: 'MAX_LANES',
	},
	{
		file: '.opencode/skills/swarm-pr-review/SKILL.md',
		label: 'swarm-pr-review micro-lane dispatch lane cap',
		regex: /accepts at\s+most (eight|\d+) lanes per call/,
		expected: MAX_LANES,
		sourceName: 'MAX_LANES',
	},
	{
		file: '.opencode/skills/swarm-pr-feedback/SKILL.md',
		label: 'swarm-pr-feedback dispatch lane cap',
		regex: /batch at (\d+) lanes \(`MAX_LANES`\)/,
		expected: MAX_LANES,
		sourceName: 'MAX_LANES',
	},
	{
		file: '.opencode/skills/swarm-pr-feedback/SKILL.md',
		label: 'swarm-pr-feedback sequential-batch lane threshold',
		regex: /needs more than (\d+) verification lanes/,
		expected: MAX_LANES,
		sourceName: 'MAX_LANES',
	},
	{
		file: '.opencode/skills/codebase-review-swarm/references/review-protocol-v8.2.md',
		label: 'review-protocol Phase 0 lane limit',
		regex: /scaled toward the (\d+)-lane dispatch limit/,
		expected: MAX_LANES,
		sourceName: 'MAX_LANES',
	},
	{
		file: 'docs/architecture.md',
		label: 'architecture.md reality-check lane cap',
		regex: /scaled to surface size up to the (\d+)-lane cap/,
		expected: MAX_LANES,
		sourceName: 'MAX_LANES',
	},
] as const satisfies readonly DocsNumericClaim[];

/** Directory holding per-PR release-note fragments awaiting release-please pickup. */
const PENDING_RELEASE_FRAGMENT_DIR = 'docs/releases/pending';
/** Shipped release notes are frozen history — never drift-checked. */
const PENDING_RELEASE_FRAGMENT_SUFFIX = '.md';

/**
 * Prose shapes that hand-copy the dispatch lane batch cap in release-note
 * fragments. Fragments are transient (deleted when release-please consumes
 * them), so they are scanned as a directory instead of pinned by path.
 */
const LANE_CAP_FRAGMENT_REGEXES: readonly RegExp[] = [
	/MAX_LANES\s*=\s*(\d+)/,
	/(\d+)\s*lanes?\s+per\s+(?:call|batch)/i,
	/(\d+)-lane\s+(?:dispatch\s+)?(?:cap|limit)/i,
];

function checkNumericClaim(
	claim: DocsNumericClaim,
	root: string,
	findings: DriftFinding[],
	category: string,
): void {
	const absolutePath = path.join(root, claim.file);
	if (!fs.existsSync(absolutePath)) {
		findings.push({
			category,
			severity: 'error',
			file: claim.file,
			message: `${claim.label} file is missing`,
		});
		return;
	}
	const match = claim.regex.exec(fs.readFileSync(absolutePath, 'utf-8'));
	if (!match?.[1]) {
		findings.push({
			category,
			severity: 'warning',
			file: claim.file,
			message: `${claim.label} is missing numeric claim matching ${claim.regex}`,
		});
		return;
	}
	const actual = spellNumber(match[1]);
	if (actual !== claim.expected) {
		findings.push({
			category,
			severity: 'warning',
			file: claim.file,
			message: `${claim.label} says ${match[1]}, but ${claim.sourceName} has ${claim.expected}`,
		});
	}
}

/** Maps the small set of spelled-out numbers used in lane prose to digits. */
function spellNumber(token: string): number {
	const spelled: Record<string, number> = {
		one: 1,
		two: 2,
		three: 3,
		four: 4,
		five: 5,
		six: 6,
		seven: 7,
		eight: 8,
		nine: 9,
		ten: 10,
	};
	return spelled[token.toLowerCase()] ?? Number(token);
}

/**
 * Scans pending release-note fragments for hand-copied lane-cap prose and
 * verifies each against the imported MAX_LANES constant. Every occurrence of
 * every phrasing is checked, not just the first; duplicate hits at the same
 * wrong number (including overlapping phrasings on one sentence) collapse
 * to a single finding, while distinct wrong numbers each get their own.
 */
function detectPendingFragmentLaneCapDrift(
	root: string,
	findings: DriftFinding[],
	category: string,
): void {
	const dir = path.join(root, PENDING_RELEASE_FRAGMENT_DIR);
	if (!fs.existsSync(dir)) {
		// No pending fragments at all — nothing to check. The directory's
		// absence is not itself drift (fresh checkouts between releases).
		return;
	}
	const fragmentNames = fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name)
		.filter((name) => name.endsWith(PENDING_RELEASE_FRAGMENT_SUFFIX))
		.sort();
	for (const name of fragmentNames) {
		const relative = `${PENDING_RELEASE_FRAGMENT_DIR}/${name}`;
		const contents = fs.readFileSync(path.join(dir, name), 'utf-8');
		// Dedupe per (file, wrong number): regexes can overlap on the SAME
		// sentence (e.g. "99 lanes per call (MAX_LANES=99)" matches two
		// phrasings), and each distinct wrong number should surface exactly
		// once. The first captured token is kept for the message.
		const wrongNumberTokens = new Map<number, string>();
		for (const regex of LANE_CAP_FRAGMENT_REGEXES) {
			// matchAll requires the g flag; checking every occurrence means
			// cloning each module-level regex with it instead of mutating the
			// shared pattern (exec alone would only see the first hit).
			const global = new RegExp(regex.source, `${regex.flags}g`);
			for (const match of contents.matchAll(global)) {
				if (!match[1]) continue;
				const actual = spellNumber(match[1]);
				if (actual !== MAX_LANES && !wrongNumberTokens.has(actual)) {
					wrongNumberTokens.set(actual, match[1]);
				}
			}
		}
		for (const token of wrongNumberTokens.values()) {
			findings.push({
				category,
				severity: 'warning',
				file: relative,
				message: `release fragment lane-cap citation says ${token}, but MAX_LANES has ${MAX_LANES}`,
			});
		}
		// #2034 review PRR-015: delegation-store bounds hand-copied into
		// fragments. Each pattern maps to exactly one source constant and is
		// ORDER-AGNOSTIC (the fragment phrases some bounds number-first and
		// some phrase-first); MiB values are converted to bytes.
		for (const [patterns, label, expected] of [
			[
				[/(\d+)\s*MiB\s+fail-closed\s+recovery\s+guard/i],
				'recovery guard',
				MAX_RECOVERY_LEDGER_BYTES,
			],
			[
				[
					/(\d+)\s*MiB\s+compaction\s+high-water\s+mark/i,
					/compaction\s+high-water\s+(\d+)\s*MiB/i,
				],
				'compaction high-water',
				DELEGATION_COMPACTION_HIGH_WATER_BYTES,
			],
			[
				[/(\d+)\s*MiB\s+checkpoint\s+byte\s+budget/i],
				'checkpoint byte budget',
				MAX_CHECKPOINT_BYTES,
			],
		] as const) {
			for (const regex of patterns) {
				const global = new RegExp(regex.source, `${regex.flags}g`);
				for (const match of contents.matchAll(global)) {
					if (!match[1]) continue;
					const claimedBytes = Number(match[1]) * 1024 * 1024;
					if (claimedBytes !== expected) {
						findings.push({
							category,
							severity: 'warning',
							file: relative,
							message: `release fragment says ${match[1]} MiB ${label}, but the source constant has ${expected} bytes`,
						});
					}
				}
			}
		}
		const liveCap = /live-record\s+cap\s+(\d+)/.exec(contents);
		if (liveCap?.[1] && Number(liveCap[1]) !== MAX_CHECKPOINT_RECORDS) {
			findings.push({
				category,
				severity: 'warning',
				file: relative,
				message: `release fragment live-record cap says ${liveCap[1]}, but MAX_CHECKPOINT_RECORDS has ${MAX_CHECKPOINT_RECORDS}`,
			});
		}
		// 72 h tombstone age: match "N h" in BOTH phrasings of the tombstone
		// bound (eviction sentence and bounds-bullet "N h closed-summary age
		// floor") so neither copy can drift silently; unrelated hour figures
		// are not flagged.
		for (const tombstone of contents.matchAll(
			/(?:(?:closed summaries (?:younger than|<))\s*(\d+)\s*h|(\d+)\s*h\s+closed-summary\s+age\s+floor)/gi,
		)) {
			const hours = tombstone[1] ?? tombstone[2];
			if (!hours) continue;
			const claimedMs = Number(hours) * 60 * 60 * 1000;
			if (claimedMs !== TOMBSTONE_MIN_AGE_MS) {
				findings.push({
					category,
					severity: 'warning',
					file: relative,
					message: `release fragment tombstone age says ${hours} h, but TOMBSTONE_MIN_AGE_MS has ${TOMBSTONE_MIN_AGE_MS} ms`,
				});
			}
		}
	}
}

export function detectDocsClaimDrift(root: string = REPO_ROOT): DriftFinding[] {
	const findings: DriftFinding[] = [];
	const category = 'docs-claim';

	for (const claim of DOCS_NUMERIC_CLAIMS) {
		checkNumericClaim(claim, root, findings, category);
	}
	detectPendingFragmentLaneCapDrift(root, findings, category);

	return findings;
}
