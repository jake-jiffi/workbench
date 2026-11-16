import type { Summary } from './summary'
import type { Ui } from './cards'

// The band above the prompt: one or two rows, no border (rows are scarce). Claude's undone count is amber,
// never red; red is for the owner's items and failures.

export type BandActions = {
  onPane: () => unknown
  onHide: () => unknown
  onFinish: () => unknown
  onClear: () => unknown
  onCompact: () => unknown
  onSwap: () => unknown
}

export function band(ui: Ui, s: Summary, o: BandActions) {
  const { Box, Button, Text } = ui
  return (
    <Box key="band" flexDirection="column">
      <Box key="band-1" flexDirection="row">
        <Text>
          <Text bold>Workbench</Text> <Text color={s.running ? 'warning' : 'subtle'}>{s.running} working</Text>
          <Text dimColor> · PRs </Text>
          <Text color="success">{s.green}✓</Text> <Text color="warning">{s.going}◌</Text> <Text color={s.red ? 'error' : 'subtle'}>{s.red}✗</Text>
          <Text dimColor> · </Text>
          <Text color={s.yours ? 'error' : 'subtle'}>{s.yours} for you</Text>
          <Text dimColor> · </Text>
          <Text color={s.undone ? 'warning' : 'subtle'}>{s.undone} undone</Text>{' '}
        </Text>
        <Button key="open" label="Pane" onPress={o.onPane} />
        <Button key="hide" label="Hide" onPress={o.onHide} />
        {s.undone > 0 ? <Button key="band-finish" plain hotkey="f" label="finish undone" onPress={o.onFinish} /> : null}
      </Box>
      {s.level >= 1 ? (
        <Box key="band-2" flexDirection="row" columnGap={1}>
          <Text color={s.level === 2 ? 'error' : 'warning'}>{`Context ${s.percent}%:`}</Text>
          <Button key="band-clear" plain hotkey="c" label="/clear" onPress={o.onClear} />
          <Button key="band-compact" plain hotkey="k" label="/compact" onPress={o.onCompact} />
        </Box>
      ) : null}
      {s.acct >= 1 ? (
        <Box key="band-3" flexDirection="row" columnGap={1}>
          <Text color={s.acct === 2 ? 'error' : 'warning'}>{s.fiveHour !== undefined ? `Account 5-hour ${s.fiveHour}%:` : 'Account limit:'}</Text>
          <Button key="band-swap" plain hotkey="a" label="swap options" onPress={o.onSwap} />
        </Box>
      ) : null}
    </Box>
  )
}
