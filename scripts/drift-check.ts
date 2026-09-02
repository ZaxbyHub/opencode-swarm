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
 *   9. dep-freshness    — locked @opencode-ai/* resolution vs npm-latest (issue
 *                         #1899). Env-gated (SWARM_DEP_FRESHNESS_CHECK) and
 *                         fail-open: emits advisory `notice` findings only, never
 *                         blocks, so a stale lockfile can't silently age again.
 *
 * Output:
 *   - GitHub Actions annotations (`::warning file=...::message`) on stdout.
 *   - A structured markdown report (default written to drift-report.md, override
 *     with --report <path>; suppress with --no-report).
 *   - Exit code: 0 by default (soft-warn). When DRIFT_CHECK_ENFORCE is truthy
 *     ("1"/"true"/"yes"), exits 1 if any error/warning finding exists.
 *
 * Usage: bun run scripts/drift-check.ts [--report <path>] [--no-report] [--json]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	collectToolRegistrationErrors,
	type ToolRegistrationCheckOptions,
} from './check-tool-registration';
import { collectEventContractErrors } from './check-event-contract';
import { collectCoreEventsUsageErrors } from './check-core-events-usage';
import { collectShellAuditUsageErrors } from './check-shell-audit-usage';
import { collectTrajectoryStoreUsageErrors } from './check-trajectory-store-usage';
import { detectDocsClaimDrift } from './drift-check-docs-claims';
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
export const _internals = { _checkDuplicateSlugsFromArrays };

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
					message: `static skill "${slug}" must declare a valid top-level audience`,
				});
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

async function defaultFetchLatestVersion(pkg: string): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		DEP_FRESHNESS_FETCH_TIMEOUT_MS,
	);
	try {
		// Abbreviated packument (Accept header) carries `dist-tags` without the
		// full version history. Scoped name is URL-encoded (`@scope%2Fname`).
		const res = await fetch(
			`https://registry.npmjs.org/${encodeURIComponent(pkg)}`,
			{
				headers: { accept: 'application/vnd.npm.install-v1+json' },
				signal: controller.signal,
			},
		);
		if (!res.ok) return null;
		const body = (await res.json()) as { 'dist-tags'?: { latest?: unknown } };
		const latest = body['dist-tags']?.latest;
		return typeof latest === 'string' ? latest : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
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

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// Exported for test introspection: tests assert that every expected category
// is actually registered, which runSyncDetectors alone cannot prove (a
// detector dropped from this list simply stops running).
export const DETECTORS: Array<[string, () => DriftFinding[]]> = [
	['skill-mirror', detectSkillMirrorDrift],
	['skill-audience', detectSkillAudienceDrift],
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

export function buildReport(findings: DriftFinding[]): string {
	const lines: string[] = ['# Drift check report', ''];
	if (findings.length === 0) {
		lines.push(
			'✅ No drift detected across skills, tools, commands, agents, docs claims, and dependency freshness.',
		);
		lines.push('');
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
	return lines.join('\n');
}

function isEnforce(): boolean {
	const v = (process.env.DRIFT_CHECK_ENFORCE ?? '').trim().toLowerCase();
	return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function parseArgs(argv: string[]): {
	reportPath: string | null;
	json: boolean;
	fix: boolean;
	confirm: boolean;
} {
	let reportPath: string | null = 'drift-report.md';
	let json = false;
	let fix = false;
	let confirm = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--no-report') reportPath = null;
		else if (arg === '--report') reportPath = argv[++i] ?? reportPath;
		else if (arg === '--json') json = true;
		else if (arg === '--fix') fix = true;
		else if (arg === '--confirm') confirm = true;
	}
	return { reportPath, json, fix, confirm };
}

async function main(): Promise<void> {
	const { reportPath, json, fix, confirm } = parseArgs(process.argv.slice(2));

	// Issue #1781 E3: `drift:fix` reconciles mirrored skill pairs before
	// detection. It is a developer convenience (env-guarded or --confirm,
	// never a CI mutation). Refuse to run under DRIFT_CHECK_ENFORCE so a CI
	// accident can never mutate native skill roots (AGENTS.md invariant 4).
	if (fix) {
		if (isEnforce()) {
			console.error(
				'drift-check: --fix is a developer tool and must not run under DRIFT_CHECK_ENFORCE (would mutate native skill roots in CI).',
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

	const report = buildReport(findings);
	if (reportPath) {
		fs.writeFileSync(path.join(REPO_ROOT, reportPath), report, 'utf-8');
	}

	if (json) {
		console.log(JSON.stringify(findings, null, 2));
	} else {
		console.log(`\n${report}`);
	}

	const blocking = findings.filter((f) => f.severity !== 'notice');
	const enforce = isEnforce();
	if (blocking.length > 0 && enforce) {
		console.error(
			`\ndrift-check: ${blocking.length} blocking finding(s) and DRIFT_CHECK_ENFORCE is set — failing.`,
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
