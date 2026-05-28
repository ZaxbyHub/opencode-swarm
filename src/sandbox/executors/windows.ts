// Re-export bridge: executor.ts expects ./executors/windows
// Primary: native sandbox executor (tries runner binary, falls back to PowerShell)
export { NativeWindowsSandboxExecutor as WindowsSandboxExecutor } from '../win32/native-sandbox-executor';
// Legacy re-export for backwards compatibility
export { WindowsSandboxExecutor as LegacyWindowsSandboxExecutor } from '../win32/restricted-environment-executor';
