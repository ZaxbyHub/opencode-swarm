import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	isSkillAudienceMatch,
	parseSkillFrontmatter,
	readSkillMetadata,
	type SkillAudienceContext,
} from '../../../src/hooks/skill-scoring.js';
import { withSafeTestDir } from '../../helpers/safe-test-dir.js';

const SKILL_PATH = '.opencode/skills/example/SKILL.md';

function frontmatter(audienceLines: string[]): string {
	return ['---', 'name: example', ...audienceLines, '---', '# Example'].join(
		'\n',
	);
}

function parseAudience(audienceLines: string[]) {
	return parseSkillFrontmatter(frontmatter(audienceLines), SKILL_PATH).audience;
}

const ragappCodex: SkillAudienceContext = {
	runner: 'codex',
	audiences: ['ragappv3'],
};

describe('parseSkillFrontmatter: top-level audience metadata', () => {
	test('reports valid, absent, and structurally invalid frontmatter', () => {
		expect(
			parseSkillFrontmatter('plain markdown', SKILL_PATH).frontmatterStatus,
		).toBe('absent');
		expect(
			parseSkillFrontmatter('---\nname: example', SKILL_PATH).frontmatterStatus,
		).toBe('invalid');
		expect(
			parseSkillFrontmatter(frontmatter([]), SKILL_PATH).frontmatterStatus,
		).toBe('valid');
	});

	test('distinguishes an absent declaration from an explicit invalid one', () => {
		expect(parseAudience([])).toEqual({ status: 'absent', values: [] });
		expect(parseAudience(['audience:'])).toEqual({
			status: 'invalid',
			values: [],
		});
	});

	test('parses scalar, inline, and block list forms', () => {
		expect(parseAudience(['audience: ragappv3'])).toEqual({
			status: 'valid',
			values: ['ragappv3'],
		});
		expect(parseAudience(['audience: [ragappv3, runner:claude]'])).toEqual({
			status: 'valid',
			values: ['ragappv3', 'runner:claude'],
		});
		expect(
			parseAudience(['audience:', '  - ragappv3', '  - runner:codex']),
		).toEqual({
			status: 'valid',
			values: ['ragappv3', 'runner:codex'],
		});
	});

	test('accepts JSON inline lists and deduplicates without reordering', () => {
		expect(
			parseAudience(['audience: ["ragappv3", "runner:claude", "ragappv3"]']),
		).toEqual({
			status: 'valid',
			values: ['ragappv3', 'runner:claude'],
		});
	});

	test('recognizes only exact supported runner tokens', () => {
		for (const runner of ['opencode', 'claude', 'codex']) {
			expect(parseAudience([`audience: runner:${runner}`])).toEqual({
				status: 'valid',
				values: [`runner:${runner}`],
			});
		}

		for (const audience of [
			'runner:open-code',
			'runner:Claude',
			'runner:vscode',
		]) {
			expect(parseAudience([`audience: ${audience}`])?.status).toBe('invalid');
		}
	});

	test('enforces lowercase domain grammar and the 64-character bound', () => {
		for (const audience of [
			'RAGAPPv3',
			'-ragappv3',
			'ragappv3-',
			'ragappv3..backend',
			'rag appv3',
			'a'.repeat(65),
		]) {
			expect(parseAudience([`audience: ${audience}`])?.status).toBe('invalid');
		}

		expect(parseAudience(['audience: ragappv3.api-tests_v2'])).toEqual({
			status: 'valid',
			values: ['ragappv3.api-tests_v2'],
		});
	});

	test('rejects mixed-type lists, malformed blocks, and duplicate keys', () => {
		expect(parseAudience(['audience: ["ragappv3", 7]'])?.status).toBe(
			'invalid',
		);
		expect(
			parseAudience(['audience:', '  ragappv3', 'description: ignored'])
				?.status,
		).toBe('invalid');
		expect(
			parseAudience(['audience: ragappv3', 'audience: runner:codex'])?.status,
		).toBe('invalid');
	});

	test('rejects more than 16 declared items before deduplication', () => {
		const items = Array.from({ length: 17 }, () => '  - ragappv3');
		expect(parseAudience(['audience:', ...items])?.status).toBe('invalid');
	});

	test('does not interpret nested audience keys as top-level metadata', () => {
		expect(parseAudience(['metadata:', '  audience: ragappv3'])).toEqual({
			status: 'absent',
			values: [],
		});
	});
});

