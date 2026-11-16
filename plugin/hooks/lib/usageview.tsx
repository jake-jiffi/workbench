import type { CacheState, ContextUi, UsageSnapshot } from '../../types'
import { card } from './cards'
import type { Tone } from './cards'
import { contextLevel, countdown, duration, kTokens, trunc, wrapWords } from './format'
import { barSegments, cacheLabelMs, cacheView, categoryRows, ttlMs } from './usage'
import type { Thresholds } from './usage'
import type { Ctx } from './view'

// The context, prompt cache and cost cards, and the alert card that rises above the others when the
// context is nearly full. The bar and the wording of the cache lines are adapted from terminal-desk
// (MIT, Doonminus2; see NOTICE).

const TONES: Tone[] = ['quiet', 'warn', 'act']

export const levelOf = (snap: UsageSnapshot | null, t: Thresholds) => contextLevel(snap?.percent, t.warn, t.urgent)

export type ContextActions = {
  view: ContextUi
  openUndone: number
  onToggle: () => unknown
  onClear: () => unknown
  onCompact: () => unknown
  onHandover: () => unknown
  onCompactNow: () => unknown
}

function bar(c: Ctx, snap: UsageSnapshot) {
  const { Box, Text } = c.ui
  const segs = barSegments(snap.categories, snap.window, c.room, snap.percent)
  return (
    <Box key="ctx-bar" flexDirection="row">
      {segs.map((s, i) => (s.color ? <Text key={`seg-${i}`} color={s.color}>{'█'.repeat(s.n)}</Text> : <Text key={`seg-${i}`} dimColor>{'░'.repeat(s.n)}</Text>))}
    </Box>
  )
}

export function contextCard(c: Ctx, snap: UsageSnapshot | null, t: Thresholds, o: ContextActions) {
  const { ui, room } = c
  const { Box, Button, Text } = ui
  const level = levelOf(snap, t)
  const rows: unknown[] = []
  if (!snap || snap.percent === undefined || snap.tokens === undefined) {
    rows.push(<Text key="ctx-none" dimColor>No response in this window yet.</Text>)
  } else {
    rows.push(<Text key="ctx-line">{`${kTokens(snap.tokens)} of ${kTokens(snap.window)}`}</Text>)
    rows.push(bar(c, snap))
    if (level >= 1) {
      rows.push(
        <Box key="ctx-act" flexDirection="row" columnGap={2}>
          <Button key="ctx-clear" plain hotkey="c" label="/clear" onPress={o.onClear} />
          <Button key="ctx-compact" plain hotkey="k" label="/compact" onPress={o.onCompact} />
        </Box>,
      )
      rows.push(<Text key="ctx-carry" dimColor>{trunc(o.openUndone > 0 ? `${o.openUndone} left undone carry over: they are kept outside the chat.` : 'Nothing open in Left undone to lose.', room)}</Text>)
    }
    rows.push(
      <Box key="ctx-hand" flexDirection="row" columnGap={2}>
        <Button key="ctx-brief" plain hotkey="b" label="handover brief" onPress={o.onHandover} />
        {level >= 1 ? <Button key="ctx-compact-now" plain hotkey="n" label="compact now" onPress={o.onCompactNow} /> : null}
      </Box>,
    )
    if (snap.categories.length > 0) {
      rows.push(<Button key="ctx-more" plain hotkey="m" label={o.view.showAll ? 'hide categories' : 'all categories'} onPress={o.onToggle} />)
      if (o.view.showAll) {
        for (const r of categoryRows(snap.categories, true)) {
          rows.push(
            <Box key={`cat-${r.name}`} flexDirection="row" columnGap={1}>
              <Text color={r.isDim ? undefined : r.color} dimColor={r.isDim}>■</Text>
              <Text dimColor={r.isDim}>{trunc(r.name, Math.max(8, room - 12))}</Text>
              <Text dimColor>{kTokens(r.tokens)}</Text>
            </Box>,
          )
        }
      }
    }
  }
  return card({ ui, id: 'context', title: 'Context', count: snap?.percent !== undefined ? `${snap.percent}%` : undefined, tone: TONES[level] ?? 'quiet', columns: c.columns, rows })
}

// Rises above the other cards only when the context is nearly full. Heavy border, red: the person must act now.
export function alertCard(c: Ctx, snap: UsageSnapshot | null, t: Thresholds, o: ContextActions) {
  if (levelOf(snap, t) < 2 || snap?.percent === undefined) return null
  const { ui, room } = c
  const { Box, Button, Text } = ui
  const rows: unknown[] = wrapWords(`Context ${snap.percent}% full. Clear or compact before it gets in the way.`, room).map((l, i) => <Text key={`al-${i}`}>{l}</Text>)
  rows.push(
    <Box key="al-act" flexDirection="row" columnGap={2}>
      <Button key="al-clear" plain label="/clear" onPress={o.onClear} />
      <Button key="al-compact" plain label="/compact" onPress={o.onCompact} />
    </Box>,
  )
  rows.push(<Text key="al-carry" dimColor>{trunc(o.openUndone > 0 ? `${o.openUndone} left undone carry over.` : 'Nothing open in Left undone to lose.', room)}</Text>)
  return card({ ui, id: 'alert', title: 'Context nearly full', tone: 'act', isHeavy: true, columns: c.columns, rows })
}

export function cacheCard(c: Ctx, state: CacheState, ttl: string, nextTokens: number | undefined, isPrecise: boolean) {
  const { ui, room, now } = c
  const { Text } = ui
  const v = cacheView(state, ttl, now)
  const next = nextTokens ?? state.lastContext
  const rows: unknown[] = []
  let tone: Tone = 'quiet'
  if (v.state === 'none' || v.state === 'unknown') {
    rows.push(<Text key="ca-none" dimColor>{v.state === 'none' ? 'Caching on; set by the next reply.' : 'Unknown since the last change; the next reply sets it.'}</Text>)
  } else if (v.state === 'warm') {
    tone = 'ok'
    rows.push(<Text key="ca-a"><Text color="success">●</Text>{` warm, cold in ${countdown(cacheLabelMs(v.leftMs, isPrecise))} (${ttl} cache)`}</Text>)
    rows.push(<Text key="ca-b" dimColor>{trunc(`Next message reads ~${kTokens(next)} from cache`, room)}</Text>)
  } else {
    rows.push(<Text key="ca-a" dimColor>{`○ cold since ${duration(v.sinceMs)} ago`}</Text>)
    rows.push(<Text key="ca-b" dimColor>{trunc(`Next message re-caches ~${kTokens(next)}`, room)}</Text>)
  }
  if ('ratio' in v && v.ratio !== null) rows.push(<Text key="ca-c" dimColor>{`Hit ratio this session ${v.ratio}%`}</Text>)
  return card({ ui, id: 'cache', title: 'Prompt cache', tone, columns: c.columns, rows })
}

/** `$3.87 · session 48m03s · /workbench hides`. The cost is the engine's estimate, the same figure /cost totals. */
export function costLine(snap: UsageSnapshot | null, now: number): string {
  const parts: string[] = []
  if (snap?.costUsd !== undefined) parts.push(`$${snap.costUsd.toFixed(2)}`)
  if (snap) parts.push(`session ${duration(Math.max(0, now - snap.startedAt))}`)
  parts.push('/workbench hides')
  return parts.join(' · ')
}

export { ttlMs }
