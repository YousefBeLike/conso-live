import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, SessionMeasureInput, SessionUsage, Timer } from 'claude-code'

import type { Calibration, Limit, Live, Snapshot, Totals, Wide } from '../types'

const PANE = 'conso-live'
const TITLE = 'Conso Claude'
// One redraw at most every 50 ms while a response streams: 20 per second.
const FRAME_MS = 50
// Rough characters per token, to count a response's tokens before the API states them.
const CHARS_PER_TOKEN = 3.5
// Percent points a window must move before its cost in tokens is learnt from it.
const MIN_STEP = 1
// Past this many points learnt, a new reading moves the figure by a fixed share.
const MAX_WEIGHT = 40

// Change a tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const snapshot = atom({ plugin: 'conso-live', key: 'snapshot' } as const, null, {
  shape: 'snapshot-1',
})
const totals = atom(
  { plugin: 'conso-live', key: 'totals' } as const,
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 },
  { shape: 'totals-2' },
)
const live = atom({ plugin: 'conso-live', key: 'live' } as const, { estimate: 0, rate: 0, streams: 0 }, {
  shape: 'live-1',
})
const calibration = atom({ plugin: 'conso-live', key: 'calibration' } as const, {}, {
  shape: 'calibration-1',
})
const IDLE_WIDE: Wide = {
  localTotal: 0,
  localOutput: 0,
  localSessions: 0,
  windows: {},
  accountLimits: null,
  accountSlope: null,
  localSpanRate: null,
  accountError: null,
  isRunning: false,
}
const wide = atom({ plugin: 'conso-live', key: 'wide' } as const, IDLE_WIDE, { shape: 'wide-2' })
const now = atom({ plugin: 'conso-live', key: 'now' } as const, 0)

const LABELS: Record<string, string> = {
  five_hour: 'Fenêtre 5 h',
  seven_day: 'Semaine',
  seven_day_opus: 'Semaine Opus',
  seven_day_sonnet: 'Semaine Sonnet',
  spend_limit: 'Limite de dépense',
}

const PARTS: { key: keyof Omit<Totals, 'requests'>; label: string; color: Color }[] = [
  { key: 'output', label: 'Sortie (générés)', color: 'claude' },
  { key: 'input', label: 'Entrée', color: 'success' },
  { key: 'cacheWrite', label: 'Cache écrit', color: 'merged' },
  { key: 'cacheRead', label: 'Cache lu', color: 'ide' },
]

const toSnapshot = (u: SessionUsage | SessionMeasureInput): Snapshot => ({
  limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
  contextTokens: u.context.tokens,
  contextWindow: u.context.window,
  contextPercent: u.context.percent,
  costUsd: u.cost?.usd,
})

const sumTokens = (t: Totals) => t.input + t.output + t.cacheRead + t.cacheWrite

const tone = (percent: number): Color => (percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success')

// Full figure grouped by thousands: 1 234 567.
const full = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

const short = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2).replace('.', ',')} M`
    : n >= 10_000
      ? `${Math.round(n / 1_000)} k`
      : full(n)

const fmtReset = (resetsAt: string, at: number) => {
  const left = Math.max(0, new Date(resetsAt).getTime() - at)
  const days = Math.floor(left / 86_400_000)
  const hours = Math.floor((left % 86_400_000) / 3_600_000)
  const minutes = Math.floor((left % 3_600_000) / 60_000)
  return days > 0 ? `${days} j ${hours} h` : hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`
}

const refresh = async ($: EngineInterface) => {
  const usage = await $.session.usage()
  await update($, snapshot, () => toSnapshot(usage))
  await update($, now, () => Date.now())
}

type Stream = { chars: number; startedAt: number }

// The responses streaming now, by turn, step and loop.
const streams = new Map<string, Stream>()
let lastFrame = 0
// Where each window stood when its cost was last learnt: its percent, and the
// session's token total at that moment.
const anchors = new Map<string, { percent: number; tokens: number }>()

function liveNow(): Live {
  const at = Date.now()
  let chars = 0
  let rate = 0
  for (const s of streams.values()) {
    chars += s.chars
    const seconds = (at - s.startedAt) / 1000
    if (seconds > 0.3) rate += s.chars / CHARS_PER_TOKEN / seconds
  }
  return { estimate: chars / CHARS_PER_TOKEN, rate, streams: streams.size }
}

function frame($: EngineInterface, isForced = false) {
  const at = Date.now()
  if (!isForced && at - lastFrame < FRAME_MS) return
  lastFrame = at
  void update($, live, liveNow)
}

