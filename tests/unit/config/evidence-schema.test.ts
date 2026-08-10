import { describe, expect, it } from 'bun:test';
import {
	ApprovalEvidenceSchema,
	BaseEvidenceSchema,
	BuildEvidenceSchema,
	DiffEvidenceSchema,
	EVIDENCE_MAX_JSON_BYTES,
	EVIDENCE_MAX_PATCH_BYTES,
	EVIDENCE_MAX_TASK_BYTES,
	type Evidence,
	EvidenceBundleSchema,
	EvidenceSchema,
	type EvidenceType,
	EvidenceTypeSchema,
	EvidenceVerdictSchema,
	NoteEvidenceSchema,
	PlaceholderEvidenceSchema,
	QualityBudgetEvidenceSchema,
	RetrospectiveEvidenceSchema,
	ReviewEvidenceSchema,
	SastEvidenceSchema,
	SbomEvidenceSchema,
	SecretscanEvidenceSchema,
	SyntaxEvidenceSchema,
	TestEvidenceSchema,
} from '../../../src/config/evidence-schema';

describe('EvidenceTypeSchema', () => {
	it('valid values: review, test, diff, approval, note all parse', () => {
		const review = EvidenceTypeSchema.safeParse('review');
		expect(review.success).toBe(true);

		const test = EvidenceTypeSchema.safeParse('test');
		expect(test.success).toBe(true);

		const diff = EvidenceTypeSchema.safeParse('diff');
		expect(diff.success).toBe(true);

		const approval = EvidenceTypeSchema.safeParse('approval');
		expect(approval.success).toBe(true);

		const note = EvidenceTypeSchema.safeParse('note');
		expect(note.success).toBe(true);
	});

	it('invalid value: unknown rejects', () => {
		const result = EvidenceTypeSchema.safeParse('unknown');
		expect(result.success).toBe(false);
	});
});

describe('EvidenceVerdictSchema', () => {
	it('valid values: pass, fail, approved, rejected, info all parse', () => {
		const pass = EvidenceVerdictSchema.safeParse('pass');
		expect(pass.success).toBe(true);

		const fail = EvidenceVerdictSchema.safeParse('fail');
		expect(fail.success).toBe(true);

		const approved = EvidenceVerdictSchema.safeParse('approved');
		expect(approved.success).toBe(true);

		const rejected = EvidenceVerdictSchema.safeParse('rejected');
		expect(rejected.success).toBe(true);

		const info = EvidenceVerdictSchema.safeParse('info');
		expect(info.success).toBe(true);
	});

	it('invalid value: maybe rejects', () => {
		const result = EvidenceVerdictSchema.safeParse('maybe');
		expect(result.success).toBe(false);
	});
});

describe('BaseEvidenceSchema', () => {
	it('valid base evidence parses', () => {
		const evidence = {
			task_id: '1.1',
			type: 'note' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'info' as const,
			summary: 'test note',
		};
		const result = BaseEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.task_id).toBe('1.1');
			expect(result.data.type).toBe('note');
			expect(result.data.timestamp).toBe('2026-02-09T12:00:00.000Z');
			expect(result.data.agent).toBe('mega_reviewer');
			expect(result.data.verdict).toBe('info');
			expect(result.data.summary).toBe('test note');
			expect(result.data.metadata).toBeUndefined();
		}
	});

	it('missing required field (no task_id) rejects', () => {
		const evidence = {
			type: 'note' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'info' as const,
			summary: 'test note',
		};
		const result = BaseEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('optional metadata field works when present', () => {
		const evidence = {
			task_id: '1.1',
			type: 'note' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'info' as const,
			summary: 'test note',
			metadata: {
				key: 'value',
				number: 42,
				flag: true,
			},
		};
		const result = BaseEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.metadata).toEqual({
				key: 'value',
				number: 42,
				flag: true,
			});
		}
	});
});

describe('ReviewEvidenceSchema', () => {
	it('valid review evidence parses (include type:review, risk:low, issues:[])', () => {
		const evidence = {
			task_id: '1.1',
			type: 'review' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'pass' as const,
			summary: 'Code review passed',
			risk: 'low' as const,
			issues: [],
		};
		const result = ReviewEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('review');
			expect(result.data.risk).toBe('low');
			expect(result.data.issues).toEqual([]);
		}
	});

	it('missing risk field rejects', () => {
		const evidence = {
			task_id: '1.1',
			type: 'review' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'pass' as const,
			summary: 'Code review passed',
			issues: [],
		};
		const result = ReviewEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('issues array with proper structure parses', () => {
		const evidence = {
			task_id: '1.1',
			type: 'review' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'fail' as const,
			summary: 'Code review failed',
			risk: 'high' as const,
			issues: [
				{
					severity: 'error' as const,
					message: 'Undefined variable',
					file: 'test.ts',
					line: 42,
				},
				{
					severity: 'warning' as const,
					message: 'Missing type annotation',
				},
			],
		};
		const result = ReviewEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.issues.length).toBe(2);
			expect(result.data.issues[0].severity).toBe('error');
			expect(result.data.issues[0].message).toBe('Undefined variable');
			expect(result.data.issues[0].file).toBe('test.ts');
			expect(result.data.issues[0].line).toBe(42);
			expect(result.data.issues[1].severity).toBe('warning');
			expect(result.data.issues[1].file).toBeUndefined();
		}
	});
});

describe('TestEvidenceSchema', () => {
	it('valid test evidence parses (include type:test, tests_passed:5, tests_failed:0)', () => {
		const evidence = {
			task_id: '1.1',
			type: 'test' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_test_engineer',
			verdict: 'pass' as const,
			summary: 'All tests passed',
			tests_passed: 5,
			tests_failed: 0,
		};
		const result = TestEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('test');
			expect(result.data.tests_passed).toBe(5);
			expect(result.data.tests_failed).toBe(0);
		}
	});

	it('negative tests_passed rejects', () => {
		const evidence = {
			task_id: '1.1',
			type: 'test' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_test_engineer',
			verdict: 'fail' as const,
			summary: 'Some tests failed',
			tests_passed: -1,
			tests_failed: 2,
		};
		const result = TestEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});
});

