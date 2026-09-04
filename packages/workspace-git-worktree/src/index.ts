export {
  GitWorktreeWorkspaceProvider,
  inspectWorktrees,
  removeWorktree,
  type ClaimedWorktree,
  type GitWorktreeWorkspaceProviderOptions,
  type InterruptedRemoval,
  type UnclaimedDirectory,
  type WorktreeInspection,
  type WorktreeOutcome,
  type WorktreeOutcomeKind,
} from './git-worktree-provider.ts'
export { WorktreeLedger, type WorktreeRecord, type WorktreeRemovalIntent } from './ledger.ts'
export {
  WORKSPACE_CONFIG_KEY,
  WORKSPACE_PLUGIN_ID,
  WORKSPACE_CONFIG_WARNING_EVENT,
  WORKSPACE_SERVICE,
  createGitWorktreeWorkspacePlugin,
  type GitWorktreeWorkspacePluginOptions,
  type WorkspaceConfigWarning,
  type WorkspacePlugin,
} from './plugin.ts'
