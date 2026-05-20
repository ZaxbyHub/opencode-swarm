import { COMMAND_REGISTRY } from './registry.js';

export type CommandName = keyof typeof COMMAND_REGISTRY;

export const COMMAND_NAMES: readonly CommandName[] = Object.freeze(
	Object.keys(COMMAND_REGISTRY) as CommandName[],
);

export const COMMAND_NAME_SET: ReadonlySet<CommandName> = new Set(
	COMMAND_NAMES,
);
