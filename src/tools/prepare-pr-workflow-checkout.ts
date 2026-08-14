import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
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
import { containsControlChars } from '../utils/path-security.js';
import { createSwarmTool } from './create-tool.js';

const GIT_TIMEOUT_MS = 30_000;
const MAX_CHECKOUT_PATHS = 32;
const MAX_CHECKOUT_RECEIPTS = 8;
const MAX_RECEIPT_PATHS = 64;
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
			stashOid: string;
			originalHead: string;
			originalBranch: string | null;
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
				stash_oid: outcome.stashOid,
				original_head: outcome.originalHead,
				original_branch: outcome.originalBranch,
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
			recovery: recoveryInstruction(preparation.stashOid),
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
				preparedAt: new Date().toISOString(),
				mode: gate.mode,
				gateRevision: gate.revision,
				gateActivatedAt: gate.activatedAt,
			};
			try {
				await writeReceipt(directory, sessionID, preparation);
			} catch (error) {
				throw new Error(
					`BLOCKED: stash ${stashOid} was created but its durable checkout-preparation receipt could not be recorded (${error instanceof Error ? error.message : String(error)}). Do not continue; ${recoveryInstruction(stashOid)}.`,
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

	const discoveredPaths = [
		...status.dirtyTrackedPaths,
		...status.untrackedPaths,
	].sort();
	const pathsTruncated = discoveredPaths.length > MAX_RECEIPT_PATHS;
	const receiptPaths = pathsTruncated
		? discoveredPaths.slice(0, MAX_RECEIPT_PATHS)
		: discoveredPaths;

	const preparation: CheckoutPreparation = {
		stashOid,
		...checkoutIdentity,
		paths: receiptPaths,
		preparedAt: new Date().toISOString(),
		mode: gate.mode,
		gateRevision: gate.revision,
		gateActivatedAt: gate.activatedAt,
		discovered: true,
		includedUntracked,
		pathsTruncated,
	};
	try {
		await writeReceipt(directory, sessionID, preparation);
	} catch (error) {
		throw new Error(
			`BLOCKED: stash ${stashOid} was created but its durable checkout-preparation receipt could not be recorded (${error instanceof Error ? error.message : String(error)}). Do not continue; ${recoveryInstruction(stashOid)}.`,
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
	const filePath = validateSwarmPath(directory, 'background-delegations.jsonl');
	let raw: string;
	try {
		raw = await fsp.readFile(filePath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
		throw new Error(
			'BLOCKED: unable to inspect PR workflow lanes; cannot safely prepare checkout',
		);
	}
	const latestByCorrelationID = new Map<
		string,
		{ parentSessionId: string; mode?: unknown; status: string }
	>();
	for (const rawLine of raw.split('\n')) {
		const line = rawLine.trim();
		if (!line) continue;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			throw new Error(
				'BLOCKED: PR workflow lane registry is malformed; cannot safely prepare checkout',
			);
		}
		if (
			typeof record !== 'object' ||
			record === null ||
			typeof (record as { correlationId?: unknown }).correlationId !==
				'string' ||
			typeof (record as { parentSessionId?: unknown }).parentSessionId !==
				'string' ||
			typeof (record as { status?: unknown }).status !== 'string'
		) {
			throw new Error(
				'BLOCKED: PR workflow lane registry is invalid; cannot safely prepare checkout',
			);
		}
		const typed = record as {
			correlationId: string;
			parentSessionId: string;
			mode?: unknown;
			status: string;
		};
		if (typed.parentSessionId === sessionID && typeof typed.mode !== 'string') {
			throw new Error(
				'BLOCKED: active-session lane metadata is invalid; cannot safely prepare checkout',
			);
		}
		latestByCorrelationID.set(typed.correlationId, typed);
	}
	return [...latestByCorrelationID.values()].filter(
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
			`BLOCKED: stash ${stashOid} was created, but the post-stash working-tree status could not be verified (${error instanceof Error ? error.message : String(error)}). Do not continue; ${recoveryInstruction(stashOid)} and resolve manually.`,
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
				`BLOCKED: stash ${stashOid} was created, but the checkout is still not clean (remaining: ${remainingText}). Submodule pointer changes are not preserved by --include-untracked and must be resolved manually. Do not continue; ${recoveryInstruction(stashOid)} and resolve manually.`,
			);
		}
		throw new Error(
			`BLOCKED: stash ${stashOid} was created, but the checkout is still not clean. Do not continue; ${recoveryInstruction(stashOid)} and resolve manually.`,
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
	if (branch.exitCode !== 0 && branch.exitCode !== 1) {
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
): Promise<{ exitCode: number; stdout: string }> {
	// `--literal-pathspecs` is on by default so every user-supplied pathspec (explicit
	// mode's `-- <paths>`) is treated as a literal, defeating glob/magic-pathspec
	// injection. Discovery's `stash push --include-untracked` carries NO pathspec, and
	// `git --literal-pathspecs stash push -u` has an empirically-confirmed quirk (git
	// 2.43) where untracked files are recorded in the stash but NOT removed from the
	// working tree — leaving `assertCleanWorkingTree` to (correctly) reject a tree that
	// plain `git stash push -u` would have cleaned. That call opts out via
	// `literalPathspecs: false`; it is safe because its argv is entirely fixed literals.
	const literalPathspecs = options.literalPathspecs ?? true;
	const proc = bunSpawn(
		['git', ...(literalPathspecs ? ['--literal-pathspecs'] : []), ...args],
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
			options.captureStdout ? proc.stdout.text() : Promise.resolve(''),
		]);
		return { exitCode, stdout };
	} finally {
		try {
			proc.kill();
		} catch {
			// Best-effort cleanup; Git may already have exited.
		}
	}
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
			`BLOCKED: stash ${stashOid} does not contain exactly the requested checkout-preparation paths; do not continue. ${recoveryInstruction(stashOid)} and resolve manually.`,
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
	let activeStashOids: Set<string>;
	try {
		activeStashOids = await readCurrentStashOids(directory);
	} catch {
		throw new Error(
			'BLOCKED: unable to inspect checkout-preparation receipts safely',
		);
	}
	return receipts.filter((receipt) => activeStashOids.has(receipt.stashOid))
		.length;
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
	schemaVersion: number;
	sessionID: string;
	legacyIdentityDerived?: boolean;
}

async function listCheckoutReceiptPaths(
	directory: string,
	sessionID: string,
): Promise<Array<{ stashOid: string; receiptPath: string }>> {
	const receiptDirectory = validateSwarmPath(
		directory,
		path.join(RECEIPT_DIR, prWorkflowSessionFileStem(sessionID)),
	);
	try {
		const entries = await fsp.readdir(receiptDirectory, {
			withFileTypes: true,
		});
		return entries
			.filter(
				(entry) =>
					entry.isFile() && /^[0-9a-f]{40,64}\.json$/i.test(entry.name),
			)
			.map((entry) => ({
				stashOid: entry.name.replace(/\.json$/i, '').toLowerCase(),
				receiptPath: validateSwarmPath(
					directory,
					path.join(
						RECEIPT_DIR,
						prWorkflowSessionFileStem(sessionID),
						entry.name,
					),
				),
			}));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw new CheckoutRestoreError(
			'CHECKOUT_RESTORE_RECEIPT_READ_FAILED',
			'BLOCKED: unable to inspect checkout-restoration receipts safely',
		);
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
		value = JSON.parse(await fsp.readFile(receiptPath, 'utf8'));
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
		receipt.sessionID !== expectedSessionID ||
		typeof receipt.stashOid !== 'string' ||
		receipt.stashOid.toLowerCase() !== expectedStashOid ||
		!Array.isArray(receipt.paths) ||
		typeof receipt.preparedAt !== 'string' ||
		(receipt.mode !== 'PR_REVIEW' && receipt.mode !== 'PR_FEEDBACK') ||
		typeof receipt.gateRevision !== 'number' ||
		typeof receipt.gateActivatedAt !== 'string' ||
		(receipt.originalHead !== undefined &&
			(typeof receipt.originalHead !== 'string' ||
				!/^[0-9a-f]{40,64}$/i.test(receipt.originalHead))) ||
		(receipt.originalBranch !== undefined &&
			receipt.originalBranch !== null &&
			(typeof receipt.originalBranch !== 'string' ||
				!isSafeRecordedBranch(receipt.originalBranch)))
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

async function resolveExactStashRef(
	directory: string,
	stashOid: string,
): Promise<string> {
	const list = await _internals.runGit(
		directory,
		['stash', 'list', '--format=%gd%x00%H'],
		{ captureStdout: true },
	);
	if (list.exitCode !== 0) {
		throw new CheckoutRestoreError(
			'CHECKOUT_RESTORE_STASH_READ_FAILED',
			'BLOCKED: unable to inspect the preserved stash before restoration',
		);
	}
	const matches = list.stdout
		.split(/\r?\n/)
		.map((line) => line.split('\0'))
		.filter(
			(parts) =>
				parts.length === 2 &&
				/^stash@\{\d+\}$/.test(parts[0]) &&
				parts[1].toLowerCase() === stashOid,
		);
	if (matches.length !== 1) {
		throw new CheckoutRestoreError(
			'CHECKOUT_RESTORE_STASH_MISSING',
			`BLOCKED: preserved stash ${stashOid} is missing or ambiguous; no checkout mutation was attempted`,
		);
	}
	return matches[0][0];
}

async function assertOriginalCheckoutExists(
	directory: string,
	receipt: CheckoutRestoreReceipt,
): Promise<void> {
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
		if (
			branch.exitCode !== 0 ||
			branch.stdout.trim().toLowerCase() !== receipt.originalHead.toLowerCase()
		) {
			throw new CheckoutRestoreError(
				'CHECKOUT_RESTORE_BRANCH_DRIFT',
				`BLOCKED: original branch ${boundUntrustedPath(receipt.originalBranch)} no longer points to the recorded original HEAD; no checkout mutation was attempted`,
			);
		}
	}
}

async function appendRestoreEvent(
	directory: string,
	sessionID: string,
	receipt: CheckoutRestoreReceipt,
): Promise<void> {
	try {
		const eventsPath = validateSwarmPath(directory, 'events.jsonl');
		await fsp.appendFile(
			eventsPath,
			`${JSON.stringify({
				type: 'pr_workflow_checkout_restored',
				timestamp: new Date().toISOString(),
				sessionID,
				mode: receipt.mode,
				stashOid: receipt.stashOid,
				originalHead: receipt.originalHead,
				originalBranch: receipt.originalBranch,
			})}\n`,
			'utf8',
		);
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
				const selected = normalizedRequested
					? receipts.filter((entry) => entry.stashOid === normalizedRequested)
					: receipts;
				if (selected.length !== 1) {
					const available = receipts.map((entry) => entry.stashOid);
					throw new CheckoutRestoreError(
						'CHECKOUT_RESTORE_RECEIPT_AMBIGUOUS',
						normalizedRequested
							? `BLOCKED: no unique checkout receipt exists for stash ${normalizedRequested}; available stash_oid values: ${available.join(', ')}`
							: `BLOCKED: multiple checkout receipts remain; retry with one exact stash_oid: ${available.join(', ')}`,
					);
				}
				const target = selected[0];
				const receipt = await readCheckoutRestoreReceipt(
					directory,
					target.receiptPath,
					sessionID,
					target.stashOid,
				);
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
						'BLOCKED: checkout restoration requires a clean destination working tree; no switch or stash pop was attempted',
					);
				}
				const stashRef = await resolveExactStashRef(directory, target.stashOid);
				await assertOriginalCheckoutExists(directory, receipt);
				const switchResult = await _internals.runGit(
					directory,
					receipt.originalBranch
						? ['switch', '--', receipt.originalBranch]
						: ['switch', '--detach', receipt.originalHead],
				);
				if (switchResult.exitCode !== 0) {
					throw new CheckoutRestoreError(
						'CHECKOUT_RESTORE_SWITCH_FAILED',
						'BLOCKED: Git could not return to the recorded original checkout; the stash and receipt remain intact',
					);
				}
				const pop = await _internals.runGit(directory, [
					'stash',
					'pop',
					'--index',
					stashRef,
				]);
				if (pop.exitCode !== 0) {
					throw new CheckoutRestoreError(
						'CHECKOUT_RESTORE_POP_FAILED',
						`BLOCKED: Git could not reapply preserved stash ${target.stashOid}; the receipt remains for manual recovery`,
					);
				}
				const restoredIdentity = await captureCheckoutIdentity(directory);
				const activeStashes = await readCurrentStashOids(directory);
				if (
					restoredIdentity.originalHead !==
						receipt.originalHead.toLowerCase() ||
					restoredIdentity.originalBranch !== receipt.originalBranch ||
					activeStashes.has(target.stashOid)
				) {
					throw new CheckoutRestoreError(
						'CHECKOUT_RESTORE_VERIFY_FAILED',
						'BLOCKED: checkout restoration completed but its final identity could not be verified; inspect the working tree and retained receipt manually',
					);
				}
				let receiptCleanupPending = false;
				try {
					await _internals.removeCheckoutRestoreReceipt(target.receiptPath);
				} catch {
					receiptCleanupPending = true;
				}
				await appendRestoreEvent(directory, sessionID, receipt);
				return {
					kind: 'restored',
					stashOid: target.stashOid,
					originalHead: receipt.originalHead,
					originalBranch: receipt.originalBranch,
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
	await writePrWorkflowAtomicJson(directory, receiptPath, {
		schemaVersion: 1,
		sessionID,
		...preparation,
	});
}

async function appendPreparationEvent(
	directory: string,
	sessionID: string,
	preparation: CheckoutPreparation,
): Promise<void> {
	try {
		const eventsPath = validateSwarmPath(directory, 'events.jsonl');
		await fsp.appendFile(
			eventsPath,
			`${JSON.stringify({
				type: 'pr_workflow_checkout_prepared',
				timestamp: preparation.preparedAt,
				sessionID,
				mode: preparation.mode,
				gateRevision: preparation.gateRevision,
				stashOid: preparation.stashOid,
				paths: preparation.paths,
			})}\n`,
			'utf-8',
		);
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
	classifyGitState: typeof classifyPrWorkflowGitState;
	removeCheckoutRestoreReceipt: typeof removeCheckoutRestoreReceipt;
} = {
	runGit,
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

function recoveryInstruction(stashOid: string): string {
	return `After complete_pr_workflow or abort_pr_workflow clears the gate, restore only these preserved changes with: git stash apply --index ${stashOid}`;
}

export const prepare_pr_workflow_checkout: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Prepare or restore an auditable PR workflow checkout. Before binding, operation=prepare (the default) preserves dirty working-tree changes, records the original branch/HEAD and exact stash OID, and refuses unsafe state. After complete_pr_workflow or abort_pr_workflow clears the gate, operation=restore returns to that exact checkout and pops the preserved stash under the same mutation lock; legacy receipts derive the original commit from the stash and use a uniquely matching local branch when available. It refuses dirty, ambiguous, missing-stash, or drifted state without reset/clean. Provide stash_oid from checkout_restore_receipts only to disambiguate multiple receipts. This tool never permits arbitrary stash commands.',
		args: {
			operation: PreparePrWorkflowCheckoutArgsSchema.shape.operation,
			paths: PreparePrWorkflowCheckoutArgsSchema.shape.paths,
			stash_oid: PreparePrWorkflowCheckoutArgsSchema.shape.stash_oid,
		},
		execute: executePreparePrWorkflowCheckout,
	});
