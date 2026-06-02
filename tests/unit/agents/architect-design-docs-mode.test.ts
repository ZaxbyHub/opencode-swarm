/**
 * Verifies the MODE: DESIGN_DOCS wiring in architect.ts and that the design-doc
 * sync is kept out of the standard phase-wrap docs auto-dispatch (issue #1080).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArchitectAgent } from '../../../src/agents/architect';

const ARCHITECT = readFileSync(
	join(process.cwd(), 'src/agents/architect.ts'),
	'utf-8',
);

describe('MODE: DESIGN_DOCS protocol elements in architect.ts', () => {
	test('section header exists', () => {
		expect(ARCHITECT).toContain('### MODE: DESIGN_DOCS');
	});

	test('loads the design-docs skill on demand', () => {
		expect(ARCHITECT).toContain('file:.opencode/skills/design-docs/SKILL.md');
	});

	test('delegates authoring to docs_design and renders its target', () => {
		expect(ARCHITECT).toContain('docs_design');
		expect(ARCHITECT).toContain(
			"the active swarm's docs_design agent = @{{AGENT_PREFIX}}docs_design",
		);
	});

	test('section is placed between DEEP_DIVE and ISSUE_INGEST', () => {
		const deepDive = ARCHITECT.indexOf('### MODE: DEEP_DIVE');
		const designDocs = ARCHITECT.indexOf('### MODE: DESIGN_DOCS');
		const issueIngest = ARCHITECT.indexOf('### MODE: ISSUE_INGEST');
		expect(deepDive).toBeGreaterThan(-1);
		expect(designDocs).toBeGreaterThan(deepDive);
		expect(issueIngest).toBeGreaterThan(designDocs);
	});
});

describe('createArchitectAgent strips DESIGN_DOCS when disabled (opt-in)', () => {
	// Param order: model, prompt?, append?, adversarial?, council?, uiReview?,
	// memoryEnabled, archSupervision?, designDocsEnabled.
	function buildPrompt(designDocsEnabled: boolean): string {
		const def = createArchitectAgent(
			'm',
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			designDocsEnabled,
		);
		return def.config.prompt ?? '';
	}

	test('disabled: no MODE: DESIGN_DOCS, no docs_design in roster or render list', () => {
		const p = buildPrompt(false);
		expect(p).not.toContain('### MODE: DESIGN_DOCS');
		expect(p).not.toContain('docs_design');
	});

	test('enabled: MODE: DESIGN_DOCS present and docs_design referenced', () => {
		const p = buildPrompt(true);
		expect(p).toContain('### MODE: DESIGN_DOCS');
		expect(p).toContain('docs_design');
		// The strip must not have eaten the following mode.
		expect(p).toContain('### MODE: ISSUE_INGEST');
	});
});

describe('phase-wrap keeps docs_design out of the standard docs auto-dispatch', () => {
	for (const tree of ['.opencode', '.claude']) {
		test(`${tree}/skills/phase-wrap/SKILL.md guards step 2`, () => {
			const skill = readFileSync(
				join(process.cwd(), tree, 'skills/phase-wrap/SKILL.md'),
				'utf-8',
			);
			// Step 2 explicitly excludes docs_design from the standard auto-dispatch...
			expect(skill).toContain('NOT `docs_design`');
			// ...and the dedicated design-doc sync step exists and is conditional.
			expect(skill).toContain('5.58');
			expect(skill).toContain('design_docs.enabled');
		});
	}
});
