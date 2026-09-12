import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	closeAllProjectDbs,
	getProjectDb,
} from '../../../src/db/project-db.js';
import {
	_test_exports,
	activatePrWorkflow,
	MAX_SALVAGED_SCHEMA_ERROR_CHARS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	prWorkflowSessionFileStem,
	workflowGateStateRelativePath,
} from '../../../src/pr-review/persistence.js';
import { abort_pr_workflow } from '../../../src/tools/index.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

type RegisteredAbortTool = {
	execute(
		args: unknown,
		context: { directory: string; sessionID: string },
	): Promise<unknown>;
};

type AbortResponse = {
	success: boolean;
	mode?: string;
	gate_cleared?: boolean;
	state_salvaged?: boolean;
	state_salvage_disclosure?: string;
	message?: string;
};

const registeredAbort = abort_pr_workflow as unknown as RegisteredAbortTool;
const SESSION_ID = 'coordination-authority-corrupt';
const FOREIGN_SESSION_ID = 'coordination-foreign-active';
const originalTestExports = { ..._test_exports };
let directory = '';

function responseText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (
		typeof value === 'object' &&
		value !== null &&
		'output' in value &&
		typeof value.output === 'string'
	) {
		return value.output;
	}
	throw new Error('registered abort tool returned an unexpected result');
}

beforeEach(() => {
	directory = canonicalMkdtemp('abort-coordination-corrupt-');
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => 'abc123';
	_test_exports.resolveIsWorkingTreeClean = () => true;
	// Keep this acceptance test independent of any host session state leaked by
	// another test file. The workflow has no delegation lanes to settle.
	_test_exports.getSessionOps = () => null;
});

