import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import packageJson from '../../package.json' with { type: 'json' };
import type { EvidenceBundle } from '../config/evidence-schema';
import { readTaskEvidence } from '../gate-evidence';
import type { PhaseGateEntry } from '../tools/phase-complete/preflight-report';
import { stableReportHash } from '../tools/phase-complete/preflight-report';
import { toPortableRelativePath } from '../tools/phase-complete/snapshot-identity';
import {
	deriveDurableTaskGate,
	deriveTaskEvidenceSynthesis,
} from './gate-outcome';
import { loadEvidence } from './manager';

/**
 * Verification receipts (#2968, Workstream J slot J22).
 *
 * A receipt is a portable, hash-backed record of the durably recorded gate
 * outcomes for a task or phase: bounded gate records, the snapshot hashes the
 * gates were evaluated against, and content-hashed artifact refs. A gate that
 * ran without a durable record is absent (nothing is reconstructed). Task-arm
 * gate outcomes are derived from the durable entry via the shared
 * gate-outcome helper (#3560): verdict-bearing records reflect their recorded
 * verdict (REJECT never renders pass), presence-only records attest
 * pass-on-presence honestly by producer contract, and the empty-gates
 * synthesis is not_applicable unless durable read-only-settlement proof
 * exists. Receipts
 * provide integrity AGAINST THE MODEL for lazy falsification (an agent cannot
 * edit persisted gate state under an unchanged digest and claim a gate passed —
 * report digests are RE-DERIVED from stored bytes at build time and from
 * the bundled copy at verify time, FB-004); a forger willing to recompute
 * every digest consistently needs an out-of-band capture-time anchor, which
 * is out of scope here, and a determined local actor is out of scope by
 * design (see the release notes' limitations).
 *
 * Field names here are the frozen #2970 contract — `format_version`,
 * `receipt_hash`, `artifacts[].path/sha256/bytes`,
 * `snapshot.{plan_structure, policy, phase_evidence}`, `gates[].output_digest`
 * must not be renamed. `receipt_hash` is always computed over the RAW
 * JSON-parsed object minus itself (never a schema-stripped value), so an
 * unknown added field flips verification to `receipt_hash_mismatch` instead
 * of being silently dropped.
 */

export const RECEIPT_FORMAT_VERSION = '1.0.0';

export const MAX_RECEIPT_ARTIFACTS = 512;
export const MAX_RECEIPT_GATES = 64;
export const MAX_RECEIPT_JSON_BYTES = 256 * 1024;
export const MAX_RECEIPT_ARTIFACT_BYTES = 16 * 1024 * 1024;

export const ReceiptArtifactRefSchema = z.object({
	path: z.string().min(1),
	sha256: z.string().length(64),
	bytes: z.number().int().nonnegative(),
});

export const ReceiptGateRecordSchema = z.object({
	gate_id: z.string().min(1),
	outcome: z.enum(['pass', 'block', 'error', 'not_applicable']),
	code: z.string().optional(),
	responsible_actor: z.string(),
	evidence_refs: z.array(z.string()),
	/** Present ONLY when a durable producer recorded them (truthfulness rule). */
	command: z.string().optional(),
	exit_code: z.number().int().optional(),
	output_digest: z.string().optional(),
	detail_digest: z.string().optional(),
});

export const VerificationReceiptSchema = z.object({
	format_version: z.literal(RECEIPT_FORMAT_VERSION),
	kind: z.enum(['phase', 'task']),
	unit_id: z.string().min(1),
	generated_at: z.string().datetime(),
	plugin_version: z.string(),
	snapshot: z.object({
		plan_structure: z.string().optional(),
		policy: z.string().optional(),
		phase_evidence: z.string().optional(),
	}),
	gates: z.array(ReceiptGateRecordSchema),
	artifacts: z.array(ReceiptArtifactRefSchema),
	report_hash: z.string().optional(),
	receipt_hash: z.string().length(64),
});

export type ReceiptArtifactRef = z.infer<typeof ReceiptArtifactRefSchema>;
export type ReceiptGateRecord = z.infer<typeof ReceiptGateRecordSchema>;
export type VerificationReceipt = z.infer<typeof VerificationReceiptSchema>;
export type ReceiptKind = VerificationReceipt['kind'];

/** Canonical serialization: recursively sorted keys, no whitespace, UTF-8. */
export function canonicalReceiptJson(value: unknown): string {
	const normalize = (input: unknown): unknown => {
		if (Array.isArray(input)) return input.map(normalize);
		if (input !== null && typeof input === 'object') {
			const record = input as Record<string, unknown>;
			const sorted: Record<string, unknown> = {};
			for (const key of Object.keys(record).sort()) {
				sorted[key] = normalize(record[key]);
			}
			return sorted;
		}
		return input;
	};
	return JSON.stringify(normalize(value));
}

