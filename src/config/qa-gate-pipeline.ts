export interface QaGatePipelineStep {
	readonly id: string;
	readonly docsLabel: string;
	readonly protocolToken: string;
}

export const QA_GATE_PIPELINE_STEPS = [
	{ id: 'diff', docsLabel: '`diff`', protocolToken: 'diff' },
	{
		id: 'syntax_check',
		docsLabel: '`syntax_check`',
		protocolToken: 'syntax_check',
	},
	{
		id: 'placeholder_scan',
		docsLabel: '`placeholder_scan`',
		protocolToken: 'placeholder_scan',
	},
	{ id: 'imports', docsLabel: '`imports`', protocolToken: 'imports' },
	{ id: 'lint_fix', docsLabel: '`lint fix`', protocolToken: 'lint' },
	{
		id: 'build_check',
		docsLabel: '`build_check`',
		protocolToken: 'build_check',
	},
	{
		id: 'pre_check_batch',
		docsLabel: '`pre_check_batch`',
		protocolToken: 'pre_check_batch',
	},
	{ id: 'reviewer', docsLabel: '`reviewer`', protocolToken: 'reviewer' },
	{
		id: 'security_reviewer',
		docsLabel: '`security-reviewer`',
		protocolToken: 'security-reviewer',
	},
	{
		id: 'test_engineer_verification',
		docsLabel: '`test_engineer verification`',
		protocolToken: 'testengineer-verification',
	},
	{
		id: 'regression_sweep',
		docsLabel: '`regression-sweep`',
		protocolToken: 'regression-sweep',
	},
	{
		id: 'test_drift',
		docsLabel: '`test-drift`',
		protocolToken: 'test-drift',
	},
	{
		id: 'test_engineer_adversarial',
		docsLabel: '`test_engineer adversarial`',
		protocolToken: 'ADVERSARIAL TEST STEP',
	},
	{
		id: 'coverage_check',
		docsLabel: '`coverage check`',
		protocolToken: 'COVERAGE CHECK',
	},
	{
		id: 'pre_commit_checklist',
		docsLabel: '`pre-commit checklist`',
		protocolToken: 'PRE-COMMIT RULE',
	},
] as const satisfies readonly QaGatePipelineStep[];

export const QA_GATE_PIPELINE_STEP_COUNT = QA_GATE_PIPELINE_STEPS.length;
