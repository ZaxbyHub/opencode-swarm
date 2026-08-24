import { describe, expect, it } from 'bun:test';
import { createCoderAgent } from './coder';

describe('CODER_PROMPT — REUSE SCAN PROTOCOL', () => {
	const agent = createCoderAgent('test-model');
	const prompt = agent.config.prompt ?? '';

	it('contains the REUSE SCAN PROTOCOL section', () => {
		expect(prompt).toContain('## REUSE SCAN PROTOCOL (MANDATORY)');
	});

	it('contains SCAN sub-section', () => {
		expect(prompt).toContain('1. SCAN:');
	});

	it('contains READ sub-section', () => {
		expect(prompt).toContain('2. READ:');
	});

	it('contains REPORT sub-section', () => {
		expect(prompt).toContain('3. REPORT:');
	});

	it('contains AUTOMATIC REJECTION CONDITIONS', () => {
		expect(prompt).toContain('AUTOMATIC REJECTION CONDITIONS');
	});

	it('contains SCAN_NOT_APPLICABLE conditions', () => {
		expect(prompt).toContain('SCAN_NOT_APPLICABLE');
	});

	it('is positioned after ANTI-HALLUCINATION PROTOCOL', () => {
		const anthallucIndex = prompt.indexOf('## ANTI-HALLUCINATION PROTOCOL');
		const reuseIndex = prompt.indexOf('## REUSE SCAN PROTOCOL (MANDATORY)');
		expect(reuseIndex).toBeGreaterThan(anthallucIndex);
	});

	it('is positioned before DEFENSIVE CODING RULES', () => {
		const reuseIndex = prompt.indexOf('## REUSE SCAN PROTOCOL (MANDATORY)');
		const defensiveIndex = prompt.indexOf('DEFENSIVE CODING RULES');
		expect(defensiveIndex).toBeGreaterThan(reuseIndex);
	});

	it('does not modify ANTI-HALLUCINATION PROTOCOL content', () => {
		expect(prompt).toContain('## ANTI-HALLUCINATION PROTOCOL (MANDATORY)');
		expect(prompt).toContain(
			'Before importing ANY function, type, or class from an existing project module',
		);
	});

	it('preserves DEFENSIVE CODING RULES content', () => {
		expect(prompt).toContain('NEVER use `any` type');
	});

	it('preserves leading space before DEFENSIVE CODING RULES heading', () => {
		const defensiveIndex = prompt.indexOf('DEFENSIVE CODING RULES');
		const leadingChar = prompt.charAt(defensiveIndex - 4);
		expect(leadingChar).toBe(' ');
	});
});

describe('CODER_PROMPT — REUSE_SCAN in DONE template', () => {
	const agent = createCoderAgent('test-model');
	const prompt = agent.config.prompt ?? '';

	it('has REUSE_SCAN field in the standalone DONE template (after DEPS_ADDED, before BLOCKED)', () => {
		const depsIndex = prompt.indexOf('DEPS_ADDED:');
		const reuseIndex = prompt.indexOf('REUSE_SCAN:', depsIndex);
		const blockedIndex = prompt.indexOf('BLOCKED:', depsIndex);
		expect(reuseIndex).toBeGreaterThan(depsIndex);
		expect(blockedIndex).toBeGreaterThan(reuseIndex);
	});

	it('has REUSE_SCAN field in the OUTPUT FORMAT section (after DEPS_ADDED, before SELF-AUDIT)', () => {
		const depsIndex = prompt.indexOf(
			'DEPS_ADDED:',
			prompt.indexOf('OUTPUT FORMAT'),
		);
		const reuseIndex = prompt.indexOf('REUSE_SCAN:', depsIndex);
		const selfAuditIndex = prompt.indexOf('SELF-AUDIT:', depsIndex);
		expect(reuseIndex).toBeGreaterThan(depsIndex);
		expect(selfAuditIndex).toBeGreaterThan(reuseIndex);
	});

	it('REUSE_SCAN field contains valid values', () => {
		expect(prompt).toContain('EXISTING_REUSED');
		expect(prompt).toContain('EXTENDED');
		expect(prompt).toContain('NO_MATCH_FOUND');
		expect(prompt).toContain('SCAN_NOT_APPLICABLE');
	});

	it('contains reuse scan checkbox in SELF-AUDIT', () => {
		expect(prompt).toContain(
			'I ran a reuse scan for every new function/class I created and included REUSE_SCAN in my output',
		);
	});
});

describe('CODER_PROMPT — repo_map localization directive (issue #1988 C1)', () => {
	const agent = createCoderAgent('test-model');
	const prompt = agent.config.prompt ?? '';

	it('RULES direct repo_map localization before editing shared files', () => {
		const rulesStart = prompt.indexOf('RULES:');
		const worktreeIndex = prompt.indexOf('WORKTREE ISOLATION');
		const rulesSection = prompt.substring(rulesStart, worktreeIndex);
		expect(rulesSection).toContain('repo_map action="localization"');
		expect(rulesSection).toContain('shared or cross-imported file');
	});

	it('directive is positioned after "Read target file before editing"', () => {
		const readIndex = prompt.indexOf('Read target file before editing');
		const directiveIndex = prompt.indexOf('repo_map action="localization"');
		expect(directiveIndex).toBeGreaterThan(readIndex);
	});

	it('directive explains it covers the undeclared-scope case', () => {
		expect(prompt).toContain('including when no scope was declared');
	});
});

describe('CODER_PROMPT — ACCEPTANCE field (issue #1687 task 2.1)', () => {
	const agent = createCoderAgent('test-model');
	const prompt = agent.config.prompt ?? '';

	it('INPUT FORMAT includes an ACCEPTANCE field', () => {
		expect(prompt).toContain('ACCEPTANCE:');
	});

	it('ACCEPTANCE field is positioned after OUTPUT and CONSTRAINT, before SKILLS', () => {
		const outputIndex = prompt.indexOf('OUTPUT: [expected deliverable]');
		const constraintIndex = prompt.indexOf('CONSTRAINT: [what NOT to do]');
		const acceptanceIndex = prompt.indexOf('ACCEPTANCE:', constraintIndex);
		const skillsIndex = prompt.indexOf('SKILLS: [optional', acceptanceIndex);
		expect(constraintIndex).toBeGreaterThan(outputIndex);
		expect(acceptanceIndex).toBeGreaterThan(constraintIndex);
		expect(skillsIndex).toBeGreaterThan(acceptanceIndex);
	});

	it('documents gate-injected verbatim FR text requirement, not paraphrase (#2205)', () => {
		expect(prompt).toContain('the delegation gate injects');
		expect(prompt).toContain(
			'verbatim requirement text from spec.md automatically',
		);
		expect(prompt).toContain('never a paraphrase');
	});

	it('documents ACCEPTANCE is never empty even without a spec mapping', () => {
		expect(prompt).toContain('This field is never empty.');
	});

	it('does NOT describe ACCEPTANCE as optional/omittable (old M15 wording removed)', () => {
		expect(prompt).not.toContain('its absence is normal and is NOT a blocker');
	});

	it('ACCEPTANCE HANDLING guidance treats ACCEPTANCE as at least as binding as TASK', () => {
		expect(prompt).toContain('ACCEPTANCE HANDLING');
		expect(prompt).toContain('at least as binding as TASK');
		expect(prompt).toContain('the task is not complete');
	});
});
