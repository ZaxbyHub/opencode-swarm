import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PhaseGateReport } from '../tools/phase-complete/preflight-report';
import { renameSyncWithRetry } from '../utils/atomic-write';
import { assertProjectRoot } from '../utils/project-boundary';
import { writeImmutableArtifact } from './immutable-store';
import { withEvidenceLock } from './lock';
import {
	assertNoSymlinkComponents,
	canonicalReceiptJson,
	computeReceiptHash,
	MAX_RECEIPT_ARTIFACT_BYTES,
	MAX_RECEIPT_GATES,
	MAX_RECEIPT_JSON_BYTES,
	type ReceiptKind,
	receiptContentSignature,
	renderReceiptMarkdown,
	type VerificationReceipt,
	VerificationReceiptSchema,
} from './receipt';
import { atomicWriteFile } from './task-file';

/**
 * Durable receipt persistence (#2968). Three artifacts:
 *
 * - captured phase gate reports at `.swarm/evidence/receipts/phase-<N>-<reportHash>.json`
 *   (content-addressed write-once, written at the commit boundary, fail-open
 *   to phase completion — the capture is not a gate);
 * - emitted receipts `receipt-<kind>-<id>-<shorthash>.json` (+ rendered `.md`
 *   sibling) with per-unit serialized idempotent writes and newest-8 retention;
 * - self-contained export bundles under `.swarm/plan-export/receipt-<kind>-<id>-<shorthash>/`
 *   (staged, digest-verified, atomically published).
 *
 * All destinations are explicitly contained under `<root>/.swarm/`: every
 * write target's component chain is walked against the REAL root and any
 * symbolic link/junction on it is refused (FB-001) — the model that can
 * write `.swarm` state can plant links, and this feature's threat model
 * names the model as the adversary. Paths handed back to callers are built
 * from the realpath'd root (FB-002), so symlinked/junctioned project roots
 * succeed rather than false-rejecting. Retention matches an exact filename
 * grammar per unit (never a prefix scan) and never deletes outside
 * `.swarm/evidence/receipts/`.
 */

const RECEIPTS_DIR_SEGMENTS = ['.swarm', 'evidence', 'receipts'];
const PLAN_EXPORT_SEGMENTS = ['.swarm', 'plan-export'];
const MAX_RETAINED_PER_UNIT = 8;

function escapeForRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unitFileGrammar(kind: ReceiptKind, unitId: string): RegExp {
	return new RegExp(
		`^receipt-${kind}-${escapeForRegex(unitId)}-[0-9a-f]{12}\\.(json|md)$`,
	);
}

function reportFileGrammar(phase: number): RegExp {
	return new RegExp(`^phase-${phase}-[0-9a-f]{64}\\.json$`);
}

function receiptsDir(directory: string): string {
	return path.join(directory, ...RECEIPTS_DIR_SEGMENTS);
}

/** FB-001: reject a planted link anywhere on a write destination's chain. */
function assertContainedWriteTarget(root: string, destination: string): void {
	assertNoSymlinkComponents(
		root,
		destination,
		(offender) => new Error(`RECEIPT_WRITE_PATH_ESCAPE: ${offender}`),
	);
}

/**
 * Windows-safe removal: transient EBUSY/EPERM handles (AV/indexer, the class
 * `renameSyncWithRetry` and `tests/helpers/tmpdir.ts` both document) must not
 * mask the ORIGINAL export failure, and must not strand staging residue where
 * no reaper reaches (FB-015b/PRR-018). Retries; never throws.
 */
function removeTreeQuietly(target: string): void {
	try {
		fs.rmSync(target, {
			recursive: true,
			force: true,
			maxRetries: 4,
			retryDelay: 25,
		});
	} catch {
		// Residue is reaped by the close plan-export stage (FB-003); never
		// let cleanup replace the real failure.
	}
}

