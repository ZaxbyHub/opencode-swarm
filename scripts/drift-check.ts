#!/usr/bin/env bun
/**
 * CI drift checker — issue #1497.
 *
 * Detects when the repo's parallel "canonical source + mirror" / "source +
 * registry" surfaces fall out of sync. Unlike a grep-based heuristic, every
 * detector IMPORTS the real modules and compares runtime values, so it does not
 * produce the false positives a textual scan would.
 *
 * Detectors:
 *   1. skill-mirror     — .opencode <-> .claude skill trees vs the contracts in
 *                         src/config/skill-mirrors.ts (byte identity / divergent /
 *                         adapter / opencode-only), plus adapter-shim reference
 *                         integrity (.agents, .github).
 *   2. bundled-skill    — BUNDLED_PROJECT_SKILLS completeness vs the filesystem,
 *                         package.json#files, and the package-smoke slug list
 *                         (the issue #1496 drift class).
 *   3. tool             — reuse of scripts/check-tool-registration.ts.
 *   4. command          — COMMAND_REGISTRY structural integrity.
 *   5. agent            — ALL_AGENT_NAMES vs AGENT_TOOL_MAP and the opt-in maps.
 *   6. docs-claim       — numeric documentation claims vs importable source.
 *   7. config-schema    — checked-in opencode-swarm.schema.json vs
 *                         regeneration from PluginConfigSchema (issue #1663).
 *   8. config-docs      — generated top-level-config-keys section of
 *                         docs/configuration.md vs regeneration (issue #1663).
 *   9. gates-docs       — gates.* docs↔schema↔reader triangle for
 *                         docs/installation.md + GATE_SECTION_SCHEMAS +
 *                         GATE_CONFIG_KNOWN_SECTION_KEYS +
 *                         GATE_CONFIG_READERS (issue #2524).
 *  10. dep-freshness    — locked @opencode-ai/* resolution vs npm-latest (issue
 *                         #1899), plus the vendored @opencode/plugin pin in
 *                         src/host/v2/types.ts vs npm-latest (issue #2910).
 *                         Both env-gated (SWARM_DEP_FRESHNESS_CHECK) and
 *                         fail-open: emits advisory `notice` findings only, never
 *                         blocks, so a stale lockfile can't silently age again.
 *  11. required-check-contract — exact ruleset-required contexts and workflow
 *                         event/job ownership against bounded captured evidence
 *                         (issue #2677). Pre-promotion intended checks are notices.
 *
 * Output:
 *   - GitHub Actions annotations (`::warning file=...::message`) on stdout.
 *   - A structured markdown report (default written to drift-report.md, override
 *     with --report <path>; suppress with --no-report).
 *   - Exit code: 0 by default (soft-warn). With `--enforce` or a truthy
 *     DRIFT_CHECK_ENFORCE value, blocking findings exit 1.
 *
 * Usage: bun run scripts/drift-check.ts [--enforce] [--report <path>] [--no-report] [--json]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
	collectToolRegistrationErrors,
	type ToolRegistrationCheckOptions,
} from './check-tool-registration';
import { collectEventContractErrors } from './check-event-contract';
import {
	buildQuarantineCensus,
	collectAddRetireTrend,
	formatQuarantineCensus,
	readLedgerContents,
} from './ci/quarantine-census';
import { collectCoreEventsUsageErrors } from './check-core-events-usage';
import { collectShellAuditUsageErrors } from './check-shell-audit-usage';
import { collectTrajectoryStoreUsageErrors } from './check-trajectory-store-usage';
import { readBounded } from './lib/read-bounded';
import { detectDocsClaimDrift } from './drift-check-docs-claims';
import { detectGatesConfigDrift } from './drift-check-gates-docs';
import { collectRequiredCheckContract } from './check-required-check-contract';
import { checkSkillAssertions, formatBrokenAssertions } from './check-skill-assertions';
import {
	CONFIG_DOCS_MARKER_BEGIN,
	CONFIG_DOCS_MARKER_END,
	CONFIG_DOCS_RELATIVE_PATH,
	CONFIG_SCHEMA_RELATIVE_PATH,
	buildConfigDocsSection,
	serializeConfigSchema,
} from './generate-config-schema';
import { BUNDLED_PROJECT_SKILLS } from '../src/config/bundled-skills';
import { ALL_AGENT_NAMES } from '../src/config/agent-names';
import {
	AGENT_TOOL_MAP,
	COUNCIL_AGENT_TOOL_MAP,
	EPIC_AGENT_TOOL_MAP,
	EXTERNAL_SKILL_AGENT_TOOL_MAP,
	GENERAL_COUNCIL_AGENT_TOOL_MAP,
	MEMORY_AGENT_TOOL_MAP,
	TURBO_AGENT_TOOL_MAP,
} from '../src/config/constants';
import { COMMAND_NAME_SET, COMMAND_NAMES } from '../src/commands/command-names';
import { COMMAND_REGISTRY } from '../src/commands/registry';
import { parseSkillFrontmatter } from '../src/hooks/skill-scoring';
import {
	ADAPTER_ARCHITECT_MODE_SKILLS,
	ADDITIONAL_SKILL_MIRROR_CONTRACTS,
	DIVERGENT_ARCHITECT_MODE_SKILLS,
	MIRRORED_ARCHITECT_MODE_SKILLS,
	NON_SKILL_OPENCODE_DIRS,
	OPENCODE_ONLY_ARCHITECT_MODE_SKILLS,
} from '../src/config/skill-mirrors';
export { detectDocsClaimDrift };

export type DriftSeverity = 'error' | 'warning' | 'notice';

export interface DriftFinding {
	category: string;
	severity: DriftSeverity;
	message: string;
	/** Repo-relative path for the GitHub annotation, when applicable. */
	file?: string;
}

export const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);

interface FsHelpers {
	abs: (relativePath: string) => string;
	realpath: (relativePath: string) => string;
	fileExists: (relativePath: string) => boolean;
	readFile: (relativePath: string) => string;
	writeFile: (relativePath: string, contents: string) => void;
	listDirNames: (relativePath: string) => string[];
	listDirEntries: (relativePath: string) => fs.Dirent[];
}

/**
 * Filesystem helpers bound to a repo root. Detectors accept an optional root so
 * tests can point them at a synthetic fixture tree without mutating the repo.
 */
function makeFs(root: string): FsHelpers {
	const abs = (relativePath: string): string => path.join(root, relativePath);
	return {
		abs,
		realpath: (relativePath) => {
			try {
				return fs.realpathSync(abs(relativePath));
			} catch {
				return abs(relativePath);
			}
		},
		fileExists: (relativePath) => fs.existsSync(abs(relativePath)),
		readFile: (relativePath) => fs.readFileSync(abs(relativePath), 'utf-8'),
		writeFile: (relativePath, contents) => {
			const full = abs(relativePath);
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, contents, 'utf-8');
		},
		listDirNames: (relativePath) => {
			const dir = abs(relativePath);
			if (!fs.existsSync(dir)) return [];
			return fs
				.readdirSync(dir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name);
		},
		listDirEntries: (relativePath) => {
			const dir = abs(relativePath);
			if (!fs.existsSync(dir)) return [];
			return fs.readdirSync(dir, { withFileTypes: true });
		},
	};
}

// ---------------------------------------------------------------------------
// 1) Skill mirror drift
// ---------------------------------------------------------------------------

