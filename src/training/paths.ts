/**
 * Issue #2486: path layout for the consented training vault.
 *
 * All durable training state lives under `<project-root>/.swarm/training/v1/`
 * (source contract #2050 §4; re-baselined by #2486). The helpers here are the
 * single source of truth for the layout; every read/write in the training
 * subsystem resolves through `validateSwarmPath` (`src/hooks/utils.ts`) before
 * touching the filesystem, and the tree is Git-excluded via the standard
 * `.swarm/` exclusion flow.
 */
import * as path from 'node:path';
import { validateSwarmPath } from '../hooks/utils';

/** Root directory name of the governed training tree, relative to `.swarm/`. */
export const TRAINING_ROOT_NAME = '.swarm/training/v1';

/** Resolved absolute root of the training tree for a project directory. */
export function trainingRootDir(directory: string): string {
	return validateSwarmPath(directory, 'training/v1');
}

/** `<root>/vault/records.jsonl` — the append-only vault record store. */
export function trainingVaultRecordsPath(directory: string): string {
	return validateSwarmPath(directory, 'training/v1/vault/records.jsonl');
}

/** `<root>/vault/quarantine.jsonl` — journal of quarantined corrupt lines. */
export function trainingQuarantinePath(directory: string): string {
	return validateSwarmPath(directory, 'training/v1/vault/quarantine.jsonl');
}

/** `<root>/consent.json` — the durable, separately-consented grant record. */
export function trainingConsentPath(directory: string): string {
	return validateSwarmPath(directory, 'training/v1/consent.json');
}

/** `<root>/tombstones.jsonl` — append-only withdrawal tombstones (never pruned). */
export function trainingTombstonesPath(directory: string): string {
	return validateSwarmPath(directory, 'training/v1/tombstones.jsonl');
}

/** `<root>/health.json` — bounded capture-health state (stop reasons, counters). */
export function trainingHealthPath(directory: string): string {
	return validateSwarmPath(directory, 'training/v1/health.json');
}

/** `<root>/exports` — contained dataset export bundles (`<exports>/<exportId>/`). */
export function trainingExportsDir(directory: string): string {
	return validateSwarmPath(directory, 'training/v1/exports');
}

/** `<root>/pending-op.json` — single-slot confirmation token store. */
export function trainingPendingOpPath(directory: string): string {
	return validateSwarmPath(directory, 'training/v1/pending-op.json');
}

/** Directory portion of a resolved training path (for mkdir before writes). */
export function parentDirOf(filePath: string): string {
	return path.dirname(filePath);
}
