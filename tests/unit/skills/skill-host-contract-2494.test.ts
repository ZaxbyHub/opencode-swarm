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

	test('swarm-pr-review publishes a display->machine mapping for every advertised verdict', () => {
		const lines = readRepoFile(SWARM_PR_REVIEW).split(/\r?\n/);

		// Advertised display verdicts = first table column of the Merge
		// Recommendation Table (backticked), plus `INCOMPLETE` as the
		// machine-only terminal row.
		const advertised = new Set<string>();
		let inTable = false;
		for (const line of lines) {
			if (/^#\s+Merge Recommendation Table\s*$/.test(line.trim())) {
				inTable = true;
				continue;
			}
			if (inTable && /^#{1,3}\s/.test(line.trim())) break;
			if (!inTable) continue;
			const m = line.match(/^\|\s*`([A-Z_]+)`\s*\|/);
			if (m) advertised.add(m[1]);
		}
		expect([...advertised].sort()).toEqual([
			'APPROVE',
			'APPROVE_WITH_NOTES',
			'BLOCK',
			'INCOMPLETE',
			'REQUEST_CHANGES',
		]);

		for (const display of advertised) {
			const re = new RegExp(
				'`?' +
					display +
					'`?' +
					MAPPING_CONNECTOR +
					'(APPROVE|REQUEST_CHANGES|INCOMPLETE)(?!_WITH_NOTES)',
			);
			expect(lines.some((l) => re.test(l))).toBeTrue(
				`no published mapping line for display verdict ${display}`,
			);
		}

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
		const settlementToken = /N-of-6|settle|settlement|#2383|unsettled/i;
		const anchors = [/^14\.\s/, /^15\.\s/, /COVERAGE GATE CONDITION/];
		for (const anchor of anchors) {
			const idx = lines.findIndex((l) => anchor.test(l));
			expect(idx).toBeGreaterThanOrEqual(0);
			const window = lines.slice(idx, idx + 4).join('\n');
			expect(settlementToken.test(window)).toBeTrue(
				`clause at line ${idx + 1} lacks N-of-6 settlement scoping`,
			);
		}
	});
});
