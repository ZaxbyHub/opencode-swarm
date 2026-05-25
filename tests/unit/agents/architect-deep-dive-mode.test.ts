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

	test('3. No final finding may appear without verification — evidence rule', () => {
		expect(content).toContain(
			'No final finding may appear in the report without reviewer verification',
		);
	});

	test('4. BEHAVIORAL_GUIDANCE_START count is exactly 8', () => {
		const matches = content.match(/<!--\s*BEHAVIORAL_GUIDANCE_START\s*-->/g);
		expect(matches).not.toBeNull();
		expect(matches!.length).toBe(8);
	});

	test('5. Section is between MODE: COUNCIL and MODE: ISSUE_INGEST', () => {
		const councilIndex = content.indexOf('### MODE: COUNCIL');
		const deepDiveIndex = content.indexOf('### MODE: DEEP_DIVE');
		const issueIngestIndex = content.indexOf('### MODE: ISSUE_INGEST');

		expect(councilIndex).toBeGreaterThan(-1);
		expect(deepDiveIndex).toBeGreaterThan(-1);
		expect(issueIngestIndex).toBeGreaterThan(-1);

		expect(deepDiveIndex).toBeGreaterThan(councilIndex);
		expect(issueIngestIndex).toBeGreaterThan(deepDiveIndex);
	});
});
