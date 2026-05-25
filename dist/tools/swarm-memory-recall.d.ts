import { loadPluginConfigWithMeta } from '../config';
import { createMemoryGateway } from '../memory';
import { createSwarmTool } from './create-tool';
export declare const swarm_memory_recall: ReturnType<typeof createSwarmTool>;
export declare const _internals: {
    loadPluginConfigWithMeta: typeof loadPluginConfigWithMeta;
    createMemoryGateway: typeof createMemoryGateway;
};
