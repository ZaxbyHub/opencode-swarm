/**
 * #3587: every `is not authorised to write` denial in tool-before.ts renders
 * the target bounded and home-redacted; the file-authority REASON path slot
 * folds home/profile prefixes via the original-input display; structured data
 * channels (ShellWriteBlockedError.writeTarget, audit rows) keep exact values.
 *
 * Legs mirror the frozen acceptance checks (C1 live four-door set; C2 = this
 * suite) and the executed probe evidence in the issue trace.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { redactPath } from '../../../src/hooks/guardrails/audit-log';
import { checkFileAuthority } from '../../../src/hooks/guardrails/file-authority';
import {
	_internals,
	ShellWriteBlockedError,
} from '../../../src/hooks/guardrails/tool-before';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const created: string[] = [];
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
	} as GuardrailsConfig;
}

const longName = `h${'a'.repeat(400)}`;
const RUN_320 = 'a'.repeat(320);
const DENIAL_SHAPE = /is not authorised to write "([^"]*)"/;

interface Verdict {
	verdict: 'ADMITTED' | 'DENIED';
	message: string;
	error: unknown;
}

async function gateShell(
	ws: string,
	command: string,
	opts?: {
		agent?: 'coder' | 'build';
		scope?: string[];
		authority?: unknown;
	},
): Promise<Verdict> {
	const sessionID = `r3587-s${++counter}`;
	const callID = `r3587-c${counter}`;
	startAgentSession(sessionID, opts?.agent ?? 'coder');
	if (opts?.scope) {
		installActiveScopeBinding({
			directory: ws,
			childSessionId: sessionID,
			taskId: '1.1',
			files: opts.scope,
			dispatchCallId: callID,
		});
	}
	const hooks = createGuardrailsHooks(
		ws,
		undefined,
		config(),
		opts?.authority as never,
	);
	try {
		await hooks.toolBefore(
			{ tool: 'bash', sessionID, callID },
			{ args: { command } },
		);
		return { verdict: 'ADMITTED', message: '', error: undefined };
	} catch (error) {
		return {
			verdict: 'DENIED',
			message: (error as Error).message.split('\n')[0] ?? '',
			error,
		};
	} finally {
		resetSwarmState();
	}
}

async function gateWrite(ws: string, filePath: string): Promise<Verdict> {
	const sessionID = `r3587-s${++counter}`;
	const callID = `r3587-c${counter}`;
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
			{ tool: 'write', sessionID, callID },
			{ args: { filePath, content: 'x' } },
		);
		return { verdict: 'ADMITTED', message: '', error: undefined };
	} catch (error) {
		return {
			verdict: 'DENIED',
			message: (error as Error).message.split('\n')[0] ?? '',
			error,
		};
	} finally {
		resetSwarmState();
	}
}

function auditRows(ws: string): Array<Record<string, unknown>> {
	const p = path.join(ws, '.swarm', 'session', 'shell-audit.jsonl');
	try {
		return readFileSync(p, 'utf-8')
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

function wsFixture(): string {
	const ws = canonicalMkdtemp('r3587-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	return ws;
}

describe('3587 four denial doors render bounded, redacted targets', () => {
	test('shell enforced-authority door (:1733 family)', async () => {
		const ws = wsFixture();
		const got = await gateShell(ws, `printf x > .git/${longName}`, {
			scope: ['src/'],
		});
		expect(got.verdict).toBe('DENIED');
		const render = DENIAL_SHAPE.exec(got.message)?.[1] ?? '';
		// The capture is non-empty — a message-shape regression that empties
		// or drops the quoted slot fails here (the production extractor's
		// [^"]+ requires one-or-more; the suite regex is intentionally
		// [^"]* so the empty case is observable and asserted away).
		expect(render.length).toBeGreaterThan(0);
		expect(render.length).toBeLessThanOrEqual(320);
		expect(got.message.includes(RUN_320)).toBe(false);
		if (process.platform === 'win32') {
			// redactPath folds the profile PREFIX only; AppData/Local/Temp below
			// it legitimately remains — the USER segment must be gone.
			expect(render.startsWith('~')).toBe(true);
			expect(render.includes('Users')).toBe(false);
		}
	}, 30_000);

	test('non-shell file_write door (:3578 family)', async () => {
		const ws = wsFixture();
		const got = await gateWrite(ws, `.git/${longName}`);
		expect(got.verdict).toBe('DENIED');
		const render = DENIAL_SHAPE.exec(got.message)?.[1] ?? '';
		expect(render.length).toBeGreaterThan(0);
		expect(render.length).toBeLessThanOrEqual(320);
		expect(got.message.includes(RUN_320)).toBe(false);
	}, 30_000);

	test('universal deny prefix door via lenient role (:1658 family)', async () => {
		const ws = wsFixture();
		const got = await gateShell(ws, `printf x > haaa${'a'.repeat(400)}`, {
			agent: 'build',
			authority: {
				enabled: true,
				rules: {},
				universal_deny_prefixes: ['haaa'],
			},
		});
		expect(got.verdict).toBe('DENIED');
		expect(got.message.includes('universal deny prefix')).toBe(true);
		const render = DENIAL_SHAPE.exec(got.message)?.[1] ?? '';
		expect(render.length).toBeGreaterThan(0);
		expect(render.length).toBeLessThanOrEqual(320);
		expect(got.message.includes(RUN_320)).toBe(false);
	}, 30_000);

	test('lenient verifier-config door via lenient role (:1700 family)', async () => {
		const ws = wsFixture();
		const got = await gateShell(
			ws,
			`printf x > quality-gate.h${'a'.repeat(400)}.toml`,
			{
				agent: 'build',
				authority: {
					enabled: true,
					rules: {},
					universal_deny_prefixes: [],
					verifier_config_paths: ['**/quality-gate.*'],
				},
			},
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message.includes('verifier-owned configuration')).toBe(true);
		const render = DENIAL_SHAPE.exec(got.message)?.[1] ?? '';
		expect(render.length).toBeGreaterThan(0);
		expect(render.length).toBeLessThanOrEqual(320);
		expect(got.message.includes(RUN_320)).toBe(false);
	}, 30_000);

	test('shell door renders the RESOLVED target with the runtime profile folded', async () => {
		// Shell doors render the resolved absolute: its leading runtime
		// profile folds; an interior caller-supplied home/<name> segment
		// beyond it is a disclosed bound (fragment Known bounds).
		const ws = wsFixture();
		const got = await gateShell(ws, 'printf x > ../../home/alice/x.txt', {
			scope: ['src/'],
		});
		expect(got.verdict).toBe('DENIED');
		const render = DENIAL_SHAPE.exec(got.message)?.[1] ?? '';
		expect(render.length).toBeGreaterThan(0);
		const home = os.homedir();
		if (ws.startsWith(home)) {
			expect(render.includes(path.basename(home))).toBe(false);
			expect(render.startsWith('~')).toBe(true);
		}
	}, 30_000);
});