describe('DiffEvidenceSchema', () => {
	it('valid diff evidence parses (include type:diff, files_changed:[a.ts], additions:10, deletions:5)', () => {
		const evidence = {
			task_id: '1.1',
			type: 'diff' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'info' as const,
			summary: 'Code changes',
			files_changed: ['a.ts', 'b.ts'],
			additions: 10,
			deletions: 5,
		};
		const result = DiffEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('diff');
			expect(result.data.files_changed).toEqual(['a.ts', 'b.ts']);
			expect(result.data.additions).toBe(10);
			expect(result.data.deletions).toBe(5);
		}
	});

	it('defaults applied (files_changed defaults to [], additions/deletions to 0)', () => {
		const evidence = {
			task_id: '1.1',
			type: 'diff' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'info' as const,
			summary: 'Code changes',
		};
		const result = DiffEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.files_changed).toEqual([]);
			expect(result.data.additions).toBe(0);
			expect(result.data.deletions).toBe(0);
		}
	});
});

describe('ApprovalEvidenceSchema', () => {
	it('valid approval evidence parses', () => {
		const evidence = {
			task_id: '1.1',
			type: 'approval' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'approved' as const,
			summary: 'Changes approved',
		};
		const result = ApprovalEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('approval');
		}
	});
});

describe('NoteEvidenceSchema', () => {
	it('valid note evidence parses', () => {
		const evidence = {
			task_id: '1.1',
			type: 'note' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'info' as const,
			summary: 'Test note',
		};
		const result = NoteEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('note');
		}
	});
});

describe('EvidenceSchema discriminated union', () => {
	it('review type correctly parsed as review', () => {
		const evidence = {
			task_id: '1.1',
			type: 'review' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'pass' as const,
			summary: 'Code review',
			risk: 'low' as const,
			issues: [],
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('review');
		}
	});

	it('test type correctly parsed as test', () => {
		const evidence = {
			task_id: '1.1',
			type: 'test' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_test_engineer',
			verdict: 'pass' as const,
			summary: 'Test results',
			tests_passed: 10,
			tests_failed: 0,
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('test');
		}
	});

	it('invalid type foobar rejects', () => {
		const evidence = {
			task_id: '1.1',
			type: 'foobar' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'info' as const,
			summary: 'Invalid type',
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});
});

describe('EvidenceBundleSchema', () => {
	it('valid bundle parses with entries', () => {
		const bundle = {
			schema_version: '1.0.0' as const,
			task_id: '1.1',
			entries: [
				{
					task_id: '1.1',
					type: 'note' as const,
					timestamp: '2026-02-09T12:00:00.000Z',
					agent: 'mega_reviewer',
					verdict: 'info' as const,
					summary: 'Test note',
				},
			],
			created_at: '2026-02-09T12:00:00.000Z',
			updated_at: '2026-02-09T12:00:00.000Z',
		};
		const result = EvidenceBundleSchema.safeParse(bundle);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.schema_version).toBe('1.0.0');
			expect(result.data.task_id).toBe('1.1');
			expect(result.data.entries.length).toBe(1);
		}
	});

	it('empty entries array parses (with default)', () => {
		const bundle = {
			schema_version: '1.0.0' as const,
			task_id: '1.1',
			entries: [],
			created_at: '2026-02-09T12:00:00.000Z',
			updated_at: '2026-02-09T12:00:00.000Z',
		};
		const result = EvidenceBundleSchema.safeParse(bundle);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.entries).toEqual([]);
		}
	});

	it('wrong schema_version rejects', () => {
		const bundle = {
			schema_version: '0.9.0' as const,
			task_id: '1.1',
			entries: [],
			created_at: '2026-02-09T12:00:00.000Z',
			updated_at: '2026-02-09T12:00:00.000Z',
		};
		const result = EvidenceBundleSchema.safeParse(bundle);
		expect(result.success).toBe(false);
	});
});

describe('Constants', () => {
	it('EVIDENCE_MAX_JSON_BYTES = 512000, EVIDENCE_MAX_PATCH_BYTES = 5242880, EVIDENCE_MAX_TASK_BYTES = 20971520', () => {
		expect(EVIDENCE_MAX_JSON_BYTES).toBe(512000);
		expect(EVIDENCE_MAX_PATCH_BYTES).toBe(5242880);
		expect(EVIDENCE_MAX_TASK_BYTES).toBe(20971520);
	});
});

describe('RetrospectiveEvidenceSchema', () => {
	it('valid retrospective evidence parses with all fields', () => {
		const evidence = {
			task_id: '1.1',
			type: 'retrospective' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'info' as const,
			summary: 'Phase 1 retrospective',
			phase_number: 1,
			total_tool_calls: 150,
			coder_revisions: 3,
			reviewer_rejections: 1,
			test_failures: 2,
			security_findings: 0,
			integration_issues: 1,
			task_count: 5,
			task_complexity: 'moderate' as const,
			top_rejection_reasons: ['Code style', 'Missing tests'],
			lessons_learned: [
				'Add more edge case tests',
				'Review PR before submitting',
			],
		};
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('retrospective');
			expect(result.data.phase_number).toBe(1);
			expect(result.data.total_tool_calls).toBe(150);
			expect(result.data.task_complexity).toBe('moderate');
		}
	});

	it('missing required field (phase_number) rejects', () => {
		const evidence = {
			task_id: '1.1',
			type: 'retrospective' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'info' as const,
			summary: 'Phase 1 retrospective',
			total_tool_calls: 150,
			task_count: 5,
			task_complexity: 'moderate' as const,
		};
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('invalid task_complexity rejects', () => {
		const evidence = {
			task_id: '1.1',
			type: 'retrospective' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'info' as const,
			summary: 'Phase 1 retrospective',
			phase_number: 1,
			total_tool_calls: 150,
			coder_revisions: 3,
			reviewer_rejections: 1,
			test_failures: 2,
			security_findings: 0,
			integration_issues: 1,
			task_count: 5,
			task_complexity: 'invalid' as any,
		};
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('defaults applied for optional arrays', () => {
		const evidence = {
			task_id: '1.1',
			type: 'retrospective' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'info' as const,
			summary: 'Phase 1 retrospective',
			phase_number: 1,
			total_tool_calls: 150,
			coder_revisions: 0,
			reviewer_rejections: 0,
			test_failures: 0,
			security_findings: 0,
			integration_issues: 0,
			task_count: 5,
			task_complexity: 'simple' as const,
		};
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.top_rejection_reasons).toEqual([]);
			expect(result.data.lessons_learned).toEqual([]);
		}
	});
});

describe('SyntaxEvidenceSchema', () => {
	it('valid syntax evidence parses with all fields', () => {
		const evidence = {
			task_id: '2.1',
			type: 'syntax' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'pass' as const,
			summary: 'All files passed syntax check',
			files_checked: 10,
			files_failed: 0,
			skipped_count: 2,
			files: [
				{
					path: 'src/index.ts',
					language: 'typescript',
					ok: true,
					errors: [],
				},
				{
					path: 'src/utils.ts',
					language: 'typescript',
					ok: true,
					errors: [],
					skipped_reason: 'generated file',
				},
			],
		};
		const result = SyntaxEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('syntax');
			expect(result.data.files_checked).toBe(10);
			expect(result.data.files_failed).toBe(0);
			expect(result.data.files.length).toBe(2);
		}
	});

	it('missing required field (files_checked) rejects', () => {
		const evidence = {
			task_id: '2.1',
			type: 'syntax' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'pass' as const,
			summary: 'All files passed syntax check',
			files_failed: 0,
		};
		const result = SyntaxEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('files with errors parses correctly', () => {
		const evidence = {
			task_id: '2.1',
			type: 'syntax' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'fail' as const,
			summary: 'Syntax errors found',
			files_checked: 5,
			files_failed: 1,
			files: [
				{
					path: 'src/broken.ts',
					language: 'typescript',
					ok: false,
					errors: [
						{ line: 10, column: 5, message: 'Unexpected token' },
						{ line: 15, column: 1, message: 'Missing semicolon' },
					],
				},
			],
		};
		const result = SyntaxEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.files[0].errors.length).toBe(2);
			expect(result.data.files[0].errors[0].line).toBe(10);
		}
	});

	it('default skipped_count applied', () => {
		const evidence = {
			task_id: '2.1',
			type: 'syntax' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'pass' as const,
			summary: 'All files passed syntax check',
			files_checked: 10,
			files_failed: 0,
		};
		const result = SyntaxEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.skipped_count).toBe(0);
		}
	});
});

