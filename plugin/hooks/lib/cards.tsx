import { trunc } from './format'

// The card system. A card is a rounded box with a coloured title row and its rows beneath.
// The idea of one bordered box per section, its colour carrying meaning, is from terminal-desk,
// hooks/register.tsx (MIT, Doonminus2). See NOTICE. The code here is our own.

export type Tone = 'quiet' | 'warn' | 'act' | 'ok'

// Red ('error') is only for "a person must act now". Quiet things are grey.
export const TONE_COLOR: Record<Tone, string> = { quiet: 'subtle', warn: 'warning', act: 'error', ok: 'success' }

// Below this many columns a border and its padding cost too much: the card is a bold title and its rows.
export const NARROW_COLUMNS = 44

export const isNarrow = (columns: number) => columns < NARROW_COLUMNS

// Room for a row inside a card: the border takes two columns and the padding two more.
export const innerWidth = (columns: number) => (isNarrow(columns) ? columns : columns - 4)

// The resolved element table of the surface drawing: Box, Text, Button.
export type Ui = { Box: any; Text: any; Button: any }

export type CardProps = {
  ui: Ui
  id: string
  title: string
  count?: string
  hint?: string
  tone: Tone
  columns: number
  // 'bold' draws the heavy border the alert card uses.
  isHeavy?: boolean
  rows: unknown[]
}

export function card({ ui, id, title, count, hint, tone, columns, isHeavy, rows }: CardProps) {
  const { Box, Text } = ui
  const color = TONE_COLOR[tone]
  const room = innerWidth(columns)
  const head = `${title}${count ? ` ${count}` : ''}`
  const room4hint = room - head.length - 2
  const shownHint = hint && room4hint >= 4 ? trunc(hint, room4hint) : ''

  const titleRow = (
    <Box key={`${id}-title`} flexDirection="row" justifyContent="space-between">
      <Text>
        <Text bold color={color}>{title}</Text>
        {count ? <Text dimColor>{` ${count}`}</Text> : null}
      </Text>
      {shownHint ? <Text dimColor>{shownHint}</Text> : null}
    </Box>
  )

  if (isNarrow(columns)) {
    return (
      <Box key={id} flexDirection="column">
        <Text bold color={color}>{trunc(head, room)}</Text>
        {rows}
      </Box>
    )
  }
  return (
    <Box key={id} flexDirection="column" borderStyle={isHeavy ? 'bold' : 'round'} borderColor={color} paddingX={1}>
      {titleRow}
      {rows}
    </Box>
  )
}