/** Fail-open capture of the commit-boundary gate report (never blocks a phase). */
export async function capturePhaseGateReport(
	directory: string,
	report: PhaseGateReport,
): Promise<void> {
	const root = fs.realpathSync(directory);
	const filePath = path.join(
		receiptsDir(root),
		`phase-${report.phase}-${report.reportHash}.json`,
	);
	// FB-001: the capture is a write destination like any other.
	assertContainedWriteTarget(root, filePath);
	await _internals.writeImmutableArtifact<PhaseGateReport>({
		directory: root,
		relativeLockPath: path.posix.join(
			'evidence',
			'receipts',
			`phase-${report.phase}-${report.reportHash.slice(0, 12)}.lock`,
		),
		filePath,
		agent: 'architect',
		taskId: `phase-${report.phase}`,
		value: report,
		serialize: (value) => JSON.stringify(value, null, 2),
		parse: (raw) => raw as PhaseGateReport,
		conflictError: (conflict) =>
			new Error(
				`RECEIPT_CAPTURE_CONFLICT: ${conflict.kind} ${conflict.filePath}`,
			),
		// PRR-019: the capture runs while the plan lock is held; a contended
		// evidence lock must not stall phase_complete for the 60 s default.
		lockTimeoutMs: 10_000,
		// FB-001 (review round 2): re-run the destination-chain walk INSIDE the
		// lock (writeImmutableArtifact invokes this before mkdir/write), so a
		// junction planted during the lock wait cannot redirect the capture.
		validateDestination: () => assertContainedWriteTarget(root, filePath),
	});
	await pruneRetention(
		root,
		reportFileGrammar(report.phase),
		`phase-${report.phase}-${report.reportHash}`,
	);
}

/**
 * Newest-8 retention over an exact filename grammar; never leaves the
 * receipts dir. Each STEM counts once toward the cap and carries both its
 * files: pruning a stem removes its `.json` AND its rendered `.md` sibling
 * (implementation-review F2 — a json-only filter let Markdown siblings grow
 * without bound). Survivor IDENTITY is pinned by tests (FB-012): the OLDEST
 * stems are evicted, the freshest are kept. Symlinked entries are never
 * counted and never deleted; mtime ties and future mtimes are still prunable
 * (these are our own derived artifacts; a documented divergence from
 * pruneDirectory). Entries that vanish mid-enumeration are skipped, not
 * fatal (FB-009: a concurrent close/prune must not abort emission).
 */
async function pruneRetention(
	directory: string,
	grammar: RegExp,
	justWrittenStem: string,
): Promise<void> {
	const dir = receiptsDir(directory);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return;
	}
	interface Stem {
		stem: string;
		mtime: number;
		files: string[];
	}
	const stems = new Map<string, Stem>();
	for (const name of names) {
		if (!grammar.test(name)) continue;
		const stem = name.replace(/\.(json|md)$/, '');
		// Exclude the just-written STEM entirely (both its files): the +1 in
		// the excess arithmetic below accounts for it, and its .md sibling
		// must not re-add it to the candidate set (off-by-one, review F2).
		if (stem === justWrittenStem) continue;
		const full = path.join(dir, name);
		let stat: fs.Stats;
		try {
			stat = _internals.pruneLstat(full);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ENOTDIR') {
				continue; // vanished mid-enumeration (FB-009)
			}
			throw error;
		}
		if (!stat.isFile()) continue;
		const entry = stems.get(stem) ?? { stem, mtime: 0, files: [] };
		entry.files.push(full);
		entry.mtime = Math.max(entry.mtime, stat.mtimeMs);
		stems.set(stem, entry);
	}
	const ordered = [...stems.values()].sort((left, right) =>
		right.mtime === left.mtime
			? right.stem.localeCompare(left.stem)
			: right.mtime - left.mtime,
	);
	const excess = ordered.length + 1 - MAX_RETAINED_PER_UNIT;
	for (let index = 0; index < excess; index += 1) {
		const stem = ordered[ordered.length - 1 - index];
		for (const target of stem.files) {
			if (!target.startsWith(dir + path.sep)) {
				throw new Error(`RECEIPT_RETENTION_ESCAPE: ${target}`);
			}
			try {
				fs.unlinkSync(target);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
				// raced away between readdir and unlink (FB-009) — skip it.
			}
		}
	}
}

export interface ReceiptWriteResult {
	receipt: VerificationReceipt;
	jsonPath: string;
	mdPath: string;
	alreadyFrozen: boolean;
}

/**
 * Per-unit serialized write-once emission. If an existing receipt for the
 * same unit has an identical content signature (everything except
 * `generated_at`/`receipt_hash`), it is returned verbatim — re-emitting
 * unchanged durable state within the same plugin version yields the
 * identical frozen receipt (plugin_version is part of the frozen content,
 * so a version bump legitimately produces a new content-addressed file);
 * changed durable state likewise produces a new file. An adopted candidate
 * is RE-VALIDATED (schema + recorded hash) and its rendered `.md` sibling
 * is healed when missing before it is handed back (FB-005 — a JSON-only
 * orphan from an interrupted write must never be reported as complete).
 */
