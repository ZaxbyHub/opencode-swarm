import { Buffer } from 'node:buffer';
import { WRITE_TOOL_NAMES, type WriteToolName } from '../config/constants';
import {
	type ExtractCodeBlocksArgs,
	getOrPlanExtractCodeBlocks,
} from '../tools/file-extractor-planner';

export const MAX_PATCH_FIELD_BYTES = 1_000_000;
export const MAX_PATCH_AGGREGATE_BYTES = 2_000_000;

export type WriteTargetResolution =
	| { status: 'resolved'; paths: string[] }
	| { status: 'unverifiable'; reason: string };

export interface WriteTargetResolverContext {
	directory: string;
}

type WriteTargetResolver = (
	args: Record<string, unknown>,
	context: WriteTargetResolverContext,
) => WriteTargetResolution;

const SCALAR_PATH_KEYS = ['path', 'filePath', 'file', 'target'] as const;
const ARRAY_PATH_KEYS = ['files', 'paths', 'targetFiles'] as const;

/**
 * Field names a patch-family tool (`patch` / `apply_patch` /
 * `swarm_apply_patch`) may use to carry its patch payload. Issue #2059: models
 * and tool wrappers commonly emit `patchText`, `patch_text`, `patchPayload`,
 * `text`, or `content`; recognizing only `patch`/`input`/`diff` made the
 * resolver throw `WRITE TARGET UNVERIFIABLE: No patch payload was provided`
 * for valid diffs.
 *
 * Exported so the guardrail layer (`tool-before.ts`) can reuse the single
 * source of truth instead of drifting its own inline copies (the drift is what
 * hid the original bug — three copies of this list existed).
 *
 * Collision safety: the patch resolver only runs for tools in
 * `WRITE_TOOL_NAMES`, and `extract_code_blocks` (which uses `content`) routes
 * to `extractResolver`, not `patchResolver`. Any future `WRITE_TOOL_NAMES`
 * addition that uses `text` or `content` for a non-patch purpose must be
 * audited against this list.
 */
export const PATCH_PAYLOAD_KEYS = [
	'patch',
	'input',
	'diff',
	'patchText',
	'patch_text',
	'patchPayload',
	'text',
	'content',
] as const;

function unverifiable(reason: string): WriteTargetResolution {
	return { status: 'unverifiable', reason };
}

function dedupe(paths: Iterable<string>): string[] {
	return [...new Set(paths)];
}

function genericResolver(args: Record<string, unknown>): WriteTargetResolution {
	const paths: string[] = [];
	let observedTargetField = false;
	for (const key of SCALAR_PATH_KEYS) {
		if (!(key in args)) continue;
		observedTargetField = true;
		const value = args[key];
		if (
			typeof value !== 'string' ||
			value.trim() === '' ||
			containsControlCharacter(value)
		) {
			return unverifiable(`Malformed ${key} target`);
		}
		paths.push(value);
	}
	for (const key of ARRAY_PATH_KEYS) {
		if (!(key in args)) continue;
		observedTargetField = true;
		const value = args[key];
		if (
			!Array.isArray(value) ||
			value.some(
				(item) =>
					typeof item !== 'string' ||
					item.trim() === '' ||
					containsControlCharacter(item),
			)
		) {
			return unverifiable(`Malformed ${key} targets`);
		}
		paths.push(...(value as string[]));
	}
	if (!observedTargetField || paths.length === 0) {
		return unverifiable('No write target was provided');
	}
	return { status: 'resolved', paths: dedupe(paths) };
}

interface ParsedPatch {
	paths: string[];
	operations: Map<string, Set<string>>;
}

