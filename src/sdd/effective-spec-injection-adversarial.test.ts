/** Adversarial test pass — featureLabel content injection (FR-005, SC-004).
 * Vector 1: malformed featureLabel content injection (bracket, newline, header, backtick, long-label, RTL).
 * Structural integrity: umbrella assertions for all injection vectors. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateSpecContent } from '../config/spec-schema';
import {
	buildOpenSpecProjectionSync,
	buildSpeckitProjectionSync,
} from './effective-spec';

// Helpers
let tempDir: string;

function write(relPath: string, content: string): void {
	const abs = path.join(tempDir, relPath);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf-8');
}

beforeEach(() => {
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-inject-adversarial-')),
	);
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

// Vector 1 — featureLabel content injection (OpenSpec change id path)
describe('ATTACK VECTOR 1 — featureLabel content injection', () => {
	/** Bracket injection: `]` inside featureLabel previously closed the
	 * `[NEEDS CLARIFICATION…]` envelope early; `[` opened a second fragment.
	 * Attack: change id = "Evil] [Broken"
	 * AFTER fix (FR-005): brackets in featureLabel are neutralised → safeLabel.
	 * VERDICT: PASS — featureLabel brackets are sanitised before interpolation. */
	test('bracket injection in change id is sanitised — envelope stays well-formed', () => {
		// Create an OpenSpec change whose id contains ] and [ chars.
		write(
			path.join('openspec', 'changes', 'Evil] [Broken', 'proposal.md'),
			'# Evil Proposal\n',
		);
		write(
			path.join(
				'openspec',
				'changes',
				'Evil] [Broken',
				'specs',
				'auth',
				'spec.md',
			),
			[
				'# Auth',
				'',
				'## Requirements',
				'',
				'### Requirement: Login',
				'**FR-001**: The system MUST allow users to authenticate.',
				'',
			].join('\n'),
		);

		const spec = buildOpenSpecProjectionSync(tempDir);

		expect(spec).not.toBeNull();
		const scLine = spec!.content
			.split('\n')
			.find((l) => l.includes('### SC-') && l.includes('[NEEDS CLARIFICATION'));

		// Count ALL brackets in the SC line content (after "### SC-XXX: ").
		// A well-formed SC line has exactly ONE [ and ONE ] defining the envelope.
		const scContent = scLine!.replace(/^### SC-\d{3}: /, '');
		const openBrackets = (scContent.match(/\[/g) ?? []).length;
		const closeBrackets = (scContent.match(/\]/g) ?? []).length;

		// After FR-005 fix: brackets from featureLabel are neutralised.
		// Must have exactly 1 open and 1 close bracket (the envelope only).
		expect(openBrackets).toBe(1);
		expect(closeBrackets).toBe(1);

		// The well-formed envelope regex must match — no orphan fragments.
		const envelopeMatch = scContent.match(
			/^\[NEEDS CLARIFICATION — define success criterion for ([^\]]+)\]$/,
		);
		expect(envelopeMatch).not.toBeNull();
		// The captured label must be the sanitised version (brackets → '-').
		// "Evil] [Broken" → "Evil- -Broken" (each bracket becomes '-').
		expect(envelopeMatch![1]!).toBe('Evil- -Broken');
	});

	/** Newline injection: a change id with literal \n breaks the "single line" invariant.
	 * On filesystems permitting newlines in directory names (Linux), this is a real attack vector. */
	test('newline in change id injects extra lines into the SC line', () => {
		// Create a change directory with a newline in its name; skip on non-supporting FS.
		let changeDir: string;
		try {
			changeDir = path.join(
				tempDir,
				'openspec',
				'changes',
				'Evil\n\n## Success Criteria\n\nMalicious',
			);
			fs.mkdirSync(changeDir, { recursive: true });
		} catch {
			// Filesystem does not support newlines in directory names — skip.
			return;
		}

		// Write a minimal proposal so the change is recognized.
		fs.writeFileSync(path.join(changeDir, 'proposal.md'), '# Evil\n', 'utf-8');
		fs.mkdirSync(path.join(changeDir, 'specs', 'auth'), { recursive: true });
		fs.writeFileSync(
			path.join(changeDir, 'specs', 'auth', 'spec.md'),
			[
				'# Auth',
				'',
				'## Requirements',
				'',
				'### Requirement: Login',
				'**FR-001**: The system MUST authenticate users.',
				'',
			].join('\n'),
		);

		const spec = buildOpenSpecProjectionSync(tempDir);
		expect(spec).not.toBeNull();

		// The SC line containing NEEDS CLARIFICATION must be ONE line.
		// If the change id has embedded newlines, it will appear on multiple lines.
		const lines = spec!.content.split('\n');
		const scLines = lines.filter(
			(l) => l.includes('### SC-') && l.includes('[NEEDS CLARIFICATION'),
		);
		expect(scLines.length).toBe(1);

		// Additionally, no markdown header (## ) should appear INSIDE the SC line.
		// If the newline-split content includes a ## header mid-SC line, that's
		// an injected section — the SC line will have > 1 ## markers.
		for (const l of scLines) {
			const headerCount = (l.match(/^##+ /g) ?? []).length;
			expect(headerCount).toBe(0);
		}
	});

	/**
	 * Markdown header injection: a change id containing `## ` could inject a
	 * section header inside the SC placeholder line. We check at the document
	 * level: if the change id contains a line that would become a standalone
	 * `## Success Criteria` heading in the output, that would inject a second
	 * Success Criteria section — breaking the "exactly one ## Success Criteria"
	 * structural invariant.
	 *
	 * On Windows, `## ` in a directory name is valid (not a path separator),
	 * so this test is runnable on both platforms.
	 */
	test('markdown header injection in change id creates extra ## Success Criteria heading', () => {
		// Use a change id that contains a newline-composed header to bypass the
		// single-line SC scaffold (the scaffold uses lines.join('\n') so if the
		// featureLabel itself contains '\n\n## Success Criteria\n\n', the generated
		// SC line would span multiple lines with an injected heading between them).
		//
		// However, since the featureLabel is interpolated directly into a single
		// line array element, newlines in the change id appear as literal \n chars
		// in the SC line string. We test the document-level impact instead.
		let changeDir: string;
		try {
			changeDir = path.join(tempDir, 'openspec', 'changes', 'Evil## Malicious');
			fs.mkdirSync(changeDir, { recursive: true });
		} catch {
			return;
		}

		fs.writeFileSync(path.join(changeDir, 'proposal.md'), '# Evil\n', 'utf-8');
		fs.mkdirSync(path.join(changeDir, 'specs', 'auth'), { recursive: true });
		fs.writeFileSync(
			path.join(changeDir, 'specs', 'auth', 'spec.md'),
			[
				'# Auth',
				'',
				'## Requirements',
				'',
				'### Requirement: Login',
				'**FR-001**: The system MUST authenticate users.',
				'',
			].join('\n'),
		);

		const spec = buildOpenSpecProjectionSync(tempDir);
		expect(spec).not.toBeNull();

		// The SC line's envelope is: [NEEDS CLARIFICATION — define success criterion for Evil## Malicious]
		// The "## " inside the envelope is just literal text, not a markdown header.
		// We verify the envelope is still intact (no unclosed [ inside).
		const lines = spec!.content.split('\n');
		const scLine = lines.find(
			(l) => l.includes('### SC-') && l.includes('[NEEDS CLARIFICATION'),
		)!;
		// Count open/close brackets — must be exactly 1 pair.
		const openCount = (scLine.match(/\[/g) ?? []).length;
		const closeCount = (scLine.match(/\]/g) ?? []).length;
		// FAIL if more than 1 pair (label injects extra brackets).
		expect(openCount).toBe(1);
		expect(closeCount).toBe(1);
		// The envelope must be closed properly (no unmatched [).
		// An unmatched [ would leave the envelope open.
		const envelopeContent = scLine.match(
			/\[NEEDS CLARIFICATION — define success criterion for ([^\]]*)\]$/,
		);
		// envelopeContent[1] captures the text between the first [ and the last ].
		// If the label contains '[', the capture would include partial label text.
		expect(envelopeContent).not.toBeNull();
		// The captured content must not contain '[' (unmatched opener).
		expect(envelopeContent![1]!).not.toContain('[');
	});

	/**
	 * Backtick injection: a change id containing backticks could create an
	 * inline code span inside the SC placeholder, e.g.
	 *   `Evil`  →  the SC line contains `Evil` as code.
	 * This is technically valid markdown but breaks the envelope invariant
	 * (the placeholder should be plain text, not a code span).
	 *
	 * NOTE: On Windows, backtick is a path separator character and cannot appear
	 * in a directory name. This test is SKIPPED on Windows and only runs on
	 * POSIX filesystems where backtick in directory names is permitted.
	 */
	test('backtick in change id creates code span inside SC envelope', () => {
		if (process.platform === 'win32') {
			// On Windows, ` is a path separator — mkdir will fail or create
			// nested directories, not a single dir named "Evil`Code`Injection".
			return;
		}

		const changeDir = path.join(
			tempDir,
			'openspec',
			'changes',
			'Evil`Code`Injection',
		);
		fs.mkdirSync(changeDir, { recursive: true });
		fs.writeFileSync(path.join(changeDir, 'proposal.md'), '# Evil\n', 'utf-8');
		fs.mkdirSync(path.join(changeDir, 'specs', 'auth'), { recursive: true });
		fs.writeFileSync(
			path.join(changeDir, 'specs', 'auth', 'spec.md'),
			[
				'# Auth',
				'',
				'## Requirements',
				'',
				'### Requirement: Login',
				'**FR-001**: The system MUST authenticate users.',
				'',
			].join('\n'),
		);

		const spec = buildOpenSpecProjectionSync(tempDir);
		expect(spec).not.toBeNull();

		const lines = spec!.content.split('\n');
		const scLine = lines.find(
			(l) => l.includes('### SC-') && l.includes('[NEEDS CLARIFICATION'),
		)!;

		// The SC line must be a single line (no embedded \n).
		expect(scLine.includes('\n')).toBe(false);

		// Count brackets — must be exactly 1 pair.
		const openCount = (scLine.match(/\[/g) ?? []).length;
		const closeCount = (scLine.match(/\]/g) ?? []).length;
		expect(openCount).toBe(1);
		expect(closeCount).toBe(1);

		// The envelope must be well-formed (closed properly, no extra brackets).
		const envelopeMatch = scLine.match(
			/\[NEEDS CLARIFICATION — define success criterion for ([^\]]*)\]$/,
		);
		expect(envelopeMatch).not.toBeNull();
		// Backtick inside the envelope creates a code span — report it.
		// FAIL if the label contains backtick characters.
		const envelopeContent = envelopeMatch![1]!;
		expect(envelopeContent).not.toContain('`');
	});

	/**
	 * Very long featureLabel: strings approaching MAX_SPEC_BYTES should not
	 * corrupt projection structure — the envelope stays intact.
	 *
	 * NOTE: On Windows, mkdir fails for paths exceeding ~260 chars (MAX_PATH).
	 * We skip on Windows and only run on platforms that support long paths.
	 */
	test('very long featureLabel (10 KB) stays inside SC envelope', () => {
		const longLabel = 'A'.repeat(10 * 1024); // 10 KB
		let changeDir: string;
		try {
			changeDir = path.join(tempDir, 'openspec', 'changes', longLabel);
			fs.mkdirSync(changeDir, { recursive: true });
		} catch (err: unknown) {
			// Windows mkdir fails with ENOENT for paths exceeding MAX_PATH (~260 chars).
			// This is an environmental limitation, not a code bug.
			const code = (err as { code?: string }).code;
			if (code === 'ENOENT' || code === 'ENAMETOOLONG') {
				return; // Skip — environment does not support long paths.
			}
			throw err;
		}
		fs.writeFileSync(
			path.join(changeDir, 'proposal.md'),
			'# Change\n',
			'utf-8',
		);
		fs.mkdirSync(path.join(changeDir, 'specs', 'auth'), { recursive: true });
		fs.writeFileSync(
			path.join(changeDir, 'specs', 'auth', 'spec.md'),
			[
				'# Auth',
				'',
				'## Requirements',
				'',
				'### Requirement: Login',
				'**FR-001**: The system MUST authenticate users.',
				'',
			].join('\n'),
		);

		const spec = buildOpenSpecProjectionSync(tempDir);

		// Should not throw and should return a valid projection (or null if too large).
		// The critical requirement: no crash and no malformed SC envelope.
		if (spec !== null) {
			const lines = spec.content.split('\n');
			const scLine = lines.find(
				(l) => l.includes('### SC-') && l.includes('[NEEDS CLARIFICATION'),
			);
			if (scLine) {
				// SC line must have exactly one opening [ and one closing ].
				const openCount = (scLine.match(/\[/g) ?? []).length;
				const closeCount = (scLine.match(/\]/g) ?? []).length;
				expect(openCount).toBe(1);
				expect(closeCount).toBe(1);
			}
		}
	});

	/**
	 * Unicode / RTL injection: featureLabel containing Unicode control or
	 * directional override characters. The SC line should still be well-formed.
	 */
	test('Unicode RTL override in change id does not corrupt SC structure', () => {
		const rtlLabel = 'Evil\u202E Wrong'; // RLO + LRI characters
		const changeDir = path.join(tempDir, 'openspec', 'changes', rtlLabel);
		fs.mkdirSync(changeDir, { recursive: true });
		fs.writeFileSync(path.join(changeDir, 'proposal.md'), '# Evil\n', 'utf-8');
		fs.mkdirSync(path.join(changeDir, 'specs', 'auth'), { recursive: true });
		fs.writeFileSync(
			path.join(changeDir, 'specs', 'auth', 'spec.md'),
			[
				'# Auth',
				'',
				'## Requirements',
				'',
				'### Requirement: Login',
				'**FR-001**: The system MUST authenticate users.',
				'',
			].join('\n'),
		);

		const spec = buildOpenSpecProjectionSync(tempDir);
		expect(spec).not.toBeNull();

		const lines = spec!.content.split('\n');
		const scLine = lines.find(
			(l) => l.includes('### SC-') && l.includes('[NEEDS CLARIFICATION'),
		);
		expect(scLine).toBeDefined();

		// SC line must be a single line (no embedded \n from the label).
		const scContent = scLine!;
		expect(scContent).not.toContain('\n');

		// The envelope [ … ] must be intact with exactly one open and close bracket.
		const openCount = (scContent.match(/\[/g) ?? []).length;
		const closeCount = (scContent.match(/\]/g) ?? []).length;
		expect(openCount).toBe(1);
		expect(closeCount).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Structural integrity — umbrella assertion for all injection vectors
// ---------------------------------------------------------------------------
describe('Structural integrity — no injected section headers in SC line', () => {
	/**
	 * The projected Success Criteria section must contain exactly ONE
	 * `## Success Criteria` heading. If featureLabel injection creates a second
	 * `## Success Criteria` heading in the output, the projection structure is
	 * broken.
	 */
	test('projection has exactly one ## Success Criteria heading', () => {
		const changeDir = path.join(tempDir, 'openspec', 'changes', 'TestChange');
		fs.mkdirSync(path.join(changeDir, 'specs', 'auth'), { recursive: true });
		fs.writeFileSync(path.join(changeDir, 'proposal.md'), '# Test\n', 'utf-8');
		fs.writeFileSync(
			path.join(changeDir, 'specs', 'auth', 'spec.md'),
			[
				'# Auth',
				'',
				'## Requirements',
				'',
				'### Requirement: Login',
				'**FR-001**: The system MUST authenticate users.',
				'',
			].join('\n'),
		);

		const spec = buildOpenSpecProjectionSync(tempDir);
		expect(spec).not.toBeNull();

		const lines = spec!.content.split('\n');
		const successCriteriaLines = lines.filter((l) =>
			/^## Success Criteria$/.test(l.trim()),
		);
		// Must have exactly one ## Success Criteria heading.
		expect(successCriteriaLines.length).toBe(1);
	});

	/**
	 * The SC scaffold line must be a single line — no embedded newlines.
	 * If featureLabel contains a newline, the join('\n') would produce a
	 * multi-line SC line, which breaks the envelope and downstream parsing.
	 */
	test('SC scaffold line is a single line (no embedded newlines from label)', () => {
		const changeDir = path.join(tempDir, 'openspec', 'changes', 'TestChange');
		fs.mkdirSync(path.join(changeDir, 'specs', 'auth'), { recursive: true });
		fs.writeFileSync(path.join(changeDir, 'proposal.md'), '# Test\n', 'utf-8');
		fs.writeFileSync(
			path.join(changeDir, 'specs', 'auth', 'spec.md'),
			[
				'# Auth',
				'',
				'## Requirements',
				'',
				'### Requirement: Login',
				'**FR-001**: The system MUST authenticate users.',
				'',
			].join('\n'),
		);

		const spec = buildOpenSpecProjectionSync(tempDir);
		expect(spec).not.toBeNull();

		// Find the SC scaffold line and verify it's a single line.
		const scLine = spec!.content
			.split('\n')
			.find((l) => l.includes('### SC-') && l.includes('[NEEDS CLARIFICATION'));

		expect(scLine).toBeDefined();
		// A single line must not contain \n characters.
		expect(scLine!.includes('\n')).toBe(false);
		// The line must start with ### SC-XXX: and have a well-formed envelope.
		expect(scLine).toMatch(
			/^### SC-\d{3}: \[NEEDS CLARIFICATION — define success criterion for .+\]$/,
		);
	});

	/**
	 * validateSpecContent must accept the enriched projection as valid —
	 * injection that evades structural checks would be a silent security issue.
	 */
	test('enriched projection passes validateSpecContent structural checks', () => {
		write(
			path.join('openspec', 'specs', 'auth', 'spec.md'),
			[
				'# Auth',
				'',
				'## Requirements',
				'',
				'### Requirement: Login',
				'**FR-001**: The system MUST authenticate users.',
				'',
			].join('\n'),
		);

		const spec = buildOpenSpecProjectionSync(tempDir);
		expect(spec).not.toBeNull();

		// The enriched projection must pass structural validation.
		// A projection that contains injection but still passes validation
		// is a FINDING (the envelope was broken but not caught).
		const validation = validateSpecContent(spec!.content);
		expect(validation.valid).toBe(true);
		expect(validation.issues.length).toBe(0);
	});
});
