/**
 * Issue #3216: generated-skill frontmatter convergence.
 *
 * After the #3216 migration NO generated skill may carry a legacy top-level
 * `triggers:` key (trigger phrases live under `metadata:`), and every
 * generated SKILL.md's `name:` must equal its directory slug. Scans the REAL
 * repo tree (`.opencode/skills/generated`), so both assertions are RED at the
 * unfixed base (13 top-level `triggers:` files, one name/slug mismatch) and
 * GREEN once the migration lands.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const GENERATED_ROOT = join(ROOT, '.opencode', 'skills', 'generated');

/**
 * Frontmatter lines between the opening and closing `---` fences (empty when
 * the file has no well-formed fence pair). `.trim()` on the fence lines also
 * tolerates a UTF-8 BOM (ZWNBSP is trim-classified whitespace), matching how
 * the production frontmatter readers scan.
 */
function frontmatterLines(content: string): string[] {
	const lines = content.split(/\r?\n/);
	if (lines[0]?.trim() !== '---') return [];
	const end = lines.findIndex(
		(line, index) => index > 0 && line.trim() === '---',
	);
	if (end === -1) return [];
	return lines.slice(1, end);
}

function declaredName(frontmatter: string[]): string | undefined {
	for (const line of frontmatter) {
		const match = line.match(/^name:\s*(.*)$/);
		if (match) return match[1].trim().replace(/^["']|["']$/g, '');
	}
	return undefined;
}

function generatedSlugs(): string[] {
	return readdirSync(GENERATED_ROOT, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

describe('generated skill frontmatter convergence (issue #3216)', () => {
	test('no generated skill carries a legacy top-level triggers key', () => {
		const offenders: string[] = [];
		for (const slug of generatedSlugs()) {
			const frontmatter = frontmatterLines(
				readFileSync(join(GENERATED_ROOT, slug, 'SKILL.md'), 'utf8'),
			);
			if (/^triggers:/m.test(frontmatter.join('\n'))) offenders.push(slug);
		}
		// Frozen RED marker — prints the offender list when the tree regresses
		// (13 at the unfixed base tree); the green path stays silent.
		if (offenders.length > 0) {
			console.log(`top-level triggers files: ${offenders.length}`);
		}
		expect(offenders).toEqual([]);
	});

	test('every generated skill name equals its directory slug', () => {
		const mismatches: string[] = [];
		for (const slug of generatedSlugs()) {
			const frontmatter = frontmatterLines(
				readFileSync(join(GENERATED_ROOT, slug, 'SKILL.md'), 'utf8'),
			);
			if (declaredName(frontmatter) !== slug) {
				console.log(`name/slug mismatch: ${slug}`);
				mismatches.push(slug);
			}
		}
		expect(mismatches).toEqual([]);
	});
});
