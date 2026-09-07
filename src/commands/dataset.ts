/**
 * Issue #2486: the human-only `/swarm dataset` command surface — consent,
 * withdrawal, and governed dataset export.
 *
 * All three commands are `toolPolicy: 'human-only'` (refused for agents via
 * swarm_command, chat fallback, and the shell guardrail). Every mutating
 * operation runs preview-first and executes only behind the single-slot,
 * 15-minute-TTL, scope-bound confirmation token — the repo's established
 * two-step pattern (`src/commands/destructive-purge.ts`, ADR 0002).
 */
import { createHash } from 'node:crypto';
import {
	grantTrainingConsent,
	readActiveTrainingConsent,
	revokeTrainingConsent,
	TRAINING_CONSENT_CURRENT_VERSION,
	TRAINING_EXPORT_QUOTA_CEILINGS,
	TRAINING_QUOTA_CEILINGS,
} from '../training/consent';
import {
	checkTrainingConfirmToken,
	consumeTrainingPendingOp,
	executeTrainingExport,
	issueTrainingConfirmToken,
	previewTrainingExport,
	type TrainingExportFilters,
} from '../training/exporter';
import {
	getTrainingVaultStatus,
	listTrainingTombstones,
	purgeTrainingVaultContent,
	readTrainingExportRevocations,
} from '../training/vault';

const CONSENT_PURPOSE =
	'Contribute consented project content (visible user/assistant messages and structured tool calls/results) to a local, redacted training vault for governed dataset export.';

function flagValue(args: string[], name: string): string | undefined {
	const prefix = `--${name}=`;
	for (const arg of args) {
		if (arg.startsWith(prefix)) return arg.slice(prefix.length);
	}
	return undefined;
}

function quotaNumber(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseFilters(args: string[]): TrainingExportFilters {
	const filters: TrainingExportFilters = {};
	const ratio = quotaNumber(flagValue(args, 'validation-ratio'));
	if (ratio !== undefined)
		filters.validationRatio = Math.min(
			0.5,
			Math.max(0, ratio / 100 >= 1 ? ratio / 100 : ratio),
		);
	const kinds: TrainingExportFilters['kinds'] = [];
	const kind = flagValue(args, 'kind');
	if (kind !== undefined) {
		for (const k of kind.split(',')) {
			if (
				k === 'user_message' ||
				k === 'assistant_message' ||
				k === 'tool_call' ||
				k === 'tool_result'
			) {
				kinds.push(k);
			}
		}
		if (kinds.length > 0) filters.kinds = kinds;
	}
	const session = flagValue(args, 'session');
	if (session !== undefined) filters.sessionId = session;
	const task = flagValue(args, 'task');
	if (task !== undefined) filters.taskId = task;
	const since = flagValue(args, 'since');
	if (since !== undefined) filters.since = since;
	return filters;
}

/**
 * `/swarm dataset consent` — grant or revoke the training-content consent.
 * Granting is two-step: the bare command prints the terms and issues a token;
 * `--confirm=<token>` writes the grant. Quotas may only lower the ceilings.
 */
export async function handleDatasetConsentCommand(
	directory: string,
	args: string[],
): Promise<string> {
	if (args.includes('--revoke')) {
		revokeTrainingConsent(directory);
		const status = getTrainingVaultStatus(directory);
		return [
			'Training consent withdrawn.',
			`Capture is stopped as of now. Vault records on disk: ${status.recordCount}; tombstones: ${status.tombstoneCount}.`,
			'Physical deletion of vault content and export revocation require `/swarm dataset withdraw`.',
		].join('\n');
	}
	const status = getTrainingVaultStatus(directory);
	const confirm = flagValue(args, 'confirm');
	const quotas = {
		maxBytes:
			quotaNumber(flagValue(args, 'max-bytes')) ??
			TRAINING_QUOTA_CEILINGS.maxBytes,
		maxRecords:
			quotaNumber(flagValue(args, 'max-records')) ??
			TRAINING_QUOTA_CEILINGS.maxRecords,
		retentionDays:
			quotaNumber(flagValue(args, 'retention-days')) ??
			TRAINING_QUOTA_CEILINGS.retentionDays,
	};
	const digest = createHash('sha256')
		.update(`dataset-consent-v1\0${JSON.stringify(quotas)}`)
		.digest('hex');
	if (confirm !== undefined) {
		const check = checkTrainingConfirmToken(directory, 'consent', confirm);
		if (!check.ok) {
			return `Consent NOT granted: ${check.reason}. Re-run /swarm dataset consent for a fresh token.`;
		}
		if (check.record.scope_digest !== digest) {
			return 'Consent NOT granted: the requested quotas changed since the token was issued. Re-run /swarm dataset consent and confirm the new token.';
		}
		consumeTrainingPendingOp(directory);
		const consent = grantTrainingConsent(directory, { quotas });
		return [
			'Training consent GRANTED.',
			`consent_id: ${consent.consent_id} (terms v${consent.consent_version})`,
			`quotas: ${consent.quotas.maxBytes} bytes / ${consent.quotas.maxRecords} records / ${consent.quotas.retentionDays} days`,
			`expires: ${consent.expires_at}`,
			`Current consent state: ${getTrainingVaultStatus(directory).consentState}.`,
		].join('\n');
	}
	const token = issueTrainingConfirmToken(directory, {
		kind: 'consent',
		digest,
	});
	return [
		'Training-content capture is OFF until a consent record exists.',
		`Purpose: ${CONSENT_PURPOSE}`,
		`Content classes: user_message, assistant_message, tool_call, tool_result (plugin-injected guidance is never captured).`,
		`Redaction: defense-in-depth v1 (URL/credential patterns) applied at capture and recorded per record.`,
		`Hard ceilings (you may choose LOWER): ${TRAINING_QUOTA_CEILINGS.maxBytes} bytes, ${TRAINING_QUOTA_CEILINGS.maxRecords} records, ${TRAINING_QUOTA_CEILINGS.retentionDays} days.`,
		`Requested quotas: ${JSON.stringify(quotas)}`,
		`Current state: ${status.consentState}; vault records: ${status.recordCount}.`,
		'Withdrawal: /swarm dataset consent --revoke stops capture; /swarm dataset withdraw deletes content and revokes exports.',
		`To grant, re-run: /swarm dataset consent --confirm=${token} (valid 15 minutes).`,
	].join('\n');
}

/**
 * `/swarm dataset withdraw` — the destructive, confirmed purge: physically
 * deletes ALL vault content, writes a withdrawal tombstone, and revokes every
 * export still under plugin control.
 */
export async function handleDatasetWithdrawCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const status = getTrainingVaultStatus(directory);
	const revocations = readTrainingExportRevocations(directory);
	const exportIds = revocations.length; // already-revoked exports
	const digest = createHash('sha256')
		.update(
			`dataset-withdraw-v1\0${status.recordCount}\0${status.vaultBytes}\0${status.tombstoneCount}`,
		)
		.digest('hex');
	const confirm = flagValue(args, 'confirm');
	if (confirm !== undefined) {
		const check = checkTrainingConfirmToken(directory, 'withdraw', confirm);
		if (!check.ok) {
			return `Withdrawal NOT executed: ${check.reason}. Re-run /swarm dataset withdraw for a fresh token.`;
		}
		if (check.record.scope_digest !== digest) {
			return 'Withdrawal NOT executed: the vault changed since the token was issued. Re-run /swarm dataset withdraw and confirm the new token.';
		}
		consumeTrainingPendingOp(directory);
		revokeTrainingConsent(directory);
		const purge = purgeTrainingVaultContent(directory);
		return [
			`Withdrawal executed: purged ${purge.purgedRecords} record(s).`,
			`tombstone_id: ${purge.tombstone.tombstone_id}`,
			`revoked exports: ${purge.revokedExports.length === 0 ? 'none under plugin control' : purge.revokedExports.join(', ')}`,
			'The vault file is now empty; the tombstone is durable and never removed by later operations.',
		].join('\n');
	}
	const token = issueTrainingConfirmToken(directory, {
		kind: 'withdraw',
		digest,
	});
	return [
		'Withdrawal preview (destructive):',
		`  - vault records to DELETE: ${status.recordCount} (${status.vaultBytes} bytes)`,
		`  - exports to revoke: ${exportIds === 0 ? 'none under plugin control' : `${exportIds} already-revoked listed; live exports will get REVOKED.json`}`,
		`  - withdrawal tombstone will be appended (existing tombstones: ${status.tombstoneCount}, never deleted)`,
		`  - consent will be marked withdrawn (capture stops immediately)`,
		'This destroys the consented vault content on disk.',
		`To execute, re-run: /swarm dataset withdraw --confirm=${token} (valid 15 minutes).`,
	].join('\n');
}

