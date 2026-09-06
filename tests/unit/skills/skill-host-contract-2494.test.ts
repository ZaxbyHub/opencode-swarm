/**
 * Skill/host executable-contract guardrail (issue #2494, defect class:
 * "the instruction layer advertises or demands a contract the executable
 * surface does not accept or provide, with no published bridge").
 *
 * Three durable predicates:
 * 1. Host qualification sweep — every SKILL.md across the three native trees
 *    that names a swarm controller / PR-workflow tool must carry availability
 *    conditioning or profile/fallback language in the same file.
 * 2. Report-contract bridge — the swarm-pr-review skill must publish a mapping
 *    line for every verdict it advertises in the Merge Recommendation Table,
 *    mapping into the machine enum registered on complete_pr_workflow, and
 *    BLOCK must never map to APPROVE.
 * 3. Settlement scoping — the blanket no-partial clauses (Hard Rules 14/15,
 *    COVERAGE GATE) must reference the truthful N-of-6 terminal settlement
 *    within their clause window.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	allowedPrReviewReportVerdicts,
	PR_REVIEW_REPORT_VERDICTS,
} from '../../../src/pr-review/completion';

const SKILL_TREES = ['.opencode/skills', '.claude/skills', '.agents/skills'];

const CONTROLLER_TOOLS = [
	'dispatch_lanes_async',
	'collect_lane_results',
	'retrieve_lane_output',
	'parse_lane_candidates',
	'write_pr_review_artifact',
	'write_pr_review_trigger_eval',
	'complete_pr_workflow',
	'prepare_pr_workflow_checkout',
	'abort_pr_workflow',
	'submit_pr_review_result',
] as const;

const CONDITIONING_PHRASES = [
	'when available',
	'only if the session',
	'Profile A',
	'Profile B',
	'controller',
	'subagent',
	'fallback',
	'actual tool list',
	'capability',
] as const;

const SWARM_PR_REVIEW = '.opencode/skills/swarm-pr-review/SKILL.md';
const MAPPING_CONNECTOR =
	'[\\s|`]*(?:→|->|=>|maps?\\s+to|mapped\\s+to|:)[\\s|`]*';

function readRepoFile(path: string): string {
	return readFileSync(join(process.cwd(), path), 'utf-8');
}

function skillFiles(tree: string): string[] {
	const dir = join(process.cwd(), tree);
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => join(tree, e.name, 'SKILL.md'))
		.filter((rel) => existsSync(join(process.cwd(), rel)));
}

describe('skill/host executable-contract guardrail (issue #2494)', () => {
	test('machine enum stays APPROVE / REQUEST_CHANGES / INCOMPLETE with coverage-kind gating', () => {
		expect([...PR_REVIEW_REPORT_VERDICTS]).toEqual([
			'APPROVE',
			'REQUEST_CHANGES',
			'INCOMPLETE',
		]);
		expect(allowedPrReviewReportVerdicts('PARTIAL')).not.toContain('APPROVE');
		expect(allowedPrReviewReportVerdicts('NO_COVERAGE')).toEqual([
			'INCOMPLETE',
		]);
	});

	test('every skill naming a controller tool carries availability conditioning', () => {
		const offenders: string[] = [];
		for (const tree of SKILL_TREES) {
			for (const file of skillFiles(tree)) {
				const text = readRepoFile(file);
				const named = CONTROLLER_TOOLS.filter((t) => text.includes(t));
				if (named.length === 0) continue;
				const conditioned = CONDITIONING_PHRASES.some((p) =>
					text.toLowerCase().includes(p.toLowerCase()),
				);
				if (!conditioned) offenders.push(`${file} names [${named.join(', ')}]`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test('swarm-pr-review publishes the exact display->machine mapping in BOTH surfaces', () => {
		const lines = readRepoFile(SWARM_PR_REVIEW).split(/\r?\n/);

		// The pinned #2494 contract: each advertised display verdict maps to
		// exactly this machine target, in EACH publication surface (the Merge
		// Recommendation Table AND the Final Output ## Verdict bullets — the
		// bullet list is the emission instruction a model follows at report
		// time, so per-surface agreement is asserted, not whole-file presence).
		const expectedTargets: Record<string, string> = {
			APPROVE: 'APPROVE',
			APPROVE_WITH_NOTES: 'APPROVE',
			REQUEST_CHANGES: 'REQUEST_CHANGES',
			BLOCK: 'REQUEST_CHANGES',
			INCOMPLETE: 'INCOMPLETE',
		};
		const machineGroup = '(APPROVE|REQUEST_CHANGES|INCOMPLETE)(?!_WITH_NOTES)';

		const collectMappings = (
			startRe: RegExp,
			rowRe: RegExp,
			into: Map<string, string>,
		): void => {
			let inside = false;
			for (const line of lines) {
				if (startRe.test(line.trim())) {
					inside = true;
					continue;
				}
				if (inside && /^#{1,3}\s/.test(line.trim())) break;
				if (!inside) continue;
				const col = line.match(rowRe);
				if (!col) continue;
				const m = line.match(
					new RegExp('`?' + col[1] + '`?' + MAPPING_CONNECTOR + machineGroup),
				);
				// machineGroup is capture group 1 (the connector group is
				// non-capturing).
				if (m) into.set(col[1], m[1]);
			}
		};

		const tableMappings = new Map<string, string>();
		collectMappings(
			/^#\s+Merge Recommendation Table\s*$/,
			/^\|\s*`([A-Z_]+)`\s*\|/,
			tableMappings,
		);
		const bulletMappings = new Map<string, string>();
		collectMappings(/^##\s+Verdict\s*$/, /^-\s*`([A-Z_]+)`/, bulletMappings);

		for (const [display, target] of Object.entries(expectedTargets)) {
			expect(tableMappings.get(display)).toBe(
				target,
				`Merge Recommendation Table must map ${display} -> ${target}`,
			);
			if (display !== 'INCOMPLETE') {
				// INCOMPLETE is machine-only by design: table row only, no bullet.
				expect(bulletMappings.get(display)).toBe(
					target,
					`## Verdict bullets must map ${display} -> ${target}`,
				);
			}
		}
		// No un-pinned display verdict may appear in either surface.
		const pinned = Object.keys(expectedTargets).sort();
		expect([...tableMappings.keys()].sort()).toEqual(pinned);
		expect([...bulletMappings.keys()].sort()).toEqual(
			pinned.filter((k) => k !== 'INCOMPLETE'),
		);

		// Honesty guard: a BLOCK-condition review can never approve.
		const blockMapsToApprove = lines.some((l) =>
			new RegExp(
				'`?BLOCK`?' + MAPPING_CONNECTOR + 'APPROVE(?!_WITH_NOTES)',
			).test(l),
		);
		expect(blockMapsToApprove).toBe(false);
	});

	test('blanket no-partial clauses are scoped to the N-of-6 terminal settlement', () => {
		const lines = readRepoFile(SWARM_PR_REVIEW).split(/\r?\n/);
		// Specific tokens only (N-of-6 / issue #2383): a generic "settle" match
		// would also pass a negated rewrite like "settlement is never allowed".
		const settlementToken = /N-of-6|#2383/i;
		const anchors = [/^14\.\s/, /^15\.\s/, /COVERAGE GATE CONDITION/];
		for (const anchor of anchors) {
			const idx = lines.findIndex((l) => anchor.test(l));
			expect(idx).toBeGreaterThanOrEqual(0);
			// Each anchor is a single-line clause; scoping the anchor's own line
			// (not a multi-line window) prevents a sibling rule's settlement
			// token from masking this clause losing its scoping.
			expect(settlementToken.test(lines[idx])).toBeTrue(
				`clause at line ${idx + 1} lacks N-of-6 settlement scoping`,
			);
		}
	});
});
