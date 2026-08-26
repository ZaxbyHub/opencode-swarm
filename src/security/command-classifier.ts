/**
 * Shared best-effort shell command classifier (issue #1824).
 *
 * This is a tripwire, not a parser or security boundary. Consumers retain
 * their own target, scope, approval, and sandbox policy. Ambiguous syntax can
 * never become `safe`.
 */
import { createHash } from 'node:crypto';
import {
	dcNormalizeCommand,
	dcSplitSegments,
	dcUnwrapWrappers,
} from '../hooks/guardrails/destructive-command.js';

export type CommandRiskCategory =
	| 'catastrophic'
	| 'destructive'
	| 'unknown'
	| 'escalate'
	| 'safe';

export interface CommandSegmentClassificationV1 {
	segment: string;
	category: CommandRiskCategory;
	reason: string;
}

export interface CommandClassificationV1 {
	v: 1;
	originalDigest: string;
	aggregate: CommandRiskCategory;
	ambiguous: boolean;
	segments: readonly CommandSegmentClassificationV1[];
}

const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_SEGMENTS = 128;
const MAX_EVIDENCE_CHARS = 512;

const SEVERITY: Record<CommandRiskCategory, number> = {
	safe: 0,
	escalate: 1,
	unknown: 2,
	destructive: 3,
	catastrophic: 4,
};

const CATASTROPHIC: readonly RegExp[] = [
	/:\s*\(\s*\)\s*\{[^}]*\|[^}]*:/i,
	/\b(?:shutdown|reboot|halt|poweroff)\b/i,
	/\bmkfs[./]/i,
	/^diskpart(?:\.exe)?$/i,
	/^format\s+[A-Za-z]:/i,
	/^vssadmin(?:\.exe)?\s+delete\b/i,
	/^wbadmin(?:\.exe)?\s+delete\b/i,
	/^bcdedit(?:\.exe)?\s+\/delete\b/i,
	/\bdd\b[^\n]*(?:of=\s*(?:\/dev\/|[A-Za-z]:)|if=\s*\/dev\/(?:zero|random|urandom))/i,
	/\bgit\s+push\b[^\n]*--force(?!-with-lease)/i,
	/\b(?:curl|wget)\b[^|\n]*\|\s*(?:sh|bash|zsh|fish)\b/i,
];

const DESTRUCTIVE: readonly RegExp[] = [
	/\bgit\s+(?:-C\s+\S+\s+)?(?:reset\s+--hard|clean\s+-[^\s]*[fdx])/i,
	/\brm\b[^\n]*(?:-[^\s]*[rf]|--recursive|--force)/i,
	/\b(?:rmdir|rd|del)(?:\.exe)?\b[^\n]*\/[sqf]/i,
	/\bRemove-Item\b[^\n]*(?:-Recurse|-Force)/i,
	/\bfind\b[^\n]*\s-delete\b/i,
	/\b(?:rsync\b[^\n]*--delete|docker\s+system\s+prune|kubectl\s+delete)\b/i,
	/\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i,
	/\bsed\s+-i\b[^\n]*(?:biome\.json|oxlintrc|eslint)/i,
];

const ESCALATE: readonly RegExp[] = [
	/\b(?:sudo|chmod|chown|curl|wget|ssh|scp|sftp|nc|netcat)\b/i,
	/\b(?:eval|Invoke-Expression|iex)\b/i,
];

const SAFE: readonly RegExp[] = [
	/^(?:cat|head|tail|file|stat|wc|sort|uniq|cut|grep|rg|ag|ls|pwd|whoami|hostname|uname|date|which|type|tree)\b/i,
	/^git\s+(?:-C\s+\S+\s+)?(?:status|log|show|diff|branch|describe|rev-parse|rev-list|ls-files|remote\s+-v)\b/i,
	/^(?:true|false|test|echo|printf)\b/i,
	/^(?:bun|npm|yarn|pnpm)\s+(?:run\s+(?:typecheck|lint|test|build)|test|typecheck|lint)\b/i,
];

