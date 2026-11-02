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
// A window weighed at this percent or more replaces the figure outright; under
// it, the whole percent the account rounds to is too coarse.
const TRUSTED_PERCENT = 5
// Seconds before a watcher that stopped is started again, doubling up to the last.
const RESTART_S = [2, 5, 15, 60]
// The account is read once a minute: past this, its reading is called stale.
const STALE_MS = 3 * 60_000

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
  accountAt: null,
  accountSlope: null,
  localSpanRate: null,
  accountError: null,
  isRunning: false,
  runner: '',
}
const wide = atom({ plugin: 'conso-live', key: 'wide' } as const, IDLE_WIDE, { shape: 'wide-3' })
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


// The band's donuts are drawn as images on the desktop, where theme names do
// not reach. Each measure has a hue of its own, calm on the light and the dark
// theme alike; a limit turns amber past 75 % and red past 90 %.
const DONUT = 26
const HUES: Record<string, { hex: string; theme: Color }> = {
  five_hour: { hex: '#D97757', theme: 'claude' },
  seven_day: { hex: '#6A9BCC', theme: 'suggestion' },
  seven_day_opus: { hex: '#9C8AD1', theme: 'merged' },
  seven_day_sonnet: { hex: '#5FA8A0', theme: 'ide' },
  context: { hex: '#8CAF6E', theme: 'success' },
}
const PART_HEX: Record<keyof Omit<Totals, 'requests'>, string> = {
  output: '#D97757',
  input: '#8CAF6E',
  cacheWrite: '#9C8AD1',
  cacheRead: '#6A9BCC',
}

type Segment = { share: number; hex: string; theme: Color }

const gauge = (percent: number, kind: string): Segment => {
  const hue = HUES[kind] ?? { hex: '#6A9BCC', theme: 'suggestion' as Color }
  const share = Math.min(100, Math.max(0, percent)) / 100
  return percent >= 90
    ? { share, hex: '#D9534F', theme: 'error' }
    : percent >= 75
      ? { share, hex: '#D4A23B', theme: 'warning' }
      : { share, ...hue }
}

// Segments one after the other round a ring, from twelve o'clock.
const donutSvg = (segments: Segment[], size = DONUT * 2, stroke = 7) => {
  const c = size / 2
  const r = c - stroke / 2
  const round = 2 * Math.PI * r
  let offset = 0
  let arcs = ''
  for (const s of segments) {
    const length = round * Math.min(1, Math.max(0, s.share))
    if (length <= 0) continue
    arcs +=
      `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${s.hex}" stroke-width="${stroke}" ` +
      `stroke-dasharray="${length} ${round - length}" stroke-dashoffset="${-offset}" ` +
      `stroke-linecap="${segments.length === 1 ? 'round' : 'butt'}" transform="rotate(-90 ${c} ${c})"/>`
    offset += length
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#8B857C" stroke-opacity="0.25" stroke-width="${stroke}"/>` +
    arcs +
    '</svg>'
  )
}

// A limit in tokens: this machine's count is live, the percent a minute old
// at most, so the larger of the two is the better reading of what is used.
const inTokens = (lim: Limit, calib: Calibration, w: Wide) => {
  const cal = calib[lim.kind]
  if (!cal) return null
  const capacity = cal.perPercent * 100
  const used = Math.max(cal.perPercent * lim.percentUsed, w.windows[lim.kind]?.total ?? 0)
  return { used, capacity, left: Math.max(0, capacity - used) }
}

// Full figure grouped by thousands: 1 234 567.
const full = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

const short = (n: number) =>
  n >= 1_000_000_000
    ? `${(n / 1_000_000_000).toFixed(2).replace('.', ',')} Md`
    : n >= 1_000_000
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

// A limit as it stands at `at`: once its reset time has passed, the window
// starts again from zero, before the account is read anew.
const current = (lim: Limit, at: number): Limit & { isReset: boolean } =>
  lim.resetsAt && new Date(lim.resetsAt).getTime() <= at
    ? { kind: lim.kind, percentUsed: 0, isReset: true }
    : { ...lim, isReset: false }

