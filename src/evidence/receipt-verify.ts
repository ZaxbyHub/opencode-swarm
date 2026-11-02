import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	computeReceiptHash,
	RECEIPT_FORMAT_VERSION,
	VerificationReceiptSchema,
} from './receipt';

/**
 * Fresh-clone receipt verification (#2970, Workstream J slot J23).
 *
 * `verifyReceiptBundle` is a PURE function of exactly two roots — the
 * receipt file and the bundle's `artifacts/` directory. It reads no
 * `.swarm/` state, no config, no plan, takes no locks, performs ZERO
 * filesystem writes, and launches no child processes. That purity is what
 * makes an exported bundle PR-attachable: any reviewer with a fresh clone
 * can re-check every hash with nothing but the bundle.
 *
 * Path normalization is shared with emission BY IMPORT
 * (`computeReceiptHash` / canonical serialization from `receipt.ts`, whose
 * artifact paths are produced by the snapshot-identity normalizer), so
 * emission and verification cannot drift apart.
 *
 * Invariant-3 conditional (AGENTS.md): if verification is EVER extended to
 * re-execute cited commands, every child-process invocation must follow the
 * full bounded-subprocess contract — array-form invocation, explicit working
 * directory, closed stdin, a timeout, bounded-or-ignored output streams, and
 * a best-effort termination in a `finally` block. Re-execution also changes
 * the trust story (results become machine-dependent) and needs its own
 * issue; it is deliberately absent here.
 */

export type ReceiptVerifyFailureKind =
	| 'corrupt_json'
	| 'unsupported_format_version'
	| 'schema_mismatch'
	| 'receipt_hash_mismatch'
	| 'missing_artifact'
	| 'digest_mismatch'
	| 'path_escape';

export interface ReceiptVerifyFailure {
	kind: ReceiptVerifyFailureKind;
	path?: string;
	expected?: string;
	actual?: string;
}

export interface ReceiptVerifyResult {
	ok: boolean;
	checked: { artifacts: number; receiptHash: boolean };
	failures: ReceiptVerifyFailure[];
}

const MAX_VERIFY_RECEIPT_BYTES = 1024 * 1024;
const MAX_VERIFY_ARTIFACT_BYTES = 16 * 1024 * 1024;

export interface ReceiptVerifyInput {
	/** Absolute path to the bundle's receipt.json. */
	receiptFile: string;
	/** Absolute path to the bundle's artifacts/ directory. */
	artifactRoot: string;
}

function fail(
	kind: ReceiptVerifyFailureKind,
	extra?: Partial<ReceiptVerifyFailure>,
): ReceiptVerifyResult {
	return {
		ok: false,
		checked: { artifacts: 0, receiptHash: false },
		failures: [{ kind, ...extra }],
	};
}

/**
 * Verify a receipt bundle: parse → format gate → schema gate → receipt-hash
 * recheck → per-artifact re-hash, fail-closed at every step with a typed
 * failure. Result carries digests and counts only — never artifact content.
 */