function normalizeComparisonPath(filePath: string): string {
	return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function containsControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function parseTarget(
	raw: string,
	stripGitPrefix: boolean,
): { path?: string; error?: string } {
	let value = raw.replace(/\r$/, '').split('\t', 1)[0]?.trim() ?? '';
	if (!value) return { error: 'Empty patch target' };
	if (value === '/dev/null') return {};
	if (
		value.startsWith('"') ||
		value.startsWith("'") ||
		value.endsWith('"') ||
		value.endsWith("'")
	) {
		return { error: `Quoted patch path is unsupported: ${value}` };
	}
	if (stripGitPrefix && /\s/.test(value)) {
		return { error: `Ambiguous whitespace in diff path: ${value}` };
	}
	if (stripGitPrefix && (value.startsWith('a/') || value.startsWith('b/'))) {
		value = value.slice(2);
	}
	if (!value || containsControlCharacter(value)) {
		return { error: 'Malformed patch target' };
	}
	return { path: value };
}

function parsePatchPayload(payload: string): ParsedPatch | string {
	const paths: string[] = [];
	const operations = new Map<string, Set<string>>();
	const add = (
		raw: string,
		operation: string,
		stripGitPrefix = false,
	): string | null => {
		const parsed = parseTarget(raw, stripGitPrefix);
		if (parsed.error) return parsed.error;
		if (!parsed.path) return null;
		paths.push(parsed.path);
		const key = normalizeComparisonPath(parsed.path);
		const existing = operations.get(key) ?? new Set<string>();
		existing.add(operation);
		operations.set(key, existing);
		return null;
	};

	const lines = payload.split('\n');
	const beginIndices: number[] = [];
	const endIndices: number[] = [];
	const nativeOperationIndices: number[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? '';
		const trimmed = line.trim();
		if (trimmed === '*** Begin Patch') beginIndices.push(index);
		if (trimmed === '*** End Patch') endIndices.push(index);
		if (
			/^\*\*\* (?:Update|Add|Delete) File:/i.test(line) ||
			/^\*\*\* Move (?:to|from):/i.test(line)
		) {
			nativeOperationIndices.push(index);
		}
	}
	// A payload is a Native Vibe Patch when it has a `*** Begin Patch` marker,
	// OR carries any native operation marker (`*** Update/Add/Delete File:` /
	// `*** Move to|from:` — these are unambiguous native syntax that never
	// appears in a unified-diff body, so their presence always demands native
	// framing), OR has a bare `*** End Patch` marker with NO unified-diff
	// headers. The last clause tolerates a model appending `*** End Patch` as a
	// stray trailer on an otherwise-standard unified diff (issue #2059) while
	// still failing closed on a genuinely malformed native patch that is missing
	// its begin marker. Operation markers are intentionally NOT relaxed: a
	// payload with `*** Update File:` and no begin marker is always a malformed
	// native patch, never a unified diff (this preserves the security guard at
	// `tests/unit/hooks/write-target-resolver.test.ts` "rejects unframed ...
	// native operations").
	const hasUnifiedHeaders = lines.some((l) => /^(---|\+\+\+)\s+/.test(l));
	const native =
		beginIndices.length > 0 ||
		nativeOperationIndices.length > 0 ||
		(!hasUnifiedHeaders && endIndices.length > 0);
	if (native) {
		if (beginIndices.length === 0)
			return 'Native patch is missing *** Begin Patch';
		if (endIndices.length === 0) return 'Native patch is missing *** End Patch';
		if (beginIndices.length !== 1 || endIndices.length !== 1)
			return 'Native patch framing must contain exactly one begin and end marker';
		const beginIndex = beginIndices[0] ?? -1;
		const endIndex = endIndices[0] ?? -1;
		if (beginIndex >= endIndex)
			return 'Native patch has invalid begin/end marker ordering';
		if (
			nativeOperationIndices.some(
				(index) => index <= beginIndex || index >= endIndex,
			)
		) {
			return 'Native patch contains an operation outside begin/end markers';
		}

		for (let index = beginIndex + 1; index < endIndex; index++) {
			const line = lines[index] ?? '';
			const match = line.match(/^\*\*\* (Update|Add|Delete) File:\s*(.*)$/);
			if (match) {
				const error = add(match[2] ?? '', (match[1] ?? '').toLowerCase());
				if (error) return error;
				continue;
			}
			const move = line.match(/^\*\*\* Move (?:to|from):\s*(.*)$/i);
			if (move) {
				const error = add(move[1] ?? '', 'move');
				if (error) return error;
			}
		}
	} else {
		for (const line of lines) {
			const git = line.match(/^diff --git\s+(.+)$/);
			if (git) {
				const remainder = git[1]?.trim() ?? '';
				if (remainder.startsWith('"') || remainder.startsWith("'")) {
					return 'Quoted diff --git paths are unsupported';
				}
				const parts = remainder.split(/\s+/);
				if (parts.length !== 2) return 'Malformed diff --git header';
				for (const part of parts) {
					const error = add(part, 'diff', true);
					if (error) return error;
				}
				continue;
			}
			const unified = line.match(/^(---|\+\+\+)\s+(.+)$/);
			if (unified) {
				const error = add(unified[2] ?? '', 'diff', true);
				if (error) return error;
				continue;
			}
			const rename = line.match(/^rename (from|to)\s+(.+)$/);
			if (rename) {
				const error = add(rename[2] ?? '', 'rename');
				if (error) return error;
			}
		}
	}

	if (paths.length === 0) return 'Patch contains no recognizable write targets';
	for (const [filePath, fileOperations] of operations) {
		if (fileOperations.has('add') && fileOperations.has('delete')) {
			return `Contradictory add/delete operations for ${filePath}`;
		}
	}
	return { paths: dedupe(paths), operations };
}

function patchResolver(
	args: Record<string, unknown>,
	_context: WriteTargetResolverContext,
	toolName: 'patch' | 'apply_patch' | 'swarm_apply_patch',
): WriteTargetResolution {
	const payloadGroups: Array<{ field: string; payloads: string[] }> = [];
	let aggregateBytes = 0;
	for (const field of PATCH_PAYLOAD_KEYS) {
		if (!(field in args)) continue;
		const value = args[field];
		if (typeof value !== 'string')
			return unverifiable(`Malformed ${field} payload`);
		payloadGroups.push({ field, payloads: [value] });
	}
	if ('cmd' in args) {
		const cmd = args.cmd;
		if (typeof cmd === 'string') {
			payloadGroups.push({ field: 'cmd', payloads: [cmd] });
		} else if (
			Array.isArray(cmd) &&
			cmd.every((item) => typeof item === 'string')
		) {
			const payloads = (cmd as string[]).filter((item, index) => {
				if (
					index === 0 &&
					/(?:^|[/\\])(?:apply_patch|patch)(?:\.exe)?$/i.test(item)
				)
					return false;
				return !(
					item.startsWith('-') &&
					!item.includes('\n') &&
					!item.includes('*** Begin Patch')
				);
			});
			payloadGroups.push({ field: 'cmd', payloads });
		} else {
			return unverifiable('Malformed cmd payload');
		}
	}

	if (payloadGroups.length === 0)
		return unverifiable('No patch payload was provided');
	const resolvedGroups: Array<{ field: string; paths: string[] }> = [];
	for (const group of payloadGroups) {
		if (group.payloads.length === 0)
			return unverifiable(`Empty ${group.field} payload`);
		const groupPaths: string[] = [];
		for (const payload of group.payloads) {
			const bytes = Buffer.byteLength(payload, 'utf8');
			if (bytes > MAX_PATCH_FIELD_BYTES) {
				return unverifiable(
					`Patch payload exceeds 1 MB (${group.field} field)`,
				);
			}
			aggregateBytes += bytes;
			if (aggregateBytes > MAX_PATCH_AGGREGATE_BYTES) {
				return unverifiable('Aggregate patch payload exceeds size limit');
			}
			const parsed = parsePatchPayload(payload);
			if (typeof parsed === 'string')
				return unverifiable(`${group.field}: ${parsed}`);
			groupPaths.push(...parsed.paths);
		}
		resolvedGroups.push({ field: group.field, paths: dedupe(groupPaths) });
	}

	const canonical = (paths: string[]) =>
		paths.map(normalizeComparisonPath).sort().join('\n');
	const expected = canonical(resolvedGroups[0]?.paths ?? []);
	if (resolvedGroups.some((group) => canonical(group.paths) !== expected)) {
		return unverifiable('Conflicting targets across patch payload fields');
	}
	const paths = resolvedGroups[0]?.paths ?? [];

	if (toolName === 'swarm_apply_patch') {
		const declared = args.files;
		if (
			!Array.isArray(declared) ||
			declared.some((item) => typeof item !== 'string' || item.trim() === '')
		) {
			return unverifiable('swarm_apply_patch requires a valid files array');
		}
		const declaredSet = new Set(
			(declared as string[]).map(normalizeComparisonPath),
		);
		if (
			paths.some(
				(filePath) => !declaredSet.has(normalizeComparisonPath(filePath)),
			)
		) {
			return unverifiable('Parsed patch target is missing from declared files');
		}
	}

	return { status: 'resolved', paths };
}

function extractResolver(
	args: Record<string, unknown>,
	context: WriteTargetResolverContext,
): WriteTargetResolution {
	const plan = getOrPlanExtractCodeBlocks(
		args as ExtractCodeBlocksArgs,
		context.directory,
	);
	if (plan.status === 'invalid') return unverifiable(plan.reason);
	if (plan.status === 'noop') {
		return plan.reason === 'no-code-blocks'
			? { status: 'resolved', paths: [] }
			: unverifiable('content is required');
	}
	return {
		status: 'resolved',
		paths: plan.files.map((file) => file.relativePath),
	};
}

const patch = (
	args: Record<string, unknown>,
	context: WriteTargetResolverContext,
) => patchResolver(args, context, 'patch');
const applyPatch = (
	args: Record<string, unknown>,
	context: WriteTargetResolverContext,
) => patchResolver(args, context, 'apply_patch');
const swarmApplyPatch = (
	args: Record<string, unknown>,
	context: WriteTargetResolverContext,
) => patchResolver(args, context, 'swarm_apply_patch');

/** One authoritative resolver per registered write tool. */
export const WRITE_TARGET_RESOLVERS = {
	write: genericResolver,
	edit: genericResolver,
	patch,
	apply_patch: applyPatch,
	swarm_apply_patch: swarmApplyPatch,
	create_file: genericResolver,
	insert: genericResolver,
	replace: genericResolver,
	append: genericResolver,
	prepend: genericResolver,
	extract_code_blocks: extractResolver,
} satisfies Record<WriteToolName, WriteTargetResolver>;

export function resolveWriteTargets(
	toolName: string,
	args: unknown,
	context: WriteTargetResolverContext,
): WriteTargetResolution {
	if (!(WRITE_TOOL_NAMES as readonly string[]).includes(toolName)) {
		return unverifiable(`Unknown write tool: ${toolName}`);
	}
	if (typeof args !== 'object' || args === null || Array.isArray(args)) {
		return unverifiable('Write tool arguments must be an object');
	}
	try {
		return WRITE_TARGET_RESOLVERS[toolName as WriteToolName](
			args as Record<string, unknown>,
			context,
		);
	} catch (error) {
		return unverifiable(
			`Target resolution failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}
