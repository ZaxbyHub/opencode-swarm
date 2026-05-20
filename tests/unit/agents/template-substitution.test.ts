import { describe, expect, test } from 'bun:test';
import {
	bulletList,
	emptyProjectContext,
	escapeForTemplate,
	renderPrompt,
	UNRESOLVED,
} from '../../../src/agents/template';

describe('renderPrompt', () => {
	test('substitutes a single known placeholder', () => {
		const ctx = { ...emptyProjectContext(), PROJECT_LANGUAGE: 'Python' };
		const out = renderPrompt('Language: {{PROJECT_LANGUAGE}}', ctx);
		expect(out).toBe('Language: Python');
	});

	test('substitutes multiple placeholders in one pass', () => {
		const ctx = {
			...emptyProjectContext(),
			PROJECT_LANGUAGE: 'Rust',
			BUILD_CMD: 'cargo build',
			TEST_CMD: 'cargo test',
		};
		const out = renderPrompt(
			'L: {{PROJECT_LANGUAGE}}\nB: {{BUILD_CMD}}\nT: {{TEST_CMD}}',
			ctx,
		);
		expect(out).toBe('L: Rust\nB: cargo build\nT: cargo test');
	});

	test('throws on unknown placeholder', () => {
		const ctx = emptyProjectContext();
		expect(() => renderPrompt('Hello {{NOT_A_KEY}}', ctx)).toThrow(
			/unknown placeholder/,
		);
	});

	test('throws once with all unknown placeholders listed', () => {
		const ctx = emptyProjectContext();
		expect(() => renderPrompt('{{FOO}} and {{BAR}} and {{BAZ}}', ctx)).toThrow(
			/\{\{FOO\}\}.*\{\{BAR\}\}.*\{\{BAZ\}\}/,
		);
	});

	test('leaves non-placeholder text unchanged (curly braces, JSON, etc.)', () => {
		const ctx = emptyProjectContext();
		const json = '{"x": 1}';
		const out = renderPrompt(`Output: ${json}`, ctx);
		expect(out).toBe(`Output: ${json}`);
	});

	test('substitutes UNRESOLVED sentinel string when value is unresolved', () => {
		const ctx = emptyProjectContext();
		const out = renderPrompt('Test command: {{TEST_CMD}}', ctx);
		expect(out).toContain(UNRESOLVED);
		expect(out).toContain('run /swarm preflight');
	});

	test('placeholders with the same key substituted in all occurrences', () => {
		const ctx = { ...emptyProjectContext(), PROJECT_LANGUAGE: 'Go' };
		const out = renderPrompt(
			'1:{{PROJECT_LANGUAGE}} 2:{{PROJECT_LANGUAGE}} 3:{{PROJECT_LANGUAGE}}',
			ctx,
		);
		expect(out).toBe('1:Go 2:Go 3:Go');
	});

	test('empty prompt yields empty string', () => {
		expect(renderPrompt('', emptyProjectContext())).toBe('');
	});

	test('prompt with no placeholders is returned verbatim', () => {
		const s = 'A static prompt with no template variables.';
		expect(renderPrompt(s, emptyProjectContext())).toBe(s);
	});
});

describe('escapeForTemplate', () => {
	test('escapes backticks (otherwise terminates a TS template literal)', () => {
		expect(escapeForTemplate('use `bun:test`')).toBe('use \\`bun:test\\`');
	});

	test('escapes ${...} (otherwise begins interpolation)', () => {
		expect(escapeForTemplate('cost: ${100}')).toBe('cost: \\${100}');
	});

	test('passes other characters unchanged', () => {
		expect(escapeForTemplate('plain text 123 ☃')).toBe('plain text 123 ☃');
	});

	test('preserves single backslashes (template-literal parsing already done)', () => {
		expect(escapeForTemplate('path\\to\\file')).toBe('path\\to\\file');
	});

	test('handles backtick + dollar-brace combination from real coder constraints', () => {
		const input = 'use `${PROJECT_LANGUAGE}` consistently';
		const escaped = escapeForTemplate(input);
		expect(escaped).toBe('use \\`\\${PROJECT_LANGUAGE}\\` consistently');
	});
});

describe('bulletList', () => {
	test('formats array as escaped bulleted block', () => {
		const out = bulletList(['Use `bun:test` for tests', 'Avoid `any` types']);
		expect(out).toBe('- Use \\`bun:test\\` for tests\n- Avoid \\`any\\` types');
	});

	test('returns empty string for empty array', () => {
		expect(bulletList([])).toBe('');
	});

	test('handles single-item array', () => {
		expect(bulletList(['only one'])).toBe('- only one');
	});
});

describe('emptyProjectContext', () => {
	test('all string fields are populated', () => {
		const ctx = emptyProjectContext();
		// Constraints/checklists default to empty (no language detected),
		// not the UNRESOLVED sentinel — embedding the sentinel into a
		// constraint list would render as "- unresolved (run /swarm
		// preflight)" which reads as a fake bullet point.
		expect(ctx.CODER_CONSTRAINTS).toBe('');
		expect(ctx.TEST_CONSTRAINTS).toBe('');
		expect(ctx.REVIEWER_CHECKLIST).toBe('');
		expect(ctx.PROJECT_CONTEXT_SECONDARY_LANGUAGES).toBe('');
		// The UI-visible single-value placeholders use the sentinel so the
		// architect's DISCOVER mode triggers cleanly.
		expect(ctx.PROJECT_LANGUAGE).toBe(UNRESOLVED);
		expect(ctx.BUILD_CMD).toBe(UNRESOLVED);
		expect(ctx.TEST_CMD).toBe(UNRESOLVED);
		expect(ctx.LINT_CMD).toBe(UNRESOLVED);
	});
});
