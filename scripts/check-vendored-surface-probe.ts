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
 * not met), 2 usage or infrastructure error (no local TypeScript install).
 *
 * `--self-test` mutates src/host/v2/types.ts (summary: string -> number),
 * expects the gate to FAIL, and restores the file byte-exactly in a finally
 * block (verified by re-reading the backup). The outer bash wrapper (C8) is
 * the second restore layer.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
	exitCode: number;
	stdout: string;
	stderr: string;
}

function runGate(repoRoot: string): GateResult {
	const tscJs = path.join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js');
	if (!existsSync(tscJs)) {
		return {
			exitCode: 2,
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
			stdin: 'ignore',
			encoding: 'utf-8',
			timeout: TSC_TIMEOUT_MS,
			maxBuffer: 16 * 1024 * 1024,
		},
	);
	if (proc.error) {
		return { exitCode: 2, stdout: '', stderr: String(proc.error) };
	}
	return {
		exitCode: proc.status ?? 2,
		stdout: proc.stdout ?? '',
		stderr: proc.stderr ?? '',
	};
}

export function main(
	startDir: string = process.cwd(),
	argv: string[] = process.argv.slice(2),
): number {
	const selfTest = argv.includes('--self-test');
	const repoRoot = resolveRepoRoot(startDir);

	if (selfTest) {
		const typesPath = path.join(repoRoot, TYPES_REL);
		if (!existsSync(typesPath)) {
			console.error(`check-vendored-surface: ${TYPES_REL} not found`);
			return 2;
		}
		const backup = readFileSync(typesPath, 'utf-8');
		const anchor = 'summary: string;';
		if (!backup.includes(anchor)) {
			console.error(
				'check-vendored-surface: self-test anchor "summary: string;" not found in src/host/v2/types.ts — update the self-test',
			);
			return 2;
		}
		try {
			const mutated = backup.replace(anchor, 'summary: number;');
			if (mutated === backup) {
				console.error('check-vendored-surface: self-test mutation was a no-op');
				return 2;
			}
			// Write via tsc-agnostic fs — restored in finally, byte-verified.
			const { writeFileSync } = require('node:fs') as typeof import('node:fs');
			writeFileSync(typesPath, mutated, 'utf-8');
			const result = runGate(repoRoot);
			if (result.exitCode === 0) {
				console.error(
					'check-vendored-surface: self-test FAILED — the gate passed a deliberately broken types.ts (the probe does not bite)',
				);
				return 1;
			}
			console.log(
				`check-vendored-surface: self-test ok — gate failed as expected on the mutated surface (exit ${result.exitCode})`,
			);
			return 0;
		} finally {
			const { writeFileSync } = require('node:fs') as typeof import('node:fs');
			writeFileSync(typesPath, backup, 'utf-8');
			const restored = readFileSync(typesPath, 'utf-8');
			if (restored !== backup) {
				console.error(
					'check-vendored-surface: self-test RESTORE FAILED — types.ts is not byte-identical to its pre-test state',
				);
				return 2;
			}
		}
	}

	const result = runGate(repoRoot);
	if (result.stdout.trim()) console.log(result.stdout.trim());
	if (result.stderr.trim()) console.error(result.stderr.trim());
	if (result.exitCode === 0) {
		console.log(
			`check-vendored-surface: ok — ${PROBE_REL} compiles clean under the pinned local TypeScript`,
		);
		return 0;
	}
	console.error(
		`check-vendored-surface: FAIL — ${PROBE_REL} produced compiler errors (exit ${result.exitCode})`,
	);
	return result.exitCode === 2 ? 2 : 1;
}

if (import.meta.main) {
	process.exit(main());
}
