import type { AccountsState, SwapState } from '../../types'
import { isSameAccount } from './accounts'
import { rowsWithErrors } from './acct'
import { card } from './cards'
import { trunc, wrapWords } from './format'
import { HOLD_MS, MOVE_MS, WHAT_CHANGES, moveRoute, targetFacts } from './swap'
import type { SwapChecks } from './swap'
import type { Ctx } from './view'

// The swap sheet: what is at risk, what changes, and one button that moves this conversation. It leaves a request
// for a wrapper and puts /exit in the prompt box; the person presses Enter. It never signs anyone in.

export type SwapActions = {
  onMove: () => unknown
  onModel: () => unknown
  onClose: () => unknown
  onPick: (label: string) => unknown
}

const lines = (text: string, room: number) => wrapWords(text, room)

export function swapCard(c: Ctx, s: SwapState, acc: AccountsState, checks: SwapChecks, a: SwapActions, canMove: boolean) {
  if (!s.isOpen && !s.result) return null
  const { ui, room, now } = c
  const { Box, Button, Text } = ui
  const rows: unknown[] = []
  const list = rowsWithErrors(acc)
  const target = list.find(r => r.label === s.target)

  if (s.result) {
    rows.push(<Text key="sw-now" bold>{trunc(`Now on ${s.result.label}${s.result.email ? ` · ${s.result.email}` : ''}`, room)}</Text>)
    s.result.lines.forEach((l, i) => rows.push(<Text key={`sw-res-${i}`} color={l.isProblem ? 'error' : undefined} dimColor={!l.isProblem}>{trunc(l.text, room)}</Text>))
    rows.push(<Button key="sw-close" plain label="close" onPress={a.onClose} />)
    return card({ ui, id: 'swap', title: 'Account changed', tone: s.result.lines.some(l => l.isProblem) ? 'act' : 'ok', columns: c.columns, rows })
  }

  rows.push(<Text key="sw-target" bold>{trunc(target ? `To ${targetFacts(target).join(' · ')}` : 'No other account readable yet. Refresh accounts first.', room)}</Text>)
  if (s.isChoosing) {
    for (const r of list.filter(x => !isSameAccount(x.reading, acc.self))) rows.push(<Button key={`sw-pick-${r.label}`} plain label={`${r.label}${r.reading?.email ? ` · ${r.reading.email}` : ''}`} onPress={() => a.onPick(r.label)} />)
  }
  for (const [i, b] of checks.blockers.entries()) lines(b, room).forEach((l, n) => rows.push(<Text key={`sw-b-${i}-${n}`} color="error">{l}</Text>))
  for (const [i, w] of checks.warnings.entries()) lines(w, room).forEach((l, n) => rows.push(<Text key={`sw-w-${i}-${n}`} color="warning">{l}</Text>))
  rows.push(<Text key="sw-what" dimColor>What changes:</Text>)
  WHAT_CHANGES.forEach((w, i) => lines(w, room - 2).forEach((l, n) => rows.push(<Text key={`sw-c-${i}-${n}`} dimColor>{`${n === 0 ? '· ' : '  '}${l}`}</Text>)))
  rows.push(<Text key="sw-saved" dimColor>A handover brief is saved first, so nothing is lost if this goes wrong.</Text>)

  const isArmed = s.armedAt > 0 && now - s.armedAt < HOLD_MS
  const act = canMove ? `move this conversation to ${target?.label}` : 'put /exit in the prompt'
  const label = checks.isBlocked ? (isArmed ? `press again: ${act}` : `held: press twice to ${act}`) : act
  rows.push(
    <Box key="sw-act" flexDirection="column">
      {target ? <Button key="sw-move" plain label={label} onPress={a.onMove} /> : null}
      <Box flexDirection="row" columnGap={2}>
        <Button key="sw-model" plain label="/model instead" onPress={a.onModel} />
        <Button key="sw-close" plain label="close" onPress={a.onClose} />
      </Box>
    </Box>,
  )
  if (target && s.movedAt !== undefined && now - s.movedAt < MOVE_MS) {
    const text = canMove ? `Press Enter on /exit: this conversation reopens on ${target.label} in this terminal.` : `Press Enter on /exit, then ${moveRoute(target.label)}.`
    lines(text, room).forEach((l, n) => rows.push(<Text key={`sw-moving-${n}`} color="warning">{l}</Text>))
  }
  if (target && !canMove) lines(`This session cannot reopen by itself. To move: press Enter on /exit, then ${moveRoute(target.label)} (this mod never runs it).`, room).forEach((l, n) => rows.push(<Text key={`sw-shell-${n}`} dimColor>{l}</Text>))
  return card({ ui, id: 'swap', title: 'Swap account', tone: checks.isBlocked ? 'act' : 'warn', columns: c.columns, rows })
}
