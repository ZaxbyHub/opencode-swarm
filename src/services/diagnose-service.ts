import * as child_process from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../../package.json' with { type: 'json' };
import {
	discoverVersionPinnedCachePaths,
	getPluginCachePaths,
	resolveCachePackageRoot,
} from '../config/cache-paths.js';
import { loadPluginConfig } from '../config/loader';
import type { Plan } from '../config/plan-schema';
import { getSwarmDbHealthSnapshot } from '../db/health.js';
import { getCoreEventCoverage, readCoreEvents } from '../events/core-events.js';
import { getDurableGateEvidenceStatusForTask } from '../evidence/gate-bridge.js';
import { listEvidenceTaskIds } from '../evidence/manager';
import { listBlockingActionCircuitsForInvocation } from '../failures/action-circuit.js';
import { loadFullAutoRunState } from '../full-auto/state.js';
import { readLearningHealth } from '../health/learning-health';
import { readSwarmFileAsync } from '../hooks/utils';
import { getTaskModelRoutingStateSnapshot } from '../models/task-model-routing.js';
import { loadPlanJsonOnly } from '../plan/manager';
import { SandboxCapabilityProbe } from '../sandbox/capability-probe.js';
import { getExecutor } from '../sandbox/executor.js';
import { getSandboxSkipSummary } from '../sandbox/skip-state.js';
import { readEffectiveSpecSync } from '../sdd/effective-spec';
import { getAgentSession } from '../state.js';
import { resolveGitExecutableAsync } from '../utils/git-executable.js';
import { listCoderSettlementWalStates } from '../workflow/coder-settlement.js';
import { checkKnowledgeHealth } from './knowledge-diagnostics.js';
import { inventorySwarmResidue } from './swarm-residue.js';
import { compareVersions, readVersionCache } from './version-check.js';
import { getDeferredWarnings } from './warning-buffer.js';

const { version } = packageJson;
const sandboxCapabilityProbe = new SandboxCapabilityProbe();
const REQUIRED_CACHE_GRAMMAR_ASSETS = [
	'tree-sitter.wasm',
	'tree-sitter-javascript.wasm',
	'tree-sitter-typescript.wasm',
] as const;

export const _internals = {
	detectSandboxCapability: () => sandboxCapabilityProbe.detect(),
	getSandboxExecutor: getExecutor,
};

/**
 * A single health check result.
 */
export interface HealthCheck {
	name: string;
	status: '✅' | '❌' | '⚠️' | '⬜';
	detail: string;
}

/** quick_check size cap (rendered into the warning text). */
const SWARM_DB_QUICK_CHECK_MAX_BYTES = 64 * 1024 * 1024;

/**
 * #2480: `.swarm/swarm.db` health — quick_check integrity, journal mode,
 * page count, recorded migration failures, and the active driver/runtime vs
 * the declared support floors. The DB probe itself lives in `src/db/health.ts`
 * (the sanctioned read-only surface); diagnose only renders the snapshot.
 * Never opens-for-create (an absent DB is healthy) and never throws.
 */
function checkSwarmDb(directory: string): HealthCheck {
	const runtime = process.versions.bun === undefined ? 'node' : 'bun';
	const runtimeVersion =
		process.versions.bun ?? process.versions.node ?? 'unknown';
	const snapshot = getSwarmDbHealthSnapshot(directory);
	switch (snapshot.kind) {
		case 'absent':
			return {
				name: 'swarm.db',
				status: '✅',
				detail: `not created yet (driver: ${runtime} ${runtimeVersion})`,
			};
		case 'too_large':
			return {
				name: 'swarm.db',
				status: '⚠️',
				detail: `${Math.round(snapshot.sizeBytes / (1024 * 1024))} MiB exceeds the ${Math.round(
					SWARM_DB_QUICK_CHECK_MAX_BYTES / (1024 * 1024),
				)} MiB inline quick_check cap — run an external integrity check (driver: ${runtime} ${runtimeVersion})`,
			};
		case 'error':
			return {
				name: 'swarm.db',
				status: '❌',
				detail: `unavailable (${snapshot.category}): ${snapshot.message}`,
			};
		case 'open': {
			const markerNote = snapshot.staleMarker
				? ', stale db-migration-failure.json marker present'
				: '';
			const detail = `quick_check ${snapshot.quickCheck}; ${snapshot.journalMode} mode, ${snapshot.pageCount} pages, ${snapshot.migrationFailures} recorded migration failure(s)${markerNote}; driver: ${runtime} ${runtimeVersion}`;
			if (snapshot.quickCheck !== 'ok') {
				return { name: 'swarm.db', status: '❌', detail };
			}
			if (snapshot.migrationFailures > 0 || snapshot.staleMarker) {
				return { name: 'swarm.db', status: '⚠️', detail };
			}
			return { name: 'swarm.db', status: '✅', detail };
		}
	}
}

/**
 * Structured diagnose data returned by the diagnose service.
 */
export interface DiagnoseData {
	checks: HealthCheck[];
	passCount: number;
	totalCount: number;
	allPassed: boolean;
	deferredWarnings: readonly string[];
}

/**
 * Validate task dependencies in a plan.
 */
function validateTaskDag(plan: Plan): {
	valid: boolean;
	missingDeps: string[];
} {
	const allTaskIds = new Set<string>();
	for (const phase of plan.phases) {
		for (const task of phase.tasks) {
			allTaskIds.add(task.id);
		}
	}

	const missingDeps: string[] = [];
	for (const phase of plan.phases) {
		for (const task of phase.tasks) {
			for (const dep of task.depends) {
				if (!allTaskIds.has(dep)) {
					missingDeps.push(`${task.id} depends on missing ${dep}`);
				}
			}
		}
	}

	return { valid: missingDeps.length === 0, missingDeps };
}

/**
 * Check evidence completeness against completed tasks.
 */