export function detectSkillMirrorDrift(root: string = REPO_ROOT): DriftFinding[] {
	const { fileExists, readFile, listDirNames } = makeFs(root);
	const findings: DriftFinding[] = [];
	const category = 'skill-mirror';
	const classified = new Set<string>();

	// MIRRORED: both sides must exist AND be byte-identical.
	for (const { slug, opencodePath, claudePath } of MIRRORED_ARCHITECT_MODE_SKILLS) {
		classified.add(slug);
		if (!fileExists(opencodePath)) {
			findings.push({
				category,
				severity: 'error',
				file: opencodePath,
				message: `mirrored skill "${slug}" missing canonical ${opencodePath}`,
			});
			continue;
		}
		if (!fileExists(claudePath)) {
			findings.push({
				category,
				severity: 'error',
				file: claudePath,
				message: `mirrored skill "${slug}" missing mirror ${claudePath}`,
			});
			continue;
		}
		if (readFile(opencodePath) !== readFile(claudePath)) {
			findings.push({
				category,
				severity: 'error',
				file: claudePath,
				message: `mirrored skill "${slug}" differs between ${opencodePath} and ${claudePath} (must be byte-identical)`,
			});
		}
	}

	// DIVERGENT: both sides must exist; content may differ.
	for (const { slug, opencodePath, claudePath } of DIVERGENT_ARCHITECT_MODE_SKILLS) {
		classified.add(slug);
		for (const p of [opencodePath, claudePath]) {
			if (!fileExists(p)) {
				findings.push({
					category,
					severity: 'error',
					file: p,
					message: `divergent skill "${slug}" missing required file ${p}`,
				});
			}
		}
	}

	// ADAPTER: canonical must exist and each adapter must reference it.
	for (const {
		slug,
		canonicalPath,
		adapterPaths,
		expectedCanonicalRef,
	} of ADAPTER_ARCHITECT_MODE_SKILLS) {
		classified.add(slug);
		if (!fileExists(canonicalPath)) {
			findings.push({
				category,
				severity: 'error',
				file: canonicalPath,
				message: `adapter skill "${slug}" missing canonical ${canonicalPath}`,
			});
		}
		for (const adapterPath of adapterPaths) {
			if (!fileExists(adapterPath)) {
				findings.push({
					category,
					severity: 'error',
					file: adapterPath,
					message: `adapter skill "${slug}" missing adapter shim ${adapterPath}`,
				});
				continue;
			}
			if (!readFile(adapterPath).includes(expectedCanonicalRef)) {
				findings.push({
					category,
					severity: 'error',
					file: adapterPath,
					message: `adapter shim ${adapterPath} no longer references canonical "${expectedCanonicalRef}"`,
				});
			}
		}
	}

	// OPENCODE_ONLY: .opencode exists; .claude mirror must be absent.
	for (const { slug, opencodePath } of OPENCODE_ONLY_ARCHITECT_MODE_SKILLS) {
		classified.add(slug);
		if (!fileExists(opencodePath)) {
			findings.push({
				category,
				severity: 'error',
				file: opencodePath,
				message: `opencode-only skill "${slug}" missing ${opencodePath}`,
			});
		}
		const claudePath = opencodePath.replace(
			'.opencode/skills/',
			'.claude/skills/',
		);
		if (fileExists(claudePath)) {
			findings.push({
				category,
				severity: 'warning',
				file: claudePath,
				message: `opencode-only skill "${slug}" unexpectedly has a .claude mirror at ${claudePath}`,
			});
		}
	}

	// ADDITIONAL contracts for non-architect-mode skill pairs.
	for (const contract of ADDITIONAL_SKILL_MIRROR_CONTRACTS) {
		const { slug, kind } = contract;
		classified.add(slug);
		const opencodePath = `.opencode/skills/${slug}/SKILL.md`;
		const claudePath = `.claude/skills/${slug}/SKILL.md`;
		if (kind === 'identical') {
			if (!fileExists(opencodePath)) {
				findings.push({
					category,
					severity: 'error',
					file: opencodePath,
					message: `skill "${slug}" missing ${opencodePath}`,
				});
				continue;
			}
			if (!fileExists(claudePath)) {
				findings.push({
					category,
					severity: 'error',
					file: claudePath,
					message: `skill "${slug}" missing mirror ${claudePath}`,
				});
				continue;
			}
			if (readFile(opencodePath) !== readFile(claudePath)) {
				findings.push({
					category,
					severity: 'error',
					file: claudePath,
					message: `skill "${slug}" mirror drifted: ${opencodePath} and ${claudePath} must be byte-identical (canonical: ${contract.canonical ?? '.claude'})`,
				});
			}
			for (const extraPath of contract.extraIdenticalPaths ?? []) {
				if (!fileExists(extraPath)) {
					findings.push({
						category,
						severity: 'error',
						file: extraPath,
						message: `skill "${slug}" missing extra identical mirror ${extraPath}`,
					});
					continue;
				}
				if (readFile(opencodePath) !== readFile(extraPath)) {
					findings.push({
						category,
						severity: 'error',
						file: extraPath,
						message: `skill "${slug}" extra mirror drifted: ${opencodePath} and ${extraPath} must be byte-identical (canonical: ${contract.canonical ?? '.claude'})`,
					});
				}
			}
		} else if (kind === 'divergent') {
			const existingDivergentPaths: string[] = [];
			for (const p of [opencodePath, claudePath]) {
				if (!fileExists(p)) {
					findings.push({
						category,
						severity: 'error',
						file: p,
						message: `divergent skill "${slug}" missing required file ${p}`,
					});
				} else {
					existingDivergentPaths.push(p);
				}
			}
			// Safety-section parity (M13 fix): a divergent pair may differ in
			// runtime-specific prose, but any heading it declares in
			// `sharedSafetyHeadings` must be present in EVERY existing tree.
			// Without this, the existence-only checks above let a whole safety
			// section (e.g. "### Critical safety guard") live in one tree and be
			// silently absent from the other. Match is a substring test so a
			// heading may omit a trailing parenthetical (e.g. "(differential
			// scanning)").
			for (const heading of contract.sharedSafetyHeadings ?? []) {
				for (const p of existingDivergentPaths) {
					if (!readFile(p).includes(heading)) {
						findings.push({
							category,
							severity: 'error',
							file: p,
							message: `divergent skill "${slug}" is missing required safety section "${heading}" in ${p} — designated safety headings are parity-enforced across every tree`,
						});
					}
				}
			}
			// extraIdenticalPaths: existence check for divergent contracts.
			// Unlike 'identical' kind, divergent pairs may differ in content,
			// but extra paths listed in the contract MUST exist (SC-006, SC-007).
			for (const extraPath of contract.extraIdenticalPaths ?? []) {
				if (!fileExists(extraPath)) {
					findings.push({
						category,
						severity: 'error',
						file: extraPath,
						message: `divergent skill "${slug}" missing extra path ${extraPath}`,
					});
				}
			}
		} else if (kind === 'adapter') {
			if (!fileExists(opencodePath)) {
				findings.push({
					category,
					severity: 'error',
					file: opencodePath,
					message: `adapter skill "${slug}" missing canonical ${opencodePath}`,
				});
			}
			for (const adapterPath of contract.adapterPaths ?? []) {
				if (!fileExists(adapterPath)) {
					findings.push({
						category,
						severity: 'error',
						file: adapterPath,
						message: `adapter skill "${slug}" missing adapter shim ${adapterPath}`,
					});
					continue;
				}
				const expectedRef = contract.expectedCanonicalRef ?? opencodePath;
				if (!readFile(adapterPath).includes(expectedRef)) {
					findings.push({
						category,
						severity: 'error',
						file: adapterPath,
						message: `adapter shim ${adapterPath} no longer references canonical "${expectedRef}"`,
					});
				}
			}
		} else if (kind === 'opencode-only') {
			if (!fileExists(opencodePath)) {
				findings.push({
					category,
					severity: 'error',
					file: opencodePath,
					message: `opencode-only skill "${slug}" missing ${opencodePath}`,
				});
			}
			if (fileExists(claudePath)) {
				findings.push({
					category,
					severity: 'warning',
					file: claudePath,
					message: `opencode-only skill "${slug}" unexpectedly has a .claude mirror at ${claudePath}`,
				});
			}
		} else if (kind === 'agents-only') {
			// agents-only: skills that exist in .agents/.claude but NOT .opencode.
			// detectSkillMirrorDrift enforces extraIdenticalPaths existence for this kind.
			for (const extraPath of contract.extraIdenticalPaths ?? []) {
				if (!fileExists(extraPath)) {
					findings.push({
						category,
						severity: 'error',
						file: extraPath,
						message: `agents-only skill "${slug}" missing ${extraPath}`,
					});
				}
			}
		}
	}

	// Any cross-tree skill pair without a contract must be classified by a human.
	const opencodeSkills = listDirNames('.opencode/skills').filter(
		(name) => !NON_SKILL_OPENCODE_DIRS.has(name),
	);
	const claudeSkills = listDirNames('.claude/skills');
	const claudeSet = new Set(claudeSkills);
	for (const slug of opencodeSkills) {
		if (classified.has(slug)) continue;
		if (claudeSet.has(slug)) {
			findings.push({
				category,
				severity: 'warning',
				file: `.opencode/skills/${slug}/SKILL.md`,
				message: `skill "${slug}" exists in both .opencode and .claude but has no mirror contract in src/config/skill-mirrors.ts — classify it (identical / divergent / adapter / opencode-only)`,
			});
		}
	}

	// SC-009: Check .agents/skills/ and .github/skills/ for unclassified dirs.
	const extraSkillTrees = ['.agents/skills', '.github/skills'];
	for (const treePath of extraSkillTrees) {
		if (fileExists(treePath)) {
			const treeSlugs = listDirNames(treePath);
			for (const slug of treeSlugs) {
				if (!classified.has(slug)) {
					findings.push({
						category,
						severity: 'warning',
						file: `${treePath}/${slug}/SKILL.md`,
						message: `skill "${slug}" exists in ${treePath} but has no contract in src/config/skill-mirrors.ts — classify it`,
					});
				}
			}
		}
	}

	return findings;
}

// ---------------------------------------------------------------------------
// 1c) Duplicate slug detection (FR-004, SC-010, SC-011)
// ---------------------------------------------------------------------------

type SlugCarrier = { slug: string };

/**
 * Pure helper — counts slug occurrences across all provided contract arrays and
 * returns an error finding for every slug that appears in more than one array.
 * Exported via _internals for unit-test direct invocation (avoids mock.module
 * leakage across the shared Bun test-runner process per AGENTS.md invariant #7).
 */
export function _checkDuplicateSlugsFromArrays(
	mirrored: SlugCarrier[],
	divergent: SlugCarrier[],
	adapter: SlugCarrier[],
	opencodeOnly: SlugCarrier[],
	additional: SlugCarrier[],
): DriftFinding[] {
	const findings: DriftFinding[] = [];
	const category = 'skill-mirror';
	const slugCount = new Map<string, number>();

	for (const { slug } of mirrored) {
		slugCount.set(slug, (slugCount.get(slug) ?? 0) + 1);
	}
	for (const { slug } of divergent) {
		slugCount.set(slug, (slugCount.get(slug) ?? 0) + 1);
	}
	for (const { slug } of adapter) {
		slugCount.set(slug, (slugCount.get(slug) ?? 0) + 1);
	}
	for (const { slug } of opencodeOnly) {
		slugCount.set(slug, (slugCount.get(slug) ?? 0) + 1);
	}
	for (const { slug } of additional) {
		slugCount.set(slug, (slugCount.get(slug) ?? 0) + 1);
	}

	for (const [slug, count] of slugCount) {
		if (count > 1) {
			findings.push({
				category,
				severity: 'error',
				message: `duplicate slug "${slug}" appears in ${count} mirror contract arrays — each slug must be unique across all arrays`,
			});
		}
	}

	return findings;
}

/** _internals seam for test injection — see AGENTS.md invariant #7. */
export const _internals = {
	_checkDuplicateSlugsFromArrays,
	resolveUserGlobalHome: resolveUserGlobalHomeDefault,
};

/**
 * Detect duplicate slugs across ALL skill mirror contract arrays.
 * A duplicate slug appearing in multiple arrays (e.g. both MIRRORED and DIVERGENT)
 * is a configuration error that must be reported as a drift finding.
 */
export function detectDuplicateSlugs(): DriftFinding[] {
	return _checkDuplicateSlugsFromArrays(
		MIRRORED_ARCHITECT_MODE_SKILLS,
		DIVERGENT_ARCHITECT_MODE_SKILLS,
		ADAPTER_ARCHITECT_MODE_SKILLS,
		OPENCODE_ONLY_ARCHITECT_MODE_SKILLS,
		ADDITIONAL_SKILL_MIRROR_CONTRACTS,
	);
}

// ---------------------------------------------------------------------------
// 1d) Package.json files duplicate detection (SC-012)
// ---------------------------------------------------------------------------

/**
 * Detect duplicate entries in package.json's `files` array that start with
 * `.opencode/skills/`. Duplicate entries in the published package files list
 * would cause incorrect package contents.
 */
export function detectPackageJsonFilesDuplicates(root: string = REPO_ROOT): DriftFinding[] {
	const { readFile } = makeFs(root);
	const findings: DriftFinding[] = [];
	const category = 'bundled-skill';

	let pkg: PackageJson = {};
	try {
		pkg = JSON.parse(readFile('package.json')) as PackageJson;
	} catch (err) {
		return findings; // Already handled by detectBundledSkillDrift.
	}

	const skillPrefix = '.opencode/skills/';
	const filesArr = pkg.files ?? [];

	// Find duplicates among entries starting with .opencode/skills/
	const seen = new Map<string, number>();
	const duplicates: string[] = [];
	for (const file of filesArr) {
		if (!file.startsWith(skillPrefix)) continue;
		const count = seen.get(file) ?? 0;
		if (count === 1) {
			duplicates.push(file);
		}
		seen.set(file, count + 1);
	}

	for (const dup of duplicates) {
		findings.push({
			category,
			severity: 'error',
			file: 'package.json',
			message: `duplicate entry "${dup}" in package.json#files`,
		});
	}

	return findings;
}

// ---------------------------------------------------------------------------
// 1b) Skill mirror FIX (issue #1781 E3)
// ---------------------------------------------------------------------------

/**
 * Reconcile mirrored skill pairs by copying the canonical side to each mirror.
 * The detect-only path (`detectSkillMirrorDrift`) reports divergence; this
 * function fixes it. It is invoked by `drift:fix` (a developer convenience, not
 * a CI mutation) and is guarded against accidental invocation.
 *
 * Invariants:
 *  - Writes ONLY to native skill roots (`.opencode/skills/`, `.claude/skills/`,
 *    `.agents/skills/`). These are protected by AGENTS.md invariant 4; this is
 *    a developer tool, never a plugin-runtime sync, and never runs under
 *    `DRIFT_CHECK_ENFORCE`. The env-guard below enforces explicit confirmation.
 *  - Reads `canonical` per pair to decide copy direction (`.opencode` for the
 *    MIRRORED pairs and ADDITIONAL identical pairs whose canonical is
 *    `.opencode`). A wrong direction would corrupt the operative side, so this
 *    MUST read the field, not assume `.opencode`. (`commit-pr` is `divergent`
 *    since #1692 — its `.opencode` portable copy and `.claude` repo-internal
 *    copy intentionally differ — so it is a no-op here.)
 *  - No-op on `divergent` and `opencode-only` pairs and on already-in-sync
 *    pairs.
 *  - Returns `DriftFinding[]` with severity `'notice'` describing what was
 *    synced, so callers can print a summary.
 */
