import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	_internals as coordinationInternals,
	listCoordinationStates,
} from '../../../src/db/coordination-store.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	_test_exports,
	activatePrWorkflow,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	issuePrReviewReentryAuthorization,
	_internals as reentryInternals,
	reservePrReviewReentryAuthorizationAgainstBinding,
} from '../../../src/pr-review/authorization.js';
import { readPrWorkflowGateStateFromDisk } from '../../../src/pr-review/persistence.js';
import { bunSpawn } from '../../../src/utils/bun-compat.js';
import { withTimeout } from '../../../src/utils/timeout.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;

let directory = '';

function waitForFile(filePath: string, timeoutMs = 5_000): void {
	const gate = new Int32Array(new SharedArrayBuffer(4));
	const deadline = performance.now() + timeoutMs;
	while (!fs.existsSync(filePath)) {
		if (performance.now() > deadline) {
			throw new Error(`Timed out waiting for ${filePath}`);
		}
		Atomics.wait(gate, 0, 0, 10);
	}
}

async function establishActiveReview(): Promise<void> {
	await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
		prHeadSha: PR_ARTIFACT_HEAD_SHA,
	});
}

function emptyLegacyAuthorizationStore(
	sessionID = PR_ARTIFACT_SESSION_ID,
): string {
	return `${JSON.stringify(
		{
			schemaVersion: 1,
			sessionId: sessionID,
			authorizations: [],
		},
		null,
		2,
	)}\n`;
}

beforeEach(() => {
	directory = canonicalMkdtemp('pr-reentry-auth-sqlite-');
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHeadAsync = async () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () =>
		PR_ARTIFACT_REVISION_DIGEST;
});

afterEach(async () => {
	coordinationInternals.coordinationFaultInjector = undefined;
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	closeAllProjectDbs();
	await fsp.rm(directory, { recursive: true, force: true });
});

