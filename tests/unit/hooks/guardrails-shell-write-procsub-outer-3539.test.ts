/**
 * #3539 W5 (RC-5): procsub masking + residual resolution. On a
 * parse-failing `>(…)` line the detector now masks every balanced unquoted
 * span, parses the RESIDUAL, and takes the OUTER writes from the normal AST
 * detectors on that residual — the second write that the procsub-only
 * partial detector laundered (C9) is visible again. The gate resolves the
 * surviving writes against the residual so outer writes resolve under
 * TRACKED cd context (the critic discriminator), and masked-inner writes
 * withdraw when their body or outer prefix carries a directory change.
 * Legs run through the REAL createGuardrailsHooks().toolBefore (coder,
 * scope src/), plus detector-level residual pins and `/swarm guardrail
 * explain` parity rows.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	detectPosixWrites,
	resolveWriteTargets,
} from '../../../src/hooks/shell-write-detect';
import { handleGuardrailExplain } from '../../../src/services/guardrail-explain-service';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const ANY_WRITE_BLOCK = /^(WRITE )?BLOCKED/;
const ANY_BLOCK = /^(WRITE )?BLOCKED/;
const created: string[] = [];
const explainRoots: string[] = [];
let counter = 0;

afterAll(() => {
	for (const dir of created.splice(0)) removeTreeWithRetry(dir);
});

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

function freshWorkspace(): string {
	const ws = canonicalMkdtemp('w5-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	return ws;
}

async function gate(
	command: string,
): Promise<{ verdict: 'ADMITTED' | 'DENIED'; detail: string }> {
	const ws = freshWorkspace();
	const sessionID = `w5-${++counter}`;
	const callID = `w5-call-${counter}`;
	startAgentSession(sessionID, 'coder');
	installActiveScopeBinding({
		directory: ws,
		childSessionId: sessionID,
		taskId: '1.1',
		files: ['src/'],
		dispatchCallId: callID,
	});
	const hooks = createGuardrailsHooks(ws, undefined, config());
	try {
		await hooks.toolBefore(
			{ tool: 'bash', sessionID, callID },
			{ args: { command } },
		);
		return { verdict: 'ADMITTED', detail: '' };
	} catch (error) {
		return {
			verdict: 'DENIED',
			detail: (error as Error).message.split('\n')[0].slice(0, 120),
		};
	} finally {
		resetSwarmState();
	}
}

async function expectAdmitted(command: string): Promise<void> {
	const got = await gate(command);
	expect(`${command} -> ${got.verdict} ${got.detail}`).toBe(
		`${command} -> ADMITTED `,
	);
}

async function expectDenied(
	command: string,
	detailPattern?: RegExp,
): Promise<void> {
	const got = await gate(command);
	expect(got.verdict).toBe('DENIED');
	if (detailPattern) expect(got.detail).toMatch(detailPattern);
}

describe('gate: procsub masking exposes the outer writes (C9 families)', () => {
	test('outer redirect AFTER the procsub is DENIED (laundry closed)', async () => {
		await expectDenied(
			'tee >(cat > src/ok) ; echo x > /etc/passwd',
			/^WRITE BLOCKED/,
		);
	});
	test('outer redirect attached to the tee pipeline is DENIED', async () => {
		await expectDenied(
			'echo hi | tee >(cat > src/ok) > ../outside.txt',
			/^WRITE BLOCKED/,
		);
	});
	test('outer write BEFORE the procsub is DENIED (both orderings)', async () => {
		await expectDenied('echo x > ../esc.txt; tee >(cat > src/ok)');
	});
	test('outer builtin cp is DENIED', async () => {
		await expectDenied('tee >(cat > src/ok); cp a ../../esc.txt');
	});
	test('outer builtin mv is DENIED', async () => {
		await expectDenied('tee >(cat > src/ok) ; mv a ../esc.txt');
	});
	test('outer truncate is DENIED', async () => {
		await expectDenied('tee >(cat > src/ok); truncate -s 0 ../esc.txt');
	});
	test('two procsub spans, second outer-laundry write is DENIED', async () => {
		await expectDenied(
			'tee >(cat > src/ok); tee >(cat > src/ok2) ; echo x > ../esc.txt',
		);
	});
});

describe('gate: benign procsub controls stay ADMITTED', () => {
	test('procsub alone stays ADMITTED (C9 control)', async () => {
		await expectAdmitted('tee >(cat > src/ok)');
	});
	test('each redirect alone stays BLOCKED (C9 controls)', async () => {
		await expectDenied('echo x > /etc/passwd', /^WRITE BLOCKED/);
		await expectDenied('echo x > ../outside.txt', /^WRITE BLOCKED/);
	});
	test('in-scope outer redirect behind a procsub ADMITS', async () => {
		await expectAdmitted('tee >(cat > src/ok) > src/outer.txt');
	});
	test('QUOTED outer operand ADMITS (residual parses quoted words)', async () => {
		await expectAdmitted("tee >(cat > src/ok) > 'src/quoted out.txt'");
	});
	test('fd-dup on the outer command is not a write (exclusion)', async () => {
		await expectAdmitted('tee >(cat > src/ok) 2>&1');
	});
	test('read-only <(cmd) procsub no longer parse-blocks (masking admits)', () => {
		// Detector-level pin: the write gate clears the parse error for a
		// read-only `<(…)` line and reports no writes. (Not a toolBefore leg:
		// an admitted no-write command then reaches the host sandbox arm,
		// whose weak-PowerShell wrapper rejects this shape on machines
		// without the native Windows sandbox runner — an environment
		// behavior outside this gate.)
		const analysis = detectPosixWrites('cat <(ls)');
		expect(analysis.parseError).toBeUndefined();
		expect(analysis.writes).toEqual([]);
		expect(analysis.residualCommand).toBe('cat /dev/null');
	});
	test('a <(cmd) body write is judged like a >(cmd) body', async () => {
		await expectDenied('cat <(tee ../../esc.txt)');
	});
	test('> >(cat > src/f) redirect-to-procsub admits in scope', async () => {
		await expectAdmitted('echo x > >(cat > src/f)');
	});
	test('> >(cat > ../f) redirect-to-procsub denies out of scope', async () => {
		await expectDenied('echo x > >(cat > ../esc.txt)');
	});
});

describe('gate: residual context discriminator + inner-cd withdrawal (v4 constraints 6-7)', () => {
	test('cd ..; tee >(cat > src/ok); echo x > src/f DENIES (outer write at post-cd cwd)', async () => {
		await expectDenied(
			'cd ..; tee >(cat > src/ok); echo x > src/f',
			/SCOPE_VIOLATION|WRITE BLOCKED/,
		);
	});
	test('same line without the cd ADMITS (the cd is the discriminator)', async () => {
		await expectAdmitted('tee >(cat > src/ok); echo x > src/f');
	});
	test('tee >(cd ..; cat > src/f) DENIES (inner-cd withdrawal)', async () => {
		await expectDenied('tee >(cd ..; cat > src/f)');
	});
	test('a cd AFTER the span does not withdraw the inner write', async () => {
		await expectAdmitted('tee >(cat > src/ok); cd src');
	});
	test('bash -c payload procsub is the W4 surface, not this one (admits in scope)', async () => {
		await expectAdmitted("bash -c 'tee >(cat > src/ok)'");
	});
	test('bash -c payload procsub with an escaping write DENIES', async () => {
		await expectDenied("bash -c 'tee >(cat > ../esc.txt)'");
	});
});

describe('gate: malformed residuals stay blocked (fail-closed)', () => {
	test('stray close paren after the span is a parse error block', async () => {
		await expectDenied('tee >(cat > src/ok))', /failed to parse/);
	});
	test('unbalanced procsub span is a parse error block', async () => {
		await expectDenied('tee >(cat > src/ok', /failed to parse/);
	});
	test('a quoted procsub is a literal operand (parse OK), judged as a path', async () => {
		// `tee '>(cat > src/ok)'` writes a file literally named `>(cat > src/ok)`
		// at the workspace root — outside scope src/ — so it DENIES as a write.
		await expectDenied("tee '>(cat > src/ok)'", /^WRITE BLOCKED/);
	});
	test('a comment procsub never masks and never blocks', async () => {
		await expectAdmitted('true # >(cat > ../esc.txt)');
	});
});

describe('detector: residual + placeholder properties (metadata suppression)', () => {
	test('masking returns the residual and clears parseError', () => {
		const analysis = detectPosixWrites(
			'tee >(cat > src/ok) ; echo x > /etc/passwd',
		);
		expect(analysis.parseError).toBeUndefined();
		expect(analysis.residualCommand).toBe(
			'tee /dev/null ; echo x > /etc/passwd',
		);
		expect(analysis.writes.map((w) => w.path)).toEqual([
			'/etc/passwd',
			'src/ok',
		]);
	});
	test('the placeholder operand emits no outer write (sink exemption, both walks)', () => {
		const analysis = detectPosixWrites('tee >(cat > src/ok)');
		expect(analysis.writes.map((w) => w.path)).toEqual(['src/ok']);
		const resolved = resolveWriteTargets(
			analysis.residualCommand ?? 'tee >(cat > src/ok)',
			analysis.writes,
			'/ws',
		);
		expect(resolved).toHaveLength(1);
		expect(resolved[0].resolvedPath?.replaceAll('\\', '/')).toBe('/ws/src/ok');
	});
	test('outer writes resolve under the residual tracked cwd', () => {
		const analysis = detectPosixWrites(
			'cd ..; tee >(cat > src/ok); echo x > src/f',
		);
		const resolved = resolveWriteTargets(
			analysis.residualCommand as string,
			analysis.writes,
			'/ws',
		);
		const paths = resolved.map((r) => r.resolvedPath);
		// The withdrawn inner write nulls; the outer write lands one level up.
		expect(paths).toContain(null);
		expect(paths).toContain('/src/f');
	});
	test('a real /dev/null operand is still a non-target beside a procsub', () => {
		const analysis = detectPosixWrites('tee /dev/null >(cat > src/ok)');
		expect(analysis.writes.map((w) => w.path)).toEqual(['src/ok']);
	});
	test('no-mask legacy fallback keeps its parseError (partial find never clears)', () => {
		const analysis = detectPosixWrites('tee >(cat > src/ok))');
		expect(analysis.parseError).toBe(true);
	});
});

describe('explain parity: the mirror consumes the residual channel', () => {
	afterEach(() => {
		for (const root of explainRoots.splice(0)) {
			// best-effort cleanup; canonicalMkdtemp dirs also tracked above
			try {
				removeTreeWithRetry(root);
			} catch {
				/* best effort */
			}
		}
	});

	async function explain(command: string): Promise<string> {
		const root = canonicalMkdtemp('w5-explain-');
		explainRoots.push(root);
		mkdirSync(path.join(root, 'src'), { recursive: true });
		created.push(root);
		return handleGuardrailExplain(root, [
			'--scope',
			'src/',
			...command.split(' '),
		]);
	}

	test('outer-write laundry explains as block (gate parity)', async () => {
		const out = await explain('tee >(cat > src/ok) > ../outside.txt');
		expect(out).toMatch(/\| *Decision *\| *block */i);
	});
	test('residual-context discriminator explains as block', async () => {
		const out = await explain('cd ..; tee >(cat > src/ok); echo x > src/f');
		expect(out).toMatch(/\| *Decision *\| *block */i);
	});
	test('in-scope procsub explains as allow', async () => {
		const out = await explain('tee >(cat > src/ok)');
		expect(out).toMatch(/\| *Decision *\| *allow */i);
	});
	test('inner-cd withdrawal explains as block', async () => {
		const out = await explain('tee >(cd ..; cat > src/f)');
		expect(out).toMatch(/\| *Decision *\| *block */i);
	});
});
