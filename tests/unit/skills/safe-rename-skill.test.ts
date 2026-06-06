/**
 * Verification tests for safe-rename SKILL.md
 * Task 2.1
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SKILL_PATH = resolve(
	process.cwd(),
	'.opencode/skills/generated/safe-rename/SKILL.md',
);

describe('safe-rename SKILL.md — Task 2.1 verification', () => {
	const content = readFileSync(SKILL_PATH, 'utf-8').replace(/\r\n/g, '\n');

	describe('1. File exists at correct path', () => {
		it('skill file exists', () => {
			expect(content.length).toBeGreaterThan(0);
		});
	});

	describe('2. Required sections present', () => {
		it('has "Required Tools" section', () => {
			expect(content).toContain('## Required Tools');
		});

		it('has "Workflow" section', () => {
			expect(content).toContain('## Workflow');
		});

		it('has "Limitations" section', () => {
			expect(content).toContain('## Limitations');
		});

		it('has "Checklist" section', () => {
			expect(content).toContain('## Checklist');
		});
	});

	describe('3. Mentions all required tools', () => {
		const requiredTools = [
			'repo_map',
			'batch_symbols',
			'symbols',
			'apply_patch', // task requirement
			'build_check',
			'test_runner',
		];

		for (const tool of requiredTools) {
			it(`mentions "${tool}"`, () => {
				expect(content).toContain(tool);
			});
		}
	});

	describe('4. Dry-run requirement documented', () => {
		it('has dry-run section with mandatory verification', () => {
			expect(content).toContain('Dry-run');
			expect(content).toContain('MANDATORY');
		});

		it('describes build_check as dry-run verification step', () => {
			// Step 6 should reference build_check for dry-run
			const step6Start = content.indexOf('### Step 6');
			const step7Start = content.indexOf('### Step 7');
			const step6Section = content.slice(step6Start, step7Start);
			expect(step6Section).toContain('build_check');
		});
	});

	describe('5. All 5 limitations documented', () => {
		const limitations = [
			{
				name: 'alias resolution',
				anchor: '### No alias resolution',
			},
			{
				name: 'type-awareness',
				anchor: '### No type-awareness',
			},
			{
				name: 'dynamic refs',
				anchor: '### Dynamic references',
			},
			{
				name: 're-exports',
				anchor: '### Re-exports and barrel files',
			},
			{
				name: 'non-code refs',
				anchor: '### Non-code references',
			},
		];

		for (const { name, anchor } of limitations) {
			it(`documents "${name}" limitation`, () => {
				expect(content).toContain(anchor);
			});
		}
	});

	describe('6. Checklist items present', () => {
		const checklistItems = [
			'Definition renamed in source file',
			'import statements updated',
			'usage sites updated',
			'Re-exports updated',
			'Import paths updated',
			'build_check',
			'Tests pass',
			'search',
		];

		for (const item of checklistItems) {
			it(`checklist contains "${item}"`, () => {
				expect(content).toContain(item);
			});
		}
	});
});