export function fixSkillMirrorDrift(
	root: string = REPO_ROOT,
	options: { confirmed?: boolean } = {},
): DriftFinding[] {
	const confirmed =
		options.confirmed === true ||
		process.env.SWARM_SKILL_SYNC_CONFIRM === '1';
	if (!confirmed) {
		throw new Error(
			'fixSkillMirrorDrift writes to native skill roots (.opencode/skills, ' +
				'.claude/skills, .agents/skills) protected by AGENTS.md invariant 4. ' +
				'Confirm by passing `--confirm` on the CLI or setting ' +
				'SWARM_SKILL_SYNC_CONFIRM=1. This tool is a developer convenience ' +
				'(run via `bun run drift:fix`); it is never a plugin-runtime sync and ' +
				'is never invoked under DRIFT_CHECK_ENFORCE.',
		);
	}
	const { fileExists, readFile, writeFile } = makeFs(root);
	const synced: DriftFinding[] = [];
	const category = 'skill-mirror';

	// MIRRORED architect-mode pairs (canonical always `.opencode`).
	for (const {
		slug,
		opencodePath,
		claudePath,
		canonical,
	} of MIRRORED_ARCHITECT_MODE_SKILLS) {
		if (!fileExists(opencodePath) || !fileExists(claudePath)) continue;
		const opencodeContent = readFile(opencodePath);
		const claudeContent = readFile(claudePath);
		if (opencodeContent === claudeContent) continue;
		if (canonical === '.opencode') {
			writeFile(claudePath, opencodeContent);
		} else {
			writeFile(opencodePath, claudeContent);
		}
		synced.push({
			category,
			severity: 'notice',
			file: canonical === '.opencode' ? claudePath : opencodePath,
			message: `mirrored skill "${slug}" synced from ${canonical} canonical`,
		});
	}

	// ADDITIONAL `identical` pairs (canonical may be either side; honor it).
	for (const contract of ADDITIONAL_SKILL_MIRROR_CONTRACTS) {
		if (contract.kind !== 'identical') continue;
		const { slug, canonical } = contract;
		const canonicalSide = canonical ?? '.opencode';
		const opencodePath = `.opencode/skills/${slug}/SKILL.md`;
		const claudePath = `.claude/skills/${slug}/SKILL.md`;
		if (!fileExists(opencodePath) || !fileExists(claudePath)) continue;
		const opencodeContent = readFile(opencodePath);
		const claudeContent = readFile(claudePath);
		const canonicalContent =
			canonicalSide === '.opencode' ? opencodeContent : claudeContent;
		const mirrorPath =
			canonicalSide === '.opencode' ? claudePath : opencodePath;
		if (opencodeContent !== claudeContent) {
			writeFile(mirrorPath, canonicalContent);
			synced.push({
				category,
				severity: 'notice',
				file: mirrorPath,
				message: `identical skill "${slug}" synced from ${canonicalSide} canonical`,
			});
		}
		// extraIdenticalPaths: bring each extra mirror in line with the canonical.
		for (const extraPath of contract.extraIdenticalPaths ?? []) {
			if (!fileExists(extraPath)) continue;
			if (readFile(extraPath) !== canonicalContent) {
				writeFile(extraPath, canonicalContent);
				synced.push({
					category,
					severity: 'notice',
					file: extraPath,
					message: `identical skill "${slug}" extra mirror synced from ${canonicalSide} canonical`,
				});
			}
		}
	}

	return synced;
}

// ---------------------------------------------------------------------------
// 2) Bundled-skill completeness drift (issue #1496 class)
// ---------------------------------------------------------------------------

interface PackageJson {
	files?: string[];
}

/**
 * Require declarative audience metadata on tracked, static skill surfaces.
 * Runtime-generated skills are deliberately excluded: their repository
 * audience cannot be guessed safely and absence remains legacy match-all.
 */
export function detectSkillAudienceDrift(
	root: string = REPO_ROOT,
): DriftFinding[] {
	const { fileExists, readFile, listDirNames } = makeFs(root);
	const findings: DriftFinding[] = [];
	const category = 'skill-audience';

	for (const skillRoot of [
		'.opencode/skills',
		'.claude/skills',
		'.agents/skills',
	]) {
		for (const slug of listDirNames(skillRoot)) {
			if (skillRoot === '.opencode/skills' && slug === 'generated') continue;
			const skillPath = `${skillRoot}/${slug}/SKILL.md`;
			if (!fileExists(skillPath)) continue;
			const metadata = parseSkillFrontmatter(readFile(skillPath), skillPath);
			if (metadata.frontmatterStatus !== 'valid') {
				findings.push({
					category,
					severity: 'error',
					file: skillPath,
					message: `static skill "${slug}" has ${metadata.frontmatterStatus ?? 'invalid'} frontmatter`,
				});
				continue;
			}
			if (metadata.audience?.status !== 'valid') {
				findings.push({
					category,
					severity: 'error',
					file: skillPath,
					message: `static skill "${slug}" must declare a valid audience (metadata.audience or legacy top-level)`,
				});
			}
		}
	}

	return findings;
}

/**
 * Spec frontmatter keys per https://agentskills.io/specification: name,
 * description, license, compatibility, metadata, allowed-tools.
 */
const SKILL_SPEC_FRONTMATTER_KEYS = new Set([
	'name',
	'description',
	'license',
	'compatibility',
	'metadata',
	'allowed-tools',
]);

/**
 * Host-runtime behavioral keys that intentionally stay top-level (issue
 * #2907): Claude Code reads `disable-model-invocation` / `argument-hint` and
 * OpenCode reads `context` / `agent` at the top level of skill frontmatter —
 * moving them under `metadata` would delete host behavior, which the issue
 * scopes out. Everything else non-spec must live under `metadata:`.
 */
const HOST_CONSUMED_TOP_LEVEL_KEYS = new Set([
	'disable-model-invocation',
	'argument-hint',
	'context',
	'agent',
]);

/**
 * Bare metadata-child values YAML would resolve as a NON-STRING scalar.
 * YAML 1.2 core resolves integers/floats/bools/null; ISO-8601 timestamps
 * resolve as strings under 1.2 but the repo's writer policy quotes them
 * (issue #2907), so bare timestamps are flagged to keep output canonical.
 */
const SKILL_METADATA_NON_STRING_SCALAR =
	/^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|-?\.[0-9]+|true|false|null|yes|no|on|off|~|\d{4}-\d{2}-\d{2}(?:[T ].*)?)$/i;

/**
 * Strip a trailing YAML comment from a frontmatter value, quote-aware
 * (PR #3387 follow-up, FB-027; hardened in the follow-up review): a `#`
 * inside a BALANCED quoted scalar is content, so `[a, "b # c"] # note`
 * strips to `[a, "b # c"]` — the previous first-char-only check escaped
 * exactly that shape from the flow-collection and bare-scalar checks.
 *
 * A quote opens ONLY at a value start (after a flow-element boundary, or
 * after `:` when a whitespace/EOL follows — the `:` in a plain flow scalar
 * like `b:'c` is content, not a mapping separator, so its quote must not
 * open). A doubled `''` inside a single-quoted scalar is the YAML escape
 * for a literal quote, so `'it''s # x'` stays quoted through the `#`. If a
 * quote is still open at end of value (malformed input), the strip falls
 * back to the naive first-comment scan so those shapes keep firing the way
 * the pre-quote-aware detector did. That fallback is the parity boundary,
 * not a guarantee: a malformed value whose quotes CLOSE around the comment
 * (e.g. `['a] # b' x`) stays unstripped — documented bounded-subset
 * behavior, the same class as the skill-scoring flow parser. A `#` at
 * value start is a comment-only value (strips to empty), and `#` must
 * follow whitespace or start the value to count as a comment opener.
 */
function stripFrontmatterValueComment(value: string): string {
	let quote: '"' | "'" | undefined;
	let atValueStart = true;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i] as string;
		if (quote) {
			if (quote === '"' && ch === '\\') {
				i += 1;
				continue;
			}
			if (ch === quote) {
				if (quote === "'" && value[i + 1] === "'") {
					// YAML doubled single-quote escape — content, stay quoted.
					i += 1;
					continue;
				}
				quote = undefined;
			}
			atValueStart = false;
			continue;
		}
		if ((ch === '"' || ch === "'") && atValueStart) {
			quote = ch;
			atValueStart = false;
			continue;
		}
		if (ch === '#' && (i === 0 || /\s/.test(value[i - 1] as string))) {
			return value.slice(0, i).trim();
		}
		if (ch === '{' || ch === '[' || ch === ',') {
			atValueStart = true;
			continue;
		}
		if (ch === ':') {
			// A mapping separator only when a space/EOL follows; the colon in
			// `b:'c` sits inside a plain scalar, and the quote after it is
			// content (follow-up review: base fired there, head must too).
			const next = value[i + 1];
			atValueStart = next === undefined || /\s/.test(next);
			continue;
		}
		if (!/\s/.test(ch)) atValueStart = false;
	}
	if (quote !== undefined) {
		// Unterminated quote (malformed YAML): fall back to the naive strip
		// so those shapes keep firing. Parity boundary only — a malformed
		// value whose quotes CLOSE around the comment stays unstripped (see
		// the function docstring).
		for (let i = 0; i < value.length; i++) {
			if (value[i] === '#' && (i === 0 || /\s/.test(value[i - 1] as string))) {
				return value.slice(0, i).trim();
			}
		}
	}
	return value.trim();
}

/**
 * Agent-Skills-spec conformance for tracked SKILL.md frontmatter
 * (issue #2907): non-spec keys must live under the `metadata:` string map,
 * `name` must match the parent directory, and metadata children must be
 * string-typed scalars. The generated tree (`.opencode/skills/generated/`)
 * is enforced by the skill-frontmatter detector (post-migration, issue
 * #3216); `metadata:` values must use the block form — inline flow maps are
 * non-canonical (issue #3217).
 */
