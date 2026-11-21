/**
 * Fixture suite for the floating-promise scanner (r17 §7): the checker must
 * distinguish genuinely unhandled promise execution from every legitimate
 * handling shape before its findings can be used as review candidates.
 *
 * The fixtures encode the r17 §7 case list. The scanner's verdict on each:
 *   MUST REPORT   — bare unhandled call; `void` discard (intent, not a safe
 *                   rejection path — surfaced as a separate category).
 *   MUST NOT REPORT — awaited; returned to a promise-aware caller; stored;
 *                   `.catch`-handled; `.then(success, rejection)`-handled;
 *                   non-promise-typed API call.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanFiles } from '../../../scripts/check-floating-promises';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..');

/** The shared callee module — an async fn imported with a .js suffix, an
 *  interface-typed async method, and a union-returning fn (real shapes the
 *  checker must resolve through, not just a direct local call). */
const CALLEE_SOURCE = `
export async function changeState(): Promise<void> {
	await Promise.resolve();
}

export interface Worker {
	runJob(): Promise<void>;
}

export function makeWorker(): Worker {
	return {
		async runJob() {
			await changeState();
		},
	};
}

export function maybeAsync(flag: boolean): void | Promise<void> {
	if (flag) return changeState();
}
`;

/** The fixture body — each function is one case from the r17 §7 list. */
const FIXTURE_SOURCE = `
import { changeState, makeWorker, maybeAsync } from './callee.js';

function bad(): void {
	changeState(); // MUST REPORT (floating)
}

async function good(): Promise<void> {
	await changeState(); // MUST NOT REPORT
}

function stored(): Promise<void> {
	const pending = changeState(); // MUST NOT REPORT (stored, returned)
	return pending;
}

function handled(): void {
	changeState().catch((err: unknown) => { void err; }); // MUST NOT REPORT
}

function handledTwoArgThen(): void {
	changeState().then(
		() => undefined,
		(err: unknown) => { void err; }, // MUST NOT REPORT (rejection handled)
	);
}

function voidDiscard(): void {
	void changeState(); // MUST REPORT (void_discard category)
}

function ifaceMethod(): void {
	makeWorker().runJob(); // MUST REPORT (floating — typed through the interface)
}

function unionCall(flag: boolean): void {
	maybeAsync(flag); // MUST REPORT (union void | Promise<void> is Promise-like)
}

function storedInMapForLaterAwait(): void {
	const pending = new Map<string, Promise<void>>();
	pending.set('k', changeState()); // MUST NOT REPORT (argument, not statement)
}
`;

describe('floating-promise scanner fixtures (r17 §7)', () => {
	let dir: string;
	let cleanup: () => void;
	let fixturePath: string;
	let calleePath: string;

	beforeEach(() => {
		({ dir, cleanup } = createSafeTestDir('floating-fixtures-'));
		calleePath = path.join(dir, 'callee.ts');
		fixturePath = path.join(dir, 'fixture.ts');
		fs.writeFileSync(calleePath, CALLEE_SOURCE);
		fs.writeFileSync(fixturePath, FIXTURE_SOURCE);
	});

	afterEach(() => {
		cleanup();
	});

	test('classifies every fixture case correctly', async () => {
		const findings = await scanFiles(REPO_ROOT, [fixturePath]);
		const byCategory = {
			floating: findings.filter((f) => f.category === 'floating'),
			void_discard: findings.filter((f) => f.category === 'void_discard'),
		};

		// The four expected floating statements: bad(), ifaceMethod(),
		// unionCall(). (storedInMapForLaterAwait passes the promise as an
		// ARGUMENT — not an expression statement — and must not appear.)
		const floatingLines = byCategory.floating
			.map((f) => f.line)
			.sort((a, b) => a - b);
		expect(floatingLines).toHaveLength(3);
		for (const line of floatingLines) {
			const text = findings
				.filter((f) => f.line === line && f.category === 'floating')
				.map((f) => f.text)
				.join(' ');
			// The three floating cases are exactly the changeState/runJob/
			// maybeAsync bare calls.
			expect(
				text.includes('changeState()') ||
					text.includes('runJob()') ||
					text.includes('maybeAsync(flag)'),
			).toBe(true);
		}

		// Exactly one void_discard.
		expect(byCategory.void_discard).toHaveLength(1);
		expect(byCategory.void_discard[0].text).toContain('void changeState()');

		// The handled shapes never appear anywhere in the findings.
		const allText = findings.map((f) => f.text).join('\n');
		expect(allText).not.toContain('.catch');
		expect(allText).not.toContain('.then');
	}, 120_000);

	test('a large file with many handled shapes stays scannable', async () => {
		// Regression shape for the Biome inference-budget failure mode: a
		// file with thousands of lines where the ONE floating call must still
		// be found (the full checker has no budget).
		const lines: string[] = [
			"import { changeState } from './callee.js';",
			'',
			'export async function pad(n: number): Promise<void> {',
			'\tif (n <= 0) {',
			'\t\tchangeState(); // MUST REPORT (floating, deep in a large file)',
			'\t\treturn;',
			'\t}',
			'\tawait pad(n - 1);',
			'}',
		];
		// ~4000 filler lines of handled awaits.
		for (let i = 0; i < 4000; i++) {
			lines.push(`export async function filler${i}(): Promise<void> { await pad(1); }`);
		}
		const bigPath = path.join(dir, 'big.ts');
		fs.writeFileSync(bigPath, lines.join('\n'));

		const findings = await scanFiles(REPO_ROOT, [bigPath]);
		const floating = findings.filter((f) => f.category === 'floating');
		expect(floating).toHaveLength(1);
		expect(floating[0].text).toContain('changeState()');
	}, 120_000);
});
