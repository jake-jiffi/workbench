// Pure formatting helpers: no `$`, so tests call them directly.
//
// `kTokens`, `duration`, `countdown` (their `clock`), `hhmm` and `contextLevel` are adapted from
// terminal-desk, hooks/detect.ts (MIT, Doonminus2). See NOTICE.

export const trunc = (text: string, room: number) => (text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1))}…`)

// Rows must fit one line: a selectable row ignores the surface's own truncation, so lines are sized here.
export const fitLine = (fixed: string, tail: string, room: number) => trunc(tail, Math.max(4, room - fixed.length - 1))

/** 125000 ms -> "2m", 7500000 ms -> "2h5m" (coarse age for worker rows). */
export function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ''}`
}

/** Clock time "14:02" from epoch ms, in local time. */
export function hhmm(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "3:07" for a countdown. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** 182340 -> "182.3K" */
export function kTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}

/** 3725000 -> "1h02m", 192000 -> "3m12s" */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}

/** 0 fine, 1 getting full, 2 nearly full. */
export function contextLevel(percent: number | undefined, warnAt: number, urgentAt: number): 0 | 1 | 2 {
  if (percent === undefined) return 0
  if (percent >= urgentAt) return 2
  if (percent >= warnAt) return 1
  return 0
}

/** Break words into lines of at most `room` characters, for hint text that must not wrap on its own. */
export function wrapWords(text: string, room: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > room) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines.map(l => trunc(l, room))
}