/** sha256 over the canonical form of `value` (caller excludes receipt_hash). */
export function computeReceiptHash(value: unknown): string {
	return createHash('sha256').update(canonicalReceiptJson(value)).digest('hex');
}

/** Structural bounds enforced before any receipt write (AC4, test-enforced). */
export function ensureReceiptBounds(receipt: {
	gates: unknown[];
	artifacts: unknown[];
}): void {
	if (receipt.gates.length > MAX_RECEIPT_GATES) {
		throw new Error(`RECEIPT_GATE_LIMIT: ${receipt.gates.length}`);
	}
	if (receipt.artifacts.length > MAX_RECEIPT_ARTIFACTS) {
		throw new Error(`RECEIPT_ARTIFACT_LIMIT: ${receipt.artifacts.length}`);
	}
	const encoded = canonicalReceiptJson(receipt);
	if (Buffer.byteLength(encoded, 'utf8') > MAX_RECEIPT_JSON_BYTES) {
		throw new Error('RECEIPT_JSON_BYTE_LIMIT');
	}
}

const UNIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidReceiptUnitId(kind: ReceiptKind, id: string): boolean {
	if (!UNIT_ID_PATTERN.test(id)) return false;
	if (kind === 'phase') return /^\d+$/.test(id);
	return true;
}

interface HashedArtifact {
	ref: ReceiptArtifactRef;
	absolutePath: string;
}

/**
 * Walk every component from the REAL project root down to `absolute` (which
 * must be built from that same real root) and reject symbolic links at any
 * level. Missing trailing components are OK (callers create them next);
 * everything that exists on the chain must not be a link. This is the
 * write-side mirror of the read-side symlink rejections (#2968 review
 * FB-001/PRR-004): `assertSwarmContainedTarget` is documented as scoped to
 * the CONTAINED canonical writer's local-process threat model, while the
 * receipt feature names the MODEL as its adversary — and the model plants
 * links with same-user power — so both link classes (symlink, junction)
 * must be rejected on receipt-family write destinations and artifact
 * sources alike.
 */
export function assertNoSymlinkComponents(
	root: string,
	absolute: string,
	makeError: (offender: string) => Error,
): void {
	const relative = path.relative(root, absolute);
	if (
		relative === '' ||
		relative === '..' ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw makeError(absolute);
	}
	let cursor = root;
	for (const segment of relative.split(path.sep)) {
		if (segment === '') continue;
		cursor = path.join(cursor, segment);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(cursor);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ENOTDIR') return;
			throw error;
		}
		if (stat.isSymbolicLink()) throw makeError(cursor);
	}
}

/**
 * Bounded, symlink-rejecting artifact re-hash (the snapshot-identity safety
 * pattern, read-side): O_NOFOLLOW open, fstat identity/mutation checks,
 * byte/entry caps. Returns the portable ref plus the absolute path so the
 * export bundle can copy the exact bytes that were hashed.
 */
export function hashReceiptArtifact(
	root: string,
	absolute: string,
): HashedArtifact {
	const relative = toPortableRelativePath(root, absolute);
	if (
		relative === '' ||
		relative === '..' ||
		relative.startsWith('../') ||
		relative.startsWith('/') ||
		/^[A-Za-z]:[\\/]/.test(relative) ||
		relative.startsWith('\\\\')
	) {
		throw new Error(`RECEIPT_ARTIFACT_PATH_ESCAPE: ${relative}`);
	}
	// PRR-004 (review round 2 batch): O_NOFOLLOW is undefined on win32, so the
	// leaf-open guard is inert there, and even on POSIX it protects only the
	// FINAL component. Walk every parent component first and reject links at
	// any level (junctions included) — a symlinked parent would redirect the
	// hashed bytes away from the object the receipt claims to cite.
	assertNoSymlinkComponents(
		root,
		absolute,
		(offender) => new Error(`RECEIPT_ARTIFACT_UNSAFE_PATH: ${offender}`),
	);
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new Error(`RECEIPT_ARTIFACT_MISSING: ${relative}`);
		}
		throw error;
	}
	if (stat.isSymbolicLink()) {
		throw new Error(`RECEIPT_ARTIFACT_UNSAFE_PATH: ${relative}`);
	}
	if (!stat.isFile()) {
		throw new Error(`RECEIPT_ARTIFACT_NON_REGULAR: ${relative}`);
	}
	if (stat.size > MAX_RECEIPT_ARTIFACT_BYTES) {
		throw new Error(`RECEIPT_ARTIFACT_BYTE_LIMIT: ${relative}`);
	}
	const descriptor = fs.openSync(
		absolute,
		fs.constants.O_RDONLY |
			((fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0),
	);
	try {
		const opened = fs.fstatSync(descriptor);
		if (
			!opened.isFile() ||
			opened.dev !== stat.dev ||
			opened.ino !== stat.ino ||
			opened.size !== stat.size
		) {
			throw new Error(`RECEIPT_ARTIFACT_CONCURRENT_MUTATION: ${relative}`);
		}
		const bytes = fs.readFileSync(descriptor);
		const after = fs.fstatSync(descriptor);
		if (
			after.size !== opened.size ||
			after.mtimeMs !== opened.mtimeMs ||
			after.ctimeMs !== opened.ctimeMs
		) {
			throw new Error(`RECEIPT_ARTIFACT_CONCURRENT_MUTATION: ${relative}`);
		}
		return {
			ref: {
				path: relative,
				sha256: createHash('sha256').update(bytes).digest('hex'),
				bytes: bytes.byteLength,
			},
			absolutePath: absolute,
		};
	} finally {
		fs.closeSync(descriptor);
	}
}

