import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { type BunCompatSubprocess, bunSpawn } from '../utils/bun-compat';
import { resolveGitExecutable } from '../utils/git-executable.js';

interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}
export const _internals = { bunSpawn, resolveGitExecutable };
const OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

async function git(directory: string, args: string[]): Promise<GitResult> {
	let proc: BunCompatSubprocess | undefined;
	try {
		proc = _internals.bunSpawn([_internals.resolveGitExecutable(), ...args], {
			cwd: directory,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 10000,
			maxBuffer: 65536,
			env: { ...process.env, LC_ALL: 'C' },
		});
		if (proc.spawnError) throw proc.spawnError;
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			proc.stdout.text(),
			proc.stderr.text(),
		]);
		if (proc.spawnError) throw proc.spawnError;
		return { exitCode, stdout, stderr };
	} finally {
		try {
			proc?.kill();
		} catch {
			// Best-effort reap: an already exited Git child may reject kill.
		}
	}
}
function requireOid(oid: string): void {
	if (!OID.test(oid))
		throw new Error('CODER_SETTLEMENT_SOURCE_UNCERTAIN: malformed source OID');
}
export async function probeSettlementSource(
	directory: string,
	oid: string,
): Promise<'present' | 'absent'> {
	requireOid(oid);
	const result = await git(directory, [
		'rev-parse',
		'--verify',
		'--quiet',
		`${oid}^{commit}`,
	]);
	if (result.exitCode === 0 && result.stdout.trim() === oid) return 'present';
	if (result.exitCode === 1 && !result.stderr.trim() && !result.stdout.trim()) {
		// Git can report a quiet missing revision even when GIT_OBJECT_DIRECTORY
		// points to an unreadable or non-directory location. Absence requires a
		// usable object database, not merely the quiet revision exit status.
		const objects = await git(directory, [
			'rev-parse',
			'--git-path',
			'objects',
		]);
		if (
			objects.exitCode !== 0 ||
			!objects.stdout.trim() ||
			!(
				await stat(path.resolve(directory, objects.stdout.trim()))
			).isDirectory()
		) {
			throw new Error(
				`CODER_SETTLEMENT_SOURCE_UNCERTAIN: object database unavailable for ${oid}`,
			);
		}
		const health = await git(directory, ['count-objects', '-v']);
		if (health.exitCode !== 0 || health.stderr.trim())
			throw new Error(
				`CODER_SETTLEMENT_SOURCE_UNCERTAIN: object database unreadable for ${oid}`,
			);
		return 'absent';
	}
	throw new Error(
		`CODER_SETTLEMENT_SOURCE_UNCERTAIN: ${oid}: ${result.stderr.trim() || 'Git object probe failed'}`,
	);
}
export function settlementBackupRef(oid: string): string {
	requireOid(oid);
	return `refs/swarm/coder-settlements/${oid}`;
}
async function readDirectRef(
	directory: string,
	ref: string,
): Promise<string | null> {
	const symbolic = await git(directory, ['symbolic-ref', '-q', ref]);
	if (symbolic.exitCode !== 1)
		throw new Error(
			`CODER_SETTLEMENT_REF_UNCERTAIN: symbolic or unreadable ref ${ref}`,
		);
	const result = await git(directory, [
		'rev-parse',
		'--verify',
		'--quiet',
		ref,
	]);
	if (result.exitCode === 0 && OID.test(result.stdout.trim()))
		return result.stdout.trim();
	if (result.exitCode === 1 && !result.stderr.trim() && !result.stdout.trim())
		return null;
	throw new Error(`CODER_SETTLEMENT_REF_UNCERTAIN: ${ref}`);
}

async function createExactRef(
	directory: string,
	ref: string,
	oid: string,
): Promise<boolean> {
	requireOid(oid);
	const current = await readDirectRef(directory, ref);
	if (current === oid) return false;
	if (current !== null)
		throw new Error(`RECOVERABLE_ORPHAN_COMMIT: ${oid}; occupied ref ${ref}`);
	const result = await git(directory, [
		'update-ref',
		'--no-deref',
		ref,
		oid,
		'0'.repeat(oid.length),
	]);
	// Even successful CAS is re-read: a symbolic or foreign racing winner is never accepted.
	if ((await readDirectRef(directory, ref)) !== oid)
		throw new Error(
			`RECOVERABLE_ORPHAN_COMMIT: ${oid}; cannot preserve ${ref}: ${result.stderr.trim()}`,
		);
	return true;
}
export async function preserveSettlementSource(
	directory: string,
	oid: string,
): Promise<string> {
	const ref = settlementBackupRef(oid);
	await createExactRef(directory, ref, oid);
	return ref;
}
export async function restoreSettlementBranch(
	directory: string,
	branch: string,
	oid: string,
): Promise<boolean> {
	const ref = `refs/heads/${branch}`;
	const valid = await git(directory, ['check-ref-format', ref]);
	if (valid.exitCode !== 0)
		throw new Error('CODER_SETTLEMENT_REF_UNCERTAIN: malformed lane branch');
	return createExactRef(directory, ref, oid);
}
export async function releaseSettlementSource(
	directory: string,
	oid: string,
): Promise<void> {
	const ref = settlementBackupRef(oid);
	const current = await readDirectRef(directory, ref);
	if (current === null) return;
	if (current !== oid)
		throw new Error(`CODER_SETTLEMENT_REF_UNCERTAIN: occupied backup ${ref}`);
	await git(directory, ['update-ref', '--no-deref', '-d', ref, oid]);
	if ((await readDirectRef(directory, ref)) !== null)
		throw new Error(`CODER_SETTLEMENT_REF_UNCERTAIN: cannot release ${ref}`);
}
export async function validateSettlementLane(
	directory: string,
	branchName: string,
	expectedHead: string,
): Promise<void> {
	requireOid(expectedHead);
	if (
		(await git(directory, ['check-ref-format', `refs/heads/${branchName}`]))
			.exitCode !== 0
	)
		throw new Error(
			'CODER_SETTLEMENT_DISPATCH_ARTIFACT_CHANGED: invalid branch',
		);
	const [branch, head] = await Promise.all([
		git(directory, ['symbolic-ref', '--short', 'HEAD']),
		git(directory, ['rev-parse', '--verify', 'HEAD']),
	]);
	if (
		branch.exitCode !== 0 ||
		branch.stdout.trim() !== branchName ||
		head.exitCode !== 0 ||
		head.stdout.trim() !== expectedHead
	)
		throw new Error(
			'CODER_SETTLEMENT_DISPATCH_ARTIFACT_CHANGED: lane branch or HEAD changed',
		);
}
