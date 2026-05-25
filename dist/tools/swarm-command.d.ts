import type { AgentDefinition } from '../agents/index.js';
import { createSwarmTool } from './create-tool.js';
export declare function createSwarmCommandTool(agents: Record<string, AgentDefinition>): ReturnType<typeof createSwarmTool>;
export declare const swarm_command: ReturnType<typeof createSwarmTool>;