function digest(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function hasAmbiguousSyntax(value: string): boolean {
	let single = false;
	let double = false;
	let escaped = false;
	for (const character of value) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === '\\') {
			escaped = true;
			continue;
		}
		if (character === "'" && !double) single = !single;
		if (character === '"' && !single) double = !double;
	}
	return (
		single ||
		double ||
		escaped ||
		/<<[-]?\s*\w+/.test(value) ||
		/\$\(|`|\$\{?|\$IFS\b/i.test(value)
	);
}

function classifySegment(
	segment: string,
	ambiguous: boolean,
): CommandSegmentClassificationV1 {
	const bounded = segment.slice(0, MAX_EVIDENCE_CHARS);
	for (const pattern of CATASTROPHIC) {
		if (pattern.test(segment))
			return {
				segment: bounded,
				category: 'catastrophic',
				reason: pattern.source,
			};
	}
	for (const pattern of DESTRUCTIVE) {
		if (pattern.test(segment))
			return {
				segment: bounded,
				category: 'destructive',
				reason: pattern.source,
			};
	}
	if (
		ambiguous ||
		/[<>]|\|\s*(?:sh|bash|zsh|fish|pwsh|powershell|cmd)\b/i.test(segment)
	) {
		return {
			segment: bounded,
			category: 'unknown',
			reason: 'ambiguous shell syntax',
		};
	}
	for (const pattern of ESCALATE) {
		if (pattern.test(segment))
			return { segment: bounded, category: 'escalate', reason: pattern.source };
	}
	for (const pattern of SAFE) {
		if (pattern.test(segment))
			return { segment: bounded, category: 'safe', reason: pattern.source };
	}
	return {
		segment: bounded,
		category: 'unknown',
		reason: 'command is not in the bounded classifier corpus',
	};
}

export function classifyCommand(
	original: string,
): Readonly<CommandClassificationV1> {
	const originalDigest = digest(
		typeof original === 'string' ? original : String(original),
	);
	if (typeof original !== 'string' || original.length === 0) {
		return Object.freeze({
			v: 1,
			originalDigest,
			aggregate: 'unknown',
			ambiguous: true,
			segments: Object.freeze([]),
		});
	}
	if (Buffer.byteLength(original, 'utf8') > MAX_COMMAND_BYTES) {
		return Object.freeze({
			v: 1,
			originalDigest,
			aggregate: 'unknown',
			ambiguous: true,
			segments: Object.freeze([]),
		});
	}
	const normalized = dcNormalizeCommand(original);
	const unwrapped = dcUnwrapWrappers(normalized);
	const candidates = [
		...new Set([
			normalized,
			unwrapped,
			...dcSplitSegments(normalized),
			...dcSplitSegments(unwrapped),
			...dcSplitSegments(normalized).map(dcUnwrapWrappers),
		]),
	];
	if (candidates.length === 0 || candidates.length > MAX_SEGMENTS) {
		return Object.freeze({
			v: 1,
			originalDigest,
			aggregate: 'unknown',
			ambiguous: true,
			segments: Object.freeze([]),
		});
	}
	const ambiguous = hasAmbiguousSyntax(normalized);
	const segments = candidates.map((segment) =>
		classifySegment(segment.trim(), ambiguous),
	);
	const aggregate = segments.reduce<CommandRiskCategory>(
		(highest, current) =>
			SEVERITY[current.category] > SEVERITY[highest]
				? current.category
				: highest,
		'safe',
	);
	const frozenSegments = Object.freeze(
		segments.map((segment) => Object.freeze(segment)),
	) as readonly CommandSegmentClassificationV1[];
	return Object.freeze({
		v: 1,
		originalDigest,
		aggregate,
		ambiguous,
		segments: frozenSegments,
	});
}
