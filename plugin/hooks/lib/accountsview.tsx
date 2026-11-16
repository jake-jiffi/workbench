import type { AccountRow, AccountsState, Limit } from '../../types'
import { ageLabel, accountTone, errorClears, FIFTEEN_MIN, labelFor, meterLevel, rowFor, swapCandidate } from './accounts'
import { card } from './cards'
import type { Tone } from './cards'
import { limitName, fmtReset, hasRecentError, rowsWithErrors } from './acct'
import { trunc } from './format'
import type { Ctx } from './view'

// The Accounts card: this session's account, its two meters, and the other accounts you can move to (a click on
// one moves). Only numbers the binary or the engine printed; nothing here reads a login.

export type AccountsView = { warn: number; urgent: number; weekWarn: number }

export type AccountsActions = {
  onSwap: () => unknown
  onChoose: () => unknown
  onRefresh: () => unknown
  onModel: (model: string) => unknown
  onMove: (label: string) => unknown
}

const barOf = (percent: number, cols: number) => {
  const n = Math.round((percent / 100) * cols)
  return '█'.repeat(n) + '░'.repeat(Math.max(0, cols - n))
}

export function accountsTone(s: AccountsState, o: AccountsView, now: number): Tone {
  return accountTone(s.limits, { warn: o.warn, urgent: o.urgent, now, recentError: hasRecentError(s, now) && s.lastError?.kind !== undefined })
}

export const toneToCard = (t: ReturnType<typeof accountTone>): Tone => t

function meterRow(c: Ctx, l: Limit, o: AccountsView, stale: string) {
  const { Text } = c.ui
  const lv = meterLevel(l.percent, l.kind === 'seven_day' ? o.weekWarn : o.warn, o.urgent)
  const color = lv === 2 ? 'error' : lv === 1 ? 'warning' : 'success'
  const name = limitName(l.kind).padEnd(7)
  const resets = l.resetsAt ? ` resets ${fmtReset(l.resetsAt, c.now)}` : ''
  const barCols = Math.max(6, Math.min(16, c.room - 28))
  return (
    <Text key={`m-${l.kind}`}>
      {`${name} `}
      <Text color={color}>{`${String(l.percent).padStart(3)}% ${barOf(l.percent, barCols)}`}</Text>
      <Text dimColor>{trunc(`${resets}${stale}`, Math.max(0, c.room - name.length - barCols - 8))}</Text>
    </Text>
  )
}

