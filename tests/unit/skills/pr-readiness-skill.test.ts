import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SKILL_PATH = resolve('.opencode/skills/generated/pr-readiness/SKILL.md');

describe('pr-readiness skill file', () => {
	let content: string;

	test('file exists', () => {
		expect(() => readFileSync(SKILL_PATH, 'utf-8')).not.toThrow();
		content = readFileSync(SKILL_PATH, 'utf-8');
	});

	test('is a legacy compatibility shim to swarm-pr-feedback', () => {
		expect(content).toContain('Legacy compatibility shim');
		expect(content).toContain('Use `swarm-pr-feedback` skill instead');
		expect(content).toContain('.claude/skills/swarm-pr-feedback/SKILL.md');
	});

	test('does not duplicate the old readiness checklist', () => {
		expect(content).not.toContain('1. Lint pass');
		expect(content).not.toContain('## Invariant audit');
	});

	test('keeps generated skill metadata', () => {
		expect(content).toContain('skill_origin: generated');
		expect(content).toContain('status: active');
	});
});
