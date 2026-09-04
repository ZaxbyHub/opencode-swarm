import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AGENT_TOOL_MAP } from '../../../src/config/constants.js';
import {
	abortPrWorkflow,
	activatePrWorkflow,
	_test_exports as gateInternals,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeAbortPrWorkflow } from '../../../src/tools/abort-pr-workflow.js';
import { abort_pr_workflow } from '../../../src/tools/index.js';
import { TOOL_MANIFEST } from '../../../src/tools/manifest.js';
import { TOOL_NAMES } from '../../../src/tools/tool-names.js';
import { writeAuthoritativePrWorkflowState } from '../../helpers/pr-workflow-state-authority.js';

let directory = '';
const originalResolveCurrentGitHead = gateInternals.resolveCurrentGitHead;
const originalResolveIsWorkingTreeClean =
	gateInternals.resolveIsWorkingTreeClean;

beforeEach(() => {
	directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'abort-tool-')));
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => 'abc123';
	gateInternals.resolveIsWorkingTreeClean = () => true;
	// Issue #2251: settlement probes host session liveness. Pin "no host" so a
	// `swarmState.opencodeClient` leaked by another file cannot make this suite
	// order-dependent (or make it wait out the probe's real 5s deadline).
	gateInternals.getSessionOps = () => null;
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originalResolveCurrentGitHead;
	gateInternals.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	await fs.rm(directory, { recursive: true, force: true });
});

/** Write arbitrary bytes to the durable gate-state path for `sessionID`. */
async function writeGateStateBytes(
	sessionID: string,
	bytes: string,
): Promise<void> {
	const absolute = path.join(
		directory,
		'.swarm',
		gateInternals.workflowGateStateRelativePath(sessionID),
	);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	await fs.writeFile(absolute, bytes, 'utf-8');
}

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

	test('rejects kind:force — force is not agent-callable (ST-001)', async () => {
		const result = JSON.parse(
			await executeAbortPrWorkflow(
				{ mode: 'PR_REVIEW', kind: 'force', reason: 'try to bypass' },
				directory,
				{ sessionID: 's1' },
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('Invalid PR workflow abort');
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
			checkout_restore_required: false,
			checkout_restore_receipts: [],
		});
		// pr_head_sha is omitted on the deadlock path (no binding).
		expect(result.pr_head_sha).toBeUndefined();
	});

	test('FB-004: the tool response carries the salvage and CAS disclosures', async () => {
		// A schema-invalid state with an UNSALVAGEABLE revision exercises both
		// disclosures at once: the gate salvages the state to clear it at all, and
		// takes the documented CAS escape because there is no revision to compare.
		// The operator reads THIS response first, so the disclosures have to be
		// here, not only in events.jsonl and pr_workflow_status.
		await writeGateStateBytes(
			'salvage-tool',
			JSON.stringify({
				schemaVersion: 1,
				revision: 'not-a-number',
				sessionID: 'salvage-tool',
				mode: 'PR_REVIEW',
				activatedAt: '2026-07-19T00:00:00.000Z',
				updatedAt: '2026-07-19T00:00:00.000Z',
				prReviewValidationBatches: 'not-an-array',
			}),
		);

		const result = JSON.parse(
			await executeAbortPrWorkflow(
				{ mode: 'PR_REVIEW', kind: 'recovery', reason: 'state corrupted' },
				directory,
				{ sessionID: 'salvage-tool' },
			),
		);

		expect(result).toMatchObject({
			success: true,
			gate_cleared: true,
			state_salvaged: true,
			cas_escape_disclosure:
				'state revision unsalvageable; cleared without compare-and-swap',
		});
		expect(result.state_salvage_disclosure).toContain(
			'failed schema validation',
		);
	});

	test('FB-008: a failed CAS-guarded clear records a retraction and still throws', async () => {
		await activatePrWorkflow(directory, 'cas-race', 'PR_REVIEW');
		const statePath = path.join(
			directory,
			'.swarm',
			gateInternals.workflowGateStateRelativePath('cas-race'),
		);
		// Simulate the concurrent mutation between the durable audit append and
		// the clear: bump the on-disk revision so the clear's CAS read mismatches.
		gateInternals.beforeAbortClear = async () => {
			const current = JSON.parse(await fs.readFile(statePath, 'utf-8'));
			await writeAuthoritativePrWorkflowState(directory, {
				...current,
				revision: current.revision + 1,
			});
		};

		await expect(
			abortPrWorkflow(directory, 'cas-race', {
				kind: 'recovery',
				reason: 'raced with a concurrent mutation',
			}),
		).rejects.toThrow(/changed during terminal completion/i);

		const events = (
			await fs.readFile(path.join(directory, '.swarm', 'events.jsonl'), 'utf-8')
		)
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		// The abort event is durable and deliberately precedes the clear, so the
		// trail would otherwise assert an abort that never executed.
		expect(events.some((e) => e.type === 'pr_workflow_aborted')).toBe(true);
		const retraction = events.find(
			(e) => e.type === 'pr_workflow_abort_not_completed',
		);
		expect(retraction).toBeDefined();
		// Correlation fields so the retraction can be matched to what it retracts.
		expect(retraction.sessionID).toBe('cas-race');
		expect(retraction.mode).toBe('PR_REVIEW');
		expect(retraction.reason).toBe('raced with a concurrent mutation');
		expect(retraction.failure).toMatch(/changed during terminal completion/i);
		expect(retraction.disclosure).toContain('did NOT complete');
		// The gate must NOT have been cleared — the retraction says so truthfully.
		expect(await fs.stat(statePath)).toBeDefined();
	});
});
