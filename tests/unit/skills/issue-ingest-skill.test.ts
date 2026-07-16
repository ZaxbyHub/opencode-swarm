/**
 * Content assertion tests for the issue-ingest SKILL.md mirrors.
 *
 * Verifies that three specific changes are present in both the .opencode and
 * .claude copies of the issue-ingest skill, and that the two copies remain
 * byte-identical (dual-tree mirror contract).
 *
 * Changes under test:
 * 1. Phase 1 INTAKE: step 2 reads .swarm/issue-reference.json
 * 2. Phase 3 SPEC GENERATION: step 0a includes ## Source Issue in spec.md
 * 3. Full file: zero swarm-implement references (replaced with issue-trace
 *    hook automatic ladder in both flag description and Phase 4)
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const OPENCODE_PATH = join(
	process.cwd(),
	'.opencode/skills/issue-ingest/SKILL.md',
);
const CLAUDE_PATH = join(process.cwd(), '.claude/skills/issue-ingest/SKILL.md');

function normalize(content: string): string {
	return content.replace(/\r\n/g, '\n');
}

function extractSection(content: string, headingPrefix: string): string {
	const lines = content.split('\n');
	const startIdx = lines.findIndex((l) => l.startsWith(headingPrefix));
	if (startIdx === -1) return '';
	// Section ends at the next heading of the same or higher level
	const depth = (lines[startIdx].match(/^#+/) ?? [''])[0].length;
	let endIdx = lines.length;
	for (let i = startIdx + 1; i < lines.length; i++) {
		const m = lines[i].match(/^(#{1,4})\s/);
		if (m && m[1].length <= depth) {
			endIdx = i;
			break;
		}
	}
	return lines.slice(startIdx, endIdx).join('\n');
}

describe('issue-ingest SKILL.md mirror content assertions', () => {
	it('both mirror files exist', () => {
		expect(existsSync(OPENCODE_PATH)).toBe(true);
		expect(existsSync(CLAUDE_PATH)).toBe(true);
	});

	it('.opencode and .claude copies are byte-identical', () => {
		const opencodeContent = normalize(readFileSync(OPENCODE_PATH, 'utf-8'));
		const claudeContent = normalize(readFileSync(CLAUDE_PATH, 'utf-8'));
		expect(claudeContent).toBe(opencodeContent);
	});

	describe('Phase 1 INTAKE — issue-reference.json step', () => {
		it('.claude Phase 1 mentions issue-reference.json', () => {
			const content = normalize(readFileSync(CLAUDE_PATH, 'utf-8'));
			const phase1 = extractSection(content, '#### Phase 1: INTAKE');
			expect(phase1.length).toBeGreaterThan(0);
			expect(phase1).toContain('issue-reference.json');
		});

		it('.opencode Phase 1 mentions issue-reference.json', () => {
			const content = normalize(readFileSync(OPENCODE_PATH, 'utf-8'));
			const phase1 = extractSection(content, '#### Phase 1: INTAKE');
			expect(phase1.length).toBeGreaterThan(0);
			expect(phase1).toContain('issue-reference.json');
		});
	});

	describe('Phase 3 SPEC GENERATION — ## Source Issue step', () => {
		it('.claude Phase 3 mentions ## Source Issue', () => {
			const content = normalize(readFileSync(CLAUDE_PATH, 'utf-8'));
			const phase3 = extractSection(content, '#### Phase 3: SPEC GENERATION');
			expect(phase3.length).toBeGreaterThan(0);
			expect(phase3).toContain('## Source Issue');
		});

		it('.opencode Phase 3 mentions ## Source Issue', () => {
			const content = normalize(readFileSync(OPENCODE_PATH, 'utf-8'));
			const phase3 = extractSection(content, '#### Phase 3: SPEC GENERATION');
			expect(phase3.length).toBeGreaterThan(0);
			expect(phase3).toContain('## Source Issue');
		});
	});

	describe('full-file — no swarm-implement references anywhere', () => {
		it('.claude file does not reference swarm-implement', () => {
			const content = normalize(readFileSync(CLAUDE_PATH, 'utf-8'));
			expect(content).not.toContain('swarm-implement');
		});

		it('.opencode file does not reference swarm-implement', () => {
			const content = normalize(readFileSync(OPENCODE_PATH, 'utf-8'));
			expect(content).not.toContain('swarm-implement');
		});
	});

	describe('Phase 4 TRANSITION — issue-trace hook references', () => {
		it('.claude Phase 4 mentions issue-trace hook', () => {
			const content = normalize(readFileSync(CLAUDE_PATH, 'utf-8'));
			const phase4 = extractSection(content, '#### Phase 4: TRANSITION');
			expect(phase4).toContain('issue-trace');
		});

		it('.opencode Phase 4 mentions issue-trace hook', () => {
			const content = normalize(readFileSync(OPENCODE_PATH, 'utf-8'));
			const phase4 = extractSection(content, '#### Phase 4: TRANSITION');
			expect(phase4).toContain('issue-trace');
		});
	});
});