describe('PlaceholderEvidenceSchema', () => {
	it('valid placeholder evidence parses with all fields', () => {
		const evidence = {
			task_id: '3.1',
			type: 'placeholder' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'info' as const,
			summary: 'Placeholder detection complete',
			findings: [
				{
					path: 'src/placeholder.ts',
					line: 42,
					kind: 'function_body' as const,
					excerpt: '// TODO: implement',
					rule_id: 'placeholder-function',
				},
			],
			files_scanned: 50,
			files_with_findings: 1,
			findings_count: 1,
		};
		const result = PlaceholderEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('placeholder');
			expect(result.data.findings_count).toBe(1);
			expect(result.data.findings[0].kind).toBe('function_body');
		}
	});

	it('missing required field (findings_count) rejects', () => {
		const evidence = {
			task_id: '3.1',
			type: 'placeholder' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'info' as const,
			summary: 'Placeholder detection complete',
			files_scanned: 50,
			files_with_findings: 0,
		};
		const result = PlaceholderEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('findings with all kinds parse correctly', () => {
		const evidence = {
			task_id: '3.1',
			type: 'placeholder' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'info' as const,
			summary: 'Placeholder detection complete',
			findings: [
				{
					path: 'src/a.ts',
					line: 1,
					kind: 'comment' as const,
					excerpt: '// TODO',
					rule_id: 't1',
				},
				{
					path: 'src/b.ts',
					line: 2,
					kind: 'string' as const,
					excerpt: '"FIXME"',
					rule_id: 't2',
				},
				{
					path: 'src/c.ts',
					line: 3,
					kind: 'function_body' as const,
					excerpt: 'throw new Error()',
					rule_id: 't3',
				},
				{
					path: 'src/d.ts',
					line: 4,
					kind: 'other' as const,
					excerpt: '...',
					rule_id: 't4',
				},
			],
			files_scanned: 10,
			files_with_findings: 4,
			findings_count: 4,
		};
		const result = PlaceholderEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.findings.length).toBe(4);
		}
	});

	it('empty findings array parses with defaults', () => {
		const evidence = {
			task_id: '3.1',
			type: 'placeholder' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'info' as const,
			summary: 'No placeholders found',
			files_scanned: 50,
			files_with_findings: 0,
			findings_count: 0,
		};
		const result = PlaceholderEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.findings).toEqual([]);
		}
	});
});

describe('SastEvidenceSchema', () => {
	it('valid SAST evidence parses with all fields', () => {
		const evidence = {
			task_id: '4.1',
			type: 'sast' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'pass' as const,
			summary: 'Security scan complete',
			findings: [
				{
					rule_id: 'G401',
					severity: 'high' as const,
					message: 'Use of weak cryptographic algorithm',
					location: { file: 'src/crypto.ts', line: 15, column: 10 },
					remediation: 'Use AES-256 instead',
				},
			],
			engine: 'tier_a+tier_b' as const,
			files_scanned: 25,
			findings_count: 1,
			findings_by_severity: {
				critical: 0,
				high: 1,
				medium: 0,
				low: 0,
			},
		};
		const result = SastEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('sast');
			expect(result.data.engine).toBe('tier_a+tier_b');
			expect(result.data.findings[0].severity).toBe('high');
		}
	});

	it('missing required field (engine) rejects', () => {
		const evidence = {
			task_id: '4.1',
			type: 'sast' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'pass' as const,
			summary: 'Security scan complete',
			files_scanned: 25,
			findings_count: 0,
			findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
		};
		const result = SastEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('findings_by_severity validation works', () => {
		const evidence = {
			task_id: '4.1',
			type: 'sast' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'fail' as const,
			summary: 'Security issues found',
			findings: [],
			engine: 'tier_a' as const,
			files_scanned: 10,
			findings_count: 5,
			findings_by_severity: {
				critical: 1,
				high: 2,
				medium: 1,
				low: 1,
			},
		};
		const result = SastEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.findings_by_severity.critical).toBe(1);
			expect(result.data.findings_by_severity.high).toBe(2);
		}
	});

	it('invalid severity rejects', () => {
		const evidence = {
			task_id: '4.1',
			type: 'sast' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'pass' as const,
			summary: 'Security scan complete',
			findings: [
				{
					rule_id: 'G401',
					severity: 'invalid' as any,
					message: 'Test',
					location: { file: 'src/test.ts', line: 1 },
				},
			],
			engine: 'tier_a' as const,
			files_scanned: 1,
			findings_count: 1,
			findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
		};
		const result = SastEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('optional column and remediation parse correctly', () => {
		const evidence = {
			task_id: '4.1',
			type: 'sast' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'pass' as const,
			summary: 'Security scan complete',
			findings: [
				{
					rule_id: 'G401',
					severity: 'high' as const,
					message: 'Use of weak crypto',
					location: { file: 'src/test.ts', line: 5 },
				},
			],
			engine: 'tier_a' as const,
			files_scanned: 1,
			findings_count: 1,
			findings_by_severity: { critical: 0, high: 1, medium: 0, low: 0 },
		};
		const result = SastEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.findings[0].location.column).toBeUndefined();
			expect(result.data.findings[0].remediation).toBeUndefined();
		}
	});
});

