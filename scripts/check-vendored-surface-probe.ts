/**
 * Vendored-surface type-probe gate (#3756 AC1).
 *
 * Compiles tests/unit/host/v2/vendored-surface-2-3-0.type-probe.ts with the
 * PINNED LOCAL TypeScript (node_modules/typescript — the lockfile resolves
 * 5.9.3) and fails on any compiler error. The probe is deliberately not a
 * .test.ts file (bun's test runner would erase its type errors), and the
 * root tsconfig only includes src/, so nothing else compiles it — this gate
 * is the only automated assignability check on the vendored @opencode/plugin
 * surface.
 *
 * The gate resolves the local tsc via node_modules/typescript/lib/tsc.js run
 * through process.execPath (bun). A GLOBALLY resolved `bunx tsc` is wrong on
 * purpose: outside an install it fetches the latest TypeScript (6.x), which
 * refuses the documented argv with TS5112.
 *
 * Exit codes: 0 pass, 1 violation (compiler errors / self-test expectations
 * not met), 2 usage or infrastructure error (unknown flag, no local
 * TypeScript install, spawn failure).
 *
 * `--self-test` mutates src/host/v2/types.ts (summary: string -> number),
 * expects the gate to FAIL with a compiler violation, and restores the file
 * in a finally block. The backup is written to a temp file first so an
 * in-memory-only restore cannot lose it, the restore is byte-compared
 * (Buffer), and the CI step that invokes it (the quality job) also runs
 * `git checkout -- src/host/v2/types.ts` afterward as a second restore layer.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROBE_REL = 'tests/unit/host/v2/vendored-surface-2-3-0.type-probe.ts';
const TYPES_REL = 'src/host/v2/types.ts';
const TSC_TIMEOUT_MS = 120_000;

function resolveRepoRoot(startDir: string): string {
	let dir = startDir;
	for (;;) {
		if (existsSync(path.join(dir, 'package.json'))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return startDir;
		dir = parent;
	}
}

interface GateResult {
	/** tsc's own exit status, or null when tsc could not be spawned. */
	tscStatus: number | null;
	stdout: string;
	stderr: string;
}

function runGate(repoRoot: string): GateResult {
	const tscJs = path.join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js');
	if (!existsSync(tscJs)) {
		return {
			tscStatus: null,
			stdout: '',
			stderr:
				'check-vendored-surface: local TypeScript not found at node_modules/typescript — run `bun install --frozen-lockfile` first (a globally resolved tsc is wrong on purpose: it fetches TS 6.x and fails TS5112)',
		};
	}
	const proc = spawnSync(
		process.execPath,
		[
			tscJs,
			'--noEmit',
			'--strict',
			'--skipLibCheck',
			'--module',
			'esnext',
			'--moduleResolution',
			'bundler',
			'--target',
			'es2022',
			path.join(repoRoot, PROBE_REL),
		],
		{
			cwd: repoRoot,
			// `stdin: 'ignore'` is NOT a spawnSync option — the correct key is
			// `stdio`. (CI #3882 script-hygiene fix.)
			stdio: ['ignore', 'pipe', 'pipe'],
			encoding: 'utf-8',
			timeout: TSC_TIMEOUT_MS,
			maxBuffer: 16 * 1024 * 1024,
		},
	);
	if (proc.error) {
		return { tscStatus: null, stdout: '', stderr: String(proc.error) };
	}
	return {
		tscStatus: proc.status,
		stdout: proc.stdout ?? '',
		stderr: proc.stderr ?? '',
	};
}

/** A gate outcome classified for the process exit code. */
type GateOutcome = { kind: 'pass' } | { kind: 'violation' } | { kind: 'infra' };

function classify(result: GateResult): GateOutcome {
	if (result.tscStatus === null) return { kind: 'infra' };
	return result.tscStatus === 0 ? { kind: 'pass' } : { kind: 'violation' };
}

