/**
 * WHY A THIRD PARTY'S OUTAGE MUST NOT FAIL PANDA'S GATE, in one place.
 *
 * A live suite measures something about panda only when the executor actually
 * RAN. An expired quota, a logged-out account or a data-policy consent the
 * account never granted all mean the same thing: nothing was measured. AD-5 is
 * panda's own rule — unavailable is not failed — and the honest answer is a skip
 * that says why.
 *
 * THIS FILE EXISTS BECAUSE THE PATTERNS ROTTED THREE TIMES. They lived in three
 * copies across `confinement-live.test.ts`, `stream-mode-live.test.ts` and
 * `live-smoke.test.ts`, each slightly different, each patched separately after a
 * vendor changed its wording. Two real messages were falling through on the day
 * this was written, measured against the patterns as they stood:
 *
 *     codex  quota    auth=false unavailable=false   "You've hit your usage limit..."
 *     claude logout   auth=false unavailable=false   "Not logged in · Please run /login"
 *     CONTROL panda   auth=false unavailable=false   an argument the executor rejects
 *
 * The control is the point: a genuine panda defect must match NEITHER, or a skip
 * would swallow the failures this suite exists to catch.
 *
 * NOT a `.test.ts`, because a test file that imports another test file registers
 * its suites twice. `provider-refusal.test.ts` runs the corpus below, and it is
 * an ordinary suite rather than a live one: it needs no vendor binary, so it
 * runs in CI, where the live suites all skip.
 */

/** The account cannot authenticate, so the executor never got to run. */
export const AUTH_FAILURE =
  /invalid api key|api key (is )?(invalid|required|missing)|not authenticated|unauthenticated|(please )?run `?(\/|(claude|codex|opencode) )(login|auth)|oauth token|insufficient credit|no credentials|not logged ?in|log ?in to continue/i

/**
 * The provider REFUSED, which is not the same as the executor misbehaving.
 *
 * `usage limit` and the billing-URL alternative were added after codex's quota
 * message fell through every phrase here. The URL is the more durable half: the
 * prose changes per vendor and per release, but a quota message points at a
 * settings, billing or usage page because that is what it is for.
 */
export const PROVIDER_UNAVAILABLE =
  /rate limit|usage limit|quota (exceeded|exhausted)|too many requests|freeusagelimit|purchase more credits|datapolicy|requires explicit opt in|service unavailable|overloaded|https?:\/\/\S*\/(settings|billing|usage|upgrade)\b|(^|[^0-9])(429|503)([^0-9]|$)/i

export function isAuthFailure(text: string): boolean {
  return AUTH_FAILURE.test(text)
}

export function isProviderUnavailable(text: string): boolean {
  return PROVIDER_UNAVAILABLE.test(text)
}

/** Which guard a message must reach, or `'neither'` for a panda-attributable one. */
export type RefusalVerdict = 'auth' | 'unavailable' | 'neither'

/**
 * REAL messages, copied from real runs, never invented.
 *
 * A message only earns a place here once it has actually been seen — inventing
 * plausible vendor prose would test the pattern against itself. Add the exact
 * bytes when a live suite reports a failure that measured nothing, and the
 * pattern above has to grow until this file is green again.
 */
export const OBSERVED_REFUSALS: readonly {
  readonly seen: string
  readonly text: string
  readonly verdict: RefusalVerdict
}[] = [
  {
    seen: 'codex, exhausted account, 2026-09-06',
    text: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 12th, 2026 10:17 PM.",
    verdict: 'unavailable',
  },
  {
    seen: 'claude, logged out, 2026-09-06',
    text: 'Not logged in · Please run /login',
    verdict: 'auth',
  },
  {
    seen: 'claude, bad key',
    text: 'invalid api key',
    verdict: 'auth',
  },
  {
    seen: 'generic HTTP throttle',
    text: 'request failed with status 429',
    verdict: 'unavailable',
  },
  {
    seen: 'generic rate limit',
    text: 'you have hit the rate limit',
    verdict: 'unavailable',
  },
  {
    // THE CONTROL, and the reason the two above cannot be widened carelessly: a
    // pattern loose enough to swallow this one turns every real defect into a
    // skip, which is worse than the failure it was meant to prevent.
    seen: 'a panda defect, which must never skip',
    text: "panda's adapter passed an argument the executor does not accept",
    verdict: 'neither',
  },
]
