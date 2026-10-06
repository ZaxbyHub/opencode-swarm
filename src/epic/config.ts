/**
 * Epic Mode config — the ONE place that knows where Epic settings live.
 *
 * Canonical path: the top-level `epic` block of `opencode-swarm.json`
 * (`{ "epic": { "mode": { "enabled": true } } }`). It needs no `turbo` block:
 * Epic Mode is its own mode, not a Turbo overlay.
 *
 * Legacy path: `turbo.epic` (Epic v1 and Epic v2 before C9). It is accepted
 * PERMANENTLY — there is no removal date — and handled in two layers:
 *
 *  1. Raw config (the loader, `src/config/loader.ts` step 0, and the raw
 *     re-reads in `/swarm config doctor`): {@link migrateLegacyEpicConfig}
 *     moves `turbo.epic` to top-level `epic` in EACH config file BEFORE the
 *     user + project files are merged and before Zod parsing. Within one
 *     file the move is a per-key deep merge in which that file's top-level
 *     `epic` wins every key both set; across files the normal precedence
 *     applies afterwards (project over user), whichever path each file used.
 *     Doing it on the raw object is what makes the merge exact (after
 *     parsing, schema defaults are indistinguishable from keys the user
 *     wrote). The `turbo` block left behind is unchanged apart from losing
 *     `epic`, and is dropped when nothing else was in it — so a legacy
 *     `turbo.epic` no longer needs `turbo.strategy`. The loader warns once
 *     when any file carries `turbo.epic` ({@link LEGACY_EPIC_CONFIG_WARNING}),
 *     names recovered keys that came from it `… (from turbo.epic)`
 *     ({@link annotateLegacyEpicKeys}), and `/swarm config doctor` reports
 *     `legacy-epic-config-path` per file (report-only), naming validation
 *     issues at the path the user wrote ({@link legacyEpicIssuePath}).
 *  2. Parsed config: {@link resolveEpicConfig} returns `config.epic`, falling
 *     back to `config.turbo.epic` for a config parsed WITHOUT the loader
 *     (direct `PluginConfigSchema.parse`, tests). When a parsed config carries
 *     both, the top-level block wins whole — the per-key merge needs the raw
 *     config and is the loader's job.
 *
 * Every Epic config reader goes through {@link resolveEpicConfig} (directly or
 * via `config-gate.ts`). This module has no runtime imports, so the loader and
 * shared files can use it without pulling in Epic code.
 */
import type { EpicConfig } from '../config/schema.js';

/** Advisory printed once per config-advisory dedup window (process / session start). */
export const LEGACY_EPIC_CONFIG_WARNING =
	'[opencode-swarm] turbo.epic is deprecated — move it to top-level epic ' +
	'(`{ "epic": { "mode": { "enabled": true } } }`; no `turbo` block or ' +
	'`turbo.strategy` is needed). The legacy path keeps working: its keys are ' +
	'used where top-level `epic` does not set them. See docs/configuration.md (Epic Mode).';

/**
 * The parts of a parsed config Epic settings can live in. Generic over the
 * Epic block's shape so structural mini-configs (e.g. the Full-Auto
 * classifier input) resolve through the same function as `PluginConfig`.
 */
export type EpicConfigSource<E = EpicConfig> =
	| { epic?: E | null; turbo?: { epic?: E | null } | null }
	| null
	| undefined;

/**
 * The effective Epic settings of a parsed config: top-level `epic`, else the
 * legacy `turbo.epic` (see the module doc for the per-key merge). `undefined`
 * when neither is set — every Epic gate then reads as off.
 */
export function resolveEpicConfig<E = EpicConfig>(
	config: EpicConfigSource<E>,
): E | undefined {
	return config?.epic ?? config?.turbo?.epic ?? undefined;
}

/**
 * Master gate: `epic.mode.enabled === true` (absent block ⇒ false). Pure; the
 * directory-keyed variant and the disabled message live in `config-gate.ts`,
 * which re-exports this.
 */
export function isEpicModeConfigEnabled(
	config: EpicConfigSource<{ mode?: { enabled?: boolean } | null }>,
): boolean {
	return resolveEpicConfig(config)?.mode?.enabled === true;
}