const ago = (ms: number) => {
  const minutes = Math.floor(ms / 60_000)
  return minutes < 1 ? "à l'instant" : minutes < 60 ? `il y a ${minutes} min` : `il y a ${Math.floor(minutes / 60)} h`
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

// Keeps scripts/conso-watch.py running for as long as the module is loaded,
// starting it again whenever it stops.
async function supervise($: EngineInterface) {
  const runner = `${Date.now()}-${Math.random()}`
  for (let failures = 0; ; failures++) {
    const startedAt = Date.now()
    try {
      await watch($, runner)
    } catch {
      // Started again below.
    }
    // A watcher that ran a while had not failed: its restart is quick again.
    if (Date.now() - startedAt > 120_000) failures = 0
    const wait = RESTART_S[Math.min(failures, RESTART_S.length - 1)] ?? 60
    await $.clock.sleep(wait * 1000)
  }
}

// Runs the watcher once and folds each line it prints into `wide`.
async function watch($: EngineInterface, runner: string) {
  const watcher = $.process.spawn({ argv: ['python3', '-I', `${$.plugin.root}/scripts/conso-watch.py`] })
  let pending = ''

  await update($, wide, w => ({ ...w, isRunning: true, runner }))
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
          // session learnt on its own, unless the window is too fresh to tell
          // better than the figure already kept (just after a reset).
          const next = await update($, calibration, old => {
            const merged: Calibration = { ...old }
            for (const [kind, figure] of Object.entries(reading)) {
              if (!Array.isArray(figure)) continue
              const [perPercent, percent] = figure as [number, number]
              if (!(perPercent > 0)) continue
              const prior = merged[kind]
              if (!prior || percent >= TRUSTED_PERCENT || percent >= prior.weight) {
                merged[kind] = { perPercent, weight: percent }
              }
            }
            return merged
          })
          await $.store.set('calibration', next)
        } else if (reading.t === 'account') {
          const error = typeof reading.error === 'string' ? reading.error : null
          await update($, wide, w =>
            Array.isArray(reading.limits)
              ? {
                  ...w,
                  accountError: error,
                  accountLimits: reading.limits as Limit[],
                  accountAt: typeof reading.at === 'number' ? reading.at * 1000 : w.accountAt,
                  accountSlope: typeof reading.pct_per_min === 'number' ? reading.pct_per_min : null,
                  localSpanRate: typeof reading.local_rate === 'number' ? reading.local_rate : null,
                }
              : { ...w, accountError: error },
          )
        }
      }
    }
  } finally {
    // A watcher started since (after a reload) keeps its own mark.
    await update($, wide, w => (w.runner === runner ? { ...w, isRunning: false } : w))
  }
}

