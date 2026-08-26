export const PANDA_ERROR_CODES = {
  kernelManifestInvalid: 'PANDA_KERNEL_MANIFEST_INVALID',
  kernelCycleDetected: 'PANDA_KERNEL_CYCLE_DETECTED',
  kernelServiceNotProvided: 'PANDA_KERNEL_SERVICE_NOT_PROVIDED',
  kernelServiceConflict: 'PANDA_KERNEL_SERVICE_CONFLICT',
  kernelPluginInactive: 'PANDA_KERNEL_PLUGIN_INACTIVE',
  kernelPluginStartFailed: 'PANDA_KERNEL_PLUGIN_START_FAILED',
  kernelSwapRejected: 'PANDA_KERNEL_SWAP_REJECTED',
  kernelReemitDuringFanout: 'PANDA_KERNEL_REEMIT_DURING_FANOUT',
  kernelInvalidScope: 'PANDA_KERNEL_INVALID_SCOPE',
  kernelInvalidLayer: 'PANDA_KERNEL_INVALID_LAYER',
  kernelLogRecordInvalid: 'PANDA_KERNEL_LOG_RECORD_INVALID',
  kernelActionInvalid: 'PANDA_KERNEL_ACTION_INVALID',
  kernelActionDenied: 'PANDA_KERNEL_ACTION_DENIED',
  kernelInvocationCapExceeded: 'PANDA_KERNEL_INVOCATION_CAP_EXCEEDED',
  kernelCostCapExceeded: 'PANDA_KERNEL_COST_CAP_EXCEEDED',
  kernelConcurrencyCapExceeded: 'PANDA_KERNEL_CONCURRENCY_CAP_EXCEEDED',
  kernelStageFailed: 'PANDA_KERNEL_STAGE_FAILED',
  contractEnvelopeInvalid: 'PANDA_CONTRACT_ENVELOPE_INVALID',
  contractWorkspaceUnknownId: 'PANDA_CONTRACT_WORKSPACE_UNKNOWN_ID',
  contractWorkspaceInvalidHandle: 'PANDA_CONTRACT_WORKSPACE_INVALID_HANDLE',
  contractWorkspaceDoubleRelease: 'PANDA_CONTRACT_WORKSPACE_DOUBLE_RELEASE',
  contractWorkspaceUnavailable: 'PANDA_CONTRACT_WORKSPACE_UNAVAILABLE',
  contractProviderDisposed: 'PANDA_CONTRACT_PROVIDER_DISPOSED',
  executorUnavailable: 'PANDA_EXECUTOR_UNAVAILABLE',
  executorRunFailed: 'PANDA_EXECUTOR_RUN_FAILED',
  executorCancelled: 'PANDA_EXECUTOR_CANCELLED',
  // Panda ships no adapter under the name that was asked for. Deliberately NOT
  // `executorUnavailable`: that one means the binary did not spawn, and the two
  // have different fixes — use a name panda has versus install the tool. A
  // selection that failed because the name was wrong must never be reported as
  // a missing installation, or the user goes looking for the wrong problem.
  executorNotFound: 'PANDA_EXECUTOR_NOT_FOUND',
  // Panda's OWN configuration document exists and cannot be used: unreadable,
  // not valid JSON, not an object, or holding a value of the wrong type. Coded,
  // and separate from `executorNotFound`, because the fix is different again
  // (repair the file versus correct the name) — and separate from the layered
  // config's own `PANDA_KERNEL_INVALID_LAYER`, which is what rejects a hostile
  // key once the document has parsed.
  //
  // A document that is ABSENT is not this: it is a layer panda does not have.
  // Falling back to the default because a configuration could not be read is the
  // exact failure executor selection exists to remove — it runs a DIFFERENT
  // agent than the user configured, silently, wearing the disguise of robustness.
  configurationUnusable: 'PANDA_CONFIGURATION_UNUSABLE',
  registryInvalidEntry: 'PANDA_REGISTRY_INVALID_ENTRY',
  registryContention: 'PANDA_REGISTRY_CONTENTION',
  registryStoreUnavailable: 'PANDA_REGISTRY_STORE_UNAVAILABLE',
  registryInactive: 'PANDA_REGISTRY_INACTIVE',
  registryProviderRejected: 'PANDA_REGISTRY_PROVIDER_REJECTED',
  registryOriginConflict: 'PANDA_REGISTRY_ORIGIN_CONFLICT',
  projectionNativeMalformed: 'PANDA_PROJECTION_NATIVE_MALFORMED',
  projectionTargetFailed: 'PANDA_PROJECTION_TARGET_FAILED',
  projectionTraitsInvalid: 'PANDA_PROJECTION_TRAITS_INVALID',
  projectionLedgerUnavailable: 'PANDA_PROJECTION_LEDGER_UNAVAILABLE',
  projectionNativeUnclaimable: 'PANDA_PROJECTION_NATIVE_UNCLAIMABLE',
  // `runProjection` was asked to run in a mode it does not have. Coded, and
  // rejected rather than defaulted, because the one thing that mode decides is
  // whether panda writes into files it does not own: an unrecognised value
  // silently taken as "apply" writes into a user's config on the say-so of a
  // typo, and `runProjection` is on the FR-29 surface, so untyped callers reach it.
  projectionModeInvalid: 'PANDA_PROJECTION_MODE_INVALID',
  // The machine or project scope panda was pointed at cannot be used: a
  // directory that does not exist, a path that is not a directory, an empty
  // string where a home was expected, or panda's own state directory occupied
  // by a file. Coded because every one of these is reachable from a caller's
  // argv or a consumer's `process.env.HOME ?? ''`, and a raw ENOENT/EEXIST
  // names neither the path nor what panda wanted from it.
  environmentScopeUnavailable: 'PANDA_ENVIRONMENT_SCOPE_UNAVAILABLE',
} as const

export type PandaErrorCode = (typeof PANDA_ERROR_CODES)[keyof typeof PANDA_ERROR_CODES]

export class PandaError extends Error {
  readonly code: PandaErrorCode

  constructor(code: PandaErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PandaError'
    this.code = code
  }
}