describe('pr-review reentry authorization SQLite authority (#2481)', () => {
	test('legacy import archives original bytes and refreshes the projection non-destructively', async () => {
		await establishActiveReview();
		const legacyPath = reentryInternals.reentryAuthorizationFilePath(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		const legacyRaw = emptyLegacyAuthorizationStore();
		await fsp.mkdir(path.dirname(legacyPath), { recursive: true });
		await fsp.writeFile(legacyPath, legacyRaw, 'utf8');

		const issued = await issuePrReviewReentryAuthorization(
			directory,
			PR_ARTIFACT_SESSION_ID,
			{ prHeadSha: PR_ARTIFACT_HEAD_SHA, role: 'reviewer' },
		);

		expect(await fsp.readFile(`${legacyPath}.imported`, 'utf8')).toBe(
			legacyRaw,
		);
		const projected = JSON.parse(await fsp.readFile(legacyPath, 'utf8')) as {
			authorizations: Array<{ authorizationId: string }>;
		};
		expect(projected.authorizations).toHaveLength(1);
		expect(projected.authorizations[0]?.authorizationId).toBe(
			issued.authorizationId,
		);
		expect(
			listCoordinationStates(
				directory,
				reentryInternals.reentryAuthorizationCoordinationNamespace(
					PR_ARTIFACT_SESSION_ID,
				),
			),
		).toHaveLength(1);
	});

	test('corrupt legacy authority fails closed without archival or SQLite import', async () => {
		await establishActiveReview();
		const legacyPath = reentryInternals.reentryAuthorizationFilePath(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		await fsp.mkdir(path.dirname(legacyPath), { recursive: true });
		await fsp.writeFile(legacyPath, '{ corrupt', 'utf8');

		await expect(
			issuePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				role: 'reviewer',
			}),
		).rejects.toThrow(/json parse error|not valid JSON|invalid/i);

		expect(fs.existsSync(`${legacyPath}.imported`)).toBe(false);
		expect(
			listCoordinationStates(
				directory,
				reentryInternals.reentryAuthorizationCoordinationNamespace(
					PR_ARTIFACT_SESSION_ID,
				),
			),
		).toHaveLength(0);
	});

	test('import crash after commit is repaired on replay without duplicating the row', async () => {
		await establishActiveReview();
		const legacyPath = reentryInternals.reentryAuthorizationFilePath(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		const legacyRaw = emptyLegacyAuthorizationStore();
		await fsp.mkdir(path.dirname(legacyPath), { recursive: true });
		await fsp.writeFile(legacyPath, legacyRaw, 'utf8');
		let injected = false;
		coordinationInternals.coordinationFaultInjector = (point) => {
			if (!injected && point === 'after_commit_before_archive') {
				injected = true;
				throw new Error('simulated archive crash');
			}
		};

		await expect(
			issuePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				role: 'reviewer',
			}),
		).rejects.toThrow(/archive crash/i);

		coordinationInternals.coordinationFaultInjector = undefined;
		const issued = await issuePrReviewReentryAuthorization(
			directory,
			PR_ARTIFACT_SESSION_ID,
			{ prHeadSha: PR_ARTIFACT_HEAD_SHA, role: 'reviewer' },
		);
		expect(await fsp.readFile(`${legacyPath}.imported`, 'utf8')).toBe(
			legacyRaw,
		);
		const projected = JSON.parse(await fsp.readFile(legacyPath, 'utf8')) as {
			authorizations: Array<{ authorizationId: string }>;
		};
		expect(projected.authorizations).toHaveLength(1);
		expect(projected.authorizations[0]?.authorizationId).toBe(
			issued.authorizationId,
		);
		expect(
			listCoordinationStates(
				directory,
				reentryInternals.reentryAuthorizationCoordinationNamespace(
					PR_ARTIFACT_SESSION_ID,
				),
			),
		).toHaveLength(1);
	});

	test('reappeared legacy source preserves the canonical archive and is re-archived collision-safely', async () => {
		await establishActiveReview();
		const legacyPath = reentryInternals.reentryAuthorizationFilePath(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		const firstLegacyRaw = emptyLegacyAuthorizationStore();
		await fsp.mkdir(path.dirname(legacyPath), { recursive: true });
		await fsp.writeFile(legacyPath, firstLegacyRaw, 'utf8');
		await issuePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			role: 'reviewer',
		});

		const reappearedLegacyRaw = `${JSON.stringify(
			{
				schemaVersion: 1,
				sessionId: PR_ARTIFACT_SESSION_ID,
				authorizations: [
					{
						schemaVersion: 1,
						authorizationId: 'legacy-reappeared',
						sessionId: PR_ARTIFACT_SESSION_ID,
						prHeadSha: PR_ARTIFACT_HEAD_SHA,
						revisionDigest: PR_ARTIFACT_REVISION_DIGEST,
						role: 'reviewer',
						generation: 1,
						createdAt: '2026-01-01T00:00:00.000Z',
						expiresAt: '2026-01-01T00:10:00.000Z',
					},
				],
			},
			null,
			2,
		)}\n`;
		await fsp.writeFile(legacyPath, reappearedLegacyRaw, 'utf8');
		await issuePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			role: 'test_engineer',
		});

		expect(await fsp.readFile(`${legacyPath}.imported`, 'utf8')).toBe(
			firstLegacyRaw,
		);
		expect(await fsp.readFile(`${legacyPath}.imported.1`, 'utf8')).toBe(
			reappearedLegacyRaw,
		);
	});

	test(
		'real two-process duplicate consume converges on exactly one winner',
		{ timeout: 30_000 },
		async () => {
			await establishActiveReview();
			await issuePrReviewReentryAuthorization(
				directory,
				PR_ARTIFACT_SESSION_ID,
				{ prHeadSha: PR_ARTIFACT_HEAD_SHA, role: 'reviewer' },
			);
			const workflowState = await readPrWorkflowGateStateFromDisk(
				directory,
				PR_ARTIFACT_SESSION_ID,
			);
			if (!workflowState?.workflowInstanceId) {
				throw new Error('expected workflow instance id');
			}
			const binding = {
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				revisionDigest: PR_ARTIFACT_REVISION_DIGEST,
				generation: workflowState.revision,
				workflowInstanceId: workflowState.workflowInstanceId,
			};
			const repoRoot = path.resolve(import.meta.dir, '..', '..', '..');
			const authUrl = pathToFileURL(
				path.join(repoRoot, 'src', 'pr-review', 'authorization.ts'),
			).href;
			const projectDbUrl = pathToFileURL(
				path.join(repoRoot, 'src', 'db', 'project-db.ts'),
			).href;
			const readyPath = path.join(directory, 'child.ready');
			const goPath = path.join(directory, 'child.go');
			const workerPath = path.join(directory, 'consume-worker.ts');
			fs.writeFileSync(
				workerPath,
				`import { existsSync, writeFileSync } from 'node:fs';
import { closeAllProjectDbs } from ${JSON.stringify(projectDbUrl)};
import { reservePrReviewReentryAuthorizationAgainstBinding } from ${JSON.stringify(authUrl)};
const [directory, sessionID, readyPath, goPath, callID, bindingJson] = process.argv.slice(2);
writeFileSync(readyPath, 'ready');
const gate = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goPath)) Atomics.wait(gate, 0, 0, 10);
const binding = JSON.parse(bindingJson);
const result = await reservePrReviewReentryAuthorizationAgainstBinding(directory, sessionID, { role: 'reviewer', callID }, binding);
process.stdout.write(JSON.stringify(result));
closeAllProjectDbs();
`,
				'utf8',
			);

			const child = bunSpawn(
				[
					process.execPath,
					workerPath,
					directory,
					PR_ARTIFACT_SESSION_ID,
					readyPath,
					goPath,
					'child-call',
					JSON.stringify(binding),
				],
				{
					cwd: repoRoot,
					stdin: 'ignore',
					stdout: 'pipe',
					stderr: 'pipe',
					timeout: 15_000,
					killProcessTree: true,
				},
			);

			try {
				waitForFile(readyPath);
				fs.writeFileSync(goPath, 'go', 'utf8');
				const parent = await reservePrReviewReentryAuthorizationAgainstBinding(
					directory,
					PR_ARTIFACT_SESSION_ID,
					{ role: 'reviewer', callID: 'parent-call' },
					binding,
				);
				const childResult = await withTimeout(
					Promise.all([child.exited, child.stdout.text(), child.stderr.text()]),
					20_000,
					new Error('Timed out waiting for authorization child'),
				);
				expect(childResult[0], childResult[2]).toBe(0);
				const childReservation = JSON.parse(childResult[1]) as {
					consumedCallId?: string;
					authorizationId?: string;
				} | null;
				const winners = [parent, childReservation].filter(
					(result) => result !== null,
				);
				expect(winners).toHaveLength(1);
				expect(winners[0]?.consumedCallId).toMatch(/parent-call|child-call/);
				const projected = JSON.parse(
					await fsp.readFile(
						reentryInternals.reentryAuthorizationFilePath(
							directory,
							PR_ARTIFACT_SESSION_ID,
						),
						'utf8',
					),
				) as {
					authorizations: Array<{ consumedCallId?: string }>;
				};
				expect(projected.authorizations[0]?.consumedCallId).toBe(
					winners[0]?.consumedCallId,
				);
			} finally {
				child.kill();
			}
		},
	);
});
