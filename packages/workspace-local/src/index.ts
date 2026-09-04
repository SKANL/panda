export {
  LOCAL_WORKSPACE_RECORD_FILE,
  LocalWorkspaceProvider,
  type LocalWorkspaceProviderOptions,
  type LocalWorkspaceRecord,
} from './local-workspace-provider.ts'
// Taking back a workspace panda made, beside the provider that makes one (spec
// M27.A). Free functions rather than a port method, for the reason D1 states:
// a `remove()` on `WorkspaceProvider` would either be so under-specified that
// its clause could only assert "it resolved", or it would force every
// third-party implementer to build a destructive method to pass conformance.
//
// `WORKSPACE_ID_PATTERN` and `WINDOWS_RESERVED_IDS` are exported from the
// provider module for `removal.ts` and are deliberately NOT re-exported here:
// they are how this package agrees with itself about what an id is, not a
// surface a consumer routes on.
export {
  inspectLocalWorkspaces,
  removeLocalWorkspace,
  type ClaimedLocalWorkspace,
  type InspectLocalWorkspacesOptions,
  type LocalWorkspaceInspection,
  type LocalWorkspaceOutcome,
  type LocalWorkspaceOutcomeKind,
  type UnclaimedLocalDirectory,
} from './removal.ts'
export {
  WORKSPACE_CONFIG_KEY,
  WORKSPACE_CONFIG_WARNING_EVENT,
  WORKSPACE_PLUGIN_ID,
  WORKSPACE_SERVICE,
  createWorkspacePlugin,
  type WorkspaceConfigWarning,
  type WorkspacePlugin,
  type WorkspacePluginOptions,
} from './plugin.ts'
