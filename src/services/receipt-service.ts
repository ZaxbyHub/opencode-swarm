import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandFailure } from '../commands/registry';
import {
	buildVerificationReceipt,
	type ReceiptKind,
	renderReceiptMarkdown,
} from '../evidence/receipt';
import {
	writeExportBundle,
	writeReceiptArtifact,
} from '../evidence/receipt-store';
import {
	formatReceiptVerifySummary,
	verifyReceiptBundle,
} from '../evidence/receipt-verify';

/**
 * `/swarm receipt` service layer (#2968 emission + #2970 verify).
 *
 * Usage:
 *   receipt <task|phase> <id> [--export]
 *   receipt --verify <bundle-dir | receipt.json>
 *
 * The verify arm returns a plain string on success (CLI exits 0) and a
 * `CommandFailure { exitCode: 1 }` on any typed failure — the structured
 * failure channel the CLI already maps. The tool path shares the same
 * classifier (the verify result itself), so `ok` can never disagree with
 * the command's classification.
 */

export interface ReceiptEmissionOutcome {
	format_version: string;
	receipt_hash: string;
	kind: ReceiptKind;
	unit_id: string;
	gate_count: number;
	artifact_count: number;
	json_path: string;
	md_path: string;
	bundle_dir: string | null;
	already_frozen: boolean;
}

/**
 * Resolve a user-supplied verify target to {receiptFile, artifactRoot}.
 * Relative targets resolve against `baseDir` when provided — the TOOL arm
 * passes `ctx.directory` (PRR-021 / AGENTS.md invariant 4: tools must not
 * resolve user paths against `process.cwd()`); the CLI arm keeps the
 * conventional process-cwd resolution. Empty/whitespace targets are refused
 * (FB-016: `path.resolve('')` would silently verify the CWD itself).
 */
export function resolveVerifyTarget(
	target: string,
	baseDir?: string,
): { receiptFile: string; artifactRoot: string } {
	if (target.trim() === '') {
		throw new Error('RECEIPT_VERIFY_TARGET_EMPTY: provide a bundle path');
	}
	const absolute =
		baseDir !== undefined
			? path.resolve(baseDir, target)
			: path.resolve(target);
	const stat = fs.existsSync(absolute) ? fs.statSync(absolute) : null;
	if (stat?.isDirectory()) {
		const receiptFile = path.join(absolute, 'receipt.json');
		return { receiptFile, artifactRoot: path.join(absolute, 'artifacts') };
	}
	return {
		receiptFile: absolute,
		artifactRoot: path.join(path.dirname(absolute), 'artifacts'),
	};
}

export async function executeReceiptVerify(
	target: string,
	baseDir?: string,
): Promise<{ ok: boolean; summary: string; result: unknown }> {
	const { receiptFile, artifactRoot } = resolveVerifyTarget(target, baseDir);
	const result = verifyReceiptBundle({ receiptFile, artifactRoot });
	return {
		ok: result.ok,
		summary: formatReceiptVerifySummary(target, result),
		result,
	};
}

export async function executeReceiptEmission(
	directory: string,
	kind: ReceiptKind,
	id: string,
	exportBundle: boolean,
): Promise<ReceiptEmissionOutcome> {
	const receipt = await buildVerificationReceipt(directory, kind, id);
	const written = await writeReceiptArtifact(directory, receipt);
	let bundleDir: string | null = null;
	if (exportBundle) {
		const bundle = await writeExportBundle(
			directory,
			written.receipt,
			renderReceiptMarkdown(written.receipt),
		);
		bundleDir = bundle.bundleDir;
	}
	return {
		format_version: written.receipt.format_version,
		receipt_hash: written.receipt.receipt_hash,
		kind: written.receipt.kind,
		unit_id: written.receipt.unit_id,
		gate_count: written.receipt.gates.length,
		artifact_count: written.receipt.artifacts.length,
		json_path: path.relative(directory, written.jsonPath).replaceAll('\\', '/'),
		md_path: path.relative(directory, written.mdPath).replaceAll('\\', '/'),
		bundle_dir: bundleDir
			? path.relative(directory, bundleDir).replaceAll('\\', '/')
			: null,
		already_frozen: written.alreadyFrozen,
	};
}

export async function handleReceiptCommand(
	directory: string,
	args: string[],
): Promise<string | CommandFailure> {
	if (args[0] === '--verify') {
		const target = args[1];
		// FB-007: the verify arm must not silently swallow trailing
		// emission-only arguments (`--export`, stray tokens) the way the
		// emission arm already rejects.
		if (!target || args.length > 2) {
			return {
				text: 'receipt --verify requires EXACTLY one bundle directory or receipt.json path',
				ok: false,
				exitCode: 1,
			};
		}
		if (target.trim() === '') {
			return {
				text: 'receipt --verify target must not be empty',
				ok: false,
				exitCode: 1,
			};
		}
		if (!fs.existsSync(path.resolve(target))) {
			return {
				text: `receipt verify target not found: ${target}`,
				ok: false,
				exitCode: 1,
			};
		}
		// Verify targets are FOREIGN by design (#2970: a fresh-clone bundle on
		// any machine) — the project-containment contract applies to emission
		// destinations, never to the two read-only verify roots.
		const absolute = path.resolve(target);
		const outcome = await executeReceiptVerify(absolute);
		if (!outcome.ok) {
			return { text: outcome.summary, ok: false, exitCode: 1 };
		}
		return outcome.summary;
	}

	const kind = args[0];
	const id = args[1];
	const exportBundle = args.includes('--export');
	if (
		(kind !== 'task' && kind !== 'phase') ||
		!id ||
		args.slice(2).some((arg) => arg !== '--export')
	) {
		return {
			text: 'usage: receipt <task|phase> <id> [--export] | receipt --verify <bundle>',
			ok: false,
			exitCode: 1,
		};
	}
	try {
		const outcome = await executeReceiptEmission(
			directory,
			kind,
			id,
			exportBundle,
		);
		const lines = [
			`receipt emitted: ${outcome.kind} ${outcome.unit_id}`,
			`format_version: ${outcome.format_version}`,
			`receipt_hash: ${outcome.receipt_hash}`,
			`gates: ${outcome.gate_count} | artifacts: ${outcome.artifact_count}`,
			`json: ${outcome.json_path}`,
			`markdown: ${outcome.md_path}`,
		];
		if (outcome.bundle_dir) {
			lines.push(`bundle: ${outcome.bundle_dir}`);
		}
		if (outcome.already_frozen) {
			lines.push('(identical durable state: existing frozen receipt returned)');
		}
		return lines.join('\n');
	} catch (error) {
		return {
			text: `receipt emission failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
			ok: false,
			exitCode: 1,
		};
	}
}