export async function writeReceiptArtifact(
	directory: string,
	receipt: VerificationReceipt,
): Promise<ReceiptWriteResult> {
	const root = fs.realpathSync(directory);
	const shorthash = receipt.receipt_hash.slice(0, 12);
	const stem = `receipt-${receipt.kind}-${receipt.unit_id}-${shorthash}`;
	const jsonPath = path.join(receiptsDir(root), `${stem}.json`);
	const mdPath = path.join(receiptsDir(root), `${stem}.md`);
	const jsonPayload = `${canonicalReceiptJson(receipt)}\n`;
	// FB-018: the persisted file includes the trailing newline — measure the
	// exact payload that will land on disk.
	if (Buffer.byteLength(jsonPayload, 'utf8') > MAX_RECEIPT_JSON_BYTES) {
		throw new Error('RECEIPT_JSON_BYTE_LIMIT');
	}
	// FB-001: validate destinations BEFORE any mkdir/write; component chains
	// must be link-free from the real root down.
	assertContainedWriteTarget(root, jsonPath);
	assertContainedWriteTarget(root, mdPath);
	return withEvidenceLock(
		root,
		path.posix.join(
			'evidence',
			'receipts',
			`unit-${receipt.kind}-${receipt.unit_id}.lock`,
		),
		'architect',
		`receipt-${receipt.kind}-${receipt.unit_id}`,
		async () => {
			// FB-001 (review round 2): the pre-lock walk is invalidated by the
			// await boundary of lock acquisition — re-validate both destination
			// chains as the FIRST statement inside the critical section, so a
			// junction planted while this writer waited for the unit lock is
			// rejected before mkdir/heal/write touches it.
			assertContainedWriteTarget(root, jsonPath);
			assertContainedWriteTarget(root, mdPath);
			const signature = receiptContentSignature(receipt);
			for (const name of fs.existsSync(receiptsDir(root))
				? fs.readdirSync(receiptsDir(root))
				: []) {
				if (!unitFileGrammar(receipt.kind, receipt.unit_id).test(name))
					continue;
				if (!name.endsWith('.json')) continue;
				const candidatePath = path.join(receiptsDir(root), name);
				if (candidatePath === jsonPath) continue;
				try {
					const parsed = JSON.parse(
						fs.readFileSync(candidatePath, 'utf8'),
					) as unknown;
					// FB-005: adopt only a candidate that is a VALID receipt
					// whose recorded hash re-derives over its own content —
					// the idempotency signature deliberately excludes
					// `receipt_hash`, so without this a tampered-hash file
					// would be handed back as frozen and copied verbatim
					// into export bundles that then fail `--verify`.
					const validated = VerificationReceiptSchema.safeParse(parsed);
					if (!validated.success) continue;
					const existing = validated.data;
					const { receipt_hash: recorded, ...rest } = parsed as Record<
						string,
						unknown
					>;
					if (
						typeof recorded !== 'string' ||
						computeReceiptHash(rest) !== recorded
					) {
						continue;
					}
					if (receiptContentSignature(existing) !== signature) continue;
					const adoptedMdPath = candidatePath.replace(/\.json$/, '.md');
					const rendered = renderReceiptMarkdown(existing);
					let mdMatches = false;
					try {
						mdMatches =
							fs.lstatSync(adoptedMdPath).isFile() &&
							fs.readFileSync(adoptedMdPath, 'utf8') === rendered;
					} catch {
						mdMatches = false;
					}
					if (!mdMatches) {
						// Heal the rendered sibling (FB-005 / posted R1-M2:
						// "exists and matches the receipt") — covers both the
						// missing orphan AND a drifted sibling, so adoption never
						// returns an md_path whose content disagrees with the
						// frozen JSON. The validator runs same-tick with the
						// write (FB-001 round 3) — the heal awaits, so the chain
						// must be re-proven immediately before the syscall.
						await atomicWriteFile(adoptedMdPath, rendered, () =>
							assertContainedWriteTarget(root, adoptedMdPath),
						);
					}
					return {
						receipt: existing,
						jsonPath: candidatePath,
						mdPath: adoptedMdPath,
						alreadyFrozen: true,
					};
				} catch {
					// Unreadable candidate: skip; the fresh write below is authoritative.
				}
			}
			fs.mkdirSync(receiptsDir(root), { recursive: true });
			// FB-005 ordering: Markdown FIRST, JSON as the commit marker — a
			// crash between the two leaves an orphaned `.md` (invisible to the
			// signature scan) instead of a JSON that later masquerades as a
			// complete pair. FB-001 (round 3): each write re-proves the chain
			// same-tick with its own syscall (the awaited writer yields), so a
			// junction planted mid-loop cannot redirect bytes outside the root.
			await atomicWriteFile(mdPath, renderReceiptMarkdown(receipt), () =>
				assertContainedWriteTarget(root, mdPath),
			);
			await atomicWriteFile(jsonPath, jsonPayload, () =>
				assertContainedWriteTarget(root, jsonPath),
			);
			await pruneRetention(
				root,
				unitFileGrammar(receipt.kind, receipt.unit_id),
				stem,
			);
			return { receipt, jsonPath, mdPath, alreadyFrozen: false };
		},
	);
}

