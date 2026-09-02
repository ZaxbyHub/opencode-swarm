import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { councilRoundStatePaths } from '../../../src/council/council-round-state.js';
import { ensureAgentSession, swarmState } from '../../../src/state.js';
import { seedCouncilLaunch } from '../../helpers/task-workflow-evidence.js';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

function writeConfig(dir: string): void {
	mkdirSync(join(dir, '.opencode'), { recursive: true });
	writeFileSync(
		join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ council: { enabled: true } }),
	);
}

function makeFinding(severity: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH') {
	return {
		severity,
		category: 'logic',
		location: 'src/task.ts:10',
		detail: 'Needs follow-up before task completion.',
		evidence: 'regression fixture',
	};
}

function makeVerdict(
	agent: 'critic' | 'reviewer' | 'sme' | 'test_engineer' | 'explorer',
	verdict: 'APPROVE' | 'CONCERNS' | 'REJECT' = 'APPROVE',
	extra: Record<string, unknown> = {},
) {
	return {
		agent,
		verdict,
		confidence: 0.9,
		findings: verdict === 'CONCERNS' ? [makeFinding()] : [],
		criteriaAssessed: [],
		criteriaUnmet: [],
		durationMs: 25,
		...extra,
	};
}

function collectAttemptJsonlFiles(dir: string): string[] {
	const root = join(dir, '.swarm', 'council', 'attempts');
	if (!existsSync(root)) {
		return [];
	}

	const files: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			continue;
		}
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const fullPath = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(fullPath);
				continue;
			}
			if (entry.isFile() && fullPath.endsWith('.jsonl')) {
				files.push(fullPath);
			}
		}
	}

	return files.sort();
}

function finalizedForTask(dir: string, taskId: string): string[] {
	// v2 task scopes are identity-bound (the token embeds the review identity
	// digest the tool computed from plan + config), so enumerate the audit
	// files instead of recomputing the token, then filter by the scope's
	// hashed taskId.
	const scopeHash = createHash('sha256').update(taskId).digest('hex');
	return collectAttemptJsonlFiles(dir)
		.flatMap((file) =>
			readFileSync(file, 'utf8')
				.trim()
				.split('\n')
				.filter(Boolean)
				.map(
					(line) =>
						JSON.parse(line) as {
							event: string;
							disposition: string;
							scope?: { kind?: string; scopeHash?: string };
						},
				),
		)
		.filter(
			(record) =>
				record.scope?.kind === 'task' && record.scope.scopeHash === scopeHash,
		)
		.filter((record) => record.event === 'finalized')
		.map((record) => record.disposition);
}