describe('3587 reason channel folds home/profile paths (file-authority)', () => {
	test('invalid-path arm: platform-independent fold, decision.path retained', () => {
		const decision = checkFileAuthority(
			'coder',
			'/home/alice/aw\u0001ful.txt',
			process.cwd(),
			undefined,
			{ declaredScope: ['src/'] },
		);
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.reason).toContain('path=~/aw?ful.txt');
			expect(decision.reason.includes('/home/alice')).toBe(false);
			// Structured channel keeps the sanitized pre-change form.
			expect(decision.path).toBe('/home/alice/aw?ful.txt');
		}
	});

	test.each([
		'./../home/alice/aw\u0001ful.txt',
		'src/../../home/alice/aw\u0001ful.txt',
	])('invalid-path arm: non-canonical escaping %p folds (normalized probe)', (t) => {
		const decision = checkFileAuthority('coder', t, process.cwd(), undefined, {
			declaredScope: ['src/'],
		});
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.reason).toContain('path=../~/aw?ful.txt');
			expect(decision.reason.includes('alice')).toBe(false);
		}
	});

	test('Windows-profile slash form folds in the reason on every host', () => {
		// Lexical classification: no platform gate (pre-fix this leaked the
		// account name on POSIX hosts, where C:/ is not path-absolute).
		const decision = checkFileAuthority(
			'coder',
			'C:/Users/alice/s\u0001.txt',
			process.cwd(),
			undefined,
			{ declaredScope: ['src/'] },
		);
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.reason.includes('alice')).toBe(false);
		}
	});

	test.skipIf(process.platform !== 'win32')(
		'same-root arm: display folds, decision.path keeps host-relative form',
		() => {
			const decision = checkFileAuthority(
				'coder',
				'/home/alice/secret.txt',
				process.cwd(),
				undefined,
				{ declaredScope: ['src/'] },
			);
			expect(decision.allowed).toBe(false);
			if (!decision.allowed) {
				expect(decision.reason).toContain('~/secret.txt');
				expect(decision.reason.includes('/home/alice')).toBe(false);
				// Depth-independent: the structured path keeps the host-relative
				// form whose ../ count equals the checkout depth below the drive
				// root (2 on this repo's local root, 3 on the GitHub Windows
				// checkout) — pin the shape, never a depth literal.
				expect(decision.path).toMatch(/^(\.\.\/)+home\/alice\/secret\.txt$/);
			}
		},
	);

	test.skipIf(process.platform !== 'win32')(
		'non-home cross-root control: preserved, bounded, never tilde-folded',
		() => {
			// Z: is only a DIFFERENT ROOT on Windows; on POSIX it is a relative
			// filename inside the workspace (allowed), so the control is
			// win32-gated like the same-root leg.
			const decision = checkFileAuthority(
				'coder',
				'Z:/elsewhere/x.txt',
				process.cwd(),
				undefined,
				{ declaredScope: ['src/'] },
			);
			expect(decision.allowed).toBe(false);
			if (!decision.allowed) {
				// redactPath intentionally preserves ordinary non-home absolutes.
				expect(decision.reason).toContain('path=Z:');
				expect(decision.reason.includes('path=~')).toBe(false);
			}
		},
	);

	test('relative escaping input keeps the workspace-relative reason shape', () => {
		// The pre-change display for RELATIVE inputs (the W4-pinned
		// behavior): the reason carries the normalized relative form, never
		// an absolute render, so ../shape assertions keep matching.
		const decision = checkFileAuthority(
			'coder',
			'../x',
			process.cwd(),
			undefined,
			{ declaredScope: ['src/'] },
		);
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.reason).toMatch(/\.\.[\\/]x/);
			expect(decision.reason.includes('~')).toBe(false);
		}
	});
});

