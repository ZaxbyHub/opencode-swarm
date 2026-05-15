/**
 * Issue #862: Per-task QA-gate evidence file protection.
 *
 * Verifies that the guardrails toolBefore hook refuses every form of agent
 * mutation against `.swarm/evidence/<strict-task-id>.json`:
 *   - Write / Edit / apply_patch
 *   - Bash: rm, mv, cp, sed -i, find -delete, xargs rm, redirect, bash -c wrapper
 *
 * Negative-control coverage: non-numeric stems (`.swarm/evidence/test.json`),
 * phase-scoped subdirs (`.swarm/evidence/retro-3/evidence.json`), and the
 * well-known `final-council.json` MUST still flow through to per-agent
 * authority rules — they are NOT blocked by the universal evidence guard.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

function baseConfig(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		idle_timeout_minutes: 60,
		no_op_warning_threshold: 9999,
		max_coder_revisions: 5,
		qa_gates: {
			required_tools: [],
			require_reviewer_test_engineer: false,
		},
	};
}

function input(tool: string, sessionID: string) {
	return { tool, sessionID, callID: `call-${Math.random()}` };
}

async function runWrite(
	hooks: ReturnType<typeof createGuardrailsHooks>,
	sessionID: string,
	args: Record<string, unknown>,
	tool = 'write',
): Promise<Error | null> {
	try {
		await hooks.toolBefore(input(tool, sessionID), { args });
		return null;
	} catch (error) {
		return error as Error;
	}
}

async function runBash(
	hooks: ReturnType<typeof createGuardrailsHooks>,
	sessionID: string,
	command: string,
): Promise<Error | null> {
	try {
		await hooks.toolBefore(input('bash', sessionID), { args: { command } });
		return null;
	} catch (error) {
		return error as Error;
	}
}

describe('issue #862: per-task evidence file protection', () => {
	let tempDir: string;

	beforeEach(async () => {
		resetSwarmState();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-protect-'));
	});

	afterEach(async () => {
		resetSwarmState();
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	// ───────────────────────────────────────────────────────────────────
	// Write / Edit blocks (per-agent universality)
	// ───────────────────────────────────────────────────────────────────
	for (const agent of [
		'architect',
		'reviewer',
		'critic',
		'test_engineer',
		'docs',
		'designer',
		'explorer',
		'sme',
		'coder',
	]) {
		it(`blocks ${agent} from writing .swarm/evidence/3.1.json (Write tool)`, async () => {
			const hooks = createGuardrailsHooks(tempDir, baseConfig());
			const sessionID = `session-write-${agent}`;
			startAgentSession(sessionID, agent);
			swarmState.activeAgent.set(sessionID, agent);

			const err = await runWrite(hooks, sessionID, {
				filePath: '.swarm/evidence/3.1.json',
				content: '{}',
			});
			expect(err).not.toBeNull();
			expect(err!.message).toContain('WRITE BLOCKED');
			expect(err!.message.toLowerCase()).toContain('per-task');
		});

		it(`blocks ${agent} from editing .swarm/evidence/3.1.json (Edit tool)`, async () => {
			const hooks = createGuardrailsHooks(tempDir, baseConfig());
			const sessionID = `session-edit-${agent}`;
			startAgentSession(sessionID, agent);
			swarmState.activeAgent.set(sessionID, agent);

			const err = await runWrite(
				hooks,
				sessionID,
				{
					filePath: '.swarm/evidence/3.1.json',
					oldString: 'a',
					newString: 'b',
				},
				'edit',
			);
			expect(err).not.toBeNull();
			expect(err!.message).toContain('WRITE BLOCKED');
		});
	}

	it('blocks apply_patch when ANY target is a per-task evidence file', async () => {
		const hooks = createGuardrailsHooks(tempDir, baseConfig());
		const sessionID = 'session-patch';
		startAgentSession(sessionID, 'reviewer');
		swarmState.activeAgent.set(sessionID, 'reviewer');

		const patchBody =
			'*** Begin Patch\n' +
			'*** Update File: .swarm/evidence/3.1.json\n' +
			'@@\n-foo\n+bar\n' +
			'*** End Patch\n';
		const err = await runWrite(
			hooks,
			sessionID,
			{ patch: patchBody },
			'apply_patch',
		);
		expect(err).not.toBeNull();
		expect(err!.message).toMatch(/WRITE BLOCKED|per-task/i);
	});

	it('blocks Write to nested numeric task ID like 1.2.3.json', async () => {
		const hooks = createGuardrailsHooks(tempDir, baseConfig());
		const sessionID = 'session-nested';
		startAgentSession(sessionID, 'reviewer');
		swarmState.activeAgent.set(sessionID, 'reviewer');

		const err = await runWrite(hooks, sessionID, {
			filePath: '.swarm/evidence/1.2.3.json',
			content: '{}',
		});
		expect(err).not.toBeNull();
		expect(err!.message).toContain('WRITE BLOCKED');
	});

	it('blocks Write when path uses leading ./', async () => {
		const hooks = createGuardrailsHooks(tempDir, baseConfig());
		const sessionID = 'session-dotslash';
		startAgentSession(sessionID, 'reviewer');
		swarmState.activeAgent.set(sessionID, 'reviewer');

		const err = await runWrite(hooks, sessionID, {
			filePath: './.swarm/evidence/4.4.json',
			content: '{}',
		});
		expect(err).not.toBeNull();
		expect(err!.message).toContain('WRITE BLOCKED');
	});

	it('blocks Write when path is absolute and resolves inside cwd', async () => {
		const hooks = createGuardrailsHooks(tempDir, baseConfig());
		const sessionID = 'session-abs';
		startAgentSession(sessionID, 'reviewer');
		swarmState.activeAgent.set(sessionID, 'reviewer');

		const err = await runWrite(hooks, sessionID, {
			filePath: path.join(tempDir, '.swarm', 'evidence', '4.4.json'),
			content: '{}',
		});
		expect(err).not.toBeNull();
		expect(err!.message).toContain('WRITE BLOCKED');
	});

	// ───────────────────────────────────────────────────────────────────
	// Negative controls — these MUST still pass through universal block
	// (per-agent authority rules then handle them as before).
	// ───────────────────────────────────────────────────────────────────
	it('does NOT block reviewer from writing .swarm/evidence/test.json (non-numeric stem)', async () => {
		const hooks = createGuardrailsHooks(tempDir, baseConfig());
		const sessionID = 'session-reviewer-test';
		startAgentSession(sessionID, 'reviewer');
		swarmState.activeAgent.set(sessionID, 'reviewer');

		const err = await runWrite(hooks, sessionID, {
			filePath: '.swarm/evidence/test.json',
			content: '{}',
		});
		expect(err).toBeNull();
	});

	it('does NOT block test_engineer from writing .swarm/evidence/notes.txt', async () => {
		const hooks = createGuardrailsHooks(tempDir, baseConfig());
		const sessionID = 'session-te-notes';
		startAgentSession(sessionID, 'test_engineer');
		swarmState.activeAgent.set(sessionID, 'test_engineer');

		const err = await runWrite(hooks, sessionID, {
			filePath: '.swarm/evidence/notes.txt',
			content: 'notes',
		});
		expect(err).toBeNull();
	});

	it('does NOT block reviewer from writing .swarm/evidence/retro-3/evidence.json (phase-scoped subdir)', async () => {
		const hooks = createGuardrailsHooks(tempDir, baseConfig());
		const sessionID = 'session-retro';
		startAgentSession(sessionID, 'reviewer');
		swarmState.activeAgent.set(sessionID, 'reviewer');

		const err = await runWrite(hooks, sessionID, {
			filePath: '.swarm/evidence/retro-3/evidence.json',
			content: '{}',
		});
		expect(err).toBeNull();
	});

	it('does NOT block reviewer from writing .swarm/evidence/final-council.json', async () => {
		const hooks = createGuardrailsHooks(tempDir, baseConfig());
		const sessionID = 'session-final';
		startAgentSession(sessionID, 'reviewer');
		swarmState.activeAgent.set(sessionID, 'reviewer');

		const err = await runWrite(hooks, sessionID, {
			filePath: '.swarm/evidence/final-council.json',
			content: '{}',
		});
		expect(err).toBeNull();
	});

	// ───────────────────────────────────────────────────────────────────
	// Bash mutation blocks
	// ───────────────────────────────────────────────────────────────────
	const BLOCKED_BASH = [
		['rm', 'rm .swarm/evidence/4.4.json'],
		['rm absolute', 'rm /tmp/repo/.swarm/evidence/4.4.json'],
		['mv', 'mv .swarm/evidence/4.4.json /tmp/x'],
		['cp overwrite', 'cp /tmp/x .swarm/evidence/4.4.json'],
		['unlink', 'unlink .swarm/evidence/4.4.json'],
		['truncate', 'truncate -s 0 .swarm/evidence/4.4.json'],
		['sed -i', "sed -i 's/x/y/' .swarm/evidence/4.4.json"],
		['sed --in-place', "sed --in-place 's/x/y/' .swarm/evidence/4.4.json"],
		['find -delete', 'find .swarm/evidence -name "4.4.json" -delete'],
		['xargs rm', 'echo .swarm/evidence/4.4.json | xargs rm'],
		['redirect >', 'echo {} > .swarm/evidence/4.4.json'],
		['redirect >>', 'echo {} >> .swarm/evidence/4.4.json'],
		['bash -c wrap', 'bash -c "rm .swarm/evidence/4.4.json"'],
		['sh -c wrap', 'sh -c "rm .swarm/evidence/4.4.json"'],
	] as const;

	for (const [label, cmd] of BLOCKED_BASH) {
		it(`Bash blocks: ${label}`, async () => {
			const hooks = createGuardrailsHooks(tempDir, baseConfig());
			const sessionID = `session-bash-${label}`;
			startAgentSession(sessionID, 'architect');
			swarmState.activeAgent.set(sessionID, 'architect');

			const err = await runBash(hooks, sessionID, cmd);
			expect(err).not.toBeNull();
			expect(err!.message).toContain('BASH BLOCKED');
		});
	}

	const ALLOWED_BASH = [
		['cat', 'cat .swarm/evidence/4.4.json'],
		['ls dir', 'ls .swarm/evidence/'],
		['head', 'head -n 5 .swarm/evidence/4.4.json'],
		['jq read', 'jq . .swarm/evidence/4.4.json'],
		['grep read', 'grep foo .swarm/evidence/4.4.json'],
		['rm non-numeric stem', 'rm .swarm/evidence/test.json'],
		['rm retro file', 'rm .swarm/evidence/retro-3/evidence.json'],
		['rm final-council', 'rm .swarm/evidence/final-council.json'],
	] as const;

	for (const [label, cmd] of ALLOWED_BASH) {
		it(`Bash allows: ${label}`, async () => {
			const hooks = createGuardrailsHooks(tempDir, baseConfig());
			const sessionID = `session-bash-allow-${label}`;
			startAgentSession(sessionID, 'architect');
			swarmState.activeAgent.set(sessionID, 'architect');

			const err = await runBash(hooks, sessionID, cmd);
			// Either pass cleanly or be blocked by an unrelated guard
			// (e.g., destructive-rm), but NEVER by the evidence guard.
			if (err !== null) {
				expect(err.message).not.toContain('BASH BLOCKED');
			}
		});
	}
});
