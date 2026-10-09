import { renameSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import {
	type Phase,
	type Plan,
	PlanSchema,
	type Task,
	type TaskStatus,
} from '../config/plan-schema';
import { readSwarmFileAsync } from '../hooks/utils';
import { warn } from '../utils';
import { bunHash, bunWrite } from '../utils/bun-compat';

/**
 * Load plan.json ONLY without auto-migration from plan.md.
 * Returns null if plan.json doesn't exist or is invalid.
 * Use this when you want to check for structured plans without triggering migration.
 */
export async function loadPlanJsonOnly(
	directory: string,
): Promise<Plan | null> {
	const planJsonContent = await readSwarmFileAsync(directory, 'plan.json');
	if (planJsonContent !== null) {
		// SECURITY: Reject content with null bytes (injection) or invalid UTF-8 (corruption markers)
		if (planJsonContent.includes('\0') || planJsonContent.includes('\uFFFD')) {
			warn(
				'Plan rejected: .swarm/plan.json contains null bytes or invalid encoding',
			);
			return null;
		}
		try {
			const parsed = JSON.parse(planJsonContent);
			const validated = PlanSchema.parse(parsed);
			return validated;
		} catch (error) {
			warn(
				`Plan validation failed for .swarm/plan.json: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return null;
}

/**
 * Natural numeric comparison for task IDs (e.g., "1.2" < "1.10").
 * This ensures deterministic ordering: 1.1, 1.2, 1.10, 1.11, 2.1
 */
function compareTaskIds(a: string, b: string): number {
	const partsA = a.split('.').map((n) => parseInt(n, 10));
	const partsB = b.split('.').map((n) => parseInt(n, 10));
	const maxLen = Math.max(partsA.length, partsB.length);

	for (let i = 0; i < maxLen; i++) {
		const numA = partsA[i] ?? 0;
		const numB = partsB[i] ?? 0;
		if (numA !== numB) {
			return numA - numB;
		}
	}
	return 0;
}

/**
 * Compute deterministic content hash for plan (excludes timestamp/derived fields).
 * Used to detect drift between plan.json and plan.md.
 * Uses natural numeric sorting for task IDs (1.2 < 1.10).
 * Returns a short hash string for compact storage in plan.md.
 */
function computePlanContentHash(plan: Plan): string {
	// Create deterministic representation (no timestamps, sorted IDs)
	const content = {
		schema_version: plan.schema_version,
		title: plan.title,
		swarm: plan.swarm,
		current_phase: plan.current_phase,
		migration_status: plan.migration_status,
		phases: plan.phases
			.map((phase) => ({
				id: phase.id,
				name: phase.name,
				status: phase.status,
				tasks: phase.tasks
					.map((task) => ({
						id: task.id,
						phase: task.phase,
						status: task.status,
						size: task.size,
						description: task.description,
						depends: [...task.depends].sort(compareTaskIds),
						acceptance: task.acceptance,
						files_touched: [...task.files_touched].sort(),
						evidence_path: task.evidence_path,
						blocked_reason: task.blocked_reason,
					}))
					.sort((a, b) => compareTaskIds(a.id, b.id)),
			}))
			.sort((a, b) => a.id - b.id),
	};
	const jsonString = JSON.stringify(content);
	// Use Bun's hash for a compact hash string
	return bunHash(jsonString).toString(36);
}

/**
 * Extract content hash from plan.md header if present.
 * Format: <!-- PLAN_HASH: <hash> -->
 */
function extractPlanHashFromMarkdown(markdown: string): string | null {
	const match = markdown.match(/<!--\s*PLAN_HASH:\s*(\S+)\s*-->/);
	return match ? match[1] : null;
}

/**
 * Check if plan.md is derived from the given plan by comparing content hashes.
 * Returns true if plan.md exists and matches the plan's content hash.
 * This avoids timestamp comparison issues by using a deterministic hash.
 */
async function isPlanMdInSync(directory: string, plan: Plan): Promise<boolean> {
	const planMdContent = await readSwarmFileAsync(directory, 'plan.md');
	if (planMdContent === null) {
		return false;
	}

	// Compute deterministic hash from plan
	const expectedHash = computePlanContentHash(plan);

	// Try to extract hash from existing plan.md
	const existingHash = extractPlanHashFromMarkdown(planMdContent);

	// If both hashes match, plan.md is in sync
	if (existingHash === expectedHash) {
		return true;
	}

	// Fallback: If no hash in plan.md but content structure matches, still in sync
	// This provides backward compatibility with plan.md files generated before hashing
	const expectedMarkdown = derivePlanMarkdown(plan);
	const normalizedExpected = expectedMarkdown.trim();
	const normalizedActual = planMdContent.trim();

	// Check if actual matches expected (allowing for trailing whitespace differences)
	if (normalizedActual === normalizedExpected) {
		return true;
	}

	// Check if actual contains the derived content (handles added comments/metadata)
	return (
		normalizedActual.includes(normalizedExpected) ||
		normalizedExpected.includes(normalizedActual.replace(/^#.*$/gm, '').trim())
	);
}

/**
 * Regenerate plan.md from valid plan.json (auto-heal case 1).
 */
async function regeneratePlanMarkdown(
	directory: string,
	plan: Plan,
): Promise<void> {
	const swarmDir = path.resolve(directory, '.swarm');
	const contentHash = computePlanContentHash(plan);
	const markdown = derivePlanMarkdown(plan);
	// Prepend hash as comment for sync detection
	const markdownWithHash = `<!-- PLAN_HASH: ${contentHash} -->\n${markdown}`;
	const mdPath = path.join(swarmDir, 'plan.md');
	const mdTempPath = path.join(
		swarmDir,
		`plan.md.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`,
	);
	try {
		await bunWrite(mdTempPath, markdownWithHash);
		renameSync(mdTempPath, mdPath);
	} finally {
		try {
			unlinkSync(mdTempPath);
		} catch {
			/* already renamed or never created */
		}
	}
}

/**
 * Load and validate plan from .swarm/plan.json with auto-heal sync.
 *
 * 4-step precedence with auto-heal:
 * 1. .swarm/plan.json exists AND validates ->
 *    a) If plan.md missing or stale -> regenerate plan.md from plan.json
 *    b) Return parsed Plan
 * 2. .swarm/plan.json exists but FAILS validation ->
 *    a) If plan.md exists -> migrate from plan.md, save valid plan.json, then derive plan.md
 *    b) Return migrated Plan
 * 3. .swarm/plan.md exists only -> migrate from plan.md, save both files, return Plan
 * 4. Neither exists -> return null
 */
export async function loadPlan(directory: string): Promise<Plan | null> {
	// Step 1: Try to load and validate plan.json
	const planJsonContent = await readSwarmFileAsync(directory, 'plan.json');
	if (planJsonContent !== null) {
		// SECURITY: Reject content with null bytes or invalid UTF-8
		if (planJsonContent.includes('\0') || planJsonContent.includes('\uFFFD')) {
			warn(
				'Plan rejected: .swarm/plan.json contains null bytes or invalid encoding',
			);
			// Skip to plan.md migration path - don't parse tainted content
		} else {
			try {
				const parsed = JSON.parse(planJsonContent);
				const validated = PlanSchema.parse(parsed);

				// Auto-heal case 1: Valid plan.json exists, check if plan.md needs regeneration
				const inSync = await isPlanMdInSync(directory, validated);
				if (!inSync) {
					try {
						await regeneratePlanMarkdown(directory, validated);
					} catch (regenError) {
						// Log warning but don't fail - plan.json is valid
						warn(
							`Failed to regenerate plan.md: ${regenError instanceof Error ? regenError.message : String(regenError)}. Proceeding with plan.json only.`,
						);
					}
				}

				return validated;
			} catch (error) {
				// Step 2: Validation failed, log warning and fall through to legacy
				warn(
					`Plan validation failed for .swarm/plan.json: ${error instanceof Error ? error.message : String(error)}`,
				);
				// Auto-heal case 2: plan.json invalid but plan.md exists -> migrate from plan.md
				const planMdContent = await readSwarmFileAsync(directory, 'plan.md');
				if (planMdContent !== null) {
					const migrated = migrateLegacyPlan(planMdContent);
					// savePlan writes both plan.json and plan.md
					await savePlan(directory, migrated);
					return migrated;
				}
				// If plan.md doesn't exist either, fall through to step 3
			}
		}
	}

	// Step 3: Try to migrate from legacy plan.md (no plan.json exists)
	const planMdContent = await readSwarmFileAsync(directory, 'plan.md');
	if (planMdContent !== null) {
		const migrated = migrateLegacyPlan(planMdContent);
		// Save the migrated plan (writes both files)
		await savePlan(directory, migrated);
		return migrated;
	}

	// Step 4: Neither exists
	return null;
}

/**
 * Validate against PlanSchema (throw on invalid), write to .swarm/plan.json via atomic temp+rename pattern,
 * then derive and write .swarm/plan.md
 */
export async function savePlan(directory: string, plan: Plan): Promise<void> {
	// Fail-fast: reject blank or whitespace-only directory inputs before any I/O
	if (
		directory === null ||
		directory === undefined ||
		typeof directory !== 'string' ||
		directory.trim().length === 0
	) {
		throw new Error(`Invalid directory: directory must be a non-empty string`);
	}

	// Validate against schema
	const validated = PlanSchema.parse(plan);

	// Protect completed tasks from regression (root cause #4):
	// If any task was 'completed' in the current plan.json, preserve that status
	// even if the incoming plan has it as 'pending'/'in_progress'/'blocked'.
	try {
		const currentPlan = await loadPlanJsonOnly(directory);
		if (currentPlan) {
			const completedTaskIds = new Set<string>();
			for (const phase of currentPlan.phases) {
				for (const task of phase.tasks) {
					if (task.status === 'completed') completedTaskIds.add(task.id);
				}
			}
			if (completedTaskIds.size > 0) {
				for (const phase of validated.phases) {
					for (const task of phase.tasks) {
						if (completedTaskIds.has(task.id) && task.status !== 'completed') {
							task.status = 'completed';
						}
					}
				}
			}
		}
	} catch {
		/* first write or corrupted plan — proceed without regression protection */
	}

	// Derive phase status from task statuses on every save (fixes remaining Issue #145):
	// Ensures phase status is always consistent even when architect calls save_plan directly.
	for (const phase of validated.phases) {
		const tasks = phase.tasks;
		if (tasks.length > 0 && tasks.every((t) => t.status === 'completed')) {
			phase.status = 'complete';
		} else if (tasks.some((t) => t.status === 'in_progress')) {
			phase.status = 'in_progress';
		} else if (tasks.some((t) => t.status === 'blocked')) {
			phase.status = 'blocked';
		} else {
			phase.status = 'pending';
		}
	}

	const swarmDir = path.resolve(directory, '.swarm');
	const planPath = path.join(swarmDir, 'plan.json');
	const tempPath = path.join(
		swarmDir,
		`plan.json.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`,
	);

	// Write to temp and atomically rename
	try {
		await bunWrite(tempPath, JSON.stringify(validated, null, 2));
		renameSync(tempPath, planPath);
	} finally {
		try {
			unlinkSync(tempPath);
		} catch {
			/* already renamed or never created */
		}
	}

	// Derive and write markdown atomically (with content hash for sync detection)
	const contentHash = computePlanContentHash(validated);
	const markdown = derivePlanMarkdown(validated);
	const markdownWithHash = `<!-- PLAN_HASH: ${contentHash} -->\n${markdown}`;
	const mdPath = path.join(swarmDir, 'plan.md');
	const mdTempPath = path.join(
		swarmDir,
		`plan.md.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`,
	);
	try {
		await bunWrite(mdTempPath, markdownWithHash);
		renameSync(mdTempPath, mdPath);
	} finally {
		try {
			unlinkSync(mdTempPath);
		} catch {
			/* already renamed or never created */
		}
	}

	// Advisory: write marker file for plan-manager write detection
	try {
		const markerPath = path.join(swarmDir, '.plan-write-marker');
		const tasksCount = validated.phases.reduce(
			(sum, phase) => sum + phase.tasks.length,
			0,
		);
		const marker = JSON.stringify({
			source: 'plan_manager',
			timestamp: new Date().toISOString(),
			phases_count: validated.phases.length,
			tasks_count: tasksCount,
		});
		await bunWrite(markerPath, marker);
	} catch {
		/* Advisory only - marker write failure does not affect plan save */
	}
}

/**
 * Load plan → find task by ID → update status → save → return updated plan.
 * Throw if plan not found or task not found.
 */
export async function updateTaskStatus(
	directory: string,
	taskId: string,
	status: TaskStatus,
): Promise<Plan> {
	const plan = await loadPlan(directory);
	if (plan === null) {
		throw new Error(`Plan not found in directory: ${directory}`);
	}

	// Find task by ID
	let taskFound = false;

	const derivePhaseStatusFromTasks = (tasks: Task[]): Phase['status'] => {
		if (
			tasks.length > 0 &&
			tasks.every((task) => task.status === 'completed')
		) {
			return 'complete';
		}

		if (tasks.some((task) => task.status === 'in_progress')) {
			return 'in_progress';
		}

		if (tasks.some((task) => task.status === 'blocked')) {
			return 'blocked';
		}

		return 'pending';
	};

	const updatedPhases: Phase[] = plan.phases.map((phase) => {
		const updatedTasks: Task[] = phase.tasks.map((task) => {
			if (task.id === taskId) {
				taskFound = true;
				return { ...task, status };
			}
			return task;
		});
		return {
			...phase,
			status: derivePhaseStatusFromTasks(updatedTasks),
			tasks: updatedTasks,
		};
	});

	if (!taskFound) {
		throw new Error(`Task not found: ${taskId}`);
	}

	const updatedPlan: Plan = { ...plan, phases: updatedPhases };
	await savePlan(directory, updatedPlan);
	return updatedPlan;
}

/**
 * Generate deterministic markdown view from plan object.
 * Ensures stable ordering: phases by ID (ascending), tasks by ID (natural numeric).
 */
export function derivePlanMarkdown(plan: Plan): string {
	const statusMap: Record<string, string> = {
		pending: 'PENDING',
		in_progress: 'IN PROGRESS',
		complete: 'COMPLETE',
		blocked: 'BLOCKED',
	};

	const now = new Date().toISOString();
	const currentPhase = plan.current_phase ?? 1;
	const phaseStatus =
		statusMap[plan.phases[currentPhase - 1]?.status] || 'PENDING';

	let markdown = `# ${plan.title}\nSwarm: ${plan.swarm}\nPhase: ${currentPhase} [${phaseStatus}] | Updated: ${now}\n`;

	// Sort phases deterministically by ID (ascending)
	const sortedPhases = [...plan.phases].sort((a, b) => a.id - b.id);

	for (const phase of sortedPhases) {
		const phaseStatusText = statusMap[phase.status] || 'PENDING';
		markdown += `\n## Phase ${phase.id}: ${phase.name} [${phaseStatusText}]\n`;

		// Sort tasks deterministically by ID (natural numeric, e.g., "1.1", "1.2", "1.10")
		const sortedTasks = [...phase.tasks].sort((a, b) =>
			compareTaskIds(a.id, b.id),
		);

		// Find the first in_progress task in the current phase to mark as CURRENT
		let currentTaskMarked = false;

		for (const task of sortedTasks) {
			let taskLine = '';
			let suffix = '';

			// Determine checkbox state and prefix
			if (task.status === 'completed') {
				taskLine = `- [x] ${task.id}: ${task.description}`;
			} else if (task.status === 'blocked') {
				taskLine = `- [BLOCKED] ${task.id}: ${task.description}`;
				if (task.blocked_reason) {
					taskLine += ` - ${task.blocked_reason}`;
				}
			} else {
				taskLine = `- [ ] ${task.id}: ${task.description}`;
			}

			// Add size
			taskLine += ` [${task.size.toUpperCase()}]`;

			// Add dependencies if present (sorted for determinism)
			if (task.depends.length > 0) {
				const sortedDepends = [...task.depends].sort();
				suffix += ` (depends: ${sortedDepends.join(', ')})`;
			}

			// Mark as CURRENT if it's the first in_progress task in current phase
			if (
				phase.id === plan.current_phase &&
				task.status === 'in_progress' &&
				!currentTaskMarked
			) {
				suffix += ' ← CURRENT';
				currentTaskMarked = true;
			}

			markdown += `${taskLine}${suffix}\n`;
		}
	}

	// Separate phases with ---
	const phaseSections = markdown.split('\n## ');
	if (phaseSections.length > 1) {
		// Reconstruct with --- separators between phases
		const header = phaseSections[0];
		const phases = phaseSections.slice(1).map((p) => `## ${p}`);
		markdown = `${header}\n---\n${phases.join('\n---\n')}`;
	}

	return `${markdown.trim()}\n`;
}

/**
 * Convert existing plan.md to plan.json. PURE function — no I/O.
 */
export function migrateLegacyPlan(planContent: string, swarmId?: string): Plan {
	const lines = planContent.split('\n');
	let title = 'Untitled Plan';
	let swarm = swarmId || 'default-swarm';
	let currentPhaseNum = 1;
	const phases: Phase[] = [];

	let currentPhase: Phase | null = null;

	for (const line of lines) {
		const trimmed = line.trim();

		// Extract title from first # line
		if (trimmed.startsWith('# ') && title === 'Untitled Plan') {
			title = trimmed.substring(2).trim();
			continue;
		}

		// Extract swarm from "Swarm:" line
		if (trimmed.startsWith('Swarm:')) {
			swarm = trimmed.substring(6).trim();
			continue;
		}

		// Extract current phase from "Phase:" line
		if (trimmed.startsWith('Phase:')) {
			const match = trimmed.match(/Phase:\s*(\d+)/i);
			if (match) {
				currentPhaseNum = parseInt(match[1], 10);
			}
			continue;
		}

		// Parse phase headers: ## Phase N: Name [STATUS] or ### Phase N [STATUS]
		const phaseMatch = trimmed.match(
			/^#{2,3}\s*Phase\s+(\d+)(?::\s*([^[]+))?\s*(?:\[([^\]]+)\])?/i,
		);
		if (phaseMatch) {
			// Save previous phase if exists
			if (currentPhase !== null) {
				phases.push(currentPhase);
			}

			const phaseId = parseInt(phaseMatch[1], 10);
			const phaseName = phaseMatch[2]?.trim() || `Phase ${phaseId}`;
			const statusText = phaseMatch[3]?.toLowerCase() || 'pending';

			const statusMap: Record<string, Phase['status']> = {
				complete: 'complete',
				completed: 'complete',
				'in progress': 'in_progress',
				in_progress: 'in_progress',
				inprogress: 'in_progress',
				pending: 'pending',
				blocked: 'blocked',
			};

			currentPhase = {
				id: phaseId,
				name: phaseName,
				status: statusMap[statusText] || 'pending',
				tasks: [],
			};
			continue;
		}

		// Parse task lines
		// Completed: - [x] N.M: Description [SIZE]
		// Pending: - [ ] N.M: Description [SIZE]
		// Blocked: - [BLOCKED] N.M: Description - reason
		const taskMatch = trimmed.match(
			/^-\s*\[([^\]]+)\]\s+(\d+\.\d+):\s*(.+?)(?:\s*\[(\w+)\])?(?:\s*-\s*(.+))?$/i,
		);
		if (taskMatch && currentPhase !== null) {
			const checkbox = taskMatch[1].toLowerCase();
			const taskId = taskMatch[2];
			let description = taskMatch[3].trim();
			const sizeText = taskMatch[4]?.toLowerCase() || 'small';
			let blockedReason: string | undefined;

			// Check for dependencies in description: (depends: X.Y, X.Z)
			const dependsMatch = description.match(/\s*\(depends:\s*([^)]+)\)$/i);
			const depends: string[] = [];
			if (dependsMatch) {
				const depsText = dependsMatch[1];
				depends.push(...depsText.split(',').map((d) => d.trim()));
				description = description.substring(0, dependsMatch.index).trim();
			}

			// Parse status from checkbox
			let status: Task['status'] = 'pending';
			if (checkbox === 'x') {
				status = 'completed';
			} else if (checkbox === 'blocked') {
				status = 'blocked';
				// Check if blocked reason is in the description suffix
				const blockedReasonMatch = taskMatch[5];
				if (blockedReasonMatch) {
					blockedReason = blockedReasonMatch.trim();
				}
			}

			// Parse size
			const sizeMap: Record<string, Task['size']> = {
				small: 'small',
				medium: 'medium',
				large: 'large',
			};

			const task: Task = {
				id: taskId,
				phase: currentPhase.id,
				status,
				size: sizeMap[sizeText] || 'small',
				description,
				depends,
				acceptance: undefined,
				files_touched: [],
				evidence_path: undefined,
				blocked_reason: blockedReason,
			};

			currentPhase.tasks.push(task);
		}

		// Fallback: Parse numbered list tasks (1. Description [SIZE])
		const numberedTaskMatch = trimmed.match(
			/^(\d+)\.\s+(.+?)(?:\s*\[(\w+)\])?$/,
		);
		if (numberedTaskMatch && currentPhase !== null) {
			const taskId = `${currentPhase.id}.${currentPhase.tasks.length + 1}`;
			let description = numberedTaskMatch[2].trim();
			const sizeText = numberedTaskMatch[3]?.toLowerCase() || 'small';

			// Check for dependencies in description: (depends: X.Y, X.Z)
			const dependsMatch = description.match(/\s*\(depends:\s*([^)]+)\)$/i);
			const depends: string[] = [];
			if (dependsMatch) {
				const depsText = dependsMatch[1];
				depends.push(...depsText.split(',').map((d) => d.trim()));
				description = description.substring(0, dependsMatch.index).trim();
			}

			// Parse size
			const sizeMap: Record<string, Task['size']> = {
				small: 'small',
				medium: 'medium',
				large: 'large',
			};

			const task: Task = {
				id: taskId,
				phase: currentPhase.id,
				status: 'pending',
				size: sizeMap[sizeText] || 'small',
				description,
				depends,
				acceptance: undefined,
				files_touched: [],
				evidence_path: undefined,
				blocked_reason: undefined,
			};

			currentPhase.tasks.push(task);
		}

		// Fallback: Parse checkbox tasks without N.M: prefix
		const noPrefixTaskMatch = trimmed.match(
			/^-\s*\[([^\]]+)\]\s+(?!\d+\.\d+:)(.+?)(?:\s*\[(\w+)\])?(?:\s*-\s*(.+))?$/i,
		);
		if (noPrefixTaskMatch && currentPhase !== null) {
			const checkbox = noPrefixTaskMatch[1].toLowerCase();
			const taskId = `${currentPhase.id}.${currentPhase.tasks.length + 1}`;
			let description = noPrefixTaskMatch[2].trim();
			const sizeText = noPrefixTaskMatch[3]?.toLowerCase() || 'small';
			let blockedReason: string | undefined;

			// Check for dependencies in description: (depends: X.Y, X.Z)
			const dependsMatch = description.match(/\s*\(depends:\s*([^)]+)\)$/i);
			const depends: string[] = [];
			if (dependsMatch) {
				const depsText = dependsMatch[1];
				depends.push(...depsText.split(',').map((d) => d.trim()));
				description = description.substring(0, dependsMatch.index).trim();
			}

			// Parse status from checkbox
			let status: Task['status'] = 'pending';
			if (checkbox === 'x') {
				status = 'completed';
			} else if (checkbox === 'blocked') {
				status = 'blocked';
				const blockedReasonMatch = noPrefixTaskMatch[4];
				if (blockedReasonMatch) {
					blockedReason = blockedReasonMatch.trim();
				}
			}

			// Parse size
			const sizeMap: Record<string, Task['size']> = {
				small: 'small',
				medium: 'medium',
				large: 'large',
			};

			const task: Task = {
				id: taskId,
				phase: currentPhase.id,
				status,
				size: sizeMap[sizeText] || 'small',
				description,
				depends,
				acceptance: undefined,
				files_touched: [],
				evidence_path: undefined,
				blocked_reason: blockedReason,
			};

			currentPhase.tasks.push(task);
		}
	}

	// Add final phase
	if (currentPhase !== null) {
		phases.push(currentPhase);
	}

	// Determine migration status
	let migrationStatus: Plan['migration_status'] = 'migrated';
	if (phases.length === 0) {
		// Zero phases parsed - migration failed
		console.warn(
			`migrateLegacyPlan: 0 phases parsed from ${lines.length} lines. First 3 lines: ${lines.slice(0, 3).join(' | ')}`,
		);
		migrationStatus = 'migration_failed';
		phases.push({
			id: 1,
			name: 'Migration Failed',
			status: 'blocked',
			tasks: [
				{
					id: '1.1',
					phase: 1,
					status: 'blocked',
					size: 'large',
					description: 'Review and restructure plan manually',
					depends: [],
					files_touched: [],
					blocked_reason: 'Legacy plan could not be parsed automatically',
				},
			],
		});
	}

	// Sort phases by ID
	phases.sort((a, b) => a.id - b.id);

	const plan: Plan = {
		schema_version: '1.0.0',
		title,
		swarm,
		current_phase: currentPhaseNum,
		phases,
		migration_status: migrationStatus,
	};

	return plan;
}
