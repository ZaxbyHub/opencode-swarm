#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

const REQUIRED_PACKAGE_FILES = [
	'dist/index.js',
	'dist/index.d.ts',
	'dist/cli/index.js',
	'README.md',
	'LICENSE',
	'package.json',
];

const FORBIDDEN_PACKAGE_PREFIXES = [
	'.github/',
	'.swarm/',
	'src/',
	'tests/unit/',
	'tests/integration/',
	'tests/smoke/',
	'tests/security/',
	'tests/adversarial/',
];

function npmInvocation(args) {
	if (process.platform !== 'win32') {
		return { command: 'npm', args };
	}

	const nodeDir = path.dirname(process.execPath);
	const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
	return {
		command: process.execPath,
		args: [npmCli, ...args],
	};
}

function normalizePackagePath(filePath) {
	return String(filePath).replace(/\\/g, '/').replace(/^package\//, '');
}

function runCommand(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
		encoding: 'utf8',
		timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		maxBuffer: MAX_BUFFER_BYTES,
		windowsHide: true,
	});

	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		const stdout = (result.stdout ?? '').trim();
		const stderr = (result.stderr ?? '').trim();
		throw new Error(
			[
				`Command failed: ${command} ${args.join(' ')}`,
				`exit code: ${result.status}`,
				stdout ? `stdout:\n${stdout}` : '',
				stderr ? `stderr:\n${stderr}` : '',
			]
				.filter(Boolean)
				.join('\n'),
		);
	}

	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	};
}

export async function listExpectedGrammarFiles(root = ROOT) {
	const grammarDir = path.join(root, 'src', 'lang', 'grammars');
	const files = await readdir(grammarDir);
	return files
		.filter((file) => file.endsWith('.wasm'))
		.sort()
		.map((file) => `dist/lang/grammars/${file}`);
}

export function validatePackageFiles(files, expectedGrammarFiles) {
	const paths = new Set(files.map((file) => normalizePackagePath(file.path ?? file)));
	const errors = [];

	for (const required of REQUIRED_PACKAGE_FILES) {
		if (!paths.has(required)) {
			errors.push(`missing required package file: ${required}`);
		}
	}

	for (const grammar of expectedGrammarFiles) {
		if (!paths.has(grammar)) {
			errors.push(`missing grammar asset: ${grammar}`);
		}
	}

	for (const packagePath of paths) {
		for (const prefix of FORBIDDEN_PACKAGE_PREFIXES) {
			if (packagePath.startsWith(prefix)) {
				errors.push(`unexpected source-only package file: ${packagePath}`);
			}
		}
	}

	return {
		ok: errors.length === 0,
		errors,
		paths,
	};
}

function parsePackOutput(stdout) {
	let parsed;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		throw new Error(
			`Failed to parse npm pack --json output: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	if (!Array.isArray(parsed) || parsed.length !== 1) {
		throw new Error('npm pack --json did not return exactly one package entry');
	}
	return parsed[0];
}

async function main() {
	const packDir = mkdtempSync(path.join(tmpdir(), 'opencode-swarm-pack-'));
	const installDir = mkdtempSync(path.join(tmpdir(), 'opencode-swarm-install-'));

	try {
		const pack = npmInvocation([
			'pack',
			'--json',
			'--pack-destination',
			packDir,
		]);
		const packResult = runCommand(pack.command, pack.args);
		const packEntry = parsePackOutput(packResult.stdout);
		const expectedGrammarFiles = await listExpectedGrammarFiles(ROOT);
		const validation = validatePackageFiles(
			packEntry.files ?? [],
			expectedGrammarFiles,
		);

		if (!validation.ok) {
			throw new Error(
				`Package file validation failed:\n${validation.errors.join('\n')}`,
			);
		}

		const tarball = path.resolve(packDir, packEntry.filename);
		writeFileSync(
			path.join(installDir, 'package.json'),
			JSON.stringify({ type: 'module', private: true }, null, 2),
		);

		const install = npmInvocation([
			'install',
			'--ignore-scripts',
			'--no-audit',
			'--no-fund',
			tarball,
		]);
		runCommand(install.command, install.args, { cwd: installDir });

		runCommand(process.execPath, [
			'--input-type=module',
			'--eval',
			[
				"const mod = await import('opencode-swarm');",
				"if (!mod.default || mod.default.id !== 'opencode-swarm') throw new Error('bad plugin id');",
				"if (typeof mod.default.server !== 'function') throw new Error('missing server function');",
				"console.log('installed package import OK');",
			].join(' '),
		], { cwd: installDir });

		runCommand('bun', [
			path.join(
				installDir,
				'node_modules',
				'opencode-swarm',
				'dist',
				'cli',
				'index.js',
			),
			'--help',
		], { cwd: installDir });

		console.log(
			`package smoke OK: ${packEntry.filename} (${packEntry.files.length} files)`,
		);
	} finally {
		rmSync(packDir, { recursive: true, force: true });
		rmSync(installDir, { recursive: true, force: true });
	}
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (currentFile === invokedFile) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
