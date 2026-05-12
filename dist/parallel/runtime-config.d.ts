import type { PluginConfig } from '../config';
export type StandardParallelizationRuntimeConfig = {
    stageBParallelEnabled: boolean;
    taskFanoutEnabled: boolean;
    maxConcurrentTasks: number;
    maxConcurrentCoders: number;
    maxConcurrentStageBGroups: number;
    evidenceLockTimeoutMs: number;
    source: 'current-default' | 'global-config' | 'locked-profile';
};
export declare function resolveStandardParallelizationConfig(config: PluginConfig | undefined, directory: string): StandardParallelizationRuntimeConfig;
