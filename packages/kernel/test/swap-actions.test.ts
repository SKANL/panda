import { describe, expect, it } from 'vitest'
import { PluginInactiveError, SwapRejectedError, createKernel, type PluginFactory } from '../src'
import { manifest } from './helpers'

// Does a plugin that registers an ACTION survive a swap, and does a REJECTED
// swap leave anything behind? Driven, because the answer is not in any comment.

function actionPlugin(actionId: string, marker: string): PluginFactory {
  return (context) => {
    context.actions.register({ id: actionId, cost: 0, run: () => marker })
    return { status: 'activated', services: { 'svc.p': marker }, dispose: () => {} }
  }
}

describe('swap against the live action pipeline', () => {
  it('a plugin that registered an action can be replaced', () => {
    const kernel = createKernel()
    kernel.register(manifest({ id: 'p', provides: ['svc.p'] }), actionPlugin('act', 'old'))
    kernel.start()
    kernel.swap('p', actionPlugin('act', 'new'))
    expect(kernel.getService('svc.p')).toEqual({ kind: 'provided', pluginId: 'p', value: 'new' })
  })

  it('a REJECTED swap leaves nothing of the candidate behind', () => {
    const kernel = createKernel()
    kernel.register(manifest({ id: 'p', provides: ['svc.p'] }), () => ({
      status: 'activated',
      services: { 'svc.p': 'old' },
      dispose: () => {},
    }))
    kernel.start()

    // Registers an action, THEN fails the service contract, so the swap is
    // rejected after the candidate has already touched the live pipeline.
    const rejected: PluginFactory = (context) => {
      context.actions.register({ id: 'leaked', cost: 0, run: () => 'x' })
      return { status: 'activated', services: { 'svc.wrong': 'x' }, dispose: () => {} }
    }
    expect(() => kernel.swap('p', rejected)).toThrow(SwapRejectedError)
    expect(kernel.getService('svc.p')).toEqual({ kind: 'provided', pluginId: 'p', value: 'old' })

    // If the rejected candidate's registration survived, a LATER legitimate
    // plugin can never claim that id.
    const second: PluginFactory = (context) => {
      context.actions.register({ id: 'leaked', cost: 0, run: () => 'y' })
      return { status: 'activated', services: { 'svc.p': 'second' }, dispose: () => {} }
    }
    kernel.swap('p', second)
    expect(kernel.getService('svc.p')).toEqual({ kind: 'provided', pluginId: 'p', value: 'second' })
  })

  it('after a REJECTED swap the predecessor still holds its action id', async () => {
    const kernel = createKernel()
    let pHandle: { invoke: () => Promise<unknown> } | undefined
    kernel.register(manifest({ id: 'p', provides: ['svc.p'] }), (context) => {
      pHandle = context.actions.register({ id: 'act', cost: 0, run: () => 'old' })
      return { status: 'activated', services: { 'svc.p': 'old' }, dispose: () => {} }
    })
    kernel.register(manifest({ id: 'q', provides: ['svc.q'] }), () => ({
      status: 'activated',
      services: { 'svc.q': 'q' },
      dispose: () => {},
    }))
    kernel.start()

    // Rejected: the candidate re-declares p's id (legitimately, it is replacing
    // p) and then fails the service contract. p keeps serving, so p must keep
    // its id — the reclaim has to be UNDONE, not just abandoned.
    expect(() =>
      kernel.swap('p', (context) => {
        context.actions.register({ id: 'act', cost: 0, run: () => 'x' })
        return { status: 'activated', services: { 'svc.wrong': 'x' }, dispose: () => {} }
      }),
    ).toThrow(SwapRejectedError)

    // If the reclaim were left undone, an unrelated plugin could now take the id
    // p's live handle still answers to, and the audit subject would name two
    // different operations.
    expect(() =>
      kernel.swap('q', (context) => {
        context.actions.register({ id: 'act', cost: 0, run: () => 'stolen' })
        return { status: 'activated', services: { 'svc.q': 'q2' }, dispose: () => {} }
      }),
    ).toThrow(SwapRejectedError)

    // And p is still SERVING, so the handle it handed out must still run. The
    // reclaim frees the id before the candidate declares it; undoing that has to
    // bring the same declaration back to life, not merely re-mark the id.
    await expect(pHandle!.invoke()).resolves.toBe('old')
  })

  it('swap on a stopped kernel is refused', async () => {
    const kernel = createKernel()
    kernel.register(manifest({ id: 'p', provides: ['svc.p'] }), () => ({
      status: 'activated',
      services: { 'svc.p': 'old' },
      dispose: () => {},
    }))
    kernel.start()
    await kernel.stop()
    expect(() =>
      kernel.swap('p', () => ({ status: 'activated', services: { 'svc.p': 'new' }, dispose: () => {} })),
    ).toThrow(PluginInactiveError)
  })
})

describe('disposing a plugin retires the actions it declared', () => {
  it('refuses to run an action whose plugin is gone', async () => {
    const kernel = createKernel()
    let handle: { invoke: () => Promise<unknown> } | undefined
    kernel.register(manifest({ id: 'p', provides: ['svc.p'] }), (context) => {
      handle = context.actions.register({ id: 'act', cost: 0, run: () => 'from p' })
      return { status: 'activated', services: { 'svc.p': 'p' }, dispose: () => {} }
    })
    kernel.start()

    // CONTROL: it runs while its plugin is alive, or the refusal below proves
    // nothing about disposal.
    await expect(handle!.invoke()).resolves.toBe('from p')

    await kernel.dispose('p')

    // The kernel is already rigorous about the OTHER half of a disposed plugin:
    // `getService` throws PANDA_KERNEL_PLUGIN_INACTIVE with "service 'svc.p' was
    // disposed with its plugin". Actions were completely open — driven, a
    // disposed plugin's action still RAN and returned 'from p', executing a
    // closure whose disposer had already torn its state down.
    expect(() => kernel.getService('svc.p')).toThrow(PluginInactiveError)
    await expect(handle!.invoke()).rejects.toMatchObject({
      code: 'PANDA_KERNEL_PLUGIN_INACTIVE',
      pluginId: 'p',
    })
  })

  it('frees the id so another plugin can declare it', async () => {
    const kernel = createKernel()
    let pHandle: { invoke: () => Promise<unknown> } | undefined
    kernel.register(manifest({ id: 'p', provides: ['svc.p'] }), (context) => {
      pHandle = context.actions.register({ id: 'act', cost: 0, run: () => 'from p' })
      return { status: 'activated', services: { 'svc.p': 'p' }, dispose: () => {} }
    })
    kernel.register(manifest({ id: 'q', provides: ['svc.q'] }), () => ({
      status: 'activated',
      services: { 'svc.q': 'q' },
      dispose: () => {},
    }))
    kernel.start()
    await kernel.dispose('p')

    // Without this the id is burned for the life of the process by a plugin
    // that no longer exists.
    kernel.swap('q', (context) => {
      context.actions.register({ id: 'act', cost: 0, run: () => 'from q' })
      return { status: 'activated', services: { 'svc.q': 'q2' }, dispose: () => {} }
    })
    expect(kernel.getService('svc.q')).toEqual({ kind: 'provided', pluginId: 'q', value: 'q2' })

    // AND the dead handle stays dead. Reviving the declaration instead of
    // replacing it would hand p's disposed closure back to whoever still holds
    // its handle, under an id that now belongs to q.
    await expect(pHandle!.invoke()).rejects.toMatchObject({
      code: 'PANDA_KERNEL_PLUGIN_INACTIVE',
      pluginId: 'p',
    })
  })
})
