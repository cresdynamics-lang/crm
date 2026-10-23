/**
 * Which English the recogniser should listen for.
 *
 * The browser's speech recognition is tuned per locale, and the locale decides
 * how well an accent is understood: the same sentence can come back clean under
 * one and as nonsense under another. There is no way to know in advance which
 * fits a given speaker, and no way to hear them from here — but the recogniser
 * reports how confident it was in every phrase, and that number is higher when
 * the locale fits the voice.
 *
 * So this runs a trial. It listens under each candidate in turn, a few requests
 * at a time, averages the recogniser's own confidence for each, and settles on
 * the best. Only requests that were accepted as the user's count, so the
 * television does not get a vote. The verdict is remembered; `reset()` (or
 * clearing site data) starts the trial again.
 */

/** Tried in this order; the first wins a tie. Override with VITE_SPEECH_LANGS. */
const DEFAULT_CANDIDATES = ['en-KE', 'en-US', 'en-GB']
/** Accepted requests per candidate before a verdict. */
const TRIAL_REQUESTS = 8
/** Requests heard under one candidate before trying the next. */
const TURN = 4
/** A lead smaller than this is noise: keep the earlier candidate. */
const MARGIN = 0.015
const STORAGE_KEY = 'jarvis.speechLang'

type Stats = Record<string, { n: number; sum: number }>
type Saved = { stats: Stats; chosen: string | null; candidates: string[] }
type Store = { get: () => string | null; set: (v: string) => void }

const browserStore: Store = {
  get: () => {
    try {
      return localStorage.getItem(STORAGE_KEY)
    } catch {
      return null
    }
  },
  set: (v) => {
    try {
      localStorage.setItem(STORAGE_KEY, v)
    } catch {
      /* private mode: the trial simply runs again next time */
    }
  },
}

export type LangPicker = {
  /** The locale to listen under right now. */
  current: () => string
  /** One accepted request's mean confidence (0..1). True if the locale should change now. */
  record: (confidence: number) => boolean
  /** The settled locale, or null while the trial is running. */
  chosen: () => string | null
  /** One line for the diagnostics panel. */
  describe: () => string
  reset: () => void
}

export function createLangPicker(candidates: string[] = DEFAULT_CANDIDATES, store: Store = browserStore): LangPicker {
  const fresh = (): Saved => ({
    stats: Object.fromEntries(candidates.map((c) => [c, { n: 0, sum: 0 }])),
    chosen: null,
    candidates,
  })

  let state = fresh()
  try {
    const saved = JSON.parse(store.get() ?? 'null') as Saved | null
    // A different candidate list is a different trial.
    if (saved && Array.isArray(saved.candidates) && saved.candidates.join() === candidates.join()) state = saved
  } catch {
    /* unreadable: start over */
  }

  const mean = (c: string) => (state.stats[c].n ? state.stats[c].sum / state.stats[c].n : 0)

  /** While trying: the first candidate that still owes requests in the current round. */
  const trying = () => {
    for (let round = TURN; round <= TRIAL_REQUESTS; round += TURN) {
      const owing = candidates.find((c) => state.stats[c].n < round)
      if (owing) return owing
    }
    return candidates[0]
  }

  const current = () => state.chosen ?? trying()

  return {
    current,
    chosen: () => state.chosen,
    record(confidence) {
      if (state.chosen || !(confidence > 0) || confidence > 1) return false
      const before = current()
      state.stats[before].n += 1
      state.stats[before].sum += confidence
      if (candidates.every((c) => state.stats[c].n >= TRIAL_REQUESTS)) {
        // Best mean wins; an earlier candidate keeps the place unless clearly beaten.
        state.chosen = candidates.reduce((best, c) => (mean(c) > mean(best) + MARGIN ? c : best), candidates[0])
      }
      store.set(JSON.stringify(state))
      return current() !== before
    },
    describe() {
      const scores = candidates
        .map((c) => `${c} ${state.stats[c].n ? mean(c).toFixed(2) : '–'} (${state.stats[c].n})`)
        .join(', ')
      return state.chosen ? `${state.chosen} chosen — ${scores}` : `trying ${current()} — ${scores}`
    },
    reset() {
      state = fresh()
      store.set(JSON.stringify(state))
    },
  }
}
