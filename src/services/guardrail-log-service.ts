import { redactPath } from '../hooks/guardrails/audit-log.js';
import { redactShellCommand } from '../hooks/guardrails/helpers.js';
import {
	getShellAuditFoldedSummary,
	readShellAuditTail,
} from '../hooks/guardrails/shell-audit-store.js';

export interface GuardrailLogEntry {
	ts: string;
	type?: string;
	sessionID: string;
	agent: string;
	tool: string;
	command?: string;
	path?: string;
	/** 16-hex sha256 fingerprint of the redacted command (typed entries only);
	 *  rendered as a correlation suffix so duplicate/related decisions can be
	 *  linked without repeating command content. */
	commandHash?: string;
}

const BLOCK_TYPES = new Set<string>([
	'file_write',
	'scope_violation',
	'destructive_block',
]);

/** Bounded output: only the most recent N entries are rendered, with an
 *  explicit footer disclosing the cap (issue #2040 requirement 3: stable,
 *  bounded output). */
const MAX_RENDERED_ENTRIES = 200;

/** Per-rendered-line character cap for the diagnostic display. */
const MAX_RENDERED_LINE_CHARS = 512;

function isBlockEntry(entry: GuardrailLogEntry): boolean {
	if (entry.type === null || entry.type === undefined) return false;
	return BLOCK_TYPES.has(entry.type);
}

function redactSummary(entry: GuardrailLogEntry): string {
	if (entry.type === 'file_write' || entry.type === 'scope_violation') {
		const raw = entry.path ?? '';
		return redactPath(raw);
	}

	if (
		entry.type === 'destructive_block' ||
		entry.type === 'sandbox_wrap' ||
		entry.type === 'sandbox_skip' ||
		entry.type === 'shell' ||
		entry.type === null ||
		entry.type === undefined
	) {
		const raw = entry.command ?? '';
		return redactShellCommand(raw);
	}

	return '';
}

/**
 * Display sanitization (issue #2040 edge case: newline/control/ANSI/bidi
 * injection). Strips C0/C1 control characters EXCEPT tab — including LF/CR,
 * so stored multi-line commands cannot forge additional markdown lines —
 * ANSI CSI escape sequences, bidirectional-override controls, and invisible
 * zero-width/format characters from every rendered field so stored bytes
 * cannot re-shape or forge the markdown output.
 */
function sanitizeDisplayText(value: string): string {
	return (
		value
			// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars to strip them
			.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '') // ANSI CSI sequences
			// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars to strip them
			.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g, '') // C0/C1 minus tab (LF included — line forgery)
			.replace(/[\u202a-\u202e\u2066-\u2069]/g, '') // bidi overrides / isolates
			.replace(/[\u200e\u200f\u200b-\u200d\u2060-\u2064\ufeff]/g, '') // LRM/RLM + zero-width/format/BOM
	);
}

function formatEntry(entry: GuardrailLogEntry): string {
	const decisionType = entry.type ?? 'shell';
	const summary = redactSummary(entry);

	let line = `- [${sanitizeDisplayText(entry.ts)}] ${sanitizeDisplayText(
		decisionType,
	)} | agent: ${sanitizeDisplayText(entry.agent)} | ${sanitizeDisplayText(summary)}`;
	// Fingerprint suffix (issue #2040 requirement 5): the persisted hash
	// correlates repeated/related decisions without repeating content.
	if (entry.commandHash !== undefined) {
		line += ` · fp:${sanitizeDisplayText(entry.commandHash)}`;
	}
	return line.length > MAX_RENDERED_LINE_CHARS
		? `${line.slice(0, MAX_RENDERED_LINE_CHARS)}…`
		: line;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value.constructor === Object || Object.getPrototypeOf(value) === null)
	);
}

