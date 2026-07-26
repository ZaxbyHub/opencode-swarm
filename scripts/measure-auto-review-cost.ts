import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_MODELS } from '../src/config/constants.js';
import { estimateTokens } from '../src/hooks/utils.js';
import { collectReviewDiff } from '../src/review/diff-source.js';
import {
	buildReviewPrompt,
	REVIEW_SYSTEM_PROMPT,
} from '../src/review/engine.js';

const REPOSITORY_ROOT = path.resolve(import.meta.dir, '..');
const OUTPUT_PATH = path.join(
	REPOSITORY_ROOT,
	'docs',
	'benchmarks',
	'auto-review-v8-cost-baseline.json',
);
const MAX_DIFF_BYTES = 262_144;
const REVIEWER_OUTPUT_TOKEN_BUDGET = 800;

// Fixed first-parent window from canonical main at issue #1675 implementation
// intake. Keeping the complete ordered set makes every one of the 30 base/head
// pairs independently reproducible even after main advances.
const FIRST_PARENT_SHAS = [
	'b0284ca370c13919578164921e896b35eecf9b25',
	'42b42b881a47f7732beaa4208e083d8240045f8c',
	'95a60e775be28b61c9d07efc96b5314d0458b296',
	'47e98a094dc33f3ffd9c236ce262411cacd82eeb',
	'2d64460068a44038dea7b46615ce3ea8ee3d9ea0',
	'03732159ce73484649ab4a218e74863b426020a1',
	'b6a737beb340baa963d99d8a4609c03671261f81',
	'e442151267d9b1d1f41aa810e38315c30c37b1c3',
	'f28343dc876a22c6cfe5b5a40773ae23f0047c6d',
	'1be3a8429191252d900e430fe843be6e602f765f',
	'2413eabc37b5f42546236ca0f53a6cc2a34f1d2d',
	'c770a720574c714e1f25b747f0c16914eed519f8',
	'2c8a51f3fd27c7e7fa46c6572179e02d7406424e',
	'9b67d48fc25963be184239629ff28a88c872e05d',
	'0bc6a8b53b4462091ed4af8c2a1d39e2403d859e',
	'f8eb17fcd36323b790234c704f603d51e80ef250',
	'c717988039f8a210937de152f1bbcfbb7912017c',
	'ca502494f90017d6061114ff9d8c9d5662207cf3',
	'07bef196dab2fd72da38335d47400965e2a743ce',
	'96674c740691be387044bf97e92e6a1bcfb3a9fc',
	'd99b8ed351cbb61a2fd8e18e47cb9406f26d1394',
	'41c739960c3740dee2ee66fb8d6c4a8b62b466c9',
	'0a884e9813923bd38c5496f2057f7f2a2b09de58',
	'8ef6aca08c901ba93249515f22a06e0cb54dba51',
	'bcff2be020e47dcb2e6f87ea2e00a70f63b0d66a',
	'123ad1dbc548dbec4d92c82fb511d90b20fcbe33',
	'ffc405ae977294ccce0800a8a72bd26f92c054ae',
	'27180d290bda69de078d9b9dff5145c75a98032d',
	'f2c832f9066a74ebd93acf171487060fe6e1cfcb',
	'1e4761ef7a02b3351a8225e7e223e6a74b2870db',
	'8d1d8bfe6ae7b0c69fefd5bc0f80677366201722',
] as const;

function distribution(values: number[]) {
	const ordered = [...values].sort((a, b) => a - b);
	const percentile = (fraction: number) =>
		ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
	return {
		min: ordered[0],
		p50: percentile(0.5),
		p95: percentile(0.95),
		max: ordered.at(-1),
	};
}

const samples = [];
for (let index = 0; index < FIRST_PARENT_SHAS.length - 1; index++) {
	const head = FIRST_PARENT_SHAS[index];
	const base = FIRST_PARENT_SHAS[index + 1];
	const diff = await collectReviewDiff({
		directory: REPOSITORY_ROOT,
		selector: { kind: 'range', from: base, to: head, operator: '..' },
		maxBytes: MAX_DIFF_BYTES,
		timeoutMs: 30_000,
	});
	if (diff.status !== 'ok') {
		throw new Error(`${base}..${head}: ${diff.code}: ${diff.reason}`);
	}
	const prompt = buildReviewPrompt({
		trigger: 'phase_completion',
		phase: 1,
		diff,
	});
	samples.push({
		base_sha: base,
		head_sha: head,
		scope_hash: diff.scopeHash,
		diff_bytes: diff.reviewTextBytes,
		prompt_bytes: Buffer.byteLength(REVIEW_SYSTEM_PROMPT) + Buffer.byteLength(prompt),
		prompt_token_estimate:
			estimateTokens(REVIEW_SYSTEM_PROMPT) + estimateTokens(prompt),
		scope_complete: diff.completeness.complete,
		scope_truncated: diff.completeness.truncated,
	});
}

const payload = {
	schema_version: 1,
	generated_at: '2026-07-25T00:00:00.000Z',
	generation_command: 'bun run scripts/measure-auto-review-cost.ts',
	sample_method:
		'30 fixed consecutive first-parent canonical-main commit diffs',
	sample_count: samples.length,
	review_policy: {
		trigger: 'phase_boundary',
		mode: 'advisory',
		min_confidence: 0.7,
		validate_findings: false,
		max_diff_bytes: MAX_DIFF_BYTES,
		reviewer_output_token_budget: REVIEWER_OUTPUT_TOKEN_BUDGET,
	},
	model_assumptions: {
		reviewer: DEFAULT_MODELS.reviewer,
		optional_validator: DEFAULT_MODELS.critic_finding_validator,
	},
	call_formula: {
		v8_default_per_phase: '1 reviewer + 0 validator',
		validation_opt_in_per_phase:
			'1 reviewer + 0 or 1 batched validator when eligible findings exist',
	},
	diff_bytes: distribution(samples.map((sample) => sample.diff_bytes)),
	reviewer_prompt_token_estimate: distribution(
		samples.map((sample) => sample.prompt_token_estimate),
	),
	scope_completeness: {
		complete_samples: samples.filter((sample) => sample.scope_complete).length,
		truncated_samples: samples.filter((sample) => sample.scope_truncated).length,
	},
	expected_default_token_delta: {
		input_tokens: distribution(
			samples.map((sample) => sample.prompt_token_estimate),
		),
		output_tokens_upper_bound: REVIEWER_OUTPUT_TOKEN_BUDGET,
		usd: null,
		usd_reason:
			'Provider-reported usage and pricing are unavailable in a deterministic source-only benchmark.',
	},
	samples,
	limitations: [
		'Token estimates use the repository estimateTokens utility, not provider tokenizers.',
		'This source-only baseline excludes cache behavior, retries, and provider-specific pricing.',
		'Runtime delegation_end telemetry and /swarm costs are authoritative for observed provider usage.',
	],
};
const artifactSha256 = createHash('sha256')
	.update(JSON.stringify(payload), 'utf8')
	.digest('hex');
const artifact = { ...payload, artifact_sha256: artifactSha256 };

fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(
	`Wrote ${path.relative(REPOSITORY_ROOT, OUTPUT_PATH)} (${samples.length} samples, sha256 ${artifactSha256})`,
);