/** Co-change gate: `epic.cochange.enabled === true` (absent block ⇒ false). */
export function isEpicCochangeConfigEnabled(
	config: EpicConfigSource<{ cochange?: { enabled?: boolean } | null }>,
): boolean {
	return resolveEpicConfig(config)?.cochange?.enabled === true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Per-key deep merge: `winner` keeps every key it sets (plain objects recurse). */
function mergeWinnerFirst(
	loser: Record<string, unknown>,
	winner: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...loser };
	for (const [key, value] of Object.entries(winner)) {
		const prior = Object.hasOwn(out, key) ? out[key] : undefined;
		// defineProperty, not assignment: an own `__proto__` key (JSON.parse
		// makes one) must stay an own key so the loader's dangerous-key merge
		// refusal still sees it.
		Object.defineProperty(out, key, {
			value:
				isPlainRecord(prior) && isPlainRecord(value)
					? mergeWinnerFirst(prior, value)
					: value,
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return out;
}

/** True when a raw (pre-parse) config carries the legacy `turbo.epic` key. */
export function hasLegacyEpicConfig(raw: unknown): boolean {
	return (
		isPlainRecord(raw) &&
		isPlainRecord(raw.turbo) &&
		Object.hasOwn(raw.turbo, 'epic')
	);
}

/**
 * Move a raw config's legacy `turbo.epic` to top-level `epic` (module doc,
 * layer 1). Returns the SAME object when there is no legacy key — a non-Epic
 * config is never copied or changed. A non-object legacy value is moved as-is
 * when top-level `epic` is absent (so validation reports it at `epic`), and
 * dropped when top-level `epic` is set (top-level wins). Applied per config
 * FILE, before the user and project files are merged.
 */
export function migrateLegacyEpicConfig(
	raw: Record<string, unknown>,
): Record<string, unknown> {
	if (!hasLegacyEpicConfig(raw)) return raw;
	const { epic: legacy, ...turboRest } = raw.turbo as Record<string, unknown>;
	const top = raw.epic;
	let epic: unknown;
	if (top === undefined) epic = legacy;
	else if (isPlainRecord(top) && isPlainRecord(legacy)) {
		epic = mergeWinnerFirst(legacy, top);
	} else epic = top;
	const { turbo: _turbo, ...rest } = raw;
	return {
		...rest,
		...(Object.keys(turboRest).length > 0 ? { turbo: turboRest } : {}),
		epic,
	};
}

function ownPathExists(node: unknown, path: readonly string[]): boolean {
	let current = node;
	for (const key of path) {
		if (!isPlainRecord(current) || !Object.hasOwn(current, key)) return false;
		current = current[key];
	}
	return true;
}

/**
 * The path a validation issue of a MIGRATED raw config file should be reported
 * at, given the file as the user wrote it: an `epic.*` path maps back to
 * `turbo.epic.*` when the file set only the legacy path (no top-level `epic`).
 * Every other path — and every path of a file without `turbo.epic` — is
 * returned unchanged.
 */
export function legacyEpicIssuePath(
	raw: unknown,
	path: readonly PropertyKey[],
): PropertyKey[] {
	if (
		path[0] !== 'epic' ||
		!hasLegacyEpicConfig(raw) ||
		Object.hasOwn(raw as Record<string, unknown>, 'epic')
	) {
		return [...path];
	}
	return ['turbo', ...path];
}

/**
 * Label recovered config keys that came from a legacy `turbo.epic` block:
 * `epic.<k>` becomes `epic.<k> (from turbo.epic)` when `<k>` was written under
 * `turbo.epic` in one of `rawFiles` (as the user wrote them, before
 * migration) and under no top-level `epic`; the whole `epic` section gets
 * the label when some file had `turbo.epic` and none had top-level `epic`.
 * Returns `keys` itself when no file carries `turbo.epic`.
 */
export function annotateLegacyEpicKeys(
	keys: string[],
	rawFiles: readonly unknown[],
): string[] {
	const legacy = rawFiles.filter(hasLegacyEpicConfig) as Array<
		Record<string, Record<string, unknown>>
	>;
	if (legacy.length === 0) return keys;
	const tops = rawFiles.filter(
		(raw) => isPlainRecord(raw) && Object.hasOwn(raw, 'epic'),
	) as Array<Record<string, unknown>>;
	return keys.map((key) => {
		if (key !== 'epic' && !key.startsWith('epic.')) return key;
		const rel = key === 'epic' ? [] : key.slice('epic.'.length).split('.');
		const inLegacy = legacy.some((raw) => ownPathExists(raw.turbo.epic, rel));
		const inTop = tops.some((raw) => ownPathExists(raw.epic, rel));
		return inLegacy && !inTop ? `${key} (from turbo.epic)` : key;
	});
}
