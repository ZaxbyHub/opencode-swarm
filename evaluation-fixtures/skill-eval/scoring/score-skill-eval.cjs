#!/usr/bin/env node
/*
 * Skill-eval project scorer wrapper (issue #1822 — D1, critic C1).
 *
 * The evaluation substrate invokes `kind:'project'` scorers as isolated
 * subprocesses (runner.ts:175-228), passing:
 *   - SWARM_EVAL_TASK_ID, SWARM_EVAL_CANDIDATE_ID, SWARM_EVAL_SEED
 *   - SWARM_EVAL_ARTIFACT_DIR (contains model-output.json with the candidate's
 *     generated text under { v: 1, text: "..." })
 *   - argv: [<this-script>, <phrase-spec-path>]
 *
 * The scorer reads the candidate text from model-output.json, reads the phrase
 * spec (required_phrases / forbidden_phrases), and emits a ScorerOutputV1 line:
 *   { "v": 1, "score": <0..1>, "cost": { "source": "unavailable" } }
 *
 * The scoring arithmetic is the SAME as `scoreSkillPhrases` in
 * src/services/skill-evaluator.ts (the source of truth). A parity test
 * (tests/unit/services/skill-evaluator-refactor.test.ts) proves the two agree,
 * so there is no duplicate scorer — one authoritative function, one thin
 * subprocess mirror that must match.
 *
 * Score = requiredHits / max(1, required.length), minus a 1-point penalty if
 * any forbidden phrase is present, clamped to >= 0. Phrase matching is
 * case-insensitive substring.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readArtifact() {
	const dir = process.env.SWARM_EVAL_ARTIFACT_DIR;
	if (!dir) throw new Error('missing SWARM_EVAL_ARTIFACT_DIR');
	const file = path.join(dir, 'model-output.json');
	const raw = fs.readFileSync(file, 'utf8');
	const parsed = JSON.parse(raw);
	if (!parsed || typeof parsed.text !== 'string') {
		throw new Error('model-output.json missing text field');
	}
	return parsed.text;
}

function readPhraseSpec(specPath) {
	if (!specPath || !fs.existsSync(specPath)) {
		return { required: [], forbidden: [] };
	}
	const parsed = JSON.parse(fs.readFileSync(specPath, 'utf8'));
	return {
		required: Array.isArray(parsed.required_phrases) ? parsed.required_phrases : [],
		forbidden: Array.isArray(parsed.forbidden_phrases) ? parsed.forbidden_phrases : [],
	};
}

function includesPhrase(content, phrase) {
	return content.toLowerCase().includes(String(phrase).toLowerCase());
}

function scoreSkillPhrases(content, spec) {
	const required = spec.required;
	const forbidden = spec.forbidden;
	let requiredHits = 0;
	for (const phrase of required) {
		if (includesPhrase(content, phrase)) requiredHits++;
	}
	const requiredScore = required.length === 0 ? 1 : requiredHits / Math.max(1, required.length);
	const forbiddenPenalty = forbidden.some((p) => includesPhrase(content, p)) ? 1 : 0;
	return Math.max(0, requiredScore - forbiddenPenalty);
}

function main() {
	const specPath = process.argv[2];
	const content = readArtifact();
	const spec = readPhraseSpec(specPath);
	const score = scoreSkillPhrases(content, spec);
	process.stdout.write(
		JSON.stringify({ v: 1, score, cost: { source: 'unavailable' } }) + '\n',
	);
}

try {
	main();
} catch (err) {
	// ScorerFailure 'malformed' — the runner treats non-zero exit / bad JSON as a
	// task failure rather than a candidate score. Emit a zero-score with a
	// metadata reason so the run records the failure deterministically.
	process.stderr.write(`score-skill-eval failed: ${err && err.message ? err.message : String(err)}\n`);
	process.stdout.write(
		JSON.stringify({
			v: 1,
			score: 0,
			cost: { source: 'unavailable' },
			metadata: { failure: 'scorer-error', reason: String(err && err.message ? err.message : err).slice(0, 200) },
		}) + '\n',
	);
	process.exitCode = 0;
}
