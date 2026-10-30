/**
 * Multi-operand builtin-write coverage for the shell write-scope gate
 * (issue #3503, AC1). Real bash `rmdir dir...` removes EVERY operand and
 * `truncate file...` truncates EVERY operand, so the write detector must
 * report each non-switch operand as its own write target; an out-of-scope
 * operand in ANY position denies the command. At base only one operand per
 * command is reported (the LAST non-flag word for rmdir, the FIRST for
 * truncate), so the escape legs below are RED until the detector models the
 * operand set.
 *
 * The gate evaluates the command TEXT through the real toolBefore; no
 * fixture directories are created (the bare-rmdir exemption accepts a
 * missing directory, and the ordinary scope check is lexical) — mirroring
 * the trace's base probe. cp/mv/install/ln keep destination-only semantics
 * (the LAST operand is the written file), pinned by the final detector leg.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { detectPosixWrites } from '../../../src/hooks/shell-write-detect';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp(
	'guardrails-shell-write-rmdir-multi-operand-',
);
// Loose pin: the full message embeds host-specific absolute paths.
const WRITE_BLOCKED = /^WRITE BLOCKED/;

function config(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
	};
}

let callCounter = 0;

function coderWithScope(sessionID: string, files: string[]): string {
	const callID = `call-${++callCounter}`;
	startAgentSession(sessionID, 'coder');
	installActiveScopeBinding({
		directory: TEST_DIR,
		childSessionId: sessionID,
		taskId: '1.1',
		files,
		dispatchCallId: callID,
	});
	return callID;
}

async function runAsCoder(sessionID: string, command: string): Promise<void> {
	const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
	const callID = coderWithScope(sessionID, ['src/']);
	await hooks.toolBefore(
		{ tool: 'bash', sessionID, callID },
		{ args: { command } },
	);
}

afterAll(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('shell write scope: multi-operand builtin writes (#3503 AC1)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('denies rmdir whose FIRST operand is out of scope (escape at base)', async () => {
		await expect(
			runAsCoder('rmdir-first-oos', 'rmdir outside-oos src/share/ok'),
		).rejects.toThrow(WRITE_BLOCKED);
	});

	it('denies the reversed operand order (control, denied at base too)', async () => {
		await expect(
			runAsCoder('rmdir-reversed', 'rmdir src/share/ok outside-oos'),
		).rejects.toThrow(WRITE_BLOCKED);
	});

	it('denies when every operand but the last is out of scope', async () => {
		await expect(
			runAsCoder(
				'rmdir-all-but-last',
				'rmdir outside-oosA outside-oosB src/ok',
			),
		).rejects.toThrow(WRITE_BLOCKED);
	});

	it('denies a flag-prefixed multi-operand rmdir', async () => {
		await expect(
			runAsCoder('rmdir-flag-prefix', 'rmdir -p outside-oos src/ok'),
		).rejects.toThrow(WRITE_BLOCKED);
	});

	it('admits a multi-operand rmdir whose operands are all in scope (floor)', async () => {
		await expect(
			runAsCoder('rmdir-in-scope-multi', 'rmdir src/a src/b'),
		).resolves.toBeUndefined();
	});

	it('keeps single-operand in-scope rmdir admitted (#3503 AC2 floor)', async () => {
		await expect(
			runAsCoder('rmdir-single-in-scope', 'rmdir src/old'),
		).resolves.toBeUndefined();
	});

	it('class coverage (truncate): denies multi-operand truncate whose later operand is out of scope', async () => {
		await expect(
			runAsCoder('truncate-later-oos', 'truncate -s 0 src/a outside-oos-t'),
		).rejects.toThrow(WRITE_BLOCKED);
	});
});

describe('detectPosixWrites: multi-operand builtin write operand sets (#3503)', () => {
	const builtinWritePaths = (command: string): string[] =>
		detectPosixWrites(command)
			.writes.filter((write) => write.category === 'builtin_write')
			.map((write) => write.path);

	it('reports every operand of rmdir a b c as a builtin_write', () => {
		expect(builtinWritePaths('rmdir a b c')).toEqual(['a', 'b', 'c']);
	});

	it('class coverage (truncate): reports every operand of truncate -s 0 a b', () => {
		expect(builtinWritePaths('truncate -s 0 a b')).toEqual(['a', 'b']);
	});

	it('class coverage (cp destination floor): cp reports only the destination, never the source x', () => {
		expect(builtinWritePaths('cp x src/dest')).toEqual(['src/dest']);
	});
});

describe('process substitution fallback: multi-operand operands reach the gate (#3503, plan-critic R2-1)', () => {
	it('denies true >(rmdir outside-oos src/ok) — the string fallback reports every operand', async () => {
		await expect(
			runAsCoder('procsub-rmdir', 'true >(rmdir outside-oos src/ok)'),
		).rejects.toThrow(WRITE_BLOCKED);
	});

	it('class coverage (truncate): denies true >(truncate -s 0 outside-oos-t src/a) — fallback last-token scan', async () => {
		await expect(
			runAsCoder(
				'procsub-truncate-oos-first',
				'true >(truncate -s 0 outside-oos-t src/a)',
			),
		).rejects.toThrow(WRITE_BLOCKED);
	});

	it('class coverage (truncate): denies true >(truncate -s 0 src/a outside-oos-t) — complementary order', async () => {
		await expect(
			runAsCoder(
				'procsub-truncate-oos-last',
				'true >(truncate -s 0 src/a outside-oos-t)',
			),
		).rejects.toThrow(WRITE_BLOCKED);
	});

	it('in-scope floor: true >(rmdir src/a src/b) stays admitted', async () => {
		await runAsCoder('procsub-in-scope', 'true >(rmdir src/a src/b)');
	});
});
