/**
 * Telling the user's voice from voices in the background.
 *
 * The browser's recogniser transcribes whatever it can hear — the television,
 * a colleague, a call in the next room — and nothing in its results says who
 * was speaking. What does differ is distance: the person addressing JARVIS is
 * near the microphone, and everyone else is not. So this measures how loud
 * speech was while it was being said and compares it with how loud the user
 * is known to be.
 *
 * "Known" comes from the wake word. Saying his name is the one moment that is
 * certainly the user, so each wake teaches the gate their level from wherever
 * they are sitting today. Requests that pass the gate refine it slowly, which
 * lets it settle to a normal speaking voice (people say the name louder than
 * what follows) without background speech ever pulling it down.
 *
 * It fails open. With no level learned yet, or no signal from the microphone
 * analyser, nothing is called background: missing a request is worse than
 * hearing an extra one.
 */

/** Speech below this fraction of the user's own level is taken as background. */
const BACKGROUND_RATIO = 0.4
/** Loudness is the median of this many of the loudest samples — the fifth
 *  loudest of nine — so a door slam or a cough, which is a few samples at most,
 *  cannot stand in for a sentence. At 50ms a sample, nine is under half a second. */
const TOP_SAMPLES = 9
/** How much history to keep. Longer than any single request. */
const KEEP_MS = 30_000
const STORAGE_KEY = 'jarvis.voiceLevel'

type Sample = { at: number; level: number }

export type NearGate = {
  /** Record the microphone level now. Call on a steady timer. */
  sample: (now?: number) => void
  /** Sustained loudness of what was heard since `since`. 0 = nothing measured. */
  loudness: (since: number) => number
  /** That speech was certainly the user (weight 0..1 = how much to trust it). */
  learn: (since: number, weight: number) => void
  /** True when speech since `since` was too quiet to have been the user. */
  isBackground: (since: number) => boolean
  /** The learned level, or null before the first wake. For diagnostics. */
  level: () => number | null
}

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
      /* private mode: relearned at the next wake */
    }
  },
}

export function createNearGate(read: () => number, store: Store = browserStore): NearGate {
  let samples: Sample[] = []
  const saved = Number(store.get())
  let level: number | null = Number.isFinite(saved) && saved > 0 ? saved : null

  const loudness = (since: number) => {
    const top = samples
      .filter((s) => s.at >= since)
      .map((s) => s.level)
      .sort((a, b) => b - a)
      .slice(0, TOP_SAMPLES)
    if (top.length < TOP_SAMPLES) return 0
    return top[Math.floor(TOP_SAMPLES / 2)]
  }

  return {
    sample(now = Date.now()) {
      samples.push({ at: now, level: read() })
      const cutoff = now - KEEP_MS
      if (samples[0].at < cutoff) samples = samples.filter((s) => s.at >= cutoff)
    },
    loudness,
    learn(since, weight) {
      const heard = loudness(since)
      if (heard <= 0) return
      level = level === null ? heard : level * (1 - weight) + heard * weight
      store.set(level.toFixed(4))
    },
    isBackground(since) {
      if (level === null) return false
      const heard = loudness(since)
      if (heard <= 0) return false
      return heard < level * BACKGROUND_RATIO
    },
    level: () => level,
  }
}
