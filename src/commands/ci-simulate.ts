import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type ExternalToolRunResult,
	runExternalTool,
} from '../utils/external-tool-runner';

const DEFAULT_BASE = 'origin/main';
const DEFAULT_HEAD = 'HEAD';
const DEFAULT_CI_COMMANDS = [
	['bun', 'run', 'typecheck'],
	['bun', 'run', 'lint:ci'],
	['bun', 'run', 'build'],
	['bun', 'run', 'test:unit:ci'],
	['bun', 'test', 'tests/integration', '--timeout', '120000'],
	['bun', 'test', 'tests/security', '--timeout', '120000'],
	['bun', 'test', 'tests/smoke', '--timeout', '120000'],
	['bun', 'run', 'drift:check'],
];
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_TIMEOUT_MS = 60 * 1000;
const OUTPUT_LIMIT = 12_000;

type RunResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
	stdoutTruncated?: boolean;
	stderrTruncated?: boolean;
};

async function runCommand(
	cmd: string[],
	cwd: string,
	timeout: number,
): Promise<RunResult> {
	const [executable, ...args] = cmd;
	const result: ExternalToolRunResult = await runExternalTool({
		executable,
		args,
		cwd,
		timeoutMs: timeout,
		maxStdoutBytes: OUTPUT_LIMIT,
		maxStderrBytes: OUTPUT_LIMIT,
	});
	return {
		exitCode: result.exitCode ?? 1,
		stdout: result.message
			? [result.message, result.stdout].filter(Boolean).join('\n')
			: result.stdout,
		stderr: result.stderr,
		stdoutTruncated: result.stdoutTruncated,
		stderrTruncated: result.stderrTruncated,
	};
}

function readOptionalFlag(args: string[], name: string): string | null {
	const index = args.indexOf(name);
	if (index < 0) return null;
	const value = args[index + 1];
	return value && !value.startsWith('--') ? value : null;
}

function readFlag(args: string[], name: string, fallback: string): string {
	return readOptionalFlag(args, name) ?? fallback;
}

function hasUnsupportedArgs(args: string[]): string | null {
	const allowedWithValue = new Set(['--base', '--head']);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg.startsWith('--')) return `unexpected positional argument ${arg}`;
		if (!allowedWithValue.has(arg)) return arg;
		const value = args[i + 1];
		if (!value || value.startsWith('--')) return `missing value for ${arg}`;
		i++;
	}
	return null;
}

export const _internals = {
	runCommand,
	now: () => Date.now(),
	mkdirSync: fs.mkdirSync,
};

function formatResult(prefix: string, result: RunResult): string {
	const output = [result.stdout.trim(), result.stderr.trim()]
		.filter(Boolean)
		.join('\n');
	const suffix =
		result.stdoutTruncated || result.stderrTruncated
			? '\n\n[output truncated to bounded limit]'
			: '';
	return output ? `${prefix}\n\n${output}${suffix}` : `${prefix}${suffix}`;
}

export async function handleCiSimulateCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const unsupportedArg = hasUnsupportedArgs(args);
	if (unsupportedArg) {
		const reason = unsupportedArg.startsWith('--')
			? `unsupported argument ${unsupportedArg}`
			: unsupportedArg;
		return `CI simulation failed: ${reason}. Supported arguments: --base <ref> --head <ref>.`;
	}
	const base = readFlag(args, '--base', DEFAULT_BASE);
	const headFlag = readOptionalFlag(args, '--head');
	const ciCommands = DEFAULT_CI_COMMANDS;
	let head = headFlag ?? DEFAULT_HEAD;
	if (!headFlag) {
		const currentHead = await _internals.runCommand(
			['git', '-C', directory, 'rev-parse', 'HEAD'],
			directory,
			GIT_TIMEOUT_MS,
		);
		if (currentHead.exitCode !== 0) {
			return formatResult(
				'CI simulation failed: could not resolve the current worktree HEAD.',
				currentHead,
			);
		}
		head = currentHead.stdout.trim();
	}
	const worktreeBase = path.join(directory, '.swarm', 'ci-simulate');
	const worktreePath = path.join(
		worktreeBase,
		`merge-${_internals.now()}-${Math.random().toString(36).slice(2)}`,
	);
	_internals.mkdirSync(worktreeBase, { recursive: true });

	let cleanupError: string | undefined;
	let createdWorktree = false;
	let response: string | undefined;
	try {
		const add = await _internals.runCommand(
			[
				'git',
				'-C',
				directory,
				'worktree',
				'add',
				'--detach',
				worktreePath,
				base,
			],
			directory,
			GIT_TIMEOUT_MS,
		);
		if (add.exitCode !== 0) {
			response = formatResult(
				`CI simulation failed: could not create temp worktree from ${base}.`,
				add,
			);
		} else {
			createdWorktree = true;

			const merge = await _internals.runCommand(
				['git', '-C', worktreePath, 'merge', '--no-edit', head],
				worktreePath,
				GIT_TIMEOUT_MS,
			);
			if (merge.exitCode !== 0) {
				response = formatResult(
					`CI simulation failed: ${head} does not merge cleanly into ${base}.`,
					merge,
				);
			} else {
				for (const ciCommand of ciCommands) {
					const ci = await _internals.runCommand(
						ciCommand,
						worktreePath,
						COMMAND_TIMEOUT_MS,
					);
					if (ci.exitCode !== 0) {
						response = formatResult(
							`CI simulation failed after merging ${head} into ${base}: ${ciCommand.join(' ')}`,
							ci,
						);
						break;
					}
				}
				response ??= `CI simulation passed after merging ${head} into ${base}: ${ciCommands.map((cmd) => cmd.join(' ')).join(' && ')}`;
			}
		}
	} finally {
		if (createdWorktree) {
			const remove = await _internals.runCommand(
				['git', '-C', directory, 'worktree', 'remove', '--force', worktreePath],
				directory,
				GIT_TIMEOUT_MS,
			);
			if (remove.exitCode !== 0) {
				cleanupError = remove.stderr.trim() || remove.stdout.trim();
			}
		}
		await _internals.runCommand(
			['git', '-C', directory, 'worktree', 'prune'],
			directory,
			GIT_TIMEOUT_MS,
		);
	}
	if (cleanupError) {
		const cleanupMessage = `CI simulation cleanup failed: ${cleanupError}`;
		return response ? `${response}\n\n${cleanupMessage}` : cleanupMessage;
	}
	return response ?? 'CI simulation failed: no result was produced.';
}
