import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	AUTO_REVIEW_V8_BURN_IN_DECISION,
	resolveAutoReviewConfig,
} from '../../../src/config/schema';

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../..',
);
const artifactPath = path.join(
	repositoryRoot,
	AUTO_REVIEW_V8_BURN_IN_DECISION.artifact_path,
);

describe('v8 auto-review burn-in decision', () => {
	test('pins an approved reproducible 30-diff cost artifact', () => {
		const artifact = JSON.parse(
			fs.readFileSync(artifactPath, 'utf8'),
		) as Record<string, unknown>;
		const { artifact_sha256: embeddedHash, ...payload } = artifact;
		const computedHash = createHash('sha256')
			.update(JSON.stringify(payload), 'utf8')
			.digest('hex');

		expect(AUTO_REVIEW_V8_BURN_IN_DECISION.approved).toBe(true);
		expect(embeddedHash).toBe(computedHash);
		expect(AUTO_REVIEW_V8_BURN_IN_DECISION.artifact_sha256).toBe(computedHash);
		expect(artifact.sample_count).toBe(30);
		expect((artifact.samples as unknown[]).length).toBe(30);
		expect(
			(artifact.expected_default_token_delta as { usd: unknown }).usd,
		).toBeNull();
	});

	test('activates only at v8 while an explicit false remains authoritative', () => {
		expect(
			resolveAutoReviewConfig(
				{},
				{
					packageVersion: '7.999.0',
					burnInDecision: AUTO_REVIEW_V8_BURN_IN_DECISION,
				},
			).enabled,
		).toBe(false);
		expect(
			resolveAutoReviewConfig(
				{},
				{
					packageVersion: '8.0.0',
					burnInDecision: AUTO_REVIEW_V8_BURN_IN_DECISION,
				},
			).enabled,
		).toBe(true);
		expect(
			resolveAutoReviewConfig(
				{ enabled: false },
				{
					packageVersion: '8.0.0',
					burnInDecision: AUTO_REVIEW_V8_BURN_IN_DECISION,
				},
			).enabled,
		).toBe(false);
	});
});
