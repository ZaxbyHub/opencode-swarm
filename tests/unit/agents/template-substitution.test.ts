import { describe, expect, test } from 'bun:test';
import {
	bulletList,
	emptyProjectContext,
	escapeForTemplate,
	UNRESOLVED,
} from '../../../src/agents/template';

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
