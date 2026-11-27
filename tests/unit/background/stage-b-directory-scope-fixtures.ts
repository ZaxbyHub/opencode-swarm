/**
 * Shared fixtures for the stage-b directory-scope attribution suites.
 *
 * Split out of stage-b-directory-scope-attribution.test.ts when the
 * receipts-handoff regressions (F-001/F-002/F-003/F-005, PR 3918 review)
 * pushed the single file past the FR-006 500-line cap: both suites need the
 * same git-backed tmp workspace, parent-session registration,
 * background-coder generation seeding, and receipts options.
 */
import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
	BackgroundDelegationRecord,
	BackgroundDelegationResult,
	BackgroundWorkspaceSnapshot,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import { resolveAutoReviewConfig } from '../../../src/config/schema';
import {
	captureReviewerScopeFileFingerprint,
	reviewerScopeCaptureToFingerprint,
} from '../../../src/hooks/reviewer-scope-file-fingerprint';
import { canonicalWorkspaceIdentity } from '../../../src/scope/scope-binding';
import type { AgentSessionState } from '../../../src/state';
import {
	recordReviewerScopeGenerationFile,
	recordReviewerScopeGenerationFileFingerprint,
	resetSwarmState,
	startAgentSession,
	startReviewerScopeGeneration,
	swarmState,
} from '../../../src/state';

export const PARENT_SESSION_ID = 'parent';

/**
 * Deterministic frozen instant for the directory-scope suites
 * (scripts/check-test-clock.ts, issue #1782): suites freeze the clock at
 * this constant in beforeEach and seed every generation/record timestamp
 * relative to it, so sweeps, stamps, and interval comparisons are stable
 * across runs instead of reading the real clock.
 */
export const FROZEN_NOW = 1_758_000_000_000;

export const TERMINAL_RESULT: BackgroundDelegationResult = {
	text: 'done',
	chars: 4,
	truncated: false,
	digest: 'result-digest',
};

export interface DirectoryScopeFixture {
	directory: string;
	terminalResult: BackgroundDelegationResult;
	git: (...args: string[]) => void;
	writeFile: (file: string, content: string) => void;
	baseline: (files: string[]) => BackgroundWorkspaceSnapshot;
	parentSession: () => AgentSessionState;
	/** Start one background coder generation and route its observed writes. */
	startBackgroundCoder: (input: {
		taskId: string;
		callID: string;
		declaredFiles: string[];
		files: string[];
		createdAt: number;
	}) => void;
	/** Capture and record the post-write fingerprint for each routed file. */
	fingerprintRoutedFiles: (
		taskId: string,
		callID: string,
		files: string[],
	) => void;
	/** Capture the fingerprint at the on-disk spelling and record it rekeyed
	 * to the routed spelling (Windows case-divergent routing shapes). */
	recordFingerprintUnderSpelling: (input: {
		taskId: string;
		callID: string;
		onDiskFile: string;
		routedFile: string;
	}) => void;
	/** Receipts-enabled validation options (the handoff branch's gate). */
	receiptsOptions: () => {
		config: ReturnType<typeof resolveAutoReviewConfig>;
	};
	coderRecord: (input: {
		taskId: string;
		callID: string;
		baseline: BackgroundWorkspaceSnapshot;
		declaredFiles: string[];
	}) => BackgroundDelegationRecord;
	teardown: () => void;
}

