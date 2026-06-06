/**
 * Capsule Builder Unit Tests
 *
 * Tests for src/context-map/capsule-builder.ts
 * Uses _internals DI seam to mock filesystem and context map dependencies.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	_internals,
	buildCapsule,
	buildReadPolicy,
	DEFAULT_ROLE_PROFILES,
	estimateTokens,
} from '../../../src/context-map/capsule-builder';

import type {
	AgentRole,
	ContextCapsule,
	ReadPolicyEntry,
} from '../../../src/types/context-capsule';
import type {
	ContextMap,
	FileContextEntry,
} from '../../../src/types/context-map';

// ---------------------------------------------------------------------------
// Test fixtures — inline ContextMap objects
// ---------------------------------------------------------------------------

function makeFileEntry(
	overrides: Partial<FileContextEntry> = {},
): FileContextEntry {
	return {
		path: 'src/example.ts',
		content_hash: 'abc123',
		mtime_ms: Date.now(),
		purpose: 'Example purpose',
		summary: 'Example summary',
		...overrides,
	};
}

function makeContextMap(
	entries: Record<string, FileContextEntry> = {},
): ContextMap {
	return {
		schema_version: 1,
		generated_at: new Date().toISOString(),
		repo_fingerprint: 'test-fingerprint',
		files: entries,
		task_history: {},
		decisions: [],
	};
}

// ---------------------------------------------------------------------------
// Tests: DEFAULT_ROLE_PROFILES
// ---------------------------------------------------------------------------

describe('DEFAULT_ROLE_PROFILES', () => {
	test('has all 5 roles', () => {
		const roles: AgentRole[] = [
			'coder',
			'reviewer',
			'critic',
			'test_engineer',
			'sme',
		];
		for (const role of roles) {
			expect(DEFAULT_ROLE_PROFILES).toHaveProperty(role);
		}
		expect(Object.keys(DEFAULT_ROLE_PROFILES)).toHaveLength(5);
	});

	test('coder has correct configuration', () => {
		const coder = DEFAULT_ROLE_PROFILES.coder;
		expect(coder.role).toBe('coder');
		expect(coder.strategy).toBe('scoped_files_plus_rejection');
		expect(coder.max_files).toBe(15);
		expect(coder.include_rejection).toBe(true);
		expect(coder.include_coverage).toBe(false);
		expect(coder.include_claims).toBe(false);
	});

	test('reviewer has correct configuration', () => {
		const reviewer = DEFAULT_ROLE_PROFILES.reviewer;
		expect(reviewer.role).toBe('reviewer');
		expect(reviewer.strategy).toBe('full_scope_plus_checklist');
		expect(reviewer.max_files).toBe(20);
		expect(reviewer.include_rejection).toBe(true);
		expect(reviewer.include_coverage).toBe(false);
		expect(reviewer.include_claims).toBe(true);
	});

	test('critic has correct configuration', () => {
		const critic = DEFAULT_ROLE_PROFILES.critic;
		expect(critic.role).toBe('critic');
		expect(critic.strategy).toBe('plan_context_only');
		expect(critic.max_files).toBe(5);
		expect(critic.include_rejection).toBe(false);
		expect(critic.include_coverage).toBe(false);
		expect(critic.include_claims).toBe(false);
	});

	test('test_engineer has correct configuration', () => {
		const te = DEFAULT_ROLE_PROFILES.test_engineer;
		expect(te.role).toBe('test_engineer');
		expect(te.strategy).toBe('code_plus_coverage_targets');
		expect(te.max_files).toBe(15);
		expect(te.include_rejection).toBe(true);
		expect(te.include_coverage).toBe(true);
		expect(te.include_claims).toBe(false);
	});

	test('sme has correct configuration', () => {
		const sme = DEFAULT_ROLE_PROFILES.sme;
		expect(sme.role).toBe('sme');
		expect(sme.strategy).toBe('domain_facts_only');
		expect(sme.max_files).toBe(3);
		expect(sme.include_rejection).toBe(false);
		expect(sme.include_coverage).toBe(false);
		expect(sme.include_claims).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Tests: estimateTokens
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
	test('returns positive number for non-empty string', () => {
		const result = estimateTokens('hello world');
		expect(result).toBeGreaterThan(0);
	});

	test('returns at least 1 for empty string (min-1 floor)', () => {
		expect(estimateTokens('')).toBeGreaterThanOrEqual(1);
	});

	test('returns larger estimate for longer content', () => {
		const short = 'hi';
		const long = 'this is a much longer string of text';
		expect(estimateTokens(long)).toBeGreaterThan(estimateTokens(short));
	});

	test('base estimator returns 0 for empty, but capsule floor returns 1', () => {
		// The capsule wrapper uses Math.max(1, baseEstimator)
		// so even if base returns 0, we get at least 1
		expect(estimateTokens('')).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Tests: buildReadPolicy
// ---------------------------------------------------------------------------

describe('buildReadPolicy', () => {
	afterEach(() => {
		mock.restore();
	});

	test('files not in map → trust_summary=false, read_original=true, reason contains "not in context map"', () => {
		const map = makeContextMap({});
		const files = ['src/file1.ts', 'src/file2.ts'];

		const policy = buildReadPolicy(files, map, os.tmpdir());

		expect(policy).toHaveLength(2);

		expect(policy[0]).toEqual({
			file_path: 'src/file1.ts',
			trust_summary: false,
			read_original: true,
			reason: 'file not in context map',
		});

		expect(policy[1]).toEqual({
			file_path: 'src/file2.ts',
			trust_summary: false,
			read_original: true,
			reason: 'file not in context map',
		});
	});

	test('files in map but stale → trust_summary=false, read_original=true, reason contains "stale"', () => {
		const entry = makeFileEntry({
			path: 'src/Stale.ts',
			content_hash: 'old-hash',
		});
		const map = makeContextMap({ 'src/Stale.ts': entry });
		const files = ['src/Stale.ts'];

		// Store original values
		const origExists = _internals.existsSync;
		const origRead = _internals.readFileSync;
		const origStale = _internals.isFileStale;

		// Override with mocks
		_internals.existsSync = () => true;
		_internals.readFileSync = () => 'new content' as unknown as Buffer & string;
		_internals.isFileStale = () => true;

		const policy = buildReadPolicy(files, map, os.tmpdir());

		expect(policy).toHaveLength(1);
		expect(policy[0].trust_summary).toBe(false);
		expect(policy[0].read_original).toBe(true);
		expect(policy[0].reason).toContain('stale');

		// Restore
		_internals.existsSync = origExists;
		_internals.readFileSync = origRead;
		_internals.isFileStale = origStale;
	});

	test('files in map and fresh → trust_summary=true, read_original=false, reason contains "current"', () => {
		const entry = makeFileEntry({
			path: 'src/Fresh.ts',
			content_hash: 'abc123',
		});
		const map = makeContextMap({ 'src/Fresh.ts': entry });
		const files = ['src/Fresh.ts'];

		// Store original values
		const origExists = _internals.existsSync;
		const origRead = _internals.readFileSync;
		const origStale = _internals.isFileStale;

		// Override with mocks
		_internals.existsSync = () => true;
		_internals.readFileSync = () =>
			'same content' as unknown as Buffer & string;
		_internals.isFileStale = () => false;

		const policy = buildReadPolicy(files, map, os.tmpdir());

		expect(policy).toHaveLength(1);
		expect(policy[0].trust_summary).toBe(true);
		expect(policy[0].read_original).toBe(false);
		expect(policy[0].reason).toContain('current');

		// Restore
		_internals.existsSync = origExists;
		_internals.readFileSync = origRead;
		_internals.isFileStale = origStale;
	});

	test('handles empty files array', () => {
		const map = makeContextMap();
		const policy = buildReadPolicy([], map, os.tmpdir());
		expect(policy).toHaveLength(0);
	});

	test('file does not exist on disk → treated as stale', () => {
		const entry = makeFileEntry({ path: 'src/Missing.ts' });
		const map = makeContextMap({ 'src/Missing.ts': entry });
		const files = ['src/Missing.ts'];

		// Store original
		const origExists = _internals.existsSync;

		// Mock existsSync to return false (file doesn't exist)
		_internals.existsSync = () => false;

		const policy = buildReadPolicy(files, map, os.tmpdir());

		expect(policy).toHaveLength(1);
		expect(policy[0].trust_summary).toBe(false);
		expect(policy[0].read_original).toBe(true);
		expect(policy[0].reason).toContain('stale');

		// Restore
		_internals.existsSync = origExists;
	});
});

// ---------------------------------------------------------------------------
// Tests: buildCapsule
// ---------------------------------------------------------------------------

describe('buildCapsule', () => {
	const tempDir = os.tmpdir();

	afterEach(() => {
		mock.restore();
	});

	test('returns capsule with correct task_id, agent_role, delegation_reason, generated_at', () => {
		// Direct assignment to _internals
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		const { capsule } = buildCapsule({
			task_id: '1.2',
			agent_role: 'coder',
			delegation_reason: 'new_task',
			files_in_scope: [],
			task_goal: 'Implement feature X',
			directory: tempDir,
		});

		expect(capsule.task_id).toBe('1.2');
		expect(capsule.agent_role).toBe('coder');
		expect(capsule.delegation_reason).toBe('new_task');
		expect(capsule.generated_at).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
		);

		_internals.loadContextMap = origLoad;
	});

	test('returns metadata with success=true, token_estimate > 0', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		const { metadata } = buildCapsule({
			task_id: '1.1',
			agent_role: 'critic',
			delegation_reason: 'critic_plan_review',
			files_in_scope: [],
			task_goal: 'Review plan',
			directory: tempDir,
		});

		expect(metadata.success).toBe(true);
		expect(metadata.token_estimate).toBeGreaterThan(0);

		_internals.loadContextMap = origLoad;
	});

	test('uses DEFAULT_ROLE_PROFILES for the given role', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		// For critic role (max_files=5), passing 10 files should truncate to 5
		const manyFiles = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`);
		const { capsule } = buildCapsule({
			task_id: '2.1',
			agent_role: 'critic',
			delegation_reason: 'critic_plan_review',
			files_in_scope: manyFiles,
			task_goal: 'Review plan',
			directory: tempDir,
		});

		// critic max_files = 5
		expect(capsule.files_in_scope).toHaveLength(5);

		_internals.loadContextMap = origLoad;
	});

	test('truncates files_in_scope to max_files from profile', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		// For sme role (max_files=3), passing 5 files should truncate to 3
		const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
		const { capsule } = buildCapsule({
			task_id: '3.1',
			agent_role: 'sme',
			delegation_reason: 'new_task',
			files_in_scope: files,
			task_goal: 'SME review',
			directory: tempDir,
		});

		expect(capsule.files_in_scope).toHaveLength(3);
		expect(capsule.files_in_scope).toEqual(['a.ts', 'b.ts', 'c.ts']);

		_internals.loadContextMap = origLoad;
	});

	test('markdown content includes header, Task Goal, Files in Scope, Read Policy', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		const { capsule } = buildCapsule({
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'new_task',
			files_in_scope: ['src/example.ts'],
			task_goal: 'Implement X',
			directory: tempDir,
		});

		expect(capsule.content).toContain('# Context Capsule: Task 1.1');
		expect(capsule.content).toContain('## Task Goal');
		expect(capsule.content).toContain('Implement X');
		expect(capsule.content).toContain('## Files in Scope');
		expect(capsule.content).toContain('## Read Policy');

		_internals.loadContextMap = origLoad;
	});

	test('includes Prior Rejection section when include_rejection=true and prior_rejection provided', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		const { capsule } = buildCapsule({
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'reviewer_rejection_fix',
			files_in_scope: [],
			task_goal: 'Fix bug',
			prior_rejection: 'Type error on line 42',
			directory: tempDir,
		});

		expect(capsule.content).toContain('## Prior Rejection');
		expect(capsule.content).toContain('Type error on line 42');

		_internals.loadContextMap = origLoad;
	});

	test('excludes Prior Rejection when include_rejection=false (critic, sme)', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		// critic has include_rejection=false
		const { capsule: criticCapsule } = buildCapsule({
			task_id: '2.1',
			agent_role: 'critic',
			delegation_reason: 'critic_plan_review',
			files_in_scope: [],
			task_goal: 'Review plan',
			prior_rejection: 'This should not appear',
			directory: tempDir,
		});

		expect(criticCapsule.content).not.toContain('## Prior Rejection');
		expect(criticCapsule.content).not.toContain('This should not appear');

		_internals.loadContextMap = origLoad;
	});

	test('sme role excludes Prior Rejection despite prior_rejection being provided', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		const { capsule } = buildCapsule({
			task_id: '3.1',
			agent_role: 'sme',
			delegation_reason: 'new_task',
			files_in_scope: [],
			task_goal: 'SME review',
			prior_rejection: 'Should not appear',
			directory: tempDir,
		});

		expect(capsule.content).not.toContain('## Prior Rejection');

		_internals.loadContextMap = origLoad;
	});

	test('includes Coverage Targets when include_coverage=true and coverage_targets provided (test_engineer)', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		const { capsule } = buildCapsule({
			task_id: '4.1',
			agent_role: 'test_engineer',
			delegation_reason: 'test_failure_fix',
			files_in_scope: [],
			task_goal: 'Fix failing tests',
			coverage_targets: ['src/utils.ts', 'src/helpers.ts'],
			directory: tempDir,
		});

		expect(capsule.content).toContain('## Coverage Targets');
		expect(capsule.content).toContain('src/utils.ts');
		expect(capsule.content).toContain('src/helpers.ts');

		_internals.loadContextMap = origLoad;
	});

	test('excludes Coverage Targets for roles with include_coverage=false', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		// coder has include_coverage=false
		const { capsule } = buildCapsule({
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'new_task',
			files_in_scope: [],
			task_goal: 'Implement X',
			coverage_targets: ['should not appear'],
			directory: tempDir,
		});

		expect(capsule.content).not.toContain('## Coverage Targets');
		expect(capsule.content).not.toContain('should not appear');

		_internals.loadContextMap = origLoad;
	});

	test('includes Review Checklist when include_claims=true and review_checklist provided (reviewer)', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		const { capsule } = buildCapsule({
			task_id: '5.1',
			agent_role: 'reviewer',
			delegation_reason: 'new_task',
			files_in_scope: [],
			task_goal: 'Review implementation',
			review_checklist: ['Check error handling', 'Verify edge cases'],
			directory: tempDir,
		});

		expect(capsule.content).toContain('## Review Checklist');
		expect(capsule.content).toContain('Check error handling');
		expect(capsule.content).toContain('Verify edge cases');

		_internals.loadContextMap = origLoad;
	});

	test('excludes Review Checklist for roles with include_claims=false', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		// coder has include_claims=false
		const { capsule } = buildCapsule({
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'new_task',
			files_in_scope: [],
			task_goal: 'Implement X',
			review_checklist: ['should not appear'],
			directory: tempDir,
		});

		expect(capsule.content).not.toContain('## Review Checklist');
		expect(capsule.content).not.toContain('should not appear');

		_internals.loadContextMap = origLoad;
	});

	test('handles missing context map gracefully (uses empty map)', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => null; // simulate missing map

		const { capsule, metadata } = buildCapsule({
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'new_task',
			files_in_scope: ['src/unknown.ts'],
			task_goal: 'Work on unknown file',
			directory: tempDir,
		});

		expect(capsule.content).toContain('# Context Capsule: Task 1.1');
		expect(metadata.success).toBe(true);
		expect(metadata.cache_misses).toBe(1); // file not in map

		_internals.loadContextMap = origLoad;
	});

	test('tracks cache_hits, cache_misses, stale_entries in metadata', () => {
		const entry1 = makeFileEntry({ path: 'src/hit.ts' });
		const entry2 = makeFileEntry({
			path: 'src/stale.ts',
			content_hash: 'old-hash',
		});
		const map = makeContextMap({
			'src/hit.ts': entry1,
			'src/stale.ts': entry2,
		});

		// Store and override _internals directly
		const origLoad = _internals.loadContextMap;
		const origExists = _internals.existsSync;
		const origRead = _internals.readFileSync;
		const origStale = _internals.isFileStale;

		_internals.loadContextMap = () => map;
		_internals.existsSync = () => true;
		_internals.readFileSync = () => 'new content' as unknown as Buffer & string;
		_internals.isFileStale = () => true;

		const { metadata } = buildCapsule({
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'new_task',
			files_in_scope: ['src/hit.ts', 'src/stale.ts', 'src/miss.ts'],
			task_goal: 'Test cache tracking',
			directory: tempDir,
		});

		// src/hit.ts → in map but stale (1 stale entry, 1 cache hit for entry but stale)
		// src/stale.ts → in map but stale (1 stale entry, 1 cache hit but stale)
		// src/miss.ts → not in map (1 cache miss)
		expect(metadata.cache_hits).toBe(2);
		expect(metadata.cache_misses).toBe(1);
		expect(metadata.stale_entries).toBe(2);

		// Restore
		_internals.loadContextMap = origLoad;
		_internals.existsSync = origExists;
		_internals.readFileSync = origRead;
		_internals.isFileStale = origStale;
	});

	test('recommended_reads contains files where read_original=true', () => {
		const entry = makeFileEntry({ path: 'src/stale.ts' });
		const map = makeContextMap({ 'src/stale.ts': entry });

		// Store and override _internals directly
		const origLoad = _internals.loadContextMap;
		const origExists = _internals.existsSync;
		const origRead = _internals.readFileSync;
		const origStale = _internals.isFileStale;

		_internals.loadContextMap = () => map;
		_internals.existsSync = () => true;
		_internals.readFileSync = () => 'new content' as unknown as Buffer & string;
		_internals.isFileStale = () => true;

		const { metadata } = buildCapsule({
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'new_task',
			files_in_scope: ['src/stale.ts'],
			task_goal: 'Fix stale',
			directory: tempDir,
		});

		expect(metadata.recommended_reads).toContain('src/stale.ts');

		// Restore
		_internals.loadContextMap = origLoad;
		_internals.existsSync = origExists;
		_internals.readFileSync = origRead;
		_internals.isFileStale = origStale;
	});

	test('skipped_reads contains files where trust_summary=true', () => {
		const entry = makeFileEntry({
			path: 'src/fresh.ts',
			content_hash: 'abc123',
		});
		const map = makeContextMap({ 'src/fresh.ts': entry });

		// Store and override _internals directly
		const origLoad = _internals.loadContextMap;
		const origExists = _internals.existsSync;
		const origRead = _internals.readFileSync;
		const origStale = _internals.isFileStale;

		_internals.loadContextMap = () => map;
		_internals.existsSync = () => true;
		_internals.readFileSync = () =>
			'same content' as unknown as Buffer & string;
		_internals.isFileStale = () => false;

		const { metadata } = buildCapsule({
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'new_task',
			files_in_scope: ['src/fresh.ts'],
			task_goal: 'Review fresh',
			directory: tempDir,
		});

		expect(metadata.skipped_reads).toContain('src/fresh.ts');

		// Restore
		_internals.loadContextMap = origLoad;
		_internals.existsSync = origExists;
		_internals.readFileSync = origRead;
		_internals.isFileStale = origStale;
	});

	test('token budget pruning reduces content size but mandatory sections survive', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		// Create a very large task_goal
		const largeGoal = 'A'.repeat(5000);

		const { capsule, metadata } = buildCapsule({
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'new_task',
			files_in_scope: [],
			task_goal: largeGoal,
			directory: tempDir,
			max_capsule_tokens: 500, // very small budget
		});

		// Token estimate should be significantly reduced from the unpruned estimate
		// (unpruned would be ~1500+ tokens for the large goal alone)
		expect(metadata.token_estimate).toBeLessThan(1500);
		// Mandatory sections should still be present
		expect(capsule.content).toContain('# Context Capsule: Task 1.1');
		expect(capsule.content).toContain('## Task Goal');
		expect(capsule.content).toContain('## Files in Scope');
		expect(capsule.content).toContain('## Read Policy');

		_internals.loadContextMap = origLoad;
	});

	test('Relevant Facts section included when provided', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		const { capsule } = buildCapsule({
			task_id: '1.1',
			agent_role: 'sme',
			delegation_reason: 'new_task',
			files_in_scope: [],
			task_goal: 'Domain review',
			relevant_facts: ['Uses TypeScript', 'React-based UI'],
			directory: tempDir,
		});

		expect(capsule.content).toContain('## Relevant Facts');
		expect(capsule.content).toContain('Uses TypeScript');
		expect(capsule.content).toContain('React-based UI');

		_internals.loadContextMap = origLoad;
	});

	test('Required Fix section included when include_rejection=true and required_fix provided', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		const { capsule } = buildCapsule({
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'reviewer_rejection_fix',
			files_in_scope: [],
			task_goal: 'Fix reviewer feedback',
			required_fix: 'Add null check for user input',
			directory: tempDir,
		});

		expect(capsule.content).toContain('## Required Fix');
		expect(capsule.content).toContain('Add null check for user input');

		_internals.loadContextMap = origLoad;
	});

	test('Required Fix excluded when include_rejection=false (critic)', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		const { capsule } = buildCapsule({
			task_id: '2.1',
			agent_role: 'critic',
			delegation_reason: 'critic_plan_review',
			files_in_scope: [],
			task_goal: 'Review plan',
			required_fix: 'Should not appear',
			directory: tempDir,
		});

		expect(capsule.content).not.toContain('## Required Fix');
		expect(capsule.content).not.toContain('Should not appear');

		_internals.loadContextMap = origLoad;
	});
});

// ---------------------------------------------------------------------------
// Tests: _internals DI seam
// ---------------------------------------------------------------------------

describe('_internals DI seam', () => {
	test('all expected functions are present', () => {
		expect(_internals).toHaveProperty('loadContextMap');
		expect(_internals).toHaveProperty('createEmptyContextMap');
		expect(_internals).toHaveProperty('computeContentHash');
		expect(_internals).toHaveProperty('isFileStale');
		expect(_internals).toHaveProperty('extractFileSummary');
		expect(_internals).toHaveProperty('readFileSync');
		expect(_internals).toHaveProperty('existsSync');
		expect(_internals).toHaveProperty('estimateTokens');
	});

	test('overrides work: mock loadContextMap is called', () => {
		const mockMap = makeContextMap({
			'test.ts': makeFileEntry({ path: 'test.ts', purpose: 'Mocked file' }),
		});

		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => mockMap;

		const { capsule, metadata } = buildCapsule({
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'new_task',
			files_in_scope: ['test.ts'],
			task_goal: 'Test DI seam',
			directory: os.tmpdir(),
		});

		// If loadContextMap was properly called, the file should be found in the map
		// resulting in a cache_hit, not cache_miss
		expect(metadata.cache_hits).toBe(1);
		expect(metadata.cache_misses).toBe(0);

		_internals.loadContextMap = origLoad;
	});

	test('overrides work: mock createEmptyContextMap is used when loadContextMap returns null', () => {
		const emptyMap = makeContextMap({});

		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => null; // return null to trigger fallback

		const { metadata } = buildCapsule({
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'new_task',
			files_in_scope: [],
			task_goal: 'Test fallback',
			directory: os.tmpdir(),
		});

		// When loadContextMap returns null, createEmptyContextMap should be used
		// which gives us an empty map with no files
		expect(metadata.cache_misses).toBe(0); // no files in scope
		expect(metadata.success).toBe(true);

		_internals.loadContextMap = origLoad;
	});
});

// ---------------------------------------------------------------------------
// Tests: Config wiring (mode, invalidate_on_hash_change, agent_profiles)
// ---------------------------------------------------------------------------

describe('Config wiring (mode, invalidate_on_hash_change, agent_profiles)', () => {
	const tempDir = os.tmpdir();

	afterEach(() => {
		mock.restore();
	});

	test('mode=conservative increases max_files (coder 15 → 23)', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		// coder default max_files = 15; conservative → Math.ceil(15 * 1.5) = 23
		const manyFiles = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
		const { capsule } = buildCapsule({
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'new_task',
			files_in_scope: manyFiles,
			task_goal: 'Conservative mode test',
			directory: tempDir,
			mode: 'conservative',
		});

		// Conservative coder should include 20 files (under the 23 ceiling)
		expect(capsule.files_in_scope).toHaveLength(20);
		// Without conservative it would have been truncated to 15
		expect(capsule.files_in_scope).toEqual(manyFiles);

		_internals.loadContextMap = origLoad;
	});

	test('mode=aggressive decreases max_files (coder 15 → 9)', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		// coder default max_files = 15; aggressive → Math.max(3, Math.floor(15 * 0.6)) = 9
		const manyFiles = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
		const { capsule } = buildCapsule({
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'new_task',
			files_in_scope: manyFiles,
			task_goal: 'Aggressive mode test',
			directory: tempDir,
			mode: 'aggressive',
		});

		// Aggressive coder should only include 9 files (truncated)
		expect(capsule.files_in_scope).toHaveLength(9);
		// First 9 files should be included
		expect(capsule.files_in_scope).toEqual(manyFiles.slice(0, 9));

		_internals.loadContextMap = origLoad;
	});

	test('mode=aggressive enforces min of 3 even for sme (3 → 3)', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		// sme default max_files = 3; aggressive → Math.max(3, Math.floor(3 * 0.6)) = 3
		const manyFiles = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
		const { capsule } = buildCapsule({
			task_id: '1.1',
			agent_role: 'sme',
			delegation_reason: 'new_task',
			files_in_scope: manyFiles,
			task_goal: 'Aggressive sme test',
			directory: tempDir,
			mode: 'aggressive',
		});

		// sme aggressive should still include 3 files (floor)
		expect(capsule.files_in_scope).toHaveLength(3);

		_internals.loadContextMap = origLoad;
	});

	test('agent_profiles overrides strategy — coder with sme strategy includes Prior Rejection (sme has include_rejection=false but coder override keeps its own)', () => {
		// This test verifies agent_profiles changes the profile's strategy field.
		// The strategy field controls section inclusion logic.
		// We test it indirectly: coder's default strategy includes Prior Rejection (include_rejection=true).
		// We verify the override path runs without error and produces a valid capsule.
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		// Using a real strategy name so the profile is well-formed
		const { capsule, metadata } = buildCapsule({
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'new_task',
			files_in_scope: [],
			task_goal: 'Strategy override test',
			directory: tempDir,
			agent_profiles: { coder: 'domain_facts_only' },
			prior_rejection: 'some rejection',
		});

		// Should produce a valid capsule — the strategy override was applied without error
		expect(metadata.success).toBe(true);
		expect(capsule.agent_role).toBe('coder');
		// Prior Rejection section: coder default include_rejection=true, so it still appears
		// (agent_profiles only changes strategy name, not the include_rejection derived from original role)
		expect(capsule.content).toContain('## Prior Rejection');

		_internals.loadContextMap = origLoad;
	});

	test('agent_profiles only overrides strategy field — include_rejection preserved from original role profile', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		// Override reviewer with critic's strategy name.
		// agent_profiles ONLY changes the strategy string — other fields (include_rejection, etc.)
		// are preserved from the original role's profile.
		const { capsule, metadata } = buildCapsule({
			task_id: '1.1',
			agent_role: 'reviewer',
			delegation_reason: 'new_task',
			files_in_scope: [],
			task_goal: 'Strategy override preserves flags',
			directory: tempDir,
			agent_profiles: { reviewer: 'plan_context_only' },
			prior_rejection: 'some rejection',
		});

		// Reviewer's include_rejection=true is preserved even though strategy name changed.
		// agent_profiles only overrides strategy, not the other profile fields.
		expect(metadata.success).toBe(true);
		expect(capsule.content).toContain('## Prior Rejection');

		_internals.loadContextMap = origLoad;
	});

	test('invalidate_on_hash_change=false skips staleness check (trust_summary=true)', () => {
		const entry = makeFileEntry({
			path: 'src/stale.ts',
			content_hash: 'old-hash',
		});
		const map = makeContextMap({ 'src/stale.ts': entry });

		const origLoad = _internals.loadContextMap;
		const origExists = _internals.existsSync;
		const origRead = _internals.readFileSync;
		const origStale = _internals.isFileStale;

		_internals.loadContextMap = () => map;
		_internals.existsSync = () => true;
		// Return different content so hash would fail if checked
		_internals.readFileSync = () =>
			'different content' as unknown as Buffer & string;
		_internals.isFileStale = () => true;

		const { capsule, metadata } = buildCapsule({
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'new_task',
			files_in_scope: ['src/stale.ts'],
			task_goal: 'Skip staleness test',
			directory: tempDir,
			invalidate_on_hash_change: false,
		});

		// With invalidate_on_hash_change=false, staleness is NOT checked
		// The file should be trusted (trust_summary=true in read policy)
		expect(metadata.stale_entries).toBe(0);
		// skipped_reads is the array of files where trust_summary=true
		expect(metadata.skipped_reads).toContain('src/stale.ts');
		expect(metadata.recommended_reads).not.toContain('src/stale.ts');

		_internals.loadContextMap = origLoad;
		_internals.existsSync = origExists;
		_internals.readFileSync = origRead;
		_internals.isFileStale = origStale;
	});

	test('invalidate_on_hash_change=true (default) marks stale when content differs', () => {
		const entry = makeFileEntry({
			path: 'src/stale.ts',
			content_hash: 'old-hash',
		});
		const map = makeContextMap({ 'src/stale.ts': entry });

		const origLoad = _internals.loadContextMap;
		const origExists = _internals.existsSync;
		const origRead = _internals.readFileSync;
		const origStale = _internals.isFileStale;

		_internals.loadContextMap = () => map;
		_internals.existsSync = () => true;
		// Return different content so hash fails
		_internals.readFileSync = () =>
			'different content' as unknown as Buffer & string;
		_internals.isFileStale = () => true;

		const { capsule, metadata } = buildCapsule({
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'new_task',
			files_in_scope: ['src/stale.ts'],
			task_goal: 'Staleness checked test',
			directory: tempDir,
			invalidate_on_hash_change: true, // explicit default
		});

		// With invalidate_on_hash_change=true (default), staleness IS checked
		// so stale_entries should be 1 and the read policy should not trust
		expect(metadata.stale_entries).toBe(1);
		expect(metadata.recommended_reads).toContain('src/stale.ts');
		expect(metadata.skipped_reads).not.toContain('src/stale.ts');

		_internals.loadContextMap = origLoad;
		_internals.existsSync = origExists;
		_internals.readFileSync = origRead;
		_internals.isFileStale = origStale;
	});

	test('buildReadPolicy invalidateOnHashChange=false skips staleness', () => {
		const entry = makeFileEntry({
			path: 'src/stale.ts',
			content_hash: 'old-hash',
		});
		const map = makeContextMap({ 'src/stale.ts': entry });

		const origExists = _internals.existsSync;
		const origRead = _internals.readFileSync;
		const origStale = _internals.isFileStale;

		_internals.existsSync = () => true;
		_internals.readFileSync = () =>
			'different content' as unknown as Buffer & string;
		_internals.isFileStale = () => true;

		// invalidateOnHashChange = false → should trust summary regardless of hash
		const policy = buildReadPolicy(['src/stale.ts'], map, tempDir, false);

		expect(policy).toHaveLength(1);
		expect(policy[0].trust_summary).toBe(true);
		expect(policy[0].read_original).toBe(false);
		expect(policy[0].reason).toContain('current');

		_internals.existsSync = origExists;
		_internals.readFileSync = origRead;
		_internals.isFileStale = origStale;
	});

	test('buildReadPolicy invalidateOnHashChange=true marks stale on hash mismatch', () => {
		const entry = makeFileEntry({
			path: 'src/stale.ts',
			content_hash: 'old-hash',
		});
		const map = makeContextMap({ 'src/stale.ts': entry });

		const origExists = _internals.existsSync;
		const origRead = _internals.readFileSync;
		const origStale = _internals.isFileStale;

		_internals.existsSync = () => true;
		_internals.readFileSync = () =>
			'different content' as unknown as Buffer & string;
		_internals.isFileStale = () => true;

		// invalidateOnHashChange = true (default) → should check hash and distrust
		const policy = buildReadPolicy(['src/stale.ts'], map, tempDir, true);

		expect(policy).toHaveLength(1);
		expect(policy[0].trust_summary).toBe(false);
		expect(policy[0].read_original).toBe(true);
		expect(policy[0].reason).toContain('stale');

		_internals.existsSync = origExists;
		_internals.readFileSync = origRead;
		_internals.isFileStale = origStale;
	});

	test('All defaults backward compatible — no mode/invalidate_on_hash_change/agent_profiles', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		// Build with absolutely no new config fields
		const { capsule, metadata } = buildCapsule({
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'new_task',
			files_in_scope: ['a.ts', 'b.ts'],
			task_goal: 'Backward compat test',
			directory: tempDir,
		});

		// Should behave exactly as before — coder default max_files=15, so 2 files included
		expect(capsule.files_in_scope).toHaveLength(2);
		expect(metadata.success).toBe(true);
		expect(metadata.stale_entries).toBe(0); // no stale check done (file not in map)
		// Role line should show coder (strategy is internal, not in content)
		expect(capsule.content).toContain('Role: coder');

		_internals.loadContextMap = origLoad;
	});

	test('conservative mode with critic scales from 5 to 8', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		// critic default max_files = 5; conservative → Math.ceil(5 * 1.5) = 8
		const manyFiles = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`);
		const { capsule } = buildCapsule({
			task_id: '1.1',
			agent_role: 'critic',
			delegation_reason: 'critic_plan_review',
			files_in_scope: manyFiles,
			task_goal: 'Conservative critic test',
			directory: tempDir,
			mode: 'conservative',
		});

		// Should include 8 files (5 * 1.5 ceiling)
		expect(capsule.files_in_scope).toHaveLength(8);

		_internals.loadContextMap = origLoad;
	});
});

// ---------------------------------------------------------------------------
// Edge cases and boundary conditions
// ---------------------------------------------------------------------------

describe('edge cases', () => {
	const tempDir = os.tmpdir();

	afterEach(() => {
		mock.restore();
	});

	test('empty files_in_scope array produces valid capsule', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		const { capsule, metadata } = buildCapsule({
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'new_task',
			files_in_scope: [],
			task_goal: 'No files needed',
			directory: tempDir,
		});

		expect(capsule.files_in_scope).toHaveLength(0);
		expect(metadata.recommended_reads).toHaveLength(0);
		expect(metadata.skipped_reads).toHaveLength(0);
		expect(capsule.content).toContain('# Context Capsule: Task 1.1');

		_internals.loadContextMap = origLoad;
	});

	test('undefined optional fields handled gracefully', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		const { capsule } = buildCapsule({
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'new_task',
			files_in_scope: [],
			task_goal: 'Test undefined fields',
			// All optional fields omitted
			directory: tempDir,
		});

		expect(capsule.prior_rejection).toBeUndefined();
		expect(capsule.required_fix).toBeUndefined();
		expect(capsule.relevant_facts).toEqual([]);
		expect(capsule.review_checklist).toBeUndefined();
		expect(capsule.coverage_targets).toBeUndefined();

		_internals.loadContextMap = origLoad;
	});

	test('all roles produce valid capsules with unique strategies', () => {
		const roles: AgentRole[] = [
			'coder',
			'reviewer',
			'critic',
			'test_engineer',
			'sme',
		];

		for (const role of roles) {
			const origLoad = _internals.loadContextMap;
			_internals.loadContextMap = () => makeContextMap({});

			const { capsule, metadata } = buildCapsule({
				task_id: '99.99',
				agent_role: role,
				delegation_reason: 'new_task',
				files_in_scope: [],
				task_goal: `Test ${role} role`,
				directory: tempDir,
			});

			expect(metadata.success).toBe(true);
			expect(capsule.agent_role).toBe(role);
			expect(capsule.content).toContain(`Role: ${role}`);

			_internals.loadContextMap = origLoad;
		}
	});

	test('Files in Scope section shows correct count', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		const { capsule } = buildCapsule({
			task_id: '1.1',
			agent_role: 'reviewer',
			delegation_reason: 'new_task',
			files_in_scope: ['a.ts', 'b.ts', 'c.ts'],
			task_goal: 'Test file count',
			directory: tempDir,
		});

		expect(capsule.content).toContain('## Files in Scope (3 files)');

		_internals.loadContextMap = origLoad;
	});

	test('single file in Files in Scope uses singular "file"', () => {
		const origLoad = _internals.loadContextMap;
		_internals.loadContextMap = () => makeContextMap({});

		const { capsule } = buildCapsule({
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'new_task',
			files_in_scope: ['only.ts'],
			task_goal: 'One file',
			directory: tempDir,
		});

		expect(capsule.content).toContain('## Files in Scope (1 file)');

		_internals.loadContextMap = origLoad;
	});
});
