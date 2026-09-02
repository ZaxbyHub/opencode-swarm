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
	ruleId?: string;
}

export interface CommandClassificationV1 {
	v: 1;
	originalDigest: string;
	aggregate: CommandRiskCategory;
	ambiguous: boolean;
	segments: readonly CommandSegmentClassificationV1[];
}

export interface SharedClassifierGuardrailBlockV1 {
	ruleId: string;
	category: Extract<CommandRiskCategory, 'catastrophic' | 'destructive'>;
	destructiveCategory: string;
	message: string;
}

type SharedGuardrailMode = 'immediate-block' | 'target-aware';

interface SharedGuardrailRule {
	mode: SharedGuardrailMode;
	destructiveCategory: string;
	message: string;
}

interface CommandClassifierRule {
	id: string;
	pattern: RegExp;
	reason?: string;
	liveGuardrail?: SharedGuardrailRule;
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

const CATASTROPHIC: readonly CommandClassifierRule[] = [
	{
		id: 'fork-bomb',
		pattern: /:\s*\(\s*\)\s*\{[^}]*\|[^}]*:/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'fork bomb',
			message:
				'BLOCKED: catastrophic shell operation detected by the shared command classifier; critic approval cannot waive this policy',
		},
	},
	{
		id: 'power-control',
		pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'system shutdown',
			message:
				'BLOCKED: catastrophic shell operation detected by the shared command classifier; critic approval cannot waive this policy',
		},
	},
	{
		id: 'mkfs-suffixed',
		pattern: /\bmkfs[./]/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'disk format',
			message:
				'BLOCKED: catastrophic shell operation detected by the shared command classifier; critic approval cannot waive this policy',
		},
	},
	{
		id: 'diskpart',
		pattern: /^diskpart(?:\.exe)?$/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'disk format',
			message:
				'BLOCKED: catastrophic shell operation detected by the shared command classifier; critic approval cannot waive this policy',
		},
	},
	{
		id: 'format-drive',
		pattern: /^format\s+[A-Za-z]:/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'disk format',
			message:
				'BLOCKED: catastrophic shell operation detected by the shared command classifier; critic approval cannot waive this policy',
		},
	},
	{
		id: 'vssadmin-delete',
		pattern: /^vssadmin(?:\.exe)?\s+delete\b/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'data wipe',
			message:
				'BLOCKED: catastrophic shell operation detected by the shared command classifier; critic approval cannot waive this policy',
		},
	},
	{
		id: 'wbadmin-delete',
		pattern: /^wbadmin(?:\.exe)?\s+delete\b/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'data wipe',
			message:
				'BLOCKED: catastrophic shell operation detected by the shared command classifier; critic approval cannot waive this policy',
		},
	},
	{
		id: 'bcdedit-delete',
		pattern: /^bcdedit(?:\.exe)?\s+\/delete\b/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'boot configuration delete',
			message:
				'BLOCKED: catastrophic shell operation detected by the shared command classifier; critic approval cannot waive this policy',
		},
	},
	{
		id: 'dd-data-wipe',
		pattern:
			/\bdd\b[^\n]*(?:of=\s*(?:\/dev\/|[A-Za-z]:)|if=\s*\/dev\/(?:zero|random|urandom))/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'data wipe',
			message:
				'BLOCKED: "dd" with destructive data-wipe parameters detected by the shared command classifier; critic approval cannot waive this policy',
		},
	},
	{
		id: 'git-push-force',
		pattern: /\bgit\s+push\b[^\n]*(?:--force(?!-with-lease)|\s-f\b)/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'force push',
			message:
				'BLOCKED: Force push detected — git push --force is not allowed (use --force-with-lease instead)',
		},
	},
	{
		id: 'curl-pipe-shell',
		pattern: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sh|bash|zsh|fish)\b/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'script pipe execution',
			message:
				'BLOCKED: catastrophic shell operation detected by the shared command classifier; critic approval cannot waive this policy',
		},
	},
];

