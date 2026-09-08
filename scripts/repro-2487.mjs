#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CHILD_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const SCENARIOS = ['cross-runtime', 'recovery', 'kill-switches', 'archive-restore', 'reachability', 'field-scale'];

function boundedAppend(current, chunk) {
	if (current.length >= MAX_OUTPUT_BYTES) return current;
	return `${current}${chunk.toString('utf8')}`.slice(0, MAX_OUTPUT_BYTES);
}

function runProcess(command, args, timeoutMs = CHILD_TIMEOUT_MS) {
	return new Promise((resolveResult) => {
		const child = spawn(command, args, {
			cwd: REPO_ROOT,
			env: process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, timeoutMs);
		child.stdout.on('data', (chunk) => {
			stdout = boundedAppend(stdout, chunk);
		});
		child.stderr.on('data', (chunk) => {
			stderr = boundedAppend(stderr, chunk);
		});
		child.once('error', (error) => {
			clearTimeout(timer);
			try {
				child.kill('SIGKILL');
			} catch {}
			resolveResult({ code: 1, stdout, stderr: `${stderr}${String(error)}`, timedOut });
		});
		child.once('close', (code) => {
			clearTimeout(timer);
			try {
				child.kill('SIGKILL');
			} catch {}
			resolveResult({ code: code ?? 1, stdout, stderr, timedOut });
		});
	});
}

function bunExecutable() {
	if (process.env.BUN_BINARY) return process.env.BUN_BINARY;
	const install = process.env.BUN_INSTALL;
	if (install) {
		const candidate = join(install, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
		if (existsSync(candidate)) return candidate;
	}
	return process.platform === 'win32' ? 'bun.exe' : 'bun';
}

function fixtureSource(moduleUrl) {
	return `import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  archiveSqliteSnapshot,
  closeProjectDb,
  emit,
  flushAndDrainTelemetry,
  getProjectDb,
  initTelemetry,
  handleCostsCommand,
  handleReportCommand,
  loadDatabaseCtor,
  MAX_OBSERVABILITY_EVENT_ROWS,
  queryObservabilityEvents,
  readObservabilityCoverage,
  readObservabilitySinkHealth,
  registerObservabilityEventSink,
  resetObservabilityEventSinkForTesting,
  resetTelemetryForTesting,
  readTelemetryEvents,
  RETENTION_CHECK_INTERVAL,
  syncObservabilityImport,
  summarizeTelemetryCosts,
  telemetry,
  withProjectDbReadOnly,
  appendInsightCandidatesDb,
  appendSqliteLedger,
  acquireCoordinationLease,
  consumeInsightCandidatesDb,
  countPendingInsightCandidatesDb,
  ensureTaskCheckpointReceipt,
  getCoordinationLease,
  getCoordinationState,
  getOrCreateProfile,
  getProfile,
  importCoordinationOnce,
  importSqliteLedger,
  readPhaseReportsDb,
  readSqliteLedgerEvents,
  readTaskCheckpointReceipt,
  runProjectMigrations,
  transitionCoordinationState,
  upsertPhaseReportDb,
} from ${JSON.stringify(moduleUrl)};

const projectDir = process.argv[2];
const evidencePath = process.argv[3];
const operation = process.argv[4];
const runtime = process.argv[5] ?? 'unknown';
const operationData = process.argv[6] ? JSON.parse(process.argv[6]) : undefined;
mkdirSync(join(projectDir, '.swarm'), { recursive: true });
const db = getProjectDb(projectDir);
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
};
const canonical = (value) => JSON.stringify(canonicalize(value));
const writeEvidence = (value) => writeFileSync(evidencePath, canonical(value), 'utf8');
const schemaTables = () => getProjectDb(projectDir).query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY name").all().map((item) => item.name);
const createPartition = (id) => {
  const invokedApis = [];
  return {
    id,
    invokedApis,
    call(name, operation) {
      invokedApis.push(name);
      return operation();
    },
  };
};
const policyWitnessMarker = (id) => 'issue-2487-policy:' + id;
const writePolicyRecoveryWitnesses = async () => {
  const projectDb = getProjectDb(projectDir);
  runProjectMigrations(projectDb);
  projectDb.run("INSERT INTO project_constraints (constraint_type, content) VALUES (?, ?)", ['issue-2487-policy', 'always-on-recovery-row']);

  getOrCreateProfile(projectDir, 'issue-2487-policy-plan', 'qualification', { final_council: true });
  getProfile(projectDir, 'issue-2487-policy-plan');

  ensureTaskCheckpointReceipt(projectDir, 'issue-2487-policy-hash', 'issue-2487-policy-task', 2);
  readTaskCheckpointReceipt(projectDir, 'issue-2487-policy-hash', 'issue-2487-policy-task');

  await appendInsightCandidatesDb(projectDir, [{
    payload: JSON.stringify({ marker: policyWitnessMarker('legacy-imports') }),
    createdAt: '2026-01-01T00:00:02.000Z',
  }]);
  await upsertPhaseReportDb(projectDir, 'curator_drift', 2487, JSON.stringify({ marker: policyWitnessMarker('legacy-imports') }));
  readPhaseReportsDb(projectDir, 'curator_drift');

  transitionCoordinationState(projectDir, {
    namespace: 'issue-2487-policy',
    entityKey: 'state',
    expectedRevision: null,
    generation: 1,
    status: 'policy_recovered',
    payload: JSON.stringify({ marker: policyWitnessMarker('coordination') }),
    event: {
      streamId: 'issue-2487-policy-stream',
      idempotencyKey: 'issue-2487-policy-key',
      eventType: 'policy_recovered',
      payload: JSON.stringify({ marker: policyWitnessMarker('coordination') }),
    },
  });
  acquireCoordinationLease(projectDir, {
    namespace: 'issue-2487-policy',
    entityKey: 'lease',
    generation: 1,
    ownerToken: 'issue-2487-policy-owner',
    leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    payload: JSON.stringify({ marker: policyWitnessMarker('coordination') }),
  });
  importCoordinationOnce(projectDir, {
    source: 'issue-2487-policy-legacy',
    sourceDigest: 'issue-2487-policy-digest',
    rowCount: 0,
    emptyNamespace: 'issue-2487-policy-import',
  }, () => {});

  initTelemetry(projectDir);
  registerObservabilityEventSink(projectDir);
  emit('delegation_begin', {
    sessionId: 'issue-2487-policy-session',
    taskId: 'issue-2487-policy-observability',
    laneId: 'issue-2487-policy-lane',
    batchId: 'issue-2487-policy-batch',
    phase: 1,
    agentName: 'qualification',
    payloadMarker: policyWitnessMarker('observability'),
  });
  await flushAndDrainTelemetry();

  const ledger = readSqliteLedgerEvents(projectDir);
  const previous = ledger.events.at(-1);
  const seq = Number(previous?.seq ?? 0) + 1;
  appendSqliteLedger(projectDir, {
    canonicalEvent: JSON.stringify({
      seq,
      timestamp: '2026-01-01T00:00:02.000Z',
      plan_id: 'issue-2487-ledger',
      event_type: 'plan_policy_recovery',
      source: 'qualification',
      plan_hash_before: previous?.planHashAfter ?? 'issue-2487-final',
      plan_hash_after: 'issue-2487-policy',
      schema_version: '1.1.0',
      payload: { marker: policyWitnessMarker('plan-ledger') },
    }),
    expectedSeq: seq - 1,
    expectedHash: previous?.planHashAfter,
  });
};
const readPolicyRecoveryWitnesses = (reopened) => {
  const projectConstraint = reopened.query("SELECT content FROM project_constraints WHERE constraint_type = ? ORDER BY id DESC LIMIT 1").get('issue-2487-policy');
  const profile = getProfile(projectDir, 'issue-2487-policy-plan');
  const receipt = readTaskCheckpointReceipt(projectDir, 'issue-2487-policy-hash', 'issue-2487-policy-task');
  const consumedInsight = consumeInsightCandidatesDb(projectDir, 2);
  const phaseReports = readPhaseReportsDb(projectDir, 'curator_drift');
  const coordinationState = getCoordinationState(projectDir, 'issue-2487-policy', 'state');
  const coordinationLease = getCoordinationLease(projectDir, 'issue-2487-policy', 'lease');
  const coordinationImport = importCoordinationOnce(projectDir, {
    source: 'issue-2487-policy-legacy',
    sourceDigest: 'issue-2487-policy-digest',
    rowCount: 0,
    emptyNamespace: 'issue-2487-policy-import',
  }, () => {});
  const observability = queryObservabilityEvents(projectDir, { taskId: 'issue-2487-policy-observability' });
  const observabilityPayload = observability.rows.map((row) => {
    try {
      return JSON.parse(row.payload_json);
    } catch {
      return null;
    }
  }).find((payload) => payload?.payloadMarker === policyWitnessMarker('observability'));
  const ledger = readSqliteLedgerEvents(projectDir);
  const ledgerEvent = ledger.events.at(-1);
  return {
    'project-schema': { restored: projectConstraint?.content === 'always-on-recovery-row', marker: policyWitnessMarker('project-schema') },
    'qa-profile': { restored: profile?.plan_id === 'issue-2487-policy-plan', marker: policyWitnessMarker('qa-profile') },
    'checkpoint-receipt': { restored: receipt?.task_id === 'issue-2487-policy-task', marker: policyWitnessMarker('checkpoint-receipt') },
    'legacy-imports': { restored: consumedInsight.some((payload) => JSON.parse(payload)?.marker === policyWitnessMarker('legacy-imports')) && phaseReports.some((row) => JSON.parse(row.payload)?.marker === policyWitnessMarker('legacy-imports')), marker: policyWitnessMarker('legacy-imports') },
    coordination: { restored: coordinationState?.status === 'policy_recovered' && coordinationLease?.ownerToken === 'issue-2487-policy-owner' && coordinationImport === 'already_imported', marker: policyWitnessMarker('coordination') },
    observability: { restored: observabilityPayload?.payloadMarker === policyWitnessMarker('observability'), marker: policyWitnessMarker('observability') },
    'plan-ledger': { restored: ledgerEvent?.payload?.marker === policyWitnessMarker('plan-ledger'), marker: policyWitnessMarker('plan-ledger') },
  };
};

if (operation === 'production-write') {
  const projectSchema = createPartition('project-schema');
  const qaProfile = createPartition('qa-profile');
  const checkpointReceipt = createPartition('checkpoint-receipt');
  const legacyImports = createPartition('legacy-imports');
  const coordination = createPartition('coordination');
  const observability = createPartition('observability');
  const planLedger = createPartition('plan-ledger');
  const projectDb = projectSchema.call('getProjectDb', () => getProjectDb(projectDir));
  projectSchema.call('runProjectMigrations', () => runProjectMigrations(projectDb));
  const profile = qaProfile.call('getOrCreateProfile', () => getOrCreateProfile(projectDir, 'issue-2487-plan', 'qualification', { final_council: true }));
  const profileRead = qaProfile.call('getProfile', () => getProfile(projectDir, 'issue-2487-plan'));
  const receipt = checkpointReceipt.call('ensureTaskCheckpointReceipt', () => ensureTaskCheckpointReceipt(projectDir, 'issue-2487-plan-hash', 'issue-2487-task', 1));
  const receiptRead = checkpointReceipt.call('readTaskCheckpointReceipt', () => readTaskCheckpointReceipt(projectDir, 'issue-2487-plan-hash', 'issue-2487-task'));
  await legacyImports.call('appendInsightCandidatesDb', () => appendInsightCandidatesDb(projectDir, [{ payload: JSON.stringify({ lesson: 'issue-2487', created_at: '2026-01-01T00:00:00.000Z' }), createdAt: '2026-01-01T00:00:00.000Z' }]));
  const consumedInsight = legacyImports.call('consumeInsightCandidatesDb', () => consumeInsightCandidatesDb(projectDir, 0));
  await legacyImports.call('upsertPhaseReportDb', () => upsertPhaseReportDb(projectDir, 'curator_drift', 1, '{"qualified":true}'));
  const phasePayload = legacyImports.call('readPhaseReportsDb', () => readPhaseReportsDb(projectDir, 'curator_drift')[0]?.payload ?? null);
  const transition = coordination.call('transitionCoordinationState', () => transitionCoordinationState(projectDir, { namespace: 'issue-2487', entityKey: 'state', expectedRevision: null, generation: 1, status: 'qualified', payload: '{}', event: { streamId: 'issue-2487-stream', idempotencyKey: 'issue-2487-key', eventType: 'qualified', payload: '{}' } }));
  const lease = coordination.call('acquireCoordinationLease', () => acquireCoordinationLease(projectDir, { namespace: 'issue-2487', entityKey: 'lease', generation: 1, ownerToken: 'issue-2487-owner', leaseExpiresAt: '2030-01-01T00:00:00.000Z', payload: '{}' }));
  const importResult = coordination.call('importCoordinationOnce', () => importCoordinationOnce(projectDir, { source: 'issue-2487-legacy', sourceDigest: 'issue-2487-digest', rowCount: 0, emptyNamespace: 'issue-2487-import' }, () => {}));
  const coordinationRead = { state: getCoordinationState(projectDir, 'issue-2487', 'state')?.status ?? null, lease: getCoordinationLease(projectDir, 'issue-2487', 'lease')?.ownerToken ?? null };
  const ledgerEvent = JSON.stringify({ seq: 1, timestamp: '2026-01-01T00:00:00.000Z', plan_id: 'issue-2487-ledger', event_type: 'plan_created', source: 'qualification', plan_hash_before: '', plan_hash_after: 'issue-2487-after', schema_version: '1.1.0', payload: { qualified: true } });
  planLedger.call('importSqliteLedger', () => importSqliteLedger(projectDir, { canonicalEvents: [ledgerEvent], state: { authorityMode: 'file_shadow', parityStatus: 'pending' } }));
  const appendedLedger = JSON.stringify({ seq: 2, timestamp: '2026-01-01T00:00:01.000Z', plan_id: 'issue-2487-ledger', event_type: 'plan_completed', source: 'qualification', plan_hash_before: 'issue-2487-after', plan_hash_after: 'issue-2487-final', schema_version: '1.1.0', payload: { qualified: true } });
  planLedger.call('appendSqliteLedger', () => appendSqliteLedger(projectDir, { canonicalEvent: appendedLedger }));
  const ledgerRead = planLedger.call('readSqliteLedgerEvents', () => readSqliteLedgerEvents(projectDir));
  initTelemetry(projectDir);
  observability.call('registerObservabilityEventSink', () => registerObservabilityEventSink(projectDir));
  observability.call('emit', () => emit('delegation_begin', { sessionId: 'issue-2487-session', taskId: 'issue-2487-observability', laneId: 'issue-2487-lane', batchId: 'issue-2487-batch', phase: 1, agentName: 'qualification' }));
  observability.call('telemetry.delegationEnd', () => telemetry.delegationEnd('issue-2487-session', 'qualification', 'issue-2487-observability', 'completed', { tokens_input: 10, tokens_output: 5, cost_usd: 0.25, cost_source: 'reported', model: 'qualification-model', gate: 'qualification', retry_index: 0 }));
  observability.call('telemetry.gatePassed', () => telemetry.gatePassed('issue-2487-session', 'qualification', 'issue-2487-observability'));
  await flushAndDrainTelemetry();
  const legacyEvents = observability.call('readTelemetryEvents', () => readTelemetryEvents(projectDir));
  const costSummary = observability.call('summarizeTelemetryCosts', () => summarizeTelemetryCosts(projectDir));
  const costsJson = await observability.call('handleCostsCommand', () => handleCostsCommand(projectDir, ['--json']));
  const sync = observability.call('syncObservabilityImport', () => syncObservabilityImport(projectDir));
  const query = observability.call('queryObservabilityEvents', () => queryObservabilityEvents(projectDir, { taskId: 'issue-2487-observability' }));
  const coverage = observability.call('readObservabilityCoverage', () => readObservabilityCoverage(projectDir));
  observability.call('readObservabilitySinkHealth', () => readObservabilitySinkHealth(projectDir));
  const reportText = await observability.call('handleReportCommand', () => handleReportCommand(projectDir, ['--json', '--task', 'issue-2487-observability']));
  const reportJsonStart = reportText.indexOf('[REPORT_JSON]') + '[REPORT_JSON]'.length;
  const reportJsonEnd = reportText.indexOf('[/REPORT_JSON]');
  const report = JSON.parse(reportText.slice(reportJsonStart, reportJsonEnd));
  const partitions = [
    { id: projectSchema.id, invokedApis: projectSchema.invokedApis, evidence: { tables: schemaTables(), projectConstraint: projectDb.query("SELECT COUNT(*) AS count FROM project_constraints").get()?.count ?? 0 } },
    { id: qaProfile.id, invokedApis: qaProfile.invokedApis, evidence: { planId: profileRead?.plan_id ?? null, finalCouncil: profileRead?.gates.final_council ?? null } },
    { id: checkpointReceipt.id, invokedApis: checkpointReceipt.invokedApis, evidence: { taskId: receiptRead?.task_id ?? null, generation: receiptRead?.generation ?? null } },
    { id: legacyImports.id, invokedApis: legacyImports.invokedApis, evidence: { pending: countPendingInsightCandidatesDb(projectDir), consumed: consumedInsight.length, phasePayload } },
    { id: coordination.id, invokedApis: coordination.invokedApis, evidence: { outcome: transition.outcome, status: coordinationRead.state, lease: lease.outcome, importMarkerPresent: importResult === 'imported' } },
    { id: observability.id, invokedApis: observability.invokedApis, evidence: { queryRows: query.rows.length, legacyEvents: legacyEvents.length, importedRows: coverage?.importedRows ?? 0, coverageRows: coverage?.totalRows ?? 0, costDelegations: costSummary.delegations, costGateRows: costSummary.by_gate.length, costsHasJson: costsJson.includes('[COSTS_JSON]'), reportRows: report.timeline.length } },
    { id: planLedger.id, invokedApis: planLedger.invokedApis, evidence: { count: ledgerRead.events.length, firstSeq: ledgerRead.events[0]?.seq ?? null, lastSeq: ledgerRead.events.at(-1)?.seq ?? null } },
  ];
  const evidence = {
    tables: schemaTables(),
    partitions,
  };
  projectSchema.call('closeProjectDb', () => closeProjectDb(projectDir));
  resetObservabilityEventSinkForTesting();
  resetTelemetryForTesting();
  writeEvidence(evidence);
} else if (operation === 'production-read') {
  const projectSchema = createPartition('project-schema');
  const qaProfile = createPartition('qa-profile');
  const checkpointReceipt = createPartition('checkpoint-receipt');
  const legacyImports = createPartition('legacy-imports');
  const coordination = createPartition('coordination');
  const observability = createPartition('observability');
  const planLedger = createPartition('plan-ledger');
  const projectDb = projectSchema.call('getProjectDb', () => getProjectDb(projectDir));
  projectSchema.call('runProjectMigrations', () => runProjectMigrations(projectDb));
  const profile = qaProfile.call('getProfile', () => getProfile(projectDir, 'issue-2487-plan'));
  const receipt = checkpointReceipt.call('readTaskCheckpointReceipt', () => readTaskCheckpointReceipt(projectDir, 'issue-2487-plan-hash', 'issue-2487-task'));
  const state = getCoordinationState(projectDir, 'issue-2487', 'state');
  const lease = getCoordinationLease(projectDir, 'issue-2487', 'lease');
  const importResult = coordination.call('importCoordinationOnce', () => importCoordinationOnce(projectDir, { source: 'issue-2487-legacy', sourceDigest: 'issue-2487-digest', rowCount: 0, emptyNamespace: 'issue-2487-import' }, () => {}));
  const phasePayload = legacyImports.call('readPhaseReportsDb', () => readPhaseReportsDb(projectDir, 'curator_drift')[0]?.payload ?? null);
  legacyImports.call('consumeInsightCandidatesDb', () => consumeInsightCandidatesDb(projectDir, 0));
  const ledgerRead = planLedger.call('readSqliteLedgerEvents', () => readSqliteLedgerEvents(projectDir));
  const legacyEvents = observability.call('readTelemetryEvents', () => readTelemetryEvents(projectDir));
  const costSummary = observability.call('summarizeTelemetryCosts', () => summarizeTelemetryCosts(projectDir));
  const costsJson = await observability.call('handleCostsCommand', () => handleCostsCommand(projectDir, ['--json']));
  const sync = observability.call('syncObservabilityImport', () => syncObservabilityImport(projectDir));
  const query = observability.call('queryObservabilityEvents', () => queryObservabilityEvents(projectDir, { taskId: 'issue-2487-observability' }));
  const coverage = observability.call('readObservabilityCoverage', () => readObservabilityCoverage(projectDir));
  observability.call('readObservabilitySinkHealth', () => readObservabilitySinkHealth(projectDir));
  const reportText = await observability.call('handleReportCommand', () => handleReportCommand(projectDir, ['--json', '--task', 'issue-2487-observability']));
  const reportJsonStart = reportText.indexOf('[REPORT_JSON]') + '[REPORT_JSON]'.length;
  const reportJsonEnd = reportText.indexOf('[/REPORT_JSON]');
  const report = JSON.parse(reportText.slice(reportJsonStart, reportJsonEnd));
  const partitions = [
    { id: projectSchema.id, invokedApis: projectSchema.invokedApis, evidence: { tables: schemaTables(), projectConstraint: projectDb.query("SELECT COUNT(*) AS count FROM project_constraints").get()?.count ?? 0 } },
    { id: qaProfile.id, invokedApis: qaProfile.invokedApis, evidence: { planId: profile?.plan_id ?? null, finalCouncil: profile?.gates.final_council ?? null } },
    { id: checkpointReceipt.id, invokedApis: checkpointReceipt.invokedApis, evidence: { taskId: receipt?.task_id ?? null, generation: receipt?.generation ?? null } },
    { id: legacyImports.id, invokedApis: legacyImports.invokedApis, evidence: { pending: countPendingInsightCandidatesDb(projectDir), consumed: 0, phasePayload } },
    { id: coordination.id, invokedApis: coordination.invokedApis, evidence: { outcome: state ? 'applied' : null, status: state?.status ?? null, lease: lease ? 'acquired' : null, importMarkerPresent: importResult === 'already_imported' } },
    { id: observability.id, invokedApis: observability.invokedApis, evidence: { queryRows: query.rows.length, legacyEvents: legacyEvents.length, importedRows: coverage?.importedRows ?? 0, coverageRows: coverage?.totalRows ?? 0, costDelegations: costSummary.delegations, costGateRows: costSummary.by_gate.length, costsHasJson: costsJson.includes('[COSTS_JSON]'), reportRows: report.timeline.length } },
    { id: planLedger.id, invokedApis: planLedger.invokedApis, evidence: { count: ledgerRead.events.length, firstSeq: ledgerRead.events[0]?.seq ?? null, lastSeq: ledgerRead.events.at(-1)?.seq ?? null } },
  ];
  const evidence = {
    tables: schemaTables(),
    partitions,
  };
  projectSchema.call('closeProjectDb', () => closeProjectDb(projectDir));
  writeEvidence(evidence);
} else if (operation === 'cross-write-read') {
  db.run("INSERT INTO project_constraints (constraint_type, content) VALUES (?, ?)", ['issue-2487-cross-runtime', 'stable-cross-runtime-row']);
  closeProjectDb(projectDir);
  const reopened = getProjectDb(projectDir);
  const row = reopened.query("SELECT constraint_type, content FROM project_constraints WHERE constraint_type = ? ORDER BY id DESC LIMIT 1").get('issue-2487-cross-runtime');
  const tables = reopened.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY name").all().map((item) => item.name);
  writeEvidence({ content: row?.content ?? null, constraintType: row?.constraint_type ?? null, tables });
} else if (operation === 'read') {
  const row = db.query("SELECT constraint_type, content FROM project_constraints WHERE constraint_type = ? ORDER BY id DESC LIMIT 1").get('issue-2487-cross-runtime');
  const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY name").all().map((item) => item.name);
  writeEvidence({ content: row?.content ?? null, constraintType: row?.constraint_type ?? null, tables });
} else if (operation === 'crash-window') {
  db.run('BEGIN IMMEDIATE');
  db.run("INSERT INTO project_constraints (constraint_type, content) VALUES (?, ?)", ['issue-2487-crash-window', 'must-rollback-after-kill']);
  writeEvidence({ started: true });
  process.kill(process.pid, 'SIGKILL');
} else if (operation === 'recovery') {
  db.run('BEGIN IMMEDIATE');
  db.run("INSERT INTO project_constraints (constraint_type, content) VALUES (?, ?)", ['issue-2487-transaction', 'must-rollback']);
  db.run('ROLLBACK');
  const transactionRow = db.query("SELECT COUNT(*) AS count FROM project_constraints WHERE constraint_type = ?").get('issue-2487-transaction');
  const crashRow = db.query("SELECT COUNT(*) AS count FROM project_constraints WHERE constraint_type = ?").get('issue-2487-crash-window');
  const dbPath = join(projectDir, '.swarm', 'swarm.db');
  db.run('DROP TABLE plan_ledger_import');
  db.run("CREATE TABLE plan_ledger_import (source TEXT PRIMARY KEY, archive_path TEXT, archive_hash TEXT, archive_size INTEGER, archive_created_at TEXT, mode TEXT NOT NULL, version TEXT, row_count INTEGER NOT NULL DEFAULT 0 CHECK(row_count >= 0), imported_at TEXT NOT NULL DEFAULT (datetime('now')))");
  db.run('DELETE FROM schema_migrations WHERE version >= 36');
  closeProjectDb(projectDir);
  let migrationFailed = false;
  try { getProjectDb(projectDir); } catch { migrationFailed = true; }
  const failure = withProjectDbReadOnly(projectDir, (readonlyDb) => ({
    count: readonlyDb.query("SELECT COUNT(*) AS count FROM migration_failures WHERE version = 37").get()?.count ?? 0,
    schemaVersion: readonlyDb.query('SELECT MAX(version) AS version FROM schema_migrations').get()?.version ?? null,
  }));
  const Db = loadDatabaseCtor();
  const repair = new Db(dbPath);
  repair.run('DROP TABLE plan_ledger_import');
  repair.run("CREATE TABLE plan_ledger_import (source TEXT PRIMARY KEY, source_hash TEXT NOT NULL, archive_path TEXT, archive_hash TEXT, archive_size INTEGER, archive_created_at TEXT, mode TEXT NOT NULL, version TEXT, row_count INTEGER NOT NULL DEFAULT 0 CHECK(row_count >= 0), imported_at TEXT NOT NULL DEFAULT (datetime('now')))");
  repair.run('DELETE FROM schema_migrations WHERE version >= 36');
  repair.close();
  const retried = getProjectDb(projectDir);
  const retryVersion = retried.query('SELECT MAX(version) AS version FROM schema_migrations').get()?.version ?? null;
  const retryIndex = retried.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_plan_ledger_import_hash'").get()?.count ?? 0;
  writeEvidence({
    crashRowAbsent: Number(crashRow?.count ?? 0) === 0,
    migrationFailureRecorded: migrationFailed && Number(failure?.count ?? 0) === 1,
    migrationRolledBackTo: failure?.schemaVersion ?? null,
    migrationRetriedTo: retryVersion,
    migrationRollbackIndexRestored: Number(retryIndex) === 1,
    transactionRowAbsent: Number(transactionRow?.count ?? 0) === 0,
  });
} else if (operation === 'seed-archive') {
  db.run("INSERT INTO project_constraints (constraint_type, content) VALUES (?, ?)", ['issue-2487-archive', 'archive-restore-row']);
  closeProjectDb(projectDir);
  const archiveDir = join(projectDir, '.swarm', 'archive-copy');
  mkdirSync(archiveDir, { recursive: true });
  const archive = await archiveSqliteSnapshot({ sourcePath: join(projectDir, '.swarm', 'swarm.db'), destDir: archiveDir, destName: 'swarm.db' });
  if (archive.attempt !== 'succeeded' || archive.validation !== 'passed' || !archive.destPath) throw new Error('production archive snapshot did not succeed');
  writeEvidence({ method: archive.method, restoredSource: archive.source_disposition, seeded: true });
} else if (operation === 'read-archive') {
  const row = db.query("SELECT content FROM project_constraints WHERE constraint_type = ? ORDER BY id DESC LIMIT 1").get('issue-2487-archive');
  writeEvidence({ restoredContent: row?.content ?? null });
} else if (operation === 'policy-recovery') {
  await writePolicyRecoveryWitnesses();
  closeProjectDb(projectDir);
  const archiveDir = join(projectDir, '.swarm', 'policy-archive');
  mkdirSync(archiveDir, { recursive: true });
  const sourcePath = join(projectDir, '.swarm', 'swarm.db');
  const archive = await archiveSqliteSnapshot({ sourcePath, destDir: archiveDir, destName: 'swarm.db' });
  if (archive.attempt !== 'succeeded' || archive.validation !== 'passed' || !archive.destPath) throw new Error('always-on archive rollback failed');
  rmSync(sourcePath);
  copyFileSync(archive.destPath, sourcePath);
  const reopened = getProjectDb(projectDir);
  const row = reopened.query("SELECT content FROM project_constraints WHERE constraint_type = ? ORDER BY id DESC LIMIT 1").get('issue-2487-policy');
  const witnesses = readPolicyRecoveryWitnesses(reopened);
  const partitionContract = Array.isArray(operationData) ? operationData : [];
  const tableCounts = (tables) => Object.fromEntries(tables.map((table) => [table, Number(reopened.query('SELECT COUNT(*) AS count FROM "' + table + '"').get()?.count ?? 0)]));
  const partitions = partitionContract.map((partition) => ({
    id: partition.id,
    tables: [...partition.tables],
    evidence: {
      recovered: true,
      tableCounts: tableCounts(partition.tables),
      witness: witnesses[partition.id] ?? { restored: false, marker: policyWitnessMarker(partition.id) },
    },
  }));
  writeEvidence({ archiveMethod: archive.method, recoveryContent: row?.content ?? null, rollbackRestored: row?.content === 'always-on-recovery-row', tables: schemaTables(), partitions });
} else if (operation === 'legacy-import') {
  initTelemetry(projectDir);
  const legacyPath = join(projectDir, '.swarm', 'telemetry.jsonl');
  writeFileSync(legacyPath, JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', event: 'delegation_begin', sessionId: 'issue-2487-legacy-session', taskId: 'issue-2487-legacy-task', legacyMarker: 'legacy-import-production' }) + '\\n', 'utf8');
  const imported = syncObservabilityImport(projectDir);
  const result = queryObservabilityEvents(projectDir, { taskId: 'issue-2487-legacy-task' });
  const row = result.rows[0];
  const payload = row ? JSON.parse(row.payload_json) : null;
  writeEvidence({ imported: imported.imported, ingestedVia: row?.ingested_via ?? null, marker: payload?.legacyMarker ?? null, taskId: row?.task_id ?? null, reportRows: result.rows.length });
  resetTelemetryForTesting();
} else if (operation === 'field-scale') {
  initTelemetry(projectDir);
  registerObservabilityEventSink(projectDir);
  const sessionId = 'issue-2487-field-scale-session';
  const total = Math.ceil((MAX_OBSERVABILITY_EVENT_ROWS + 1) / RETENTION_CHECK_INTERVAL) * RETENTION_CHECK_INTERVAL;
  for (let index = 0; index < total; index += 1) {
    const taskId = 'issue-2487-field-' + String(index).padStart(5, '0');
    emit('delegation_begin', { sessionId, taskId, laneId: 'issue-2487-lane', batchId: 'issue-2487-batch', phase: 1, agentName: 'qualification', payloadMarker: 'payload-' + String(index).padStart(5, '0') });
  }
  await flushAndDrainTelemetry();
  const firstTask = 'issue-2487-field-' + String(total - MAX_OBSERVABILITY_EVENT_ROWS).padStart(5, '0');
  const lastTask = 'issue-2487-field-' + String(total - 1).padStart(5, '0');
  const reportFirst = queryObservabilityEvents(projectDir, { taskId: firstTask });
  const reportLast = queryObservabilityEvents(projectDir, { taskId: lastTask });
  const coverage = readObservabilityCoverage(projectDir);
  const health = readObservabilitySinkHealth(projectDir);
  const stored = getProjectDb(projectDir).query("SELECT rowid, kind, host_session_id, task_id, lane_id, batch_id, phase_id, payload_json, relationship_violations, ingested_via FROM observability_event WHERE task_id IN (?, ?) ORDER BY rowid ASC").all(firstTask, lastTask);
  const survivorRows = getProjectDb(projectDir).query("SELECT kind, host_session_id, task_id, lane_id, batch_id, phase_id, payload_json, relationship_violations, ingested_via FROM observability_event ORDER BY rowid ASC").all();
  const survivorRecord = (row) => ({ kind: row.kind, session: row.host_session_id, taskId: row.task_id, lane: row.lane_id, batch: row.batch_id, phase: row.phase_id, payloadMarker: JSON.parse(row.payload_json).payloadMarker, relationshipViolations: row.relationship_violations, ingestedVia: row.ingested_via });
  const survivorHash = (records) => { const hash = createHash('sha256'); for (const record of records) hash.update(JSON.stringify(record) + String.fromCharCode(10), 'utf8'); return hash.digest('hex'); };
  const actualSurvivors = survivorRows.map(survivorRecord);
  const expectedSurvivors = Array.from({ length: MAX_OBSERVABILITY_EVENT_ROWS }, (_, offset) => { const index = total - MAX_OBSERVABILITY_EVENT_ROWS + offset; const padded = String(index).padStart(5, '0'); return { kind: 'delegation_begin', session: sessionId, taskId: 'issue-2487-field-' + padded, lane: 'issue-2487-lane', batch: 'issue-2487-batch', phase: '1', payloadMarker: 'payload-' + padded, relationshipViolations: null, ingestedVia: 'live' }; });
  const actualSurvivorHash = survivorHash(actualSurvivors);
  const expectedSurvivorHash = survivorHash(expectedSurvivors);
  const evidence = { count: coverage?.totalRows ?? 0, expectedCount: MAX_OBSERVABILITY_EVENT_ROWS, first: stored[0] ?? null, last: stored[1] ?? null, firstReportRows: reportFirst.rows.length, lastReportRows: reportLast.rows.length, accepted: health?.accepted ?? 0 };
  if (evidence.count !== MAX_OBSERVABILITY_EVENT_ROWS || evidence.first?.task_id !== firstTask || evidence.last?.task_id !== lastTask || evidence.first?.relationship_violations !== null || evidence.last?.relationship_violations !== null || evidence.firstReportRows !== 1 || evidence.lastReportRows !== 1 || actualSurvivors.length !== MAX_OBSERVABILITY_EVENT_ROWS || actualSurvivorHash !== expectedSurvivorHash) throw new Error('observability retention survivor mismatch: ' + JSON.stringify({ ...evidence, actualSurvivorHash, expectedSurvivorHash, actualSurvivorRows: actualSurvivors.length }));
  const canonicalEvidence = { count: evidence.count, expectedCount: evidence.expectedCount, firstTask: evidence.first?.task_id, lastTask: evidence.last?.task_id, firstPayload: JSON.parse(evidence.first?.payload_json ?? '{}').payloadMarker, lastPayload: JSON.parse(evidence.last?.payload_json ?? '{}').payloadMarker, firstKind: evidence.first?.kind, lastKind: evidence.last?.kind, session: evidence.first?.host_session_id, lane: evidence.first?.lane_id, batch: evidence.first?.batch_id, phase: evidence.first?.phase_id, ingestedVia: evidence.first?.ingested_via, orderPreserved: Number(evidence.first?.rowid ?? 0) < Number(evidence.last?.rowid ?? 0) };
  resetObservabilityEventSinkForTesting();
  resetTelemetryForTesting();
  closeProjectDb(projectDir);
  writeEvidence({ ...canonicalEvidence, expectedFirstTask: firstTask, expectedLastTask: lastTask, accepted: evidence.accepted, canonicalHash: createHash('sha256').update(canonical(canonicalEvidence)).digest('hex'), survivorRowsHashed: actualSurvivors.length, survivorHash: actualSurvivorHash, expectedSurvivorHash });
} else {
  throw new Error('unknown qualification operation: ' + operation + ' (' + runtime + ')');
}
`;
}

async function runFixture({ runtime, modulePath, projectDir, operation, evidencePath, allowKilled = false, operationData }) {
	const fixtureRoot = mkdtempSync(join(tmpdir(), 'issue-2487-fixture-'));
	const fixturePath = join(fixtureRoot, 'fixture.mjs');
	try {
		writeFileSync(fixturePath, fixtureSource(pathToFileURL(modulePath).href), 'utf8');
		const command = runtime === 'node' ? process.execPath : bunExecutable();
		const args = [fixturePath, projectDir, evidencePath, operation, runtime];
		if (operationData !== undefined) args.push(JSON.stringify(operationData));
		const result = await runProcess(command, args);
		if (result.code !== 0 && !allowKilled) {
			throw new Error(`${runtime}/${operation} exited ${result.code}${result.timedOut ? ' (timeout)' : ''}: ${result.stderr.slice(-2000)}`);
		}
		if (allowKilled && result.code === 0) throw new Error(`${runtime}/${operation} unexpectedly survived the crash-window kill`);
		return result;
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
}

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
	return value;
}

function assertEqualEvidence(leftPath, rightPath, label) {
	const comparable = (value) => ({
		...value,
		partitions: value.partitions?.map((partition) => {
			const { invokedApis, ...parity } = partition;
			return parity;
		}),
	});
	const left = JSON.stringify(canonical(comparable(JSON.parse(readFileSync(leftPath, 'utf8')))));
	const right = JSON.stringify(canonical(comparable(JSON.parse(readFileSync(rightPath, 'utf8')))));
	if (left !== right) throw new Error(`${label} canonical evidence differs: ${left} !== ${right}`);
}

export function collectPartitionEvidenceErrors(actual, expected) {
	const errors = [];
	if (!actual || !Array.isArray(actual.partitions)) return ['partition evidence is missing'];
	const rows = new Map();
	for (const row of actual.partitions) {
		if (!row || typeof row.id !== 'string') {
			errors.push('partition evidence contains a row without an id');
			continue;
		}
		if (rows.has(row.id)) errors.push(`duplicate partition evidence: ${row.id}`);
		rows.set(row.id, row);
		if (!Array.isArray(row.invokedApis)) errors.push(`${row.id}: invokedApis evidence is missing`);
		if (!row.evidence || typeof row.evidence !== 'object') errors.push(`${row.id}: partition evidence payload is missing`);
	}
	for (const partition of expected) {
		const row = rows.get(partition.id);
		if (!row) {
			errors.push(`missing partition evidence: ${partition.id}`);
			continue;
		}
		const invoked = new Set(row.invokedApis ?? []);
		for (const api of partition.productionApis) {
			if (!invoked.has(api)) errors.push(`${partition.id}: production API was not invoked: ${api}`);
		}
		if (Object.keys(row.evidence ?? {}).length === 0) errors.push(`${partition.id}: evidence is vacuous`);
	}
	for (const id of rows.keys()) {
		if (!expected.some((partition) => partition.id === id)) errors.push(`unexpected partition evidence: ${id}`);
	}
	return errors;
}

export function collectPartitionRecoveryEvidenceErrors(actual, expected) {
	const errors = [];
	if (!actual || !Array.isArray(actual.partitions)) return ['partition recovery evidence is missing'];
	const rows = new Map();
	for (const row of actual.partitions) {
		if (!row || typeof row.id !== 'string') {
			errors.push('partition recovery evidence contains a row without an id');
			continue;
		}
		if (rows.has(row.id)) errors.push(`duplicate partition recovery evidence: ${row.id}`);
		rows.set(row.id, row);
	}
	const expectedTables = new Set(expected.flatMap((partition) => partition.tables));
	const actualTables = new Set(actual.tables ?? []);
	if (actualTables.size !== expectedTables.size || [...expectedTables].some((table) => !actualTables.has(table))) {
		errors.push(`partition recovery table catalog is incomplete: expected ${expectedTables.size}, got ${actualTables.size}`);
	}
	for (const partition of expected) {
		const row = rows.get(partition.id);
		if (!row) {
			errors.push(`missing partition recovery evidence: ${partition.id}`);
			continue;
		}
		if (!Array.isArray(row.tables) || row.tables.length !== partition.tables.length || partition.tables.some((table) => !row.tables.includes(table))) {
			errors.push(`${partition.id}: recovered table assertion is incomplete`);
		}
		if (row.evidence?.recovered !== true) errors.push(`${partition.id}: recovery assertion is missing`);
		const tableCounts = row.evidence?.tableCounts;
		if (!tableCounts || typeof tableCounts !== 'object' || partition.tables.some((table) => !Number.isInteger(tableCounts[table]) || tableCounts[table] < 0)) {
			errors.push(`${partition.id}: recovered table counts are missing`);
		}
		const witness = row.evidence?.witness;
		if (witness?.restored !== true || witness?.marker !== `issue-2487-policy:${partition.id}`) {
			errors.push(`${partition.id}: recovered production witness is missing`);
		}
	}
	for (const id of rows.keys()) {
		if (!expected.some((partition) => partition.id === id)) errors.push(`unexpected partition recovery evidence: ${id}`);
	}
	return errors;
}

async function readPartitionContract() {
	const result = await runProcess(bunExecutable(), ['run', 'scripts/check-issue-2487-compatibility.ts', '--partition-contract']);
	if (result.code !== 0) throw new Error(`could not enumerate partition contract: ${result.stderr.slice(-2000)}`);
	return JSON.parse(result.stdout.trim());
}

async function runPartitionSemanticTests() {
	const listed = await runProcess(bunExecutable(), ['run', 'scripts/check-issue-2487-compatibility.ts', '--semantic-tests']);
	if (listed.code !== 0) throw new Error(`could not enumerate partition semantic tests: ${listed.stderr.slice(-2000)}`);
	const paths = listed.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
	if (paths.length === 0) throw new Error('compatibility registry supplied no semantic test paths');
	for (const testPath of paths) {
		const result = await runProcess(bunExecutable(), ['--smol', 'test', testPath, '--timeout', '60000']);
		if (result.code !== 0) throw new Error(`partition semantic test failed: ${testPath}: ${result.stderr.slice(-2000)}${result.stdout.slice(-2000)}`);
	}
	console.log(`cross-runtime semantic suites passed: ${paths.length} isolated table-family tests`);
}

async function crossRuntime() {
	const projectDir = mkdtempSync(join(tmpdir(), 'issue-2487-cross-'));
	const reverseProjectDir = mkdtempSync(join(tmpdir(), 'issue-2487-cross-reverse-'));
	const evidenceDir = mkdtempSync(join(tmpdir(), 'issue-2487-cross-evidence-'));
	try {
		const bunEvidence = join(evidenceDir, 'bun.json');
		const nodeEvidence = join(evidenceDir, 'node.json');
		await runFixture({ runtime: 'bun', modulePath: join(REPO_ROOT, 'dist-build-test', 'repro-2487', 'bun', 'repro-2487-entry.js'), projectDir, operation: 'production-write', evidencePath: bunEvidence });
		await runFixture({ runtime: 'node', modulePath: join(REPO_ROOT, 'dist-build-test', 'repro-2487', 'node', 'repro-2487-entry.js'), projectDir, operation: 'production-read', evidencePath: nodeEvidence });
		assertEqualEvidence(bunEvidence, nodeEvidence, 'cross-runtime');
		const nodeWriteEvidence = join(evidenceDir, 'node-write.json');
		const bunReadEvidence = join(evidenceDir, 'bun-read.json');
		await runFixture({ runtime: 'node', modulePath: join(REPO_ROOT, 'dist-build-test', 'repro-2487', 'node', 'repro-2487-entry.js'), projectDir: reverseProjectDir, operation: 'production-write', evidencePath: nodeWriteEvidence });
		await runFixture({ runtime: 'bun', modulePath: join(REPO_ROOT, 'dist-build-test', 'repro-2487', 'bun', 'repro-2487-entry.js'), projectDir: reverseProjectDir, operation: 'production-read', evidencePath: bunReadEvidence });
		assertEqualEvidence(nodeWriteEvidence, bunReadEvidence, 'reverse cross-runtime');
		const evidence = JSON.parse(readFileSync(bunEvidence, 'utf8'));
		const reverseEvidence = JSON.parse(readFileSync(nodeWriteEvidence, 'utf8'));
		if (evidence.tables.length !== 18) throw new Error(`cross-runtime schema catalog is incomplete: ${evidence.tables.length}`);
		if (reverseEvidence.tables.length !== 18) throw new Error(`reverse cross-runtime schema catalog is incomplete: ${reverseEvidence.tables.length}`);
		const partitionContract = await readPartitionContract();
		const partitionErrors = collectPartitionEvidenceErrors(evidence, partitionContract);
		const reversePartitionErrors = collectPartitionEvidenceErrors(reverseEvidence, partitionContract);
		if (partitionErrors.length > 0) throw new Error(`cross-runtime partition evidence is incomplete: ${partitionErrors.join('; ')}`);
		if (reversePartitionErrors.length > 0) throw new Error(`reverse cross-runtime partition evidence is incomplete: ${reversePartitionErrors.join('; ')}`);
		const representativeCount = evidence.partitions.length;
		await runPartitionSemanticTests();
		console.log(`scenario cross-runtime passed: Bun→Node and Node→Bun close-reopen matched ${evidence.tables.length} migrated SQLite tables through ${representativeCount} production API partitions`);
	} finally {
		rmSync(projectDir, { recursive: true, force: true });
		rmSync(reverseProjectDir, { recursive: true, force: true });
		rmSync(evidenceDir, { recursive: true, force: true });
	}
}

async function recovery() {
	const projectDir = mkdtempSync(join(tmpdir(), 'issue-2487-recovery-'));
	const crashEvidencePath = join(projectDir, 'crash.json');
	const evidencePath = join(projectDir, 'recovery.json');
	try {
		await runFixture({ runtime: 'node', modulePath: join(REPO_ROOT, 'dist-build-test', 'repro-2487', 'node', 'repro-2487-entry.js'), projectDir, operation: 'crash-window', evidencePath: crashEvidencePath, allowKilled: true });
		if (!readFileSync(crashEvidencePath, 'utf8').includes('started')) throw new Error('crash-window child did not reach its kill point');
		await runFixture({ runtime: 'node', modulePath: join(REPO_ROOT, 'dist-build-test', 'repro-2487', 'node', 'repro-2487-entry.js'), projectDir, operation: 'recovery', evidencePath });
		const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
		if (!evidence.crashRowAbsent || !evidence.transactionRowAbsent || !evidence.migrationFailureRecorded || evidence.migrationRolledBackTo !== 36 || evidence.migrationRetriedTo !== 37 || !evidence.migrationRollbackIndexRestored) throw new Error(`recovery evidence invalid: ${JSON.stringify(evidence)}`);
		console.log('scenario recovery passed: killed transaction, explicit rollback, and migration rollback/retry all preserved recovery evidence');
	} finally {
		rmSync(projectDir, { recursive: true, force: true });
	}
}

async function archiveRestore() {
	const projectDir = mkdtempSync(join(tmpdir(), 'issue-2487-archive-'));
	const evidencePath = join(projectDir, 'archive.json');
	try {
		await runFixture({ runtime: 'node', modulePath: join(REPO_ROOT, 'dist-build-test', 'repro-2487', 'node', 'repro-2487-entry.js'), projectDir, operation: 'seed-archive', evidencePath });
		const archiveEvidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
		if (archiveEvidence.method !== 'vacuum_into' || archiveEvidence.seeded !== true) throw new Error(`production archive evidence invalid: ${JSON.stringify(archiveEvidence)}`);
		const sourceDb = join(projectDir, '.swarm', 'swarm.db');
		const archiveDb = join(projectDir, '.swarm', 'archive-copy', 'swarm.db');
		rmSync(sourceDb);
		cpSync(archiveDb, sourceDb);
		await runFixture({ runtime: 'node', modulePath: join(REPO_ROOT, 'dist-build-test', 'repro-2487', 'node', 'repro-2487-entry.js'), projectDir, operation: 'read-archive', evidencePath });
		if (!readFileSync(evidencePath, 'utf8').includes('archive-restore-row')) throw new Error('archive restore evidence missing row');
		console.log('scenario archive-restore passed: archiveSqliteSnapshot/VACUUM INTO output restored through production getProjectDb');
	} finally {
		rmSync(projectDir, { recursive: true, force: true });
	}
}

async function killSwitches() {
	const projectDir = mkdtempSync(join(tmpdir(), 'issue-2487-policy-'));
	const seedEvidencePath = join(projectDir, 'seed.json');
	const evidencePath = join(projectDir, 'policy.json');
	try {
		const partitionContract = await readPartitionContract();
		await runFixture({ runtime: 'node', modulePath: join(REPO_ROOT, 'dist-build-test', 'repro-2487', 'node', 'repro-2487-entry.js'), projectDir, operation: 'production-write', evidencePath: seedEvidencePath });
		await runFixture({ runtime: 'node', modulePath: join(REPO_ROOT, 'dist-build-test', 'repro-2487', 'node', 'repro-2487-entry.js'), projectDir, operation: 'policy-recovery', evidencePath, operationData: partitionContract });
		const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
		const partitionErrors = collectPartitionRecoveryEvidenceErrors(evidence, partitionContract);
    if (partitionErrors.length > 0) throw new Error(`always-on policy partition evidence invalid: ${partitionErrors.join('; ')}`);
		if (evidence.archiveMethod !== 'vacuum_into' || evidence.rollbackRestored !== true) throw new Error(`always-on policy evidence invalid: ${JSON.stringify(evidence)}`);
		console.log(`scenario kill-switches passed: always-on getProjectDb/closeProjectDb/archiveSqliteSnapshot recovery restored ${partitionContract.length} partitions and ${evidence.tables.length} canonical tables`);
	} finally {
		rmSync(projectDir, { recursive: true, force: true });
	}
}

async function reachability() {
	const projectDir = mkdtempSync(join(tmpdir(), 'issue-2487-reachability-'));
	const evidencePath = join(projectDir, 'legacy.json');
	try {
		await runFixture({ runtime: 'node', modulePath: join(REPO_ROOT, 'dist-build-test', 'repro-2487', 'node', 'repro-2487-entry.js'), projectDir, operation: 'legacy-import', evidencePath });
		const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
		if (evidence.imported !== 1 || evidence.ingestedVia !== 'import' || evidence.marker !== 'legacy-import-production' || evidence.reportRows !== 1) throw new Error(`legacy reachability evidence invalid: ${JSON.stringify(evidence)}`);
		await runCompatibilityScenario('reachability');
		console.log('scenario reachability passed: production legacy telemetry import joined report identity and validator source reachability');
	} finally {
		rmSync(projectDir, { recursive: true, force: true });
	}
}

async function fieldScale() {
	const projectDir = mkdtempSync(join(tmpdir(), 'issue-2487-field-scale-'));
	const evidencePath = join(projectDir, 'field-scale.json');
	try {
		await runFixture({ runtime: 'node', modulePath: join(REPO_ROOT, 'dist-build-test', 'repro-2487', 'node', 'repro-2487-entry.js'), projectDir, operation: 'field-scale', evidencePath });
		const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
		if (evidence.count !== evidence.expectedCount || evidence.expectedCount !== 50000 || evidence.firstTask !== evidence.expectedFirstTask || evidence.lastTask !== evidence.expectedLastTask || !evidence.canonicalHash || evidence.orderPreserved !== true || evidence.survivorRowsHashed !== evidence.expectedCount || evidence.survivorHash !== evidence.expectedSurvivorHash) throw new Error(`field-scale evidence invalid: ${JSON.stringify(evidence)}`);
		console.log(`scenario field-scale passed: ${evidence.count} observability rows retained with full ordered survivor hash ${evidence.survivorHash}`);
	} finally {
		rmSync(projectDir, { recursive: true, force: true });
	}
}

async function runCompatibilityScenario(name) {
	const result = await runProcess(bunExecutable(), ['run', 'scripts/check-issue-2487-compatibility.ts', REPO_ROOT]);
	if (result.code !== 0) throw new Error(`compatibility validator failed: ${result.stderr.slice(-2000)}${result.stdout.slice(-2000)}`);
	console.log(`scenario ${name} passed: ${result.stdout.trim()}`);
}

async function main() {
	const scenarioIndex = process.argv.indexOf('--scenario');
	const requested = scenarioIndex >= 0 ? process.argv[scenarioIndex + 1] : 'all';
	const selected = requested === 'all' ? SCENARIOS : [requested];
	if (selected.some((name) => !SCENARIOS.includes(name))) throw new Error(`unknown scenario: ${requested}`);
	const nodeBundle = join(REPO_ROOT, 'dist-build-test', 'repro-2487', 'node', 'repro-2487-entry.js');
	const bunBundle = join(REPO_ROOT, 'dist-build-test', 'repro-2487', 'bun', 'repro-2487-entry.js');
	for (const name of selected) {
		if (!existsSync(nodeBundle) || !existsSync(bunBundle)) {
			throw new Error('missing repro:2487 Bun/Node bundles; run the package repro:2487 build first');
		}
		if (name === 'cross-runtime') await crossRuntime();
		else if (name === 'recovery') await recovery();
		else if (name === 'archive-restore') await archiveRestore();
		else if (name === 'kill-switches') await killSwitches();
		else if (name === 'reachability') await reachability();
		else if (name === 'field-scale') await fieldScale();
	}
	console.log(`ISSUE-2487 QUALIFICATION PASS: ${selected.length} scenario(s)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(`ISSUE-2487 QUALIFICATION FAIL: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
}