// Learns how many of this session's tokens one percent of each window costs,
// from how far the window moved while they were spent.
async function calibrate($: EngineInterface, limits: Limit[]) {
  // The watcher weighs the limits from the whole history: this is the fallback.
  if ((await read($, wide)).isRunning) return
  const tokens = sumTokens(await read($, totals))
  const learnt: Calibration = {}

  for (const limit of limits) {
    const anchor = anchors.get(limit.kind)
    if (!anchor || limit.percentUsed < anchor.percent) {
      anchors.set(limit.kind, { percent: limit.percentUsed, tokens })
      continue
    }
    const step = limit.percentUsed - anchor.percent
    const spent = tokens - anchor.tokens
    if (step < MIN_STEP) continue
    anchors.set(limit.kind, { percent: limit.percentUsed, tokens })
    if (spent > 0) learnt[limit.kind] = { perPercent: spent / step, weight: step }
  }

  if (Object.keys(learnt).length === 0) return

  const next = await update($, calibration, (old: Calibration) => {
    const merged: Calibration = { ...old }
    for (const [kind, sample] of Object.entries(learnt)) {
      const prior = merged[kind]
      merged[kind] = prior
        ? {
            perPercent: (prior.perPercent * prior.weight + sample.perPercent * sample.weight) / (prior.weight + sample.weight),
            weight: Math.min(MAX_WEIGHT, prior.weight + sample.weight),
          }
        : sample
    }
    return merged
  })
  await $.store.set('calibration', next)
}

// Runs scripts/conso-watch.py for as long as the module is loaded and folds each
// line it prints into `wide`.
async function watch($: EngineInterface) {
  const watcher = $.process.spawn({ argv: ['python3', '-I', `${$.plugin.root}/scripts/conso-watch.py`] })
  let pending = ''

  await update($, wide, w => ({ ...w, isRunning: true }))
  try {
    for await (const piece of watcher) {
      if (piece.stream !== 'stdout') continue
      const lines = (pending + piece.text).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        let reading: Record<string, unknown>
        try {
          reading = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (reading.t === 'local') {
          await update($, wide, w => ({
            ...w,
            localTotal: Number(reading.total) || 0,
            localOutput: Number(reading.output) || 0,
            localSessions: Number(reading.sessions) || 0,
            windows: (reading.windows ?? {}) as Wide['windows'],
          }))
        } else if (reading.t === 'calib') {
          // Weighed from this machine's whole history: it replaces what this
          // session learnt on its own.
          const weighed: Calibration = {}
          for (const [kind, perPercent] of Object.entries(reading)) {
            if (typeof perPercent === 'number' && perPercent > 0) weighed[kind] = { perPercent, weight: MAX_WEIGHT }
          }
          const next = await update($, calibration, old => ({ ...old, ...weighed }))
          await $.store.set('calibration', next)
        } else if (reading.t === 'account') {
          await update($, wide, w =>
            typeof reading.error === 'string'
              ? { ...w, accountError: reading.error as string }
              : {
                  ...w,
                  accountError: null,
                  accountLimits: Array.isArray(reading.limits) ? (reading.limits as Limit[]) : w.accountLimits,
                  accountSlope: typeof reading.pct_per_min === 'number' ? reading.pct_per_min : null,
                  localSpanRate: typeof reading.local_rate === 'number' ? reading.local_rate : null,
                },
          )
        }
      }
    }
  } finally {
    await update($, wide, w => ({ ...w, isRunning: false }))
  }
}

