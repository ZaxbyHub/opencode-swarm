import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Extract REVIEWER_PROMPT from reviewer.ts source (it's not exported)
// Uses the same approach as architect prompt extraction in other tests
function findWorkspaceRoot(): string {
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

function extractReviewerPrompt(): string {
	const workspaceRoot = findWorkspaceRoot();
	const filePath = resolve(workspaceRoot, 'src/agents/reviewer.ts');
	const content = readFileSync(filePath, 'utf-8');

	// Find the REVIEWER_PROMPT template literal start
	const startMarker = 'const REVIEWER_PROMPT = `';
	const startIdx = content.indexOf(startMarker);
	if (startIdx === -1) throw new Error('REVIEWER_PROMPT not found');

	const actualBacktick = startIdx + startMarker.length; // position of opening backtick

	// Find the closing backtick: it's a `; that is NOT escaped (not preceded by \)
	// and is followed by newline and then 'export function'
	let endIdx = -1;
	for (let i = actualBacktick + 1; i < content.length - 3; i++) {
		if (
			content.charAt(i) === '`' &&
			content.charAt(i + 1) === ';' &&
			content.charAt(i - 1) !== '\\'
		) {
			// Check if followed by newline and then 'export function'
			const after = content.substring(i + 2, i + 25).trim();
			if (after.startsWith('export function')) {
				endIdx = i;
				break;
			}
		}
	}

	if (endIdx === -1) throw new Error('Could not find end of REVIEWER_PROMPT');

	return content.substring(actualBacktick + 1, endIdx);
}

// Extract ARCHITECT_PROMPT from architect.ts source (it's not exported)
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

const REVIEWER_PROMPT = extractReviewerPrompt();
const ARCHITECT_PROMPT = extractArchitectPrompt();

describe('Reviewer prompt assertions — SKILL_COMPLIANCE and SKILLS_USED_BY_CODER', () => {
	describe('INPUT FORMAT section', () => {
		test('REVIEWER_PROMPT contains SKILLS_USED_BY_CODER in INPUT FORMAT', () => {
			expect(REVIEWER_PROMPT).toContain('SKILLS_USED_BY_CODER');
		});

		test('SKILLS_USED_BY_CODER appears in the INPUT FORMAT section context', () => {
			// The INPUT FORMAT section starts around "## INPUT FORMAT"
			// and SKILLS_USED_BY_CODER should be a field there
			const inputFormatSection = REVIEWER_PROMPT.match(
				/## INPUT FORMAT[\s\S]*?(?=## OUTPUT FORMAT|$)/,
			);
			expect(inputFormatSection).not.toBeNull();
			expect(inputFormatSection![0]).toContain('SKILLS_USED_BY_CODER');
		});
	});

	describe('SKILL COMPLIANCE REVIEW section', () => {
		test('REVIEWER_PROMPT contains "SKILL COMPLIANCE REVIEW:" instruction', () => {
			expect(REVIEWER_PROMPT).toContain('SKILL COMPLIANCE REVIEW:');
		});

		test('SKILL COMPLIANCE REVIEW section mentions verifying coder changes comply', () => {
			expect(REVIEWER_PROMPT).toContain("verify the coder's changes comply");
		});

		test('SKILL COMPLIANCE REVIEW section mentions flagging violations at same severity as logic errors', () => {
			expect(REVIEWER_PROMPT).toContain(
				'Flag violations at the same severity as logic errors',
			);
		});

		test('SKILL COMPLIANCE REVIEW section mentions reporting SKILL_COMPLIANCE in output', () => {
			expect(REVIEWER_PROMPT).toContain(
				'Report the overall compliance verdict in SKILL_COMPLIANCE field',
			);
		});
	});

	describe('SKILL_LOAD_FAILED handling', () => {
		test('REVIEWER_PROMPT contains SKILL_LOAD_FAILED handling for skill compliance', () => {
			expect(REVIEWER_PROMPT).toContain('SKILL_LOAD_FAILED');
		});

		test('SKILL_LOAD_FAILED handling mentions PARTIAL compliance status', () => {
			expect(REVIEWER_PROMPT).toContain(
				'SKILL_COMPLIANCE: PARTIAL — [skill path] could not be loaded',
			);
		});
	});

	describe('OUTPUT FORMAT section', () => {
		test('REVIEWER_PROMPT contains COMPLIANT | PARTIAL | VIOLATED in output format', () => {
			expect(REVIEWER_PROMPT).toContain('COMPLIANT | PARTIAL | VIOLATED');
		});

		test('SKILL_COMPLIANCE appears as an output field', () => {
			expect(REVIEWER_PROMPT).toContain('SKILL_COMPLIANCE:');
		});
	});
});

describe('Architect prompt assertions — SKILLS_USED_BY_CODER and skill forwarding', () => {
	describe('DELEGATION FORMAT section', () => {
		test('ARCHITECT_PROMPT contains SKILLS_USED_BY_CODER in delegation format', () => {
			expect(ARCHITECT_PROMPT).toContain('SKILLS_USED_BY_CODER');
		});

		test('SKILLS_USED_BY_CODER appears in the reviewer delegation example', () => {
			// The reviewer delegation example should include SKILLS_USED_BY_CODER
			// Search within the ## DELEGATION FORMAT section (not the ## AGENTS list)
			const delegationSection = ARCHITECT_PROMPT.match(
				/## DELEGATION FORMAT[\s\S]*?(?=## WORKFLOW|$)/,
			);
			expect(delegationSection).not.toBeNull();
			// Find the reviewer delegation example within this section
			const reviewerDelegationExample = delegationSection![0].match(
				/{{AGENT_PREFIX}}reviewer\nTASK:[\s\S]*?(?={{AGENT_PREFIX}}|$)/,
			);
			expect(reviewerDelegationExample).not.toBeNull();
			expect(reviewerDelegationExample![0]).toContain('SKILLS_USED_BY_CODER');
		});
	});

	describe('SKILLS PROPAGATION section', () => {
		test('ARCHITECT_PROMPT contains "Step 4 — Forward skills to reviewer"', () => {
			expect(ARCHITECT_PROMPT).toContain('Step 4 — Forward skills to reviewer');
		});

		test('Step 4 mentions including SKILLS_USED_BY_CODER field', () => {
			// The Step 4 section should explain the SKILLS_USED_BY_CODER field
			const step4Section = ARCHITECT_PROMPT.match(
				/### Step 4[\s\S]*?(?=###|##|$)/,
			);
			expect(step4Section).not.toBeNull();
			expect(step4Section![0]).toContain('SKILLS_USED_BY_CODER');
		});

		test('Step 4 mentions reviewer must receive same skill context as coder', () => {
			expect(ARCHITECT_PROMPT).toContain(
				'The reviewer must receive the same skill context the coder received',
			);
		});

		test('Step 4 explains purpose: verify skill compliance', () => {
			expect(ARCHITECT_PROMPT).toContain('verify skill compliance');
		});
	});

	describe('ANTI-RATIONALIZATION section', () => {
		test('ARCHITECT_PROMPT contains anti-rationalization line about reviewer needing coder skills', () => {
			// The anti-rationalization section should contain this specific line
			expect(ARCHITECT_PROMPT).toContain(
				'"The reviewer doesn\'t need the coder\'s skills"',
			);
		});

		test('Anti-rationalization line says this is WRONG', () => {
			expect(ARCHITECT_PROMPT).toContain(
				'"The reviewer doesn\'t need the coder\'s skills" → WRONG',
			);
		});

		test('Anti-rationalization explains reviewer cannot verify skill compliance without knowing coder skills', () => {
			expect(ARCHITECT_PROMPT).toContain(
				'The reviewer cannot verify skill compliance without knowing what skills the coder received',
			);
		});

		test('Anti-rationalization says to always forward via SKILLS_USED_BY_CODER', () => {
			expect(ARCHITECT_PROMPT).toContain(
				'Always forward via SKILLS_USED_BY_CODER',
			);
		});
	});
});
