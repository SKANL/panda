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

  it('after a REJECTED swap the predecessor still holds its action id', () => {
    const kernel = createKernel()
    kernel.register(manifest({ id: 'p', provides: ['svc.p'] }), actionPlugin('act', 'old'))
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
