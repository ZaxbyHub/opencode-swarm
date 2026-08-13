import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AGENT_TOOL_MAP } from '../../../src/config/constants.js';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeAbortPrWorkflow } from '../../../src/tools/abort-pr-workflow.js';
import { abort_pr_workflow } from '../../../src/tools/index.js';
import { TOOL_MANIFEST } from '../../../src/tools/manifest.js';
import { TOOL_NAMES } from '../../../src/tools/tool-names.js';

let directory = '';
const originalResolveCurrentGitHead = gateInternals.resolveCurrentGitHead;
const originalResolveIsWorkingTreeClean =
	gateInternals.resolveIsWorkingTreeClean;

beforeEach(() => {
	directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'abort-tool-')));
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => 'abc123';
	gateInternals.resolveIsWorkingTreeClean = () => true;
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originalResolveCurrentGitHead;
	gateInternals.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('abort_pr_workflow tool', () => {
	test('is registered as an architect-only controller tool', () => {
		expect(TOOL_NAMES).toContain('abort_pr_workflow');
		expect(TOOL_MANIFEST.abort_pr_workflow).toBeDefined();
		expect(AGENT_TOOL_MAP.architect).toContain('abort_pr_workflow');
		expect(AGENT_TOOL_MAP.explorer).not.toContain('abort_pr_workflow');
		// The createSwarmTool wrapper must expose the args surface so the
		// architect can discover it.
		expect(abort_pr_workflow.args.mode).toBeDefined();
		expect(abort_pr_workflow.args.kind).toBeDefined();
		expect(abort_pr_workflow.args.reason).toBeDefined();
	});

	test('rejects invalid arguments', async () => {
		// kind and reason are required, so {} is a validation failure.
		const result = JSON.parse(await executeAbortPrWorkflow({}, directory));
		expect(result.success).toBe(false);
		expect(result.message).toContain('Invalid PR workflow abort');
		// An unknown key is also a strict-schema violation.
		const strictViolation = JSON.parse(
			await executeAbortPrWorkflow(
				{ unexpected_field: true, kind: 'recovery', reason: 'x' },
				directory,
				{ sessionID: 's1' },
			),
		);
		expect(strictViolation.success).toBe(false);
		expect(strictViolation.message).toContain('Invalid PR workflow abort');
	});

	test('requires an active sessionID', async () => {
		const result = JSON.parse(
			await executeAbortPrWorkflow(
				{ mode: 'PR_REVIEW', kind: 'recovery', reason: 'cause' },
				directory,
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('requires an active sessionID');
	});

	test('reports failure JSON when no gate is active', async () => {
		const result = JSON.parse(
			await executeAbortPrWorkflow(
				{ mode: 'PR_REVIEW', kind: 'recovery', reason: 'cause' },
				directory,
				{ sessionID: 'no-gate' },
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('no active PR workflow gate');
	});

	test('clears the gate and returns a success summary (deadlock case)', async () => {
		await activatePrWorkflow(directory, 'deadlock', 'PR_REVIEW');
		const result = JSON.parse(
			await executeAbortPrWorkflow(
				{
					mode: 'PR_REVIEW',
					kind: 'recovery',
					reason: 'compound checkout rejected',
				},
				directory,
				{ sessionID: 'deadlock' },
			),
		);
		expect(result).toMatchObject({
			success: true,
			mode: 'PR_REVIEW',
			open_lanes: 0,
			gate_cleared: true,
		});
		// pr_head_sha is omitted on the deadlock path (no binding).
		expect(result.pr_head_sha).toBeUndefined();
	});
});
