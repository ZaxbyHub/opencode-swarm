import { describe, expect, test } from 'bun:test';
import { AGENT_TOOL_MAP } from '../../../src/config/constants.js';
import { executeCompletePrWorkflow } from '../../../src/tools/complete-pr-workflow.js';
import { TOOL_MANIFEST } from '../../../src/tools/manifest.js';
import { TOOL_NAMES } from '../../../src/tools/tool-names.js';

describe('complete_pr_workflow', () => {
	test('is registered as an architect-only terminal gate tool', () => {
		expect(TOOL_NAMES).toContain('complete_pr_workflow');
		expect(TOOL_MANIFEST.complete_pr_workflow).toBeDefined();
		expect(AGENT_TOOL_MAP.architect).toContain('complete_pr_workflow');
		expect(AGENT_TOOL_MAP.explorer).not.toContain('complete_pr_workflow');
	});

	test('requires both valid arguments and an active session', async () => {
		const invalid = JSON.parse(
			await executeCompletePrWorkflow({}, process.cwd()),
		);
		expect(invalid.success).toBe(false);
		expect(invalid.message).toContain('Invalid PR workflow completion');

		const missingSession = JSON.parse(
			await executeCompletePrWorkflow(
				{ mode: 'PR_REVIEW', pr_head_sha: 'abc123' },
				process.cwd(),
			),
		);
		expect(missingSession.success).toBe(false);
		expect(missingSession.message).toContain('requires an active sessionID');
	});
});
