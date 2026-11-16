import type { EngineInterface } from 'claude-code'

import type { CWorker, Snapshot, TaskLine, UndoneItem, UndoneUi, Worker } from '../../types'
import { card, innerWidth } from './cards'
import type { Ui } from './cards'
import { ago, fitLine, hhmm, trunc, wrapWords } from './format'
import { ci, nextStep } from './github'
import { ownerName } from './workspace'
import { cardItems, isStale, sourceLabel } from './undone'
import { isCwEnded, isSilentCW, runningCW, visibleCW } from './cworkers'
import { RECENT_MS, isEnded, isQuietWorker, prsTone, waitingTone, workersTone } from './tones'

// The cards of the pane that v1 already had: workers, pull requests, production, waiting on the owner.
// Same data and the same one-line rule as v1; only the frame is new.

// `$` is never kept in an object (the engine refuses it): the sections take it as an argument.
export type Ctx = { ui: Ui; columns: number; room: number; now: number }

export function makeCtx(ui: Ui, columns: number, now: number): Ctx {
  return { ui, columns, room: innerWidth(columns), now }
}

export function workersCard($: EngineInterface, c: Ctx, list: Worker[], cw: CWorker[] = []) {
  const { ui, now, room } = c
  const { Button, Text } = ui
  const running = list.filter(w => !isEnded(w.status))
  const recent = list
    .filter(w => isEnded(w.status) && now - (w.endedAt ?? now) < RECENT_MS)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, 6)

  const row = (w: Worker) => {
    const isQuiet = isQuietWorker(w, now)
    // Red is for what needs attention: a failure or a quiet worker. A worker stopped after its work is done is grey.
    // A failure inside five minutes of an account swap that reads as an account fault is amber, tagged "account": not a code fault.
    const isAccount = w.tag === 'account'
    const mark = w.status === 'completed' ? '✓' : isAccount && w.status !== 'running' ? '!' : isAccount ? '!' : w.status === 'failed' ? '✗' : w.status === 'killed' ? '■' : isQuiet ? '!' : '▶'
    const color = w.status === 'completed' ? 'success' : isAccount ? 'warning' : w.status === 'failed' || isQuiet ? 'error' : w.status === 'killed' ? 'subtle' : 'warning'
    const state = isAccount ? ' account' : w.status === 'killed' ? ' stopped' : w.status === 'failed' ? ' failed' : ''
    const age = w.startedAt > 0 ? ` ${ago((w.endedAt ?? now) - w.startedAt)}` : ''
    const where = w.worktree ? ` ${w.worktree.replace('worktrees/', '')}` : ''
    const desc = trunc(w.description, Math.max(12, Math.floor(room * 0.6)))
    return (
      <Button key={`w-${w.id}`} plain onPress={() => $.ui.view({ agentId: w.id })}>
        <Text>
          <Text color={color}>{mark}</Text> {desc}{' '}
          <Text dimColor>{fitLine(`${mark} ${desc} `, `${w.type}${age}${state}${isQuiet ? ' quiet' : ''}${where}`, room)}</Text>
        </Text>
      </Button>
    )
  }
  // claude-worker's workers: view only, so no button. A name row, then the reason claude-worker gave on its own line.
  const cwRow = (w: CWorker) => {
    const isSilent = isSilentCW(w, now)
    const mark = w.state === 'done' ? '✓' : w.state === 'failed' ? '✗' : w.state === 'stopped' ? '■' : w.state === 'waiting' ? '◌' : w.state === 'running' ? (isSilent ? '!' : '▶') : '?'
    const color = w.state === 'done' ? 'success' : w.state === 'failed' ? 'error' : w.state === 'running' ? 'warning' : 'subtle'
    const age = ago((w.endedAt ?? now) - w.createdAt)
    const silent = isSilent ? ` no heartbeat ${ago(now - w.updatedAt)}` : ''
    const name = trunc(w.name, Math.max(12, Math.floor(room * 0.5)))
    const tail = `${w.state}${silent}${w.account ? ` · ${w.account}` : ''} ${age}`
    return [
      <Text key={`cw-${w.id}`}>
        <Text color={color}>{mark}</Text> {name} <Text dimColor>{fitLine(`${mark} ${name} `, tail, room)}</Text>
      </Text>,
      w.reason ? (
        <Text key={`cwr-${w.id}`} dimColor>
          {'  '}
          {trunc(w.reason, Math.max(8, room - 2))}
        </Text>
      ) : null,
    ]
  }
  const cwShown = visibleCW(cw, now)
  const cwRunning = runningCW(cw).length
  const cwRecent = cwShown.filter(w => isCwEnded(w.state)).length
  const rows = [...running.map(row), ...recent.map(row), ...cwShown.flatMap(cwRow)]
  const finished = recent.length + cwRecent
  return card({
    ui,
    id: 'workers',
    title: 'Workers',
    count: `${running.length + cwRunning} running`,
    hint: finished ? `${finished} finished recently` : undefined,
    tone: workersTone(list, now, cw),
    columns: c.columns,
    rows: rows.length ? rows : [<Text key="none" dimColor>None yet.</Text>],
  })
}

