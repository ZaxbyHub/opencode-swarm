import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
	normalizePrWorkflowShellCommand,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

// Lane 1 / C1+C2+C9: the read-only shell classifier tolerates provably
// read-only-neutral wrappers (a leading `cd <dir> &&` and a trailing `2>&1`)
// without weakening fail-closed — state transitions hidden behind those
// wrappers stay blocked, and blocked reads carry an actionable diagnosis.

describe('normalizePrWorkflowShellCommand', () => {
	test('strips a leading cd prefix and reports it', () => {
		expect(normalizePrWorkflowShellCommand('cd /repo && git status')).toEqual({
			normalized: 'git status',
			strippedCdPrefix: true,
		});
	});

	test('strips a trailing 2>&1 without flagging a cd prefix', () => {
		expect(normalizePrWorkflowShellCommand('git log 2>&1')).toEqual({
			normalized: 'git log',
			strippedCdPrefix: false,
		});
	});

	test('strips a quoted Windows cd target together with the stderr merge', () => {
		expect(
			normalizePrWorkflowShellCommand('cd "E:\\OpenCode\\x" && git log 2>&1'),
		).toEqual({ normalized: 'git log', strippedCdPrefix: true });
	});

	test('strips several chained cd prefixes up to the bound', () => {
		expect(normalizePrWorkflowShellCommand('cd a && cd b && git push')).toEqual(
			{
				normalized: 'git push',
				strippedCdPrefix: true,
			},
		);
	});

	test('leaves a metacharacter-bearing cd target unstripped (grammar rejects $)', () => {
		// The conservative path charset never matches `$(`, so the wrapper is not
		// recognized and the whole command survives for the compound reject.
		expect(
			normalizePrWorkflowShellCommand('cd "$(evil)" && git status'),
		).toEqual({
			normalized: 'cd "$(evil)" && git status',
			strippedCdPrefix: false,
		});
	});

	test('returns a bare command unchanged', () => {
		expect(normalizePrWorkflowShellCommand('git status')).toEqual({
			normalized: 'git status',
			strippedCdPrefix: false,
		});
	});
});

describe('PR_REVIEW shell wrapper tolerance', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	async function reviewOutcome(command: string): Promise<string> {
		return enforcePrWorkflowToolBefore(tempDir, SESSION_ID, 'shell', {
			command,
		}).then(
			() => 'ALLOWED',
			(error) => (error instanceof Error ? error.message : String(error)),
		);
	}

	test('tolerates cd-prefix / 2>&1 on allowlisted reads and new read verbs', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		for (const command of [
			'cd /repo && git status',
			'cd "E:\\OpenCode\\x" && git log 2>&1',
			'git status --short 2>&1',
			'git branch -a',
			'git branch --contains HEAD',
			'which gh',
			'where git',
			'git --version',
			'git version',
			'gh --version',
		]) {
			expect(await reviewOutcome(command)).toBe('ALLOWED');
		}
	});

	test('keeps the canonical detached checkout canonical with a trailing 2>&1', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		expect(
			await reviewOutcome(`git switch --detach ${'a'.repeat(40)} 2>&1`),
		).toBe('ALLOWED');
	});

	test('blocks state transitions hidden behind a cd prefix or compound syntax', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		// These reach the read-only fail-closed throw (no checkout verb present),
		// so the locked substring is preserved alongside the appended diagnosis.
		for (const command of [
			'cd x && git fetch origin y',
			'cd a && cd b && git push',
			'cd "$(evil)" && git status',
			'git status; rm -rf /',
			'git branch -D x',
			'git branch newbranch',
		]) {
			const message = await reviewOutcome(command);
			expect(message).toContain('BLOCKED');
			expect(message).toContain('PR_REVIEW is read-only');
			expect(message).toContain('fail-closed');
		}
	});

	// PRR-009: the compound-syntax reject charset (`/[\r\n;&|<>` + backtick +
	// `]/`) covers pipe and redirect metacharacters too, not just `;`/`&&` — but
	// the pre-existing regression coverage above only exercised `;`. Lock in
	// that `|`, `>`, and `<` are still BLOCKED, both bare and behind the
	// cd-prefix-stripping wrapper this PR introduced (the stripped prefix must
	// not smuggle a pipe/redirect past the reject, since it runs against the
	// post-strip remainder).
	test('blocks pipe and redirect metacharacters, alone and behind a cd prefix', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		for (const command of [
			'git status | grep foo',
			'cd /repo && git status | grep foo',
			'git log > out.txt',
			'cd /repo && git log > out.txt',
			'git log < input.txt',
			'cd /repo && git log < input.txt',
		]) {
			const message = await reviewOutcome(command);
			expect(message).toContain('BLOCKED');
			expect(message).toContain('PR_REVIEW is read-only');
			expect(message).toContain('fail-closed');
			expect(message).toContain('Reason: compound-syntax');
		}
	});

	test('blocks a cd-wrapped `gh pr checkout` with a wrapper-aware diagnosis', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		// `gh pr checkout` trips the raw checkout backstop, so this lands on the
		// checkout throw rather than the read-only throw — still fail-closed.
		const message = await reviewOutcome('cd x && gh pr checkout 5');
		expect(message).toContain('BLOCKED');
		expect(message).toContain('cd-prefix-on-checkout-verb');
	});

	test('appends a bounded, actionable diagnosis to the read-only throw', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		const message = await reviewOutcome('cd x && git fetch origin feature');
		expect(message).toContain('PR_REVIEW is read-only');
		expect(message).toContain('fail-closed');
		expect(message).toContain('Reason: cd-prefix-on-checkout-verb');
		expect(message).toContain('pr_workflow_status');
		// The appended diagnosis stays bounded (< ~600 chars).
		const diagnosisStart = message.indexOf(' Reason:');
		expect(diagnosisStart).toBeGreaterThan(-1);
		expect(message.length - diagnosisStart).toBeLessThan(600);
	});

	test('names compound-syntax as the reason for chained commands', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		const message = await reviewOutcome('git status; rm -rf /');
		expect(message).toContain('PR_REVIEW is read-only');
		expect(message).toContain('Reason: compound-syntax');
	});

	test('names the unlisted binary reason for an unknown command', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		const message = await reviewOutcome('node scripts/fix.js');
		expect(message).toContain('PR_REVIEW is read-only');
		expect(message).toContain('Reason: unlisted binary');
	});
});
