import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import {
	prWorkflowSessionFileStem,
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
const RECEIPT_DIR = 'pr-workflow-checkouts';

const PreparePrWorkflowCheckoutArgsSchema = z
	.object({
		// Optional: an explicit path set selects EXPLICIT mode (exact dirty-tracked
		// match); omitting `paths` selects DISCOVERY mode (stash all dirt, including
		// untracked). An empty array is still rejected so a present `paths` cannot
		// silently degrade into discovery.
		paths: z.array(z.string().min(1).max(240)).min(1).max(32).optional(),
	})
	.strict();

interface CheckoutPreparation {
	stashOid: string;
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
	| { kind: 'prepared'; preparation: CheckoutPreparation };

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
		async (gate) => {
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
				return prepareDiscoveredCheckout(directory, sessionID, gate);
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
			`BLOCKED: checkout preparation refuses untracked churn under .swarm/ (${swarmUntracked.slice(0, 5).join(', ')}); that directory must stay git-excluded (.git/info/exclude). Resolve the .swarm/ tracking regression before preparing a checkout.`,
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
	const status = await readPorcelainStatus(directory);
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
					? remaining.join(', ')
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
	const result = await runGit(
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
	const list = await runGit(
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
	const changed = await runGit(
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
		throw new Error(
			`BLOCKED: stash ${stashOid} does not contain exactly the requested checkout-preparation paths; do not continue and recover it manually`,
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
	const receiptDirectory = validateSwarmPath(
		directory,
		path.join(RECEIPT_DIR, prWorkflowSessionFileStem(sessionID)),
	);
	try {
		const entries = await fsp.readdir(receiptDirectory, {
			withFileTypes: true,
		});
		const receiptOids = entries
			.filter(
				(entry) =>
					entry.isFile() && /^[0-9a-f]{40,64}\.json$/i.test(entry.name),
			)
			.map((entry) => entry.name.replace(/\.json$/i, '').toLowerCase());
		if (receiptOids.length === 0) return 0;
		const activeStashOids = await readCurrentStashOids(directory);
		return receiptOids.filter((oid) => activeStashOids.has(oid)).length;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
		throw new Error(
			'BLOCKED: unable to inspect checkout-preparation receipts safely',
		);
	}
}

async function readCurrentStashOids(directory: string): Promise<Set<string>> {
	const list = await runGit(directory, ['stash', 'list', '--format=%H'], {
		captureStdout: true,
	});
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
	await fsp.mkdir(path.dirname(receiptPath), { recursive: true });
	await writePrWorkflowAtomicJson(receiptPath, {
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

/** Test-only seam for serializing concurrent real-Git checkout preparation. */
export const _internals: {
	runGit: typeof runGit;
} = {
	runGit,
};

function recoveryInstruction(stashOid: string): string {
	return `After complete_pr_workflow or abort_pr_workflow clears the gate, restore only these preserved changes with: git stash apply --index ${stashOid}`;
}

export const prepare_pr_workflow_checkout: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Before binding a PR_REVIEW or PR_FEEDBACK checkout, preserve dirty working-tree changes in an auditable Git stash so the unbound checkout cannot lose them. Provide `paths` to preserve an exact set of named dirty tracked files (untracked files are refused in this explicit mode). Omit `paths` for self-discovery mode: it reads the full working-tree status and stashes every dirty tracked AND untracked change (git stash push --include-untracked); an already-clean tree is a no-op that writes no stash and no receipt. Untracked churn under .swarm/ is refused because that directory must stay git-excluded. This architect-only controller uses a fixed safe Git argv, records the stash OID and recovery instructions under .swarm, and refuses after head binding or while workflow lanes are running. It does not allow arbitrary git stash shell commands.',
		args: {
			paths: PreparePrWorkflowCheckoutArgsSchema.shape.paths,
		},
		execute: executePreparePrWorkflowCheckout,
	});
