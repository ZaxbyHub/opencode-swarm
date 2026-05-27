import type { MemoryKind } from './types';
export interface MemoryConfig {
    enabled: boolean;
    provider: 'local-jsonl' | 'sqlite';
    storageDir: string;
    sqlite: {
        path: string;
        busyTimeoutMs: number;
    };
    recall: {
        defaultMaxItems: number;
        defaultTokenBudget: number;
        minScore: number;
        injection: {
            enabled: boolean;
            minScore: number;
            requireQuerySignal: boolean;
            maxItems: number;
            tokenBudget: number;
        };
    };
    writes: {
        mode: 'propose';
    };
    redaction: {
        rejectDurableSecrets: boolean;
    };
    maintenance: {
        lowUtilityMaxConfidence: number;
        lowUtilityMinAgeDays: number;
    };
    hardDelete: boolean;
}
export declare const DEFAULT_MEMORY_CONFIG: MemoryConfig;
export declare const DURABLE_MEMORY_KINDS: ReadonlySet<MemoryKind>;
export declare const EVIDENCE_REQUIRED_KINDS: ReadonlySet<MemoryKind>;
export declare function resolveMemoryConfig(input: Partial<MemoryConfig> | undefined): MemoryConfig;
