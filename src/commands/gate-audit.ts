import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GateName } from '../evaluation/contracts.js';
import { GateNameSchema } from '../evaluation/contracts.js';
import { TIER1_FIXTURE_IDS } from '../evaluation/fixtures.js';
import {
	createGateAuditManifest,
	defaultGateAuditId,
	runGateAudit,
} from '../evaluation/gate-audit.js';
import type { EvaluationModelDispatcher } from '../evaluation/model-dispatcher.js';
import {
	readGateAuditManifest,
	readGateAuditResult,
	saveGateAuditManifest,
} from '../evaluation/store.js';

const DEFAULT_PACKAGE_ROOT = resolvePackageRoot(fileURLToPath(import.meta.url));

type ParsedGateAuditArgs = {
	runId?: string;
	models: string[];
	preferredSwarm?: string;
	gates: GateName[];
	tasks: string[];
	repetitions: number;
	seed: string;
	maxConcurrency: number;
	maxRetries: number;
	maxTimeMs: number;
	maxCostUsd?: number;
	json: boolean;
};

function resolvePackageRoot(modulePath: string): string {
	const moduleDir = path.dirname(modulePath);
	const leaf = path.basename(moduleDir);
	if (leaf === 'commands' || leaf === 'cli')
		return path.resolve(moduleDir, '..', '..');
	if (leaf === 'dist') return path.resolve(moduleDir, '..');
	return path.resolve(moduleDir, '..');
}

function positiveInteger(
	value: string | undefined,
	flag: string,
	maximum: number,
): number {
	if (!value || !/^\d+$/.test(value))
		throw new Error(`${flag} requires an integer`);
	const parsed = Number(value);
	if (parsed < 1 || parsed > maximum) {
		throw new Error(`${flag} must be between 1 and ${maximum}`);
	}
	return parsed;
}

function nonNegativeInteger(
	value: string | undefined,
	flag: string,
	maximum: number,
): number {
	if (!value || !/^\d+$/.test(value))
		throw new Error(`${flag} requires an integer`);
	const parsed = Number(value);
	if (parsed > maximum)
		throw new Error(`${flag} must be between 0 and ${maximum}`);
	return parsed;
}

function parseArgs(args: string[]): ParsedGateAuditArgs {
	const parsed: ParsedGateAuditArgs = {
		models: [],
		gates: ['reviewer', 'test-engineer', 'sast', 'mutation', 'quality'],
		tasks: [...TIER1_FIXTURE_IDS],
		repetitions: 1,
		seed: 'tier1-v1',
		maxConcurrency: 2,
		maxRetries: 1,
		maxTimeMs: 300_000,
		json: false,
	};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		const value = args[index + 1];
		if (arg === '--json') parsed.json = true;
		else if (arg === '--run-id') {
			if (!value || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)) {
				throw new Error('--run-id requires a safe identifier');
			}
			parsed.runId = value;
			index++;
		} else if (arg === '--model') {
			if (!value || value.length > 300)
				throw new Error('--model requires a model id');
			parsed.models.push(value);
			index++;
		} else if (arg === '--swarm') {
			if (!value || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)) {
				throw new Error('--swarm requires a safe swarm id');
			}
			parsed.preferredSwarm = value;
			index++;
		} else if (arg === '--gates') {
			if (!value) throw new Error('--gates requires a comma-separated list');
			parsed.gates = value.split(',').map((gate) => GateNameSchema.parse(gate));
			index++;
		} else if (arg === '--tasks') {
			if (!value) throw new Error('--tasks requires a comma-separated list');
			parsed.tasks = value.split(',');
			if (
				parsed.tasks.some((task) => !TIER1_FIXTURE_IDS.includes(task as never))
			) {
				throw new Error('--tasks contains an unknown Tier-1 fixture');
			}
			index++;
		} else if (arg === '--runs') {
			parsed.repetitions = positiveInteger(value, arg, 100);
			index++;
		} else if (arg === '--max-concurrency') {
			parsed.maxConcurrency = positiveInteger(value, arg, 16);
			index++;
		} else if (arg === '--max-retries') {
			parsed.maxRetries = nonNegativeInteger(value, arg, 20);
			index++;
		} else if (arg === '--max-time-ms') {
			parsed.maxTimeMs = positiveInteger(value, arg, 3_600_000);
			index++;
		} else if (arg === '--max-cost-usd') {
			if (!value || !/^\d+(?:\.\d+)?$/.test(value)) {
				throw new Error('--max-cost-usd requires a non-negative number');
			}
			parsed.maxCostUsd = Number(value);
			index++;
		} else if (arg === '--seed') {
			if (!value || value.length > 500)
				throw new Error('--seed requires a bounded value');
			parsed.seed = value;
			index++;
		} else {
			throw new Error(`Unknown gate-audit argument: ${arg}`);
		}
	}
	if (parsed.models.length === 0) parsed.models.push('configured');
	if (new Set(parsed.tasks).size !== parsed.tasks.length) {
		throw new Error('--tasks contains duplicate ids');
	}
	if (new Set(parsed.gates).size !== parsed.gates.length) {
		throw new Error('--gates contains duplicate gates');
	}
	return parsed;
}