const DESTRUCTIVE: readonly CommandClassifierRule[] = [
	{
		id: 'git-reset-hard',
		pattern: /\bgit\s+(?:-C\s+\S+\s+)?reset\s+--hard\b/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'git reset',
			message:
				'BLOCKED: "git reset --hard" detected — use --soft or --mixed with caution',
		},
	},
	{
		id: 'git-reset-mixed-target',
		pattern: /\bgit\s+(?:-C\s+\S+\s+)?reset\s+--mixed\s+\S+/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'git reset',
			message:
				'BLOCKED: "git reset --mixed" with a target branch/commit is not allowed',
		},
	},
	{
		id: 'git-clean-force',
		pattern: /\bgit\s+(?:-C\s+\S+\s+)?clean\s+-[^\s]*[fdx]/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'git clean',
			message:
				'BLOCKED: "git clean -fd" detected — permanently deletes untracked files and directories',
		},
	},
	{
		id: 'rm-recursive',
		pattern: /\brm\b[^\n]*(?:-[^\s]*[rf]|--recursive|--force)/i,
		liveGuardrail: {
			mode: 'target-aware',
			destructiveCategory: 'recursive delete',
			message: 'target-aware recursive delete',
		},
	},
	{
		id: 'windows-recursive-delete',
		pattern: /\b(?:rmdir|rd|del)(?:\.exe)?\b[^\n]*\/[sqf]/i,
		liveGuardrail: {
			mode: 'target-aware',
			destructiveCategory: 'recursive delete',
			message: 'target-aware Windows recursive delete',
		},
	},
	{
		id: 'powershell-recursive-delete',
		pattern: /\bRemove-Item\b[^\n]*(?:-Recurse|-Force)/i,
		liveGuardrail: {
			mode: 'target-aware',
			destructiveCategory: 'recursive remove',
			message: 'target-aware PowerShell recursive delete',
		},
	},
	{
		id: 'find-delete',
		pattern: /\bfind\b[^\n]*\s-delete\b/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'find delete',
			message:
				'BLOCKED: "find -delete" detected — dynamic delete expansion is not allowed from shell commands',
		},
	},
	{
		id: 'rsync-delete',
		pattern: /\brsync\b[^\n]*--delete(?:-after|-before|-during|-delay)?\b/i,
		liveGuardrail: {
			mode: 'target-aware',
			destructiveCategory: 'rsync delete',
			message: 'target-aware rsync delete',
		},
	},
	{
		id: 'docker-system-prune',
		pattern: /\bdocker\s+system\s+prune\b/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'docker prune',
			message:
				'BLOCKED: "docker system prune" detected — destructive container operation',
		},
	},
	{
		id: 'kubectl-delete',
		pattern: /\bkubectl\s+delete\b/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'kubectl delete',
			message:
				'BLOCKED: "kubectl delete" detected — destructive cluster operation',
		},
	},
	{
		id: 'sql-drop',
		pattern: /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'sql drop',
			message:
				'BLOCKED: SQL DROP command detected — destructive database operation',
		},
	},
	{
		id: 'sql-truncate',
		pattern: /\bTRUNCATE\s+TABLE\b/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'sql truncate',
			message:
				'BLOCKED: SQL TRUNCATE command detected — destructive database operation',
		},
	},
	{
		id: 'sed-config-rewrite',
		pattern: /\bsed\s+-i\b[^\n]*(?:biome\.json|oxlintrc|eslint)/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'config rewrite',
			message:
				'BLOCKED: in-place configuration rewrite detected — protected lint or policy config edit matched the shared command classifier',
		},
	},
	{
		id: 'sdelete',
		pattern: /^sdelete(?:\.exe)?\s+/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'secure delete',
			message:
				'BLOCKED: "sdelete" detected — secure file deletion (Sysinternals)',
		},
	},
	{
		id: 'fsutil-destructive',
		pattern:
			/^fsutil(?:\.exe)?\s+(?:reparsepoint\s+delete|file\s+setzerodata)\b/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'data wipe',
			message: 'BLOCKED: "fsutil" destructive subcommand detected',
		},
	},
	{
		id: 'takeown-recursive',
		pattern: /^takeown(?:\.exe)?\s+.*\/[rR]\b/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'ownership takeover',
			message:
				'BLOCKED: "takeown /R" (recursive ownership takeover) detected — often precedes destructive operations',
		},
	},
	{
		id: 'cipher-wipe',
		pattern: /^cipher(?:\.exe)?\s+\/[wW]\b/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'data wipe',
			message:
				'BLOCKED: "cipher /w" detected — overwrites free disk space (data wipe operation)',
		},
	},
	{
		id: 'robocopy-mirror',
		pattern: /^robocopy(?:\.exe)?\s+.*\/(?:MIR|mir)\b/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'mirror sync',
			message:
				'BLOCKED: "robocopy /MIR" (mirror) detected — can delete files in the destination that do not exist in the source',
		},
	},
	{
		id: 'chmod-permission-wipe',
		pattern: /^chmod\s+.*-[rR]\b.*000\b/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'permission wipe',
			message:
				'BLOCKED: "chmod -R 000" detected — removes all permissions recursively',
		},
	},
	{
		id: 'chattr-immutable',
		pattern: /^chattr\s+.*\+i\b/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'immutable flag',
			message: 'BLOCKED: "chattr +i" detected — makes files immutable',
		},
	},
	{
		id: 'icacls-deny',
		pattern: /^icacls(?:\.exe)?\s+.*\/deny\b/i,
		liveGuardrail: {
			mode: 'immediate-block',
			destructiveCategory: 'permission deny',
			message:
				'BLOCKED: "icacls /deny" detected — denies filesystem permissions',
		},
	},
];

