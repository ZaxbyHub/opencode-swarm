import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { scanDelegationsForRecovery } from '../background/pending-delegations.js';
import { appendCoreEventSync } from '../events/core-events.js';
import { classifyPrWorkflowGitState } from '../git/pr-workflow-state.js';
import {
	type PrWorkflowCheckoutRecoveryRecord,
	prWorkflowSessionFileStem,
	withInactivePrWorkflowCheckoutRestoreLock,
	withPrWorkflowCheckoutPreparationLock,
	writePrWorkflowAtomicJson,
} from '../hooks/pr-workflow-gate.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { bunSpawn } from '../utils/bun-compat.js';
import { resolveGitExecutableAsync } from '../utils/git-executable.js';
import { containsControlChars } from '../utils/path-security.js';
import { createSwarmTool } from './create-tool.js';

const GIT_TIMEOUT_MS = 30_000;
const MAX_CHECKOUT_PATHS = 32;
const MAX_CHECKOUT_RECEIPTS = 8;
const MAX_RECEIPT_DIRECTORY_ENTRIES = 64;
const MAX_RECEIPT_PATHS = 64;
const MAX_RECEIPT_PATH_LEN = 4_096;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_GIT_STDOUT_BYTES = 1024 * 1024;
const MAX_ECHOED_PATH_LEN = 200;
const RECEIPT_DIR = 'pr-workflow-checkouts';

const PreparePrWorkflowCheckoutArgsSchema = z
	.object({
		operation: z.enum(['prepare', 'restore']).optional(),
		// Optional: an explicit path set selects EXPLICIT mode (exact dirty-tracked
		// match); omitting `paths` selects DISCOVERY mode (stash all dirt, including
		// untracked). An empty array is still rejected so a present `paths` cannot
		// silently degrade into discovery.
		paths: z.array(z.string().min(1).max(240)).min(1).max(32).optional(),
		stash_oid: z
			.string()
			.regex(/^[0-9a-f]{40,64}$/i)
			.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.operation === 'restore' && value.paths) {
			context.addIssue({
				code: 'custom',
				path: ['paths'],
				message: 'paths cannot be supplied for restore',
			});
		}
		if (value.operation !== 'restore' && value.stash_oid) {
			context.addIssue({
				code: 'custom',
				path: ['stash_oid'],
				message: 'stash_oid is only valid for restore',
			});
		}
	});

interface CheckoutPreparation {
	stashOid: string;
	originalHead: string;
	originalBranch: string | null;
	paths: string[];
	preparedAt: string;
	mode: 'PR_REVIEW' | 'PR_FEEDBACK';
	gateRevision: number;
	gateActivatedAt: string;
	// DISCOVERY-mode-only annotations (absent in EXPLICIT mode so its receipt stays
	// byte-identical). `paths` is bounded to MAX_RECEIPT_PATHS entries; when the
	// discovered set exceeded that cap, `pathsTruncated` is true.
	discovered?: boolean;
	includedUntracked?: boolean;
	pathsTruncated?: boolean;
}

type PreparationOutcome =
	| { kind: 'already_clean' }
	| { kind: 'recovery_required'; recovery: PrWorkflowCheckoutRecoveryRecord }
	| { kind: 'prepared'; preparation: CheckoutPreparation };

interface CheckoutIdentity {
	originalHead: string;
	originalBranch: string | null;
}

function buildReceiptDocument(
	sessionID: string,
	preparation: CheckoutPreparation,
): { schemaVersion: 1; sessionID: string } & CheckoutPreparation {
	return { schemaVersion: 1, sessionID, ...preparation };
}

function serializedJsonByteLength(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value, null, 2)).byteLength;
}

function assertReceiptWithinByteBudget(
	sessionID: string,
	preparation: CheckoutPreparation,
): void {
	const lifecycleMaximum = {
		...buildReceiptDocument(sessionID, preparation),
		restoreState: 'applied',
		restoreAppliedAt: 't'.repeat(64),
		restoreVerifiedAt: 't'.repeat(64),
		restoredHead: 'f'.repeat(64),
		restoredBranch: preparation.originalBranch,
	};
	if (serializedJsonByteLength(lifecycleMaximum) > MAX_RECEIPT_BYTES) {
		throw new Error(
			`checkout-preparation receipt exceeds the ${MAX_RECEIPT_BYTES}-byte durable lifecycle boundary`,
		);
	}
}

function assertRestoreReceiptWithinByteBudget(
	receipt: CheckoutRestoreReceipt,
): void {
	if (serializedJsonByteLength(receipt) > MAX_RECEIPT_BYTES) {
		throw new Error(
			`checkout-restoration receipt exceeds the ${MAX_RECEIPT_BYTES}-byte durable read boundary`,
		);
	}
}

function fitDiscoveredReceiptPaths(
	sessionID: string,
	discoveredPaths: readonly string[],
	base: Omit<CheckoutPreparation, 'stashOid' | 'paths' | 'pathsTruncated'>,
): { paths: string[]; pathsTruncated: boolean } {
	const paths: string[] = [];
	let pathsTruncated = discoveredPaths.length > MAX_RECEIPT_PATHS;
	for (const rawPath of discoveredPaths.slice(0, MAX_RECEIPT_PATHS)) {
		const candidatePath = rawPath.slice(0, MAX_RECEIPT_PATH_LEN);
		if (candidatePath.length < rawPath.length) pathsTruncated = true;
		const candidatePaths = [...paths, candidatePath];
		const candidate: CheckoutPreparation = {
			...base,
			stashOid: 'f'.repeat(64),
			paths: candidatePaths,
			pathsTruncated: true,
		};
		try {
			assertReceiptWithinByteBudget(sessionID, candidate);
		} catch {
			pathsTruncated = true;
			break;
		}
		paths.push(candidatePath);
	}
	const fitted: CheckoutPreparation = {
		...base,
		stashOid: 'f'.repeat(64),
		paths,
		pathsTruncated,
	};
	assertReceiptWithinByteBudget(sessionID, fitted);
	return { paths, pathsTruncated };
}

function isSafeRecordedBranch(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 240 &&
		!value.startsWith('-') &&
		!value.startsWith('/') &&
		!value.endsWith('/') &&
		!value.endsWith('.') &&
		!value.endsWith('.lock') &&
		!value.includes('..') &&
		!value.includes('@{') &&
		!value.includes('//') &&
		!/[\s~^:?*[\]\\]/.test(value) &&
		!containsControlChars(value)
	);
}

type RestoreOutcome =
	| { kind: 'already_restored' }
	| {
			kind: 'restored';
			stashOids: string[];
			retainedStashOids: string[];
			stashRetentionVerified: boolean;
			originalHead: string;
			originalBranch: string | null;
			restoredHead: string;
			receiptCleanupPending: boolean;
	  };

export interface PrWorkflowCheckoutRestoreInventoryItem {
	stash_oid: string;
	stash_present: boolean | null;
}

class CheckoutRestoreError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'CheckoutRestoreError';
	}
}

/**
 * Preserve explicit dirty tracked files before the unbound PR checkout.
 *
 * The tool uses the canonical gate's cross-process mutation lock and
 * schema-validated state, so an abort, bind, or same-session reactivation
 * cannot revoke or replace authorization while the fixed Git command runs.
 * The independent receipt is retained under `.swarm/` after terminal gate
 * cleanup so the exact stash recovery command remains auditable.
 */
