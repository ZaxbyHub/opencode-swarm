import type { MemoryKind, MemoryRecord, MemoryScopeRef, MemorySource, RecallMode } from './types';
export type RecallEvaluationProviderName = 'local-jsonl' | 'sqlite';
export type RecallEvaluationMode = Extract<RecallMode, 'manual' | 'injection' | 'curator'>;
export interface RecallEvaluationOptions {
    fixtureDirectory: string;
    providers?: RecallEvaluationProviderName[];
    modes?: RecallEvaluationMode[];
    keepTempRoots?: boolean;
}
export interface RecallEvaluationMetrics {
    'precision@k': number;
    'recall@k': number;
    injection_count: number;
    noisy_injection_count: number;
    same_scope_noise_count: number;
    cross_scope_leak_count: number;
    stale_memory_count: number;
}
export interface RecallEvaluationRun {
    fixture: string;
    provider: RecallEvaluationProviderName;
    mode: RecallEvaluationMode;
    k: number;
    query: string;
    expected_labels: string[];
    expected_ids: string[];
    retrieved_labels: string[];
    retrieved_ids: string[];
    metrics: RecallEvaluationMetrics;
    passed: boolean;
}
export interface RecallEvaluationReport {
    schema_version: 1;
    generated_at: string;
    fixture_directory: string;
    providers: RecallEvaluationProviderName[];
    modes: RecallEvaluationMode[];
    summary: RecallEvaluationMetrics & {
        fixture_count: number;
        run_count: number;
        passed_run_count: number;
    };
    runs: RecallEvaluationRun[];
}
type FixtureRecordState = {
    deleted?: boolean;
    supersededByLabel?: string;
    expiresAt?: string;
};
interface FixtureRecord {
    label: string;
    scope: MemoryScopeRef;
    kind: MemoryKind;
    text: string;
    tags?: string[];
    confidence?: number;
    stability?: MemoryRecord['stability'];
    source?: MemorySource;
    metadata?: Record<string, unknown>;
    state?: FixtureRecordState;
}
interface RecallEvaluationFixture {
    name: string;
    query: string;
    task?: string;
    agentRole?: string;
    scopes: MemoryScopeRef[];
    kinds?: MemoryKind[];
    maxItems?: number;
    tokenBudget?: number;
    k?: number;
    expectedLabels: string[];
    records: FixtureRecord[];
}
export declare function evaluateMemoryRecallFixtures(options: RecallEvaluationOptions): Promise<RecallEvaluationReport>;
export declare function loadRecallEvaluationFixtures(fixtureDirectory: string): Promise<RecallEvaluationFixture[]>;
export {};
