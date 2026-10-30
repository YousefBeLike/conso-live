export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Snapshot = {
  limits: Limit[]
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  costUsd?: number
}

export type Totals = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  requests: number
}

export type Live = {
  // Output tokens of the responses streaming now, estimated from their text.
  estimate: number
  // Output tokens per second over the responses streaming now.
  rate: number
  streams: number
}

// Tokens one percent of a limit window was seen to cost, by window kind;
// `weight` is how many percent points the figure was learnt over.
export type Calibration = Record<string, { perPercent: number; weight: number }>

// The account's use beyond this session, as scripts/conso-watch.py reports it.
export type Wide = {
  // Every Claude Code session on this machine, exact, smoothed over about 15 s.
  localTotal: number
  localOutput: number
  localSessions: number
  // This machine's tokens since each limit window opened, live.
  windows: Record<string, { total: number; output: number }>
  // Every limit window as the account reported it a minute ago at most,
  // every client of the account counted; null before the first reading.
  accountLimits: Limit[] | null
  // When the account was last read (ms), the limits above with it.
  accountAt: number | null
  // The five-hour window's percent per minute over the last minutes, and
  // this machine's tokens per second over the same span; null until enough
  // readings.
  accountSlope: number | null
  localSpanRate: number | null
  // Why the last reading of the account failed; the limits are then stale.
  accountError: string | null
  isRunning: boolean
  // The watcher now running, so one that ended late cannot mark it stopped.
  runner: string
}

declare module 'claude-code' {
  interface PluginState {
    'conso-live': {
      snapshot: Shaped<Snapshot | null>
      totals: Shaped<Totals>
      live: Shaped<Live>
      calibration: Shaped<Calibration>
      wide: Shaped<Wide>
      now: number
    }
  }
}
