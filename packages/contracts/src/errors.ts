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
  kernelSettlementInvalid: 'PANDA_KERNEL_SETTLEMENT_INVALID',
  kernelSettlementInProgress: 'PANDA_KERNEL_SETTLEMENT_IN_PROGRESS',
  contractEnvelopeInvalid: 'PANDA_CONTRACT_ENVELOPE_INVALID',
  contractWorkspaceUnknownId: 'PANDA_CONTRACT_WORKSPACE_UNKNOWN_ID',
  contractWorkspaceInvalidHandle: 'PANDA_CONTRACT_WORKSPACE_INVALID_HANDLE',
  contractWorkspaceDoubleRelease: 'PANDA_CONTRACT_WORKSPACE_DOUBLE_RELEASE',
  contractWorkspaceUnavailable: 'PANDA_CONTRACT_WORKSPACE_UNAVAILABLE',
  // Panda looked at a workspace it owns and DECLINED to remove it. Nothing
  // failed and nothing is unavailable: the removal would have destroyed work
  // that exists nowhere else, so panda stopped. Its own code rather than
  // `contractWorkspaceUnavailable`, for the reason that one's note gives — a
  // caller told a workspace is unavailable goes looking at git or the disk,
  // and here both are fine and the answer is to put the work somewhere a ref
  // names. Every refusal on the removal path arrives under this code, so a
  // caller branches on "panda would not" without matching message text.
  contractWorkspaceRemovalRefused: 'PANDA_CONTRACT_WORKSPACE_REMOVAL_REFUSED',
  // Two removals of ONE workspace at once; the loser gets this, naming the
  // holder as `pid@host`. Deliberately the same rule and the same shape as
  // `registryContention` rather than a second answer to the same question: one
  // winner, a bounded coded refusal for everyone else, and a holder a user can
  // identify. Separate from the refusal above because the fix is different —
  // wait for the other process, versus move the work somewhere a ref names.
  contractWorkspaceContention: 'PANDA_CONTRACT_WORKSPACE_CONTENTION',
  contractProviderDisposed: 'PANDA_CONTRACT_PROVIDER_DISPOSED',
  // A save request the port will not admit: a non-string payload, or provenance
  // missing or malformed in any of its three mandatory fields (RD-1). ONE code
  // rather than one per field, because the fix is the same class of fix —
  // correct the request — and the message names the field that is wrong. It is
  // separate from `contractMemoryUnknownEntry` below, whose fix is different: the
  // request is well-formed and the store simply does not hold what it points at.
  contractMemorySaveInvalid: 'PANDA_CONTRACT_MEMORY_SAVE_INVALID',
  // A `supersedes` pointer naming an entry this store does not hold. Refused
  // rather than stored, because an append-only log has no later opportunity to
  // repair a dangling supersession link.
  contractMemoryUnknownEntry: 'PANDA_CONTRACT_MEMORY_UNKNOWN_ENTRY',
  // RD-1's destructive overwrite, refused. The port NAMES the operation so the
  // refusal is coded and identical across providers; an absent method would
  // reach an untyped caller as `provider.overwrite is not a function`, which is
  // exactly the uncoded exit AD-7 exists to close.
  contractMemoryOverwriteUnsupported: 'PANDA_CONTRACT_MEMORY_OVERWRITE_UNSUPPORTED',
  // A store stamped with a format version this build does not speak. Version by
  // REJECT, never migrate — the same decision `STORE_VERSION` reached
  // independently in `@panda/registry`: a partially-read store is worse than an
  // unopened one, and a migration path is a v1 requirement nobody has.
  contractMemoryStoreVersionMismatch: 'PANDA_CONTRACT_MEMORY_STORE_VERSION_MISMATCH',
  // The medium itself cannot be created, opened or read, naming the path.
  // Distinct from an ABSENT store, which is not a failure at all but an empty
  // one (AD-5).
  contractMemoryStoreUnavailable: 'PANDA_CONTRACT_MEMORY_STORE_UNAVAILABLE',
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
  // A bundle, not the store: the two fail for different reasons at different
  // paths, and a user told their STORE is unavailable while their export
  // destination is what refused would go looking in the wrong place.
  registryBundleUnavailable: 'PANDA_REGISTRY_BUNDLE_UNAVAILABLE',
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
  // A remediation panda will not perform. Its own code rather than
  // `projectionTargetFailed`, because nothing failed: panda looked at what was
  // asked, found it outside what it owns or unprovable, and declined — which is
  // a different fact from a projection that broke, and the fix is different too.
  // Every containment refusal on the one path that changes ownership arrives
  // under this code, so a caller can branch on "panda would not" without
  // matching message text.
  projectionRemediationRefused: 'PANDA_PROJECTION_REMEDIATION_REFUSED',
  // The machine or project scope panda was pointed at cannot be used: a
  // directory that does not exist, a path that is not a directory, an empty
  // string where a home was expected, or panda's own state directory occupied
  // by a file. Coded because every one of these is reachable from a caller's
  // argv or a consumer's `process.env.HOME ?? ''`, and a raw ENOENT/EEXIST
  // names neither the path nor what panda wanted from it.
  environmentScopeUnavailable: 'PANDA_ENVIRONMENT_SCOPE_UNAVAILABLE',
  // A value offered as a MethodPlugin does not satisfy the published contract.
  // Separate from `kernelManifestInvalid`: that one answers for the kernel's
  // `PluginManifest`, which AD-1 keeps in a package that may never import this
  // one, and a methodology author who conflated the two would go looking for the
  // wrong validator.
  methodInvalidPlugin: 'PANDA_METHOD_INVALID_PLUGIN',
  // A method's `onActivate` or `onDeactivate` threw. ONE code, not one per hook:
  // unlike a kernel log record — whose closed shape has nowhere to carry which
  // cap fired, which is why the budget codes are split — a thrown PandaError
  // carries its `cause` and a message naming both the method and the hook, so a
  // consumer can already tell mount from unmount without a second constant.
  methodHookFailed: 'PANDA_METHOD_HOOK_FAILED',
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