export const register: Register = on => {
  let tick: Timer | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'conso',
      description: 'Ouvre le détail de la consommation de tokens (le widget reste au-dessus de la saisie)',
    })
    const kept = (await $.store.get('calibration')) as Calibration | undefined
    if (kept) await update($, calibration, () => kept)
    // The band above the prompt shows itself; the pane opens on demand.
    await refresh($)
    await update($, live, () => ({ estimate: 0, rate: 0, streams: 0 }))
    await update($, wide, () => IDLE_WIDE)
    void supervise($).catch(() => undefined)

    tick?.cancel()
    // Keeps the reset countdowns current between turns, and turns a window
    // over to zero within seconds of its reset.
    tick = $.clock.every(5_000, () => void update($, now, () => Date.now()))

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

  // The widget above the prompt: one quiet row of small donuts, each with its
  // name and figure beside it, borderless like the app's own controls.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Svg = 'Svg' in table ? table.Svg : undefined
    const snap = await read($, snapshot)
    const t = await read($, totals)
    const l = await read($, live)
    const calib = await read($, calibration)
    const w = await read($, wide)
    const at = (await read($, now)) || Date.now()
    const isStreaming = l.streams > 0
    const parts = { ...t, output: t.output + l.estimate }
    const total = sumTokens(parts)
    const pcRate = w.localTotal + l.rate
    const isStale = w.accountError !== null || (w.accountAt !== null && at - w.accountAt > STALE_MS)
    const limits = (w.accountLimits ?? snap?.limits ?? [])
      .map(lim => current(lim, at))
      // The two windows everyone has, and a model's own week once it bites.
      .filter(lim => lim.kind === 'five_hour' || lim.kind === 'seven_day' || (lim.kind.startsWith('seven_day_') && lim.percentUsed >= 50))

    // A donut on the desktop; on the terminal, a glyph filled by quarters.
    const donut = (segments: Segment[], percent: number, alt: string) =>
      Svg ? (
        <Svg source={donutSvg(segments)} alt={alt} width={DONUT} height={DONUT} />
      ) : (
        <Text color={segments[0]?.theme ?? 'subtle'}>{'○◔◑◕●'[Math.round(Math.min(100, Math.max(0, percent)) / 25)]}</Text>
      )

    const stat = (key: string, ring: JSX.Element, label: string, value: string, detail: string) => (
      <Box key={key} flexDirection="row" alignItems="center" gap={1}>
        {ring}
        <Box flexDirection="column">
          <Text size="caption" dimColor>
            {label}
          </Text>
          <Text size="footnote" tabular>
            <Text weight="semibold">{value}</Text>
            {detail ? <Text dimColor> {detail}</Text> : ''}
          </Text>
        </Box>
      </Box>
    )

    const SHORT_LABELS: Record<string, string> = { five_hour: '5 h', seven_day: 'Semaine' }

    return (
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={3} rowGap={1} paddingX={1}>
        {stat(
          'session',
          donut(
            total > 0 ? PARTS.map(p => ({ share: parts[p.key] / total, hex: PART_HEX[p.key], theme: p.color })) : [],
            100,
            'Répartition des tokens de la discussion',
          ),
          isStreaming ? '● Discussion, en direct' : 'Discussion',
          full(total),
          isStreaming ? `+${full(l.estimate)} · ${full(l.rate)} tok/s` : 'tokens',
        )}

        {limits.map(lim => {
          const figures = inTokens(lim, calib, w)
          const reset = lim.isReset ? 'remis à zéro' : lim.resetsAt ? `↻ ${fmtReset(lim.resetsAt, at)}` : ''
          return stat(
            lim.kind,
            donut([gauge(lim.percentUsed, lim.kind)], lim.percentUsed, `${lim.percentUsed} %`),
            [SHORT_LABELS[lim.kind] ?? LABELS[lim.kind] ?? lim.kind, reset].filter(Boolean).join(' · '),
            `${lim.percentUsed} %`,
            figures ? `${short(figures.left)} restants` : '',
          )
        })}

        {snap?.contextTokens !== undefined &&
          stat(
            'context',
            donut([gauge(snap.contextPercent ?? 0, 'context')], snap.contextPercent ?? 0, `${snap.contextPercent ?? 0} %`),
            'Contexte',
            `${snap.contextPercent ?? 0} %`,
            `${short(snap.contextTokens)} / ${short(snap.contextWindow)}`,
          )}

        <Box flexGrow={1} flexDirection="row" justifyContent="flex-end" alignItems="center" gap={2}>
          {isStale ? (
            <Text size="caption" color="warning">
              ● compte en attente
            </Text>
          ) : pcRate >= 1 ? (
            <Text size="caption" dimColor tabular>
              Ce PC {full(pcRate)} tok/s
            </Text>
          ) : null}
          <Button key="details" plain dimColor label="Détails ›" onPress={() => void $.ui.open({ id: PANE, title: TITLE })} />
        </Box>
      </Box>
    )
  })

  // The details, in the band's language: sections under a small heading, no
  // frames, a donut beside each figure, the same hue for the same measure.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text } = table
    const Svg = 'Svg' in table ? table.Svg : undefined
    const snap = await read($, snapshot)
    const t = await read($, totals)
    const l = await read($, live)
    const calib = await read($, calibration)
    const w = await read($, wide)
    const at = (await read($, now)) || Date.now()
    const isStreaming = l.streams > 0
    const parts = { ...t, output: t.output + l.estimate }
    const total = sumTokens(parts)
    // This session's response streams before its transcript has it: added live.
    const pcTotal = w.localTotal + l.rate
    const pcOutput = w.localOutput + l.rate
    const pcSessions = Math.max(w.localSessions, isStreaming ? 1 : 0)
    // The account's own reading is the fresher one and counts every client.
    const limits = (w.accountLimits ?? snap?.limits ?? []).map(lim => current(lim, at))
    const isStale = w.accountError !== null || (w.accountAt !== null && at - w.accountAt > STALE_MS)
    const perFive = calib.five_hour?.perPercent
    // The account's rate cannot be under this machine's over the same span.
    const accountRate =
      w.accountSlope !== null && perFive !== undefined
        ? Math.max((w.accountSlope * perFive) / 60, w.localSpanRate ?? 0)
        : null

    const donut = (segments: Segment[], percent: number, px: number, alt: string) =>
      Svg ? (
        <Svg source={donutSvg(segments, px * 2, Math.round(px * 0.27))} alt={alt} width={px} height={px} />
      ) : (
        <Text color={segments[0]?.theme ?? 'subtle'}>{'○◔◑◕●'[Math.round(Math.min(100, Math.max(0, percent)) / 25)]}</Text>
      )

    const section = (title: string, aside: JSX.Element | null, body: JSX.Element) => (
      <Box flexDirection="column" marginBottom={2}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginBottom={1}>
          <Text size="caption" weight="medium" dimColor>
            {title}
          </Text>
          {aside}
        </Box>
        {body}
      </Box>
    )

    // A label on the left, its figure on the right.
    const line = (label: JSX.Element | string, value: JSX.Element | string) => (
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        {typeof label === 'string' ? (
          <Text size="footnote" dimColor>
            {label}
          </Text>
        ) : (
          label
        )}
        {typeof value === 'string' ? (
          <Text size="footnote" tabular>
            {value}
          </Text>
        ) : (
          value
        )}
      </Box>
    )

    const limitRow = (lim: Limit & { isReset: boolean }) => {
      const figures = inTokens(lim, calib, w)
      const reset = lim.isReset ? 'remis à zéro, nouveau relevé…' : lim.resetsAt ? `↻ dans ${fmtReset(lim.resetsAt, at)}` : ''
      return (
        <Box key={lim.kind} flexDirection="row" alignItems="center" gap={2} marginBottom={1}>
          {donut([gauge(lim.percentUsed, lim.kind)], lim.percentUsed, 36, `${lim.percentUsed} %`)}
          <Box flexDirection="column" flexGrow={1}>
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Text size="footnote" weight="medium">
                {LABELS[lim.kind] ?? lim.kind}
              </Text>
              <Text size="caption" dimColor tabular>
                {reset}
              </Text>
            </Box>
            <Text size="footnote" tabular>
              <Text weight="semibold">{lim.percentUsed} %</Text>
              <Text dimColor>
                {figures
                  ? ` · ≈ ${short(figures.used)} / ${short(figures.capacity)} · reste ${short(figures.left)}`
                  : w.isRunning && Object.keys(calib).length > 0
                    ? ' · pas encore de tokens comptés'
                    : ' · calibrage en cours…'}
              </Text>
            </Text>
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        {section(
          'Cette discussion',
          isStreaming ? (
            <Text size="caption" color="claude" weight="medium">
              ● en direct
            </Text>
          ) : (
            <Text size="caption" color="inactive">
              ○ en attente
            </Text>
          ),
          <Box flexDirection="column">
            <Box flexDirection="row" alignItems="center" gap={2} marginBottom={1}>
              {donut(
                total > 0 ? PARTS.map(p => ({ share: parts[p.key] / total, hex: PART_HEX[p.key], theme: p.color })) : [],
                100,
                48,
                'Répartition des tokens de la discussion',
              )}
              <Box flexDirection="column">
                <Text size="heading" weight="semibold" tabular>
                  {full(total)}
                  <Text size="footnote" weight="regular" dimColor>
                    {' '}tokens
                  </Text>
                </Text>
                <Text size="footnote" color={isStreaming ? 'claude' : undefined} dimColor={!isStreaming} tabular>
                  {isStreaming
                    ? `+${full(l.estimate)} en cours · ${full(l.rate)} tok/s${l.streams > 1 ? ` · ${l.streams} flux` : ''}`
                    : `${t.requests} requête${t.requests > 1 ? 's' : ''}${snap?.costUsd !== undefined ? ` · ${snap.costUsd.toFixed(2).replace('.', ',')} $ équivalent API` : ''}`}
                </Text>
              </Box>
            </Box>
            {PARTS.map(p =>
              line(
                <Text size="footnote">
                  <Text color={p.color}>● </Text>
                  <Text dimColor>{p.label}</Text>
                </Text>,
                <Text size="footnote" tabular>
                  {full(parts[p.key])}
                  <Text dimColor> {total > 0 ? `${String(Math.round((parts[p.key] / total) * 100)).padStart(3)} %` : '  – %'}</Text>
                </Text>,
              ),
            )}
          </Box>,
        )}

        {limits.length > 0 &&
          section(
            "Limites d'abonnement",
            w.accountAt !== null ? (
              <Text size="caption" color={isStale ? 'warning' : 'inactive'}>
                {isStale ? '● ' : ''}relevé {ago(at - w.accountAt)}
              </Text>
            ) : null,
            <Box flexDirection="column">
              {limits.map(limitRow)}
              {isStale && (
                <Text size="caption" color="warning">
                  {w.accountError === 'http-429'
                    ? "L'API du compte est saturée : chiffres du dernier relevé, nouvel essai automatique."
                    : w.accountError
                      ? `Relevé du compte en échec (${w.accountError}) : chiffres du dernier relevé, nouvel essai automatique.`
                      : 'Relevé du compte en retard : nouvel essai automatique.'}
                </Text>
              )}
              <Text size="caption" dimColor>
                Équivalents en tokens d'après ce que ce PC a consommé depuis l'ouverture de chaque fenêtre : si d'autres
                appareils consomment aussi, ils sont sous-estimés.
              </Text>
            </Box>,
          )}

        {section(
          'Contexte',
          null,
          snap?.contextTokens !== undefined ? (
            <Box flexDirection="row" alignItems="center" gap={2}>
              {donut([gauge(snap.contextPercent ?? 0, 'context')], snap.contextPercent ?? 0, 36, `${snap.contextPercent ?? 0} %`)}
              <Box flexDirection="column">
                <Text size="footnote" tabular>
                  <Text weight="semibold">{snap.contextPercent ?? 0} %</Text>
                  <Text dimColor>
                    {' '}· {short(snap.contextTokens)} / {short(snap.contextWindow)}
                  </Text>
                </Text>
                <Text size="caption" dimColor tabular>
                  reste {short(Math.max(0, snap.contextWindow - snap.contextTokens))} dans la fenêtre
                </Text>
              </Box>
            </Box>
          ) : (
            <Text size="footnote" dimColor>
              en attente de la première réponse
            </Text>
          ),
        )}

        {section(
          'Toutes les discussions',
          pcTotal >= 1 ? (
            <Text size="caption" color="claude" weight="medium">
              ● actif
            </Text>
          ) : (
            <Text size="caption" color="inactive">
              {w.isRunning ? '○ calme' : '○ arrêté'}
            </Text>
          ),
          <Box flexDirection="column">
            {line(
              <Text size="footnote" weight="medium">
                Ce PC
              </Text>,
              <Text size="footnote" tabular>
                <Text weight="semibold">{full(pcTotal)}</Text>
                <Text dimColor> tok/s</Text>
              </Text>,
            )}
            <Text size="caption" dimColor tabular>
              dont {full(pcOutput)} tok/s générés · {pcSessions} discussion{pcSessions > 1 ? 's' : ''} active
              {pcSessions > 1 ? 's' : ''}
            </Text>
            <Box flexDirection="column" marginY={1}>
              {(['five_hour', 'seven_day'] as const).map(kind => {
                const figures = w.windows[kind]
                return line(
                  <Text size="footnote">
                    <Text color={HUES[kind]?.theme}>● </Text>
                    <Text dimColor>{kind === 'five_hour' ? 'Consommé, fenêtre 5 h' : 'Consommé, semaine'}</Text>
                  </Text>,
                  <Text size="footnote" tabular>
                    {figures ? full(figures.total) : '–'}
                    <Text dimColor>{figures ? ` · ${short(figures.output)} générés` : ''}</Text>
                  </Text>,
                )
              })}
            </Box>
            {line(
              <Text size="footnote" weight="medium">
                Compte entier
              </Text>,
              accountRate === null ? (
                <Text size="footnote" dimColor>
                  en attente
                </Text>
              ) : (
                <Text size="footnote" tabular>
                  <Text weight="semibold">≈ {full(accountRate)}</Text>
                  <Text dimColor> tok/s</Text>
                </Text>
              ),
            )}
            <Text size="caption" dimColor>
              {w.accountError
                ? 'mesure du compte indisponible pour le moment'
                : perFive === undefined
                  ? 'en attente du calibrage de la fenêtre 5 h'
                  : w.accountSlope === null
                    ? 'premières mesures : il faut 5 min de relevés'
                    : `moyenne sur 5 à 15 min, dont ce PC ${full(w.localSpanRate ?? 0)} tok/s · claude.ai, VPS et autres PC compris`}
            </Text>
          </Box>,
        )}
      </Box>
    )
  })
}