interface PersistedPhaseReport {
	schemaVersion: number;
	phase: number;
	outcome: string;
	reportHash: string;
	entries: Array<{
		id: string;
		code?: string;
		outcome: string;
		detail?: string;
		evidenceRefs: string[];
		responsibleActor: string;
	}>;
}

/** Newest persisted gate report for a phase (mtime, name-order tiebreak). */
export function readNewestPhaseReport(
	directory: string,
	phase: number,
): PersistedPhaseReport | null {
	const receiptsDir = path.join(directory, '.swarm', 'evidence', 'receipts');
	let names: string[];
	try {
		names = fs.readdirSync(receiptsDir);
	} catch {
		return null;
	}
	const grammar = new RegExp(`^phase-${phase}-[0-9a-f]{64}\\.json$`);
	const candidates = names
		.filter((name) => grammar.test(name))
		.map((name) => {
			const full = path.join(receiptsDir, name);
			const stat = fs.lstatSync(full);
			// FB-004: a persisted report is read by pathname — reject links and
			// non-regular entries so a planted symlink cannot redirect the read
			// out of the receipts dir.
			if (stat.isSymbolicLink() || !stat.isFile()) return null;
			return { name, full, mtime: stat.mtimeMs };
		})
		.filter(
			(entry): entry is { name: string; full: string; mtime: number } =>
				entry !== null,
		)
		.sort((left, right) =>
			right.mtime === left.mtime
				? right.name.localeCompare(left.name)
				: right.mtime - left.mtime,
		);
	for (const candidate of candidates) {
		try {
			const stemHash = candidate.name.match(
				/^phase-\d+-([0-9a-f]{64})\.json$/,
			)?.[1];
			if (!stemHash) continue;
			const parsed = JSON.parse(
				fs.readFileSync(candidate.full, 'utf8'),
			) as PersistedPhaseReport;
			if (
				Array.isArray(parsed?.entries) &&
				typeof parsed?.reportHash === 'string' &&
				// FB-004: the content-addressed filename must AGREE with the
				// self-declared digest — a planted report whose name hashes one
				// thing and whose body declares another is not a capture.
				parsed.reportHash === stemHash
			) {
				return parsed;
			}
		} catch {
			// Corrupt candidate: try the next-newest (clear error if all fail).
		}
	}
	return null;
}

function snapshotFromEvidenceRefs(
	refs: string[],
): VerificationReceipt['snapshot'] {
	const snapshot: VerificationReceipt['snapshot'] = {};
	for (const ref of refs) {
		if (ref.startsWith('plan-structure:')) {
			snapshot.plan_structure = ref.slice('plan-structure:'.length);
		} else if (ref.startsWith('policy:')) {
			snapshot.policy = ref.slice('policy:'.length);
		} else if (ref.startsWith('phase-evidence:')) {
			snapshot.phase_evidence = ref.slice('phase-evidence:'.length);
		}
	}
	return snapshot;
}

/**
 * Build a receipt from DURABLE state only (nothing is re-run). Absent
 * command/exit_code/output_digest fields mean no durable producer recorded
 * them — they are omitted, never reconstructed.
 */