async function checkEvidenceCompleteness(
	directory: string,
	plan: Plan,
): Promise<HealthCheck> {
	const completedTaskIds: string[] = [];
	for (const phase of plan.phases) {
		for (const task of phase.tasks) {
			if (task.status === 'completed') {
				completedTaskIds.push(task.id);
			}
		}
	}

	if (completedTaskIds.length > 0) {
		const evidenceTaskIds = new Set(await listEvidenceTaskIds(directory));
		const missingEvidence: string[] = [];
		for (const id of completedTaskIds) {
			const gateStatus = await getDurableGateEvidenceStatusForTask(
				directory,
				id,
			);
			if (gateStatus.isComplete) {
				continue;
			}
			if (gateStatus.evidenceExists && gateStatus.missingGates.length > 0) {
				missingEvidence.push(id);
				continue;
			}
			if (evidenceTaskIds.has(id)) {
				continue;
			}
			missingEvidence.push(id);
		}

		if (missingEvidence.length === 0) {
			return {
				name: 'Evidence',
				status: '✅',
				detail: `All ${completedTaskIds.length} completed tasks have evidence`,
			};
		} else {
			return {
				name: 'Evidence',
				status: '❌',
				detail: `${missingEvidence.length} completed task(s) missing evidence: ${missingEvidence.join(', ')}`,
			};
		}
	}

	return {
		name: 'Evidence',
		status: '✅',
		detail: 'No completed tasks yet',
	};
}

/**
 * Check 1: Swarm Identity Match - verifies plan.swarm matches active environment
 */
async function checkSwarmIdentity(plan: Plan | null): Promise<HealthCheck> {
	const activeSwarmId = process.env.OPENCODE_SWARM_ID;

	// If plan exists but environment variable is not set
	if (plan && !activeSwarmId) {
		return {
			name: 'Swarm Identity',
			status: '❌',
			detail: 'Plan exists but OPENCODE_SWARM_ID not set in environment',
		};
	}

	// Only return "No conflict detected" when BOTH !plan AND !activeSwarmId
	if (!plan && !activeSwarmId) {
		return {
			name: 'Swarm Identity',
			status: '✅',
			detail: 'No conflict detected',
		};
	}

	// Handle case where no plan but env var is set
	if (!plan) {
		return {
			name: 'Swarm Identity',
			status: '✅',
			detail: `No plan, but OPENCODE_SWARM_ID is '${activeSwarmId}'`,
		};
	}

	if (plan && plan.swarm !== activeSwarmId) {
		return {
			name: 'Swarm Identity',
			status: '❌',
			detail: `Swarm identity mismatch: plan says '${plan.swarm}', active is '${activeSwarmId}'`,
		};
	}

	return {
		name: 'Swarm Identity',
		status: '✅',
		detail: `Swarm identity consistent: '${plan!.swarm}'`,
	};
}

/**
 * Check 2: Phase Boundary Correctness - verifies tasks are in correct phases
 */
async function checkPhaseBoundaries(plan: Plan | null): Promise<HealthCheck> {
	if (!plan) {
		return {
			name: 'Phase Boundaries',
			status: '✅',
			detail: 'No plan to validate',
		};
	}

	const mismatches: string[] = [];
	for (const phase of plan.phases) {
		for (const task of phase.tasks) {
			const taskPhaseNum = parseInt(task.id.split('.')[0], 10);
			if (Number.isNaN(taskPhaseNum)) {
				mismatches.push(`Task ${task.id} has invalid phase number`);
			} else if (taskPhaseNum !== phase.id) {
				mismatches.push(`Task ${task.id} found under Phase ${phase.id}`);
			}
		}
	}

	if (mismatches.length === 0) {
		return {
			name: 'Phase Boundaries',
			status: '✅',
			detail: 'All tasks correctly aligned to phases',
		};
	}

	return {
		name: 'Phase Boundaries',
		status: '❌',
		detail: mismatches.join('; '),
	};
}

/**
 * Check 3: Orphaned Evidence Tasks - finds evidence entries not in plan
 */
async function checkOrphanedEvidence(
	directory: string,
	plan: Plan | null,
): Promise<HealthCheck> {
	if (!plan) {
		return {
			name: 'Orphaned Evidence',
			status: '✅',
			detail: 'No plan to cross-reference',
		};
	}

	const planTaskIds = new Set<string>();
	for (const phase of plan.phases) {
		for (const task of phase.tasks) {
			planTaskIds.add(task.id);
		}
	}

	try {
		const evidenceTaskIds = await listEvidenceTaskIds(directory);
		const orphaned = evidenceTaskIds.filter(
			(id) => !planTaskIds.has(id) && !/^retro-/.test(id),
		);

		if (orphaned.length === 0) {
			return {
				name: 'Orphaned Evidence',
				status: '✅',
				detail: 'All evidence entries reference valid plan tasks',
			};
		}

		return {
			name: 'Orphaned Evidence',
			status: '❌',
			detail: `Evidence for [${orphaned.join(', ')}] not in plan`,
		};
	} catch {
		return {
			name: 'Orphaned Evidence',
			status: '❌',
			detail: 'Could not read evidence directory',
		};
	}
}

/**
 * Check 4: Plan Sync - verifies plan.json and plan.md task counts match
 */
