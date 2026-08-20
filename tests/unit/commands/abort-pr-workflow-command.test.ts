import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleAbortPrWorkflowCommand } from '../../../src/commands/abort-pr-workflow.js';
import { COMMAND_REGISTRY } from '../../../src/commands/registry.js';
import { HUMAN_ONLY_SWARM_COMMANDS } from '../../../src/commands/tool-policy.js';
import {
	_test_exports,
	activatePrWorkflow,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';

let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;

beforeEach(() => {
	directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'abort-cmd-')));
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => 'abc123';
	_test_exports.resolveIsWorkingTreeClean = () => true;
	// Issue #2251: settlement probes host session liveness. Pin "no host" so a
	// `swarmState.opencodeClient` leaked by another file cannot make this suite
	// order-dependent (or make it wait out the probe's real 5s deadline).
	_test_exports.getSessionOps = () => null;
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('/swarm abort-pr-workflow command', () => {
	test('is registered as a restricted (human-only) command', () => {
		const entry = COMMAND_REGISTRY['abort-pr-workflow'];
		expect(entry).toBeDefined();
		expect(entry?.toolPolicy).toBe('restricted');
		// restricted commands must appear in HUMAN_ONLY_SWARM_COMMANDS so the
		// agent cannot invoke them via swarm_command (the user must run them).
		expect(HUMAN_ONLY_SWARM_COMMANDS.has('abort-pr-workflow')).toBe(true);
	});

	test('clears an active PR_REVIEW gate for the current session', async () => {
		await activatePrWorkflow(directory, 'cmd-session', 'PR_REVIEW');
		const result = await handleAbortPrWorkflowCommand(
			directory,
			['PR_REVIEW', 'compound checkout rejected'],
			'cmd-session',
		);
		expect(result).toContain('Aborted active PR_REVIEW');
		expect(result).toContain('cmd-session');
		expect(result).toContain('(force)');
		expect(result).toContain('prepare_pr_workflow_checkout operation=restore');
		expect(await readPrWorkflowGateState(directory, 'cmd-session')).toBeNull();
	});

	test('clears the active gate with no arguments (auto-detect mode, default force reason)', async () => {
		await activatePrWorkflow(directory, 'auto-session', 'PR_FEEDBACK');
		const result = await handleAbortPrWorkflowCommand(
			directory,
			[],
			'auto-session',
		);
		expect(result).toContain('Aborted active PR_FEEDBACK');
		expect(result).toContain('(force)');
		expect(await readPrWorkflowGateState(directory, 'auto-session')).toBeNull();
		// The command supplies a default reason for the audit trail when none is
		// given (issue #2131 finding 1a — the gate requires a non-empty reason).
		const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
		const event = JSON.parse(
			(await fs.readFile(eventsPath, 'utf-8'))
				.trim()
				.split('\n')
				.pop() as string,
		);
		expect(event.kind).toBe('force');
		expect(typeof event.reason).toBe('string');
		expect(event.reason.length).toBeGreaterThan(0);
	});

	test('reports a usage error for an unknown mode token', async () => {
		await activatePrWorkflow(directory, 'bad-mode', 'PR_REVIEW');
		const result = await handleAbortPrWorkflowCommand(
			directory,
			['PR_GRIPE', 'whining'],
			'bad-mode',
		);
		expect(result).toContain('Unknown mode "PR_GRIPE"');
		// The gate must survive a failed abort.
		expect(await readPrWorkflowGateState(directory, 'bad-mode')).not.toBeNull();
	});

	test('reports a clear error when no gate is active', async () => {
		const result = await handleAbortPrWorkflowCommand(
			directory,
			[],
			'no-active-gate',
		);
		expect(result).toContain('no active PR workflow gate');
	});

	test('requires a sessionID', async () => {
		const result = await handleAbortPrWorkflowCommand(directory, [], '   ');
		expect(result).toContain('requires an active sessionID');
	});
});
