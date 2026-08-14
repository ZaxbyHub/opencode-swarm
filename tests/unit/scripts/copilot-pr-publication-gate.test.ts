/**
 * Automated adversarial tests for scripts/copilot-pr-publication-gate.sh
 * (issue #2131 criterion D): the gate's rejection paths — stale HEAD, edited
 * body, wrong state, missing validation commands — must be proven by tests,
 * not claimed. Uses the precedented spawnSync('bash') + canonical temp-dir pattern
 * (see check-invariants.test.ts / check-mock-allowlist-ratchet.test.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const GATE_SCRIPT = path.join(
	import.meta.dir,
	'..',
	'..',
	'..',
	'scripts',
	'copilot-pr-publication-gate.sh',
);

const PUBLISH_PAYLOAD = JSON.stringify({
	tool: 'shell',
	command: 'gh pr create --title t --body-file b',
});

let directory = '';

beforeEach(() => {
	directory = canonicalMkdtemp('pub-gate-test-');
});

afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
	const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
	if (result.status !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed: ${result.stderr ?? result.stdout}`,
		);
	}
}

interface EvidenceOptions {
	headSha?: string;
	bodySha256?: string;
	state?: string;
	validationCommands?: boolean;
	repository?: string;
}

async function writeValidBaselinePrBody(): Promise<void> {
	await fs.mkdir(path.join(directory, '.swarm', 'evidence'), {
		recursive: true,
	});
	await fs.writeFile(
		path.join(directory, '.swarm', 'evidence', 'pr_body.md'),
		[
			'# T',
			'',
			'## Summary',
			's',
			'',
			'## Invariant audit',
			'i',
			'',
			'## Test plan',
			't',
			'',
		].join('\n'),
		'utf-8',
	);
	await fs.writeFile(
		path.join(directory, '.swarm', 'evidence', 'commit-pr-validation.md'),
		'ran the suite',
		'utf-8',
	);
}

async function writeEvidence(options: EvidenceOptions = {}): Promise<string> {
	const head = options.headSha ?? '0'.repeat(40);
	// Compute the sha exactly as the gate does (relative path from the repo
	// root) — sha256sum on an absolute Windows path emits a leading '\'
	// escape marker that would corrupt the recorded hash.
	const bodySha =
		options.bodySha256 ??
		spawnSync('sha256sum', ['.swarm/evidence/pr_body.md'], {
			cwd: directory,
			encoding: 'utf-8',
		})
			.stdout.trim()
			.split(/\s+/)[0];
	const receipt = {
		schema_version: 1,
		state: options.state ?? 'validated',
		repository: options.repository ?? 'https://github.com/example/repo.git',
		head_sha: head,
		body_sha256: bodySha,
		...(options.validationCommands === false
			? {}
			: { validation_commands: ['bun run typecheck'] }),
		recorded_at: '2026-01-01T00:00:00Z',
	};
	await fs.writeFile(
		path.join(directory, '.swarm', 'evidence', 'publication-evidence.json'),
		JSON.stringify(receipt),
		'utf-8',
	);
	return bodySha as string;
}

function runGate(payload: string): { status: number; output: string } {
	const result = spawnSync('bash', [GATE_SCRIPT], {
		cwd: directory,
		input: payload,
		encoding: 'utf-8',
		env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
	});
	return {
		status: result.status ?? -1,
		output: `${result.stdout}${result.stderr}`,
	};
}

describe('copilot-pr-publication-gate (issue #2131 criterion D)', () => {
	test('non-publish payloads pass through ungated', async () => {
		await writeValidBaselinePrBody();
		await writeEvidence();
		const { status } = runGate(
			JSON.stringify({ command: 'bun test tests/unit/foo.test.ts' }),
		);
		expect(status).toBe(0);
	});

	test('missing publication-evidence.json blocks publish', async () => {
		await writeValidBaselinePrBody();
		const { status, output } = runGate(PUBLISH_PAYLOAD);
		expect(status).toBe(1);
		expect(output).toContain(
			'missing .swarm/evidence/publication-evidence.json',
		);
	});

	test('matching evidence passes (git repo with matching HEAD and origin)', async () => {
		await writeValidBaselinePrBody();
		git(directory, ['init', '-q']);
		git(directory, [
			'remote',
			'add',
			'origin',
			'https://github.com/example/repo.git',
		]);
		git(directory, [
			'-c', 'user.name=test',
			'-c', 'user.email=test@test.com',
			'-c', 'commit.gpgsign=false',
			'commit', '-q', '--allow-empty', '-m', 'init',
		]);
		const head = spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], {
			encoding: 'utf-8',
		}).stdout.trim();
		await writeEvidence({ headSha: head });
		const { status, output } = runGate(PUBLISH_PAYLOAD);
		expect(output).toBe('');
		expect(status).toBe(0);
	});

	test('stale head_sha is rejected', async () => {
		await writeValidBaselinePrBody();
		git(directory, ['init', '-q']);
		git(directory, [
			'remote',
			'add',
			'origin',
			'https://github.com/example/repo.git',
		]);
		await writeEvidence({ headSha: 'f'.repeat(40) });
		const { status, output } = runGate(PUBLISH_PAYLOAD);
		expect(status).toBe(1);
		expect(output).toContain('does not match current HEAD');
	});

	test('body edited after the receipt is rejected (sha256 mismatch)', async () => {
		await writeValidBaselinePrBody();
		git(directory, ['init', '-q']);
		git(directory, [
			'remote',
			'add',
			'origin',
			'https://github.com/example/repo.git',
		]);
		await writeEvidence({ headSha: '0'.repeat(40) });
		// Tamper with the body AFTER the receipt was written.
		await fs.appendFile(
			path.join(directory, '.swarm', 'evidence', 'pr_body.md'),
			'\nlate edit\n',
			'utf-8',
		);
		const { status, output } = runGate(PUBLISH_PAYLOAD);
		expect(status).toBe(1);
		expect(output).toContain('body_sha256 does not match');
	});

	test('empty/missing body_sha256 in the receipt is rejected (fail-closed)', async () => {
		await writeValidBaselinePrBody();
		git(directory, ['init', '-q']);
		git(directory, [
			'remote',
			'add',
			'origin',
			'https://github.com/example/repo.git',
		]);
		await writeEvidence({ headSha: '0'.repeat(40), bodySha256: '' });
		const { status, output } = runGate(PUBLISH_PAYLOAD);
		expect(status).toBe(1);
		expect(output).toContain('body_sha256 could not be verified');
	});

	test("state other than 'validated' is rejected", async () => {
		await writeValidBaselinePrBody();
		git(directory, ['init', '-q']);
		git(directory, [
			'remote',
			'add',
			'origin',
			'https://github.com/example/repo.git',
		]);
		await writeEvidence({ state: 'draft' });
		const { status, output } = runGate(PUBLISH_PAYLOAD);
		expect(status).toBe(1);
		expect(output).toContain("state is not 'validated'");
	});

	test('missing validation_commands is rejected', async () => {
		await writeValidBaselinePrBody();
		git(directory, ['init', '-q']);
		git(directory, [
			'remote',
			'add',
			'origin',
			'https://github.com/example/repo.git',
		]);
		await writeEvidence({ validationCommands: false });
		const { status, output } = runGate(PUBLISH_PAYLOAD);
		expect(status).toBe(1);
		expect(output).toContain('missing validation_commands');
	});

	test('a receipt bound to a different repository is rejected', async () => {
		await writeValidBaselinePrBody();
		git(directory, ['init', '-q']);
		git(directory, [
			'remote',
			'add',
			'origin',
			'https://github.com/example/repo.git',
		]);
		await writeEvidence({
			repository: 'https://github.com/other/repo.git',
		});
		const { status, output } = runGate(PUBLISH_PAYLOAD);
		expect(status).toBe(1);
		expect(output).toContain('does not match this origin');
	});
});
