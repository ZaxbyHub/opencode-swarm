import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPluginConfig } from '../config/loader';
import type { Plan } from '../config/plan-schema';
import { listEvidenceTaskIds } from '../evidence/manager';
import { readSwarmFileAsync } from '../hooks/utils';
import { loadPlanJsonOnly } from '../plan/manager';

/**
 * A single health check result.
 */
export interface HealthCheck {
	name: string;
	status: '✅' | '❌';
	detail: string;
}

/**
 * Structured diagnose data returned by the diagnose service.
 */
export interface DiagnoseData {
	checks: HealthCheck[];
	passCount: number;
	totalCount: number;
	allPassed: boolean;
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
		const missingEvidence = completedTaskIds.filter(
			(id) => !evidenceTaskIds.has(id),
		);

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
		execSync('git rev-parse --git-dir', { cwd: directory, stdio: 'pipe' });
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
	const specContent = await readSwarmFileAsync(directory, 'spec.md');

	if (!specContent) {
		return {
			name: 'Spec Staleness',
			status: '✅',
			detail: 'No spec file present',
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
 * Check B: Grammar WASM Files - verifies tree-sitter grammar files exist
 */
async function checkGrammarWasmFiles(): Promise<HealthCheck> {
	const grammarFiles = [
		'tree-sitter-javascript.wasm',
		'tree-sitter-typescript.wasm',
		'tree-sitter-python.wasm',
		'tree-sitter-go.wasm',
		'tree-sitter-rust.wasm',
		'tree-sitter-cpp.wasm',
		'tree-sitter-c-sharp.wasm',
		'tree-sitter-css.wasm',
		'tree-sitter-html.wasm',
		'tree-sitter-json.wasm',
		'tree-sitter-bash.wasm',
		'tree-sitter-ruby.wasm',
		'tree-sitter-php.wasm',
		'tree-sitter-java.wasm',
		'tree-sitter-kotlin.wasm',
		'tree-sitter-swift.wasm',
		'tree-sitter-dart.wasm',
	];

	// Determine dev vs production path
	// Check for src/services in the path (more specific than just 'src')
	// Node-compatible module-dir derivation (issue #3151): import.meta.dir is a
	// Bun-only extension — fileURLToPath(new URL('.', import.meta.url)) yields
	// the same directory (with a trailing separator, immaterial to both the
	// includes checks and path.join) under Node and Bun alike.
	const moduleDir = fileURLToPath(new URL('.', import.meta.url));
	const isDev =
		moduleDir.includes('src/services') || moduleDir.includes('src\\services');
	const grammarDir = isDev
		? path.join(moduleDir, '../../dist/lang/grammars/')
		: path.join(moduleDir, '../lang/grammars/');

	const missing: string[] = [];
	for (const file of grammarFiles) {
		if (!existsSync(path.join(grammarDir, file))) {
			missing.push(file);
		}
	}

	if (missing.length === 0) {
		return {
			name: 'Grammar WASM Files',
			status: '✅',
			detail: 'All 17 grammar WASM files present',
		};
	}

	return {
		name: 'Grammar WASM Files',
		status: '❌',
		detail: `${missing.length} grammar WASM file(s) missing: ${missing.join(', ')}`,
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
 * Check D: Event Stream Integrity - validates .swarm/events.jsonl has no malformed JSON
 */
async function checkEventStreamIntegrity(
	directory: string,
): Promise<HealthCheck> {
	const eventsPath = path.join(directory, '.swarm/events.jsonl');

	if (!existsSync(eventsPath)) {
		return {
			name: 'Event Stream',
			status: '✅',
			detail: 'No events.jsonl present',
		};
	}

	try {
		const content = readFileSync(eventsPath, 'utf-8');
		const lines = content.split('\n').filter((line) => line.trim() !== '');

		let malformedCount = 0;
		for (const line of lines) {
			try {
				JSON.parse(line);
			} catch {
				malformedCount++;
			}
		}

		if (malformedCount === 0) {
			return {
				name: 'Event Stream',
				status: '✅',
				detail: `events.jsonl is valid — ${lines.length} event(s)`,
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
 * Check E: Steering Directive Staleness - checks for unconsumed steering directives
 */
async function checkSteeringDirectives(
	directory: string,
): Promise<HealthCheck> {
	const eventsPath = path.join(directory, '.swarm/events.jsonl');

	if (!existsSync(eventsPath)) {
		return {
			name: 'Steering Directives',
			status: '✅',
			detail: 'No events.jsonl — no steering directives to check',
		};
	}

	try {
		const content = readFileSync(eventsPath, 'utf-8');
		const lines = content.split('\n').filter((line) => line.trim() !== '');

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
			return {
				name: 'Steering Directives',
				status: '✅',
				detail: 'All steering directives acknowledged (or none issued)',
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
 * Get diagnose data from the swarm directory.
 * Returns structured health checks for GUI, background flows, or commands.
 */
export async function getDiagnoseData(
	directory: string,
): Promise<DiagnoseData> {
	const checks: HealthCheck[] = [];

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

	const passCount = checks.filter((c) => c.status === '✅').length;
	const totalCount = checks.length;
	const allPassed = passCount === totalCount;

	return {
		checks,
		passCount,
		totalCount,
		allPassed,
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

	return lines.join('\n');
}

/**
 * Handle diagnose command - delegates to service and formats output.
 * Kept for backward compatibility - thin adapter.
 */
export async function handleDiagnoseCommand(
	directory: string,
	_args: string[],
): Promise<string> {
	const diagnoseData = await getDiagnoseData(directory);
	return formatDiagnoseMarkdown(diagnoseData);
}