export interface ReceiptBundleResult {
	bundleDir: string;
	receiptPath: string;
	markdownPath: string;
	artifactCount: number;
}

function isContained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === '' ||
		(relative !== '..' &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
}

/**
 * Self-contained export bundle: `receipt.json` + `receipt.md` + byte-copies
 * of every cited artifact under `artifacts/<portable-path>`. Written to a
 * staging directory and atomically renamed into place; a copy whose digest
 * does not match the recorded sha256 fails with full staging cleanup (a
 * partial bundle must never look attachable). Idempotent: an existing bundle
 * dir at the final path is kept as-is. Every destination and every source
 * chain is link-validated against the REAL root (FB-001/FB-002), and each
 * source is size-gated BEFORE copying (FB-017: a source that grew since
 * emission is rejected without being buffered whole).
 */
export async function writeExportBundle(
	directory: string,
	receipt: VerificationReceipt,
	markdown: string,
): Promise<ReceiptBundleResult> {
	assertProjectRoot(directory);
	const root = fs.realpathSync(directory);
	const shorthash = receipt.receipt_hash.slice(0, 12);
	const bundleName = `receipt-${receipt.kind}-${receipt.unit_id}-${shorthash}`;
	// FB-002: build every path from the realpath'd root, never the lexical
	// argument, so containment comparisons share one canonical base.
	const exportRoot = path.join(root, ...PLAN_EXPORT_SEGMENTS);
	const finalDir = path.join(exportRoot, bundleName);
	assertContainedWriteTarget(root, exportRoot);
	assertContainedWriteTarget(root, finalDir);
	if (fs.existsSync(finalDir)) {
		return {
			bundleDir: finalDir,
			receiptPath: path.join(finalDir, 'receipt.json'),
			markdownPath: path.join(finalDir, 'receipt.md'),
			artifactCount: receipt.artifacts.length,
		};
	}
	const staging = path.join(
		exportRoot,
		`.${bundleName}.tmp-${process.pid}-${Date.now()}`,
	);
	const cleanup = (): void => {
		removeTreeQuietly(staging);
	};
	try {
		if (!isContained(root, staging)) {
			throw new Error('RECEIPT_BUNDLE_PATH_ESCAPE');
		}
		assertContainedWriteTarget(root, staging);
		fs.mkdirSync(path.join(staging, 'artifacts'), { recursive: true });
		fs.writeFileSync(
			path.join(staging, 'receipt.json'),
			`${canonicalReceiptJson(receipt)}\n`,
		);
		fs.writeFileSync(path.join(staging, 'receipt.md'), markdown);
		for (const artifact of receipt.artifacts) {
			if (
				artifact.path === '' ||
				artifact.path === '.' ||
				artifact.path.startsWith('/') ||
				/^[A-Za-z]:[\\/]/.test(artifact.path) ||
				artifact.path.startsWith('\\\\') ||
				artifact.path.split('/').includes('..')
			) {
				throw new Error(
					`RECEIPT_BUNDLE_ARTIFACT_PATH_ESCAPE: ${artifact.path}`,
				);
			}
			const source = path.join(root, ...artifact.path.split('/'));
			if (
				!isContained(root, source) ||
				!isContained(root, fs.realpathSync(path.dirname(source)))
			) {
				throw new Error(
					`RECEIPT_BUNDLE_ARTIFACT_PATH_ESCAPE: ${artifact.path}`,
				);
			}
			// FB-001 (source side, too): links anywhere on the source chain
			// redirect the copied bytes away from the cited object.
			assertNoSymlinkComponents(
				root,
				source,
				(offender) =>
					new Error(`RECEIPT_BUNDLE_ARTIFACT_PATH_ESCAPE: ${offender}`),
			);
			// FB-017: size-gate BEFORE copying/buffering — a source grown
			// since emission must be rejected, not copied whole and rejected
			// afterwards.
			let sourceStat: fs.Stats;
			try {
				sourceStat = fs.lstatSync(source);
			} catch {
				throw new Error(`RECEIPT_BUNDLE_ARTIFACT_MISSING: ${artifact.path}`);
			}
			if (
				!sourceStat.isFile() ||
				sourceStat.size > MAX_RECEIPT_ARTIFACT_BYTES ||
				sourceStat.size !== artifact.bytes
			) {
				throw new Error(
					`RECEIPT_BUNDLE_DIGEST_MISMATCH: ${artifact.path} (size ${sourceStat.size} != recorded ${artifact.bytes})`,
				);
			}
			const destination = path.join(
				staging,
				'artifacts',
				...artifact.path.split('/'),
			);
			if (!isContained(staging, destination)) {
				throw new Error(
					`RECEIPT_BUNDLE_ARTIFACT_PATH_ESCAPE: ${artifact.path}`,
				);
			}
			fs.mkdirSync(path.dirname(destination), { recursive: true });
			await _internals.copyFile(source, destination);
			const copied = fs.readFileSync(destination);
			const digest = await _internals.sha256(copied);
			if (digest !== artifact.sha256) {
				throw new Error(
					`RECEIPT_BUNDLE_DIGEST_MISMATCH: ${artifact.path} ${digest}`,
				);
			}
		}
		try {
			// FB-001 (review round 2): the copy loop awaits per artifact, so a
			// junction can be planted under exportRoot/finalDir mid-loop.
			// Re-validate the publication chain immediately before the atomic
			// rename, so publication can never land through a planted link.
			assertContainedWriteTarget(root, exportRoot);
			assertContainedWriteTarget(root, finalDir);
			assertContainedWriteTarget(root, staging);
			renameSyncWithRetry(staging, finalDir);
		} catch (renameError) {
			// R2-F3 (implementation review round 2): a concurrent export of
			// the SAME receipt can win the rename; the loser's rename then
			// fails over the just-published identical bundle. That race is
			// idempotent by design — return the published bundle instead of
			// throwing. R3-F1 (round 3): the loser's staging dir must still be
			// cleaned (an early return here skips the outer catch's cleanup).
			if (fs.existsSync(finalDir)) {
				cleanup();
				return {
					bundleDir: finalDir,
					receiptPath: path.join(finalDir, 'receipt.json'),
					markdownPath: path.join(finalDir, 'receipt.md'),
					artifactCount: receipt.artifacts.length,
				};
			}
			throw renameError;
		}
	} catch (error) {
		cleanup();
		throw error;
	}
	return {
		bundleDir: finalDir,
		receiptPath: path.join(finalDir, 'receipt.json'),
		markdownPath: path.join(finalDir, 'receipt.md'),
		artifactCount: receipt.artifacts.length,
	};
}

/** DI seam for tests (fail-open capture, copy-failure, digest checks). */
export const _internals: {
	writeImmutableArtifact: typeof writeImmutableArtifact;
	copyFile: (source: string, destination: string) => Promise<void>;
	sha256: (bytes: Buffer) => Promise<string>;
	pruneLstat: (target: string) => fs.Stats;
} = {
	writeImmutableArtifact,
	pruneLstat: (target) => fs.lstatSync(target),
	copyFile: (source, destination) => {
		fs.copyFileSync(source, destination);
		return Promise.resolve();
	},
	sha256: (bytes) =>
		Promise.resolve(createHash('sha256').update(bytes).digest('hex')),
};

export { MAX_RETAINED_PER_UNIT, MAX_RECEIPT_GATES };