const ESCALATE: readonly CommandClassifierRule[] = [
	{
		id: 'sudo-network-permissions',
		pattern: /\b(?:sudo|chmod|chown|curl|wget|ssh|scp|sftp|nc|netcat)\b/i,
	},
	{ id: 'dynamic-eval', pattern: /\b(?:eval|Invoke-Expression|iex)\b/i },
];

const SAFE: readonly CommandClassifierRule[] = [
	{
		id: 'safe-readonly-shell',
		pattern:
			/^(?:cat|head|tail|file|stat|wc|sort|uniq|cut|grep|rg|ag|ls|pwd|whoami|hostname|uname|date|which|type|tree)\b/i,
	},
	{
		id: 'safe-readonly-git',
		pattern:
			/^git\s+(?:-C\s+\S+\s+)?(?:status|log|show|diff|branch|describe|rev-parse|rev-list|ls-files|remote\s+-v)\b/i,
	},
	{ id: 'safe-shell-builtin', pattern: /^(?:true|false|test|echo|printf)\b/i },
	{
		id: 'safe-package-scripts',
		pattern:
			/^(?:bun|npm|yarn|pnpm)\s+(?:run\s+(?:typecheck|lint|test|build)|test|typecheck|lint)\b/i,
	},
];

const BLOCK_RULES_BY_ID = new Map(
	[...CATASTROPHIC, ...DESTRUCTIVE].map((rule) => [rule.id, rule]),
);

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

function matchRule(
	rules: readonly CommandClassifierRule[],
	segment: string,
): CommandClassifierRule | null {
	for (const rule of rules) {
		if (rule.pattern.test(segment)) return rule;
	}
	return null;
}

function classifySegment(
	segment: string,
	ambiguous: boolean,
): CommandSegmentClassificationV1 {
	const bounded = segment.slice(0, MAX_EVIDENCE_CHARS);
	const catastrophic = matchRule(CATASTROPHIC, segment);
	if (catastrophic)
		return {
			segment: bounded,
			category: 'catastrophic',
			reason: catastrophic.reason ?? catastrophic.pattern.source,
			ruleId: catastrophic.id,
		};
	const destructive = matchRule(DESTRUCTIVE, segment);
	if (destructive)
		return {
			segment: bounded,
			category: 'destructive',
			reason: destructive.reason ?? destructive.pattern.source,
			ruleId: destructive.id,
		};
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
	const escalate = matchRule(ESCALATE, segment);
	if (escalate)
		return {
			segment: bounded,
			category: 'escalate',
			reason: escalate.reason ?? escalate.pattern.source,
			ruleId: escalate.id,
		};
	const safe = matchRule(SAFE, segment);
	if (safe)
		return {
			segment: bounded,
			category: 'safe',
			reason: safe.reason ?? safe.pattern.source,
			ruleId: safe.id,
		};
	return {
		segment: bounded,
		category: 'unknown',
		reason: 'command is not in the bounded classifier corpus',
	};
}

export function getSharedClassifierGuardrailBlock(
	classification: Readonly<CommandClassificationV1>,
): Readonly<SharedClassifierGuardrailBlockV1> | null {
	if (
		classification.aggregate !== 'catastrophic' &&
		classification.aggregate !== 'destructive'
	) {
		return null;
	}
	for (const segment of classification.segments) {
		if (
			segment.category !== classification.aggregate ||
			typeof segment.ruleId !== 'string'
		) {
			continue;
		}
		const rule = BLOCK_RULES_BY_ID.get(segment.ruleId);
		if (!rule?.liveGuardrail || rule.liveGuardrail.mode !== 'immediate-block') {
			continue;
		}
		return Object.freeze({
			ruleId: rule.id,
			category: classification.aggregate,
			destructiveCategory: rule.liveGuardrail.destructiveCategory,
			message: rule.liveGuardrail.message,
		});
	}
	return null;
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
