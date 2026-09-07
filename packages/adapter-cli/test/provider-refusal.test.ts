import { describe, expect, it } from 'vitest'
import {
  OBSERVED_REFUSALS,
  isAuthFailure,
  isProviderUnavailable,
  type RefusalVerdict,
} from './provider-refusal.ts'

function verdictOf(text: string): RefusalVerdict {
  if (isAuthFailure(text)) return 'auth'
  if (isProviderUnavailable(text)) return 'unavailable'
  return 'neither'
}

describe('a third party outage skips, and a panda defect does not', () => {
  it.each(OBSERVED_REFUSALS)('classifies the message seen from $seen', ({ text, verdict }) => {
    expect(
      verdictOf(text),
      `this message was actually observed and the guards no longer recognise it, so a live suite would report a third party's outage as a panda failure:\n${text}`,
    ).toBe(verdict)
  })

  it('CONTROL: the corpus carries both verdicts and a negative, or it proves nothing', () => {
    // Without this, a corpus of six `'unavailable'` rows would pass against a
    // pattern that matches everything.
    const verdicts = new Set(OBSERVED_REFUSALS.map((row) => row.verdict))
    expect([...verdicts].sort()).toEqual(['auth', 'neither', 'unavailable'])
  })
})
