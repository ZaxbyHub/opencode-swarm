import { describe, expect, test } from 'bun:test';
// ARCHITECT_PROMPT is defined in architect.ts but not exported
// We read the source file directly to verify its contents
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { handleIssueCommand } from '../../../src/commands/issue';
import {
	COMMAND_REGISTRY,
	resolveCommand,
	VALID_COMMANDS,
} from '../../../src/commands/registry';

// Extract ARCHITECT_PROMPT from architect.ts source (it's not exported)
// Since import.meta.dir doesn't work reliably across environments,
// we use a known relative path from the test file location
function findWorkspaceRoot(): string {
	// Start from the test file directory and walk up to find package.json
	let dir = resolve(import.meta.dir);
	for (let i = 0; i < 10; i++) {
		try {
			readFileSync(resolve(dir, 'package.json'), 'utf-8');
			return dir;
		} catch {
			dir = resolve(dir, '..');
		}
	}
	throw new Error('Could not find workspace root');
}

function extractArchitectPrompt(): string {
	const workspaceRoot = findWorkspaceRoot();
	const filePath = resolve(workspaceRoot, 'src/agents/architect.ts');
	const content = readFileSync(filePath, 'utf-8');

	// Find the ARCHITECT_PROMPT template literal start
	const startMarker = 'const ARCHITECT_PROMPT = `';
	const startIdx = content.indexOf(startMarker);
	if (startIdx === -1) throw new Error('ARCHITECT_PROMPT not found');

	const actualBacktick = startIdx + startMarker.length; // position of opening backtick

	// Find the closing backtick: it's a `; that is NOT escaped (not preceded by \)
	// and is followed by newline and then 'export' or '/**'
	let endIdx = -1;
	for (let i = actualBacktick + 1; i < content.length - 3; i++) {
		if (
			content.charAt(i) === '`' &&
			content.charAt(i + 1) === ';' &&
			content.charAt(i - 1) !== '\\'
		) {
			// Check if followed by newline and then export or comment
			const after = content.substring(i + 2, i + 20).trim();
			if (after.startsWith('export') || after.startsWith('/**')) {
				endIdx = i;
				break;
			}
		}
	}

	if (endIdx === -1) throw new Error('Could not find end of ARCHITECT_PROMPT');

	return content.substring(actualBacktick + 1, endIdx);
}

const ARCHITECT_PROMPT = extractArchitectPrompt();

describe('Task 5.2 — Registry Registration', () => {
	describe('COMMAND_REGISTRY structure', () => {
		test('1. COMMAND_REGISTRY has an "issue" key', () => {
			expect(Object.hasOwn(COMMAND_REGISTRY, 'issue')).toBe(true);
		});

		test('2. The "issue" entry has a handler function', () => {
			const entry = COMMAND_REGISTRY['issue'];
			expect(typeof entry.handler).toBe('function');
		});

		test('3. The "issue" entry description mentions "GitHub issue" and "swarm workflow"', () => {
			const entry = COMMAND_REGISTRY['issue'];
			expect(entry.description.toLowerCase()).toContain('github issue');
			expect(entry.description.toLowerCase()).toContain('swarm workflow');
		});

		test('4. The "issue" entry has args field containing [--plan] [--trace] [--no-repro]', () => {
			const entry = COMMAND_REGISTRY['issue'];
			expect(entry.args).toBeDefined();
			expect(entry.args).toContain('--plan');
			expect(entry.args).toContain('--trace');
			expect(entry.args).toContain('--no-repro');
		});

		test('5. The "issue" entry has details field', () => {
			const entry = COMMAND_REGISTRY['issue'];
			expect(entry.details).toBeDefined();
			expect(typeof entry.details).toBe('string');
			expect(entry.details.length).toBeGreaterThan(0);
		});
	});

	describe('VALID_COMMANDS', () => {
		test('6. VALID_COMMANDS array includes "issue"', () => {
			expect(VALID_COMMANDS).toContain('issue');
		});
	});

	describe('resolveCommand', () => {
		test('7. resolveCommand(["issue"]) returns the issue entry', () => {
			const result = resolveCommand(['issue']);
			expect(result).not.toBeNull();
			expect(result?.entry).toBe(COMMAND_REGISTRY['issue']);
		});

		test('8. Calling the issue handler with a valid issue URL returns a string starting with "[MODE: ISSUE_INGEST"', () => {
			// Simulate a valid issue URL input
			const result = handleIssueCommand('/fake/dir', [
				'https://github.com/owner/repo/issues/42',
			]);
			expect(result).toStartWith('[MODE: ISSUE_INGEST');
		});
	});
});

describe('Task 5.3 — Architect Prompt Text', () => {
	test('9. ARCHITECT_PROMPT contains "MODE: ISSUE_INGEST"', () => {
		expect(ARCHITECT_PROMPT).toContain('MODE: ISSUE_INGEST');
	});

	test('10. ARCHITECT_PROMPT contains "Phase 1: INTAKE"', () => {
		expect(ARCHITECT_PROMPT).toContain('Phase 1: INTAKE');
	});

	test('11. ARCHITECT_PROMPT contains "Phase 2: LOCALIZATION"', () => {
		expect(ARCHITECT_PROMPT).toContain('Phase 2: LOCALIZATION');
	});

	test('12. ARCHITECT_PROMPT contains "Phase 3: SPEC GENERATION"', () => {
		expect(ARCHITECT_PROMPT).toContain('Phase 3: SPEC GENERATION');
	});

	test('13. ARCHITECT_PROMPT contains "Phase 4: TRANSITION"', () => {
		expect(ARCHITECT_PROMPT).toContain('Phase 4: TRANSITION');
	});

	test('14. ARCHITECT_PROMPT contains "Root Cause"', () => {
		expect(ARCHITECT_PROMPT).toContain('Root Cause');
	});

	test('15. ARCHITECT_PROMPT contains "Fix Strategy"', () => {
		expect(ARCHITECT_PROMPT).toContain('Fix Strategy');
	});

	test('16. ARCHITECT_PROMPT contains composite scoring weights (0.4, 0.25, 0.2, 0.15)', () => {
		expect(ARCHITECT_PROMPT).toContain('0.4');
		expect(ARCHITECT_PROMPT).toContain('0.25');
		expect(ARCHITECT_PROMPT).toContain('0.2');
		expect(ARCHITECT_PROMPT).toContain('0.15');
	});

	test('17. ARCHITECT_PROMPT contains flag descriptions for plan=true, trace=true, and noRepro=true', () => {
		expect(ARCHITECT_PROMPT).toContain('plan=true');
		expect(ARCHITECT_PROMPT).toContain('trace=true');
		expect(ARCHITECT_PROMPT).toContain('noRepro=true');
	});

	test('18. MODE: ISSUE_INGEST section appears between MODE: COUNCIL and MODE: PLAN sections', () => {
		const councilIndex = ARCHITECT_PROMPT.indexOf('### MODE: COUNCIL');
		const issueIngestIndex = ARCHITECT_PROMPT.indexOf('### MODE: ISSUE_INGEST');
		const planIndex = ARCHITECT_PROMPT.indexOf('### MODE: PLAN');

		expect(councilIndex).toBeGreaterThan(-1);
		expect(issueIngestIndex).toBeGreaterThan(-1);
		expect(planIndex).toBeGreaterThan(-1);
		expect(issueIngestIndex).toBeGreaterThan(councilIndex);
		expect(issueIngestIndex).toBeLessThan(planIndex);
	});
});
