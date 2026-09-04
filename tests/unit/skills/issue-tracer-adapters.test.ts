/**
 * Adapter validation for issue-tracer v3.
 * Ensures adapters are thin shims referencing the canonical skill.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('issue-tracer v3 adapters', () => {
	const adapters = [
		'.claude/skills/issue-tracer/SKILL.md',
		'.agents/skills/issue-tracer/SKILL.md',
	];

	for (const adapterPath of adapters) {
		describe(`${adapterPath}`, () => {
			it('line count is less than 60', () => {
				const fullPath = join(process.cwd(), adapterPath);
				expect(existsSync(fullPath)).toBe(true);
				const content = readFileSync(fullPath, 'utf-8');
				const lines = content.trimEnd().split(/\r?\n/);
				expect(lines.length).toBeLessThan(60);
			});

			it('contains canonical reference path', () => {
				const fullPath = join(process.cwd(), adapterPath);
				const content = readFileSync(fullPath, 'utf-8');
				expect(content).toContain(
					'../../../.opencode/skills/issue-tracer/SKILL.md',
				);
			});

			it('contains "canonical workflow"', () => {
				const fullPath = join(process.cwd(), adapterPath);
				const content = readFileSync(fullPath, 'utf-8');
				expect(content).toContain('canonical workflow');
			});

			it('no line starts with "## Phase"', () => {
				const fullPath = join(process.cwd(), adapterPath);
				const content = readFileSync(fullPath, 'utf-8');
				const lines = content.split(/\r?\n/);
				const phaseLines = lines.filter((line) => line.startsWith('## Phase'));
				expect(phaseLines.length).toBe(0);
			});
		});
	}

	describe('canonical .opencode/skills/issue-tracer/SKILL.md', () => {
		it('contains no vendor or model names in body (outside frontmatter)', () => {
			const skillPath = join(
				process.cwd(),
				'.opencode/skills/issue-tracer/SKILL.md',
			);
			expect(existsSync(skillPath)).toBe(true);
			const content = readFileSync(skillPath, 'utf-8');

			// Extract body (after frontmatter)
			const parts = content.split(/^---$/m);
			const body = parts.length >= 3 ? parts[2] : content;

			// Check for vendor/model names
			const vendorPattern =
				/\b(Opus|Sonnet|Haiku|GPT|gpt-|Kimi|MiniMax|GLM|Gemini)\b/;
			expect(body.match(vendorPattern)).toBeNull();
		});

		it('no "Claude" outside of frontmatter description', () => {
			const skillPath = join(
				process.cwd(),
				'.opencode/skills/issue-tracer/SKILL.md',
			);
			const content = readFileSync(skillPath, 'utf-8');

			// Extract body
			const parts = content.split(/^---$/m);
			const body = parts.length >= 3 ? parts[2] : content;

			// Claude is not allowed in body (even in tool-binding context, adapters handle that)
			expect(body).not.toContain('Claude ');
		});
	});

	describe('reference files in .opencode/skills/issue-tracer/references/', () => {
		it('all reference files except install.md and method-provenance.md contain no vendor/model names', () => {
			const refDir = join(
				process.cwd(),
				'.opencode/skills/issue-tracer/references',
			);
			if (!existsSync(refDir)) {
				expect(true).toBe(true);
				return;
			}

			const fs = require('node:fs');
			const files = fs.readdirSync(refDir);
			const excluded = new Set(['install.md', 'method-provenance.md']);

			for (const file of files) {
				if (!file.endsWith('.md') || excluded.has(file)) {
					continue;
				}

				const filePath = join(refDir, file);
				const content = readFileSync(filePath, 'utf-8');
				const vendorPattern =
					/\b(Opus|Sonnet|Haiku|GPT|gpt-|Kimi|MiniMax|GLM|Gemini)\b/;

				const matches = content.match(vendorPattern);
				expect(matches).toBeNull(
					`${file} contains vendor/model name: ${matches ? matches[0] : ''}`,
				);
			}
		});
	});
});