describe('3587 renderDenialTarget shipped representations (_internals seam)', () => {
	const render = _internals.renderDenialTarget;

	test('POSIX home folds', () => {
		expect(render('/home/alice/x.txt')).toBe('~/x.txt');
	});
	test('macOS home folds', () => {
		expect(render('/Users/alice/x.txt')).toBe('~/x.txt');
	});
	test.skipIf(process.platform !== 'win32')(
		'Windows profile folds to a single-separator form (double separator fixed)',
		() => {
			expect(render('C:\\Users\\alice\\x.txt')).toBe('~\\x.txt');
		},
	);
	test.skipIf(process.platform !== 'win32')(
		'UNC share folds to the shipped form',
		() => {
			expect(render('\\\\server\\share\\user\\x.txt')).toBe(
				'~\\share\\user\\x.txt',
			);
		},
	);
	test('control and bidi characters neutralize', () => {
		const out = render('/home/alice/aw\u0001\u0002\u202Eful.txt');
		expect(out).toBe('~/aw???ful.txt');
	});
	test('length bounds at 320 with the ellipsis', () => {
		const out = render(`h${'a'.repeat(400)}`);
		expect(out.length).toBe(320);
		expect(out.endsWith('…')).toBe(true);
		expect(out.includes(RUN_320)).toBe(false);
	});
	test('benign bare filename renders verbatim (no over-redaction)', () => {
		expect(render('plainname24chars.txt')).toBe('plainname24chars.txt');
	});
	test('escaping-relative slash form folds the home segment (message/reason agree)', () => {
		const out = render('../home/alice/x.txt');
		expect(out).toMatch(/^\.\.[\\/]~[\\/]x\.txt$/);
		expect(out.includes('home/alice')).toBe(false);
	});
	test.skipIf(process.platform !== 'win32')(
		'escaping-relative raw win32 backslash form folds too (Users segment gone)',
		() => {
			// The non-shell door passes the raw caller string through, so the
			// native win32 escaping form must fold exactly like the slash form
			// (the reason channel slash-normalizes; the message must agree).
			const out = render('..\\Users\\alice\\x.txt');
			expect(out).toMatch(/^\.\.[\\/]~[\\/]x\.txt$/);
			expect(out.includes('Users')).toBe(false);
		},
	);
	test.each([
		'./../home/alice/x.txt',
		'src/../../home/alice/x.txt',
	])('non-canonical escaping spelling %p folds like the reason channel', (t) => {
		const out = render(t);
		expect(out).toMatch(/^\.\.[\\/]~[\\/]x\.txt$/);
		expect(/alice/.test(out)).toBe(false);
	});
	test(
		'in-workspace home-named segment stays unfolded (fold branch gated on escaping)',
		() => {
			// Discriminating for the escaping gate: 'docs/home/alice' is NOT
			// escaping after normalization, so the fold must not fire even
			// though the path carries a home/<name> segment. (A dotted benign
			// relative is observationally identical through redactPath's own
			// normalize — see the shipped helper — so it pins nothing here.)
			expect(render('docs/home/alice/x.txt')).toBe(
				redactPath('docs/home/alice/x.txt'),
			);
			expect(render('docs/home/alice/x.txt').includes('~')).toBe(false);
		},
	);
});