export async function handleGateAuditCommand(
	directory: string,
	args: string[],
	runtime: {
		packageRoot?: string;
		dispatcher?: EvaluationModelDispatcher;
		parentSessionId?: string;
	} = {},
): Promise<string> {
	const parsed = parseArgs(args);
	const identity = JSON.stringify({
		tasks: parsed.tasks,
		gates: parsed.gates,
		models: parsed.models,
		preferredSwarm: parsed.preferredSwarm,
		repetitions: parsed.repetitions,
		seed: parsed.seed,
		maxConcurrency: parsed.maxConcurrency,
		maxRetries: parsed.maxRetries,
		maxTimeMs: parsed.maxTimeMs,
		maxCostUsd: parsed.maxCostUsd,
	});
	const id = parsed.runId ?? defaultGateAuditId(identity);
	const priorManifest = await readGateAuditManifest(directory, id);
	const manifest = createGateAuditManifest({
		v: 1,
		id,
		createdAt: priorManifest?.createdAt ?? new Date().toISOString(),
		taskIds: parsed.tasks,
		gates: parsed.gates,
		models: parsed.models,
		...(parsed.preferredSwarm ? { preferredSwarm: parsed.preferredSwarm } : {}),
		repetitions: parsed.repetitions,
		seed: parsed.seed,
		maxConcurrency: parsed.maxConcurrency,
		maxRetries: parsed.maxRetries,
		maxTimeMs: parsed.maxTimeMs,
		...(parsed.maxCostUsd === undefined
			? {}
			: { maxCostUsd: parsed.maxCostUsd }),
	});
	if (priorManifest && priorManifest.contentHash !== manifest.contentHash) {
		throw new Error(
			`gate-audit run id ${id} already belongs to a different manifest`,
		);
	}
	await saveGateAuditManifest(directory, manifest);
	const priorResult = await readGateAuditResult(directory, id);
	const result =
		priorResult ??
		(await runGateAudit({
			projectRoot: directory,
			packageRoot: runtime.packageRoot ?? DEFAULT_PACKAGE_ROOT,
			manifest,
			dispatcher: runtime.dispatcher,
			parentSessionId: runtime.parentSessionId,
		}));
	if (parsed.json) return JSON.stringify(result, null, 2);
	const caught = result.cells.filter(
		(cell) => cell.outcome === 'caught',
	).length;
	const missed = result.cells.filter(
		(cell) => cell.outcome === 'missed',
	).length;
	const unavailable = result.cells.filter(
		(cell) =>
			cell.outcome === 'unsupported' ||
			cell.outcome === 'infrastructure_failure',
	).length;
	return [
		'## Gate Audit',
		'',
		`- Run: \`${result.runId}\``,
		`- Status: **${result.status}**`,
		`- Cells: ${result.cells.length}`,
		`- Caught: ${caught}`,
		`- Missed: ${missed}`,
		`- Unsupported/infrastructure: ${unavailable}`,
		`- Cost: ${result.cost.source === 'unavailable' ? 'unavailable' : `$${result.cost.usd?.toFixed(4)}`}`,
		'- quality_budget complexity_delta/public_api_delta: true base-vs-head deltas (#2470); not consumed by promotion regression math',
	].join('\n');
}

export const _internals = { parseArgs, resolvePackageRoot };