export function verifyReceiptBundle(
	input: ReceiptVerifyInput,
): ReceiptVerifyResult {
	let rawText: string;
	try {
		const stat = fs.lstatSync(input.receiptFile);
		if (!stat.isFile()) {
			return fail('corrupt_json', { path: input.receiptFile });
		}
		if (stat.size > MAX_VERIFY_RECEIPT_BYTES) {
			return fail('schema_mismatch', { path: input.receiptFile });
		}
		rawText = fs.readFileSync(input.receiptFile, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EACCES') {
			return fail('corrupt_json', { path: input.receiptFile });
		}
		return fail('missing_artifact', { path: input.receiptFile });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText);
	} catch {
		return fail('corrupt_json', { path: input.receiptFile });
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return fail('corrupt_json', { path: input.receiptFile });
	}

	const record = parsed as Record<string, unknown>;
	if (record.format_version !== RECEIPT_FORMAT_VERSION) {
		return fail('unsupported_format_version', {
			path: input.receiptFile,
			actual:
				typeof record.format_version === 'string'
					? record.format_version
					: String(record.format_version),
		});
	}

	const schemaResult = VerificationReceiptSchema.safeParse(parsed);
	if (!schemaResult.success) {
		return fail('schema_mismatch', { path: input.receiptFile });
	}

	// Receipt hash covers the RAW parsed object (minus itself) — never a
	// schema-stripped value — so unknown added fields flip this check.
	const { receipt_hash: recordedHashRaw, ...rest } = record;
	const recordedHash = recordedHashRaw as string;
	if (computeReceiptHash(rest) !== recordedHash) {
		return fail('receipt_hash_mismatch', {
			path: input.receiptFile,
			expected: recordedHash,
		});
	}

	let artifactsChecked = 0;
	const failures: ReceiptVerifyFailure[] = [];
	const artifacts = schemaResult.data.artifacts;
	let artifactRootStat: fs.Stats | null = null;
	try {
		artifactRootStat = fs.statSync(input.artifactRoot);
	} catch {
		// handled per-artifact below as missing
	}
	if (!artifactRootStat?.isDirectory() && artifacts.length > 0) {
		return fail('missing_artifact', { path: input.artifactRoot });
	}
	for (const artifact of artifacts) {
		const segments = artifact.path.split('/');
		if (
			artifact.path === '' ||
			artifact.path === '.' ||
			artifact.path.startsWith('/') ||
			/^[A-Za-z]:[\\/]/.test(artifact.path) ||
			artifact.path.startsWith('\\\\') ||
			artifact.path.includes('\\') ||
			segments.includes('..') ||
			segments.includes('.')
		) {
			failures.push({ kind: 'path_escape', path: artifact.path });
			continue;
		}
		const resolved = path.resolve(input.artifactRoot, ...segments);
		const rootResolved = fs.realpathSync(input.artifactRoot);
		const relative = path.relative(rootResolved, resolved);
		if (
			relative === '' ||
			relative === '..' ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
		) {
			failures.push({ kind: 'path_escape', path: artifact.path });
			continue;
		}
		// F1 (implementation review): a symlink/junction at a PARENT component
		// is invisible to lstat on the leaf. Walk every component under the
		// real bundle root and reject symbolic links at any level, then require
		// the fully-resolved real path to stay inside the root — the verifier
		// must never read outside the two roots it was given. A missing FINAL
		// component is a missing ARTIFACT, not an escape; a missing/symlinked
		// INTERMEDIATE directory is an escape.
		let cursor = rootResolved;
		let parentEscape = false;
		let leafMissing = false;
		for (let index = 0; index < segments.length; index += 1) {
			cursor = path.join(cursor, segments[index]);
			let componentStat: fs.Stats;
			try {
				componentStat = fs.lstatSync(cursor);
			} catch {
				if (index === segments.length - 1) {
					leafMissing = true;
				} else {
					parentEscape = true;
				}
				break;
			}
			if (componentStat.isSymbolicLink()) {
				parentEscape = true;
				break;
			}
		}
		if (leafMissing) {
			failures.push({ kind: 'missing_artifact', path: artifact.path });
			continue;
		}
		if (!parentEscape) {
			try {
				const realResolved = fs.realpathSync(resolved);
				const realRelative = path.relative(rootResolved, realResolved);
				if (
					realRelative === '' ||
					realRelative === '..' ||
					realRelative.startsWith(`..${path.sep}`) ||
					path.isAbsolute(realRelative)
				) {
					parentEscape = true;
				}
			} catch {
				parentEscape = true;
			}
		}
		if (parentEscape) {
			failures.push({ kind: 'path_escape', path: artifact.path });
			continue;
		}
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(resolved);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EACCES') {
				failures.push({ kind: 'missing_artifact', path: artifact.path });
			} else {
				failures.push({ kind: 'missing_artifact', path: artifact.path });
			}
			continue;
		}
		if (stat.isSymbolicLink()) {
			failures.push({ kind: 'path_escape', path: artifact.path });
			continue;
		}
		if (!stat.isFile()) {
			failures.push({ kind: 'missing_artifact', path: artifact.path });
			continue;
		}
		if (stat.size > MAX_VERIFY_ARTIFACT_BYTES) {
			failures.push({ kind: 'digest_mismatch', path: artifact.path });
			continue;
		}
		let bytes: Buffer;
		try {
			bytes = fs.readFileSync(resolved);
		} catch {
			failures.push({ kind: 'missing_artifact', path: artifact.path });
			continue;
		}
		const actual = createHash('sha256').update(bytes).digest('hex');
		artifactsChecked += 1;
		if (actual !== artifact.sha256 || bytes.byteLength !== artifact.bytes) {
			failures.push({
				kind: 'digest_mismatch',
				path: artifact.path,
				expected: artifact.sha256,
				actual,
			});
		}
	}

	return {
		ok: failures.length === 0,
		checked: { artifacts: artifactsChecked, receiptHash: true },
		failures,
	};
}

/** Bounded human/agent summary of a verify result (digests and counts only). */
export function formatReceiptVerifySummary(
	bundle: string,
	result: ReceiptVerifyResult,
): string {
	if (result.ok) {
		return `receipt verify OK: ${bundle} (format ${RECEIPT_FORMAT_VERSION}, ${result.checked.artifacts} artifacts, receipt hash verified)`;
	}
	const lines = result.failures.map(
		(failure) =>
			`- ${failure.kind}${failure.path ? `: ${failure.path}` : ''}${
				failure.expected ? ` (expected ${failure.expected}` : ''
			}${failure.actual ? `, actual ${failure.actual})` : failure.expected ? ')' : ''}`,
	);
	return `receipt verify FAILED: ${bundle}\n${lines.join('\n')}`;
}

/** Shared classifier: the command's exit-code mapping and the tool's ok field agree by construction. */
export function isReceiptVerifyOk(result: ReceiptVerifyResult): boolean {
	return result.ok;
}