export async function buildVerificationReceipt(
	directory: string,
	kind: ReceiptKind,
	id: string,
): Promise<VerificationReceipt> {
	if (!isValidReceiptUnitId(kind, id)) {
		throw new Error(`RECEIPT_INVALID_UNIT_ID: ${kind} ${id}`);
	}
	const root = fs.realpathSync(directory);
	const gates: ReceiptGateRecord[] = [];
	const artifactPaths: string[] = [];
	let snapshot: VerificationReceipt['snapshot'] = {};
	let reportHash: string | undefined;

	if (kind === 'phase') {
		const phaseNumber = Number.parseInt(id, 10);
		const report = readNewestPhaseReport(root, phaseNumber);
		if (!report) {
			throw new Error(
				`RECEIPT_NO_PERSISTED_REPORT: phase ${phaseNumber} has no captured gate report (reports are captured exactly once, at the plan-commit boundary — phases completed before #2968, in plan-free mode, or whose capture failed have no backfillable report; re-running phase_complete for an already-complete phase will not produce one)`,
			);
		}
		// FB-004 (swarm-pr-review PRR-005): the persisted report is a
		// model-writable file — re-derive its content digest instead of
		// trusting the self-declared field. An edited-entry report (lazy
		// not_applicable→pass laundering) is refused here and re-checked at
		// verify time over the bundled copy.
		if (
			stableReportHash(
				report.phase,
				report.entries as unknown as PhaseGateEntry[],
			) !== report.reportHash
		) {
			throw new Error(
				`RECEIPT_REPORT_HASH_MISMATCH: phase ${phaseNumber} stored gate report digest does not match its content`,
			);
		}
		reportHash = report.reportHash;
		for (const entry of report.entries) {
			if (gates.length >= MAX_RECEIPT_GATES) {
				throw new Error(`RECEIPT_GATE_LIMIT: ${id}`);
			}
			gates.push({
				gate_id: entry.id,
				outcome: entry.outcome as ReceiptGateRecord['outcome'],
				...(entry.code !== undefined ? { code: entry.code } : {}),
				responsible_actor: entry.responsibleActor,
				evidence_refs: entry.evidenceRefs,
				...(entry.detail !== undefined
					? {
							detail_digest: createHash('sha256')
								.update(entry.detail)
								.digest('hex'),
						}
					: {}),
			});
			if (entry.id === 'snapshot_identity') {
				snapshot = snapshotFromEvidenceRefs(entry.evidenceRefs);
			}
		}
		artifactPaths.push(
			path.join(
				'.swarm',
				'evidence',
				'receipts',
				`phase-${phaseNumber}-${report.reportHash}.json`,
			),
		);
		if (snapshot.phase_evidence !== undefined) {
			const spec = path.join('.swarm', 'spec.md');
			if (fs.existsSync(path.join(root, spec))) artifactPaths.push(spec);
		}
	} else {
		const evidence = await readTaskEvidence(root, id);
		if (!evidence) {
			throw new Error(`RECEIPT_NO_TASK_EVIDENCE: ${id}`);
		}
		const gateEntries =
			(evidence as unknown as { gates?: Record<string, unknown> }).gates ?? {};
		const gateNames = Object.keys(gateEntries);
		let bundle: EvidenceBundle | null = null;
		try {
			const loaded = await loadEvidence(root, id, { migrate: false });
			bundle = loaded.status === 'found' ? loaded.bundle : null;
		} catch {
			bundle = null;
		}
		const evidenceRefs = [`task-evidence:${id}`];
		if (bundle) {
			for (const entry of bundle.entries) {
				evidenceRefs.push(`bundle-entry:${entry.type}`);
			}
		}
		for (const gateName of gateNames) {
			if (gates.length >= MAX_RECEIPT_GATES) {
				throw new Error(`RECEIPT_GATE_LIMIT: ${id}`);
			}
			// #3560: outcomes derive from the DURABLE entry (verdict-bearing
			// kinds reflect their recorded verdict; presence-only kinds are
			// honest pass-on-presence by producer contract) and the actor
			// comes from the recorded agent — never a constant.
			const derived = deriveDurableTaskGate(gateEntries[gateName]);
			gates.push({
				gate_id: gateName,
				outcome: derived.outcome,
				...(derived.code !== undefined ? { code: derived.code } : {}),
				responsible_actor: derived.responsible_actor,
				evidence_refs: evidenceRefs,
			});
		}
		if (gates.length === 0) {
			// #3560 AC5: no fabricated pass — a settled read-only task
			// (durable workflow.noMutationSettlement) is pass-bearing with
			// the proof in `code`; anything else is not_applicable.
			const synthesized = deriveTaskEvidenceSynthesis(
				(evidence as unknown as { workflow?: unknown }).workflow,
			);
			gates.push({
				gate_id: 'task_evidence',
				outcome: synthesized.outcome,
				...(synthesized.code !== undefined ? { code: synthesized.code } : {}),
				responsible_actor: synthesized.responsible_actor,
				evidence_refs: evidenceRefs,
			});
		}
		artifactPaths.push(path.join('.swarm', 'evidence', `${id}.json`));
		if (bundle) {
			artifactPaths.push(path.join('.swarm', 'evidence', id, 'evidence.json'));
		}
	}

	const artifacts: ReceiptArtifactRef[] = [];
	const hashedPaths: string[] = [];
	let totalArtifactBytes = 0;
	for (const relative of artifactPaths) {
		if (artifacts.length >= MAX_RECEIPT_ARTIFACTS) {
			throw new Error(`RECEIPT_ARTIFACT_LIMIT: ${id}`);
		}
		const hashed = hashReceiptArtifact(root, path.join(root, relative));
		totalArtifactBytes += hashed.ref.bytes;
		// Aggregate cap mirrors computePhaseEvidenceSnapshot's totalBytes
		// accumulation (implementation-review F5): the 16 MiB bound is a
		// per-RECEIPT hashing budget, not just a per-file one.
		if (totalArtifactBytes > MAX_RECEIPT_ARTIFACT_BYTES) {
			throw new Error(
				`RECEIPT_ARTIFACT_BYTE_LIMIT: aggregate ${totalArtifactBytes} over ${id}`,
			);
		}
		artifacts.push(hashed.ref);
		hashedPaths.push(hashed.absolutePath);
	}

	const receiptWithoutHash = {
		format_version: RECEIPT_FORMAT_VERSION,
		kind,
		unit_id: id,
		generated_at: new Date().toISOString(),
		plugin_version: packageJson.version,
		snapshot,
		gates,
		artifacts,
		...(reportHash !== undefined ? { report_hash: reportHash } : {}),
	};
	const receipt: VerificationReceipt = VerificationReceiptSchema.parse({
		...receiptWithoutHash,
		receipt_hash: computeReceiptHash(receiptWithoutHash),
	});
	ensureReceiptBounds(receipt);
	return receipt;
}