export function main(
	startDir: string = process.cwd(),
	argv: string[] = process.argv.slice(2),
): number {
	const unknown = argv.filter((a) => a !== '--self-test');
	if (unknown.length > 0) {
		console.error(
			`check-vendored-surface: unknown flag(s): ${unknown.join(', ')} — only --self-test is accepted`,
		);
		return 2;
	}
	const selfTest = argv.includes('--self-test');
	const repoRoot = resolveRepoRoot(startDir);

	if (selfTest) {
		const typesPath = path.join(repoRoot, TYPES_REL);
		if (!existsSync(typesPath)) {
			console.error(`check-vendored-surface: ${TYPES_REL} not found`);
			return 2;
		}
		const backup = readFileSync(typesPath);
		const anchor = 'summary: string;';
		if (!backup.includes(anchor)) {
			console.error(
				'check-vendored-surface: self-test anchor "summary: string;" not found in src/host/v2/types.ts — update the self-test',
			);
			return 2;
		}
		// Interruption-safe restore: the backup lives on disk (temp file) so a
		// throw between the mutation and the restore cannot lose it, and the
		// restore is byte-compared (Buffer, not UTF-8 string).
		const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'vendored-surface-selftest-'));
		const backupPath = path.join(tmpDir, 'types.ts.bak');
		writeFileSync(backupPath, backup);
		let restoreFailed = false;
		try {
			const mutated = backup.toString('utf-8').replace(anchor, 'summary: number;');
			if (mutated === backup.toString('utf-8')) {
				console.error('check-vendored-surface: self-test mutation was a no-op');
				return 1;
			}
			writeFileSync(typesPath, mutated, 'utf-8');
			const outcome = classify(runGate(repoRoot));
			// Only a real compiler VIOLATION proves the probe bites. An
			// infrastructure failure (missing/timed-out tsc) is NOT evidence the
			// gate works, so it must fail the self-test rather than pass on it.
			if (outcome.kind === 'pass') {
				console.error(
					'check-vendored-surface: self-test FAILED — the gate passed a deliberately broken types.ts (the probe does not bite)',
				);
				return 1;
			}
			if (outcome.kind !== 'violation') {
				console.error(
					`check-vendored-surface: self-test INCONCLUSIVE — the gate did not run to a compiler violation (outcome: ${outcome.kind}); a missing/timed-out tsc must not count as a passing self-test`,
				);
				return 2;
			}
			console.log(
				'check-vendored-surface: self-test ok — gate failed as expected on the mutated surface (violation)',
			);
			return 0;
		} finally {
			// Restore first (always — even if typesPath vanished, re-writing the
			// backup leaves the tracked file correct), byte-verified. Only a
			// verified-restore path removes the on-disk backup; a failed restore
			// keeps it for recovery and reports the failure.
			try {
				writeFileSync(typesPath, backup);
				const restored = readFileSync(typesPath);
				if (!restored.equals(backup)) restoreFailed = true;
			} catch {
				restoreFailed = true;
			}
			if (restoreFailed) {
				console.error(
					'check-vendored-surface: self-test RESTORE FAILED — types.ts is not byte-identical to its pre-test state; the temp backup survives at ' +
						backupPath,
				);
			} else {
				try {
					rmSync(tmpDir, { recursive: true, force: true });
				} catch {
					// best-effort temp cleanup
				}
			}
			if (restoreFailed) return 2;
		}
	}

	const result = runGate(repoRoot);
	if (result.stdout.trim()) console.log(result.stdout.trim());
	if (result.stderr.trim()) console.error(result.stderr.trim());
	const outcome = classify(result);
	if (outcome.kind === 'pass') {
		console.log(
			`check-vendored-surface: ok — ${PROBE_REL} compiles clean under the pinned local TypeScript`,
		);
		return 0;
	}
	if (outcome.kind === 'infra') {
		console.error(
			`check-vendored-surface: INFRA — ${result.stderr.trim() || 'tsc could not be run'}`,
		);
		return 2;
	}
	console.error(`check-vendored-surface: FAIL — ${PROBE_REL} produced compiler errors`);
	return 1;
}

if (import.meta.main) {
	process.exit(main());
}
