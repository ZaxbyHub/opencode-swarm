import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ARCHITECT_PATH = join(process.cwd(), 'src/agents/architect.ts');
const content = readFileSync(ARCHITECT_PATH, 'utf-8');

describe('MODE: DEEP_DIVE protocol elements in architect.ts', () => {
	test('1. MODE: DEEP_DIVE section header exists', () => {
		expect(content).toContain('MODE: DEEP_DIVE');
	});

	test('2. Do NOT delegate to coder — read-only constraint', () => {
		expect(content).toContain('does NOT delegate to coder');
	});

	test('3. Explorers generate candidate findings only — explorer role boundary', () => {
		expect(content).toContain('Explorers generate CANDIDATE FINDINGS only');
	});

	test('4. Reviewers verify or reject — reviewer role boundary', () => {
		expect(content).toContain('Verify or reject each candidate finding');
	});

	test('5. Critics challenge only HIGH/CRITICAL — critic scope constraint', () => {
		expect(content).toContain(
			'Only HIGH and CRITICAL go through critic review',
		);
	});

	test('6. Agent prefix usage — reviewer/critic/explorer prefixes', () => {
		expect(content).toContain('{{AGENT_PREFIX}}reviewer');
		expect(content).toContain('{{AGENT_PREFIX}}critic');
		expect(content).toContain('{{AGENT_PREFIX}}explorer');
	});

	test('7. No final finding may appear without verification — evidence rule', () => {
		expect(content).toContain(
			'No final finding may appear in the report without reviewer verification',
		);
	});

	test('8. BEHAVIORAL_GUIDANCE_START count is exactly 8', () => {
		const matches = content.match(/<!--\s*BEHAVIORAL_GUIDANCE_START\s*-->/g);
		expect(matches).not.toBeNull();
		expect(matches!.length).toBe(8);
	});

	test('9. Section is between MODE: COUNCIL and MODE: ISSUE_INGEST', () => {
		const councilIndex = content.indexOf('### MODE: COUNCIL');
		const deepDiveIndex = content.indexOf('### MODE: DEEP_DIVE');
		const issueIngestIndex = content.indexOf('### MODE: ISSUE_INGEST');

		expect(councilIndex).toBeGreaterThan(-1);
		expect(deepDiveIndex).toBeGreaterThan(-1);
		expect(issueIngestIndex).toBeGreaterThan(-1);

		expect(deepDiveIndex).toBeGreaterThan(councilIndex);
		expect(issueIngestIndex).toBeGreaterThan(deepDiveIndex);
	});

	test('10. All 8 lane templates are named', () => {
		expect(content).toContain('SCOPE_MAP');
		expect(content).toContain('WIRING_DATAFLOW');
		expect(content).toContain('RUNTIME_BEHAVIOR');
		expect(content).toContain('UX_FLOW');
		expect(content).toContain('SECURITY_TRUST');
		expect(content).toContain('TEST_COVERAGE');
		expect(content).toContain('PERFORMANCE_RELIABILITY');
		expect(content).toContain('DOCS_CONFIG_DEPLOYMENT');
	});

	test('11. All 5 profiles are named', () => {
		expect(content).toContain('standard');
		expect(content).toContain('security');
		expect(content).toContain('ux');
		expect(content).toContain('architecture');
		expect(content).toContain('full');
	});

	test('12. 2 parallel reviewers constraint', () => {
		expect(content).toContain('ALWAYS 2 PARALLEL REVIEWERS');
	});

	test('13. 8-file cap for explorer missions', () => {
		expect(content).toContain('8 files maximum per mission');
	});

	test('14. ~3500 line guardrail', () => {
		expect(content).toContain(
			'~3500 total lines across all files in a mission',
		);
	});
});
