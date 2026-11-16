/**
 * Issue #3216: migrated `triggers` metadata children must match the generator's
 * yamlJsonString emission (single-quoted JSON array string, ''-escaped) — RED at
 * base, GREEN after the fix. Pins AC12 (migration shape parity), complementing
 * generated-triggers-convergence-3216.test.ts (AC4, top-level absence).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const GENERATED_ROOT = join(process.cwd(), '.opencode', 'skills', 'generated');

/**
 * The previously-legacy files that still exist after the #2966 reconciliation
 * (19 retired forks + the active ci-failure-batching collision were deleted;
 * 12 of the 13 original members went with them — only bundle-safety remains).
 */
const MIGRATED_SLUGS = ['bundle-safety'] as const;

/** Independent oracle for renderSkillMarkdown's yamlJsonString (not exported). */
function yamlJsonString(values: string[]): string {
	const json = JSON.stringify(values);
	return `'${json.replace(/'/g, "''")}'`;
}

function frontmatterSlice(content: string): string {
	const lines = content.split(/\r?\n/);
	if (lines[0]?.trim() !== '---') return '';
	const end = lines.findIndex(
		(line, index) => index > 0 && line.trim() === '---',
	);
	if (end === -1) return '';
	return lines.slice(1, end).join('\n');
}

function metadataTriggersChild(frontmatter: string): string | null {
	const match = frontmatter.match(/^ {2}triggers:[ \t]*(.+)$/m);
	return match ? match[1].trim() : null;
}

function readFrontmatter(slug: string): string {
	const path = join(GENERATED_ROOT, slug, 'SKILL.md');
	return frontmatterSlice(readFileSync(path, 'utf-8'));
}

describe('generated triggers migration shape (issue #3216)', () => {
	test('every generated triggers metadata child is a canonical JSON-array string', () => {
		expect(existsSync(GENERATED_ROOT)).toBe(true);
		for (const slug of readdirSync(GENERATED_ROOT, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)) {
			const frontmatter = readFrontmatter(slug);
			if (!frontmatter) continue;
			const child = metadataTriggersChild(frontmatter);
			if (child === null) continue;
			expect(
				child.startsWith("'") && child.endsWith("'") && child.length >= 2,
				`${slug}: not single-quoted`,
			).toBe(true);
			const inner = child.slice(1, -1).replace(/''/g, "'");
			let parsed: unknown = null;
			try {
				parsed = JSON.parse(inner);
			} catch {
				parsed = null;
			}
			expect(Array.isArray(parsed), `${slug}: inner is not a JSON array`).toBe(
				true,
			);
			if (!Array.isArray(parsed)) continue;
			const round = yamlJsonString(parsed.map(String));
			expect(child === round, `${slug}: not yamlJsonString-canonical`).toBe(
				true,
			);
		}
	});

	test('the previously-legacy survivors declare the metadata-child triggers', () => {
		for (const slug of MIGRATED_SLUGS) {
			const frontmatter = readFrontmatter(slug);
			expect(
				metadataTriggersChild(frontmatter),
				`${slug}: missing metadata-child triggers`,
			).toBeTruthy();
		}
	});
});