/**
 * `/swarm dataset export` — the governed, deterministic dataset export.
 * Preview by default (filters, counts, destination, checksum-backed manifest
 * summary); executes only behind the confirmation token.
 */
export async function handleDatasetExportCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const filters = parseFilters(args);
	const active = readActiveTrainingConsent(directory);
	const preview = previewTrainingExport(directory, filters);
	const confirm = flagValue(args, 'confirm');
	if (confirm !== undefined) {
		const result = executeTrainingExport(directory, filters, {
			confirmToken: confirm,
		});
		if (!result.written) {
			return `Export NOT written: ${result.reason}. Re-run /swarm dataset export for a fresh preview and token.`;
		}
		return [
			`Export written: ${result.exportId}`,
			`destination: ${result.destination}`,
			'Bundle: records.jsonl, train.jsonl, validation.jsonl, manifest.json (sha256 checksums in the manifest).',
			'Re-run the identical preview to re-export the identical bundle idempotently.',
		].join('\n');
	}
	const token = issueTrainingConfirmToken(directory, {
		kind: 'export',
		digest: preview.exportId,
	});
	return [
		'Export preview (side-effect-free; deterministic bundle):',
		`  - export id: ${preview.exportId}`,
		`  - records: ${preview.recordCount} (train ${preview.split.train} / validation ${preview.split.validation}; quarantined excluded: ${preview.quarantinedExcluded})`,
		`  - estimated size: ${preview.estimatedBytes} bytes`,
		`  - destination: ${preview.destination}`,
		`  - consent: ${active ? `granted (terms v${TRAINING_CONSENT_CURRENT_VERSION})` : 'no active consent — only already-captured records export'}`,
		`  - export ceilings: ${TRAINING_EXPORT_QUOTA_CEILINGS.maxExports} exports / ${TRAINING_EXPORT_QUOTA_CEILINGS.maxBytes} bytes total`,
		'Filters: --kind <k>[,<k>] --session <id> --task <id> --since <ISO> --validation-ratio <0..0.5>.',
		`To write the bundle, re-run with --confirm=${token} (valid 15 minutes).`,
	].join('\n');
}

/** Shared status block used by help/report surfaces. */
export function describeTrainingVault(directory: string): string {
	const status = getTrainingVaultStatus(directory);
	const tombstones = listTrainingTombstones(directory).length;
	return `training vault: ${status.consentState}, ${status.recordCount} record(s), ${status.vaultBytes} bytes, tombstones ${tombstones}, quarantined ${status.quarantinedCount}${status.lastStopReason !== undefined ? `, last stop: ${status.lastStopReason}` : ''}`;
}
