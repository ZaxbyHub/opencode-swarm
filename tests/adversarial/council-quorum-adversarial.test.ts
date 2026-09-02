import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startAgentSession } from '../../src/state';
import { createSafeTestDir } from '../helpers/safe-test-dir';

const writeConfig = (dir: string): void => {
	mkdirSync(join(dir, '.opencode'), { recursive: true });
	writeFileSync(
		join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ council: { enabled: true } }),
	);
};

const verdict = (
	agent: 'critic' | 'reviewer' | 'sme' | 'test_engineer' | 'explorer',
) => ({
	agent,
	verdict: 'APPROVE' as const,
	confidence: 1,
	findings: [],
	criteriaAssessed: [],
	criteriaUnmet: [],
	durationMs: 10,
});

describe('submit_council_verdicts adversarial quorum checks', () => {
	test('fails cherry-pick retry that omits previously-required absentees', async () => {
		// createSafeTestDir canonicalizes the path (realpath) and its cleanup
		// retries EBUSY/EPERM/ENOTEMPTY with bounded backoff — the raw
		// mkdtempSync + one-shot rmSync previously raced Windows AV-held
		// handles and flaked attempt 1 on cold windows-latest merge-group
		// runners (issue #2017/#2477).
		const { dir: tempDir, cleanup } = createSafeTestDir(
			'adversarial-council-cherry-',
		);
		const sessionID = `adversarial-${Date.now()}`;
		try {
			writeConfig(tempDir);
			startAgentSession(sessionID, 'architect', undefined, tempDir);
			const { submit_council_verdicts } = await import(
				'../../src/tools/convene-council'
			);
			await submit_council_verdicts.execute(
				{
					taskId: '9.1',
					swarmId: 'swarm-1',
					roundNumber: 1,
					verdicts: [verdict('critic'), verdict('reviewer')],
					working_directory: tempDir,
				},
				{ directory: tempDir, sessionID },
			);

			const retry = await submit_council_verdicts.execute(
				{
					taskId: '9.1',
					swarmId: 'swarm-1',
					roundNumber: 1,
					verdicts: [verdict('critic'), verdict('reviewer'), verdict('sme')],
					working_directory: tempDir,
				},
				{ directory: tempDir, sessionID },
			);
			const parsed = JSON.parse(retry);
			expect(parsed.reason).toBe('cherry_pick_detected');
			expect(parsed.stillMissingMembers).toEqual(['test_engineer', 'explorer']);
		} finally {
			cleanup();
		}
	});
});
