import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PhaseGateReport } from '../tools/phase-complete/preflight-report';
import { renameSyncWithRetry } from '../utils/atomic-write';
import { assertProjectRoot } from '../utils/project-boundary';
import { writeImmutableArtifact } from './immutable-store';
import { withEvidenceLock } from './lock';
import {
	canonicalReceiptJson,
	MAX_RECEIPT_GATES,
	MAX_RECEIPT_JSON_BYTES,
	type ReceiptKind,
	receiptContentSignature,
	renderReceiptMarkdown,
	type VerificationReceipt,
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
 * All destinations are explicitly contained under `<root>/.swarm/`; retention
 * matches an exact filename grammar per unit (never a prefix scan) and never
 * deletes outside `.swarm/evidence/receipts/`.
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

/** Fail-open capture of the commit-boundary gate report (never blocks a phase). */
export async function capturePhaseGateReport(
	directory: string,
	report: PhaseGateReport,
): Promise<void> {
	const filePath = path.join(
		receiptsDir(directory),
		`phase-${report.phase}-${report.reportHash}.json`,
	);
	await _internals.writeImmutableArtifact<PhaseGateReport>({
		directory,
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
	});
	await pruneRetention(
		directory,
		reportFileGrammar(report.phase),
		`phase-${report.phase}-${report.reportHash}`,
	);
}

/**
 * Newest-8 retention over an exact filename grammar; never leaves the
 * receipts dir. Each STEM counts once toward the cap and carries both its
 * files: pruning a stem removes its `.json` AND its rendered `.md` sibling
 * (implementation-review F2 — a json-only filter let Markdown siblings grow
 * without bound). Symlinked entries are never counted and never deleted;
 * mtime ties and future mtimes are still prunable (these are our own
 * derived artifacts; a documented divergence from pruneDirectory).
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
		const stat = fs.lstatSync(full);
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
			fs.unlinkSync(target);
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
 * unchanged durable state yields the identical frozen receipt; changed
 * durable state legitimately produces a new content-addressed file.
 */
export async function writeReceiptArtifact(
	directory: string,
	receipt: VerificationReceipt,
): Promise<ReceiptWriteResult> {
	const shorthash = receipt.receipt_hash.slice(0, 12);
	const stem = `receipt-${receipt.kind}-${receipt.unit_id}-${shorthash}`;
	const jsonPath = path.join(receiptsDir(directory), `${stem}.json`);
	const mdPath = path.join(receiptsDir(directory), `${stem}.md`);
	if (
		Buffer.byteLength(canonicalReceiptJson(receipt)) > MAX_RECEIPT_JSON_BYTES
	) {
		throw new Error('RECEIPT_JSON_BYTE_LIMIT');
	}
	return withEvidenceLock(
		directory,
		path.posix.join(
			'evidence',
			'receipts',
			`unit-${receipt.kind}-${receipt.unit_id}.lock`,
		),
		'architect',
		`receipt-${receipt.kind}-${receipt.unit_id}`,
		async () => {
			const signature = receiptContentSignature(receipt);
			for (const name of fs.existsSync(receiptsDir(directory))
				? fs.readdirSync(receiptsDir(directory))
				: []) {
				if (!unitFileGrammar(receipt.kind, receipt.unit_id).test(name))
					continue;
				if (!name.endsWith('.json')) continue;
				const candidatePath = path.join(receiptsDir(directory), name);
				if (candidatePath === jsonPath) continue;
				try {
					const existing = JSON.parse(
						fs.readFileSync(candidatePath, 'utf8'),
					) as VerificationReceipt;
					if (receiptContentSignature(existing) === signature) {
						return {
							receipt: existing,
							jsonPath: candidatePath,
							mdPath: candidatePath.replace(/\.json$/, '.md'),
							alreadyFrozen: true,
						};
					}
				} catch {
					// Unreadable candidate: skip; the fresh write below is authoritative.
				}
			}
			fs.mkdirSync(receiptsDir(directory), { recursive: true });
			await atomicWriteFile(jsonPath, `${canonicalReceiptJson(receipt)}\n`);
			await atomicWriteFile(mdPath, renderReceiptMarkdown(receipt));
			await pruneRetention(
				directory,
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
 * dir at the final path is kept as-is.
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
	const exportRoot = path.join(directory, ...PLAN_EXPORT_SEGMENTS);
	const finalDir = path.join(exportRoot, bundleName);
	if (fs.existsSync(finalDir)) {
		return {
			bundleDir: finalDir,
			receiptPath: path.join(finalDir, 'receipt.json'),
			markdownPath: path.join(finalDir, 'receipt.md'),
			artifactCount: receipt.artifacts.length,
		};
	}
	fs.mkdirSync(exportRoot, { recursive: true });
	const staging = path.join(
		exportRoot,
		`.${bundleName}.tmp-${process.pid}-${Date.now()}`,
	);
	const cleanup = (): void => {
		fs.rmSync(staging, { recursive: true, force: true });
	};
	try {
		if (!isContained(root, staging)) {
			throw new Error('RECEIPT_BUNDLE_PATH_ESCAPE');
		}
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
			const source = path.join(directory, ...artifact.path.split('/'));
			if (
				!isContained(root, source) ||
				!isContained(root, fs.realpathSync(path.dirname(source)))
			) {
				throw new Error(
					`RECEIPT_BUNDLE_ARTIFACT_PATH_ESCAPE: ${artifact.path}`,
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
} = {
	writeImmutableArtifact,
	copyFile: (source, destination) => {
		fs.copyFileSync(source, destination);
		return Promise.resolve();
	},
	sha256: (bytes) =>
		Promise.resolve(createHash('sha256').update(bytes).digest('hex')),
};

export { MAX_RETAINED_PER_UNIT, MAX_RECEIPT_GATES };