const PR_ROWS = 8

export function prsCard($: EngineInterface, c: Ctx, snap: Snapshot | null) {
  const { ui, room } = c
  const { Button, Text } = ui
  const prs = (snap?.prs ?? [])
    .filter(pr => !pr.isBot)
    .map(pr => ({ pr, step: nextStep(pr) }))
    .sort((a, b) => a.step.rank - b.step.rank)
  const bots = (snap?.prs ?? []).filter(pr => pr.isBot)
  const botRed = bots.filter(pr => ci(pr.checks) === 'red').length

  const rows: unknown[] = prs.slice(0, PR_ROWS).map(({ pr, step }) => {
    const state = ci(pr.checks)
    const color = state === 'red' ? 'error' : state === 'green' ? 'success' : state === 'running' ? 'warning' : 'subtle'
    const mark = state === 'red' ? '✗' : state === 'green' ? '✓' : state === 'running' ? '◌' : '·'
    // On a narrow pane the base branch goes first, then the label is cut, so a row never wraps.
    const long = `${mark} ${pr.app} #${pr.number} → ${pr.base}`
    const head = long.length + 1 + step.label.length <= room ? long : `${mark} ${pr.app} #${pr.number}`
    const label = trunc(step.label, Math.max(4, room - head.length - 1))
    const tail = head.length + label.length + 6 <= room ? fitLine(`${head} ${label} `, pr.title, room) : ''
    return (
      <Button key={`p-${pr.app}-${pr.number}`} plain onPress={() => void $.process.run(['/usr/bin/open', pr.url])}>
        <Text>
          <Text color={color}>{mark}</Text> {head.slice(2)}{' '}
          <Text color={step.rank <= 1 ? 'error' : step.rank === 2 ? 'warning' : 'subtle'}>{label}</Text>
          {tail ? <Text dimColor>{` ${tail}`}</Text> : null}
        </Text>
      </Button>
    )
  })
  if (prs.length > PR_ROWS) rows.push(<Text key="p-more" dimColor>{`and ${prs.length - PR_ROWS} more`}</Text>)
  if (prs.length === 0) rows.push(<Text key="p-none" dimColor>{snap ? 'None open.' : 'Loading…'}</Text>)
  if (bots.length > 0) {
    rows.push(
      <Button key="p-bots" plain onPress={() => void $.process.run(['/usr/bin/open', 'https://github.com/pulls?q=is%3Aopen+is%3Apr+author%3Aapp%2Fdependabot'])}>
        <Text dimColor>{trunc(`· ${bots.length} dependency ${bots.length === 1 ? 'bump' : 'bumps'} from bots${botRed ? `, ${botRed} with CI red` : ''}`, room)}</Text>
      </Button>,
    )
  }
  return card({ ui, id: 'prs', title: 'Pull requests', count: `${prs.length}`, hint: 'by next step', tone: prsTone(snap?.prs ?? []), columns: c.columns, rows })
}