export function accountsCard(c: Ctx, s: AccountsState, o: AccountsView, a: AccountsActions, extras: { autoLine?: { text: string; isHeld: boolean }; modelLine?: string; modelFlags?: string[]; fellBack?: string; modelButtons?: boolean; folder: string; autoPct?: number }) {
  const { ui, room, now } = c
  const { Box, Button, Text } = ui
  const rows: unknown[] = []
  const known = labelFor(s.rows, s.self, extras.folder)
  const who = s.self?.email ? `${s.self.email}${s.self.plan ? ` (${s.self.plan})` : ''}` : known.label
  rows.push(<Text key="acc-self">{trunc(`This session  ${who}`, room)}</Text>)
  rows.push(<Text key="acc-label" dimColor>{trunc(`${known.isKnown ? `known as ${known.label}` : known.label}, folder ${extras.folder}`, room)}</Text>)

  const stale = s.limitsAt > 0 && now - s.limitsAt > FIFTEEN_MIN ? ` (${ageLabel(s.limitsAt, now)})` : ''
  if (s.limits.length === 0) rows.push(<Text key="acc-nolimits" dimColor>No limit reading yet.</Text>)
  for (const l of s.limits.filter(x => x.kind !== 'spend_limit' || true)) rows.push(meterRow(c, l, o, stale))

  if (s.lastError && hasRecentError(s, now)) {
    const kind = s.lastError.kind
    rows.push(<Text key="acc-err" color={errorClears(kind) ? 'warning' : 'error'}>{trunc(`${kind.replace('_', ' ')} ${ageLabel(s.lastError.at, now)}${errorClears(kind) ? ': clears by itself' : ': needs action'}`, room)}</Text>)
  }
  if (extras.autoLine) rows.push(<Text key="acc-auto" color={extras.autoLine.isHeld ? 'warning' : undefined} dimColor={!extras.autoLine.isHeld}>{trunc(extras.autoLine.text, room)}</Text>)
  if (extras.modelLine) rows.push(<Text key="acc-models" dimColor>{trunc(extras.modelLine, room)}</Text>)
  if (extras.fellBack) rows.push(<Text key="acc-fell" color="warning">{trunc(extras.fellBack, room)}</Text>)
  for (const [i, f] of (extras.modelFlags ?? []).slice(0, 3).entries()) rows.push(<Text key={`acc-flag-${i}`} color="warning">{trunc(f, room)}</Text>)

  const list = rowsWithErrors(s)
  if (list.length > 0) {
    rows.push(<Text key="acc-known" dimColor>Known accounts</Text>)
    const mine = rowFor(list, s.self)
    for (const r of list) rows.push(knownRow(c, r, r === mine || r.label === mine?.label, s, o, a.onMove))
  }

  const { best, line } = swapCandidate(list, s.self, extras.autoPct ?? 94)
  // Every other account is read and full: say why the button is plain.
  if (!best && list.some(r => !rowFor([r], s.self) && r.reading?.week)) rows.push(<Text key="acc-nobest" dimColor>{trunc(`No other account under ${line}%`, room)}</Text>)
  rows.push(
    <Box key="acc-act" flexDirection="row" columnGap={2}>
      <Button key="acct-swap" plain hotkey="a" label={best ? `swap to ${best.label}` : 'swap'} onPress={a.onSwap} />
      <Button key="acct-choose" plain hotkey="s" label="choose" onPress={a.onChoose} />
      <Button key="acct-refresh" plain label="refresh accounts" onPress={a.onRefresh} />
    </Box>,
  )
  if (extras.modelButtons) {
    rows.push(
      <Box key="acc-model-act" flexDirection="row" columnGap={2}>
        <Button key="model-opus" plain label="/model opus" onPress={() => a.onModel('opus')} />
        <Button key="model-sonnet" plain label="/model sonnet" onPress={() => a.onModel('sonnet')} />
      </Box>,
    )
  }
  return card({ ui, id: 'accounts', title: 'Accounts', count: s.limits.find(l => l.kind === 'five_hour') ? `5h ${s.limits.find(l => l.kind === 'five_hour')?.percent}%` : undefined, tone: accountsTone(s, o, now), columns: c.columns, rows })
}

function knownRow(c: Ctx, r: AccountRow, isMine: boolean, s: AccountsState, o: AccountsView, onMove: (label: string) => unknown) {
  const { Button, Text } = c.ui
  const rd = r.reading
  const bits: string[] = []
  if (rd?.email) bits.push(rd.email)
  if (rd?.error === 'billing_error') bits.push('out of credits')
  else if (rd?.session || rd?.week) {
    if (rd.session) bits.push(`5h ${rd.session.percent}%`)
    if (rd.week) bits.push(`wk ${rd.week.percent}%`)
  } else if (r.note) bits.push(r.note)
  else bits.push(rd?.error ? 'unreadable' : 'not read yet')
  if (rd && c.now - rd.at > FIFTEEN_MIN) bits.push(ageLabel(rd.at, c.now))
  const lv = meterLevel(rd?.week?.percent, o.weekWarn, o.urgent)
  const color = rd?.error === 'billing_error' ? 'error' : lv === 2 ? 'error' : lv === 1 ? 'warning' : undefined
  const mark = isMine ? '▸' : ' '
  const line = `${mark} ${r.label}  ${bits.join(' · ')}${isMine ? '  (this session)' : '  · move'}`
  if (isMine) return <Text key={`k-${r.label}`} color={color}>{trunc(line, c.room)}</Text>
  return (
    <Button key={`k-${r.label}`} plain onPress={() => onMove(r.label)}>
      <Text color={color} dimColor={!color}>{trunc(line, c.room)}</Text>
    </Button>
  )
}