export function detectSkillFrontmatterSpecDrift(
	root: string = REPO_ROOT,
): DriftFinding[] {
	const { fileExists, readFile, listDirNames } = makeFs(root);
	const findings: DriftFinding[] = [];
	const category = 'skill-frontmatter';

	const scanTargets: Array<[string, string]> = [];
	for (const skillRoot of [
		'.opencode/skills',
		'.claude/skills',
		'.agents/skills',
	]) {
		for (const slug of listDirNames(skillRoot)) {
			scanTargets.push([`${skillRoot}/${slug}/SKILL.md`, slug]);
		}
	}
	// The generated tree is enforced (issue #3216) — the legacy-key
	// migrations converged it onto the generator's spec emission; only the
	// audience detector keeps its generated-tree skip (repository audience
	// cannot be guessed safely, issue #2907 review — PRR-009).
	const generatedRoot = '.opencode/skills/generated';
	for (const child of listDirNames(generatedRoot)) {
		scanTargets.push([`${generatedRoot}/${child}/SKILL.md`, child]);
	}
	for (const [skillPath, slug] of scanTargets) {
		if (!fileExists(skillPath)) continue;
		const content = readFile(skillPath).replace(/\r\n/g, '\n');
		const lines = content.split('\n');
		if (lines[0]?.trim() !== '---') continue;
		const end = lines.findIndex(
			(line, index) => index > 0 && line.trim() === '---',
		);
		if (end === -1) continue;

		let inMetadata = false;
		for (let i = 1; i < end; i++) {
			const line = lines[i] ?? '';
			if (!line.trim()) continue;
			const indented = /^\s/.test(line);
			if (inMetadata) {
				if (!indented) {
					inMetadata = false;
				} else {
					const child = line.match(
						/^(\s+)([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/,
					);
					if (child) {
						// Strip a trailing YAML comment, quote-aware (PR #3387
						// follow-up, FB-027): a `#` inside a BALANCED quoted
						// scalar is content, so `[a, "b # c"] # note` strips to
						// `[a, "b # c"]` and still triggers the flow-collection
						// check — the previous first-char-only check escaped
						// it. A `#` at value start is a comment-only value
						// (strips to empty), and `key: true # note` is still
						// judged a bare scalar (PRR-011b).
						const value = stripFrontmatterValueComment(child[3].trim());
						const quoted =
							(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
							(value.startsWith("'") && value.endsWith("'") && value.length >= 2);
						// A declared-but-empty child followed by `- item`
						// lines is a YAML sequence — not a string (PRR-011c).
						if (value === '') {
							const childIndent = child[1].length;
							for (let j = i + 1; j < end; j++) {
								const next = lines[j] ?? '';
								if (!next.trim()) continue;
								if (!/^\s/.test(next)) break;
								const nextIndent = next.length - next.trimStart().length;
								if (nextIndent > childIndent && /^\s+-\s/.test(next)) {
									findings.push({
										category,
										severity: 'error',
										file: skillPath,
										message: `metadata child "${child[2]}" is a YAML sequence — the spec metadata map is string-typed (serialize lists as JSON array strings)`,
									});
								}
								break;
							}
						} else if (
							!quoted &&
							(/^\[.*\]$/.test(value) || /^\{.*\}$/.test(value))
						) {
							findings.push({
								category,
								severity: 'error',
								file: skillPath,
								message: `metadata child "${child[2]}" is a flow collection — the spec metadata map is string-typed (serialize lists as JSON array strings)`,
							});
						} else if (
							value !== '' &&
							!quoted &&
							SKILL_METADATA_NON_STRING_SCALAR.test(value)
						) {
							findings.push({
								category,
								severity: 'error',
								file: skillPath,
								message: `metadata child "${child[2]}" has a bare non-string scalar value "${value}" — the spec metadata map is string-typed (quote it)`,
							});
						}
					}
					continue;
				}
			}
			const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
			if (!match) continue;
			const key = match[1].toLowerCase();
			if (key === 'metadata') {
				// Strip a trailing comment (unquoted values only, PRR-011b
				// pattern) so an empty-value `metadata: # note` is not
				// treated as carrying an inline value — including the
				// value-is-entirely-comment form (plan-critic Round 3).
				// Quote-aware for the same reason as the child-value strip
				// above (FB-027): a `#` inside a BALANCED quoted scalar is
				// content.
				const inline = stripFrontmatterValueComment(match[2].trim());
				if (inline !== '') {
					findings.push({
						category,
						severity: 'error',
						file: skillPath,
						message: `metadata key "${match[1]}" carries an inline value — use the block form (issue #3217; any non-empty inline value is non-canonical for this repo's writer)`,
					});
				}
				inMetadata = true;
				continue;
			}
			if (
				!SKILL_SPEC_FRONTMATTER_KEYS.has(key) &&
				!HOST_CONSUMED_TOP_LEVEL_KEYS.has(key)
			) {
				findings.push({
					category,
					severity: 'error',
					file: skillPath,
					message: `non-spec top-level frontmatter key "${match[1]}" — move it under the metadata: map (agentskills.io/specification)`,
				});
			}
			if (key === 'name') {
				const declared = match[2].trim().replace(/^["']|["']$/g, '');
				if (declared && declared !== slug) {
					findings.push({
						category,
						severity: 'error',
						file: skillPath,
						message: `frontmatter name "${declared}" does not match the parent directory "${slug}" (spec requirement)`,
					});
				}
			}
		}
	}

	return findings;
}

export function detectBundledSkillDrift(root: string = REPO_ROOT): DriftFinding[] {
	const { fileExists, readFile, listDirNames } = makeFs(root);
	const findings: DriftFinding[] = [];
	const category = 'bundled-skill';
	const bundled = new Set<string>(BUNDLED_PROJECT_SKILLS);
	const skillPrefix = '.opencode/skills/';

	// Completeness: every shippable .opencode/skills/<dir> must be bundled.
	for (const slug of listDirNames('.opencode/skills')) {
		if (NON_SKILL_OPENCODE_DIRS.has(slug)) continue;
		if (!bundled.has(slug)) {
			findings.push({
				category,
				severity: 'error',
				file: 'src/config/bundled-skills.ts',
				message: `skill "${slug}" exists under .opencode/skills/ but is missing from BUNDLED_PROJECT_SKILLS (will not sync/ship)`,
			});
		}
	}

	// No phantom bundled entries.
	for (const slug of BUNDLED_PROJECT_SKILLS) {
		if (!fileExists(`${skillPrefix}${slug}/SKILL.md`)) {
			findings.push({
				category,
				severity: 'error',
				file: 'src/config/bundled-skills.ts',
				message: `BUNDLED_PROJECT_SKILLS lists "${slug}" but ${skillPrefix}${slug}/SKILL.md does not exist (phantom entry)`,
			});
		}
	}

	// package.json#files must cover every bundled skill, with no extras.
	let pkg: PackageJson = {};
	try {
		pkg = JSON.parse(readFile('package.json')) as PackageJson;
	} catch (err) {
		findings.push({
			category,
			severity: 'error',
			file: 'package.json',
			message: `could not parse package.json: ${err instanceof Error ? err.message : String(err)}`,
		});
		return findings;
	}
	const files = new Set(pkg.files ?? []);
	for (const slug of BUNDLED_PROJECT_SKILLS) {
		if (!files.has(`${skillPrefix}${slug}`)) {
			findings.push({
				category,
				severity: 'error',
				file: 'package.json',
				message: `package.json#files is missing "${skillPrefix}${slug}" (bundled skill will not be published)`,
			});
		}
	}
	for (const file of pkg.files ?? []) {
		if (!file.startsWith(skillPrefix)) continue;
		const slug = file.slice(skillPrefix.length);
		if (!bundled.has(slug)) {
			findings.push({
				category,
				severity: 'warning',
				file: 'package.json',
				message: `package.json#files lists "${file}" which is not in BUNDLED_PROJECT_SKILLS`,
			});
		}
	}

	return findings;
}

// ---------------------------------------------------------------------------
// 3) Tool registration drift (reuse of check-tool-registration.ts)
// ---------------------------------------------------------------------------

export function detectToolRegistrationDrift(
	options: ToolRegistrationCheckOptions = {},
): DriftFinding[] {
	return collectToolRegistrationErrors(options).map((message) => ({
		category: 'tool',
		severity: 'error' as const,
		file: 'src/tools/tool-metadata.ts',
		message,
	}));
}

// ---------------------------------------------------------------------------
// 3b) Event contract drift (issue #2029 AC6, reuse of
//     scripts/check-event-contract.ts)
//
// ADVISORY ONLY here: drift-check is soft-warn by default
// (`DRIFT_CHECK_ENFORCE`), so this detector surfaces annotations/PR comments
// but does not block a merge on its own. The BLOCKING gate for AC6 is the
// dedicated "Event contract check" step in .github/workflows/ci.yml, which
// runs `bun run check:events` (collectEventContractErrors' hard-fail CLI)
// unconditionally, with no enforce/warn env var.
// ---------------------------------------------------------------------------

export function detectEventContractDrift(): DriftFinding[] {
	return collectEventContractErrors().map((message) => ({
		category: 'event-contract',
		severity: 'error' as const,
		file: 'src/observability/catalog.ts',
		message,
	}));
}

// ---------------------------------------------------------------------------
// 3b) Core event store usage drift (issue #2039 anti-bypass ratchet)
// ---------------------------------------------------------------------------

export function detectCoreEventsUsageDrift(): DriftFinding[] {
	return collectCoreEventsUsageErrors().map((message) => ({
		category: 'core-events-usage',
		severity: 'error' as const,
		file: 'src/events/core-events.ts',
		message,
	}));
}

// ---------------------------------------------------------------------------
// 3c) Shell-audit store usage drift (issue #2040 anti-bypass ratchet)
// ---------------------------------------------------------------------------

export function detectShellAuditUsageDrift(): DriftFinding[] {
	return collectShellAuditUsageErrors().map((message) => ({
		category: 'shell-audit-usage',
		severity: 'error' as const,
		file: 'src/hooks/guardrails/shell-audit-store.ts',
		message,
	}));
}

// ---------------------------------------------------------------------------
// 3d) Trajectory-store usage drift (issue #2041 anti-bypass ratchet)
// ---------------------------------------------------------------------------

export function detectTrajectoryStoreUsageDrift(): DriftFinding[] {
	return collectTrajectoryStoreUsageErrors().map((message) => ({
		category: 'trajectory-store-usage',
		severity: 'error' as const,
		file: 'src/prm/trajectory-store.ts',
		message,
	}));
}

// ---------------------------------------------------------------------------
// 4) Command registry drift
// ---------------------------------------------------------------------------

export function detectCommandDrift(): DriftFinding[] {
	const findings: DriftFinding[] = [];
	const category = 'command';

	// COMMAND_NAME_SET must mirror COMMAND_NAMES exactly.
	if (COMMAND_NAME_SET.size !== COMMAND_NAMES.length) {
		findings.push({
			category,
			severity: 'error',
			file: 'src/commands/command-names.ts',
			message: `COMMAND_NAME_SET has ${COMMAND_NAME_SET.size} entries but COMMAND_NAMES has ${COMMAND_NAMES.length}`,
		});
	}

	// Every subcommandOf parent must be a real command. (aliasOf is free-form
	// warning text per src/commands/registry.ts and is intentionally not checked.)
	const registry = COMMAND_REGISTRY as Record<string, { subcommandOf?: string }>;
	for (const [name, entry] of Object.entries(registry)) {
		const parent = entry.subcommandOf;
		if (parent && !COMMAND_NAME_SET.has(parent as never)) {
			findings.push({
				category,
				severity: 'error',
				file: 'src/commands/registry.ts',
				message: `command "${name}" declares subcommandOf "${parent}" which is not a registered command`,
			});
		}
	}

	return findings;
}

// ---------------------------------------------------------------------------
// 5) Agent registration drift
// ---------------------------------------------------------------------------

export function detectAgentDrift(): DriftFinding[] {
	const findings: DriftFinding[] = [];
	const category = 'agent';
	const agentNames = new Set<string>(ALL_AGENT_NAMES);

	// ALL_AGENT_NAMES and AGENT_TOOL_MAP keys must match exactly.
	const mapKeys = new Set(Object.keys(AGENT_TOOL_MAP));
	for (const name of agentNames) {
		if (!mapKeys.has(name)) {
			findings.push({
				category,
				severity: 'error',
				file: 'src/tools/tool-metadata.ts',
				message: `agent "${name}" is in ALL_AGENT_NAMES but missing from AGENT_TOOL_MAP`,
			});
		}
	}
	for (const name of mapKeys) {
		if (!agentNames.has(name)) {
			findings.push({
				category,
				severity: 'error',
				file: 'src/tools/tool-metadata.ts',
				message: `AGENT_TOOL_MAP has key "${name}" that is not a registered agent in ALL_AGENT_NAMES`,
			});
		}
	}

	// Opt-in tool maps may only reference registered agents.
	const optInMaps: Array<[string, Partial<Record<string, unknown>>]> = [
		['MEMORY_AGENT_TOOL_MAP', MEMORY_AGENT_TOOL_MAP],
		['EXTERNAL_SKILL_AGENT_TOOL_MAP', EXTERNAL_SKILL_AGENT_TOOL_MAP],
		['COUNCIL_AGENT_TOOL_MAP', COUNCIL_AGENT_TOOL_MAP],
		['GENERAL_COUNCIL_AGENT_TOOL_MAP', GENERAL_COUNCIL_AGENT_TOOL_MAP],
		['TURBO_AGENT_TOOL_MAP', TURBO_AGENT_TOOL_MAP],
		['EPIC_AGENT_TOOL_MAP', EPIC_AGENT_TOOL_MAP],
	];
	for (const [mapName, map] of optInMaps) {
		for (const agent of Object.keys(map)) {
			if (!agentNames.has(agent)) {
				findings.push({
					category,
					severity: 'error',
					file: 'src/config/constants.ts',
					message: `${mapName} references agent "${agent}" that is not in ALL_AGENT_NAMES`,
				});
			}
		}
	}

	return findings;
}

// ---------------------------------------------------------------------------
// 6) Skill-reference resolver drift (FR-001)
// ---------------------------------------------------------------------------

const SKILL_REFERENCE_BUNDLED_RE = /file:\.swarm\/bundled-skills\/([^/]+)\/SKILL\.md/g;
const SKILL_REFERENCE_SIBLING_RE = /(?<![\/\.\w-])(?:\.\.\/)+(.+?)\/SKILL\.md/g;

/**
 * Detect broken cross-skill references in SKILL.md bodies.
 *
 * Two reference forms are checked:
 *  1. `file:.swarm/bundled-skills/<slug>/SKILL.md` — runtime path; the slug must
 *     resolve to a real skill directory in any of the four trees OR be listed in
 *     BUNDLED_PROJECT_SKILLS.
 *  2. `../<slug>/SKILL.md` — sibling-relative path; the target must exist as a
 *     sibling SKILL.md in the same tree.
 *
 * Broken references produce a `skill-reference` error finding with the file path
 * of the SKILL.md containing the broken reference.
 */

/**
 * Recursively find all SKILL.md files beneath a tree root.
 * Returns array of { slug, skillPath, skillDir } where:
 *   - slug: directory name containing the SKILL.md (e.g., "pr-review-fix")
 *   - skillPath: absolute path to the SKILL.md file
 *   - skillDir: parent directory of SKILL.md (e.g., ".opencode/skills/generated/pr-review-fix")
 */
function listSkillFilesRecursively(
	treeRoot: string,
	fs: FsHelpers,
): Array<{ slug: string; skillPath: string; skillDir: string }> {
	const results: Array<{ slug: string; skillPath: string; skillDir: string }> = [];
	const visited = new Set<string>();

	function walk(dir: string): void {
		// Defense-in-depth (layer 2): The primary defense is Dirent.isDirectory()
		// returning false for symlinks in listDirEntries, which prevents following
		// symlink cycles. This visited Set uses realpathSync for physical path
		// canonicalization, preventing cycles even on filesystems with unreliable d_type.
		const resolved = fs.realpath(dir);
		if (visited.has(resolved)) return;
		visited.add(resolved);

		const entries = fs.listDirEntries(dir);
		for (const entry of entries) {
			if (entry.isDirectory()) {
				const subDir = `${dir}/${entry.name}`;
				const skillPath = `${subDir}/SKILL.md`;
				if (fs.fileExists(skillPath)) {
					results.push({
						slug: entry.name,
						skillPath,
						skillDir: subDir,
					});
				}
				// Recurse into subdirectories to find nested skills
				walk(subDir);
			}
		}
	}

	walk(treeRoot);
	return results;
}

export function detectSkillReferenceDrift(root: string = REPO_ROOT): DriftFinding[] {
	const fs = makeFs(root);
	const findings: DriftFinding[] = [];
	const category = 'skill-reference';

	const skillRoots = [
		'.opencode/skills',
		'.claude/skills',
		'.agents/skills',
		'.github/skills',
	];

	// Scan every SKILL.md in every tree.
	for (const treeRoot of skillRoots) {
		for (const { slug, skillPath, skillDir } of listSkillFilesRecursively(treeRoot, fs)) {
			if (!fs.fileExists(skillPath)) continue;
			const content = fs.readFile(skillPath);

			// Check form 1: file:.swarm/bundled-skills/<slug>/SKILL.md
			for (const match of content.matchAll(SKILL_REFERENCE_BUNDLED_RE)) {
				if (match[0].includes('<') || match[0].includes('>')) continue;
				const referencedSlug = match[1];
				if (!BUNDLED_PROJECT_SKILLS.includes(referencedSlug)) {
					findings.push({
						category,
						severity: 'error',
						file: skillPath,
						message: `skill "${slug}" references \`file:.swarm/bundled-skills/${referencedSlug}/SKILL.md\` but slug "${referencedSlug}" is not in BUNDLED_PROJECT_SKILLS`,
					});
				}
			}

			// Check form 2: ../<slug>/SKILL.md (sibling relative reference)
			// Handles multi-level ../ like ../../<slug>/SKILL.md (two levels up)
			// Also handles cross-tree references like ../../../.claude/skills/commit-pr/SKILL.md
			for (const siblingMatch of content.matchAll(SKILL_REFERENCE_SIBLING_RE)) {
				const fullMatch = siblingMatch[0];
				// Skip documentation template placeholders like <slug> or <path>
				if (fullMatch.includes('<') || fullMatch.includes('>')) continue;
				const referencedPath = siblingMatch[1];
				// Count the number of ../ in the match to determine traversal depth
				// Count only the LEADING ../ prefix, not any ../ inside the referenced path
				const leadingPrefix = fullMatch.match(/^(?:\.\.\/)+/);
				const upLevelCount = leadingPrefix ? (leadingPrefix[0].length / 3) : 0;
				// Build the traversal path by going up upLevelCount levels from skillDir
				let traversedSkillDir = skillDir;
				for (let i = 0; i < upLevelCount; i++) {
					traversedSkillDir = path.join(traversedSkillDir, '..');
				}
				// Build the full target path
				const siblingSkillPath = path.join(traversedSkillDir, referencedPath, 'SKILL.md');

				// Safety check: ensure the FINAL target is within a skill tree root
				// (not the intermediate traversal directory — cross-tree refs like ../../../.claude/skills/xxx
				// traverse through the repo root before reaching the target)
				const resolvedTarget = path.resolve(root, siblingSkillPath);
				const isInSkillTree = skillRoots.some((tr) => {
					const resolvedRoot = path.resolve(root, tr);
					return resolvedTarget === resolvedRoot + path.sep + 'SKILL.md'
						|| resolvedTarget.startsWith(resolvedRoot + path.sep);
				});
				if (!isInSkillTree) {
					// Target resolves outside all skill trees — this is a broken cross-skill reference
					findings.push({
						category,
						severity: 'error',
						file: skillPath,
						message: `skill "${slug}" references \`${fullMatch}\` but the target resolves outside all skill trees (.opencode/skills, .claude/skills, .agents/skills, .github/skills)`,
					});
					continue;
				}

				if (!fs.fileExists(siblingSkillPath)) {
					findings.push({
						category,
						severity: 'error',
						file: skillPath,
						message: `skill "${slug}" references \`${fullMatch}\` but ${siblingSkillPath} does not exist`,
					});
				}
			}
		}
	}

	return findings;
}

// ---------------------------------------------------------------------------
// 7) Dependency-freshness drift (issue #1899)
// ---------------------------------------------------------------------------

/**
 * Runtime deps whose locked resolution must not silently age far behind npm
 * latest. #1899: `@opencode-ai/{sdk,plugin}` froze at 1.1.53 in bun.lock while
 * users ran 1.18.x — a ~17-minor-series skew invisible to CI because the loose
 * SDK types still compiled. No static/type/lint rule can know npm's *latest
 * published* version, so this is inherently a CI-time (network) check.
 */
export const DEP_FRESHNESS_PACKAGES = [
	'@opencode-ai/sdk',
	'@opencode-ai/plugin',
] as const;

const DEP_FRESHNESS_DEFAULT_THRESHOLD = 5;
const DEP_FRESHNESS_FETCH_TIMEOUT_MS = 10_000;

export interface DepFreshnessDeps {
	/** locked/installed version for a package (from node_modules), or null. */
	readInstalledVersion: (pkg: string) => string | null;
	/** npm dist-tag latest for a package, or null when unresolved. */
	fetchLatestVersion: (pkg: string) => Promise<string | null>;
}

/** Truthy-env gate mirroring isEnforce(). */
function isDepFreshnessEnabled(): boolean {
	const v = (process.env.SWARM_DEP_FRESHNESS_CHECK ?? '').trim().toLowerCase();
	return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function depFreshnessThreshold(): number {
	const raw = (process.env.SWARM_DEP_FRESHNESS_THRESHOLD ?? '').trim();
	if (raw === '') return DEP_FRESHNESS_DEFAULT_THRESHOLD;
	const n = Number.parseInt(raw, 10);
	// Non-numeric input must NOT silently disable the check (every `> NaN` is
	// false); fall back to the default threshold instead.
	return Number.isFinite(n) && n >= 0 ? n : DEP_FRESHNESS_DEFAULT_THRESHOLD;
}

/** Parse `major.minor` from a semver string; null when unparseable. */
export function parseMajorMinor(
	version: string,
): { major: number; minor: number } | null {
	// Strip a leading `v`, then drop build (+) and prerelease (-) metadata.
	const core = version.trim().replace(/^v/, '').split('+')[0].split('-')[0];
	const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(core);
	if (!m) return null;
	return { major: Number.parseInt(m[1], 10), minor: Number.parseInt(m[2], 10) };
}

/**
 * How many "minor series" `latest` is ahead of `locked`.
 *  - Same major: `latest.minor - locked.minor` (0 or negative → not behind).
 *  - `latest.major > locked.major`: Infinity (a major bump is always "far behind").
 *  - `latest.major < locked.major` (locked ahead of latest, unusual): 0.
 * Returns null when either version is unparseable.
 */
export function minorSeriesBehind(
	locked: string,
	latest: string,
): number | null {
	const a = parseMajorMinor(locked);
	const b = parseMajorMinor(latest);
	if (!a || !b) return null;
	if (b.major > a.major) return Number.POSITIVE_INFINITY;
	if (b.major < a.major) return 0;
	return b.minor - a.minor;
}

function defaultReadInstalledVersion(
	root: string,
): (pkg: string) => string | null {
	const { fileExists, readFile } = makeFs(root);
	return (pkg) => {
		const rel = `node_modules/${pkg}/package.json`;
		if (!fileExists(rel)) return null;
		try {
			const parsed = JSON.parse(readFile(rel)) as { version?: unknown };
			return typeof parsed.version === 'string' ? parsed.version : null;
		} catch {
			return null;
		}
	};
}

/**
 * The dist-tags endpoint answers a few hundred bytes. The abbreviated
 * packument used before carries every version's metadata (2.3-2.5 MB for
 * `@opencode-ai/sdk` and growing), read uncapped.
 */
const DEP_FRESHNESS_DIST_TAGS_MAX_BYTES = 64 * 1024;

/** npm dist-tags URL for a package; a scoped name is URL-encoded. */
export function npmDistTagsUrl(pkg: string): string {
	return `https://registry.npmjs.org/-/package/${encodeURIComponent(pkg)}/dist-tags`;
}

/**
 * Resolve npm `latest` for `pkg` from its dist-tags with a bounded read;
 * null on any failure (non-OK status, oversized or unparseable body, timeout).
 */
export async function fetchNpmLatestVersion(
	pkg: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		DEP_FRESHNESS_FETCH_TIMEOUT_MS,
	);
	try {
		const res = await fetchImpl(npmDistTagsUrl(pkg), {
			signal: controller.signal,
		});
		if (!res.ok) return null;
		const body = await readBounded(res, DEP_FRESHNESS_DIST_TAGS_MAX_BYTES);
		if (body === null) return null;
		const tags = JSON.parse(body) as { latest?: unknown };
		return typeof tags.latest === 'string' ? tags.latest : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

async function defaultFetchLatestVersion(pkg: string): Promise<string | null> {
	return fetchNpmLatestVersion(pkg);
}

/**
 * Detect runtime deps whose locked resolution has aged past the threshold behind
 * npm latest (issue #1899). Env-gated OFF by default so local
 * `bun run drift:check` stays offline/deterministic and CI opts in via
 * `SWARM_DEP_FRESHNESS_CHECK=1`. Every finding is a non-blocking `notice`:
 * dependency freshness is an external-world fact a blocked PR cannot fix, so it
 * must never fail a merge even under DRIFT_CHECK_ENFORCE (it stays visible via
 * annotations, the report, and the sticky PR comment). Fail-open on any error.
 */
export async function detectDependencyFreshnessDrift(
	root: string = REPO_ROOT,
	deps: Partial<DepFreshnessDeps> = {},
): Promise<DriftFinding[]> {
	if (!isDepFreshnessEnabled()) return [];
	const category = 'dep-freshness';
	const readInstalledVersion =
		deps.readInstalledVersion ?? defaultReadInstalledVersion(root);
	const fetchLatestVersion = deps.fetchLatestVersion ?? defaultFetchLatestVersion;
	const threshold = depFreshnessThreshold();

	// Fetch both packages' latest concurrently to bound CI latency to one
	// timeout window; each fetch fails to `null`/error in isolation.
	const resolved = await Promise.all(
		DEP_FRESHNESS_PACKAGES.map(async (pkg) => {
			try {
				return { pkg, latest: await fetchLatestVersion(pkg), error: null };
			} catch (err) {
				return { pkg, latest: null, error: err };
			}
		}),
	);

	const findings: DriftFinding[] = [];
	for (const { pkg, latest, error } of resolved) {
		// Defense-in-depth fail-open: any throw during per-package disposition
		// (including an injected/custom `readInstalledVersion`) must degrade to a
		// non-blocking notice, never escape the detector into runAllDetectors/main.
		try {
			if (error) {
				findings.push({
					category,
					severity: 'notice',
					file: 'bun.lock',
					message: `dependency-freshness check errored for "${pkg}": ${error instanceof Error ? error.message : String(error)} (skipped)`,
				});
				continue;
			}
			const locked = readInstalledVersion(pkg);
			if (!locked) {
				findings.push({
					category,
					severity: 'notice',
					file: 'bun.lock',
					message: `could not resolve installed version for "${pkg}" (skipped freshness check)`,
				});
				continue;
			}
			if (!latest) {
				findings.push({
					category,
					severity: 'notice',
					file: 'bun.lock',
					message: `could not resolve npm-latest version for "${pkg}" (network/registry unavailable; skipped)`,
				});
				continue;
			}
			const behind = minorSeriesBehind(locked, latest);
			if (behind === null) {
				findings.push({
					category,
					severity: 'notice',
					file: 'bun.lock',
					message: `could not compare versions for "${pkg}" (locked="${locked}", latest="${latest}")`,
				});
				continue;
			}
			if (behind > threshold) {
				const gap =
					behind === Number.POSITIVE_INFINITY
						? 'a major version'
						: `${behind} minor series`;
				findings.push({
					category,
					severity: 'notice',
					file: 'package.json',
					message: `"${pkg}" locked at ${locked} is ${gap} behind npm latest ${latest} (threshold ${threshold}). Refresh with \`bun update ${pkg}\` and re-audit runtime-shape assumptions (issue #1899).`,
				});
			}
		} catch (err) {
			findings.push({
				category,
				severity: 'notice',
				file: 'bun.lock',
				message: `dependency-freshness disposition errored for "${pkg}": ${err instanceof Error ? err.message : String(err)} (skipped)`,
			});
		}
	}

	return findings;
}

// ---------------------------------------------------------------------------
// 7b) v2 vendored-pin freshness (issue #2910)
// ---------------------------------------------------------------------------

/**
 * The v2 host surface is NOT installed — `src/host/v2/types.ts` vendors the
 * `@opencode/plugin` types behind a provenance pin in its module header. A
 * `DEP_FRESHNESS_PACKAGES` append would probe node_modules for a package that
 * is deliberately absent, permanently resolve null, and silently skip
 * forever. Instead this detector reads the PIN from the vendored corpus file
 * and compares it against npm-latest with the same threshold + fail-open
 * `notice` semantics as the v1 entries above (issue #1899 class).
 */
const V2_VENDORED_PIN_FILE = 'src/host/v2/types.ts';
const V2_VENDORED_PIN_PACKAGE = '@opencode/plugin';
/** Provenance-pinned version in the types.ts module header (first match). */
const V2_VENDORED_PIN_VERSION_RE = /@opencode\/plugin@(\d+\.\d+\.\d+)/;

export interface V2VendoredPinDeps {
	/** Reads the vendored-pin corpus file (src/host/v2/types.ts); null on failure. */
	readPinCorpus: (root: string) => string | null;
	/** npm dist-tag latest for the v2 host package; null when unresolved. */
	fetchLatestVersion: () => Promise<string | null>;
}

function defaultReadV2PinCorpus(root: string): string | null {
	const { fileExists, readFile } = makeFs(root);
	if (!fileExists(V2_VENDORED_PIN_FILE)) return null;
	try {
		return readFile(V2_VENDORED_PIN_FILE);
	} catch {
		return null;
	}
}

/**
 * Resolve npm `latest` for the v2 host package from its dist-tags endpoint
 * (same bounded-read + AbortController idiom as `fetchNpmLatestVersion`; the
 * URL is spelled out via `npmDistTagsUrl('@opencode/plugin')` because the
 * package is deliberately not installed and no lockfile entry names it).
 */
export async function fetchV2PluginLatestVersion(
	fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		DEP_FRESHNESS_FETCH_TIMEOUT_MS,
	);
	try {
		const res = await fetchImpl(npmDistTagsUrl('@opencode/plugin'), {
			signal: controller.signal,
		});
		if (!res.ok) return null;
		const body = await readBounded(res, DEP_FRESHNESS_DIST_TAGS_MAX_BYTES);
		if (body === null) return null;
		const tags = JSON.parse(body) as { latest?: unknown };
		return typeof tags.latest === 'string' ? tags.latest : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Detect the vendored `@opencode/plugin` pin in `src/host/v2/types.ts` aging
 * past the threshold behind npm-latest (issue #2910 W1.2). Env-gated OFF by
 * default like the v1 dep-freshness detector (SWARM_DEP_FRESHNESS_CHECK=1 in
 * CI opts in); every finding is a non-blocking `notice` naming both versions
 * and the vendored-pin corpus path, so a refresh PR can never be blocked by
 * an external-world fact. Fail-open on any error.
 */
export async function detectV2VendoredPinFreshnessDrift(
	root: string = REPO_ROOT,
	deps: Partial<V2VendoredPinDeps> = {},
): Promise<DriftFinding[]> {
	if (!isDepFreshnessEnabled()) return [];
	const category = 'dep-freshness';
	const readPinCorpus = deps.readPinCorpus ?? defaultReadV2PinCorpus;
	const fetchLatestVersion =
		deps.fetchLatestVersion ?? (async () => fetchV2PluginLatestVersion());
	const threshold = depFreshnessThreshold();

	let corpusText: string | null = null;
	try {
		corpusText = readPinCorpus(root);
	} catch (err) {
		return [
			{
				category,
				severity: 'notice',
				file: V2_VENDORED_PIN_FILE,
				message: `dependency-freshness check errored reading the v2 vendored pin: ${err instanceof Error ? err.message : String(err)} (skipped)`,
			},
		];
	}
	if (corpusText === null) {
		return [
			{
				category,
				severity: 'notice',
				file: V2_VENDORED_PIN_FILE,
				message: `could not read the v2 vendored-pin corpus ${V2_VENDORED_PIN_FILE} (skipped freshness check)`,
			},
		];
	}
	const pin = V2_VENDORED_PIN_VERSION_RE.exec(corpusText)?.[1];
	if (!pin) {
		return [
			{
				category,
				severity: 'notice',
				file: V2_VENDORED_PIN_FILE,
				message: `could not find the ${V2_VENDORED_PIN_PACKAGE} provenance pin in ${V2_VENDORED_PIN_FILE} (skipped freshness check)`,
			},
		];
	}

	let latest: string | null = null;
	try {
		latest = await fetchLatestVersion();
	} catch (err) {
		return [
			{
				category,
				severity: 'notice',
				file: V2_VENDORED_PIN_FILE,
				message: `dependency-freshness check errored for the v2 vendored pin "${V2_VENDORED_PIN_PACKAGE}": ${err instanceof Error ? err.message : String(err)} (skipped)`,
			},
		];
	}
	if (!latest) {
		return [
			{
				category,
				severity: 'notice',
				file: V2_VENDORED_PIN_FILE,
				message: `could not resolve npm-latest version for "${V2_VENDORED_PIN_PACKAGE}" (vendored pin in ${V2_VENDORED_PIN_FILE}; network/registry unavailable; skipped)`,
			},
		];
	}
	const behind = minorSeriesBehind(pin, latest);
	if (behind === null) {
		return [
			{
				category,
				severity: 'notice',
				file: V2_VENDORED_PIN_FILE,
				message: `could not compare versions for the v2 vendored pin "${V2_VENDORED_PIN_PACKAGE}" (pin="${pin}", latest="${latest}")`,
			},
		];
	}
	if (behind > threshold) {
		const gap =
			behind === Number.POSITIVE_INFINITY
				? 'a major version'
				: `${behind} minor series`;
		return [
			{
				category,
				severity: 'notice',
				file: V2_VENDORED_PIN_FILE,
				message: `v2 vendored pin "${V2_VENDORED_PIN_PACKAGE}" at ${pin} (${V2_VENDORED_PIN_FILE}) is ${gap} behind npm latest ${latest} (threshold ${threshold}). Re-vendor the types and refresh the provenance header + tests/fixtures/host/expected-structure-v2.json (issue #2910).`,
			},
		];
	}
	return [];
}

// ---------------------------------------------------------------------------
// Config schema / config docs drift (issue #1663)
// ---------------------------------------------------------------------------

/**
 * The checked-in `opencode-swarm.schema.json` must byte-match regeneration
 * from `PluginConfigSchema`. Someone editing `src/config/schema.ts` without
 * rerunning `bun run scripts/generate-config-schema.ts` drifts the shipped
 * editor-validation artifact away from the runtime schema.
 */
export function detectConfigSchemaDrift(root: string = REPO_ROOT): DriftFinding[] {
	const findings: DriftFinding[] = [];
	const category = 'config-schema';
	const schemaPath = path.join(root, CONFIG_SCHEMA_RELATIVE_PATH);

	let checkedIn: string;
	try {
		checkedIn = fs.readFileSync(schemaPath, 'utf-8');
	} catch {
		findings.push({
			category,
			severity: 'error',
			file: CONFIG_SCHEMA_RELATIVE_PATH,
			message: `${CONFIG_SCHEMA_RELATIVE_PATH} is missing — generate it with \`bun run scripts/generate-config-schema.ts\``,
		});
		return findings;
	}

	const expected = serializeConfigSchema();
	if (checkedIn !== expected) {
		const firstDiff = firstDifferingLine(checkedIn, expected);
		findings.push({
			category,
			severity: 'error',
			file: CONFIG_SCHEMA_RELATIVE_PATH,
			message:
				`${CONFIG_SCHEMA_RELATIVE_PATH} is stale (first difference near line ${firstDiff}) — ` +
				'regenerate with `bun run scripts/generate-config-schema.ts` after editing src/config/schema.ts',
		});
	}
	return findings;
}

/**
 * The marker-delimited generated section of `docs/configuration.md` must
 * match regeneration from `PluginConfigSchema`, so the "all configuration
 * keys" reference stays complete as the schema evolves.
 */
export function detectConfigDocsKeysDrift(root: string = REPO_ROOT): DriftFinding[] {
	const findings: DriftFinding[] = [];
	const category = 'config-docs';
	const docsPath = path.join(root, CONFIG_DOCS_RELATIVE_PATH);

	let doc: string;
	try {
		doc = fs.readFileSync(docsPath, 'utf-8');
	} catch {
		findings.push({
			category,
			severity: 'error',
			file: CONFIG_DOCS_RELATIVE_PATH,
			message: `${CONFIG_DOCS_RELATIVE_PATH} not found — cannot verify generated config-keys section`,
		});
		return findings;
	}

	const beginIndex = doc.indexOf(CONFIG_DOCS_MARKER_BEGIN);
	const endIndex = doc.indexOf(CONFIG_DOCS_MARKER_END);
	if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
		findings.push({
			category,
			severity: 'error',
			file: CONFIG_DOCS_RELATIVE_PATH,
			message:
				`generated config-keys markers missing in ${CONFIG_DOCS_RELATIVE_PATH} — ` +
				'restore them and regenerate with `bun run scripts/generate-config-schema.ts`',
		});
		return findings;
	}

	const embedded = doc.slice(
		beginIndex,
		endIndex + CONFIG_DOCS_MARKER_END.length,
	);
	const expected = buildConfigDocsSection();
	if (embedded !== expected) {
		const firstDiff = firstDifferingLine(embedded, expected);
		findings.push({
			category,
			severity: 'error',
			file: CONFIG_DOCS_RELATIVE_PATH,
			message:
				`generated top-level-config-keys section in ${CONFIG_DOCS_RELATIVE_PATH} is stale ` +
				`(first difference near line ${firstDiff}) — regenerate with \`bun run scripts/generate-config-schema.ts\``,
		});
	}
	return findings;
}

function firstDifferingLine(a: string, b: string): number {
	const aLines = a.split('\n');
	const bLines = b.split('\n');
	const max = Math.max(aLines.length, bLines.length);
	for (let i = 0; i < max; i++) {
		if (aLines[i] !== bLines[i]) return i + 1;
	}
	return 0;
}

/** Adapter for the focused external required-check contract gate (#2677). */
export function detectRequiredCheckContractDrift(
	root: string = REPO_ROOT,
): DriftFinding[] {
	const result = collectRequiredCheckContract(root);
	return result.findings.map((finding) => ({
		category: 'required-check-contract',
		severity: finding.severity,
		file: finding.file ?? 'scripts/required-check-contract.json',
		message: `[${finding.code}] ${finding.message}`,
	}));
}

// ---------------------------------------------------------------------------
// Fragment path-class parity (issue #2955)
// ---------------------------------------------------------------------------

/**
 * The legacy hand-maintained fragment-requirement predicate that used to be
 * triplicated across the workflows. Detected as a literal substring on ANY
 * line of ANY workflow file (including comments) so a re-introduced copy —
 * or a comment quoting it — fails parity. Kept as a substring (not a full
 * regex reconstruction) so partial re-introductions are caught too.
 */
export const LEGACY_FRAGMENT_REGEX_SUBSTRING =
	'src/|bin/|scripts/|tests/|test/|runners/|examples/|binaries/';

/**
 * The legacy predicate's alternation tokens (issue #3291). The byte-exact
 * substring above survives as one firing disjunct; this list powers the
 * order/subset-tolerant purity arm: a maximal `token(|token)+` run fires
 * when it has >= 2 members and ALL members are legacy tokens after stripping
 * a leading `^` and a trailing `/` (so `src` == `src/`). A count-based
 * threshold cannot work on this repo: ci.yml's path filter has 14 members
 * (its run capture holds 13 — the backslash in the final `\.github/workflows/`
 * member falls outside the run character class) and embeds exactly 2
 * exact-member legacy hits, so count-2-by-members would fire the real tree.
 * Accepted trade-off (issue #3291 round 2, F-7): the arm is a heuristic and
 * also fires on legitimate non-classification text — a `case` statement or
 * `grep -E` trigger over two legacy dirs — which surfaces as a false-positive
 * drift error on an --enforced gate; fail-closed direction, deliberately
 * accepted over a count rule that cannot distinguish the real filter.
 */
const LEGACY_FRAGMENT_TOKENS: readonly string[] =
	LEGACY_FRAGMENT_REGEX_SUBSTRING.split('|').map((token) =>
		token.replace(/\/$/, ''),
	);

// The lookbehind keeps matched runs maximal-left (linear scan; without it a
// long pipe-free run of class characters rescans at ~n² — measured 433 s at
// the 512 KiB read bound, 15 ms with the lookbehind). `^` is a run character
// so per-member caret forms (`^src/|^bin/`) are captured and normalized.
const LEGACY_ALTERNATION_RUN =
	/(?<![A-Za-z0-9_.\-/*^])[A-Za-z0-9_.\-/*^]+(?:\|[A-Za-z0-9_.\-/*^]+)+/g;

/**
 * True when `text` carries a hand-maintained fragment-classification
 * predicate under the tolerance rules above. Exported so the parity suite's
 * workflow scan mirrors the detector exactly (issue #3291 NEW-1).
 */
export function isLegacyPredicateAlternation(text: string): boolean {
	for (const run of text.match(LEGACY_ALTERNATION_RUN) ?? []) {
		const members = run.split('|');
		const allLegacy = members.every((member) => {
			const normalized = member.replace(/^\^/, '').replace(/\/$/, '');
			return LEGACY_FRAGMENT_TOKENS.includes(normalized);
		});
		if (allLegacy) return true;
	}
	return false;
}

/** Per-site minimum counts of shared-classifier invocations (issue #2955). */
export const FRAGMENT_CLASSIFIER_ANCHOR_SITES: ReadonlyArray<{
	file: string;
	minInvocations: number;
}> = [
	{ file: '.github/workflows/pr-standards.yml', minInvocations: 2 },
	{ file: '.github/workflows/release-and-publish.yml', minInvocations: 1 },
];

/** The full invocation form anchors a real consumer, not a comment mention. */
const FRAGMENT_CLASSIFIER_ANCHOR =
	'check-pending-fragment.ts --print-requirement';

const WORKFLOW_READ_MAX_BYTES = 512 * 1024;

function readWorkflowBounded(absolute: string): string | null {
	try {
		const stat = fs.statSync(absolute);
		if (!stat.isFile()) return null;
		if (stat.size > WORKFLOW_READ_MAX_BYTES) {
			throw new Error(
				`workflow exceeds the ${WORKFLOW_READ_MAX_BYTES}-byte read bound`,
			);
		}
		return fs.readFileSync(absolute, 'utf8');
	} catch {
		return null;
	}
}

/**
 * Fragment-gate parity detector (#2955): the user-visible path verdict is
 * single-sourced in scripts/user-visible-paths.ts and consumed via
 * check-pending-fragment.ts --print-requirement. Errors when (a) the legacy
 * hand-maintained regex reappears under .github/workflows/ (any file, any
 * line, comments included) or (b) any pinned consumer file drops below its
 * minimum classifier invocations (reverting a single arm trips this).
 * Missing pinned files are notices (trimmed forks fail open), matching the
 * absence-handling shape of the other detectors.
 */
export function detectFragmentPathParity(
	root: string = REPO_ROOT,
): DriftFinding[] {
	const findings: DriftFinding[] = [];
	const workflowsDir = path.join(root, '.github', 'workflows');
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(workflowsDir, { withFileTypes: true });
	} catch {
		return findings;
	}
	const contents = new Map<string, string | null>();
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith('.yml') && !entry.name.endsWith('.yaml')) continue;
		const rel = `.github/workflows/${entry.name}`;
		contents.set(rel, readWorkflowBounded(path.join(workflowsDir, entry.name)));
	}
	for (const [rel, text] of contents) {
		if (text === null) continue;
		if (
			text.includes(LEGACY_FRAGMENT_REGEX_SUBSTRING) ||
			isLegacyPredicateAlternation(text)
		) {
			findings.push({
				category: 'fragment-path-parity',
				severity: 'error',
				file: rel,
				message:
					'[FRAGMENT_PATH_PARITY] hand-maintained fragment-requirement path predicate re-introduced — path classification must consume scripts/user-visible-paths.ts via check-pending-fragment.ts --print-requirement (issue #2955)',
			});
		}
	}
	for (const site of FRAGMENT_CLASSIFIER_ANCHOR_SITES) {
		const text = contents.get(site.file);
		if (text === undefined) {
			findings.push({
				category: 'fragment-path-parity',
				severity: 'notice',
				file: site.file,
				message:
					'[FRAGMENT_PATH_PARITY] pinned fragment-gate workflow absent; skipping anchor count',
			});
			continue;
		}
		if (text === null) {
			findings.push({
				category: 'fragment-path-parity',
				severity: 'error',
				file: site.file,
				message: '[FRAGMENT_PATH_PARITY] pinned fragment-gate workflow unreadable',
			});
			continue;
		}
		// Count only non-comment lines: a YAML comment quoting the full
		// invocation form must not keep the count green after a real
		// consumer is reverted (comment decoys are visible in review, but
		// the counter should not depend on that).
		let invocations = 0;
		for (const line of text.split('\n')) {
			if (line.trimStart().startsWith('#')) continue;
			if (line.includes(FRAGMENT_CLASSIFIER_ANCHOR)) invocations++;
		}
		if (invocations < site.minInvocations) {
			findings.push({
				category: 'fragment-path-parity',
				severity: 'error',
				file: site.file,
				message: `[FRAGMENT_PATH_PARITY] only ${invocations} shared-classifier invocations (minimum ${site.minInvocations}) — a fragment-gate arm was reverted to hand-maintained classification (issue #2955)`,
			});
		}
	}
	return findings;
}

// ---------------------------------------------------------------------------
// User-global skill staleness (issue #2859 F6)
// ---------------------------------------------------------------------------

/** PR-workflow skills whose canonical copy carries a content stamp. */
export const STAMPED_PR_WORKFLOW_SKILLS = [
	'swarm-pr-review',
	'swarm-pr-feedback',
	'swarm-pr-subscribe',
	'swarm-ci-monitor',
] as const;

// Issue #2601: the digest primitives live in the shared src module so the
// runtime verification (src/services/pr-workflow-skill-contract.ts) and this
// dev-time detector can never disagree. Re-exported here for the existing
// consumers (scripts/stamp-skill-contracts.ts and the #2859 test suites);
// readSkillContractStamp stays file-local (no consumer needs it via this
// module's surface).
import {
	readSkillContractStamp,
	SKILL_CONTRACT_DIGEST_KEY,
	skillContractDigest,
	splitSkillFrontmatter,
} from '../src/config/skill-contract-digest.js';
export {
	SKILL_CONTRACT_DIGEST_KEY,
	skillContractDigest,
	splitSkillFrontmatter,
};

/**
 * Env-var-aware home resolution: os.homedir() ignores process.env entirely
 * (see tests/helpers/isolated-test-env.ts), so the env vars are consulted
 * FIRST to keep the detector testable against a temp HOME fixture. Production
 * resolution matches os.homedir() semantics on every platform.
 */
function resolveUserGlobalHomeDefault(): string {
	if (process.platform === 'win32') {
		const userProfile = process.env.USERPROFILE?.trim();
		if (userProfile) return userProfile;
	} else {
		const home = process.env.HOME?.trim();
		if (home) return home;
	}
	return os.homedir();
}

/**
 * Issue #2859 (F6): a stale user-global copy of a bundled skill can shadow
 * the repository canonical with zero detection (a 10-week-old copy taught a
 * dead output contract on the PR #2824 review run). READ-ONLY detection:
 * compare the repo canonical body digest against any user-global copy of the
 * same skill; warn when they diverge. User-global trees are NEVER written.
 * Repo-side stamp rot is a warning (refresh with the stamp script); a stale
 * user-global copy is a notice — advisory only, never blocks.
 */
export function detectUserGlobalSkillStaleness(
	root: string = REPO_ROOT,
): DriftFinding[] {
	const findings: DriftFinding[] = [];
	const category = 'user-global-skill-staleness';
	const home = _internals.resolveUserGlobalHome();
	for (const slug of STAMPED_PR_WORKFLOW_SKILLS) {
		const relativePath = `.opencode/skills/${slug}/SKILL.md`;
		let canonicalContent: string;
		try {
			canonicalContent = fs.readFileSync(path.join(root, relativePath), 'utf8');
		} catch {
			// Missing canonical skills are the bundled-skill detector's domain.
			continue;
		}
		const { frontmatter, body } = splitSkillFrontmatter(canonicalContent);
		const actualDigest = skillContractDigest(body);
		const stampedDigest = readSkillContractStamp(frontmatter);
		if (stampedDigest !== actualDigest) {
			findings.push({
				category,
				severity: 'warning',
				file: relativePath,
				message: `stale ${SKILL_CONTRACT_DIGEST_KEY} stamp for skill '${slug}': frontmatter says ${stampedDigest ?? '<none>'}, body content hashes to ${actualDigest}; run 'bun run scripts/stamp-skill-contracts.ts --write'`,
			});
			// NO continue here (PR #3387 follow-up, FB-029): the user-global
			// shadowing comparison below must run regardless of the repo-side
			// stamp state — a missing or stale stamp is exactly when the
			// canonical body is least vouched for, and the old `continue`
			// let a stale user-global copy escape detection in that case.
		}
		for (const userRelative of [
			`.opencode/skills/${slug}/SKILL.md`,
			`.claude/skills/${slug}/SKILL.md`,
		]) {
			const userPath = path.join(home, userRelative);
			if (!fs.existsSync(userPath)) continue;
			let userContent: string;
			try {
				userContent = fs.readFileSync(userPath, 'utf8');
			} catch {
				continue;
			}
			const userDigest = skillContractDigest(
				splitSkillFrontmatter(userContent).body,
			);
			if (userDigest === actualDigest) continue;
			findings.push({
				category,
				severity: 'notice',
				file: relativePath,
				message: `user-global copy of skill '${slug}' is stale: ${userPath} (digest ${userDigest}) differs from the repository copy ${path.join(root, relativePath)} (digest ${actualDigest}); the repository copy is authoritative — delete the stale user-global copy`,
			});
		}
	}
	return findings;
}

/**
 * Issue #2601: the `.swarm/bundled-skills/<slug>` installed copies are the
 * surface MODE entry actually loads, but until now nothing compared their
 * content against the shipped canonical (the bundled-skill detector above
 * validates registry shape only). A stale installed copy is what an
 * auto-resumed session executes. READ-ONLY detection over the worktree's
 * local runtime tree: absent surface stays silent (CI checkouts have no
 * `.swarm/`), a stale copy is a WARNING so `--enforce` blocks on it — the
 * runtime activation/wake verification (src/services/pr-workflow-skill-contract.ts)
 * heals the copy; this detector is the dev-time backstop that names it.
 */
export function detectBundledSkillStaleness(
	root: string = REPO_ROOT,
): DriftFinding[] {
	const findings: DriftFinding[] = [];
	const category = 'bundled-skill-staleness';
	for (const slug of STAMPED_PR_WORKFLOW_SKILLS) {
		const canonicalRelative = `.opencode/skills/${slug}/SKILL.md`;
		let canonicalContent: string;
		try {
			canonicalContent = fs.readFileSync(
				path.join(root, canonicalRelative),
				'utf8',
			);
		} catch {
			continue;
		}
		const canonicalDigest = skillContractDigest(
			splitSkillFrontmatter(canonicalContent).body,
		);
		const installedRelative = `.swarm/bundled-skills/${slug}/SKILL.md`;
		const installedPath = path.join(root, installedRelative);
		if (!fs.existsSync(installedPath)) continue;
		let installedContent: string;
		try {
			installedContent = fs.readFileSync(installedPath, 'utf8');
		} catch {
			continue;
		}
		const installedDigest = skillContractDigest(
			splitSkillFrontmatter(installedContent).body,
		);
		if (installedDigest === canonicalDigest) continue;
		findings.push({
			category,
			severity: 'warning',
			file: installedRelative,
			message: `installed bundled copy of skill '${slug}' is stale: ${installedPath} (digest ${installedDigest}) differs from the shipped canonical ${path.join(root, canonicalRelative)} (digest ${canonicalDigest}); re-run any /swarm command or restart the host to re-sync, or delete the stale .swarm/bundled-skills/${slug} directory`,
		});
	}
	return findings;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// Exported for test introspection: tests assert that every expected category
// is actually registered, which runSyncDetectors alone cannot prove (a
// detector dropped from this list simply stops running).
export const DETECTORS: Array<[string, () => DriftFinding[]]> = [
	['skill-mirror', detectSkillMirrorDrift],
	['skill-audience', detectSkillAudienceDrift],
	['skill-frontmatter', detectSkillFrontmatterSpecDrift],
	['bundled-skill', detectBundledSkillDrift],
	['skill-reference', detectSkillReferenceDrift],
	['duplicate-slug', detectDuplicateSlugs],
	['package-json-files', detectPackageJsonFilesDuplicates],
	['tool', detectToolRegistrationDrift],
	['event-contract', detectEventContractDrift],
	['core-events-usage', detectCoreEventsUsageDrift],
	['shell-audit-usage', detectShellAuditUsageDrift],
	['trajectory-store-usage', detectTrajectoryStoreUsageDrift],
	['command', detectCommandDrift],
	['agent', detectAgentDrift],
	['docs-claim', detectDocsClaimDrift],
	['config-schema', detectConfigSchemaDrift],
	['config-docs', detectConfigDocsKeysDrift],
	['gates-docs', detectGatesConfigDrift],
	['required-check-contract', detectRequiredCheckContractDrift],
	['fragment-path-parity', detectFragmentPathParity],
	['user-global-skill-staleness', detectUserGlobalSkillStaleness],
	['bundled-skill-staleness', detectBundledSkillStaleness],
];

/**
 * Run all synchronous detectors. Exported separately so tests that only care about
 * sync drift categories can call this without triggering async git operations.
 */
export function runSyncDetectors(): DriftFinding[] {
	const findings: DriftFinding[] = [];
	for (const [, detector] of DETECTORS) {
		findings.push(...detector());
	}
	return findings;
}

/**
 * Run all detectors, including the async skill-assertion check (FR-002).
 */
export async function runAllDetectors(): Promise<DriftFinding[]> {
	const findings = runSyncDetectors();
	const skillFindings = await detectSkillAssertionDrift();
	findings.push(...skillFindings);
	// Dependency-freshness (issue #1899): env-gated OFF by default, so this is a
	// no-op for local `bun run drift:check` and leaves the sync-detector tests
	// untouched. CI opts in via SWARM_DEP_FRESHNESS_CHECK=1. Fail-open, advisory
	// `notice` only — never blocks a merge.
	const depFindings = await detectDependencyFreshnessDrift();
	findings.push(...depFindings);
	// v2 vendored-pin freshness (issue #2910 W1.2): the same env gate, threshold,
	// and fail-open notice semantics, over the @opencode/plugin pin in
	// src/host/v2/types.ts (deliberately NOT installed — see the detector).
	const v2PinFindings = await detectV2VendoredPinFreshnessDrift();
	findings.push(...v2PinFindings);
	return findings;
}

/**
 * Run the skill-assertion check (FR-002 / issue #1746 item 3).
 * Reuses the same logic as `bun run scripts/check-skill-assertions.ts` but
 * returns DriftFinding[] so it slots into runAllDetectors without subprocess.
 */
export async function detectSkillAssertionDrift(
	cwd: string = REPO_ROOT,
): Promise<DriftFinding[]> {
	const result = await checkSkillAssertions(cwd);
	return result.brokenAssertions.map((b) => ({
		category: 'skill-assertion',
		severity: 'notice' as const,
		file: b.testFile,
		message:
			`Test at ${b.testFile}:${b.line} asserts "${b.phrase}" ` +
			`but that phrase is no longer present in "${b.skillFile}"`,
	}));
}

function escapeAnnotationData(s: string): string {
	return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeAnnotationParam(s: string): string {
	return escapeAnnotationData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

export function annotation(finding: DriftFinding): string {
	const level = finding.severity === 'notice' ? 'notice' : finding.severity;
	// GitHub workflow-command syntax: `::level params::message`, or `::level::message`
	// when there are no params. Every detector currently sets `file`, but guard the
	// fileless case so it stays valid syntax rather than `::level ::message`.
	// Values are URL-encoded per GitHub docs to prevent annotation injection.
	const params = finding.file ? ` file=${escapeAnnotationParam(finding.file)}` : '';
	return `::${level}${params}::[drift:${finding.category}] ${escapeAnnotationData(finding.message)}`;
}

export function buildReport(
	findings: DriftFinding[],
	extras: string[] = [],
): string {
	const MAX_REPORT_BYTES = 64 * 1024;
	const lines: string[] = ['# Drift check report', ''];
	if (findings.length === 0) {
		lines.push(
			'✅ No drift detected across skills, tools, commands, agents, docs claims, and dependency freshness.',
		);
		lines.push('');
		// Quarantine census block (issue #2905): rendered on zero-finding runs
		// too — the aging view matters most on otherwise-green PRs.
		if (extras.length > 0) {
			lines.push('### Quarantine census', '', ...extras, '');
		}
		return lines.join('\n');
	}

	const counts = { error: 0, warning: 0, notice: 0 };
	for (const f of findings) counts[f.severity]++;
	lines.push(
		`Found **${findings.length}** drift finding(s): ${counts.error} error, ${counts.warning} warning, ${counts.notice} notice.`,
		'',
	);

	const byCategory = new Map<string, DriftFinding[]>();
	for (const f of findings) {
		const list = byCategory.get(f.category) ?? [];
		list.push(f);
		byCategory.set(f.category, list);
	}
	for (const [category, list] of byCategory) {
		lines.push(`## ${category} (${list.length})`, '');
		for (const f of list) {
			const icon =
				f.severity === 'error' ? '🔴' : f.severity === 'warning' ? '🟡' : '🔵';
			const where = f.file ? ` \`${f.file}\`` : '';
			lines.push(`- ${icon} **${f.severity}**${where}: ${f.message}`);
		}
		lines.push('');
	}
	if (extras.length > 0) {
		lines.push('### Quarantine census', '', ...extras, '');
	}
	const report = lines.join('\n');
	if (Buffer.byteLength(report, 'utf8') <= MAX_REPORT_BYTES) return report;
	const marker = '\n\n… report truncated at 65536 bytes …\n';
	const budget = MAX_REPORT_BYTES - Buffer.byteLength(marker, 'utf8');
	let truncated = report.slice(0, budget);
	while (Buffer.byteLength(truncated + marker, 'utf8') > MAX_REPORT_BYTES) {
		truncated = truncated.slice(0, Math.max(0, truncated.length - 256));
	}
	return truncated + marker;
}

export function isEnforce(explicit = false): boolean {
	if (explicit) return true;
	const v = (process.env.DRIFT_CHECK_ENFORCE ?? '').trim().toLowerCase();
	return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function parseArgs(argv: string[]): {
	reportPath: string | null;
	json: boolean;
	fix: boolean;
	confirm: boolean;
	enforce: boolean;
} {
	let reportPath: string | null = 'drift-report.md';
	let json = false;
	let fix = false;
	let confirm = false;
	let enforce = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--no-report') reportPath = null;
		else if (arg === '--report') reportPath = argv[++i] ?? reportPath;
		else if (arg === '--json') json = true;
		else if (arg === '--fix') fix = true;
		else if (arg === '--confirm') confirm = true;
		else if (arg === '--enforce') enforce = true;
	}
	return { reportPath, json, fix, confirm, enforce };
}

async function main(): Promise<void> {
	const { reportPath, json, fix, confirm, enforce } = parseArgs(
		process.argv.slice(2),
	);

	// Issue #1781 E3: `drift:fix` reconciles mirrored skill pairs before
	// detection. It is a developer convenience (env-guarded or --confirm,
	// never a CI mutation). Refuse to run under DRIFT_CHECK_ENFORCE so a CI
	// accident can never mutate native skill roots (AGENTS.md invariant 4).
	if (fix) {
		if (isEnforce(enforce)) {
			console.error(
				'drift-check: --fix is a developer tool and must not run while enforcement is enabled (would mutate native skill roots in CI).',
			);
			process.exit(1);
		}
		const synced = fixSkillMirrorDrift(REPO_ROOT, { confirmed: confirm });
		if (synced.length > 0) {
			console.log(`drift-check --fix: synced ${synced.length} skill mirror(s):`);
			for (const f of synced) {
				console.log(`  - ${f.file}: ${f.message}`);
			}
		} else {
			console.log('drift-check --fix: no mirrored skills were out of sync.');
		}
	}

	const findings = await runAllDetectors();

	for (const finding of findings) {
		// Annotations go to stdout so they render inline in the Actions log.
		console.log(annotation(finding));
	}

	// Quarantine census block (issue #2905): always part of the report — even
	// on zero-finding green runs, where expiry pressure matters most.
	const censusTrend = await collectAddRetireTrend(REPO_ROOT);
	const census = buildQuarantineCensus(readLedgerContents(REPO_ROOT), new Date());
	const censusExtras = formatQuarantineCensus(census, censusTrend);

	const report = buildReport(findings, censusExtras);
	if (reportPath) {
		fs.writeFileSync(path.join(REPO_ROOT, reportPath), report, 'utf-8');
	}

	if (json) {
		console.log(JSON.stringify(findings, null, 2));
	} else {
		console.log(`\n${report}`);
	}

	const blocking = findings.filter((f) => f.severity !== 'notice');
	const enforceFindings = isEnforce(enforce);
	if (blocking.length > 0 && enforceFindings) {
		console.error(
			`\ndrift-check: ${blocking.length} blocking finding(s) with enforcement enabled — failing.`,
		);
		process.exit(1);
	}
	if (blocking.length > 0) {
		console.warn(
			`\ndrift-check: ${blocking.length} finding(s) detected (soft-warn; set DRIFT_CHECK_ENFORCE=1 to fail).`,
		);
	}
}

if (import.meta.main) {
	main();
}