describe('SbomEvidenceSchema', () => {
	it('valid SBOM evidence parses with all fields', () => {
		const evidence = {
			task_id: '5.1',
			type: 'sbom' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'info' as const,
			summary: 'SBOM generated',
			components: [
				{
					name: 'express',
					version: '4.18.2',
					type: 'framework' as const,
					purl: 'pkg:npm/express@4.18.2',
					license: 'MIT',
				},
			],
			metadata: {
				timestamp: '2026-02-09T12:00:00.000Z',
				tool: 'syft',
				tool_version: '0.100.0',
			},
			files: ['package.json', 'package-lock.json'],
			components_count: 1,
			output_path: 'sbom.json',
		};
		const result = SbomEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('sbom');
			expect(result.data.components_count).toBe(1);
			expect(result.data.components[0].type).toBe('framework');
		}
	});

	it('missing required field (output_path) rejects', () => {
		const evidence = {
			task_id: '5.1',
			type: 'sbom' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'info' as const,
			summary: 'SBOM generated',
			components: [],
			metadata: {
				timestamp: '2026-02-09T12:00:00.000Z',
				tool: 'syft',
				tool_version: '0.100.0',
			},
			files: [],
			components_count: 0,
		};
		const result = SbomEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('all component types parse correctly', () => {
		const evidence = {
			task_id: '5.1',
			type: 'sbom' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'info' as const,
			summary: 'SBOM generated',
			components: [
				{ name: 'react', version: '18.2.0', type: 'library' as const },
				{ name: 'next', version: '13.0.0', type: 'framework' as const },
				{ name: 'myapp', version: '1.0.0', type: 'application' as const },
			],
			metadata: {
				timestamp: '2026-02-09T12:00:00.000Z',
				tool: 'syft',
				tool_version: '0.100.0',
			},
			files: ['package.json'],
			components_count: 3,
			output_path: 'sbom.json',
		};
		const result = SbomEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.components.length).toBe(3);
		}
	});

	it('optional purl and license work correctly', () => {
		const evidence = {
			task_id: '5.1',
			type: 'sbom' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'info' as const,
			summary: 'SBOM generated',
			components: [
				{ name: 'unknown-lib', version: '1.0.0', type: 'library' as const },
			],
			metadata: {
				timestamp: '2026-02-09T12:00:00.000Z',
				tool: 'syft',
				tool_version: '0.100.0',
			},
			files: [],
			components_count: 1,
			output_path: 'sbom.json',
		};
		const result = SbomEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.components[0].purl).toBeUndefined();
			expect(result.data.components[0].license).toBeUndefined();
		}
	});
});

describe('BuildEvidenceSchema', () => {
	it('valid build evidence parses with all fields', () => {
		const evidence = {
			task_id: '6.1',
			type: 'build' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'pass' as const,
			summary: 'Build successful',
			runs: [
				{
					kind: 'build' as const,
					command: 'npm run build',
					cwd: '/project',
					exit_code: 0,
					duration_ms: 5000,
					stdout_tail: 'Build complete',
					stderr_tail: '',
				},
			],
			files_scanned: 100,
			runs_count: 1,
			failed_count: 0,
		};
		const result = BuildEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('build');
			expect(result.data.runs[0].kind).toBe('build');
			expect(result.data.runs[0].exit_code).toBe(0);
		}
	});

	it('missing required field (runs_count) rejects', () => {
		const evidence = {
			task_id: '6.1',
			type: 'build' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'pass' as const,
			summary: 'Build successful',
			files_scanned: 100,
			failed_count: 0,
		};
		const result = BuildEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('all run kinds parse correctly', () => {
		const evidence = {
			task_id: '6.1',
			type: 'build' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'pass' as const,
			summary: 'All checks passed',
			runs: [
				{
					kind: 'build' as const,
					command: 'npm run build',
					cwd: '.',
					exit_code: 0,
					duration_ms: 1000,
					stdout_tail: '',
					stderr_tail: '',
				},
				{
					kind: 'typecheck' as const,
					command: 'npm run typecheck',
					cwd: '.',
					exit_code: 0,
					duration_ms: 2000,
					stdout_tail: '',
					stderr_tail: '',
				},
				{
					kind: 'test' as const,
					command: 'npm test',
					cwd: '.',
					exit_code: 0,
					duration_ms: 5000,
					stdout_tail: '',
					stderr_tail: '',
				},
			],
			files_scanned: 50,
			runs_count: 3,
			failed_count: 0,
		};
		const result = BuildEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.runs.length).toBe(3);
		}
	});

	it('failed run parses correctly', () => {
		const evidence = {
			task_id: '6.1',
			type: 'build' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'fail' as const,
			summary: 'Build failed',
			runs: [
				{
					kind: 'build' as const,
					command: 'npm run build',
					cwd: '.',
					exit_code: 1,
					duration_ms: 5000,
					stdout_tail: '',
					stderr_tail: 'Error: Cannot find module',
				},
			],
			files_scanned: 10,
			runs_count: 1,
			failed_count: 1,
		};
		const result = BuildEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.failed_count).toBe(1);
			expect(result.data.runs[0].stderr_tail).toContain('Error');
		}
	});

	it('optional skipped_reason parses correctly', () => {
		const evidence = {
			task_id: '6.1',
			type: 'build' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'info' as const,
			summary: 'Build skipped',
			runs: [],
			files_scanned: 0,
			runs_count: 0,
			failed_count: 0,
			skipped_reason: 'No changes detected',
		};
		const result = BuildEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.skipped_reason).toBe('No changes detected');
		}
	});
});

