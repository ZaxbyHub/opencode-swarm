import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	resolveExecutableFromPath,
	runExternalTool,
} from '../utils/external-tool-runner.js';

const GIT_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const WORKTREE_PARENT = 'opencode-swarm-evaluation';

export type WorkingTreeFingerprint = {
	head: string;
	porcelainHash: string;
};

export type DisposableWorktree = {
	path: string;
	baseSha: string;
};

export class DisposableWorktreeCleanupError extends Error {
	readonly code = 'evaluation-worktree-cleanup-failed';

	constructor(
		readonly worktreePath: string,
		readonly pathPresent: boolean,
		readonly registrationPresent: boolean | undefined,
		readonly cleanupErrors: string[],
	) {
		super(
			`Evaluation worktree cleanup could not be verified for ${worktreePath} ` +
				`(pathPresent=${pathPresent}, registrationPresent=${String(registrationPresent)})`,
		);
		this.name = 'DisposableWorktreeCleanupError';
	}
}

async function git(
	projectRoot: string,
	args: string[],
	abortSignal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
	const executable = _internals.resolveExecutableFromPath(['git']);
	if (!executable) throw new Error('git executable not found');
	const result = await _internals.runExternalTool({
		executable,
		args: ['-C', projectRoot, ...args],
		cwd: projectRoot,
		timeoutMs: GIT_TIMEOUT_MS,
		maxStdoutBytes: MAX_GIT_OUTPUT_BYTES,
		maxStderrBytes: MAX_GIT_OUTPUT_BYTES,
		abortSignal,
	});
	if (result.status !== 'completed' || result.exitCode !== 0) {
		throw new Error(
			`git ${args[0] ?? ''} failed: ${result.message ?? result.stderr.trim() ?? result.status}`,
		);
	}
	return { stdout: result.stdout, stderr: result.stderr };
}

export async function captureWorkingTreeFingerprint(
	projectRoot: string,
	abortSignal?: AbortSignal,
): Promise<WorkingTreeFingerprint> {
	const canonicalRoot = fs.realpathSync(projectRoot);
	const head = await git(canonicalRoot, ['rev-parse', 'HEAD'], abortSignal);
	const porcelain = await git(
		canonicalRoot,
		[
			'status',
			'--porcelain=v1',
			'-z',
			'--untracked-files=all',
			'--',
			'.',
			':(exclude).swarm/**',
		],
		abortSignal,
	);
	return {
		head: head.stdout.trim(),
		porcelainHash: crypto
			.createHash('sha256')
			.update(porcelain.stdout)
			.digest('hex'),
	};
}

export async function createDisposableWorktree(
	projectRoot: string,
	baseRef: string,
	abortSignal?: AbortSignal,
): Promise<DisposableWorktree> {
	const canonicalRoot = fs.realpathSync(projectRoot);
	if (!/^[A-Fa-f0-9]{40,64}$/.test(baseRef)) {
		throw new Error('Evaluation baseRef must be a full commit hash');
	}
	const parent = path.join(_internals.tmpdir(), WORKTREE_PARENT);
	fs.mkdirSync(parent, { recursive: true });
	const canonicalParent = fs.realpathSync(parent);
	const worktreePath = path.join(canonicalParent, crypto.randomUUID());
	await git(
		canonicalRoot,
		['worktree', 'add', '--detach', worktreePath, baseRef],
		abortSignal,
	);
	return { path: fs.realpathSync(worktreePath), baseSha: baseRef };
}

export async function removeDisposableWorktree(
	projectRoot: string,
	worktreePath: string,
): Promise<void> {
	const canonicalRoot = fs.realpathSync(projectRoot);
	const expectedParent = fs.realpathSync(
		path.join(_internals.tmpdir(), WORKTREE_PARENT),
	);
	const resolved = path.resolve(worktreePath);
	const relative = path.relative(expectedParent, resolved);
	if (
		!relative ||
		relative === '..' ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new Error(
			'Refusing to remove a worktree outside the evaluation root',
		);
	}
	const cleanupErrors: string[] = [];
	try {
		await git(canonicalRoot, ['worktree', 'remove', '--force', resolved]);
	} catch (error) {
		cleanupErrors.push(
			`git-remove: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		_internals.rmSync(resolved, { recursive: true, force: true });
	} catch (error) {
		cleanupErrors.push(
			`filesystem-remove: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		await git(canonicalRoot, ['worktree', 'prune', '--expire', 'now']);
	} catch (error) {
		cleanupErrors.push(
			`git-prune: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const pathPresent = _internals.existsSync(resolved);
	let registrationPresent: boolean | undefined;
	try {
		const listed = await git(canonicalRoot, [
			'worktree',
			'list',
			'--porcelain',
			'-z',
		]);
		const normalizedTarget = normalizeWorktreePath(resolved);
		registrationPresent = listed.stdout
			.split('\0')
			.filter((field) => field.startsWith('worktree '))
			.some(
				(field) =>
					normalizeWorktreePath(field.slice('worktree '.length)) ===
					normalizedTarget,
			);
	} catch (error) {
		cleanupErrors.push(
			`git-list: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (pathPresent || registrationPresent !== false) {
		throw new DisposableWorktreeCleanupError(
			resolved,
			pathPresent,
			registrationPresent,
			cleanupErrors,
		);
	}
}

function normalizeWorktreePath(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export async function withDisposableWorktree<T>(args: {
	projectRoot: string;
	baseRef: string;
	abortSignal?: AbortSignal;
	run: (worktree: DisposableWorktree) => Promise<T>;
}): Promise<T> {
	const before = await _internals.captureWorkingTreeFingerprint(
		args.projectRoot,
		args.abortSignal,
	);
	let worktree: DisposableWorktree | undefined;
	try {
		worktree = await _internals.createDisposableWorktree(
			args.projectRoot,
			args.baseRef,
			args.abortSignal,
		);
		return await args.run(worktree);
	} finally {
		let cleanupFailure: unknown;
		if (worktree) {
			try {
				await _internals.removeDisposableWorktree(
					args.projectRoot,
					worktree.path,
				);
			} catch (error) {
				cleanupFailure = error;
			}
		}
		const after = await _internals.captureWorkingTreeFingerprint(
			args.projectRoot,
		);
		if (
			before.head !== after.head ||
			before.porcelainHash !== after.porcelainHash
		) {
			// biome-ignore lint/correctness/noUnsafeFinally: active-tree integrity must override a successful isolated callback.
			throw new Error('Evaluation changed the active working tree');
		}
		if (cleanupFailure) {
			// biome-ignore lint/correctness/noUnsafeFinally: cleanup failure must override a successful isolated callback.
			throw cleanupFailure;
		}
	}
}

export const _internals: {
	runExternalTool: typeof runExternalTool;
	resolveExecutableFromPath: typeof resolveExecutableFromPath;
	tmpdir: typeof os.tmpdir;
	rmSync: typeof fs.rmSync;
	existsSync: typeof fs.existsSync;
	captureWorkingTreeFingerprint: typeof captureWorkingTreeFingerprint;
	createDisposableWorktree: typeof createDisposableWorktree;
	removeDisposableWorktree: typeof removeDisposableWorktree;
} = {
	runExternalTool,
	resolveExecutableFromPath,
	tmpdir: os.tmpdir,
	rmSync: fs.rmSync,
	existsSync: fs.existsSync,
	captureWorkingTreeFingerprint,
	createDisposableWorktree,
	removeDisposableWorktree,
};
