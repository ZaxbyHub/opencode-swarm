/**
 * Content assertion tests for commit-pr SKILL.md issue-reference.json wiring.
 *
 * commit-pr is classified as `divergent` in skill-mirrors.ts — the .opencode
 * and .claude copies are intentionally different (portable vs repo-internal).
 * These tests verify that BOTH copies reference .swarm/issue-reference.json
 * for auto-populating the Closes line, without assuming identical structure.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OPENCODE_PATH = join(
	process.cwd(),
	'.opencode/skills/commit-pr/SKILL.md',
);
const CLAUDE_PATH = join(process.cwd(), '.claude/skills/commit-pr/SKILL.md');

/** Normalize CRLF to LF so tests pass on Windows git clones. */
function normalized(filePath: string): string {
	return readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
}

describe('commit-pr SKILL.md — issue-reference.json wiring', () => {
	it('both skill files exist', () => {
		expect(existsSync(OPENCODE_PATH)).toBe(true);
		expect(existsSync(CLAUDE_PATH)).toBe(true);
	});

	it('.opencode copy references issue-reference.json for Closes #N', () => {
		const content = normalized(OPENCODE_PATH);
		expect(content).toContain('issue-reference.json');
		expect(content).toContain('Closes #');
	});

	it('.claude copy references issue-reference.json for Closes #N', () => {
		const content = normalized(CLAUDE_PATH);
		expect(content).toContain('issue-reference.json');
		expect(content).toContain('Closes #');
	});

	it('.claude copy has Test-Path guard in PowerShell example', () => {
		const content = normalized(CLAUDE_PATH);
		expect(content).toContain('Test-Path');
		expect(content).toContain('$ref.number');
	});

	it('copies are divergent (not byte-identical) — commit-pr is classified divergent', () => {
		// commit-pr is intentionally divergent: .opencode is portable, .claude is repo-internal.
		// They must NOT be byte-identical.
		expect(normalized(OPENCODE_PATH)).not.toBe(normalized(CLAUDE_PATH));
	});
});
