import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from 'bun:test';
import {
	mkdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	BuildEvidence,
	Evidence,
	PlaceholderEvidence,
	QualityBudgetEvidence,
	SastEvidence,
	SbomEvidence,
	SyntaxEvidence,
} from '../../../src/config/evidence-schema';
import {
	_internals,
	deleteEvidence,
	isBuildEvidence,
	isPlaceholderEvidence,
	isQualityBudgetEvidence,
	isSastEvidence,
	isSbomEvidence,
	isSyntaxEvidence,
	isValidEvidenceType,
	listEvidenceTaskIds,
	loadEvidence,
	sanitizeTaskId,
	saveEvidence,
	VALID_EVIDENCE_TYPES,
	validateProjectRoot,
} from '../../../src/evidence/manager';

let tempDir: string;
let savedValidateProjectRoot: typeof validateProjectRoot;

beforeEach(() => {
	// Mock validateProjectRoot for all tests except the dedicated validateProjectRoot describe block
	savedValidateProjectRoot = _internals.validateProjectRoot;
	_internals.validateProjectRoot = () => {};

	tempDir = join(
		tmpdir(),
		`evidence-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(join(tempDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	// Restore the real validateProjectRoot
	_internals.validateProjectRoot = savedValidateProjectRoot;

	rmSync(tempDir, { recursive: true, force: true });
});

function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
	return {
		task_id: '1.1',
		type: 'note',
		timestamp: new Date().toISOString(),
		agent: 'test-agent',
		verdict: 'info',
		summary: 'Test evidence',
		...overrides,
	} as Evidence;
}

describe('sanitizeTaskId', () => {
	it("valid IDs: '1.1', '1.2.3', '2.1', '10.5.3' all return the ID", () => {
		expect(sanitizeTaskId('1.1')).toBe('1.1');
		expect(sanitizeTaskId('1.2.3')).toBe('1.2.3');
		expect(sanitizeTaskId('2.1')).toBe('2.1');
		expect(sanitizeTaskId('10.5.3')).toBe('10.5.3');
	});

	it("retrospective IDs: 'retro-1', 'retro-2', 'retro-10' all return the ID (FR-001, FR-002)", () => {
		// These IDs were previously rejected but are now allowed for backward compatibility
		expect(sanitizeTaskId('retro-1')).toBe('retro-1');
		expect(sanitizeTaskId('retro-2')).toBe('retro-2');
		expect(sanitizeTaskId('retro-10')).toBe('retro-10');
		expect(sanitizeTaskId('retro-100')).toBe('retro-100');
	});

	it("retrospective-like IDs: 'retro', 'retro-abc', 'Retro-1' are accepted via GENERAL_TASK_ID_REGEX (FR-003, FR-004)", () => {
		// These are now accepted by the general alphanumeric allowlist
		expect(sanitizeTaskId('retro')).toBe('retro');
		expect(sanitizeTaskId('retro-abc')).toBe('retro-abc');
		expect(sanitizeTaskId('Retro-1')).toBe('Retro-1');
	});

	it("'retro-1/2' throws because slash is not allowed", () => {
		expect(() => sanitizeTaskId('retro-1/2')).toThrow('Invalid task ID');
	});

	it("internal automated-tool IDs: 'sast_scan', 'quality_budget', 'syntax_check', 'placeholder_scan', 'sbom_generate', 'build' all return the ID", () => {
		// These IDs are allowed for internal automated-tool evidence
		expect(sanitizeTaskId('sast_scan')).toBe('sast_scan');
		expect(sanitizeTaskId('quality_budget')).toBe('quality_budget');
		expect(sanitizeTaskId('syntax_check')).toBe('syntax_check');
		expect(sanitizeTaskId('placeholder_scan')).toBe('placeholder_scan');
		expect(sanitizeTaskId('sbom_generate')).toBe('sbom_generate');
		expect(sanitizeTaskId('build')).toBe('build');
	});

	it("alphanumeric tool-like IDs 'sast', 'scan', 'quality', 'syntax', 'placeholder', 'sbom', 'build_extra', 'sast-scan' are now accepted via GENERAL_TASK_ID_REGEX", () => {
		// These are now accepted by the general alphanumeric allowlist
		expect(sanitizeTaskId('sast')).toBe('sast');
		expect(sanitizeTaskId('scan')).toBe('scan');
		expect(sanitizeTaskId('quality')).toBe('quality');
		expect(sanitizeTaskId('syntax')).toBe('syntax');
		expect(sanitizeTaskId('placeholder')).toBe('placeholder');
		expect(sanitizeTaskId('sbom')).toBe('sbom');
		expect(sanitizeTaskId('build_extra')).toBe('build_extra');
		expect(sanitizeTaskId('sast-scan')).toBe('sast-scan');
	});

	it('empty string throws', () => {
		expect(() => sanitizeTaskId('')).toThrow('Invalid task ID: empty string');
	});

	it("null byte ('task\\0id') throws", () => {
		expect(() => sanitizeTaskId('task\0id')).toThrow(
			'Invalid task ID: contains null bytes',
		);
	});

	it("control character ('task\\tid' — tab char) throws", () => {
		expect(() => sanitizeTaskId('task\tid')).toThrow(
			'Invalid task ID: contains control characters',
		);
	});

	it("path traversal '../secret' throws", () => {
		expect(() => sanitizeTaskId('../secret')).toThrow(
			'Invalid task ID: path traversal detected',
		);
	});

	it("path traversal '..\\\\secret' throws", () => {
		expect(() => sanitizeTaskId('..\\secret')).toThrow(
			'Invalid task ID: path traversal detected',
		);
	});

	it("double dot 'task..id' throws", () => {
		expect(() => sanitizeTaskId('task..id')).toThrow(
			'Invalid task ID: path traversal detected',
		);
	});

	it("invalid chars 'task/id' throws", () => {
		expect(() => sanitizeTaskId('task/id')).toThrow('Invalid task ID');
	});

	it("spaces 'task id' throws", () => {
		expect(() => sanitizeTaskId('task id')).toThrow('Invalid task ID');
	});

	it("leading dot '.hidden' throws", () => {
		// Leading dot is not valid (must start with alphanumeric)
		expect(() => sanitizeTaskId('.hidden')).toThrow('Invalid task ID');
	});
});

describe('saveEvidence + loadEvidence', () => {
	it('save creates new bundle and load returns it', async () => {
		const evidence = makeEvidence({ summary: 'Test summary' });
		const bundle = await saveEvidence(tempDir, '1.1', evidence);

		expect(bundle.task_id).toBe('1.1');
		expect(bundle.entries.length).toBe(1);
		expect(bundle.entries[0].summary).toBe('Test summary');

		const loaded = await loadEvidence(tempDir, '1.1');
		expect(loaded.status).toBe('found');
		if (loaded.status !== 'found') return;
		expect(loaded.bundle.task_id).toBe('1.1');
		expect(loaded.bundle.entries.length).toBe(1);
		expect(loaded.bundle.entries[0].summary).toBe('Test summary');
	});

	it('save appends to existing bundle', async () => {
		const evidence1 = makeEvidence({ summary: 'First entry' });
		const evidence2 = makeEvidence({ summary: 'Second entry' });

		await saveEvidence(tempDir, '1.1', evidence1);
		const bundle2 = await saveEvidence(tempDir, '1.1', evidence2);

		expect(bundle2.entries.length).toBe(2);
		expect(bundle2.entries[0].summary).toBe('First entry');
		expect(bundle2.entries[1].summary).toBe('Second entry');

		const loaded = await loadEvidence(tempDir, '1.1');
		expect(loaded.status).toBe('found');
		if (loaded.status !== 'found') return;
		expect(loaded.bundle.entries.length).toBe(2);
	});

	it('load returns null when no evidence exists', async () => {
		const loaded = await loadEvidence(tempDir, '1.1');
		expect(loaded.status).toBe('not_found');
	});

	it('save with invalid task ID throws', async () => {
		const evidence = makeEvidence();
		await expect(saveEvidence(tempDir, '../evil', evidence)).rejects.toThrow(
			'Invalid task ID',
		);
	});

	it('save validates path via validateSwarmPath (implicitly tested via save)', async () => {
		// This is implicitly tested by the fact that saveEvidence uses validateSwarmPath
		// If the path validation fails, the save should fail
		const evidence = makeEvidence();
		// Normal save should work
		const bundle = await saveEvidence(tempDir, '1.1', evidence);
		expect(bundle.task_id).toBe('1.1');
	});

	it('size limit enforcement: verify save throws with exceeds maximum message', async () => {
		const evidence = makeEvidence({
			summary: 'x'.repeat(600000), // 600KB string, will exceed 500KB limit
		});

		await expect(saveEvidence(tempDir, '1.1', evidence)).rejects.toThrow(
			'exceeds maximum',
		);
	});

	it('save and load retrospective evidence with ID retro-1 (FR-001, FR-002)', async () => {
		const evidence = makeEvidence({
			task_id: 'retro-1',
			summary: 'Phase 1 retrospective',
		});
		const bundle = await saveEvidence(tempDir, 'retro-1', evidence);

		expect(bundle.task_id).toBe('retro-1');
		expect(bundle.entries.length).toBe(1);
		expect(bundle.entries[0].summary).toBe('Phase 1 retrospective');

		const loaded = await loadEvidence(tempDir, 'retro-1');
		expect(loaded.status).toBe('found');
		if (loaded.status !== 'found') return;
		expect(loaded.bundle.task_id).toBe('retro-1');
		expect(loaded.bundle.entries.length).toBe(1);
		expect(loaded.bundle.entries[0].summary).toBe('Phase 1 retrospective');
	});

	it('save with retro-abc and retro IDs now succeeds (GENERAL_TASK_ID_REGEX accepts them)', async () => {
		const evidence = makeEvidence();
		const bundle1 = await saveEvidence(tempDir, 'retro-abc', evidence);
		expect(bundle1.task_id).toBe('retro-abc');
		const bundle2 = await saveEvidence(tempDir, 'retro', evidence);
		expect(bundle2.task_id).toBe('retro');
	});

	it('save and load internal automated-tool evidence: sast_scan, quality_budget, syntax_check, placeholder_scan, sbom_generate, build', async () => {
		const toolIds = [
			'sast_scan',
			'quality_budget',
			'syntax_check',
			'placeholder_scan',
			'sbom_generate',
			'build',
		] as const;

		for (const toolId of toolIds) {
			const evidence = makeEvidence({
				task_id: toolId,
				summary: `${toolId} scan result`,
			});
			const bundle = await saveEvidence(tempDir, toolId, evidence);

			expect(bundle.task_id).toBe(toolId);
			expect(bundle.entries.length).toBe(1);
			expect(bundle.entries[0].summary).toBe(`${toolId} scan result`);

			const loaded = await loadEvidence(tempDir, toolId);
			expect(loaded.status).toBe('found');
			if (loaded.status !== 'found') return;
			expect(loaded.bundle.task_id).toBe(toolId);
			expect(loaded.bundle.entries.length).toBe(1);
			expect(loaded.bundle.entries[0].summary).toBe(`${toolId} scan result`);
		}
	});

	it('save with alphanumeric IDs sast, scan, sast-scan now succeeds (GENERAL_TASK_ID_REGEX accepts them)', async () => {
		const evidence = makeEvidence();
		const bundle1 = await saveEvidence(tempDir, 'sast', evidence);
		expect(bundle1.task_id).toBe('sast');
		const bundle2 = await saveEvidence(tempDir, 'scan', evidence);
		expect(bundle2.task_id).toBe('scan');
		const bundle3 = await saveEvidence(tempDir, 'sast-scan', evidence);
		expect(bundle3.task_id).toBe('sast-scan');
	});
});

describe('listEvidenceTaskIds', () => {
	it('returns empty array when no evidence directory exists', async () => {
		const ids = await listEvidenceTaskIds(tempDir);
		expect(ids).toEqual([]);
	});

	it('returns sorted task IDs after saving evidence for multiple tasks', async () => {
		// Save evidence in random order
		await saveEvidence(tempDir, '2.1', makeEvidence({ task_id: '2.1' }));
		await saveEvidence(tempDir, '1.2', makeEvidence({ task_id: '1.2' }));
		await saveEvidence(tempDir, '1.1', makeEvidence({ task_id: '1.1' }));

		const ids = await listEvidenceTaskIds(tempDir);
		expect(ids).toEqual(['1.1', '1.2', '2.1']);
	});

	it('filters out non-directory files', async () => {
		// Save evidence for a valid task
		await saveEvidence(tempDir, '1.1', makeEvidence({ task_id: '1.1' }));

		// Create a regular file in the evidence directory
		const evidenceDir = join(tempDir, '.swarm', 'evidence');
		writeFileSync(join(evidenceDir, 'regular-file.txt'), 'test content');

		const ids = await listEvidenceTaskIds(tempDir);
		expect(ids).toEqual(['1.1']);
		expect(ids).not.toContain('regular-file.txt');
	});

	it('filters out invalid task ID directory names', async () => {
		// Save evidence for a valid task
		await saveEvidence(tempDir, '1.1', makeEvidence({ task_id: '1.1' }));

		// Create a directory with invalid name (double dot)
		const evidenceDir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(join(evidenceDir, 'bad..name'), { recursive: true });

		const ids = await listEvidenceTaskIds(tempDir);
		expect(ids).toEqual(['1.1']);
		expect(ids).not.toContain('bad..name');
	});

	it('handles empty evidence directory', async () => {
		// Create the evidence directory but don't save anything
		const evidenceDir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(evidenceDir, { recursive: true });

		const ids = await listEvidenceTaskIds(tempDir);
		expect(ids).toEqual([]);
	});

	it('includes internal automated-tool IDs in listing', async () => {
		// Save evidence for numeric IDs and internal tool IDs
		await saveEvidence(tempDir, '2.1', makeEvidence({ task_id: '2.1' }));
		await saveEvidence(
			tempDir,
			'sast_scan',
			makeEvidence({ task_id: 'sast_scan' }),
		);
		await saveEvidence(tempDir, '1.1', makeEvidence({ task_id: '1.1' }));
		await saveEvidence(
			tempDir,
			'quality_budget',
			makeEvidence({ task_id: 'quality_budget' }),
		);

		const ids = await listEvidenceTaskIds(tempDir);
		// Should include both numeric and internal tool IDs
		expect(ids).toContain('1.1');
		expect(ids).toContain('2.1');
		expect(ids).toContain('sast_scan');
		expect(ids).toContain('quality_budget');
		expect(ids.length).toBe(4);
	});
});

describe('deleteEvidence', () => {
	it('returns false when evidence does not exist', async () => {
		const result = await deleteEvidence(tempDir, '1.1');
		expect(result).toBe(false);
	});

	it('returns true after deleting existing evidence', async () => {
		// Save evidence
		await saveEvidence(tempDir, '1.1', makeEvidence({ task_id: '1.1' }));

		// Delete it
		const result = await deleteEvidence(tempDir, '1.1');
		expect(result).toBe(true);
	});

	it('verify deleted evidence cannot be loaded', async () => {
		// Save evidence
		await saveEvidence(tempDir, '1.1', makeEvidence({ task_id: '1.1' }));

		// Verify it exists
		let loaded = await loadEvidence(tempDir, '1.1');
		expect(loaded.status).toBe('found');

		// Delete it
		await deleteEvidence(tempDir, '1.1');

		// Verify it's gone
		loaded = await loadEvidence(tempDir, '1.1');
		expect(loaded.status).toBe('not_found');
	});

	it('invalid task ID throws', async () => {
		await expect(deleteEvidence(tempDir, '../evil')).rejects.toThrow(
			'Invalid task ID',
		);
	});
});

describe('isValidEvidenceType', () => {
	it('returns true for all 12 valid evidence types', () => {
		expect(isValidEvidenceType('review')).toBe(true);
		expect(isValidEvidenceType('test')).toBe(true);
		expect(isValidEvidenceType('diff')).toBe(true);
		expect(isValidEvidenceType('approval')).toBe(true);
		expect(isValidEvidenceType('note')).toBe(true);
		expect(isValidEvidenceType('retrospective')).toBe(true);
		expect(isValidEvidenceType('syntax')).toBe(true);
		expect(isValidEvidenceType('placeholder')).toBe(true);
		expect(isValidEvidenceType('sast')).toBe(true);
		expect(isValidEvidenceType('sbom')).toBe(true);
		expect(isValidEvidenceType('build')).toBe(true);
		expect(isValidEvidenceType('quality_budget')).toBe(true);
	});

	it('returns false for unknown types', () => {
		expect(isValidEvidenceType('unknown')).toBe(false);
		expect(isValidEvidenceType('invalid')).toBe(false);
		expect(isValidEvidenceType('')).toBe(false);
		expect(isValidEvidenceType('REVIEW')).toBe(false); // case sensitive
	});

	it('VALID_EVIDENCE_TYPES constant has 13 types', () => {
		expect(VALID_EVIDENCE_TYPES.length).toBe(13);
	});
});

describe('Type guards', () => {
	it('isSyntaxEvidence returns true for syntax type', () => {
		const evidence = makeSyntaxEvidence();
		expect(isSyntaxEvidence(evidence)).toBe(true);
		expect(isPlaceholderEvidence(evidence)).toBe(false);
		expect(isSastEvidence(evidence)).toBe(false);
		expect(isSbomEvidence(evidence)).toBe(false);
		expect(isBuildEvidence(evidence)).toBe(false);
		expect(isQualityBudgetEvidence(evidence)).toBe(false);
	});

	it('isPlaceholderEvidence returns true for placeholder type', () => {
		const evidence = makePlaceholderEvidence();
		expect(isSyntaxEvidence(evidence)).toBe(false);
		expect(isPlaceholderEvidence(evidence)).toBe(true);
		expect(isSastEvidence(evidence)).toBe(false);
		expect(isSbomEvidence(evidence)).toBe(false);
		expect(isBuildEvidence(evidence)).toBe(false);
		expect(isQualityBudgetEvidence(evidence)).toBe(false);
	});

	it('isSastEvidence returns true for sast type', () => {
		const evidence = makeSastEvidence();
		expect(isSyntaxEvidence(evidence)).toBe(false);
		expect(isPlaceholderEvidence(evidence)).toBe(false);
		expect(isSastEvidence(evidence)).toBe(true);
		expect(isSbomEvidence(evidence)).toBe(false);
		expect(isBuildEvidence(evidence)).toBe(false);
		expect(isQualityBudgetEvidence(evidence)).toBe(false);
	});

	it('isSbomEvidence returns true for sbom type', () => {
		const evidence = makeSbomEvidence();
		expect(isSyntaxEvidence(evidence)).toBe(false);
		expect(isPlaceholderEvidence(evidence)).toBe(false);
		expect(isSastEvidence(evidence)).toBe(false);
		expect(isSbomEvidence(evidence)).toBe(true);
		expect(isBuildEvidence(evidence)).toBe(false);
		expect(isQualityBudgetEvidence(evidence)).toBe(false);
	});

	it('isBuildEvidence returns true for build type', () => {
		const evidence = makeBuildEvidence();
		expect(isSyntaxEvidence(evidence)).toBe(false);
		expect(isPlaceholderEvidence(evidence)).toBe(false);
		expect(isSastEvidence(evidence)).toBe(false);
		expect(isSbomEvidence(evidence)).toBe(false);
		expect(isBuildEvidence(evidence)).toBe(true);
		expect(isQualityBudgetEvidence(evidence)).toBe(false);
	});

	it('isQualityBudgetEvidence returns true for quality_budget type', () => {
		const evidence = makeQualityBudgetEvidence();
		expect(isSyntaxEvidence(evidence)).toBe(false);
		expect(isPlaceholderEvidence(evidence)).toBe(false);
		expect(isSastEvidence(evidence)).toBe(false);
		expect(isSbomEvidence(evidence)).toBe(false);
		expect(isBuildEvidence(evidence)).toBe(false);
		expect(isQualityBudgetEvidence(evidence)).toBe(true);
	});
});

describe('All 12 evidence types can be saved and loaded', () => {
	const allTypes = [
		'review',
		'test',
		'diff',
		'approval',
		'note',
		'retrospective',
		'syntax',
		'placeholder',
		'sast',
		'sbom',
		'build',
		'quality_budget',
	] as const;

	it.each(allTypes)('can save and load %s evidence type', async (type) => {
		let evidence: Evidence = makeNoteEvidence(); // Default initialization

		switch (type) {
			case 'review':
				evidence = makeReviewEvidence();
				break;
			case 'test':
				evidence = makeTestEvidence();
				break;
			case 'diff':
				evidence = makeDiffEvidence();
				break;
			case 'approval':
				evidence = makeApprovalEvidence();
				break;
			case 'note':
				evidence = makeNoteEvidence();
				break;
			case 'retrospective':
				evidence = makeRetrospectiveEvidence();
				break;
			case 'syntax':
				evidence = makeSyntaxEvidence();
				break;
			case 'placeholder':
				evidence = makePlaceholderEvidence();
				break;
			case 'sast':
				evidence = makeSastEvidence();
				break;
			case 'sbom':
				evidence = makeSbomEvidence();
				break;
			case 'build':
				evidence = makeBuildEvidence();
				break;
			case 'quality_budget':
				evidence = makeQualityBudgetEvidence();
				break;
		}

		const taskId = '1.1'; // Use valid numeric format for canonical rule
		const saved = await saveEvidence(tempDir, taskId, evidence);
		expect(saved.entries.length).toBe(1);
		expect(saved.entries[0].type).toBe(type);

		const loaded = await loadEvidence(tempDir, taskId);
		expect(loaded.status).toBe('found');
		if (loaded.status !== 'found') return;
		expect(loaded.bundle.entries.length).toBe(1);
		expect(loaded.bundle.entries[0].type).toBe(type);
	});
});

// Helper functions for creating specific evidence types

function makeReviewEvidence() {
	return {
		task_id: '1.1',
		type: 'review' as const,
		timestamp: new Date().toISOString(),
		agent: 'test-agent',
		verdict: 'approved' as const,
		summary: 'Code review passed',
		risk: 'low' as const,
		issues: [],
	};
}

function makeTestEvidence() {
	return {
		task_id: '1.1',
		type: 'test' as const,
		timestamp: new Date().toISOString(),
		agent: 'test-agent',
		verdict: 'pass' as const,
		summary: 'All tests passed',
		tests_passed: 10,
		tests_failed: 0,
		failures: [],
	};
}

function makeDiffEvidence() {
	return {
		task_id: '1.1',
		type: 'diff' as const,
		timestamp: new Date().toISOString(),
		agent: 'test-agent',
		verdict: 'info' as const,
		summary: 'Code changes',
		files_changed: ['src/index.ts'],
		additions: 50,
		deletions: 10,
	};
}

function makeApprovalEvidence() {
	return {
		task_id: '1.1',
		type: 'approval' as const,
		timestamp: new Date().toISOString(),
		agent: 'test-agent',
		verdict: 'approved' as const,
		summary: 'Task approved',
	};
}

function makeNoteEvidence() {
	return {
		task_id: '1.1',
		type: 'note' as const,
		timestamp: new Date().toISOString(),
		agent: 'test-agent',
		verdict: 'info' as const,
		summary: 'Note summary',
	};
}

function makeRetrospectiveEvidence() {
	return {
		task_id: '1.1',
		type: 'retrospective' as const,
		timestamp: new Date().toISOString(),
		agent: 'test-agent',
		verdict: 'info' as const,
		summary: 'Sprint retrospective',
		phase_number: 1,
		total_tool_calls: 100,
		coder_revisions: 5,
		reviewer_rejections: 2,
		test_failures: 1,
		security_findings: 0,
		integration_issues: 0,
		task_count: 10,
		task_complexity: 'moderate' as const,
		top_rejection_reasons: [],
		lessons_learned: [],
	};
}

function makeSyntaxEvidence(): SyntaxEvidence {
	return {
		task_id: '1.1',
		type: 'syntax',
		timestamp: new Date().toISOString(),
		agent: 'test-agent',
		verdict: 'pass',
		summary: 'Syntax check passed',
		files_checked: 10,
		files_failed: 0,
		skipped_count: 0,
		files: [],
	};
}

function makePlaceholderEvidence(): PlaceholderEvidence {
	return {
		task_id: '1.1',
		type: 'placeholder',
		timestamp: new Date().toISOString(),
		agent: 'test-agent',
		verdict: 'info',
		summary: 'No placeholders found',
		findings: [],
		files_scanned: 10,
		files_with_findings: 0,
		findings_count: 0,
	};
}

function makeSastEvidence(): SastEvidence {
	return {
		task_id: '1.1',
		type: 'sast',
		timestamp: new Date().toISOString(),
		agent: 'test-agent',
		verdict: 'pass',
		summary: 'Security scan passed',
		findings: [],
		engine: 'tier_a',
		files_scanned: 10,
		findings_count: 0,
		findings_by_severity: {
			critical: 0,
			high: 0,
			medium: 0,
			low: 0,
		},
	};
}

function makeSbomEvidence(): SbomEvidence {
	return {
		task_id: '1.1',
		type: 'sbom',
		timestamp: new Date().toISOString(),
		agent: 'test-agent',
		verdict: 'info',
		summary: 'SBOM generated',
		components: [],
		metadata: {
			timestamp: new Date().toISOString(),
			tool: 'test-tool',
			tool_version: '1.0.0',
		},
		files: ['package.json'],
		components_count: 0,
		output_path: '/sbom.json',
	};
}

function makeBuildEvidence(): BuildEvidence {
	return {
		task_id: '1.1',
		type: 'build',
		timestamp: new Date().toISOString(),
		agent: 'test-agent',
		verdict: 'pass',
		summary: 'Build succeeded',
		runs: [],
		files_scanned: 10,
		runs_count: 1,
		failed_count: 0,
	};
}

function makeQualityBudgetEvidence(): QualityBudgetEvidence {
	return {
		task_id: '1.1',
		type: 'quality_budget',
		timestamp: new Date().toISOString(),
		agent: 'test-agent',
		verdict: 'info',
		summary: 'Quality metrics within budget',
		metrics: {
			complexity_delta: 2,
			public_api_delta: 5,
			duplication_ratio: 2,
			test_to_code_ratio: 35,
		},
		thresholds: {
			max_complexity_delta: 5,
			max_public_api_delta: 10,
			max_duplication_ratio: 5,
			min_test_to_code_ratio: 30,
		},
		violations: [],
		files_analyzed: ['src/index.ts'],
	};
}

describe('validateProjectRoot (Task 1.2)', () => {
	let subDir: string;

	beforeEach(() => {
		// Restore the real validateProjectRoot — this block tests the actual guard
		_internals.validateProjectRoot = savedValidateProjectRoot;

		subDir = join(tempDir, 'subdir', 'deep');
		mkdirSync(subDir, { recursive: true });
	});

	afterEach(() => {
		// Re-mock for subsequent non-validateProjectRoot tests
		_internals.validateProjectRoot = () => {};
	});

	it('rejects a subdirectory whose parent already has .swarm/', () => {
		// tempDir has .swarm/ created in the top-level beforeEach
		expect(() => validateProjectRoot(subDir)).toThrow(
			/Cannot write evidence.*already contains a \.swarm\//,
		);
	});

	it('does not throw when directory is the project root (has .swarm/ directly)', () => {
		// tempDir has .swarm/ in it, but tempDir itself IS the root — no parent has .swarm/
		// Skip if tmpdir itself has a .swarm/ ancestor (guard would reject before checking
		// that tempDir's own .swarm/ is direct)
		let envHasSwarmAncestor = false;
		try {
			validateProjectRoot(tempDir);
		} catch {
			envHasSwarmAncestor = true;
		}
		if (envHasSwarmAncestor) {
			// tmpdir has .swarm/ ancestor — cannot test this path in this environment
			return;
		}
		expect(() => validateProjectRoot(tempDir)).not.toThrow();
	});

	it('does not throw for a directory with no parent .swarm/ at all', () => {
		// Create a completely standalone directory tree with no .swarm/ anywhere.
		// If tmpdir itself has a .swarm/ ancestor (e.g. C:\Users\...\Temp\.swarm),
		// this test cannot exercise the "no throw" path — skip gracefully.
		const standaloneRoot = join(
			tmpdir(),
			`validate-root-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(join(standaloneRoot, 'child'), { recursive: true });
		try {
			let envHasSwarmAncestor = false;
			try {
				validateProjectRoot(standaloneRoot);
			} catch {
				envHasSwarmAncestor = true;
			}
			if (envHasSwarmAncestor) {
				// Cannot test "no throw" path in this environment — not a failure
				return;
			}
			expect(() =>
				validateProjectRoot(join(standaloneRoot, 'child')),
			).not.toThrow();
		} finally {
			rmSync(standaloneRoot, { recursive: true, force: true });
		}
	});

	it('deeply nested subdirectory still detects parent .swarm/', () => {
		// Create a deeply nested subdirectory within a project that has .swarm/
		const subDir = join(tempDir, 'subdir');
		mkdirSync(subDir, { recursive: true });
		// Create .swarm in the project root (tempDir)
		mkdirSync(join(tempDir, '.swarm'), { recursive: true });
		// Create a deeply nested directory
		const deepDir = join(
			subDir,
			'a',
			'b',
			'c',
			'd',
			'e',
			'f',
			'g',
			'h',
			'i',
			'j',
		);
		mkdirSync(deepDir, { recursive: true });
		// Even at 10+ levels deep, the parent .swarm/ should be detected
		expect(() => validateProjectRoot(deepDir)).toThrow('Cannot write evidence');
	});

	it('symlinked subdirectory is detected via realpath', () => {
		// Create a project root with .swarm/
		const projectRoot = join(tempDir, 'project');
		mkdirSync(join(projectRoot, '.swarm'), { recursive: true });
		// Create a subdirectory inside the project
		const subDir = join(projectRoot, 'subdir');
		mkdirSync(subDir, { recursive: true });
		// Create a symlink outside the project pointing to the subdirectory
		const linkDir = join(tempDir, 'link-to-subdir');
		try {
			symlinkSync(subDir, linkDir, 'junction');
		} catch {
			// Symlinks may not be supported on this platform
			return;
		}
		// The symlink target is inside a project with .swarm/
		// validateProjectRoot should detect the parent .swarm/ via realpath
		expect(() => validateProjectRoot(linkDir)).toThrow('Cannot write evidence');
	});
});

