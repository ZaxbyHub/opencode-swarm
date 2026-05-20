import { COMMAND_REGISTRY } from './registry.js';
export type CommandName = keyof typeof COMMAND_REGISTRY;
export declare const COMMAND_NAMES: readonly CommandName[];
export declare const COMMAND_NAME_SET: ReadonlySet<CommandName>;
