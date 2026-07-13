import { afterEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	AGENT_TOOL_MAP,
	WRITE_TOOL_NAMES,
} from '../../../src/config/constants';
import { TOOL_MANIFEST } from '../../../src/tools/manifest';
import { TOOL_NAMES } from '../../../src/tools/tool-names';
import {
	executeWritePrReviewTriggerEval,
	PR_REVIEW_TRIGGER_DEFINITIONS,
} from '../../../src/tools/write-pr-review-trigger-eval';

const tempDirs: string[] = [];

function tempRoot(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'trigger-eval-')));
	tempDirs.push(root);
	return root;
}

function rows() {
	return PR_REVIEW_TRIGGER_DEFINITIONS.map((definition, index) =>
		index === 0
			? {
					trigger_id: definition.id,
					result: 'MATCHED' as const,
					evidence: `matched keyword for ${definition.id}`,
					source_batch_id: 'micro-batch',
					source_lane_id: `lane-${index}`,
				}
			: {
					trigger_id: definition.id,
					result: 'NO-MATCH' as const,
					evidence: `searched keywords for ${definition.id}; none changed`,
				},
	);
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('write_pr_review_trigger_eval', () => {
	test('is fully registered for Architect without becoming a generic write capability', () => {
		expect(TOOL_NAMES).toContain('write_pr_review_trigger_eval');
		expect(TOOL_MANIFEST.write_pr_review_trigger_eval).toBeDefined();
		expect(AGENT_TOOL_MAP.architect).toContain('write_pr_review_trigger_eval');
		expect(
			(WRITE_TOOL_NAMES as readonly string[]).includes(
				'write_pr_review_trigger_eval',
			),
		).toBe(false);
	});
	test('writes the exact canonical trigger set atomically under .swarm', async () => {
		const root = tempRoot();
		const response = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{ run_id: 'review-1805', rows: rows() },
				root,
			),
		);
		expect(response).toMatchObject({
			success: true,
			matched_count: 1,
			dispatched_micro_lane_count: 1,
		});
		const artifactPath = join(
			root,
			'.swarm',
			'pr-review',
			'review-1805',
			'trigger-eval.json',
		);
		expect(existsSync(artifactPath)).toBe(true);
		const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));
		expect(artifact.rows).toHaveLength(PR_REVIEW_TRIGGER_DEFINITIONS.length);
		expect(artifact.rows[0]).toMatchObject({
			trigger_id: PR_REVIEW_TRIGGER_DEFINITIONS[0].id,
			trigger_row: PR_REVIEW_TRIGGER_DEFINITIONS[0].trigger_row,
			micro_lane: PR_REVIEW_TRIGGER_DEFINITIONS[0].micro_lane,
			result: 'MATCHED',
		});
	});

	for (const [name, mutate, message] of [
		[
			'missing rows',
			(value: ReturnType<typeof rows>) => value.slice(1),
			'missing trigger IDs',
		],
		[
			'extra rows',
			(value: ReturnType<typeof rows>) => [
				...value,
				{ trigger_id: 'extra', result: 'NO-MATCH' as const, evidence: 'none' },
			],
			'unknown trigger IDs',
		],
		[
			'duplicate rows',
			(value: ReturnType<typeof rows>) => [...value, value[0]],
			'duplicate trigger IDs',
		],
	] as const) {
		test(`rejects ${name}`, async () => {
			const result = JSON.parse(
				await executeWritePrReviewTriggerEval(
					{ run_id: 'review-1805', rows: mutate(rows()) },
					tempRoot(),
				),
			);
			expect(result.success).toBe(false);
			expect(result.message).toContain(message);
		});
	}

	test('rejects MATCHED without unique dispatch provenance', async () => {
		const missing = rows();
		delete (missing[0] as { source_batch_id?: string }).source_batch_id;
		const missingResult = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{ run_id: 'review-1805', rows: missing },
				tempRoot(),
			),
		);
		expect(missingResult.message).toContain('MATCHED rows require');

		const duplicate = rows();
		duplicate[1] = {
			...duplicate[0],
			trigger_id: duplicate[1].trigger_id,
		};
		const duplicateResult = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{ run_id: 'review-1805', rows: duplicate },
				tempRoot(),
			),
		);
		expect(duplicateResult.message).toContain('unique dispatch provenance');
	});

	test('rejects traversal and NO-MATCH provenance', async () => {
		const traversal = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{ run_id: '../escape', rows: rows() },
				tempRoot(),
			),
		);
		expect(traversal.success).toBe(false);

		const invalid = rows();
		invalid[1] = {
			...invalid[1],
			source_batch_id: 'should-not-exist',
			source_lane_id: 'should-not-exist',
		};
		const noMatch = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{ run_id: 'review-1805', rows: invalid },
				tempRoot(),
			),
		);
		expect(noMatch.message).toContain('NO-MATCH rows must not include');
	});

	test('canonical trigger definitions stay in exact parity with the skill table', () => {
		const skill = readFileSync(
			join(process.cwd(), '.opencode/skills/swarm-pr-review/SKILL.md'),
			'utf-8',
		);
		const section = skill.slice(
			skill.indexOf('### Swarm plugin risk trigger map'),
			skill.indexOf('Micro-lane output format:'),
		);
		const tablePairs = [
			...section.matchAll(/^\| `([^`]+)` \| [^|]+ \| ([^|]+) \|/gm),
		].map((match) => [match[1], match[2].trim()]);
		expect(tablePairs).toEqual(
			PR_REVIEW_TRIGGER_DEFINITIONS.map((definition) => [
				definition.id,
				definition.micro_lane,
			]),
		);
	});
});