/** Bounded content signature used for write-once idempotency (excludes volatile fields). */
export function receiptContentSignature(receipt: VerificationReceipt): string {
	const { generated_at: _generatedAt, receipt_hash: _hash, ...rest } = receipt;
	return canonicalReceiptJson(rest);
}

/**
 * Rendered Markdown. Absent fields print "—" under the header note
 * "fields absent from the durable record are omitted, not reconstructed".
 */
export function renderReceiptMarkdown(receipt: VerificationReceipt): string {
	const lines: string[] = [
		`# Verification receipt — ${receipt.kind} ${receipt.unit_id}`,
		'',
		`- format_version: ${receipt.format_version}`,
		`- receipt_hash: ${receipt.receipt_hash}`,
		...(receipt.report_hash ? [`- report_hash: ${receipt.report_hash}`] : []),
		`- generated_at: ${receipt.generated_at}`,
		`- plugin_version: ${receipt.plugin_version}`,
		'',
		'> Fields absent from the durable record are omitted, not reconstructed.',
		'',
		'## Snapshot hashes',
		'',
		`- plan_structure: ${receipt.snapshot.plan_structure ?? '—'}`,
		`- policy: ${receipt.snapshot.policy ?? '—'}`,
		`- phase_evidence: ${receipt.snapshot.phase_evidence ?? '—'}`,
		'',
		'## Gates',
		'',
		// PRR-022: only columns the durable producers actually populate are
		// rendered — command/exit_code/output_digest remain forward-compatible
		// schema fields (omitted unless a durable producer recorded them) but
		// rendering them as permanently-empty columns misrepresented the
		// receipt as richer than the durable record.
		'| gate | outcome | code | actor |',
		'|---|---|---|---|',
	];
	for (const gate of receipt.gates) {
		lines.push(
			`| ${gate.gate_id} | ${gate.outcome} | ${gate.code ?? '—'} | ${
				gate.responsible_actor
			} |`,
		);
	}
	lines.push(
		'',
		'## Artifacts',
		'',
		'| path | bytes | sha256 |',
		'|---|---|---|',
	);
	for (const artifact of receipt.artifacts) {
		lines.push(`| ${artifact.path} | ${artifact.bytes} | ${artifact.sha256} |`);
	}
	lines.push(
		'',
		'Documented limitations: hash-only integrity is spoofable by a determined',
		'local actor (integrity against the model, not the user); absent fields',
		'mean absent durable records; path normalization is byte-exact',
		'forward-slashing without case-folding.',
		'',
	);
	return lines.join('\n');
}
