import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PhaseGateEntry } from '../tools/phase-complete/preflight-report';
import { stableReportHash } from '../tools/phase-complete/preflight-report';
import { toPortableRelativePath } from '../tools/phase-complete/snapshot-identity';
import {
	computeReceiptHash,
	MAX_RECEIPT_ARTIFACT_BYTES,
	MAX_RECEIPT_ARTIFACTS,
	MAX_RECEIPT_GATES,
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
 * Path normalization and canonical hashing are shared with emission BY
 * IMPORT (`computeReceiptHash` / canonical serialization from `receipt.ts`;
 * every path comparison here goes through the SAME
 * `toPortableRelativePath` normalizer from `snapshot-identity.ts` that
 * produces artifact paths at emission), so emission and verification cannot
 * drift apart (#2970 design step 5 / review FB-010).
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

	const schemaResult = (() => {
		try {
			return VerificationReceiptSchema.safeParse(parsed);
		} catch {
			// FB-006: hostile nesting can make even the schema pass recurse
			// unboundedly; a thrown error is a typed failure, never an
			// uncaught RangeError escaping the documented taxonomy.
			return null;
		}
	})();
	if (!schemaResult || !schemaResult.success) {
		return fail('schema_mismatch', { path: input.receiptFile });
	}
	// FB-006 (review PRR-009): the emitter's structural bounds must be
	// enforced HERE too — a foreign receipt under the 1 MiB read cap
	// otherwise names thousands of artifacts and forces unbounded
	// synchronous hashing on the verify path.
	if (
		schemaResult.data.artifacts.length > MAX_RECEIPT_ARTIFACTS ||
		schemaResult.data.gates.length > MAX_RECEIPT_GATES
	) {
		return fail('schema_mismatch', { path: input.receiptFile });
	}
	let claimedBytesTotal = 0;
	for (const artifact of schemaResult.data.artifacts) {
		claimedBytesTotal += artifact.bytes;
		if (claimedBytesTotal > MAX_RECEIPT_ARTIFACT_BYTES) {
			return fail('schema_mismatch', { path: input.receiptFile });
		}
	}

	// Receipt hash covers the RAW parsed object (minus itself) — never a
	// schema-stripped value — so unknown added fields flip this check.
	const { receipt_hash: recordedHashRaw, ...rest } = record;
	const recordedHash = recordedHashRaw as string;
	let recomputedHash: string;
	try {
		recomputedHash = computeReceiptHash(rest);
	} catch {
		// FB-006: deep unknown-field nesting overflows the canonicalizer —
		// typed failure, not an escaping RangeError.
		return fail('corrupt_json', { path: input.receiptFile });
	}
	if (recomputedHash !== recordedHash) {
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
	// FB-006: the root realpath is a syscall that can throw (vanishing tree)
	// — resolve it ONCE, fail-closed, instead of an uncaught error escaping
	// the taxonomy mid-loop.
	let rootResolved: string;
	try {
		rootResolved = fs.realpathSync(input.artifactRoot);
	} catch {
		return fail('missing_artifact', { path: input.artifactRoot });
	}
	if (!rootResolved) {
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
		// R2-F1 (implementation review round 2): derive the candidate from the
		// REALPATHED root. Resolving against the lexical artifactRoot made
		// every bundle reached through a symlinked path prefix (macOS /tmp →
		// /private/tmp, junctioned scratch dirs) fail the lexical containment
		// check against the realpathed root. Symlinked ANCESTORS of the bundle
		// are legitimate; only links INSIDE the bundle may escape, and the
		// component walk + leaf realpath below catch those. Product decision
		// (review round 3, question): the artifact ROOT itself is one of the
		// two caller-supplied verify roots; reaching it through a symlinked
		// path is the caller's route to the bundle (macOS /tmp, junctioned
		// scratch dirs) and stays LEGAL — only links strictly INSIDE the two
		// roots can escape.
		// FB-010 (#2970 step 5): the containment comparison goes through the
		// SAME portable-path normalizer that produces artifact paths at
		// emission, so the two sides cannot drift.
		const resolved = path.resolve(rootResolved, ...segments);
		const relative = toPortableRelativePath(rootResolved, resolved);
		if (
			relative === '' ||
			relative === '.' ||
			relative === '..' ||
			relative.startsWith('../') ||
			path.isAbsolute(relative)
		) {
			failures.push({ kind: 'path_escape', path: artifact.path });
			continue;
		}
		// F1 (implementation review): a symlink/junction at a PARENT component
		// is invisible to lstat on the leaf. Walk every component under the
		// real bundle root and reject symbolic links at any level, then require
		// the fully-resolved real path to stay inside the root — the verifier
		// must never read outside the two roots it was given. Anything MISSING
		// on the chain (final or intermediate) is an incomplete bundle →
		// missing_artifact (CS-003: it is not evidence of tampering); only a
		// symlink anywhere on the chain is a path escape.
		let cursor = rootResolved;
		let parentEscape = false;
		let leafMissing = false;
		for (let index = 0; index < segments.length; index += 1) {
			cursor = path.join(cursor, segments[index]);
			let componentStat: fs.Stats;
			try {
				componentStat = fs.lstatSync(cursor);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === 'ENOENT' || code === 'ENOTDIR') {
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
				const realRelative = toPortableRelativePath(rootResolved, realResolved);
				if (
					realRelative === '' ||
					realRelative === '.' ||
					realRelative === '..' ||
					realRelative.startsWith('../') ||
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
		} catch {
			failures.push({ kind: 'missing_artifact', path: artifact.path });
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
		// PRR-009 companion: reject a size that disagrees with the claim
		// BEFORE reading — combined with the pre-loop aggregate bound this
		// caps total verify-side IO at the emitted budget.
		if (
			stat.size !== artifact.bytes ||
			stat.size > MAX_RECEIPT_ARTIFACT_BYTES
		) {
			failures.push({
				kind: 'digest_mismatch',
				path: artifact.path,
				expected: `${artifact.bytes} bytes`,
				actual: `${stat.size} bytes`,
			});
			continue;
		}
		let bytes: Buffer;
		// PRR-002 (review round 2 batch): pin the exact inode that passed the
		// walk — open once with O_NOFOLLOW (where available) and fstat-verify
		// identity + stability around the read, mirroring the emitter's
		// hashReceiptArtifact, so a concurrent in-bundle swap cannot redirect
		// or resize the bytes that get hashed.
		let descriptor: number | null = null;
		try {
			descriptor = fs.openSync(
				resolved,
				fs.constants.O_RDONLY |
					((fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0),
			);
			const opened = fs.fstatSync(descriptor);
			if (
				!opened.isFile() ||
				opened.dev !== stat.dev ||
				opened.ino !== stat.ino ||
				opened.size !== stat.size
			) {
				failures.push({ kind: 'path_escape', path: artifact.path });
				continue;
			}
			bytes = fs.readFileSync(descriptor);
			const after = fs.fstatSync(descriptor);
			if (
				after.size !== opened.size ||
				after.mtimeMs !== opened.mtimeMs ||
				after.ctimeMs !== opened.ctimeMs
			) {
				failures.push({
					kind: 'digest_mismatch',
					path: artifact.path,
					actual: 'concurrent-mutation',
				});
				continue;
			}
		} catch {
			failures.push({ kind: 'missing_artifact', path: artifact.path });
			continue;
		} finally {
			if (descriptor !== null) fs.closeSync(descriptor);
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
			continue;
		}
		// FB-004 (swarm-pr-review PRR-005): the bundled phase gate report is
		// RE-DERIVED, not trusted — entries edited under a stale reportHash
		// (the lazy not_applicable→pass laundering path) fail here exactly as
		// they fail at build time.
		const reportMatch = artifact.path.match(
			/^\.swarm\/evidence\/receipts\/phase-(\d+)-([0-9a-f]{64})\.json$/,
		);
		if (reportMatch && schemaResult.data.report_hash) {
			let derived: string | null = null;
			try {
				const stored = JSON.parse(bytes.toString('utf8')) as {
					phase?: number;
					entries?: unknown;
					reportHash?: string;
				};
				if (
					typeof stored.phase === 'number' &&
					Array.isArray(stored.entries) &&
					typeof stored.reportHash === 'string' &&
					stored.reportHash === reportMatch[2] &&
					reportMatch[2] === schemaResult.data.report_hash
				) {
					derived = stableReportHash(
						stored.phase,
						stored.entries as PhaseGateEntry[],
					);
				}
			} catch {
				derived = null;
			}
			if (derived !== schemaResult.data.report_hash) {
				failures.push({
					kind: 'digest_mismatch',
					path: artifact.path,
					expected: schemaResult.data.report_hash,
					actual: derived ?? 'un-derivable',
				});
			}
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
	const lines = result.failures.map((failure) => {
		const details: string[] = [];
		if (failure.expected !== undefined)
			details.push(`expected ${failure.expected}`);
		if (failure.actual !== undefined) details.push(`actual ${failure.actual}`);
		return `- ${failure.kind}${failure.path ? `: ${failure.path}` : ''}${
			details.length > 0 ? ` (${details.join(', ')})` : ''
		}`;
	});
	return `receipt verify FAILED: ${bundle}\n${lines.join('\n')}`;
}

/** Shared classifier: the command's exit-code mapping and the tool's ok field agree by construction. */
export function isReceiptVerifyOk(result: ReceiptVerifyResult): boolean {
	return result.ok;
}
