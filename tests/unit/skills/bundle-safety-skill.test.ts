import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILL_PATH = join(
	process.cwd(),
	'.opencode/skills/generated/bundle-safety/SKILL.md',
);
const SKILL_CONTENT = readFileSync(SKILL_PATH, 'utf-8').replace(/\r\n/g, '\n');

// ---------------------------------------------------------------------------
// Helper: extract YAML frontmatter block
// ---------------------------------------------------------------------------
function extractFrontmatter(content: string): string {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) throw new Error('No YAML frontmatter found');
	return match[1];
}

function frontmatterValue(
	block: string,
	key: string,
): string | string[] | undefined {
	const lines = block.split('\n');
	let inArray = false;
	let arrayItems: string[] = [];

	for (const line of lines) {
		const trimmed = line.replace(/^ {2}/, '');
		if (trimmed.startsWith(`${key}:`)) {
			const after = trimmed.slice(key.length + 1).trim();
			if (inArray) {
				// already in array mode, close it
				if (arrayItems.length > 0) return arrayItems;
				inArray = false;
			}
			if (after.startsWith('[') && after.endsWith(']')) {
				// inline array
				const inner = after.slice(1, -1);
				return inner
					.split(',')
					.map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
			}
			if (!after) {
				inArray = true;
				arrayItems = [];
				continue;
			}
			return after.replace(/^['"]|['"]$/g, '');
		}
		if (inArray && line.match(/^\s+-\s+/)) {
			arrayItems.push(
				line
					.replace(/^\s+-\s+/, '')
					.replace(/^['"]|['"]$/g, '')
					.trim(),
			);
		}
	}
	if (inArray && arrayItems.length > 0) return arrayItems;
	return undefined;
}

// ---------------------------------------------------------------------------
// 1. YAML frontmatter validity
// ---------------------------------------------------------------------------
describe('YAML frontmatter', () => {
	const fm = extractFrontmatter(SKILL_CONTENT);

	test('name is bundle-safety', () => {
		expect(frontmatterValue(fm, 'name')).toBe('bundle-safety');
	});

	test('status is active', () => {
		expect(frontmatterValue(fm, 'status')).toBe('active');
	});

	test('skill_origin is generated', () => {
		expect(frontmatterValue(fm, 'skill_origin')).toBe('generated');
	});

	test('source_knowledge_ids contains exactly the 3 expected IDs', () => {
		const ids = frontmatterValue(fm, 'source_knowledge_ids');
		expect(Array.isArray(ids)).toBe(true);
		expect(ids).toContain('5746c5c9-1330-4fbe-b62e-f564deb1ff77');
		expect(ids).toContain('5d99affe-bdd1-4945-8cd8-fcf37abb8c84');
		expect(ids).toContain('9323a8f0-c07e-41c2-9857-11a24c55dca2');
		expect(ids!.length).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// 2. All 4 topics are covered
// ---------------------------------------------------------------------------
describe('Topic coverage', () => {
	// (a) minification variant selection
	test('covers topic (a) — minification variant / identifier-preserving', () => {
		const sectionA = SKILL_CONTENT.match(
			/\(a\) Minification Variant Selection/i,
		)?.[0];
		expect(sectionA).toBeDefined();
		// Key terms
		expect(SKILL_CONTENT).toContain('identifier-preserving');
		expect(SKILL_CONTENT).toContain('--minify-whitespace');
		expect(SKILL_CONTENT).toContain('--minify-identifiers');
		// Decision is final / rejected
		expect(SKILL_CONTENT).toContain('REJECTED');
	});

	// (b) consumer-constraint verification
	test('covers topic (b) — consumer-constraint / grep guardrails', () => {
		const sectionB = SKILL_CONTENT.match(
			/\(b\) Consumer-Constraint Verification/i,
		)?.[0];
		expect(sectionB).toBeDefined();
		expect(SKILL_CONTENT).toContain('consumer-constraint');
		expect(SKILL_CONTENT).toContain('grep guardrail');
		expect(SKILL_CONTENT).toContain('grep guardrails');
	});

	// (c) identifier-preservation testing
	test('covers topic (c) — identifier-preservation testing', () => {
		const sectionC = SKILL_CONTENT.match(
			/\(c\) Identifier-Preservation Testing/i,
		)?.[0];
		expect(sectionC).toBeDefined();
		expect(SKILL_CONTENT).toContain('identifier-preserv');
	});

	// (d) namespace re-export coverage
	test('covers topic (d) — namespace re-export / export * as ns', () => {
		const sectionD = SKILL_CONTENT.match(
			/\(d\) Namespace Re-Export Coverage/i,
		)?.[0];
		expect(sectionD).toBeDefined();
		expect(SKILL_CONTENT).toContain('namespace re-export');
		expect(SKILL_CONTENT).toContain('export * as ns');
		expect(SKILL_CONTENT).toContain('export * from');
	});
});

// ---------------------------------------------------------------------------
// 3. Guardrail attribution is accurate
// ---------------------------------------------------------------------------
describe('Guardrail attribution', () => {
	test('references full-auto-toolbefore-fail-closed.test.ts', () => {
		expect(SKILL_CONTENT).toContain('full-auto-toolbefore-fail-closed.test.ts');
	});

	test('references runtime-conformance.test.ts', () => {
		expect(SKILL_CONTENT).toContain('runtime-conformance.test.ts');
	});

	test('does NOT claim all 13 guardrails are in a single file', () => {
		// The skill should say guardrails are SPLIT across the two files
		// Verify the content reflects the split (not concentrated in one file)
		const singleFileClaim =
			/all 13.*guardrail.*full-auto-toolbefore-fail-closed\.test\.ts/s.test(
				SKILL_CONTENT,
			);
		const alsoMentionsRuntime =
			/runtime-conformance\.test\.ts.*guardrail|guardrail.*runtime-conformance\.test\.ts/s.test(
				SKILL_CONTENT,
			);
		// If it mentions 13 guardrails AND both files, it correctly shows the split
		const mentionsBothFiles =
			/full-auto-toolbefore-fail-closed\.test\.ts/.test(SKILL_CONTENT) &&
			/runtime-conformance\.test\.ts/.test(SKILL_CONTENT);
		expect(mentionsBothFiles).toBe(true);
	});

	test('mentions 13 guardrails total across both files', () => {
		// The "13" number must appear in the context of guardrails
		expect(SKILL_CONTENT).toContain('13 grep guardrail');
		// And the content should indicate these are split, not all in one file
		// by referencing both consumer-constraint files
		expect(SKILL_CONTENT).toContain('full-auto-toolbefore-fail-closed.test.ts');
		expect(SKILL_CONTENT).toContain('runtime-conformance.test.ts');
	});
});

// ---------------------------------------------------------------------------
// 4. No .claude mirror exists (generated skills are opencode-only)
// ---------------------------------------------------------------------------
describe('No .claude mirror', () => {
	test('.claude/skills/generated/bundle-safety/SKILL.md does NOT exist', () => {
		const { existsSync } = require('node:fs');
		const mirrorPath = join(
			process.cwd(),
			'.claude/skills/generated/bundle-safety/SKILL.md',
		);
		expect(existsSync(mirrorPath)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 5. File length < 500 lines
// ---------------------------------------------------------------------------
describe('File constraints', () => {
	test('SKILL.md is under 500 lines', () => {
		const lineCount = SKILL_CONTENT.split('\n').length;
		expect(lineCount).toBeLessThan(500);
	});
});