describe('readSkillMetadata: frontmatter availability', () => {
	test('distinguishes readable metadata from unavailable files', async () => {
		await withSafeTestDir(async (directory) => {
			const skillPath = path.join('skills', 'example', 'SKILL.md');
			const absolutePath = path.join(directory, skillPath);
			fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
			fs.writeFileSync(
				absolutePath,
				frontmatter(['audience: ragappv3']),
				'utf8',
			);

			expect(readSkillMetadata(skillPath, directory).frontmatterStatus).toBe(
				'valid',
			);
			expect(
				readSkillMetadata(path.join('skills', 'missing', 'SKILL.md'), directory)
					.frontmatterStatus,
			).toBe('unavailable');
		});
	});

	test('reports rejected paths as unavailable', async () => {
		await withSafeTestDir(async (directory) => {
			expect(
				readSkillMetadata('../outside/SKILL.md', directory).frontmatterStatus,
			).toBe('unavailable');
		});
	});
});

describe('isSkillAudienceMatch', () => {
	test('keeps absent metadata backward-compatible and fails closed on invalid metadata', () => {
		expect(
			isSkillAudienceMatch(
				{ audience: { status: 'absent', values: [] } },
				ragappCodex,
			),
		).toBe(true);
		expect(
			isSkillAudienceMatch(
				{ audience: { status: 'invalid', values: [] } },
				ragappCodex,
			),
		).toBe(false);
	});

	test('ORs domain audiences within the domain dimension', () => {
		const metadata = {
			audience: {
				status: 'valid' as const,
				values: ['other-repo', 'ragappv3'],
			},
		};
		expect(isSkillAudienceMatch(metadata, ragappCodex)).toBe(true);
		expect(
			isSkillAudienceMatch(metadata, {
				runner: 'codex',
				audiences: ['unknown'],
			}),
		).toBe(false);
	});

	test('ORs runners within the runner dimension', () => {
		const metadata = {
			audience: {
				status: 'valid' as const,
				values: ['runner:claude', 'runner:codex'],
			},
		};
		expect(isSkillAudienceMatch(metadata, ragappCodex)).toBe(true);
		expect(
			isSkillAudienceMatch(metadata, {
				runner: 'opencode',
				audiences: ['ragappv3'],
			}),
		).toBe(false);
	});

	test('ANDs domain and runner dimensions', () => {
		const metadata = {
			audience: {
				status: 'valid' as const,
				values: ['ragappv3', 'runner:claude'],
			},
		};
		expect(
			isSkillAudienceMatch(metadata, {
				runner: 'claude',
				audiences: ['ragappv3'],
			}),
		).toBe(true);
		expect(isSkillAudienceMatch(metadata, ragappCodex)).toBe(false);
		expect(
			isSkillAudienceMatch(metadata, {
				runner: 'claude',
				audiences: ['other-repo'],
			}),
		).toBe(false);
	});

	test('routes swarm-plugin as a domain audience', () => {
		const metadata = parseSkillFrontmatter(
			frontmatter(['audience: swarm-plugin']),
			SKILL_PATH,
		);
		expect(
			isSkillAudienceMatch(metadata, {
				runner: 'opencode',
				audiences: ['swarm-plugin'],
			}),
		).toBe(true);
		expect(isSkillAudienceMatch(metadata, ragappCodex)).toBe(false);
	});
});