export function productionCard(c: Ctx, snap: Snapshot | null) {
  const { ui, room } = c
  const { Text } = ui
  const rows = (snap?.releases ?? []).map(r => {
    const tail = r.ahead === 1 ? '1 commit to release' : r.ahead > 0 ? `${r.ahead} commits to release` : 'in step'
    return (
      <Text key={`r-${r.app}`}>
        {r.app} <Text dimColor>{trunc(`live ${r.live}, ${r.integration} ${r.head}`, Math.max(4, room - r.app.length - tail.length - 3))}</Text>{' '}
        <Text color={r.ahead > 0 ? 'warning' : 'success'}>{tail}</Text>
      </Text>
    )
  })
  // Commits waiting to release are information, not an alarm: this card stays quiet.
  return card({ ui, id: 'production', title: 'Production', tone: 'quiet', columns: c.columns, rows: rows.length ? rows : [<Text key="r-none" dimColor>{snap ? 'No apps yet: workbench add-app <owner/repo>.' : 'Loading…'}</Text>] })
}

// Rows shown before "and N more", so the header count and the list always agree.
export const WAITING_ROWS = 9

export function waitingCard(c: Ctx, snap: Snapshot | null) {
  const { ui, room } = c
  const { Text } = ui
  const items = snap?.waiting ?? []
  const rows = items.length === 0
    ? [<Text key="j-none" dimColor>Nothing listed.</Text>]
    : items.slice(0, WAITING_ROWS).map((item, i) => <Text key={`j-${i}`}>{i + 1}. {trunc(item, room - 4)}</Text>)
  if (items.length > WAITING_ROWS) rows.push(<Text key="j-more" dimColor>{`and ${items.length - WAITING_ROWS} more (STATE.md)`}</Text>)
  return card({ ui, id: 'waiting', title: `Waiting on ${ownerName()}`, count: items.length ? `${items.length}` : undefined, hint: 'STATE.md', tone: waitingTone(items.length), columns: c.columns, rows })
}

export function footerRow(c: Ctx, snap: Snapshot | null, onRefresh: () => unknown, cost = '') {
  const { ui, room } = c
  const { Box, Button, Text } = ui
  const read = snap ? `GitHub read ${hhmm(snap.at)}` : 'Reading GitHub…'
  const error = snap?.error ? ` · error: ${trunc(snap.error, Math.max(8, room - 40))}` : ''
  return (
    <Box key="footer" flexDirection="column">
      {cost ? <Text dimColor>{trunc(cost, room)}</Text> : null}
      <Box flexDirection="row">
        <Text dimColor>{`${read}${error} `}</Text>
        <Button key="refresh" label="Refresh" hotkey="r" onPress={onRefresh} />
      </Box>
    </Box>
  )
}

const UNDONE_ROWS = 5
const TASK_ROWS = 4

export type UndoneActions = {
  retentionDays: number
  view: UndoneUi
  claudeResolved: UndoneItem[]
  isClearArmed: boolean
  onResolve: (id: string) => unknown
  onDrop: (id: string) => unknown
  onReopen: (id: string) => unknown
  onFinish: () => unknown
  onClear: () => unknown
  onHelp: () => unknown
  onFold: () => unknown
}

const HELP =
  "Claude's own loose ends, found in builder reports, Claude's final answers, new TODO lines and Claude's own notes. f puts a request to finish them in the prompt box and never sends it. Waiting on you is yours; this list is Claude's."