describe('QualityBudgetEvidenceSchema', () => {
	it('valid quality budget evidence parses with all fields', () => {
		const evidence = {
			task_id: '7.1',
			type: 'quality_budget' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'pass' as const,
			summary: 'Quality budget within limits',
			metrics: {
				complexity_delta: -2,
				public_api_delta: 0,
				duplication_ratio: 0.05,
				test_to_code_ratio: 1.2,
			},
			thresholds: {
				max_complexity_delta: 10,
				max_public_api_delta: 5,
				max_duplication_ratio: 0.1,
				min_test_to_code_ratio: 0.8,
			},
			violations: [],
			files_analyzed: ['src/index.ts', 'src/utils.ts'],
		};
		const result = QualityBudgetEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('quality_budget');
			expect(result.data.metrics.complexity_delta).toBe(-2);
			expect(result.data.thresholds.max_complexity_delta).toBe(10);
		}
	});

	it('missing required field (metrics) rejects', () => {
		const evidence = {
			task_id: '7.1',
			type: 'quality_budget' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'pass' as const,
			summary: 'Quality budget within limits',
			thresholds: {
				max_complexity_delta: 10,
				max_public_api_delta: 5,
				max_duplication_ratio: 0.1,
				min_test_to_code_ratio: 0.8,
			},
			files_analyzed: [],
		};
		const result = QualityBudgetEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('violations parse correctly', () => {
		const evidence = {
			task_id: '7.1',
			type: 'quality_budget' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'fail' as const,
			summary: 'Quality budget exceeded',
			metrics: {
				complexity_delta: 15,
				public_api_delta: 8,
				duplication_ratio: 0.15,
				test_to_code_ratio: 0.5,
			},
			thresholds: {
				max_complexity_delta: 10,
				max_public_api_delta: 5,
				max_duplication_ratio: 0.1,
				min_test_to_code_ratio: 0.8,
			},
			violations: [
				{
					type: 'complexity' as const,
					message: 'Complexity increased by 15',
					severity: 'error' as const,
					files: ['src/complex.ts'],
				},
				{
					type: 'test_ratio' as const,
					message: 'Test coverage too low',
					severity: 'warning' as const,
					files: ['src/main.ts', 'src/utils.ts'],
				},
			],
			files_analyzed: ['src/complex.ts', 'src/main.ts', 'src/utils.ts'],
		};
		const result = QualityBudgetEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.violations.length).toBe(2);
			expect(result.data.violations[0].type).toBe('complexity');
			expect(result.data.violations[1].severity).toBe('warning');
		}
	});

	it('all violation types parse correctly', () => {
		const evidence = {
			task_id: '7.1',
			type: 'quality_budget' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'fail' as const,
			summary: 'Multiple violations',
			metrics: {
				complexity_delta: 20,
				public_api_delta: 10,
				duplication_ratio: 0.2,
				test_to_code_ratio: 0.3,
			},
			thresholds: {
				max_complexity_delta: 10,
				max_public_api_delta: 5,
				max_duplication_ratio: 0.1,
				min_test_to_code_ratio: 0.8,
			},
			violations: [
				{
					type: 'complexity' as const,
					message: 'c',
					severity: 'error' as const,
					files: ['a.ts'],
				},
				{
					type: 'api' as const,
					message: 'a',
					severity: 'error' as const,
					files: ['b.ts'],
				},
				{
					type: 'duplication' as const,
					message: 'd',
					severity: 'error' as const,
					files: ['c.ts'],
				},
				{
					type: 'test_ratio' as const,
					message: 't',
					severity: 'warning' as const,
					files: ['d.ts'],
				},
			],
			files_analyzed: [],
		};
		const result = QualityBudgetEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.violations.length).toBe(4);
		}
	});
});

describe('SecretscanEvidenceSchema', () => {
	it('requires incomplete_files and preserves incomplete_paths diagnostics', () => {
		const valid = SecretscanEvidenceSchema.safeParse({
			task_id: '1.1',
			type: 'secretscan' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'pre_check_batch',
			verdict: 'fail' as const,
			summary: 'Scan incomplete',
			findings_count: 0,
			scan_directory: 'src',
			files_scanned: 0,
			skipped_files: 1,
			incomplete_files: 1,
			incomplete_paths: [{ path: 'src/oversized.txt', reason: 'oversized' }],
		});
		expect(valid.success).toBe(true);
		if (valid.success) {
			expect(valid.data.incomplete_files).toBe(1);
			expect(valid.data.incomplete_paths).toEqual([
				{ path: 'src/oversized.txt', reason: 'oversized' },
			]);
		}

		const missingIncompleteFiles = SecretscanEvidenceSchema.safeParse({
			task_id: '1.1',
			type: 'secretscan' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'pre_check_batch',
			verdict: 'pass' as const,
			summary: 'Scan complete',
			findings_count: 0,
			scan_directory: 'src',
			files_scanned: 1,
			skipped_files: 0,
		});
		expect(missingIncompleteFiles.success).toBe(false);
	});
});

describe('EvidenceSchema - All 12 Types Compilation', () => {
	it('review type compiles and parses in union', () => {
		const evidence = {
			task_id: '1.1',
			type: 'review' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'pass' as const,
			summary: 'Code review passed',
			risk: 'low' as const,
			issues: [],
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('review');
		}
	});

	it('test type compiles and parses in union', () => {
		const evidence = {
			task_id: '1.2',
			type: 'test' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_test_engineer',
			verdict: 'pass' as const,
			summary: 'Tests passed',
			tests_passed: 10,
			tests_failed: 0,
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('test');
		}
	});

	it('diff type compiles and parses in union', () => {
		const evidence = {
			task_id: '1.3',
			type: 'diff' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'info' as const,
			summary: 'Changes made',
			files_changed: ['a.ts'],
			additions: 10,
			deletions: 5,
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('diff');
		}
	});

	it('approval type compiles and parses in union', () => {
		const evidence = {
			task_id: '1.4',
			type: 'approval' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'approved' as const,
			summary: 'Changes approved',
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('approval');
		}
	});

	it('note type compiles and parses in union', () => {
		const evidence = {
			task_id: '1.5',
			type: 'note' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'info' as const,
			summary: 'Test note',
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('note');
		}
	});

	it('retrospective type compiles and parses in union', () => {
		const evidence = {
			task_id: '1.6',
			type: 'retrospective' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'info' as const,
			summary: 'Phase retrospective',
			phase_number: 1,
			total_tool_calls: 100,
			coder_revisions: 2,
			reviewer_rejections: 1,
			test_failures: 0,
			security_findings: 0,
			integration_issues: 0,
			task_count: 5,
			task_complexity: 'moderate' as const,
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('retrospective');
		}
	});

	it('syntax type compiles and parses in union', () => {
		const evidence = {
			task_id: '2.1',
			type: 'syntax' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'pass' as const,
			summary: 'Syntax check passed',
			files_checked: 10,
			files_failed: 0,
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('syntax');
		}
	});

	it('placeholder type compiles and parses in union', () => {
		const evidence = {
			task_id: '3.1',
			type: 'placeholder' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'info' as const,
			summary: 'Placeholder scan complete',
			files_scanned: 50,
			files_with_findings: 0,
			findings_count: 0,
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('placeholder');
		}
	});

	it('sast type compiles and parses in union', () => {
		const evidence = {
			task_id: '4.1',
			type: 'sast' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'pass' as const,
			summary: 'Security scan passed',
			files_scanned: 25,
			findings_count: 0,
			engine: 'tier_a' as const,
			findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('sast');
		}
	});

	it('sbom type compiles and parses in union', () => {
		const evidence = {
			task_id: '5.1',
			type: 'sbom' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'info' as const,
			summary: 'SBOM generated',
			components: [],
			metadata: {
				timestamp: '2026-02-09T12:00:00.000Z',
				tool: 'syft',
				tool_version: '1.0.0',
			},
			files: [],
			components_count: 0,
			output_path: 'sbom.json',
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('sbom');
		}
	});

	it('build type compiles and parses in union', () => {
		const evidence = {
			task_id: '6.1',
			type: 'build' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'pass' as const,
			summary: 'Build successful',
			runs: [],
			files_scanned: 10,
			runs_count: 0,
			failed_count: 0,
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('build');
		}
	});

	it('quality_budget type compiles and parses in union', () => {
		const evidence = {
			task_id: '7.1',
			type: 'quality_budget' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'pass' as const,
			summary: 'Quality within budget',
			metrics: {
				complexity_delta: 0,
				public_api_delta: 0,
				duplication_ratio: 0,
				test_to_code_ratio: 1,
			},
			thresholds: {
				max_complexity_delta: 10,
				max_public_api_delta: 5,
				max_duplication_ratio: 0.1,
				min_test_to_code_ratio: 0.8,
			},
			files_analyzed: [],
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('quality_budget');
		}
	});
});