export function createDirectoryScopeFixture(): DirectoryScopeFixture {
	const directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'stage-b-dir-scope-')),
	);
	const git = (...args: string[]): void => {
		const result = spawnSync('git', args, {
			cwd: directory,
			stdio: 'ignore',
			timeout: 5_000,
			windowsHide: true,
		});
		if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
	};
	const writeFile = (file: string, content: string): void => {
		const absolute = path.join(directory, file);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, content);
	};
	const baseline = (files: string[]): BackgroundWorkspaceSnapshot => {
		for (const file of files)
			writeFile(file, `export const ${path.basename(file, '.ts')} = 1;\n`);
		git('add', ...files);
		git('commit', '-m', 'fixture');
		return captureWorkspaceSnapshot(directory);
	};
	const parentSession = (): AgentSessionState => {
		const session = swarmState.agentSessions.get(PARENT_SESSION_ID);
		if (!session) throw new Error('parent session not registered');
		return session;
	};
	const startBackgroundCoder = (input: {
		taskId: string;
		callID: string;
		declaredFiles: string[];
		files: string[];
		createdAt: number;
	}): void => {
		expect(
			startReviewerScopeGeneration({
				parentSessionID: PARENT_SESSION_ID,
				taskId: input.taskId,
				coderCallID: input.callID,
				background: true,
				declaredFiles: input.declaredFiles,
				captureDirectory: directory,
				workspaceIdentity: canonicalWorkspaceIdentity(directory) ?? 'ws:test',
				createdAt: input.createdAt,
			}),
		).not.toBeNull();
		for (const file of input.files) {
			expect(
				recordReviewerScopeGenerationFile({
					parentSessionID: PARENT_SESSION_ID,
					taskId: input.taskId,
					coderCallID: input.callID,
					file,
				}),
			).toBe(true);
		}
	};
	const fingerprintRoutedFiles = (
		taskId: string,
		callID: string,
		files: string[],
	): void => {
		for (const file of files) {
			const captured = captureReviewerScopeFileFingerprint(directory, file);
			expect(captured?.kind).toBe('captured_file');
			expect(
				recordReviewerScopeGenerationFileFingerprint({
					parentSessionID: PARENT_SESSION_ID,
					taskId,
					coderCallID: callID,
					fingerprint: reviewerScopeCaptureToFingerprint(captured)!,
				}),
			).toBe(true);
		}
	};
	const recordFingerprintUnderSpelling = (input: {
		taskId: string;
		callID: string;
		onDiskFile: string;
		routedFile: string;
	}): void => {
		const captured = captureReviewerScopeFileFingerprint(
			directory,
			input.onDiskFile,
		);
		expect(captured?.kind).toBe('captured_file');
		expect(
			recordReviewerScopeGenerationFileFingerprint({
				parentSessionID: PARENT_SESSION_ID,
				taskId: input.taskId,
				coderCallID: input.callID,
				fingerprint: {
					...reviewerScopeCaptureToFingerprint(captured)!,
					file: input.routedFile,
				},
			}),
		).toBe(true);
	};
	const receiptsOptions = () => ({
		config: resolveAutoReviewConfig({ enabled: true }),
	});
	const coderRecord = (input: {
		taskId: string;
		callID: string;
		baseline: BackgroundWorkspaceSnapshot;
		declaredFiles: string[];
	}): BackgroundDelegationRecord => {
		// Deterministic instant (check:test-clock, issue #1782): fixed rather
		// than clock-read so record timestamps are stable in every suite,
		// frozen or not.
		const completedAt = FROZEN_NOW;
		return {
			schemaVersion: 2,
			correlationId: `child-${input.callID}`,
			jobId: `job-${input.callID}`,
			subagentSessionId: `child-${input.callID}`,
			parentSessionId: PARENT_SESSION_ID,
			callID: input.callID,
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: input.taskId,
			evidenceTaskId: input.taskId,
			status: 'completed',
			createdAt: completedAt - 60_000,
			updatedAt: completedAt,
			completedAt,
			taskChangeContext: {
				baseline: input.baseline,
				declaredFiles: input.declaredFiles,
			},
		};
	};
	const teardown = (): void => {
		resetSwarmState();
		fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
	};

	resetSwarmState();
	git('init', '-b', 'main');
	git('config', 'user.email', 'test@example.com');
	git('config', 'user.name', 'Test');
	fs.appendFileSync(
		path.join(directory, '.git', 'info', 'exclude'),
		'\n.swarm/\n',
	);
	// Register the parent so the attributed set is durably recorded per task
	// and observable through getModifiedFilesForTask (F-004).
	startAgentSession(PARENT_SESSION_ID, 'architect');

	return {
		directory,
		terminalResult: TERMINAL_RESULT,
		git,
		writeFile,
		baseline,
		parentSession,
		startBackgroundCoder,
		fingerprintRoutedFiles,
		recordFingerprintUnderSpelling,
		receiptsOptions,
		coderRecord,
		teardown,
	};
}