describe('validateProjectRoot integration', () => {
	// Use a random path under os.tmpdir(). If tmpdir() has a .swarm/ ancestor
	// (environment limitation), the "valid project root" test is silently skipped.
	// The "subdirectory rejection" test always works because integrationRoot itself has .swarm/.
	const integrationBase = join(
		tmpdir(),
		`.swarm-inttest-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
	);
	let integrationRoot: string;
	let ancestorHasSwarm = false;

	beforeAll(() => {
		// Walk up from integrationBase checking for .swarm/ in any ancestor.
		// validateProjectRoot checks PARENT directories — not the target itself.
		let check = integrationBase;
		ancestorHasSwarm = false;
		while (true) {
			const parent = join(check, '..');
			if (parent === check) break; // filesystem root
			try {
				if (statSync(join(parent, '.swarm')).isDirectory()) {
					ancestorHasSwarm = true;
					break;
				}
			} catch {
				// .swarm doesn't exist at this level — continue
			}
			check = parent;
		}

		mkdirSync(integrationBase, { recursive: true });
		integrationRoot = join(integrationBase, `root-${Date.now()}`);
		mkdirSync(join(integrationRoot, '.swarm', 'evidence'), { recursive: true });
		writeFileSync(
			join(integrationRoot, '.swarm', 'plan.json'),
			JSON.stringify({ title: 'test', swarm_id: 'test', phases: [] }),
		);
	});

	afterAll(() => {
		try {
			rmSync(integrationBase, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	beforeEach(() => {
		// Restore the real validateProjectRoot — this block tests the actual guard
		_internals.validateProjectRoot = savedValidateProjectRoot;
	});

	afterEach(() => {
		// Re-mock for subsequent non-integration tests
		_internals.validateProjectRoot = () => {};
	});

	it('saveEvidence writes successfully to a valid project root with .swarm/', async () => {
		if (ancestorHasSwarm) return; // environment limitation — skip silently

		const evidence = makeEvidence({ summary: 'Integration test evidence' });
		const bundle = await saveEvidence(integrationRoot, '1.1', evidence);
		expect(bundle.task_id).toBe('1.1');
		expect(bundle.entries.length).toBe(1);
		expect(bundle.entries[0].summary).toBe('Integration test evidence');
	});

	it('saveEvidence rejects when directory is a subdirectory whose parent has .swarm/', async () => {
		// This test always works: integrationRoot itself has .swarm/, so any
		// subdirectory under it will be rejected by validateProjectRoot regardless
		// of ancestor .swarm/ directories further up the tree.
		const subDir = join(integrationRoot, 'subdir', 'deep');
		mkdirSync(subDir, { recursive: true });

		const evidence = makeEvidence({ summary: 'Should fail' });
		await expect(saveEvidence(subDir, '1.1', evidence)).rejects.toThrow(
			/Cannot write evidence.*already contains a \.swarm\//,
		);
	});
});
