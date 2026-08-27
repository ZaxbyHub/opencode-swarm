import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function config(overrides: Partial<GuardrailsConfig> = {}): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		shell_audit_log: true,
		profiles: undefined,
		block_destructive_commands: true,
		...overrides,
	};
}

async function waitForAudit(filePath: string, attempts = 100): Promise<void> {
	// Use bounded retries instead of a wall-clock deadline so this helper stays
	// compatible with the repo's clock-lint gate.
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8').trim())
			return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe('destructive shell audit categories', () => {
	let tempDir = '';

	beforeEach(() => {
		resetSwarmState();
		tempDir = canonicalMkdtemp('guardrails-destructive-audit-');
		startAgentSession('dd-session', 'coder', tempDir);
	});

	afterEach(() => {
		resetSwarmState();
		if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('dd catastrophic blocks surface a dd-specific reason and data-wipe audit category', async () => {
		const hooks = createGuardrailsHooks(tempDir, undefined, config());
		const command = 'dd if=/dev/zero of=/dev/sda bs=1M count=1';

		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'dd-session', callID: 'dd-call' },
				{ args: { command } },
			),
		).rejects.toThrow(/"dd".*data-wipe parameters/i);

		const auditPath = path.join(
			tempDir,
			'.swarm',
			'session',
			'shell-audit.jsonl',
		);
		await waitForAudit(auditPath);
		const entries = fs
			.readFileSync(auditPath, 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const entry = entries.find(
			(candidate) => candidate.type === 'destructive_block',
		);
		expect(entry).toBeDefined();
		expect(entry?.destructiveCategory).toBe('data wipe');
	});

	test('FB-004: find -delete blocks in the live hook and records a structured audit category', async () => {
		const hooks = createGuardrailsHooks(tempDir, undefined, config());
		const command = 'find . -delete';

		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'dd-session', callID: 'find-delete-call' },
				{ args: { command } },
			),
		).rejects.toThrow(/"find -delete" detected/i);

		const auditPath = path.join(
			tempDir,
			'.swarm',
			'session',
			'shell-audit.jsonl',
		);
		await waitForAudit(auditPath);
		const entries = fs
			.readFileSync(auditPath, 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const entry = entries.find(
			(candidate) =>
				candidate.type === 'destructive_block' && candidate.command === command,
		);
		expect(entry).toBeDefined();
		expect(entry?.destructiveCategory).toBe('find delete');
	});
});