describe('submit_council_verdicts — issue #2022 task attempt durability', () => {
	test('invalid payloads are durably recorded in the privacy-safe unscoped audit', async () => {
		const tempDir = mkdtempSync(
			join(canonicalTmpDir(), 'council-attempt-task-invalid-'),
		);
		try {
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			const invalid = JSON.parse(
				await submit_council_verdicts.execute(
					{ taskId: '../escape', secret: 'DO_NOT_PERSIST' },
					{ directory: tempDir },
				),
			);
			expect(invalid.reason).toBe('invalid arguments');
			const audit = readFileSync(
				join(tempDir, '.swarm', 'council', 'attempts', 'unscoped.jsonl'),
				'utf8',
			);
			expect(audit).toContain('invalid_arguments');
			expect(audit).not.toContain('DO_NOT_PERSIST');
			expect(audit).not.toContain('../escape');
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('records a wrong-root return in the unscoped audit before responding', async () => {
		const tempDir = mkdtempSync(
			join(canonicalTmpDir(), 'council-task-wrong-root-'),
		);
		try {
			const nested = join(tempDir, 'nested');
			mkdirSync(nested, { recursive: true });
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			const result = JSON.parse(
				await submit_council_verdicts.execute(
					{
						taskId: '1.1',
						swarmId: 'swarm-a',
						verdicts: [makeVerdict('critic')],
						working_directory: nested,
					},
					{ directory: tempDir },
				),
			);
			expect(result.success).toBe(false);
			expect(
				readFileSync(
					join(tempDir, '.swarm', 'council', 'attempts', 'unscoped.jsonl'),
					'utf8',
				),
			).toContain('invalid_working_directory');
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('blocking task submissions are durably audited before the early return', async () => {
		const tempDir = mkdtempSync(
			join(canonicalTmpDir(), 'council-attempt-task-'),
		);
		try {
			writeConfig(tempDir);
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);

			const blocked = JSON.parse(
				await submit_council_verdicts.execute(
					{
						taskId: '2.1',
						swarmId: 'swarm-a',
						roundNumber: 1,
						verdicts: [
							makeVerdict('critic'),
							makeVerdict('reviewer'),
							makeVerdict('sme', 'CONCERNS'),
						],
						working_directory: tempDir,
					},
					{ directory: tempDir },
				),
			);

			expect(blocked.success).toBe(false);
			expect(blocked.reason).toBe('blocking_concerns_unresolved');

			const attemptFiles = collectAttemptJsonlFiles(tempDir);
			expect(attemptFiles.length).toBeGreaterThan(0);
			expect(
				readFileSync(attemptFiles[0], 'utf8').trim().length,
			).toBeGreaterThan(0);
			expect(finalizedForTask(tempDir, '2.1')).toContain(
				'blocking_concerns_unresolved',
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('actual task entry point finalizes every task policy disposition', async () => {
		const tempDir = mkdtempSync(
			join(canonicalTmpDir(), 'council-task-matrix-'),
		);
		const sessionID = 'issue-2022-disposition-matrix';
		try {
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			const execute = (
				taskId: string,
				verdicts: ReturnType<typeof makeVerdict>[],
			) =>
				submit_council_verdicts.execute(
					{
						taskId,
						swarmId: 'swarm-a',
						verdicts,
						working_directory: tempDir,
					},
					{ directory: tempDir, sessionID },
				);

			await execute('3.1', [makeVerdict('critic')]);
			expect(finalizedForTask(tempDir, '3.1')).toContain('council_disabled');
			writeConfig(tempDir);
			ensureAgentSession(sessionID);
			await execute('3.2', [makeVerdict('critic')]);
			expect(finalizedForTask(tempDir, '3.2')).toContain('insufficient_quorum');
			await execute('3.2', [makeVerdict('critic')]);
			expect(finalizedForTask(tempDir, '3.2')).toContain(
				'cherry_pick_detected',
			);

			const members = ['critic', 'reviewer', 'sme'] as const;
			for (const [taskId, verdict, expected] of [
				['3.3', 'APPROVE', 'evaluated_approve'],
				['3.4', 'CONCERNS', 'evaluated_concerns'],
				['3.5', 'REJECT', 'evaluated_reject'],
			] as const) {
				const verdicts = members.map((member, index) =>
					makeVerdict(
						member,
						index === 0 ? verdict : 'APPROVE',
						verdict === 'CONCERNS' && index === 0
							? { findings: [makeFinding('LOW')] }
							: {},
					),
				);
				await seedCouncilLaunch(tempDir, taskId, sessionID);
				await execute(taskId, verdicts);
				expect(finalizedForTask(tempDir, taskId)).toContain(expected);
			}
		} finally {
			swarmState.agentSessions.delete(sessionID);
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('task submissions reject a stale client round after a prior blocked round advanced server state', async () => {
		const tempDir = mkdtempSync(
			join(canonicalTmpDir(), 'council-task-round-mismatch-'),
		);
		try {
			writeConfig(tempDir);
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);

			await submit_council_verdicts.execute(
				{
					taskId: '2.2',
					swarmId: 'swarm-a',
					roundNumber: 1,
					verdicts: [
						makeVerdict('critic'),
						makeVerdict('reviewer'),
						makeVerdict('sme', 'CONCERNS'),
					],
					working_directory: tempDir,
				},
				{ directory: tempDir },
			);

			const mismatch = JSON.parse(
				await submit_council_verdicts.execute(
					{
						taskId: '2.2',
						swarmId: 'swarm-a',
						roundNumber: 1,
						verdicts: [
							makeVerdict('critic'),
							makeVerdict('reviewer'),
							makeVerdict('sme'),
						],
						working_directory: tempDir,
					},
					{ directory: tempDir },
				),
			);

			expect(mismatch.success).toBe(false);
			expect(mismatch.reason).toBe('council_round_mismatch');
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('legacy verdictRound is stripped from parsed task verdict payloads', async () => {
		const { submit_council_verdicts } = await import(
			'../../../src/tools/convene-council'
		);
		const parsed = submit_council_verdicts.args.verdicts.element.safeParse(
			makeVerdict('critic', 'APPROVE', {
				verdictRound: 7,
			}),
		);

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			return;
		}
		expect('verdictRound' in parsed.data).toBe(false);
	});
});