function parseEntries(raw: string): GuardrailLogEntry[] {
	const lines = raw.split(/\r?\n/);
	const entries: GuardrailLogEntry[] = [];

	for (const line of lines) {
		if (line.trim().length === 0) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}

		if (!isPlainObject(parsed)) continue;
		if (typeof parsed.ts !== 'string') continue;
		if (typeof parsed.sessionID !== 'string') continue;
		if (typeof parsed.agent !== 'string') continue;
		if (typeof parsed.tool !== 'string') continue;

		const entry: GuardrailLogEntry = {
			ts: parsed.ts,
			sessionID: parsed.sessionID,
			agent: parsed.agent,
			tool: parsed.tool,
		};

		if (typeof parsed.type === 'string') {
			entry.type = parsed.type;
		}
		if (typeof parsed.command === 'string') {
			entry.command = parsed.command;
		}
		if (typeof parsed.path === 'string') {
			entry.path = parsed.path;
		}
		if (typeof parsed.commandHash === 'string') {
			entry.commandHash = parsed.commandHash;
		}

		entries.push(entry);
	}

	return entries;
}

export async function handleGuardrailLog(
	directory: string,
	args: string[],
): Promise<string> {
	// BOUNDED READ (issue #2040 requirement 3): the newest readMaxBytes of the
	// store, never the whole file. Legacy records re-redact at render time
	// through the CURRENT policy (redactSummary) — no legacy bypass.
	const window = readShellAuditTail(directory);
	const entries = parseEntries(window.text);

	const blocksOnly = args.includes('--blocks-only');

	if (entries.length === 0) {
		// A manifest-present store whose window is fully folded still has
		// history — disclose it instead of claiming nothing was recorded.
		const folded = getShellAuditFoldedSummary(directory);
		if (folded !== null && folded.totalDecisions > 0) {
			const note = `${folded.totalDecisions} earlier decision(s) compacted into the audit manifest.`;
			return blocksOnly
				? `No guardrail block decisions in the read window; ${note}`
				: `No guardrail decisions in the read window; ${note}`;
		}
		return blocksOnly
			? 'No guardrail block decisions recorded yet.'
			: 'No guardrail decisions recorded yet.';
	}

	const filtered = blocksOnly ? entries.filter(isBlockEntry) : entries;

	if (filtered.length === 0) {
		// Folded history can still contain matching decisions (review round
		// RC-1): a store whose blocks were all compacted into the manifest must
		// disclose them, not claim none were recorded. Consult the manifest
		// whenever the FILTERED result is empty, not only when the window is.
		const folded = getShellAuditFoldedSummary(directory);
		if (blocksOnly && folded !== null) {
			const foldedBlocks = [...BLOCK_TYPES].reduce(
				(sum, type) => sum + (folded.byType[type] ?? 0),
				0,
			);
			if (foldedBlocks > 0) {
				return `No guardrail block decisions in the read window; ${foldedBlocks} earlier block decision(s) compacted into the audit manifest.`;
			}
		}
		if (blocksOnly) {
			return 'No guardrail block decisions recorded yet.';
		}
		return 'No guardrail decisions recorded yet.';
	}

	filtered.sort((a, b) => {
		const diff = b.ts.localeCompare(a.ts);
		return diff === 0 ? 0 : diff;
	});

	const rendered = filtered.slice(0, MAX_RENDERED_ENTRIES);

	const header = blocksOnly
		? '# Guardrail Block Log (most-recent-first)'
		: '# Guardrail Decision Log (most-recent-first)';

	const body = rendered.map(formatEntry).join('\n');

	// Bounded disclosure footer (issue #2040: coverage gaps are explicit).
	const notes: string[] = [];
	if (rendered.length < filtered.length) {
		notes.push(
			`showing ${rendered.length} most recent of ${filtered.length} matching entries in the read window`,
		);
	}
	if (window.truncated || window.coverage === 'truncated') {
		notes.push(
			`read window truncated to the newest bounded tail (older decisions may exist beyond it)`,
		);
	}
	const folded = getShellAuditFoldedSummary(directory);
	if (folded !== null && folded.totalDecisions > 0) {
		notes.push(
			`${folded.totalDecisions} earlier decision(s) already compacted into the audit manifest (lifetime total)`,
		);
	}

	if (notes.length === 0) {
		return `${header}\n\n${body}`;
	}
	return `${header}\n\n${body}\n\n---\n${notes.join('; ')}.`;
}