export async function executePreparePrWorkflowCheckout(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = PreparePrWorkflowCheckoutArgsSchema.safeParse(args);
	if (!parsed.success) {
		return JSON.stringify({
			success: false,
			message: `Invalid PR workflow checkout preparation: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		});
	}
	if (!context.sessionID?.trim()) {
		return JSON.stringify({
			success: false,
			message: 'PR workflow checkout preparation requires an active sessionID',
		});
	}
	try {
		if (parsed.data.operation === 'restore') {
			const outcome = await restorePrWorkflowCheckout(
				directory,
				context.sessionID,
				parsed.data.stash_oid,
			);
			if (outcome.kind === 'already_restored') {
				return JSON.stringify({
					success: true,
					already_restored: true,
					message:
						'No live checkout-preparation receipt remains for this session.',
				});
			}
			return JSON.stringify({
				success: true,
				restored: true,
				stash_oid: outcome.stashOids[0],
				stash_oids: outcome.stashOids,
				retained_stash_oids: outcome.retainedStashOids,
				stash_retained: outcome.retainedStashOids.length > 0,
				stash_retention_verified: outcome.stashRetentionVerified,
				original_head: outcome.originalHead,
				original_branch: outcome.originalBranch,
				restored_head: outcome.restoredHead,
				receipt_cleanup_pending: outcome.receiptCleanupPending,
			});
		}
		const outcome = await preparePrWorkflowCheckout(
			directory,
			context.sessionID,
			parsed.data.paths,
		);
		if (outcome.kind === 'already_clean') {
			return JSON.stringify({
				success: true,
				already_clean: true,
				message:
					'Working tree is already clean; no checkout preparation was needed. Proceed to bind the PR head.',
			});
		}
		if (outcome.kind === 'recovery_required') {
			const affectedPaths = outcome.recovery.evidence.paths
				.map(boundUntrustedPath)
				.filter(Boolean);
			const pathSummary =
				affectedPaths.length > 0
					? ` Affected paths: ${affectedPaths.join(', ')}.`
					: '';
			return JSON.stringify({
				success: false,
				code: outcome.recovery.code,
				retryable: false,
				required_action: outcome.recovery.requiredAction,
				evidence: outcome.recovery.evidence,
				message: `PR workflow checkout requires manual Git recovery (${outcome.recovery.code}); no stash command was attempted. ${outcome.recovery.requiredAction}${pathSummary}`,
			});
		}
		const { preparation } = outcome;
		const response: Record<string, unknown> = {
			success: true,
			stash_oid: preparation.stashOid,
			paths: preparation.paths,
			recovery: structuredRestoreInstruction(preparation.stashOid),
		};
		if (preparation.discovered) {
			response.discovered = true;
			response.included_untracked = preparation.includedUntracked ?? false;
			response.paths_truncated = preparation.pathsTruncated ?? false;
		}
		return JSON.stringify(response);
	} catch (error) {
		return JSON.stringify({
			success: false,
			...(error instanceof CheckoutRestoreError
				? { code: error.code, retryable: false }
				: {}),
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

async function preparePrWorkflowCheckout(
	directory: string,
	rawSessionID: string,
	requestedPaths: readonly string[] | undefined,
): Promise<PreparationOutcome> {
	const sessionID = normalizeSessionID(rawSessionID);
	const discoveryMode = !requestedPaths || requestedPaths.length === 0;
	// EXPLICIT mode still validates + anchors every literal path up front; discovery
	// mode reads the working tree itself, so there is nothing to normalize here.
	const paths = discoveryMode ? [] : normalizePaths(directory, requestedPaths);
	return withPrWorkflowCheckoutPreparationLock(
		directory,
		sessionID,
		async (gate, controls) => {
			if (gate.checkoutRecovery) {
				return {
					kind: 'recovery_required',
					recovery: gate.checkoutRecovery,
				};
			}
			const checkoutState = await _internals.classifyGitState(directory);
			if (
				checkoutState.kind === 'recovery-required' ||
				checkoutState.kind === 'indeterminate'
			) {
				const recoveredState =
					await controls.markRecoveryRequired(checkoutState);
				return {
					kind: 'recovery_required',
					recovery: recoveredState.checkoutRecovery!,
				};
			}
			if (discoveryMode && checkoutState.kind === 'clean') {
				return { kind: 'already_clean' };
			}
			const checkoutIdentity = await captureCheckoutIdentity(directory);
			const outstandingReceiptCount = await countOutstandingReceipts(
				directory,
				sessionID,
			);
			if (outstandingReceiptCount >= MAX_CHECKOUT_RECEIPTS) {
				throw new Error(
					'BLOCKED: PR workflow checkout preparation limit reached; resolve the existing preserved stashes before continuing',
				);
			}

			const openLanes = await countOpenPrWorkflowLanes(directory, sessionID);
			if (openLanes > 0) {
				throw new Error(
					`BLOCKED: ${gate.mode} checkout preparation is refused while ${openLanes} PR workflow lane(s) are in flight`,
				);
			}

			if (discoveryMode) {
				return prepareDiscoveredCheckout(
					directory,
					sessionID,
					gate,
					checkoutIdentity,
				);
			}

			await assertExactDirtyPathSet(directory, paths);
			const preparedAt = new Date().toISOString();
			assertReceiptWithinByteBudget(sessionID, {
				stashOid: 'f'.repeat(64),
				...checkoutIdentity,
				paths,
				preparedAt,
				mode: gate.mode,
				gateRevision: gate.revision,
				gateActivatedAt: gate.activatedAt,
			});
			const stashMarker = `pr-workflow-checkout-${randomUUID()}`;
			const stash = await _internals.runGit(directory, [
				'stash',
				'push',
				`--message=${stashMarker}`,
				'--',
				...paths,
			]);
			if (stash.exitCode !== 0) {
				throw new Error(
					'BLOCKED: Git could not preserve the requested checkout-preparation paths; resolve the working tree manually or abort the workflow',
				);
			}
			const stashOid = await resolveMarkedStashOid(
				directory,
				stashMarker,
				paths,
			);

			const preparation: CheckoutPreparation = {
				stashOid,
				...checkoutIdentity,
				paths,
				preparedAt,
				mode: gate.mode,
				gateRevision: gate.revision,
				gateActivatedAt: gate.activatedAt,
			};
			try {
				await writeReceipt(directory, sessionID, preparation);
			} catch (error) {
				throw new Error(
					`BLOCKED: stash ${stashOid} was created but its durable checkout-preparation receipt could not be recorded (${error instanceof Error ? error.message : String(error)}). Do not continue; ${manualRecoveryInstruction(stashOid)}.`,
				);
			}

			await assertCleanWorkingTree(directory, stashOid);
			await appendPreparationEvent(directory, sessionID, preparation);
			return { kind: 'prepared', preparation };
		},
	);
}

/**
 * DISCOVERY mode: preserve every dirty change the working tree carries — tracked
 * AND untracked — without the caller having to enumerate them under the gate.
 *
 * Two empirically-confirmed Git behaviors are handled here and MUST NOT be
 * "simplified" back into the explicit-mode path:
 *
 *  - Bug A: `git stash push --include-untracked` on a CLEAN tree prints
 *    "No local changes to save" and EXITS 0. Relying on the exit code alone would
 *    then leave zero stashes and make the marker resolver throw a confusing error.
 *    We therefore read porcelain status FIRST and short-circuit a clean tree to an
 *    `already_clean` no-op before ever stashing (no stash, no receipt).
 *  - Bug B: `git stash show --name-only` lists ONLY tracked files for a `-u`
 *    stash (untracked entries live in stash^3). The explicit-mode exact-path
 *    comparison would falsely mismatch whenever untracked files were stashed, so
 *    discovery verifies by unique-marker stash existence plus `assertCleanWorkingTree`
 *    — the real proof the tree is now clean — instead of comparing shown paths.
 */
async function prepareDiscoveredCheckout(
	directory: string,
	sessionID: string,
	gate: {
		mode: 'PR_REVIEW' | 'PR_FEEDBACK';
		revision: number;
		activatedAt: string;
	},
	checkoutIdentity: CheckoutIdentity,
): Promise<PreparationOutcome> {
	// Bug A guard: inspect the tree before touching the stash.
	const status = await readPorcelainStatus(directory);
	const isClean =
		status.dirtyTrackedPaths.length === 0 &&
		status.untrackedPaths.length === 0 &&
		!status.renameOrCopy;
	if (isClean) {
		return { kind: 'already_clean' };
	}

	// `.swarm/` must be git-excluded; untracked churn there is a containment bug,
	// not checkout dirt to preserve. Fail closed instead of stashing plugin state.
	const swarmUntracked = status.untrackedPaths.filter(
		(candidate) => candidate === '.swarm' || candidate.startsWith('.swarm/'),
	);
	if (swarmUntracked.length > 0) {
		throw new Error(
			`BLOCKED: checkout preparation refuses untracked churn under .swarm/ (${swarmUntracked
				.slice(0, 5)
				.map((entry) => boundUntrustedPath(entry))
				.join(
					', ',
				)}); that directory must stay git-excluded (.git/info/exclude). Resolve the .swarm/ tracking regression before preparing a checkout.`,
		);
	}

	const includedUntracked = status.untrackedPaths.length > 0;
	const preparedAt = new Date().toISOString();
	const discoveredPaths = [
		...status.dirtyTrackedPaths,
		...status.untrackedPaths,
	].sort();
	const fittedPaths = fitDiscoveredReceiptPaths(sessionID, discoveredPaths, {
		...checkoutIdentity,
		preparedAt,
		mode: gate.mode,
		gateRevision: gate.revision,
		gateActivatedAt: gate.activatedAt,
		discovered: true,
		includedUntracked,
	});
	const stashMarker = `pr-workflow-checkout-${randomUUID()}`;
	const stash = await _internals.runGit(
		directory,
		['stash', 'push', '--include-untracked', `--message=${stashMarker}`],
		{ literalPathspecs: false },
	);
	if (stash.exitCode !== 0) {
		throw new Error(
			'BLOCKED: Git could not preserve the discovered working-tree changes; resolve the working tree manually or abort the workflow',
		);
	}

	// Bug B guard: marker existence only, then prove cleanliness directly.
	const stashOid = await resolveMarkedStashOidByMarker(directory, stashMarker);

	const preparation: CheckoutPreparation = {
		stashOid,
		...checkoutIdentity,
		paths: fittedPaths.paths,
		preparedAt,
		mode: gate.mode,
		gateRevision: gate.revision,
		gateActivatedAt: gate.activatedAt,
		discovered: true,
		includedUntracked,
		pathsTruncated: fittedPaths.pathsTruncated,
	};
	try {
		await writeReceipt(directory, sessionID, preparation);
	} catch (error) {
		throw new Error(
			`BLOCKED: stash ${stashOid} was created but its durable checkout-preparation receipt could not be recorded (${error instanceof Error ? error.message : String(error)}). Do not continue; ${manualRecoveryInstruction(stashOid)}.`,
		);
	}

	await assertCleanWorkingTree(directory, stashOid, { discovery: true });
	await appendPreparationEvent(directory, sessionID, preparation);
	return { kind: 'prepared', preparation };
}

function normalizeSessionID(sessionID: string): string {
	const normalized = sessionID.trim();
	if (!normalized) {
		throw new Error(
			'BLOCKED: PR workflow checkout preparation requires a non-empty sessionID',
		);
	}
	return normalized;
}

function normalizePaths(
	directory: string,
	requestedPaths: readonly string[],
): string[] {
	if (
		!Array.isArray(requestedPaths) ||
		requestedPaths.length === 0 ||
		requestedPaths.length > MAX_CHECKOUT_PATHS
	) {
		throw new Error(
			`BLOCKED: checkout preparation requires 1-${MAX_CHECKOUT_PATHS} explicit paths`,
		);
	}
	const root = path.resolve(directory);
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const value of requestedPaths) {
		if (typeof value !== 'string' || !value) {
			throw new Error(
				'BLOCKED: checkout preparation paths must be non-empty strings',
			);
		}
		if (
			value.includes('\\') ||
			path.posix.normalize(value) !== value ||
			path.posix.isAbsolute(value) ||
			/^[A-Za-z]:/.test(value) ||
			containsControlChars(value)
		) {
			throw new Error(
				'BLOCKED: checkout preparation path must be a literal slash-separated repository-relative path',
			);
		}
		const segments = value.split('/');
		if (
			segments.some(
				(segment) => !segment || segment === '.' || segment === '..',
			) ||
			segments[0] === '.git' ||
			segments[0] === '.swarm'
		) {
			throw new Error(
				'BLOCKED: checkout preparation path is not an allowed repository file path',
			);
		}
		const resolved = path.resolve(root, ...segments);
		const relative = path.relative(root, resolved);
		if (
			!relative ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
		) {
			throw new Error(
				'BLOCKED: checkout preparation path escapes the project root',
			);
		}
		if (seen.has(value)) {
			throw new Error(
				'BLOCKED: checkout preparation path was supplied more than once',
			);
		}
		seen.add(value);
		normalized.push(value);
	}
	return normalized;
}

async function countOpenPrWorkflowLanes(
	directory: string,
	sessionID: string,
): Promise<number> {
	const scan = scanDelegationsForRecovery(directory);
	if (scan.status === 'uncertain') {
		throw new Error(
			`BLOCKED: unable to inspect PR workflow lanes; cannot safely prepare checkout (${scan.reason})`,
		);
	}
	return scan.owners.filter(
		(record) =>
			record.parentSessionId === sessionID &&
			typeof record.mode === 'string' &&
			record.mode.startsWith('swarm-pr-') &&
			(record.status === 'pending' || record.status === 'running'),
	).length;
}

async function assertExactDirtyPathSet(
	directory: string,
	requestedPaths: readonly string[],
): Promise<void> {
	const status = await readPorcelainStatus(directory);
	if (status.untrackedPaths.length > 0) {
		throw new Error(
			`BLOCKED: checkout preparation refuses untracked paths (${status.untrackedPaths.slice(0, 5).join(', ')}); move or remove them before checkout`,
		);
	}
	if (status.renameOrCopy) {
		throw new Error(
			'BLOCKED: checkout preparation refuses rename or copy changes; resolve them manually before checkout',
		);
	}
	const dirtySet = new Set(status.dirtyTrackedPaths);
	const requestedSet = new Set(requestedPaths);
	const omitted = [...dirtySet].filter(
		(candidate) => !requestedSet.has(candidate),
	);
	const notDirty = requestedPaths.filter(
		(candidate) => !dirtySet.has(candidate),
	);
	if (omitted.length > 0 || notDirty.length > 0) {
		throw new Error(
			`BLOCKED: checkout preparation paths must exactly cover every dirty tracked path (omitted: ${omitted.length ? omitted.join(', ') : 'none'}; not dirty: ${notDirty.length ? notDirty.join(', ') : 'none'})`,
		);
	}
}

async function assertCleanWorkingTree(
	directory: string,
	stashOid: string,
	options: { discovery?: boolean } = {},
): Promise<void> {
	let status: Awaited<ReturnType<typeof readPorcelainStatus>>;
	try {
		status = await readPorcelainStatus(directory);
	} catch (error) {
		// The stash was already created before this verification step ran, so it
		// exists and is recoverable even though its cleanliness could not be
		// confirmed here — the caller must still get the exact recovery command
		// instead of a bare "could not verify" dead end (PRR-005 / PRR-006).
		throw new Error(
			`BLOCKED: stash ${stashOid} was created, but the post-stash working-tree status could not be verified (${error instanceof Error ? error.message : String(error)}). Do not continue; ${manualRecoveryInstruction(stashOid)} and resolve manually.`,
		);
	}
	if (
		status.dirtyTrackedPaths.length > 0 ||
		status.untrackedPaths.length > 0 ||
		status.renameOrCopy
	) {
		if (options.discovery) {
			const remaining = [
				...status.dirtyTrackedPaths,
				...status.untrackedPaths,
			].slice(0, 5);
			const remainingText =
				remaining.length > 0
					? remaining.map((entry) => boundUntrustedPath(entry)).join(', ')
					: 'rename/copy changes only';
			throw new Error(
				`BLOCKED: stash ${stashOid} was created, but the checkout is still not clean (remaining: ${remainingText}). Submodule pointer changes are not preserved by --include-untracked and must be resolved manually. Do not continue; ${manualRecoveryInstruction(stashOid)} and resolve manually.`,
			);
		}
		throw new Error(
			`BLOCKED: stash ${stashOid} was created, but the checkout is still not clean. Do not continue; ${manualRecoveryInstruction(stashOid)} and resolve manually.`,
		);
	}
}

async function readPorcelainStatus(directory: string): Promise<{
	dirtyTrackedPaths: string[];
	untrackedPaths: string[];
	renameOrCopy: boolean;
}> {
	const result = await _internals.runGit(
		directory,
		['status', '--porcelain=v1', '-z', '--untracked-files=all'],
		{ captureStdout: true },
	);
	if (result.exitCode !== 0) {
		throw new Error(
			'BLOCKED: unable to inspect the full working-tree status safely',
		);
	}
	const dirtyTrackedPaths: string[] = [];
	const untrackedPaths: string[] = [];
	let renameOrCopy = false;
	const records = result.stdout.split('\0');
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record) continue;
		if (record.length < 4 || record[2] !== ' ') {
			throw new Error(
				'BLOCKED: working-tree status is malformed; cannot safely prepare checkout',
			);
		}
		const xy = record.slice(0, 2);
		const filePath = record.slice(3);
		if (!filePath) {
			throw new Error(
				'BLOCKED: working-tree status contains an empty path; cannot safely prepare checkout',
			);
		}
		if (xy === '??') {
			untrackedPaths.push(filePath);
			continue;
		}
		if (xy === '!!') continue;
		if (xy.includes('R') || xy.includes('C')) {
			renameOrCopy = true;
			// Porcelain -z adds the old path as a second NUL-delimited record.
			index++;
		}
		dirtyTrackedPaths.push(filePath);
	}
	return { dirtyTrackedPaths, untrackedPaths, renameOrCopy };
}

async function captureCheckoutIdentity(
	directory: string,
): Promise<CheckoutIdentity> {
	const head = await _internals.runGit(
		directory,
		['rev-parse', '--verify', 'HEAD^0'],
		{ captureStdout: true },
	);
	const originalHead = head.stdout.trim().toLowerCase();
	if (head.exitCode !== 0 || !/^[0-9a-f]{40,64}$/i.test(originalHead)) {
		throw new Error(
			'BLOCKED: unable to capture the original checkout HEAD; no stash was created',
		);
	}
	const branch = await _internals.runGit(
		directory,
		['symbolic-ref', '--quiet', '--short', 'HEAD'],
		{ captureStdout: true },
	);
	// Exit code 1 is `git symbolic-ref`'s documented detached-HEAD signal, but a
	// spawn failure (missing git binary, a cwd that no longer exists) also
	// resolves to a non-zero exit — and could coincidentally be 1 — with no
	// process ever having run. Check `spawnError` explicitly so a spawn failure
	// is never misread as detached-HEAD (#2236 Sweep A, FIX 3).
	if (branch.spawnError || (branch.exitCode !== 0 && branch.exitCode !== 1)) {
		throw new Error(
			'BLOCKED: unable to capture the original checkout branch; no stash was created',
		);
	}
	const originalBranch = branch.exitCode === 0 ? branch.stdout.trim() : null;
	if (originalBranch !== null && !isSafeRecordedBranch(originalBranch)) {
		throw new Error(
			'BLOCKED: original checkout branch identity is unsafe; no stash was created',
		);
	}
	return { originalHead, originalBranch };
}

async function runGit(
	directory: string,
	args: string[],
	options: { captureStdout?: boolean; literalPathspecs?: boolean } = {},
): Promise<{ exitCode: number; stdout: string; spawnError?: Error | null }> {
	// `--literal-pathspecs` is on by default so every user-supplied pathspec (explicit
	// mode's `-- <paths>`) is treated as a literal, defeating glob/magic-pathspec
	// injection. Discovery's `stash push --include-untracked` carries NO pathspec, and
	// `git --literal-pathspecs stash push -u` has an empirically-confirmed quirk (git
	// 2.43) where untracked files are recorded in the stash but NOT removed from the
	// working tree — leaving `assertCleanWorkingTree` to (correctly) reject a tree that
	// plain `git stash push -u` would have cleaned. That call opts out via
	// `literalPathspecs: false`; it is safe because its argv is entirely fixed literals.
	const literalPathspecs = options.literalPathspecs ?? true;
	// Resolution failure (every candidate rejected) is reported through this
	// function's existing `spawnError`-as-value contract — matching exactly
	// what a genuine spawn-creation failure already reports below — rather
	// than introducing a new throw at this call site.
	let gitExecutable: string;
	try {
		gitExecutable = await resolveGitExecutableAsync();
	} catch (error) {
		return {
			exitCode: 1,
			stdout: '',
			spawnError: error instanceof Error ? error : new Error(String(error)),
		};
	}
	const proc = bunSpawn(
		[
			gitExecutable,
			...(literalPathspecs ? ['--literal-pathspecs'] : []),
			...args,
		],
		{
			cwd: directory,
			stdin: 'ignore',
			stdout: options.captureStdout ? 'pipe' : 'ignore',
			stderr: 'ignore',
			timeout: GIT_TIMEOUT_MS,
		},
	);
	try {
		const [exitCode, stdout] = await Promise.all([
			proc.exited,
			options.captureStdout
				? readBoundedGitStdout(proc.stdout, () => {
						try {
							proc.kill();
						} catch {
							// Best-effort overflow termination.
						}
					})
				: Promise.resolve(''),
		]);
		return { exitCode, stdout, spawnError: proc.spawnError ?? null };
	} finally {
		try {
			proc.kill();
		} catch {
			// Best-effort cleanup; Git may already have exited.
		}
	}
}

async function readBoundedGitStdout(
	stream: { getReader(): ReadableStreamDefaultReader<Uint8Array> },
	onOverflow: () => void,
): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			const remaining = MAX_GIT_STDOUT_BYTES - totalBytes;
			if (value.byteLength > remaining) {
				onOverflow();
				throw new Error('BLOCKED: Git output exceeded the safe capture limit');
			}
			chunks.push(value);
			totalBytes += value.byteLength;
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			// The process may already have closed the stream.
		}
		try {
			reader.releaseLock();
		} catch {
			// Best-effort stream cleanup.
		}
	}
	const joined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(joined);
}

/**
 * Locate the single stash whose reflog subject carries our unique marker.
 *
 * Shared by both modes so the stash-identification command and uniqueness
 * guarantee stay identical; only the caller-supplied not-found message differs
 * ("requested" vs "discovered" changes).
 */
async function findUniqueMarkedStashOid(
	directory: string,
	stashMarker: string,
	notFoundMessage: string,
): Promise<string> {
	const list = await _internals.runGit(
		directory,
		['stash', 'list', '--format=%H%x00%gs'],
		{ captureStdout: true },
	);
	if (list.exitCode !== 0) {
		throw new Error(
			'BLOCKED: unable to identify the checkout-preparation stash safely',
		);
	}
	const matching = list.stdout
		.split('\n')
		.map((line) => line.split('\0'))
		.filter(
			(parts) =>
				parts.length === 2 &&
				/^[0-9a-f]{40,64}$/i.test(parts[0]) &&
				parts[1].includes(stashMarker),
		);
	if (matching.length !== 1) {
		throw new Error(notFoundMessage);
	}
	return matching[0][0];
}

async function resolveMarkedStashOid(
	directory: string,
	stashMarker: string,
	paths: readonly string[],
): Promise<string> {
	const stashOid = await findUniqueMarkedStashOid(
		directory,
		stashMarker,
		'BLOCKED: Git did not expose one uniquely identifiable checkout-preparation stash; do not continue to checkout until the requested changes are preserved manually',
	);
	const changed = await _internals.runGit(
		directory,
		['stash', 'show', '--name-only', '--format=', '-z', stashOid],
		{ captureStdout: true },
	);
	const changedPaths = changed.stdout.split('\0').filter(Boolean).sort();
	const expectedPaths = [...paths].sort();
	if (
		changed.exitCode !== 0 ||
		changedPaths.length !== expectedPaths.length ||
		changedPaths.some((value, index) => value !== expectedPaths[index])
	) {
		// The stash already exists (found uniquely above); only its content could
		// not be verified against the requested paths. Give the exact recovery
		// command rather than vague prose — the caller has no other way to learn
		// the apply syntax for a stash it never asked to create (PRR-006).
		throw new Error(
			`BLOCKED: stash ${stashOid} does not contain exactly the requested checkout-preparation paths; do not continue. ${manualRecoveryInstruction(stashOid)} and resolve manually.`,
		);
	}
	return stashOid;
}

/**
 * DISCOVERY-mode resolver: identify the marked stash by marker only.
 *
 * Discovery deliberately does NOT compare `git stash show --name-only` output
 * (Bug B: untracked entries live in stash^3 and never appear there, so the
 * exact-path comparison would falsely mismatch). Cleanliness is proven instead
 * by `assertCleanWorkingTree` after this resolves the OID.
 */
async function resolveMarkedStashOidByMarker(
	directory: string,
	stashMarker: string,
): Promise<string> {
	return findUniqueMarkedStashOid(
		directory,
		stashMarker,
		'BLOCKED: Git did not expose one uniquely identifiable checkout-preparation stash; do not continue to checkout until the discovered changes are preserved manually',
	);
}

async function countOutstandingReceipts(
	directory: string,
	sessionID: string,
): Promise<number> {
	const receipts = await listCheckoutReceiptPaths(directory, sessionID);
	if (receipts.length === 0) return 0;
	// Preparation and restoration must agree on the exact durable obligation
	// set. Validate every existing receipt through the authoritative restore
	// reader before creating another stash; otherwise an ignored malformed or
	// missing-stash receipt can permit a new receipt that restore immediately
	// rejects, stranding the newly preserved changes.
	const parsed = await Promise.all(
		receipts.map(async (entry) => ({
			...entry,
			receipt: await readCheckoutRestoreReceipt(
				directory,
				entry.receiptPath,
				sessionID,
				entry.stashOid,
			),
		})),
	);
	const pending = parsed.filter(
		(entry) => entry.receipt.restoreState !== 'applied',
	);
	if (pending.length > 0) {
		let activeStashOids: Set<string>;
		try {
			activeStashOids = await readCurrentStashOids(directory);
		} catch {
			throw new Error(
				'BLOCKED: unable to inspect checkout-preparation receipts safely',
			);
		}
		const missing = pending.filter(
			(entry) => !activeStashOids.has(entry.stashOid),
		);
		if (missing.length > 0) {
			throw new CheckoutRestoreError(
				'CHECKOUT_RESTORE_STASH_MISSING',
				`BLOCKED: ${missing.length} existing checkout receipt(s) reference missing preserved stashes; no new checkout stash was created`,
			);
		}
	}
	return parsed.length;
}

async function readCurrentStashOids(directory: string): Promise<Set<string>> {
	const list = await _internals.runGit(
		directory,
		['stash', 'list', '--format=%H'],
		{ captureStdout: true },
	);
	if (list.exitCode !== 0) {
		throw new Error(
			'BLOCKED: unable to inspect checkout-preparation stashes safely',
		);
	}
	return new Set(
		list.stdout
			.split(/\r?\n/)
			.map((value) => value.trim().toLowerCase())
			.filter((value) => /^[0-9a-f]{40,64}$/i.test(value)),
	);
}

interface CheckoutRestoreReceipt extends CheckoutPreparation {
	schemaVersion: 1;
	sessionID: string;
	legacyIdentityDerived?: boolean;
	restoreState?: 'applied';
	restoreAppliedAt?: string;
	restoreVerifiedAt?: string;
	restoredHead?: string;
	restoredBranch?: string | null;
}

async function listCheckoutReceiptPaths(
	directory: string,
	sessionID: string,
): Promise<Array<{ stashOid: string; receiptPath: string }>> {
	const receiptDirectory = validateSwarmPath(
		directory,
		path.join(RECEIPT_DIR, prWorkflowSessionFileStem(sessionID)),
	);
	let handle: Awaited<ReturnType<typeof fsp.opendir>>;
	try {
		handle = await fsp.opendir(receiptDirectory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw new CheckoutRestoreError(
			'CHECKOUT_RESTORE_RECEIPT_READ_FAILED',
			'BLOCKED: unable to inspect checkout-restoration receipts safely',
		);
	}
	const receiptNames: string[] = [];
	let entriesRead = 0;
	let directoryMissing = false;
	let scanError: unknown;
	let closeError: unknown;
	try {
		for (;;) {
			const entry = await handle.read();
			if (!entry) break;
			entriesRead += 1;
			if (entriesRead > MAX_RECEIPT_DIRECTORY_ENTRIES) {
				throw new CheckoutRestoreError(
					'CHECKOUT_RESTORE_RECEIPT_LIMIT',
					`BLOCKED: checkout-restoration receipt directory exceeds the ${MAX_RECEIPT_DIRECTORY_ENTRIES}-entry bounded scan`,
				);
			}
			if (!entry.isFile() || !/^[0-9a-f]{40,64}\.json$/i.test(entry.name)) {
				continue;
			}
			receiptNames.push(entry.name);
			if (receiptNames.length > MAX_CHECKOUT_RECEIPTS) {
				throw new CheckoutRestoreError(
					'CHECKOUT_RESTORE_RECEIPT_LIMIT',
					`BLOCKED: more than ${MAX_CHECKOUT_RECEIPTS} checkout-restoration receipts exist for this session; reduce the receipt set through explicit manual recovery`,
				);
			}
		}
	} catch (error) {
		// Bun on Windows may defer the directory existence check until the first
		// `read()` call even after `opendir()` resolves. Preserve the same benign
		// absent-directory behavior as an ENOENT raised by `opendir()`, but only
		// before any entry has been observed.
		if (
			entriesRead === 0 &&
			(error as NodeJS.ErrnoException).code === 'ENOENT'
		) {
			directoryMissing = true;
		} else {
			scanError = error;
		}
	} finally {
		try {
			await handle.close();
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED' &&
				(error as NodeJS.ErrnoException).code !== 'ERR_INVALID_STATE'
			) {
				closeError = error;
			}
		}
	}
	if (directoryMissing) return [];
	if (scanError !== undefined) {
		if (scanError instanceof CheckoutRestoreError) throw scanError;
		throw new CheckoutRestoreError(
			'CHECKOUT_RESTORE_RECEIPT_READ_FAILED',
			'BLOCKED: unable to inspect checkout-restoration receipts safely',
		);
	}
	if (closeError !== undefined) {
		throw new CheckoutRestoreError(
			'CHECKOUT_RESTORE_RECEIPT_READ_FAILED',
			'BLOCKED: unable to close checkout-restoration receipt inventory safely',
		);
	}
	return receiptNames
		.sort((left, right) => left.localeCompare(right))
		.map((name) => ({
			stashOid: name.replace(/\.json$/i, '').toLowerCase(),
			receiptPath: validateSwarmPath(
				directory,
				path.join(RECEIPT_DIR, prWorkflowSessionFileStem(sessionID), name),
			),
		}));
}

async function readBoundedReceiptFile(receiptPath: string): Promise<string> {
	const handle = await fsp.open(receiptPath, 'r');
	try {
		const buffer = new Uint8Array(MAX_RECEIPT_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
		if (bytesRead > MAX_RECEIPT_BYTES) {
			throw new Error('receipt exceeds safe size limit');
		}
		return new TextDecoder().decode(buffer.subarray(0, bytesRead));
	} finally {
		await handle.close();
	}
}

async function readCheckoutRestoreReceipt(
	directory: string,
	receiptPath: string,
	expectedSessionID: string,
	expectedStashOid: string,
): Promise<CheckoutRestoreReceipt> {
	let value: unknown;
	try {
		value = JSON.parse(await readBoundedReceiptFile(receiptPath));
	} catch {
		throw new CheckoutRestoreError(
			'CHECKOUT_RESTORE_RECEIPT_INVALID',
			'BLOCKED: checkout-restoration receipt is unreadable or malformed; preserve the stash and recover manually',
		);
	}
	if (!value || typeof value !== 'object') {
		throw new CheckoutRestoreError(
			'CHECKOUT_RESTORE_RECEIPT_INVALID',
			'BLOCKED: checkout-restoration receipt is not an object; preserve the stash and recover manually',
		);
	}
	const receipt = value as Record<string, unknown>;
	if (
		receipt.schemaVersion !== 1 ||
		receipt.sessionID !== expectedSessionID ||
		typeof receipt.stashOid !== 'string' ||
		receipt.stashOid.toLowerCase() !== expectedStashOid ||
		!Array.isArray(receipt.paths) ||
		receipt.paths.length > MAX_RECEIPT_PATHS ||
		receipt.paths.some(
			(value) =>
				typeof value !== 'string' ||
				value.length === 0 ||
				value.length > MAX_RECEIPT_PATH_LEN,
		) ||
		typeof receipt.preparedAt !== 'string' ||
		receipt.preparedAt.length === 0 ||
		receipt.preparedAt.length > 64 ||
		(receipt.mode !== 'PR_REVIEW' && receipt.mode !== 'PR_FEEDBACK') ||
		!Number.isInteger(receipt.gateRevision) ||
		(receipt.gateRevision as number) < 0 ||
		typeof receipt.gateActivatedAt !== 'string' ||
		receipt.gateActivatedAt.length === 0 ||
		receipt.gateActivatedAt.length > 64 ||
		(receipt.discovered !== undefined &&
			typeof receipt.discovered !== 'boolean') ||
		(receipt.includedUntracked !== undefined &&
			typeof receipt.includedUntracked !== 'boolean') ||
		(receipt.pathsTruncated !== undefined &&
			typeof receipt.pathsTruncated !== 'boolean') ||
		(receipt.originalHead !== undefined &&
			(typeof receipt.originalHead !== 'string' ||
				!/^[0-9a-f]{40,64}$/i.test(receipt.originalHead))) ||
		(receipt.originalBranch !== undefined &&
			receipt.originalBranch !== null &&
			(typeof receipt.originalBranch !== 'string' ||
				!isSafeRecordedBranch(receipt.originalBranch))) ||
		(receipt.restoreState !== undefined &&
			receipt.restoreState !== 'applied') ||
		(receipt.restoreAppliedAt !== undefined &&
			(typeof receipt.restoreAppliedAt !== 'string' ||
				receipt.restoreAppliedAt.length === 0 ||
				receipt.restoreAppliedAt.length > 64)) ||
		(receipt.restoreVerifiedAt !== undefined &&
			(typeof receipt.restoreVerifiedAt !== 'string' ||
				receipt.restoreVerifiedAt.length === 0 ||
				receipt.restoreVerifiedAt.length > 64)) ||
		(receipt.restoreVerifiedAt !== undefined &&
			receipt.restoreState !== 'applied') ||
		(receipt.restoredHead !== undefined &&
			(typeof receipt.restoredHead !== 'string' ||
				!/^[0-9a-f]{40,64}$/i.test(receipt.restoredHead))) ||
		(receipt.restoredBranch !== undefined &&
			receipt.restoredBranch !== null &&
			(typeof receipt.restoredBranch !== 'string' ||
				!isSafeRecordedBranch(receipt.restoredBranch))) ||
		(receipt.restoreState === 'applied' &&
			(typeof receipt.restoreAppliedAt !== 'string' ||
				typeof receipt.restoredHead !== 'string' ||
				receipt.restoredBranch === undefined))
	) {
		throw new CheckoutRestoreError(
			'CHECKOUT_RESTORE_RECEIPT_INVALID',
			'BLOCKED: checkout-restoration receipt failed identity validation; preserve the stash and recover manually',
		);
	}
	if (
		typeof receipt.originalHead !== 'string' ||
		receipt.originalBranch === undefined
	) {
		return deriveLegacyCheckoutIdentity(
			directory,
			receipt as unknown as Omit<
				CheckoutRestoreReceipt,
				'originalHead' | 'originalBranch'
			>,
			expectedStashOid,
		);
	}
	return receipt as unknown as CheckoutRestoreReceipt;
}

async function deriveLegacyCheckoutIdentity(
	directory: string,
	receipt: Omit<CheckoutRestoreReceipt, 'originalHead' | 'originalBranch'>,
	stashOid: string,
): Promise<CheckoutRestoreReceipt> {
	const parent = await _internals.runGit(
		directory,
		['rev-parse', '--verify', `${stashOid}^1`],
		{ captureStdout: true },
	);
	const originalHead = parent.stdout.trim().toLowerCase();
	const type = await _internals.runGit(
		directory,
		['cat-file', '-t', originalHead],
		{ captureStdout: true },
	);
	if (
		parent.exitCode !== 0 ||
		!/^[0-9a-f]{40,64}$/i.test(originalHead) ||
		type.exitCode !== 0 ||
		type.stdout.trim() !== 'commit'
	) {
		throw new CheckoutRestoreError(
			'CHECKOUT_RESTORE_LEGACY_IDENTITY_UNRESOLVED',
			"BLOCKED: the legacy receipt's stash parent could not be resolved as a commit; preserve the stash and recover manually",
		);
	}
	const refs = await _internals.runGit(
		directory,
		[
			'for-each-ref',
			'--format=%(refname:short)%00%(objectname)',
			'refs/heads/',
		],
		{ captureStdout: true },
	);
	const matchingBranches =
		refs.exitCode === 0
			? refs.stdout
					.split(/\r?\n/)
					.map((line) => line.split('\0'))
					.filter(
						(parts) =>
							parts.length === 2 &&
							parts[1].toLowerCase() === originalHead &&
							isSafeRecordedBranch(parts[0]),
					)
					.map((parts) => parts[0])
			: [];
	return {
		...receipt,
		originalHead,
		originalBranch: matchingBranches.length === 1 ? matchingBranches[0] : null,
		legacyIdentityDerived: true,
	};
}

interface RestoreDestination {
	head: string;
	branch: string | null;
}

async function resolveRestoreDestination(
	directory: string,
	receipt: CheckoutRestoreReceipt,
): Promise<RestoreDestination> {
	const head = await _internals.runGit(
		directory,
		['rev-parse', '--verify', `${receipt.originalHead}^0`],
		{ captureStdout: true },
	);
	const type = await _internals.runGit(
		directory,
		['cat-file', '-t', receipt.originalHead],
		{ captureStdout: true },
	);
	if (
		head.exitCode !== 0 ||
		head.stdout.trim().toLowerCase() !== receipt.originalHead.toLowerCase() ||
		type.exitCode !== 0 ||
		type.stdout.trim() !== 'commit'
	) {
		throw new CheckoutRestoreError(
			'CHECKOUT_RESTORE_ORIGINAL_HEAD_MISSING',
			'BLOCKED: the original checkout commit no longer resolves exactly; no checkout mutation was attempted',
		);
	}
	if (receipt.originalBranch) {
		const branch = await _internals.runGit(
			directory,
			['rev-parse', '--verify', `refs/heads/${receipt.originalBranch}^0`],
			{ captureStdout: true },
		);
		const branchHead = branch.stdout.trim().toLowerCase();
		if (branch.exitCode !== 0 || !/^[0-9a-f]{40,64}$/i.test(branchHead)) {
			throw new CheckoutRestoreError(
				'CHECKOUT_RESTORE_BRANCH_DRIFT',
				`BLOCKED: original branch ${boundUntrustedPath(receipt.originalBranch)} no longer resolves safely; no checkout mutation was attempted`,
			);
		}
		if (branchHead !== receipt.originalHead.toLowerCase()) {
			if (receipt.mode !== 'PR_FEEDBACK') {
				throw new CheckoutRestoreError(
					'CHECKOUT_RESTORE_BRANCH_DRIFT',
					`BLOCKED: original branch ${boundUntrustedPath(receipt.originalBranch)} no longer points to the recorded original HEAD; no checkout mutation was attempted`,
				);
			}
			const ancestor = await _internals.runGit(directory, [
				'merge-base',
				'--is-ancestor',
				receipt.originalHead,
				`refs/heads/${receipt.originalBranch}`,
			]);
			if (ancestor.exitCode !== 0) {
				throw new CheckoutRestoreError(
					'CHECKOUT_RESTORE_BRANCH_DRIFT',
					`BLOCKED: PR_FEEDBACK branch ${boundUntrustedPath(receipt.originalBranch)} did not advance as a descendant of the recorded original HEAD; no checkout mutation was attempted`,
				);
			}
		}
		return { head: branchHead, branch: receipt.originalBranch };
	}
	return { head: receipt.originalHead.toLowerCase(), branch: null };
}

function sameRestoreDestination(
	left: RestoreDestination,
	right: RestoreDestination,
): boolean {
	return left.head === right.head && left.branch === right.branch;
}

async function markReceiptApplied(
	directory: string,
	receiptPath: string,
	receipt: CheckoutRestoreReceipt,
	destination: RestoreDestination,
): Promise<CheckoutRestoreReceipt> {
	const applied: CheckoutRestoreReceipt = {
		...receipt,
		restoreState: 'applied',
		restoreAppliedAt: new Date().toISOString(),
		restoredHead: destination.head,
		restoredBranch: destination.branch,
	};
	assertRestoreReceiptWithinByteBudget(applied);
	await writePrWorkflowAtomicJson(directory, receiptPath, applied);
	return applied;
}

async function markReceiptVerified(
	directory: string,
	receiptPath: string,
	receipt: CheckoutRestoreReceipt,
): Promise<CheckoutRestoreReceipt> {
	const verified: CheckoutRestoreReceipt = {
		...receipt,
		restoreVerifiedAt: new Date().toISOString(),
	};
	assertRestoreReceiptWithinByteBudget(verified);
	await writePrWorkflowAtomicJson(directory, receiptPath, verified);
	return verified;
}

async function appendRestoreEvent(
	directory: string,
	sessionID: string,
	receipt: CheckoutRestoreReceipt,
): Promise<void> {
	try {
		appendCoreEventSync(directory, {
			type: 'pr_workflow_checkout_restored',
			timestamp: new Date().toISOString(),
			sessionID,
			mode: receipt.mode,
			stashOid: receipt.stashOid,
			originalHead: receipt.originalHead,
			originalBranch: receipt.originalBranch,
		});
	} catch {
		// Receipt removal after verified restore is authoritative; audit is best-effort.
	}
}

async function removeCheckoutRestoreReceipt(
	receiptPath: string,
): Promise<void> {
	await fsp.rm(receiptPath);
}

async function restorePrWorkflowCheckout(
	directory: string,
	rawSessionID: string,
	requestedStashOid?: string,
): Promise<RestoreOutcome> {
	const sessionID = normalizeSessionID(rawSessionID);
	try {
		return await withInactivePrWorkflowCheckoutRestoreLock(
			directory,
			sessionID,
			async () => {
				const receipts = await listCheckoutReceiptPaths(directory, sessionID);
				if (receipts.length === 0) return { kind: 'already_restored' };
				const normalizedRequested = requestedStashOid?.toLowerCase();
				if (
					normalizedRequested &&
					receipts.filter((entry) => entry.stashOid === normalizedRequested)
						.length !== 1
				) {
					const available = receipts
						.slice(0, MAX_CHECKOUT_RECEIPTS)
						.map((entry) => entry.stashOid);
					throw new CheckoutRestoreError(
						'CHECKOUT_RESTORE_RECEIPT_AMBIGUOUS',
						`BLOCKED: no unique checkout receipt exists for stash ${normalizedRequested}; available stash_oid values: ${available.join(', ')}`,
					);
				}
				const targets = await Promise.all(
					receipts.map(async (target) => ({
						...target,
						receipt: await readCheckoutRestoreReceipt(
							directory,
							target.receiptPath,
							sessionID,
							target.stashOid,
						),
					})),
				);
				targets.sort(
					(left, right) =>
						left.receipt.preparedAt.localeCompare(right.receipt.preparedAt) ||
						left.stashOid.localeCompare(right.stashOid),
				);
				const verifiedCleanup = targets.filter(
					(entry) =>
						entry.receipt.restoreState === 'applied' &&
						typeof entry.receipt.restoreVerifiedAt === 'string',
				);
				const restoreTargets = targets.filter(
					(entry) =>
						entry.receipt.restoreState !== 'applied' ||
						typeof entry.receipt.restoreVerifiedAt !== 'string',
				);
				const applied = restoreTargets.filter(
					(entry) => entry.receipt.restoreState === 'applied',
				);
				const pending = restoreTargets.filter(
					(entry) => entry.receipt.restoreState !== 'applied',
				);
				let observedStashes: Set<string> | null = null;
				try {
					observedStashes = await readCurrentStashOids(directory);
				} catch {
					// A fully applied restoration does not depend on stash presence. Its
					// response reports retention as unverified instead of blocking cleanup.
				}
				let receiptCleanupPending = false;
				for (const target of verifiedCleanup) {
					try {
						await _internals.removeCheckoutRestoreReceipt(target.receiptPath);
					} catch {
						receiptCleanupPending = true;
					}
				}
				if (restoreTargets.length === 0) {
					const first = verifiedCleanup[0].receipt;
					return {
						kind: 'restored',
						stashOids: targets.map((entry) => entry.stashOid),
						retainedStashOids: observedStashes
							? targets
									.filter((entry) => observedStashes.has(entry.stashOid))
									.map((entry) => entry.stashOid)
							: [],
						stashRetentionVerified: observedStashes !== null,
						originalHead: first.originalHead,
						originalBranch: first.originalBranch,
						restoredHead: first.restoredHead!,
						receiptCleanupPending,
					};
				}
				const pendingDestinations = await Promise.all(
					pending.map((entry) =>
						resolveRestoreDestination(directory, entry.receipt),
					),
				);
				const appliedDestinations = applied.map((entry) => ({
					head: entry.receipt.restoredHead!,
					branch: entry.receipt.restoredBranch!,
				}));
				const destinations = [...appliedDestinations, ...pendingDestinations];
				const destination = destinations[0];
				if (
					destinations.some(
						(candidate) => !sameRestoreDestination(destination, candidate),
					)
				) {
					throw new CheckoutRestoreError(
						'CHECKOUT_RESTORE_DESTINATION_AMBIGUOUS',
						'BLOCKED: checkout receipts target different original checkouts; no switch or stash apply was attempted',
					);
				}
				if (pending.length > 0) {
					const activeStashes =
						observedStashes ?? (await readCurrentStashOids(directory));
					const missing = pending.filter(
						(entry) => !activeStashes.has(entry.stashOid),
					);
					if (missing.length > 0) {
						throw new CheckoutRestoreError(
							'CHECKOUT_RESTORE_STASH_MISSING',
							`BLOCKED: ${missing.length} preserved checkout stash(es) are missing; no checkout mutation was attempted`,
						);
					}
				}
				if (applied.length > 0) {
					let currentIdentity: CheckoutIdentity;
					try {
						currentIdentity = await captureCheckoutIdentity(directory);
					} catch {
						throw new CheckoutRestoreError(
							'CHECKOUT_RESTORE_VERIFY_FAILED',
							'BLOCKED: an applied checkout restoration could not be verified; its durable receipt remains for retry or manual recovery',
						);
					}
					if (
						currentIdentity.originalHead !== destination.head ||
						currentIdentity.originalBranch !== destination.branch
					) {
						throw new CheckoutRestoreError(
							'CHECKOUT_RESTORE_VERIFY_FAILED',
							'BLOCKED: an applied checkout restoration no longer matches its recorded destination; its durable receipt remains for manual recovery',
						);
					}
				} else if (applied.length === 0) {
					let status: Awaited<ReturnType<typeof readPorcelainStatus>>;
					try {
						status = await readPorcelainStatus(directory);
					} catch {
						throw new CheckoutRestoreError(
							'CHECKOUT_RESTORE_STATUS_FAILED',
							'BLOCKED: unable to verify a clean destination checkout; no restore was attempted',
						);
					}
					if (
						status.dirtyTrackedPaths.length > 0 ||
						status.untrackedPaths.length > 0 ||
						status.renameOrCopy
					) {
						throw new CheckoutRestoreError(
							'CHECKOUT_RESTORE_NOT_CLEAN',
							'BLOCKED: checkout restoration requires a clean destination working tree; no switch or stash apply was attempted',
						);
					}
					const switchResult = await _internals.runGit(
						directory,
						destination.branch
							? ['switch', '--', destination.branch]
							: ['switch', '--detach', destination.head],
					);
					if (switchResult.exitCode !== 0) {
						throw new CheckoutRestoreError(
							'CHECKOUT_RESTORE_SWITCH_FAILED',
							'BLOCKED: Git could not return to the recorded original checkout; the stash and receipt remain intact',
						);
					}
				}
				for (const target of pending) {
					const apply = await _internals.runGit(directory, [
						'stash',
						'apply',
						'--index',
						target.stashOid,
					]);
					if (apply.exitCode !== 0) {
						throw new CheckoutRestoreError(
							'CHECKOUT_RESTORE_APPLY_FAILED',
							`BLOCKED: Git could not reapply preserved stash ${target.stashOid}; its receipt and immutable stash remain for explicit manual recovery`,
						);
					}
					let appliedReceipt: CheckoutRestoreReceipt;
					try {
						appliedReceipt = await markReceiptApplied(
							directory,
							target.receiptPath,
							target.receipt,
							destination,
						);
					} catch {
						throw new CheckoutRestoreError(
							'CHECKOUT_RESTORE_APPLIED_STATE_WRITE_FAILED',
							`BLOCKED: preserved stash ${target.stashOid} was applied, but durable applied-state recording failed; inspect the working tree and retained stash manually`,
						);
					}
					target.receipt = appliedReceipt;
				}
				let restoredIdentity: CheckoutIdentity;
				try {
					restoredIdentity = await captureCheckoutIdentity(directory);
				} catch {
					throw new CheckoutRestoreError(
						'CHECKOUT_RESTORE_VERIFY_FAILED',
						'BLOCKED: checkout restoration completed but its final identity could not be verified; inspect the working tree and retained applied-state receipts manually',
					);
				}
				if (
					restoredIdentity.originalHead !== destination.head ||
					restoredIdentity.originalBranch !== destination.branch
				) {
					throw new CheckoutRestoreError(
						'CHECKOUT_RESTORE_VERIFY_FAILED',
						'BLOCKED: checkout restoration completed but its final identity could not be verified; inspect the working tree and retained applied-state receipts manually',
					);
				}
				for (const target of restoreTargets) {
					if (!target.receipt.restoreVerifiedAt) {
						try {
							target.receipt = await markReceiptVerified(
								directory,
								target.receiptPath,
								target.receipt,
							);
						} catch {
							throw new CheckoutRestoreError(
								'CHECKOUT_RESTORE_VERIFIED_STATE_WRITE_FAILED',
								'BLOCKED: checkout restoration was verified, but durable verified-state recording failed; retained applied-state receipts remain for retry',
							);
						}
					}
					await appendRestoreEvent(directory, sessionID, target.receipt);
					try {
						await _internals.removeCheckoutRestoreReceipt(target.receiptPath);
					} catch {
						receiptCleanupPending = true;
					}
				}
				let finalStashes: Set<string> | null = null;
				try {
					finalStashes = await readCurrentStashOids(directory);
				} catch {
					// Restoration is complete; report retention as unverified rather than
					// turning a post-restore inventory failure into a false restore failure.
				}
				const first = restoreTargets[0].receipt;
				return {
					kind: 'restored',
					stashOids: targets.map((entry) => entry.stashOid),
					retainedStashOids: finalStashes
						? targets
								.filter((entry) => finalStashes.has(entry.stashOid))
								.map((entry) => entry.stashOid)
						: [],
					stashRetentionVerified: finalStashes !== null,
					originalHead: first.originalHead,
					originalBranch: first.originalBranch,
					restoredHead: destination.head,
					receiptCleanupPending,
				};
			},
		);
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.includes('checkout restoration is allowed only after')
		) {
			throw new CheckoutRestoreError(
				'CHECKOUT_RESTORE_GATE_ACTIVE',
				error.message,
			);
		}
		if (
			error instanceof Error &&
			error.message.includes(
				'checkout restoration cannot mutate this project while session',
			)
		) {
			throw new CheckoutRestoreError(
				'CHECKOUT_RESTORE_OTHER_SESSION_ACTIVE',
				error.message,
			);
		}
		throw error;
	}
}

export async function listPendingPrWorkflowCheckoutRestores(
	directory: string,
	sessionID: string,
): Promise<PrWorkflowCheckoutRestoreInventoryItem[]> {
	const receipts = await listCheckoutReceiptPaths(
		directory,
		normalizeSessionID(sessionID),
	);
	if (receipts.length === 0) return [];
	let activeStashes: Set<string> | null = null;
	try {
		activeStashes = await readCurrentStashOids(directory);
	} catch {
		// Receipt identity remains actionable even if Git stash inventory is unavailable.
	}
	return receipts.map((receipt) => ({
		stash_oid: receipt.stashOid,
		stash_present: activeStashes?.has(receipt.stashOid) ?? null,
	}));
}

async function writeReceipt(
	directory: string,
	sessionID: string,
	preparation: CheckoutPreparation,
): Promise<void> {
	const receiptPath = validateSwarmPath(
		directory,
		path.join(
			RECEIPT_DIR,
			prWorkflowSessionFileStem(sessionID),
			`${preparation.stashOid}.json`,
		),
	);
	assertReceiptWithinByteBudget(sessionID, preparation);
	await writePrWorkflowAtomicJson(
		directory,
		receiptPath,
		buildReceiptDocument(sessionID, preparation),
	);
}

async function appendPreparationEvent(
	directory: string,
	sessionID: string,
	preparation: CheckoutPreparation,
): Promise<void> {
	try {
		appendCoreEventSync(directory, {
			type: 'pr_workflow_checkout_prepared',
			timestamp: preparation.preparedAt,
			sessionID,
			mode: preparation.mode,
			gateRevision: preparation.gateRevision,
			stashOid: preparation.stashOid,
			paths: preparation.paths,
		});
	} catch {
		// The receipt is authoritative. Audit detail must not recreate the deadlock.
	}
}

/**
 * Test-only seam for every Git invocation this file makes (stash push/list/show,
 * status). Originally added to serialize concurrent real-Git checkout
 * preparation in tests; now the single DI point so exit-code and malformed-output
 * failure branches can be exercised without a real git-command failure.
 */
export const _internals: {
	runGit: typeof runGit;
	readBoundedGitStdout: typeof readBoundedGitStdout;
	classifyGitState: typeof classifyPrWorkflowGitState;
	removeCheckoutRestoreReceipt: typeof removeCheckoutRestoreReceipt;
} = {
	runGit,
	readBoundedGitStdout,
	classifyGitState: classifyPrWorkflowGitState,
	removeCheckoutRestoreReceipt,
};

/**
 * Lightweight neutralizer for Git-derived path strings (git status output is
 * exactly as PR-author-controlled as a branch name or remote URL) before they
 * are echoed into a BLOCKED error message. Strips control/bidi characters (the
 * same ranges as containsControlChars) and markdown/HTML metacharacters, then
 * bounds length. Mirrors src/tools/pr-workflow-status.ts's `boundUntrusted`
 * helper, kept local here since that module is a separate change lane.
 */
function boundUntrustedPath(value: string): string {
	// Mirrors containsControlChars' exact codepoint ranges (C0/C1 controls plus
	// bidi override/isolate characters), applied character-by-character rather
	// than via a regex literal so the ranges being stripped stay unambiguous.
	let cleaned = '';
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0;
		const strip =
			code <= 0x1f ||
			(code >= 0x7f && code <= 0x9f) ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069) ||
			ch === '`' ||
			ch === '<' ||
			ch === '>';
		cleaned += strip ? ' ' : ch;
	}
	cleaned = cleaned.replace(/\s+/g, ' ').trim();
	return cleaned.length > MAX_ECHOED_PATH_LEN
		? `${cleaned.slice(0, MAX_ECHOED_PATH_LEN)}…`
		: cleaned;
}

function structuredRestoreInstruction(stashOid: string): string {
	return `After complete_pr_workflow or abort_pr_workflow clears the gate, call prepare_pr_workflow_checkout with operation=restore; stash_oid=${stashOid} may be supplied as an exact receipt assertion`;
}

function manualRecoveryInstruction(stashOid: string): string {
	return `manual recovery required: git stash apply --index ${stashOid}`;
}

export const prepare_pr_workflow_checkout: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Prepare or restore an auditable PR workflow checkout. Before binding, operation=prepare (the default) preserves dirty working-tree changes, records the original branch/HEAD and exact stash OID, and refuses unsafe state. After complete_pr_workflow or abort_pr_workflow clears the gate, one operation=restore call returns to the common recorded checkout and reapplies every pending receipt by immutable stash OID under the checkout mutation lock. Restored stashes remain as explicit safety backups because Git exposes no atomic identity-bound deletion for a non-top stash; the response lists retained_stash_oids. A PR_FEEDBACK branch may advance only as a descendant of its recorded commit; PR_REVIEW and detached identities remain exact. Legacy receipts derive the original commit from the stash and use a uniquely matching local branch when available. It refuses dirty, missing-stash, cross-session, divergent, or mixed-destination state without reset/clean. stash_oid is an optional exact receipt assertion, not a selector that leaves other receipts stranded. This tool never permits arbitrary stash commands.',
		args: {
			operation: PreparePrWorkflowCheckoutArgsSchema.shape.operation,
			paths: PreparePrWorkflowCheckoutArgsSchema.shape.paths,
			stash_oid: PreparePrWorkflowCheckoutArgsSchema.shape.stash_oid,
		},
		execute: executePreparePrWorkflowCheckout,
	});
