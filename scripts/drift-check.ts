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
import { collectToolRegistrationErrors } from './check-tool-registration';
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
import {
	ADAPTER_ARCHITECT_MODE_SKILLS,
	ADDITIONAL_SKILL_MIRROR_CONTRACTS,
	DIVERGENT_ARCHITECT_MODE_SKILLS,
	MIRRORED_ARCHITECT_MODE_SKILLS,
	NON_SKILL_OPENCODE_DIRS,
	OPENCODE_ONLY_ARCHITECT_MODE_SKILLS,
} from '../src/config/skill-mirrors';

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
	fileExists: (relativePath: string) => boolean;
	readFile: (relativePath: string) => string;
	listDirNames: (relativePath: string) => string[];
}

/**
 * Filesystem helpers bound to a repo root. Detectors accept an optional root so
 * tests can point them at a synthetic fixture tree without mutating the repo.
 */
function makeFs(root: string): FsHelpers {
	const abs = (relativePath: string): string => path.join(root, relativePath);
	return {
		abs,
		fileExists: (relativePath) => fs.existsSync(abs(relativePath)),
		readFile: (relativePath) => fs.readFileSync(abs(relativePath), 'utf-8'),
		listDirNames: (relativePath) => {
			const dir = abs(relativePath);
			if (!fs.existsSync(dir)) return [];
			return fs
				.readdirSync(dir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name);
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
	for (const [slug, opencodePath, claudePath] of MIRRORED_ARCHITECT_MODE_SKILLS) {
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
		} else if (kind === 'divergent') {
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

	return findings;
}

// ---------------------------------------------------------------------------
// 2) Bundled-skill completeness drift (issue #1496 class)
// ---------------------------------------------------------------------------

interface PackageJson {
	files?: string[];
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

export function detectToolRegistrationDrift(): DriftFinding[] {
	return collectToolRegistrationErrors().map((message) => ({
		category: 'tool',
		severity: 'error' as const,
		file: 'src/tools/tool-metadata.ts',
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
// Orchestration
// ---------------------------------------------------------------------------

const DETECTORS: Array<[string, () => DriftFinding[]]> = [
	['skill-mirror', detectSkillMirrorDrift],
	['bundled-skill', detectBundledSkillDrift],
	['tool', detectToolRegistrationDrift],
	['command', detectCommandDrift],
	['agent', detectAgentDrift],
];

export function runAllDetectors(): DriftFinding[] {
	const findings: DriftFinding[] = [];
	for (const [, detector] of DETECTORS) {
		findings.push(...detector());
	}
	return findings;
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
		lines.push('✅ No drift detected across skills, tools, commands, and agents.');
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

function parseArgs(argv: string[]): { reportPath: string | null; json: boolean } {
	let reportPath: string | null = 'drift-report.md';
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--no-report') reportPath = null;
		else if (arg === '--report') reportPath = argv[++i] ?? reportPath;
		else if (arg === '--json') json = true;
	}
	return { reportPath, json };
}

function main(): void {
	const { reportPath, json } = parseArgs(process.argv.slice(2));
	const findings = runAllDetectors();

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
