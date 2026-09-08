import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { AutoReviewConfigSchema } from '../../../src/config/schema';
import type { ReviewModelDispatcher } from '../../../src/review/contracts';
import type { ReviewDiffResult } from '../../../src/review/diff-source';
import {
	_internals,
	type RunReviewEngineInput,
	runReviewEngine,
} from '../../../src/review/engine';
import { createReviewManifest } from '../../helpers/review-manifest';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let projectRoot: string;
let restoreClock: () => void;
const originalCollectReviewDiff = _internals.collectReviewDiff;

function diff(): Extract<ReviewDiffResult, { status: 'ok' }> {
	const text = 'diff --git a/src/critical.ts b/src/critical.ts\n';
	return {
		status: 'ok',
		selector: { kind: 'default' },
		canonicalText: text,
		reviewTextBytes: text.length,
		scopeHash: 'a'.repeat(64),
		headSha: 'b'.repeat(40),
		baseRef: 'origin/main',
		baseSha: 'c'.repeat(40),
		mergeBase: 'c'.repeat(40),
		changedLines: new Map([['src/critical.ts', [{ start: 1, end: 1 }]]]),
		deletedLines: new Map(),
		files: new Map([
			[
				'src/critical.ts',
				{
					kind: 'modified',
					oldPath: 'src/critical.ts',
					newPath: 'src/critical.ts',
				},
			],
		]),
		completeness: { complete: true, truncated: false, skipReasons: [] },
		staleness: {
			collectedAt: new Date().toISOString(),
			headSha: 'b'.repeat(40),
			selectorKey: 'default',
			includesWorkingTree: true,
			scopeHash: 'a'.repeat(64),
		},
		manifest: createReviewManifest(),
	};
}

function dispatcher(): ReviewModelDispatcher {
	return {
		async dispatch(request) {
			const text = JSON.stringify({
				findings: [
					{
						title: 'Critical authorization bypass',
						body: 'Unauthenticated callers can read protected records.',
						severity: 'critical',
						confidence: 0.01,
						file: 'src/critical.ts',
						line_start: 1,
						line_end: 1,
					},
				],
				verdict: 'REJECTED',
				overall_confidence: 0.01,
			});
			return {
				status: 'completed',
				text: `VERDICT: REJECTED\nRISK: CRITICAL\nISSUES: none\n\`\`\`json\n${text}\n\`\`\``,
				agentName: request.agentName,
				durationMs: 1,
				promptBytes: request.prompt.length,
				responseBytes: text.length,
			};
		},
	};
}

function input(): RunReviewEngineInput {
	return {
		directory: projectRoot,
		sessionID: 'session-2491',
		trigger: 'phase_completion',
		phase: 1,
		config: AutoReviewConfigSchema.parse({
			enabled: true,
			min_confidence: 0.7,
			validate_findings: false,
			final_review: { mode: 'advisory' },
		}),
		dispatcher: dispatcher(),
		reviewerAgent: 'reviewer',
		validatorAgent: 'critic_finding_validator',
	};
}

beforeEach(() => {
	projectRoot = canonicalMkdtemp('issue-2491-critical-');
	fs.mkdirSync(path.join(projectRoot, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(projectRoot, 'src', 'critical.ts'),
		'export const x = 1;\n',
	);
	restoreClock = freezeClock({
		fixedNow: 1_750_000_000_000,
		isoNow: '2026-01-01T00:00:00.000Z',
	});
	_internals.collectReviewDiff = async () => diff();
});

afterEach(() => {
	_internals.collectReviewDiff = originalCollectReviewDiff;
	try {
		fs.rmSync(projectRoot, { recursive: true, force: true });
	} finally {
		restoreClock();
	}
});

describe('issue #2491 — critical confidence preservation', () => {
	test('does not demote a CRITICAL finding solely for low confidence', async () => {
		const result = await runReviewEngine(input());

		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]).toMatchObject({
			severity: 'critical',
			effective_severity: 'critical',
		});
	});
});