afterEach(async () => {
	Object.assign(_test_exports, originalTestExports);
	_test_exports.resetTrackedStateCache();
	closeAllProjectDbs();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('registered abort salvages corrupt coordination authority (issue #2602)', () => {
	test('malformed authority falls back to valid shadow, clears both, and discloses bounded salvage', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		await activatePrWorkflow(directory, FOREIGN_SESSION_ID, 'PR_FEEDBACK');

		const shadowPath = path.join(
			directory,
			'.swarm',
			workflowGateStateRelativePath(SESSION_ID),
		);
		const shadow = JSON.parse(await fs.readFile(shadowPath, 'utf8')) as {
			sessionID?: string;
			mode?: string;
		};
		expect(shadow).toMatchObject({
			sessionID: SESSION_ID,
			mode: 'PR_REVIEW',
		});
		const foreignShadowPath = path.join(
			directory,
			'.swarm',
			workflowGateStateRelativePath(FOREIGN_SESSION_ID),
		);

		const namespace = `pr-workflow.state:${prWorkflowSessionFileStem(SESSION_ID)}`;
		const foreignNamespace = `pr-workflow.state:${prWorkflowSessionFileStem(FOREIGN_SESSION_ID)}`;
		const db = getProjectDb(directory);
		const rowBefore = db
			.query<{ payload: string }, [string, string]>(
				'SELECT payload FROM coordination_state WHERE namespace = ? AND entity_key = ?',
			)
			.get(namespace, 'state');
		expect(rowBefore?.payload).toBeTruthy();
		const foreignRowBefore = db
			.query<{ payload: string }, [string, string]>(
				'SELECT payload FROM coordination_state WHERE namespace = ? AND entity_key = ?',
			)
			.get(foreignNamespace, 'state');
		expect(foreignRowBefore?.payload).toBeTruthy();
		db.run(
			'UPDATE coordination_state SET payload = ? WHERE namespace = ? AND entity_key = ?',
			['{ malformed coordination payload', namespace, 'state'],
		);

		const result = JSON.parse(
			responseText(
				await registeredAbort.execute(
					{
						mode: 'PR_REVIEW',
						kind: 'recovery',
						reason: 'recover gate after coordination payload corruption',
					},
					{ directory, sessionID: SESSION_ID },
				),
			),
		) as AbortResponse;

		expect(result).toMatchObject({
			success: true,
			mode: 'PR_REVIEW',
			gate_cleared: true,
			state_salvaged: true,
		});
		expect(result.message).toBeUndefined();
		expect(result.state_salvage_disclosure).toContain('SALVAGED');
		expect(result.state_salvage_disclosure?.length ?? 0).toBeLessThan(
			MAX_SALVAGED_SCHEMA_ERROR_CHARS * 12,
		);

		// The registered tool may close its project handle during host cleanup;
		// reacquire the directory-scoped handle before inspecting post-abort state.
		const dbAfter = getProjectDb(directory);
		const rowAfter = dbAfter
			.query<{ payload: string }, [string, string]>(
				'SELECT payload FROM coordination_state WHERE namespace = ? AND entity_key = ?',
			)
			.get(namespace, 'state');
		expect(rowAfter).toBeNull();
		await expect(fs.stat(shadowPath)).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(
			readPrWorkflowGateState(directory, SESSION_ID),
		).resolves.toBeNull();
		const foreignRowAfter = dbAfter
			.query<{ payload: string }, [string, string]>(
				'SELECT payload FROM coordination_state WHERE namespace = ? AND entity_key = ?',
			)
			.get(foreignNamespace, 'state');
		expect(foreignRowAfter?.payload).toBe(foreignRowBefore?.payload);
		await expect(fs.stat(foreignShadowPath)).resolves.toBeDefined();
		await expect(
			readPrWorkflowGateState(directory, FOREIGN_SESSION_ID),
		).resolves.toMatchObject({
			sessionID: FOREIGN_SESSION_ID,
			mode: 'PR_FEEDBACK',
		});

		const events = (
			await fs.readFile(path.join(directory, '.swarm', 'events.jsonl'), 'utf8')
		)
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const abortEvent = events.find(
			(event) => event.type === 'pr_workflow_aborted',
		) as Record<string, unknown> | undefined;
		expect(abortEvent).toMatchObject({
			type: 'pr_workflow_aborted',
			stateSalvaged: true,
		});
		expect(String(abortEvent?.stateSalvageDisclosure)).toContain('SALVAGED');
		expect(String(abortEvent?.stateSalvageDisclosure).length).toBeLessThan(
			MAX_SALVAGED_SCHEMA_ERROR_CHARS * 12,
		);
	});

	test('does not shadow-salvage when the coordination database cannot open', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		const shadowPath = path.join(
			directory,
			'.swarm',
			workflowGateStateRelativePath(SESSION_ID),
		);
		const dbPath = path.join(directory, '.swarm', 'swarm.db');
		closeAllProjectDbs();
		await fs.rm(`${dbPath}-wal`, { force: true });
		await fs.rm(`${dbPath}-shm`, { force: true });
		await fs.writeFile(dbPath, 'not a sqlite database', 'utf8');

		const result = JSON.parse(
			responseText(
				await registeredAbort.execute(
					{
						mode: 'PR_REVIEW',
						kind: 'recovery',
						reason: 'do not hide coordination database outage',
					},
					{ directory, sessionID: SESSION_ID },
				),
			),
		) as AbortResponse;

		expect(result.success).toBe(false);
		expect(result.state_salvaged).not.toBe(true);
		expect(result.message).not.toMatch(/SALVAGED|schema validation/i);
		await expect(fs.stat(shadowPath)).resolves.toBeDefined();
	});

	test('does not shadow-salvage when the coordination query is unavailable', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		const shadowPath = path.join(
			directory,
			'.swarm',
			workflowGateStateRelativePath(SESSION_ID),
		);
		getProjectDb(directory).run('DROP TABLE coordination_state');

		const result = JSON.parse(
			responseText(
				await registeredAbort.execute(
					{
						mode: 'PR_REVIEW',
						kind: 'recovery',
						reason: 'do not hide coordination query outage',
					},
					{ directory, sessionID: SESSION_ID },
				),
			),
		) as AbortResponse;

		expect(result.success).toBe(false);
		expect(result.state_salvaged).not.toBe(true);
		expect(result.message).not.toMatch(/SALVAGED|schema validation/i);
		await expect(fs.stat(shadowPath)).resolves.toBeDefined();
	});
});