describe('EvidenceSchema - Discriminated Union Exhaustive', () => {
	it('type narrowing works via discriminated union', () => {
		const evidence: Evidence = {
			task_id: '1.1',
			type: 'review',
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'pass',
			summary: 'Code review passed',
			risk: 'low',
			issues: [],
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			// Type narrowing should work
			if (result.data.type === 'review') {
				expect(result.data.risk).toBe('low');
			}
		}
	});

	it('exhaustive check - all 12 types handle', () => {
		const allTypes: EvidenceType[] = [
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
		];
		expect(allTypes.length).toBe(12);
		// Each should parse without error
		for (const type of allTypes) {
			const base = {
				task_id: '1.1',
				type,
				timestamp: '2026-02-09T12:00:00.000Z',
				agent: 'test',
				verdict: 'info' as const,
				summary: 'test',
			};
			// Build minimal valid data per type
			let data: any = { ...base };
			switch (type) {
				case 'review':
					data = { ...data, risk: 'low' as const, issues: [] };
					break;
				case 'test':
					data = { ...data, tests_passed: 1, tests_failed: 0, failures: [] };
					break;
				case 'diff':
					data = { ...data, files_changed: [], additions: 0, deletions: 0 };
					break;
				case 'approval':
				case 'note':
					break;
				case 'retrospective':
					data = {
						...data,
						phase_number: 1,
						total_tool_calls: 0,
						coder_revisions: 0,
						reviewer_rejections: 0,
						test_failures: 0,
						security_findings: 0,
						integration_issues: 0,
						task_count: 1,
						task_complexity: 'simple' as const,
					};
					break;
				case 'syntax':
					data = { ...data, files_checked: 0, files_failed: 0 };
					break;
				case 'placeholder':
					data = {
						...data,
						files_scanned: 0,
						files_with_findings: 0,
						findings_count: 0,
					};
					break;
				case 'sast':
					data = {
						...data,
						findings: [],
						engine: 'tier_a' as const,
						files_scanned: 0,
						findings_count: 0,
						findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
					};
					break;
				case 'sbom':
					data = {
						...data,
						components: [],
						metadata: {
							timestamp: '2026-02-09T12:00:00.000Z',
							tool: 'test',
							tool_version: '1.0',
						},
						files: [],
						components_count: 0,
						output_path: 'test.json',
					};
					break;
				case 'build':
					data = {
						...data,
						runs: [],
						files_scanned: 0,
						runs_count: 0,
						failed_count: 0,
					};
					break;
				case 'quality_budget':
					data = {
						...data,
						metrics: {
							complexity_delta: 0,
							public_api_delta: 0,
							duplication_ratio: 0,
							test_to_code_ratio: 1,
						},
						thresholds: {
							max_complexity_delta: 10,
							max_public_api_delta: 5,
							max_duplication_ratio: 0.1,
							min_test_to_code_ratio: 0.8,
						},
						files_analyzed: [],
					};
					break;
			}
			const result = EvidenceSchema.safeParse(data);
			expect(result.success).toBe(true);
		}
	});

	it('invalid type is rejected by discriminated union', () => {
		const evidence = {
			task_id: '1.1',
			type: 'invalid_type' as any,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'test',
			verdict: 'info' as const,
			summary: 'test',
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});
});

describe('EvidenceSchema - Type Guards', () => {
	it('type guard: isReviewEvidence works', () => {
		const evidence: Evidence = {
			task_id: '1.1',
			type: 'review',
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'pass',
			summary: 'Code review passed',
			risk: 'low',
			issues: [],
		};
		const isReview = evidence.type === 'review';
		expect(isReview).toBe(true);
	});

	it('type guard: isTestEvidence works', () => {
		const evidence: Evidence = {
			task_id: '1.1',
			type: 'test',
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_test_engineer',
			verdict: 'pass',
			summary: 'Tests passed',
			tests_passed: 10,
			tests_failed: 0,
			failures: [],
		};
		const isTest = evidence.type === 'test';
		expect(isTest).toBe(true);
	});

	it('type narrowing in switch works correctly', () => {
		const evidences: Evidence[] = [
			{
				task_id: '1',
				type: 'review',
				timestamp: '2026-02-09T12:00:00.000Z',
				agent: 'a',
				verdict: 'pass',
				summary: 's',
				risk: 'low',
				issues: [],
			},
			{
				task_id: '2',
				type: 'test',
				timestamp: '2026-02-09T12:00:00.000Z',
				agent: 'a',
				verdict: 'pass',
				summary: 's',
				tests_passed: 5,
				tests_failed: 0,
				failures: [],
			},
			{
				task_id: '3',
				type: 'sast',
				timestamp: '2026-02-09T12:00:00.000Z',
				agent: 'a',
				verdict: 'pass',
				summary: 's',
				findings: [],
				engine: 'tier_a',
				files_scanned: 1,
				findings_count: 0,
				findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
			},
		];
		const types = evidences.map((e) => e.type);
		expect(types).toEqual(['review', 'test', 'sast']);
	});

	it('discriminated union discriminates correctly', () => {
		const testEvidence: Evidence = {
			task_id: '1.1',
			type: 'test',
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_test_engineer',
			verdict: 'pass',
			summary: 'Tests passed',
			tests_passed: 10,
			tests_failed: 0,
			failures: [],
		};
		const result = EvidenceSchema.safeParse(testEvidence);
		expect(result.success).toBe(true);
		if (result.success) {
			// Should have tests_passed property
			expect('tests_passed' in result.data).toBe(true);
			// Should NOT have risk property (that's for review)
			expect('risk' in result.data).toBe(false);
		}
	});
});

describe('EvidenceSchema - Invalid Data Rejection', () => {
	it('review evidence without risk rejects', () => {
		const evidence = {
			task_id: '1.1',
			type: 'review' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'pass' as const,
			summary: 'Code review',
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('test evidence with negative tests_passed rejects', () => {
		const evidence = {
			task_id: '1.1',
			type: 'test' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_test_engineer',
			verdict: 'pass' as const,
			summary: 'Tests',
			tests_passed: -1,
			tests_failed: 0,
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('sast evidence with invalid engine rejects', () => {
		const evidence = {
			task_id: '1.1',
			type: 'sast' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'pass' as const,
			summary: 'Security scan',
			engine: 'invalid_tier' as any,
			files_scanned: 1,
			findings_count: 0,
			findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('retrospective evidence without phase_number rejects', () => {
		const evidence = {
			task_id: '1.1',
			type: 'retrospective' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_reviewer',
			verdict: 'info' as const,
			summary: 'Retrospective',
			total_tool_calls: 100,
			task_count: 5,
			task_complexity: 'simple' as const,
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('build evidence without runs_count rejects', () => {
		const evidence = {
			task_id: '1.1',
			type: 'build' as const,
			timestamp: '2026-02-09T12:00:00.000Z',
			agent: 'mega_coder',
			verdict: 'pass' as const,
			summary: 'Build',
			files_scanned: 10,
			failed_count: 0,
		};
		const result = EvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});
});

describe('EvidenceBundleSchema - All 12 Types', () => {
	it('bundle with review evidence parses', () => {
		const bundle = {
			schema_version: '1.0.0' as const,
			task_id: '1.1',
			entries: [
				{
					task_id: '1.1',
					type: 'review' as const,
					timestamp: '2026-02-09T12:00:00.000Z',
					agent: 'mega_reviewer',
					verdict: 'pass' as const,
					summary: 'Review passed',
					risk: 'low' as const,
					issues: [],
				},
			],
			created_at: '2026-02-09T12:00:00.000Z',
			updated_at: '2026-02-09T12:00:00.000Z',
		};
		const result = EvidenceBundleSchema.safeParse(bundle);
		expect(result.success).toBe(true);
	});

	it('bundle with mixed evidence types parses', () => {
		const bundle = {
			schema_version: '1.0.0' as const,
			task_id: '1.1',
			entries: [
				{
					task_id: '1.1',
					type: 'note' as const,
					timestamp: '2026-02-09T12:00:00.000Z',
					agent: 'a',
					verdict: 'info' as const,
					summary: 'n',
				},
				{
					task_id: '1.1',
					type: 'test' as const,
					timestamp: '2026-02-09T12:00:00.000Z',
					agent: 'a',
					verdict: 'pass' as const,
					summary: 't',
					tests_passed: 5,
					tests_failed: 0,
				},
				{
					task_id: '1.1',
					type: 'sast' as const,
					timestamp: '2026-02-09T12:00:00.000Z',
					agent: 'a',
					verdict: 'pass' as const,
					summary: 's',
					engine: 'tier_a' as const,
					files_scanned: 1,
					findings_count: 0,
					findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
				},
				{
					task_id: '1.1',
					type: 'build' as const,
					timestamp: '2026-02-09T12:00:00.000Z',
					agent: 'a',
					verdict: 'pass' as const,
					summary: 'b',
					runs: [],
					files_scanned: 1,
					runs_count: 0,
					failed_count: 0,
				},
			],
			created_at: '2026-02-09T12:00:00.000Z',
			updated_at: '2026-02-09T12:00:00.000Z',
		};
		const result = EvidenceBundleSchema.safeParse(bundle);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.entries.length).toBe(4);
		}
	});

	it('bundle with all 12 evidence types parses', () => {
		const bundle = {
			schema_version: '1.0.0' as const,
			task_id: '1.1',
			entries: [
				{
					task_id: '1.1',
					type: 'review' as const,
					timestamp: '2026-02-09T12:00:00.000Z',
					agent: 'a',
					verdict: 'pass' as const,
					summary: 's',
					risk: 'low' as const,
					issues: [],
				},
				{
					task_id: '1.1',
					type: 'test' as const,
					timestamp: '2026-02-09T12:00:00.000Z',
					agent: 'a',
					verdict: 'pass' as const,
					summary: 's',
					tests_passed: 1,
					tests_failed: 0,
				},
				{
					task_id: '1.1',
					type: 'diff' as const,
					timestamp: '2026-02-09T12:00:00.000Z',
					agent: 'a',
					verdict: 'info' as const,
					summary: 's',
					files_changed: [],
					additions: 0,
					deletions: 0,
				},
				{
					task_id: '1.1',
					type: 'approval' as const,
					timestamp: '2026-02-09T12:00:00.000Z',
					agent: 'a',
					verdict: 'approved' as const,
					summary: 's',
				},
				{
					task_id: '1.1',
					type: 'note' as const,
					timestamp: '2026-02-09T12:00:00.000Z',
					agent: 'a',
					verdict: 'info' as const,
					summary: 's',
				},
				{
					task_id: '1.1',
					type: 'retrospective' as const,
					timestamp: '2026-02-09T12:00:00.000Z',
					agent: 'a',
					verdict: 'info' as const,
					summary: 's',
					phase_number: 1,
					total_tool_calls: 0,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 1,
					task_complexity: 'simple' as const,
				},
				{
					task_id: '1.1',
					type: 'syntax' as const,
					timestamp: '2026-02-09T12:00:00.000Z',
					agent: 'a',
					verdict: 'pass' as const,
					summary: 's',
					files_checked: 1,
					files_failed: 0,
				},
				{
					task_id: '1.1',
					type: 'placeholder' as const,
					timestamp: '2026-02-09T12:00:00.000Z',
					agent: 'a',
					verdict: 'info' as const,
					summary: 's',
					files_scanned: 1,
					files_with_findings: 0,
					findings_count: 0,
				},
				{
					task_id: '1.1',
					type: 'sast' as const,
					timestamp: '2026-02-09T12:00:00.000Z',
					agent: 'a',
					verdict: 'pass' as const,
					summary: 's',
					engine: 'tier_a' as const,
					files_scanned: 1,
					findings_count: 0,
					findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
				},
				{
					task_id: '1.1',
					type: 'sbom' as const,
					timestamp: '2026-02-09T12:00:00.000Z',
					agent: 'a',
					verdict: 'info' as const,
					summary: 's',
					components: [],
					metadata: {
						timestamp: '2026-02-09T12:00:00.000Z',
						tool: 't',
						tool_version: '1',
					},
					files: [],
					components_count: 0,
					output_path: 'o.json',
				},
				{
					task_id: '1.1',
					type: 'build' as const,
					timestamp: '2026-02-09T12:00:00.000Z',
					agent: 'a',
					verdict: 'pass' as const,
					summary: 's',
					runs: [],
					files_scanned: 1,
					runs_count: 0,
					failed_count: 0,
				},
				{
					task_id: '1.1',
					type: 'quality_budget' as const,
					timestamp: '2026-02-09T12:00:00.000Z',
					agent: 'a',
					verdict: 'pass' as const,
					summary: 's',
					metrics: {
						complexity_delta: 0,
						public_api_delta: 0,
						duplication_ratio: 0,
						test_to_code_ratio: 1,
					},
					thresholds: {
						max_complexity_delta: 10,
						max_public_api_delta: 5,
						max_duplication_ratio: 0.1,
						min_test_to_code_ratio: 0.8,
					},
					files_analyzed: [],
				},
			],
			created_at: '2026-02-09T12:00:00.000Z',
			updated_at: '2026-02-09T12:00:00.000Z',
		};
		const result = EvidenceBundleSchema.safeParse(bundle);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.entries.length).toBe(12);
		}
	});
});

describe('RetrospectiveEvidenceSchema - new fields (v6.13.3)', () => {
	const validRetroBase = {
		task_id: 'retro-1',
		type: 'retrospective' as const,
		timestamp: '2026-02-09T12:00:00.000Z',
		agent: 'mega_reviewer',
		verdict: 'info' as const,
		summary: 'Phase 1 retrospective',
		phase_number: 1,
		total_tool_calls: 150,
		coder_revisions: 3,
		reviewer_rejections: 1,
		test_failures: 2,
		security_findings: 0,
		integration_issues: 1,
		task_count: 5,
		task_complexity: 'moderate' as const,
		top_rejection_reasons: [],
		lessons_learned: [],
	};

	it('user_directives validates with all category/scope combinations', () => {
		const evidence = {
			...validRetroBase,
			user_directives: [
				{
					directive: 'Use TypeScript strict mode',
					category: 'tooling' as const,
					scope: 'session' as const,
				},
				{
					directive: 'Follow naming conventions',
					category: 'code_style' as const,
					scope: 'project' as const,
				},
				{
					directive: 'Keep functions small',
					category: 'architecture' as const,
					scope: 'global' as const,
				},
				{
					directive: 'Write tests first',
					category: 'process' as const,
					scope: 'project' as const,
				},
				{
					directive: 'Avoid magic numbers',
					category: 'other' as const,
					scope: 'session' as const,
				},
			],
		};
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.user_directives.length).toBeGreaterThanOrEqual(5);
		}
	});

	it('user_directives defaults to empty array when omitted', () => {
		const evidence = { ...validRetroBase };
		// @ts-ignore - intentionally omitting user_directives
		delete evidence.user_directives;
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.user_directives).toEqual([]);
		}
	});

	it('user_directives rejects invalid category value', () => {
		const evidence = {
			...validRetroBase,
			user_directives: [
				{
					directive: 'Test directive',
					category: 'invalid_cat' as any,
					scope: 'session' as const,
				},
			],
		};
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('user_directives rejects invalid scope value', () => {
		const evidence = {
			...validRetroBase,
			user_directives: [
				{
					directive: 'Test directive',
					category: 'tooling' as const,
					scope: 'team' as any,
				},
			],
		};
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('approaches_tried validates with all result values', () => {
		const evidence = {
			...validRetroBase,
			approaches_tried: [
				{
					approach: 'First approach - direct implementation',
					result: 'success' as const,
				},
				{
					approach: 'Second approach - refactored implementation',
					result: 'failure' as const,
					abandoned_reason: 'Too complex',
				},
				{
					approach: 'Third approach - hybrid solution',
					result: 'partial' as const,
				},
			],
		};
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.approaches_tried.length).toBe(3);
		}
	});

	it('approaches_tried defaults to empty array when omitted', () => {
		const evidence = { ...validRetroBase };
		// @ts-ignore - intentionally omitting approaches_tried
		delete evidence.approaches_tried;
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.approaches_tried).toEqual([]);
		}
	});

	it('approaches_tried respects max(10) limit', () => {
		const evidence = {
			...validRetroBase,
			approaches_tried: Array.from({ length: 11 }, (_, i) => ({
				approach: `Approach ${i + 1}`,
				result: 'success' as const,
			})),
		};
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('approaches_tried rejects invalid result enum value', () => {
		const evidence = {
			...validRetroBase,
			approaches_tried: [
				{ approach: 'Test approach', result: 'skipped' as any },
			],
		};
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('full retrospective with all new and existing fields validates correctly', () => {
		const evidence = {
			...validRetroBase,
			user_directives: [
				{
					directive: 'Use TypeScript strict mode',
					category: 'tooling' as const,
					scope: 'session' as const,
				},
				{
					directive: 'Follow naming conventions',
					category: 'code_style' as const,
					scope: 'project' as const,
				},
			],
			approaches_tried: [
				{
					approach: 'First approach - direct implementation',
					result: 'success' as const,
				},
				{
					approach: 'Second approach - refactored implementation',
					result: 'failure' as const,
					abandoned_reason: 'Too complex',
				},
			],
		};
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.user_directives.length).toBe(2);
			expect(result.data.approaches_tried.length).toBe(2);
		}
	});

	it('existing retrospective without new fields still validates (backward compat)', () => {
		const evidence = { ...validRetroBase };
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.user_directives).toEqual([]);
			expect(result.data.approaches_tried).toEqual([]);
		}
	});
});