describe('3587 structured data channels keep exact values', () => {
	test('ShellWriteBlockedError.writeTarget is raw at the enforced door', async () => {
		const ws = wsFixture();
		const got = await gateShell(ws, `printf x > .git/${longName}`, {
			scope: ['src/'],
		});
		expect(got.verdict).toBe('DENIED');
		const err = got.error as ShellWriteBlockedError;
		expect(err).toBeInstanceOf(ShellWriteBlockedError);
		expect(err.writeTarget).toBe(path.join(ws, '.git', longName));
	}, 30_000);

	test('ShellWriteBlockedError.writeTarget is raw at the universal-deny door', async () => {
		const ws = wsFixture();
		const target = `haaa${'a'.repeat(400)}`;
		const got = await gateShell(ws, `printf x > ${target}`, {
			agent: 'build',
			authority: {
				enabled: true,
				rules: {},
				universal_deny_prefixes: ['haaa'],
			},
		});
		const err = got.error as ShellWriteBlockedError;
		expect(err).toBeInstanceOf(ShellWriteBlockedError);
		expect(err.writeTarget).toBe(path.join(ws, target));
	}, 30_000);

	test('non-shell audit row: short target persists the shipped redacted form', async () => {
		const ws = wsFixture();
		const short = 'cfg.settings.json';
		const got = await gateWrite(ws, `.git/${short}`);
		expect(got.verdict).toBe('DENIED');
		const rows = auditRows(ws).filter((row) => row.path !== undefined);
		expect(rows.length).toBeGreaterThan(0);
		const rowPath = String(rows[rows.length - 1]?.path);
		// The non-shell door persists the RELATIVE input through redactPath —
		// no profile text, no tilde, exact shipped form.
		expect(rowPath).toBe(redactPath(path.join('.git', short)));
		expect(rowPath.includes('~')).toBe(false);
	}, 30_000);

	test('non-shell audit row: hostile target persists redacted and bounded', async () => {
		const ws = wsFixture();
		const got = await gateWrite(ws, `.git/${longName}`);
		expect(got.verdict).toBe('DENIED');
		const rows = auditRows(ws).filter((row) => row.path !== undefined);
		expect(rows.length).toBeGreaterThan(0);
		const rowPath = String(rows[rows.length - 1]?.path);
		// Shipped audit contract: truncateUtf8Safe at maxPathChars=320 plus the
		// 12-char '[truncated]' marker — 332 rendered chars max, no raw run.
		expect(rowPath.length).toBeLessThanOrEqual(332);
		expect(rowPath.endsWith('…[truncated]')).toBe(true);
		expect(rowPath.includes(RUN_320)).toBe(false);
	}, 30_000);
});