async function checkPlanSync(
	directory: string,
	plan: Plan | null,
): Promise<HealthCheck> {
	if (!plan) {
		return {
			name: 'Plan Sync',
			status: '✅',
			detail: 'No plan.json present',
		};
	}

	try {
		let jsonTaskCount = 0;
		for (const phase of plan.phases) {
			jsonTaskCount += phase.tasks.length;
		}

		const planMdContent = await readSwarmFileAsync(directory, 'plan.md');
		if (!planMdContent) {
			return {
				name: 'Plan Sync',
				status: '✅',
				detail: 'plan.md not present',
			};
		}

		const mdTaskCount = (planMdContent.match(/^- \[[ xX~]/gm) || []).length;

		if (jsonTaskCount === mdTaskCount) {
			return {
				name: 'Plan Sync',
				status: '✅',
				detail: `plan.json and plan.md both have ${jsonTaskCount} tasks`,
			};
		}

		return {
			name: 'Plan Sync',
			status: '❌',
			detail: `plan.json: ${jsonTaskCount} tasks, plan.md: ${mdTaskCount} — run /swarm sync-plan`,
		};
	} catch {
		return {
			name: 'Plan Sync',
			status: '❌',
			detail: 'Could not compare plan files',
		};
	}
}

/**
 * Check 5: Config Backup Accumulation - checks for excessive backup files
 */
async function checkConfigBackups(directory: string): Promise<HealthCheck> {
	try {
		const files = readdirSync(directory);
		const backupCount = files.filter((f) =>
			/\.opencode-swarm\.yaml\.bak/.test(f),
		).length;

		if (backupCount <= 5) {
			return {
				name: 'Config Backups',
				status: '✅',
				detail: `${backupCount} backup file(s) — within acceptable range`,
			};
		}

		if (backupCount <= 19) {
			return {
				name: 'Config Backups',
				status: '❌',
				detail: `${backupCount} backup config files found — consider cleanup`,
			};
		}

		return {
			name: 'Config Backups',
			status: '❌',
			detail: `${backupCount} backup config files found — cleanup required`,
		};
	} catch {
		return {
			name: 'Config Backups',
			status: '✅',
			detail: 'Could not check backup files',
		};
	}
}

/**
 * Check 6: Git Repository - verifies git version control is present
 */
async function checkGitRepository(directory: string): Promise<HealthCheck> {
	try {
		if (!existsSync(directory) || !statSync(directory).isDirectory()) {
			return {
				name: 'Git Repository',
				status: '❌',
				detail: 'Invalid directory — cannot check git status',
			};
		}
		const gitExecutable = await resolveGitExecutableAsync();
		child_process.execFileSync(gitExecutable, ['rev-parse', '--git-dir'], {
			cwd: directory,
			stdio: 'pipe',
		});
		return {
			name: 'Git Repository',
			status: '✅',
			detail: 'Git repository detected',
		};
	} catch {
		return {
			name: 'Git Repository',
			status: '❌',
			detail: 'Not a git repository — version control recommended',
		};
	}
}

/**
 * Check 7: Spec Staleness - verifies spec.md title matches plan.title
 */
async function checkSpecStaleness(
	directory: string,
	plan: Plan | null,
): Promise<HealthCheck> {
	const specContent = readEffectiveSpecSync(directory)?.content ?? null;

	if (!specContent) {
		return {
			name: 'Spec Staleness',
			status: '✅',
			detail: 'No effective spec present',
		};
	}

	if (!plan) {
		return {
			name: 'Spec Staleness',
			status: '✅',
			detail: 'No plan to compare spec against',
		};
	}

	const titleMatch = specContent.match(/^#\s+(.+)$/m);
	if (!titleMatch) {
		return {
			name: 'Spec Staleness',
			status: '✅',
			detail: 'Spec title not detectable',
		};
	}

	const specTitle = titleMatch[1]!.trim();
	const planTitle = plan.title.trim();

	if (specTitle.toLowerCase() === planTitle.toLowerCase()) {
		return {
			name: 'Spec Staleness',
			status: '✅',
			detail: 'Spec and plan titles are aligned',
		};
	}

	return {
		name: 'Spec Staleness',
		status: '❌',
		detail: `Spec/plan title mismatch: spec says '${specTitle}', plan says '${planTitle}'`,
	};
}

/**
 * Check A: Config Parseability - verifies project config is valid JSON
 */
async function checkConfigParseability(
	directory: string,
): Promise<HealthCheck> {
	const configPath = path.join(directory, '.opencode/opencode-swarm.json');

	if (!existsSync(configPath)) {
		return {
			name: 'Config Parseability',
			status: '✅',
			detail: 'No project config file present (using defaults)',
		};
	}

	try {
		const content = readFileSync(configPath, 'utf-8');
		JSON.parse(content);
		return {
			name: 'Config Parseability',
			status: '✅',
			detail: 'Project config is valid JSON',
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return {
			name: 'Config Parseability',
			status: '❌',
			detail: `Project config at .opencode/opencode-swarm.json is not valid JSON: ${message}`,
		};
	}
}

/**
 * Resolve the grammar WASM directory from an arbitrary module directory.
 * Exported for unit testing — callers should not pass import.meta.url directly.
 *
 * Rules:
 *   - Dev source  (ends with /src/services): go up one level → src/lang/grammars
 *   - CLI bundle  (ends with /cli):           go up one level → dist/lang/grammars
 *   - Main bundle (everything else):          stay put        → dist/lang/grammars
 */
export function resolveGrammarDir(thisDir: string): string {
	const normalized = thisDir.replace(/\\/g, '/');
	const isSource = normalized.endsWith('/src/services');
	const isCliBundle = normalized.endsWith('/cli');
	return isSource || isCliBundle
		? path.join(thisDir, '..', 'lang', 'grammars')
		: path.join(thisDir, 'lang', 'grammars');
}

/**
 * Check B: Grammar WASM Files - verifies tree-sitter grammar files exist
 */
async function checkGrammarWasmFiles(): Promise<HealthCheck> {
	const grammarFiles = [
		'tree-sitter-javascript.wasm',
		'tree-sitter-typescript.wasm',
		'tree-sitter-tsx.wasm',
		'tree-sitter-python.wasm',
		'tree-sitter-go.wasm',
		'tree-sitter-rust.wasm',
		'tree-sitter-cpp.wasm',
		'tree-sitter-c-sharp.wasm',
		'tree-sitter-css.wasm',
		'tree-sitter-bash.wasm',
		'tree-sitter-ruby.wasm',
		'tree-sitter-php.wasm',
		'tree-sitter-java.wasm',
		'tree-sitter-kotlin.wasm',
		'tree-sitter-swift.wasm',
		'tree-sitter-dart.wasm',
		'tree-sitter-powershell.wasm',
		'tree-sitter-ini.wasm',
		'tree-sitter-regex.wasm',
	];

	// Determine dev vs production path using import.meta.url (cross-platform)
	const thisDir = path.dirname(fileURLToPath(import.meta.url));
	const grammarDir = resolveGrammarDir(thisDir);

	const missing: string[] = [];

	// Check core tree-sitter runtime WASM (must match web-tree-sitter JS runtime)
	if (!existsSync(path.join(grammarDir, 'tree-sitter.wasm'))) {
		missing.push('tree-sitter.wasm (core runtime)');
	}

	for (const file of grammarFiles) {
		if (!existsSync(path.join(grammarDir, file))) {
			missing.push(file);
		}
	}

	if (missing.length === 0) {
		return {
			name: 'Grammar WASM Files',
			status: '✅',
			detail: `Core runtime + all ${grammarFiles.length} grammar WASM files present`,
		};
	}

	return {
		name: 'Grammar WASM Files',
		status: '❌',
		detail: `${missing.length} WASM file(s) missing: ${missing.join(', ')}`,
	};
}

/**
 * Check C: Checkpoint Manifest Validity - validates .swarm/checkpoints.json
 */
async function checkCheckpointManifest(
	directory: string,
): Promise<HealthCheck> {
	const manifestPath = path.join(directory, '.swarm/checkpoints.json');

	if (!existsSync(manifestPath)) {
		return {
			name: 'Checkpoint Manifest',
			status: '✅',
			detail: 'No checkpoint manifest (no checkpoints saved)',
		};
	}

	try {
		const content = readFileSync(manifestPath, 'utf-8');
		const parsed = JSON.parse(content);

		if (!parsed.checkpoints || !Array.isArray(parsed.checkpoints)) {
			return {
				name: 'Checkpoint Manifest',
				status: '❌',
				detail: "checkpoints.json missing 'checkpoints' array",
			};
		}

		let invalidCount = 0;
		for (const cp of parsed.checkpoints) {
			if (
				typeof cp.label !== 'string' ||
				typeof cp.sha !== 'string' ||
				typeof cp.timestamp !== 'string'
			) {
				invalidCount++;
			}
		}

		if (invalidCount > 0) {
			return {
				name: 'Checkpoint Manifest',
				status: '❌',
				detail: `${invalidCount} checkpoint(s) have invalid structure (missing label/sha/timestamp)`,
			};
		}

		return {
			name: 'Checkpoint Manifest',
			status: '✅',
			detail: `Checkpoint manifest valid — ${parsed.checkpoints.length} checkpoint(s)`,
		};
	} catch (err) {
		if (err instanceof SyntaxError) {
			return {
				name: 'Checkpoint Manifest',
				status: '❌',
				detail: 'checkpoints.json is not valid JSON',
			};
		}
		return {
			name: 'Checkpoint Manifest',
			status: '❌',
			detail: 'Could not read checkpoint manifest',
		};
	}
}

/**
 * Check D: Event Stream Integrity - validates the retained window of the
 * bounded core event store (issue #2039). The read is hard-bounded and
 * manifest-stripped; corrupt retained tails are still found. Compacted
 * history is disclosed via coverage rather than re-read.
 */
async function checkEventStreamIntegrity(
	directory: string,
): Promise<HealthCheck> {
	if (getCoreEventCoverage(directory) === 'empty') {
		return {
			name: 'Event Stream',
			status: '✅',
			detail: 'No events.jsonl present',
		};
	}

	try {
		const window = readCoreEvents(directory);
		const lines = window.text.split('\n').filter((line) => line.trim() !== '');

		let malformedCount = 0;
		for (const line of lines) {
			try {
				JSON.parse(line);
			} catch {
				malformedCount++;
			}
		}

		const coverageNote =
			window.coverage === 'truncated'
				? ' (retained window — compacted history excluded)'
				: '';

		if (malformedCount === 0) {
			return {
				name: 'Event Stream',
				status: '✅',
				detail: `events.jsonl is valid — ${lines.length} event(s)${coverageNote}`,
			};
		}

		return {
			name: 'Event Stream',
			status: '❌',
			detail: `events.jsonl has ${malformedCount} malformed line(s) — possible data corruption`,
		};
	} catch {
		return {
			name: 'Event Stream',
			status: '❌',
			detail: 'Could not read events.jsonl',
		};
	}
}

/**
 * Check E: Steering Directive Staleness - checks for unconsumed steering
 * directives within the bounded retained window (issue #2039).
 */
async function checkSteeringDirectives(
	directory: string,
): Promise<HealthCheck> {
	if (getCoreEventCoverage(directory) === 'empty') {
		return {
			name: 'Steering Directives',
			status: '✅',
			detail: 'No events.jsonl — no steering directives to check',
		};
	}

	try {
		const window = readCoreEvents(directory);
		const lines = window.text.split('\n').filter((line) => line.trim() !== '');

		const directivesIssued: string[] = [];
		const consumedIds = new Set<string>();

		for (const line of lines) {
			try {
				const parsed = JSON.parse(line);
				if (parsed.type === 'steering-directive' && parsed.directiveId) {
					directivesIssued.push(parsed.directiveId);
				}
				if (parsed.type === 'steering-consumed' && parsed.directiveId) {
					consumedIds.add(parsed.directiveId);
				}
			} catch {
				// Skip malformed lines
			}
		}

		const unconsumed = directivesIssued.filter((id) => !consumedIds.has(id));

		if (unconsumed.length === 0) {
			const coverageNote =
				window.coverage === 'truncated'
					? ' (within the retained event window)'
					: '';
			return {
				name: 'Steering Directives',
				status: '✅',
				detail: `All steering directives acknowledged (or none issued)${coverageNote}`,
			};
		}

		return {
			name: 'Steering Directives',
			status: '❌',
			detail: `${unconsumed.length} steering directive(s) not yet acknowledged`,
		};
	} catch {
		return {
			name: 'Steering Directives',
			status: '❌',
			detail: 'Could not read events.jsonl',
		};
	}
}

/**
 * Check (#2044): Learning/operations health — bounded-window alarm families
 * from the learning-health registry. Warns when any alarm is active; the
 * detail lines carry the same redacted form as the telemetry payload (16-hex
 * refs, counts, enums — never raw session ids, paths, or content).
 */
export async function checkLearningHealth(
	directory: string,
): Promise<HealthCheck> {
	try {
		const snapshot = await readLearningHealth(directory);
		if (snapshot.activeAlarms.length === 0) {
			return {
				name: 'Learning health',
				status: '✅',
				detail: `No active alarms (${snapshot.totalTransitions} transitions recorded)`,
			};
		}
		const detail = snapshot.activeAlarms
			.map((alarm) => {
				const ageMinutes = Math.floor(alarm.ageMs / 60_000);
				return `${alarm.severity} ${alarm.alarm} [${alarm.scopeClass} ${alarm.scopeRef}] age ${ageMinutes}m coverage ${alarm.coverageFacts}`;
			})
			.join('; ');
		return {
			name: 'Learning health',
			status: '⚠️',
			detail: `${snapshot.activeAlarms.length} active alarm(s): ${detail}`,
		};
	} catch {
		return {
			name: 'Learning health',
			status: '⬜',
			detail: 'Learning-health artifact unreadable (fail-open)',
		};
	}
}

/**
 * Check F: Curator Health - verifies curator.enabled and curator-summary.json state
 */
async function checkCurator(directory: string): Promise<HealthCheck> {
	try {
		const config = loadPluginConfig(directory);

		if (!config.curator?.enabled) {
			return {
				name: 'Curator',
				status: '✅',
				detail: 'Disabled (enable via curator.enabled)',
			};
		}

		const summaryPath = path.join(directory, '.swarm/curator-summary.json');

		if (!existsSync(summaryPath)) {
			return {
				name: 'Curator',
				status: '✅',
				detail: 'Enabled, no summary yet (waiting for first phase)',
			};
		}

		try {
			const content = readFileSync(summaryPath, 'utf-8');
			const parsed = JSON.parse(content);

			if (
				typeof parsed.schema_version !== 'number' ||
				parsed.schema_version !== 1
			) {
				return {
					name: 'Curator',
					status: '❌',
					detail: `curator-summary.json has invalid schema_version (expected 1, got ${JSON.stringify(parsed.schema_version)})`,
				};
			}

			const phaseInfo =
				parsed.last_phase_covered !== undefined
					? `phase ${parsed.last_phase_covered}`
					: 'unknown phase';
			const timeInfo = parsed.last_updated
				? `, updated ${parsed.last_updated}`
				: '';

			return {
				name: 'Curator',
				status: '✅',
				detail: `Summary present — covering ${phaseInfo}${timeInfo}`,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Unknown error';
			return {
				name: 'Curator',
				status: '❌',
				detail: `curator-summary.json is corrupt or invalid: ${message}`,
			};
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return {
			name: 'Curator',
			status: '❌',
			detail: `Could not check curator state: ${message}`,
		};
	}
}

/**
 * Get sandbox health-check entry.
 *
 * Consumes the cached sandbox capability probe and, if available,
 * the cached sandbox executor. Never re-probes and never crashes
 * diagnose on sandbox errors.
 */
async function getSandboxStatus(sessionID?: string): Promise<HealthCheck> {
	try {
		const capability = await _internals.detectSandboxCapability();
		const mechanism = capability.mechanism ?? 'none';
		// A legacy aggregate strength is availability evidence, not behavioral
		// evidence for any individual containment dimension. Never expand the
		// old `strong` label into four independent `real` claims.
		const legacyDimension = capability.status === 'enabled' ? 'weak' : 'none';
		const filesystem = capability.filesystem ?? legacyDimension;
		const network = capability.network ?? legacyDimension;
		const processBoundary = capability.process ?? legacyDimension;
		const effective = capability.effective ?? legacyDimension;
		const dimensions = `fs=${filesystem} network=${network} process=${processBoundary} effective=${effective}`;
		const reasons = (capability.reasons ?? []).join('; ');
		const skipSummary = getSandboxSkipSummary(sessionID);
		const skipDetail =
			skipSummary.count > 0
				? ` | observed skips=${skipSummary.count}: ${skipSummary.reasons.join('; ')}`
				: '';

		const executor = await _internals.getSandboxExecutor();
		const hasExecutor = executor !== null;
		// Issue #2475: surface WHY the native runner is not in effect (probe
		// error, e.g. binary missing/wrong-arch/protocol mismatch, or an
		// explicit disable) so the diagnose line explains downgrades.
		const executorExtras = executor as {
			probeResult?: { error?: string } | null;
			disabledReason?: string | null;
		} | null;
		const downgradeReason =
			executorExtras?.probeResult?.error ??
			executorExtras?.disabledReason ??
			null;
		const downgradeDetail =
			downgradeReason !== null && downgradeReason !== undefined
				? ` | downgrade reason: ${downgradeReason}`
				: '';

		if (hasExecutor) {
			// An available executor is NOT automatically strong. The Windows
			// PowerShell fallback (and any future advisory mechanism) only scrubs
			// the environment — it is not kernel-enforced. Never report advisory
			// containment as green (issue #1778 H2). Prefer the executor's own
			// strength when it exposes one, else the probe's.
			const executorStrength = (
				executor as { strength?: 'strong' | 'weak' | 'advisory' } | null
			)?.strength;
			const strength =
				executorStrength === 'weak' || executorStrength === 'advisory'
					? 'advisory'
					: (capability.strength ?? executorStrength ?? 'strong');

			if (effective !== 'real' || strength === 'advisory') {
				return {
					name: 'Sandbox',
					status: '⚠️',
					detail: `Mechanism: ${mechanism.toLowerCase()} | ${dimensions} | Partial boundary: ${reasons}${downgradeDetail}${skipDetail}`,
				};
			}

			return {
				name: 'Sandbox',
				status: '✅',
				detail: `Mechanism: ${mechanism.toLowerCase()} | ${dimensions} | Sandboxing requested dimensions: yes${skipDetail}`,
			};
		}

		if (mechanism !== 'none') {
			return {
				name: 'Sandbox',
				status: '⚠️',
				detail: `Mechanism: ${mechanism.toLowerCase()} | ${dimensions} | Available: no | ${reasons}${skipDetail}`,
			};
		}

		return {
			name: 'Sandbox',
			status: '⬜',
			detail: `Mechanism: ${mechanism.toLowerCase()} | Commands not sandboxed`,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		return {
			name: 'Sandbox',
			status: '⬜',
			detail: `Sandbox status unknown (${message})`,
		};
	}
}

/**
 * Bounded atomic-write residue summary (issue #2035). Rendered from the same
 * shared inventory as the close clean stage and `/swarm config doctor`, so
 * all three surfaces cannot disagree. Paths never enter the detail line —
 * counts and ages only.
 */
async function checkResidueInventory(directory: string): Promise<HealthCheck> {
	try {
		const inventory = await inventorySwarmResidue(directory);
		const s = inventory.summary;
		if (s.matched === 0) {
			return {
				name: 'Atomic-write residue',
				status: '✅',
				detail: 'No registered temp-grammar residue under .swarm/',
			};
		}
		const oldestMin = Math.round(s.oldestAgeMs / 60_000);
		return {
			name: 'Atomic-write residue',
			status: '⚠️',
			detail:
				`${s.matched} stale temp file(s) (${s.totalBytes} bytes, oldest ${oldestMin}m old): ` +
				`${s.eligible} quarantine-eligible, ${s.ambiguous} preserved as recent/active/tracked/ambiguous` +
				(inventory.gitState === 'unknown'
					? ' (git tracked-state unknown — nothing auto-quarantined)'
					: '') +
				'. Run /swarm config doctor for the full inventory, /swarm config doctor --quarantine-residue to act.',
		};
	} catch (err) {
		return {
			name: 'Atomic-write residue',
			status: '⬜',
			detail: `Inventory unavailable: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/**
 * Get diagnose data from the swarm directory.
 * Returns structured health checks for GUI, background flows, or commands.
 */
export async function getDiagnoseData(
	directory: string,
	sessionID?: string,
): Promise<DiagnoseData> {
	const checks: HealthCheck[] = [];

	// Check: Version (running) — surface npm staleness so users notice when
	// opencode is loading a stale cached copy from ~/.cache/opencode/packages
	// (issue #675). Pulls last-checked value from version-check cache file.
	const versionCache = readVersionCache();
	let versionDetail = version;
	let versionStatus: HealthCheck['status'] = '✅';
	if (versionCache?.npmLatest) {
		const ageMs = Date.now() - versionCache.checkedAt;
		const ageMin = Math.max(0, Math.round(ageMs / 60_000));
		if (compareVersions(versionCache.npmLatest, version) > 0) {
			versionStatus = '⚠️';
			versionDetail =
				`${version} (npm latest: ${versionCache.npmLatest}, checked ${ageMin}m ago) ` +
				'— run `bunx opencode-swarm update` to refresh';
		} else {
			versionDetail = `${version} (npm latest: ${versionCache.npmLatest}, checked ${ageMin}m ago)`;
		}
	}
	checks.push({
		name: 'Version',
		status: versionStatus,
		detail: versionDetail,
	});

	// Check 0 (#2480): swarm.db integrity + support floors. quick_check is
	// size-capped so an oversized DB reports a warning instead of hanging the
	// diagnose command; every failure degrades to a status line — diagnose
	// must never throw. Never opens-for-create: absent DB is healthy.
	checks.push(checkSwarmDb(directory));

	// Check 1: Try structured plan (only if plan.json exists, no auto-migration)
	const plan = await loadPlanJsonOnly(directory);

	if (plan) {
		// plan.json loaded and validated
		checks.push({
			name: 'plan.json',
			status: '✅',
			detail: 'Valid schema (v1.0.0)',
		});

		// Report migration status if present
		if (plan.migration_status === 'migrated') {
			checks.push({
				name: 'Migration',
				status: '✅',
				detail: 'Plan was migrated from legacy plan.md',
			});
		} else if (plan.migration_status === 'migration_failed') {
			checks.push({
				name: 'Migration',
				status: '❌',
				detail: 'Migration from plan.md failed — review manually',
			});
		}

		// Validate task DAG (check for missing dependencies)
		const dagResult = validateTaskDag(plan);
		if (dagResult.valid) {
			checks.push({
				name: 'Task DAG',
				status: '✅',
				detail: 'All dependencies resolved',
			});
		} else {
			checks.push({
				name: 'Task DAG',
				status: '❌',
				detail: `Missing dependencies: ${dagResult.missingDeps.join(', ')}`,
			});
		}

		// Check evidence completeness
		const evidenceCheck = await checkEvidenceCompleteness(directory, plan);
		checks.push(evidenceCheck);
	} else {
		// Fall back to checking plan.md (legacy behavior)
		const planContent = await readSwarmFileAsync(directory, 'plan.md');
		if (planContent) {
			const hasPhases = /^## Phase \d+/m.test(planContent);
			const hasTasks = /^- \[[ x]\]/m.test(planContent);
			if (hasPhases && hasTasks) {
				checks.push({
					name: 'plan.md',
					status: '✅',
					detail: 'Found with valid phase structure',
				});
			} else {
				checks.push({
					name: 'plan.md',
					status: '❌',
					detail: 'Found but missing phase/task structure',
				});
			}
		} else {
			checks.push({
				name: 'plan.md',
				status: '❌',
				detail: 'Not found',
			});
		}
	}

	// Check: Coder settlements (issue #2268) — surface the
	// CODER_DISPATCH_IN_PROGRESS wedge class that used to be invisible to
	// diagnose: a non-terminal settlement WAL whose dispatch completion never
	// arrived. Warn-level by design: a genuinely in-flight dispatch also shows
	// up as non-terminal here and must not fail the health check. Fail-open:
	// an inspection failure downgrades to a warning, never breaks diagnose.
	try {
		const { states: settlementStates, truncated } =
			await listCoderSettlementWalStates(directory);
		const truncationNote = truncated
			? ' MORE settlement WALs exist than the scan cap (200) — older ones are not shown.'
			: '';
		if (settlementStates.length === 0) {
			checks.push({
				name: 'Coder Settlements',
				status: truncated ? '⚠️' : '✅',
				detail: truncated
					? `Settlement WAL scan truncated at 200 — additional settlements exist but are not shown.${truncationNote}`
					: 'No coder settlement WALs',
			});
		} else {
			const nonTerminal = settlementStates.filter(
				(entry) =>
					entry.state === 'DISPATCHED' ||
					entry.state === 'PREPARED' ||
					entry.state === 'unreadable',
			);
			if (nonTerminal.length === 0 && !truncated) {
				checks.push({
					name: 'Coder Settlements',
					status: '✅',
					detail: `${settlementStates.length} settlement(s) all in terminal state`,
				});
			} else {
				const details = nonTerminal.map((entry) => {
					if (entry.state === 'unreadable') {
						return `task ${entry.taskId}: WAL unreadable`;
					}
					const owner =
						entry.ownedInProcess || entry.ownedByLiveForeignPid
							? `owner pid ${entry.processId ?? '?'} still alive — in flight or wedged`
							: 'owner process is gone — stale';
					return `task ${entry.taskId} (${entry.state}, ${owner})`;
				});
				checks.push({
					name: 'Coder Settlements',
					status: '⚠️',
					detail: `${
						nonTerminal.length > 0
							? `${nonTerminal.length} non-terminal settlement(s): ${details.join(
									'; ',
								)}.`
							: 'All shown settlements are terminal, but the scan was truncated.'
					} Stale settlements block dispatches with CODER_DISPATCH_IN_PROGRESS — run /swarm recover [task_id] (--force if no dispatch is genuinely running) or /swarm reset-session.${truncationNote}`,
				});
			}
		}
	} catch (error) {
		checks.push({
			name: 'Coder Settlements',
			status: '⚠️',
			detail: `could not inspect coder settlements: ${
				error instanceof Error ? error.message : String(error)
			}`,
		});
	}

	// Check: context.md exists
	const contextContent = await readSwarmFileAsync(directory, 'context.md');
	if (contextContent) {
		checks.push({ name: 'context.md', status: '✅', detail: 'Found' });
	} else {
		checks.push({ name: 'context.md', status: '❌', detail: 'Not found' });
	}

	// Check: Plugin config
	try {
		const config = loadPluginConfig(directory);
		if (config) {
			checks.push({
				name: 'Plugin config',
				status: '✅',
				detail: 'Valid configuration loaded',
			});
		} else {
			checks.push({
				name: 'Plugin config',
				status: '✅',
				detail: 'Using defaults (no custom config)',
			});
		}
	} catch {
		checks.push({
			name: 'Plugin config',
			status: '❌',
			detail: 'Invalid configuration',
		});
	}

	// Check: Swarm Identity
	checks.push(await checkSwarmIdentity(plan));

	// Check: Phase Boundaries
	checks.push(await checkPhaseBoundaries(plan));

	// Check: Orphaned Evidence
	checks.push(await checkOrphanedEvidence(directory, plan));

	// Check: Plan Sync
	checks.push(await checkPlanSync(directory, plan));

	// Check: Config Backups
	checks.push(await checkConfigBackups(directory));

	// Check: Git Repository
	checks.push(await checkGitRepository(directory));

	// Check: Sandbox
	checks.push(await getSandboxStatus(sessionID));

	// Check: Spec Staleness
	checks.push(await checkSpecStaleness(directory, plan));

	// Check: Config Parseability
	checks.push(await checkConfigParseability(directory));

	// Check: Grammar WASM Files
	checks.push(await checkGrammarWasmFiles());

	// Check: Checkpoint Manifest
	checks.push(await checkCheckpointManifest(directory));

	// Check: Event Stream Integrity
	checks.push(await checkEventStreamIntegrity(directory));

	// Check: Steering Directives
	checks.push(await checkSteeringDirectives(directory));

	// Check: Curator
	checks.push(await checkCurator(directory));

	// Check: Knowledge health (entry status breakdown, event volume, schema
	// drift, stale-cache warning).
	checks.push(await checkKnowledgeHealth(directory));
	checks.push(await checkLearningHealth(directory));

	// Check: Atomic-write residue (issue #2035) — bounded summary derived from
	// the SAME shared inventory as the close clean stage and config doctor.
	checks.push(await checkResidueInventory(directory));

	// Check: Agent Tool Snapshots
	try {
		const evidenceDir = path.join(directory, '.swarm', 'evidence');
		const snapshotFiles = existsSync(evidenceDir)
			? readdirSync(evidenceDir).filter(
					(f) => f.startsWith('agent-tools-') && f.endsWith('.json'),
				)
			: [];
		if (snapshotFiles.length > 0) {
			const latest = snapshotFiles.sort().pop()!;
			checks.push({
				name: 'Agent Tool Snapshots',
				status: '✅',
				detail: `${snapshotFiles.length} snapshot(s) found — latest: ${latest}`,
			});
		} else {
			checks.push({
				name: 'Agent Tool Snapshots',
				status: '✅',
				detail: 'No snapshots yet (snapshots written on next session start)',
			});
		}
	} catch {
		checks.push({
			name: 'Agent Tool Snapshots',
			status: '✅',
			detail: 'No snapshots yet (snapshots written on next session start)',
		});
	}

	// Deferred Warnings check
	if (getDeferredWarnings().length > 0) {
		checks.push({
			name: 'Deferred Warnings',
			status: '⚠️',
			detail: `${getDeferredWarnings().length} warning(s) deferred from init — see the Deferred Warnings section below (or set OPENCODE_SWARM_DEBUG=1 for full detail)`,
		});
	}

	// Check: Plugin Caches — inventory of known OpenCode plugin cache locations.
	// Shows which caches are present, what version is installed there, and which
	// are absent. Helps users diagnose stale-cache issues (issue #675).
	// Issue #2236 RC3 item 1 / non-blocking 5: getPluginCachePaths() is a
	// fixed, pure list (opencode-swarm@latest / opencode-swarm literals only)
	// so it cannot see a version-pinned OpenCode host cache like
	// opencode-swarm@7.143.1. discoverVersionPinnedCachePaths() performs the
	// filesystem enumeration to find those and is called explicitly here —
	// getPluginCachePaths() intentionally stays pure so it can still be
	// called from module scope elsewhere (AGENTS.md invariant 1).
	const cachePaths = [
		...getPluginCachePaths(),
		...discoverVersionPinnedCachePaths(),
	];
	const cacheRows: string[] = [];
	for (const cachePath of cachePaths) {
		try {
			if (!existsSync(cachePath)) {
				cacheRows.push(`⬜ ${cachePath} — absent`);
				continue;
			}
			const packageRoot = resolveCachePackageRoot(cachePath);
			const cacheLabel =
				packageRoot === cachePath
					? cachePath
					: `${cachePath} -> ${packageRoot}`;
			const missingGrammarAssets = REQUIRED_CACHE_GRAMMAR_ASSETS.filter(
				(file) =>
					!existsSync(path.join(packageRoot, 'dist', 'lang', 'grammars', file)),
			);
			const pkgJsonPath = path.join(packageRoot, 'package.json');
			try {
				const raw = readFileSync(pkgJsonPath, 'utf-8');
				const parsed = JSON.parse(raw) as { version?: unknown };
				const installedVersion =
					typeof parsed.version === 'string' ? parsed.version : '?';
				if (missingGrammarAssets.length > 0) {
					cacheRows.push(
						`⚠️ ${cacheLabel} — v${installedVersion}, missing grammar assets: ${missingGrammarAssets.join(', ')}; run \`bunx opencode-swarm update\` and restart OpenCode`,
					);
					continue;
				}
				cacheRows.push(`✅ ${cacheLabel} — v${installedVersion}`);
			} catch {
				cacheRows.push(`⚠️ ${cacheLabel} — present (package.json unreadable)`);
			}
		} catch {
			cacheRows.push(`⚠️ ${cachePath} — status unknown (read error)`);
		}
	}
	const hasCacheEntry = cacheRows.some((r) => r.startsWith('✅'));
	const hasCacheWarning = cacheRows.some((r) => r.startsWith('⚠️'));
	const cacheStatus: HealthCheck['status'] = hasCacheWarning
		? '⚠️'
		: hasCacheEntry
			? '✅'
			: '⬜';
	checks.push({
		name: 'Plugin Caches',
		status: cacheStatus,
		detail: cacheRows.join(' | '),
	});

	// Issue #2103: bounded, privacy-safe invocation recovery state. Never render
	// failure display text, prompts, provider output, or action arguments here.
	if (!sessionID) {
		checks.push({
			name: 'Invocation recovery',
			status: '⬜',
			detail: 'Session unavailable; scoped circuit and model status omitted',
		});
	} else {
		const invocationID = getAgentSession(sessionID)?.activeInvocationId ?? 0;
		const circuits =
			invocationID > 0
				? listBlockingActionCircuitsForInvocation(sessionID, invocationID)
				: [];
		checks.push({
			name: 'Invocation circuits',
			status: circuits.length > 0 ? '⚠️' : '✅',
			detail:
				circuits.length > 0
					? `${circuits.length} exact-action circuit(s) open for invocation ${invocationID}: ${[...new Set(circuits.map((entry) => entry.circuitKind))].join(', ')}`
					: `No exact-action circuits open${invocationID > 0 ? ` for invocation ${invocationID}` : ''}`,
		});
		const routing = getTaskModelRoutingStateSnapshot();
		const selections = routing.scopedSelections.filter(
			(entry) => entry.key.sessionID === sessionID,
		);
		checks.push({
			name: 'Model fallback scope',
			status: selections.length > 0 ? '⚠️' : '✅',
			detail:
				selections.length > 0
					? `${selections.length} scoped selection(s) active; highest fallback index ${Math.max(...selections.map((entry) => entry.fallbackIndex))}`
					: 'No scoped model override is active',
		});
		const fullAuto = loadFullAutoRunState(directory, sessionID);
		checks.push({
			name: 'Full-Auto recovery',
			status: fullAuto?.status === 'paused' ? '⚠️' : '✅',
			detail: fullAuto
				? `status=${fullAuto.status}; recovery_probe=${fullAuto.lastRecoveryProbe?.outcome ?? 'none'}`
				: 'No durable Full-Auto run state for this session',
		});
	}

	const passCount = checks.filter(
		(c) => c.status === '✅' || c.status === '⬜',
	).length;
	const totalCount = checks.length;
	const allPassed = passCount === totalCount;

	return {
		checks,
		passCount,
		totalCount,
		allPassed,
		deferredWarnings: getDeferredWarnings(),
	};
}

/**
 * Format diagnose data as markdown for command output.
 */
export function formatDiagnoseMarkdown(diagnose: DiagnoseData): string {
	const lines = [
		'## Swarm Health Check',
		'',
		...diagnose.checks.map((c) => `- ${c.status} **${c.name}**: ${c.detail}`),
		'',
		`**Result**: ${diagnose.allPassed ? '✅ All checks passed' : `⚠️ ${diagnose.passCount}/${diagnose.totalCount} checks passed`}`,
	];

	// Add Deferred Warnings section if any
	if (diagnose.deferredWarnings.length > 0) {
		lines.push('');
		lines.push('## Deferred Warnings');
		lines.push('');
		for (const warning of diagnose.deferredWarnings) {
			lines.push(`- ${warning}`);
		}
	}

	return lines.join('\n');
}

/**
 * Handle diagnose command - delegates to service and formats output.
 * Kept for backward compatibility - thin adapter.
 */
export async function handleDiagnoseCommand(
	directory: string,
	_args: string[],
	sessionID?: string,
): Promise<string> {
	const diagnoseData = await getDiagnoseData(directory, sessionID);
	return formatDiagnoseMarkdown(diagnoseData);
}
