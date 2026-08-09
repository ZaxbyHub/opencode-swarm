/**
 * Execution-based parity test proving the skill-eval scorer wrapper
 * (evaluation-fixtures/skill-eval/scoring/score-skill-eval.cjs) produces
 * identical scores to the authoritative `scoreSkillPhrases` function in
 * src/services/skill-evaluator.ts (final critic FC1).
 *
 * Spawns the .cjs as a subprocess (the way the substrate invokes project
 * scorers) over a score matrix and asserts equality. This is the "no duplicate
 * scorer" guarantee: one authoritative function + a verified-equivalent
 * subprocess mirror. If the two drift, this test fails.
 */

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { scoreSkillPhrases } from '../../../../src/services/skill-evaluator.js';

const SCORER_PATH = path.resolve(
	__dirname,
	'../../../../..',
	'evaluation-fixtures',
	'skill-eval',
	'scoring',
	'score-skill-eval.cjs',
);

// Sanity: the test runner may transpile to a cache dir, so fall back to the
// repo-relative path via process.cwd() if __dirname does not land in the repo.
function resolveScorerPath(): string {
	const candidates = [
		SCORER_PATH,
		path.resolve(
			process.cwd(),
			'evaluation-fixtures',
			'skill-eval',
			'scoring',
			'score-skill-eval.cjs',
		),
	];
	for (const c of candidates) {
		try {
			require('node:fs').accessSync(c);
			return c;
		} catch {
			// try next
		}
	}
	return SCORER_PATH;
}

interface Case {
	name: string;
	content: string;
	required: string[];
	forbidden: string[];
}

const MATRIX: Case[] = [
	{
		name: 'all-required-no-forbidden',
		content: 'use the trigger when delegating',
		required: ['trigger', 'when'],
		forbidden: [],
	},
	{
		name: 'partial-required',
		content: 'use the trigger',
		required: ['trigger', 'when', 'how'],
		forbidden: [],
	},
	{ name: 'no-required', content: 'anything', required: [], forbidden: [] },
	{
		name: 'forbidden-present',
		content: 'use the trigger shortcut when',
		required: ['trigger', 'when'],
		forbidden: ['shortcut'],
	},
	{
		name: 'partial-plus-forbidden',
		content: 'use the shortcut',
		required: ['trigger', 'when'],
		forbidden: ['shortcut'],
	},
	{
		name: 'case-insensitive',
		content: 'REVIEWER must CHECK',
		required: ['reviewer', 'check'],
		forbidden: [],
	},
];

function runCjsScorer(c: Case): number {
	const dir = mkdtempSync(path.join(tmpdir(), 'scorer-parity-'));
	try {
		const artifactDir = path.join(dir, '.artifacts');
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(
			path.join(artifactDir, 'model-output.json'),
			JSON.stringify({ v: 1, text: c.content }),
		);
		const specPath = path.join(dir, 'phrase-spec.json');
		writeFileSync(
			specPath,
			JSON.stringify({
				required_phrases: c.required,
				forbidden_phrases: c.forbidden,
			}),
		);
		const stdout = execFileSync(
			process.execPath,
			[resolveScorerPath(), specPath],
			{
				cwd: dir,
				timeout: 10_000,
				env: {
					...process.env,
					SWARM_EVAL_ARTIFACT_DIR: artifactDir,
					SWARM_EVAL_TASK_ID: 't',
					SWARM_EVAL_CANDIDATE_ID: 'c',
					SWARM_EVAL_SEED: 's',
				},
				maxBuffer: 1024 * 1024,
			},
		).toString();
		const parsed = JSON.parse(stdout.trim().split('\n').pop() as string) as {
			score: number;
		};
		return parsed.score;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe('scorer parity — .cjs wrapper equals scoreSkillPhrases (final critic FC1)', () => {
	for (const c of MATRIX) {
		it(`matches on ${c.name}`, () => {
			const expected = scoreSkillPhrases({
				content: c.content,
				required: c.required,
				forbidden: c.forbidden,
			}).score;
			const actual = runCjsScorer(c);
			expect(actual).toBeCloseTo(expected, 6);
		});
	}

	it('the wrapper exists at the expected path', () => {
		// If this fails, the scorer bundle moved and the substrate's argv would 404.
		expect(() => runCjsScorer(MATRIX[0])).not.toThrow();
	});
});
