import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildV3EnrichmentPrompt } from '../../../src/hooks/knowledge-curator';

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const PR5_RUNTIME_FILES = [
	'src/commands/close.ts',
	'src/commands/pr-feedback.ts',
	'src/config/bundled-skills.ts',
	'src/hooks/knowledge-curator.ts',
];

describe('PR5 runtime text encoding', () => {
	test('changed runtime files are UTF-8 without a byte-order mark', () => {
		for (const file of PR5_RUNTIME_FILES) {
			const bytes = readFileSync(path.join(REPO_ROOT, file));
			expect(
				[...bytes.subarray(0, 3)],
				`${file} must not begin with UTF-8 BOM bytes`,
			).not.toEqual([0xef, 0xbb, 0xbf]);
		}
	});

	test('knowledge-curator enrichment prompt contains real punctuation, not mojibake', () => {
		const prompt = buildV3EnrichmentPrompt(
			'Always verify the current PR head.',
			'workflow',
			['github'],
		);
		expect(prompt).toContain('—');
		expect(prompt).not.toContain('â€”');
	});

	test('PR feedback command documentation contains real punctuation, not mojibake', () => {
		const source = readFileSync(
			path.join(REPO_ROOT, 'src/commands/pr-feedback.ts'),
			'utf8',
		);
		expect(source).toContain('MODE: PR_FEEDBACK — the swarm workflow');
		expect(source).toContain('→ feedback pass on PR 155');
		expect(source).toContain('no parseable PR ref ⇒ the whole');
		expect(source).not.toMatch(/[âÃ]/u);
	});
});
