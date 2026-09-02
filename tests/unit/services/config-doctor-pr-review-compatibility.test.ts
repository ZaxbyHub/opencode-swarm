import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import type { PluginConfig } from '../../../src/config/schema';
import { runConfigDoctor } from '../../../src/services/config-doctor';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe('config doctor PR-review compatibility flag (F-017)', () => {
	test('reports a non-boolean raw value', () => {
		const directory = canonicalMkdtemp('doctor-pr-review-');
		directories.push(directory);
		const config = {
			pr_review_legacy_transcript_compatibility: 'yes',
		} as unknown as PluginConfig;

		const result = runConfigDoctor(config, directory);
		const finding = result.findings.find(
			(item) =>
				item.id === 'invalid-pr_review_legacy_transcript_compatibility-type',
		);

		expect(finding?.severity).toBe('error');
		expect(finding?.path).toBe('pr_review_legacy_transcript_compatibility');
	});
});
