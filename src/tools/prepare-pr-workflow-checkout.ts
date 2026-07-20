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
const RECEIPT_DIR = 'pr-workflow-checkouts';

const PreparePrWorkflowCheckoutArgsSchema = z
	.object({
		paths: z.array(z.string().min(1).max(240)).min(1).max(32),
	})
	.strict();

interface CheckoutPreparation {
	stashOid: string;
	paths: string[];
	preparedAt: string;
	mode: 'PR_REVIEW' | 'PR_FEEDBACK';
	gateRevision: number;
	gateActivatedAt: string;
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
		const preparation = await preparePrWorkflowCheckout(
			directory,
			context.sessionID,
			parsed.data.paths,
		);
		return JSON.stringify({
			success: true,
			stash_oid: preparation.stashOid,
			paths: preparation.paths,
			recovery: recoveryInstruction(preparation.stashOid),
		});
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
	requestedPaths: readonly string[],
): Promise<CheckoutPreparation> {
	const sessionID = normalizeSessionID(rawSessionID);
	const paths = normalizePaths(directory, requestedPaths);
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
			return preparation;
		},
	);
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
): Promise<void> {
	const status = await readPorcelainStatus(directory);
	if (
		status.dirtyTrackedPaths.length > 0 ||
		status.untrackedPaths.length > 0 ||
		status.renameOrCopy
	) {
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
	options: { captureStdout?: boolean } = {},
): Promise<{ exitCode: number; stdout: string }> {
	const proc = bunSpawn(['git', '--literal-pathspecs', ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: options.captureStdout ? 'pipe' : 'ignore',
		stderr: 'ignore',
		timeout: GIT_TIMEOUT_MS,
	});
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

async function resolveMarkedStashOid(
	directory: string,
	stashMarker: string,
	paths: readonly string[],
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
		throw new Error(
			'BLOCKED: Git did not expose one uniquely identifiable checkout-preparation stash; do not continue to checkout until the requested changes are preserved manually',
		);
	}
	const stashOid = matching[0][0];
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
			'Before binding a PR_REVIEW or PR_FEEDBACK checkout, preserve explicitly named dirty tracked repository files in an auditable Git stash. This architect-only controller validates literal paths, uses a fixed safe Git argv, records the stash OID and recovery instructions under .swarm, and refuses after head binding or while workflow lanes are running. It never stashes untracked files and does not allow arbitrary git stash shell commands.',
		args: {
			paths: PreparePrWorkflowCheckoutArgsSchema.shape.paths,
		},
		execute: executePreparePrWorkflowCheckout,
	});