// Claude's own open commitments. Amber, never red: nothing here is for the owner to do (that is the waiting card).
export function undoneCard(c: Ctx, items: UndoneItem[], tasks: TaskLine[], o: UndoneActions) {
  const { ui, room, now } = c
  const { Box, Button, Text } = ui
  const open = cardItems(items)
  const shown = open.slice(0, UNDONE_ROWS)
  const rows: unknown[] = []
  for (const item of shown) {
    const lead = `${item.id}${item.confidence === 'low' ? '?' : ''} ${hhmm(item.lastAt)} `
    const extra = `${item.sources.length > 1 ? ` +${item.sources.length - 1}` : ''}${item.flag ? ` · ${item.flag}` : ''}${item.root ? '' : ' · (unscoped)'}${isStale(item, now, o.retentionDays) ? ' · stale' : ''}`
    const where = trunc(` · ${sourceLabel(item)}${extra}`, Math.max(0, room - lead.length - item.tag.length))
    rows.push(
      <Box key={`u-${item.id}`} flexDirection="column">
        <Text>
          <Text dimColor>{lead}</Text>
          <Text color="warning">{item.tag}</Text>
          <Text dimColor>{where}</Text>
        </Text>
        <Box flexDirection="row" columnGap={1}>
          <Text>{`  ${trunc(item.text, Math.max(8, room - 2 - 15))}`}</Text>
          <Button key={`u-done-${item.id}`} plain label="✓ done" onPress={() => o.onResolve(item.id)} />
          <Button key={`u-drop-${item.id}`} plain label="– drop" onPress={() => o.onDrop(item.id)} />
        </Box>
      </Box>,
    )
  }
  if (open.length > shown.length) rows.push(<Text key="u-more" dimColor>{`and ${open.length - shown.length} more (left_undone_list shows them)`}</Text>)
  if (open.length === 0) rows.push(<Text key="u-none" dimColor>Nothing open.</Text>)

  if (open.length > 0) {
    rows.push(
      <Box key="u-actions" flexDirection="row" columnGap={2}>
        <Button key="u-finish" plain hotkey="f" label="finish all" onPress={o.onFinish} />
        <Button key="u-clear" plain hotkey="x" label={o.isClearArmed ? 'press x again to clear' : 'clear all'} onPress={o.onClear} />
        <Button key="u-help" plain hotkey="h" label={o.view.help ? 'hide help' : 'how it works'} onPress={o.onHelp} />
      </Box>,
    )
  } else {
    rows.push(<Button key="u-help" plain hotkey="h" label={o.view.help ? 'hide help' : 'how it works'} onPress={o.onHelp} />)
  }
  if (o.view.help) wrapWords(HELP, room).forEach((line, i) => rows.push(<Text key={`u-help-${i}`} dimColor>{line}</Text>))

  if (o.claudeResolved.length > 0) {
    rows.push(<Button key="u-fold" plain label={`${o.view.resolvedOpen ? '▾' : '▸'} Recently resolved by Claude (${o.claudeResolved.length})`} onPress={o.onFold} />)
    if (o.view.resolvedOpen) {
      for (const item of o.claudeResolved.slice(0, 6)) {
        rows.push(
          <Box key={`u-r-${item.id}`} flexDirection="row" columnGap={1}>
            <Text dimColor>{`${item.id} ${trunc(item.note ? `${item.text}: ${item.note}` : item.text, Math.max(8, room - item.id.length - 12))}`}</Text>
            <Button key={`u-reopen-${item.id}`} plain label="reopen" onPress={() => o.onReopen(item.id)} />
          </Box>,
        )
      }
    }
  }

  if (tasks.length > 0) {
    rows.push(<Text key="u-tasks" dimColor>{`Task list ${tasks.length}`}</Text>)
    for (const t of tasks.slice(0, TASK_ROWS)) rows.push(<Text key={`t-${t.id}`} dimColor>{`· ${trunc(t.text, room - 2)}`}</Text>)
  }
  return card({ ui, id: 'undone', title: 'Left undone', count: open.length ? `${open.length}` : undefined, hint: "Claude's to do", tone: open.length ? 'warn' : 'quiet', columns: c.columns, rows })
}