export const register: Register = on => {
  let tick: Timer | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'conso',
      description: 'Ouvre le panneau de consommation de tokens en direct',
    })
    const kept = (await $.store.get('calibration')) as Calibration | undefined
    if (kept) await update($, calibration, () => kept)
    void $.ui.open({ id: PANE, title: TITLE })
    await refresh($)
    await update($, live, () => ({ estimate: 0, rate: 0, streams: 0 }))
    await update($, wide, () => IDLE_WIDE)
    void watch($).catch(() => undefined)

    tick?.cancel()
    // Keeps the reset countdowns current between turns.
    tick = $.clock.every(30_000, () => void update($, now, () => Date.now()))

    return next(e)
  })

  on('command.run', { command: 'conso' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($)

    return { text: 'Panneau de consommation ouvert.' }
  })

  on('turn.step', async function* ($, e, next) {
    const id = `${e.agentId ?? 'main'}:${e.turnId}:${e.index}`
    const stream: Stream = { chars: 0, startedAt: Date.now() }
    streams.set(id, stream)
    frame($, true)

    try {
      for await (const chunk of next(e)) {
        if (chunk.kind === 'text' || chunk.kind === 'thinking') {
          stream.chars += chunk.text.length
          frame($)
        } else if (chunk.kind === 'input') {
          stream.chars += chunk.json.length
          frame($)
        } else if (chunk.kind === 'stop' && chunk.usage) {
          const u = chunk.usage
          void update($, totals, (t: Totals) => ({
            input: t.input + u.input_tokens,
            output: t.output + u.output_tokens,
            cacheRead: t.cacheRead + u.cache_read_input_tokens,
            cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
            requests: t.requests + 1,
          }))
        }
        yield chunk
      }
    } finally {
      streams.delete(id)
      frame($, true)
    }
  })

  on('session.measure', async ($, e, next) => {
    await update($, snapshot, () => toSnapshot(e))
    await update($, now, () => Date.now())
    await calibrate($, e.rateLimits)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const t = await read($, totals)
    const l = await read($, live)
    const calib = await read($, calibration)
    const w = await read($, wide)
    const at = (await read($, now)) || Date.now()
    const width = Math.max(16, Math.min(44, (e.viewport?.columns ?? 40) - 8))
    const isStreaming = l.streams > 0
    const parts = { ...t, output: t.output + l.estimate }
    const total = sumTokens(parts)
    // This session's response streams before its transcript has it: added live.
    const pcTotal = w.localTotal + l.rate
    const pcOutput = w.localOutput + l.rate
    const pcSessions = Math.max(w.localSessions, isStreaming ? 1 : 0)
    // The account's own reading is the fresher one and counts every client.
    const limits = w.accountLimits ?? snap?.limits ?? []
    const perFive = calib.five_hour?.perPercent
    // The account's rate cannot be under this machine's over the same span.
    const accountRate =
      w.accountSlope !== null && perFive !== undefined
        ? Math.max((w.accountSlope * perFive) / 60, w.localSpanRate ?? 0)
        : null

    const bar = (percent: number, color: Color) => {
      const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)
      return (
        <Text mono>
          <Text color={color}>{'━'.repeat(filled)}</Text>
          <Text color="subtle">{'━'.repeat(width - filled)}</Text>
        </Text>
      )
    }

    // One bar split by where the tokens went, each part at least a cell when present.
    const composition = () => {
      if (total === 0) return <Text color="subtle" mono>{'━'.repeat(width)}</Text>
      const cells = PARTS.map(p => (parts[p.key] > 0 ? Math.max(1, Math.round((parts[p.key] / total) * width)) : 0))
      const largest = cells.indexOf(Math.max(...cells))
      cells[largest] = (cells[largest] ?? 0) + width - cells.reduce((a, b) => a + b, 0)
      return (
        <Text mono>
          {PARTS.map((p, i) => (
            <Text color={p.color}>{'━'.repeat(Math.max(0, cells[i] ?? 0))}</Text>
          ))}
        </Text>
      )
    }

    const card = (title: string, aside: JSX.Element | null, body: JSX.Element, accent: Color = 'subtle') => (
      <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} marginBottom={1}>
        <Box justifyContent="space-between" marginBottom={1}>
          <Text dimColor weight="semibold">
            {title}
          </Text>
          {aside}
        </Box>
        {body}
      </Box>
    )

    const limitBlock = (lim: Limit) => {
      const cal = calib[lim.kind]
      const color = tone(lim.percentUsed)
      const capacity = cal ? cal.perPercent * 100 : 0
      // The percent is read once a minute; this machine's count is live.
      const used = cal ? Math.max(cal.perPercent * lim.percentUsed, w.windows[lim.kind]?.total ?? 0) : 0
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box justifyContent="space-between">
            <Text weight="semibold">{LABELS[lim.kind] ?? lim.kind}</Text>
            <Text color={color} weight="bold">
              {lim.percentUsed} %
            </Text>
          </Box>
          {bar(lim.percentUsed, color)}
          {cal ? (
            <Box justifyContent="space-between">
              <Text>
                <Text weight="semibold">≈ {short(used)}</Text>
                <Text dimColor> / {short(capacity)}</Text>
              </Text>
              <Text>
                <Text dimColor>reste </Text>
                <Text color={color} weight="bold">
                  ≈ {short(Math.max(0, capacity - used))}
                </Text>
              </Text>
            </Box>
          ) : (
            <Text dimColor>
              {w.isRunning && Object.keys(calib).length > 0
                ? 'pas encore de tokens comptés pour cette limite'
                : 'équivalent tokens : calibrage en cours…'}
            </Text>
          )}
          {lim.resetsAt && <Text dimColor>remise à zéro dans {fmtReset(lim.resetsAt, at)}</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {card(
          'CETTE DISCUSSION',
          isStreaming ? (
            <Text color="success" weight="semibold">
              ● EN DIRECT
            </Text>
          ) : (
            <Text color="inactive">○ en attente</Text>
          ),
          <Box flexDirection="column">
            <Text size="title" weight="bold" color="claude" mono>
              {full(total)}
            </Text>
            <Text color={isStreaming ? 'success' : 'inactive'}>
              {isStreaming
                ? `+${full(l.estimate)} en cours · ${full(l.rate)} tok/s générés${l.streams > 1 ? ` · ${l.streams} flux` : ''}`
                : '0 tok/s générés'}
            </Text>
            <Text dimColor>
              {t.requests} requête{t.requests > 1 ? 's' : ''}
              {snap?.costUsd !== undefined ? ` · ${snap.costUsd.toFixed(2).replace('.', ',')} $ équivalent API (fin de tour)` : ''}
            </Text>
            <Box marginY={1}>{composition()}</Box>
            {PARTS.map(p => (
              <Box justifyContent="space-between">
                <Text>
                  <Text color={p.color}>■ </Text>
                  <Text dimColor>{p.label}</Text>
                </Text>
                <Text mono>
                  {full(parts[p.key])}
                  <Text dimColor> {total > 0 ? `${String(Math.round((parts[p.key] / total) * 100)).padStart(3)} %` : '  – %'}</Text>
                </Text>
              </Box>
            ))}
          </Box>,
          isStreaming ? 'claude' : 'subtle',
        )}

        {card(
          'TOUTES DISCUSSIONS',
          pcTotal >= 1 ? (
            <Text color="success" weight="semibold">
              ● ACTIF
            </Text>
          ) : (
            <Text color="inactive">{w.isRunning ? '○ calme' : '○ arrêté'}</Text>
          ),
          <Box flexDirection="column">
            <Box justifyContent="space-between">
              <Text weight="semibold">Ce PC</Text>
              <Text>
                <Text weight="bold" color={pcTotal >= 1 ? 'claude' : undefined} mono>
                  {full(pcTotal)}
                </Text>
                <Text dimColor> tok/s</Text>
              </Text>
            </Box>
            <Text dimColor>
              dont {full(pcOutput)} tok/s générés · {pcSessions} discussion{pcSessions > 1 ? 's' : ''} active
              {pcSessions > 1 ? 's' : ''}
            </Text>
            {(['five_hour', 'seven_day'] as const).map(kind => {
              const figures = w.windows[kind]
              return (
                <Box justifyContent="space-between">
                  <Text dimColor>{kind === 'five_hour' ? 'Consommé, fenêtre 5 h' : 'Consommé, semaine'}</Text>
                  <Text mono>
                    {figures ? full(figures.total) : '–'}
                    <Text dimColor>{figures ? ` (${short(figures.output)} générés)` : ''}</Text>
                  </Text>
                </Box>
              )
            })}

            <Box justifyContent="space-between" marginTop={1}>
              <Text weight="semibold">Compte entier</Text>
              {accountRate === null ? (
                <Text dimColor>en attente</Text>
              ) : (
                <Text>
                  <Text weight="bold" color="claude" mono>
                    ≈ {full(accountRate)}
                  </Text>
                  <Text dimColor> tok/s</Text>
                </Text>
              )}
            </Box>
            <Text dimColor>
              {w.accountError
                ? `mesure du compte indisponible (${w.accountError})`
                : perFive === undefined
                  ? 'en attente du calibrage de la fenêtre 5 h'
                  : w.accountSlope === null
                    ? 'premières mesures : il faut 5 min de relevés'
                    : `moyenne 5 à 15 min, dont ce PC ${full(w.localSpanRate ?? 0)} tok/s · claude.ai, VPS, autres PC compris`}
            </Text>
          </Box>,
          pcTotal >= 1 ? 'claude' : 'subtle',
        )}

        {card(
          'CONTEXTE',
          snap?.contextPercent !== undefined ? (
            <Text color={tone(snap.contextPercent)} weight="bold">
              {snap.contextPercent} %
            </Text>
          ) : null,
          snap?.contextTokens !== undefined ? (
            <Box flexDirection="column">
              {bar(snap.contextPercent ?? 0, tone(snap.contextPercent ?? 0))}
              <Box justifyContent="space-between">
                <Text>
                  <Text weight="semibold">{short(snap.contextTokens)}</Text>
                  <Text dimColor> / {short(snap.contextWindow)}</Text>
                </Text>
                <Text>
                  <Text dimColor>reste </Text>
                  <Text color={tone(snap.contextPercent ?? 0)} weight="bold">
                    {short(Math.max(0, snap.contextWindow - snap.contextTokens))}
                  </Text>
                </Text>
              </Box>
            </Box>
          ) : (
            <Text dimColor>en attente de la première réponse</Text>
          ),
        )}

        {limits.length > 0 &&
          card(
            "LIMITES D'ABONNEMENT",
            <Text dimColor>en tokens ≈</Text>,
            <Box flexDirection="column">
              {limits.map(limitBlock)}
              <Text dimColor size="caption">
                % relevés auprès du compte chaque minute. Équivalents en tokens d'après ce que ce PC a consommé depuis
                l'ouverture de chaque fenêtre : si d'autres appareils consomment aussi, ils sont sous-estimés.
              </Text>
            </Box>,
          )}
      </Box>
    )
  })
}
