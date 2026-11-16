import type { AccountReading, AccountRow, Limit, Meter } from '../../types'

// Which Claude account this session uses, and how full each account's limits are. Pure functions only.
//
// Nothing here opens a login file or handles a login. The mod learns an account only from what the claude
// binary prints about itself (`claude auth status`, `claude -p /usage`): an email, a plan name, two
// percentages and two reset times. Everything else in that output is thrown away at parse time.
// Accounts are keyed on email, never on the folder name: a login inside a session changes the account a
// folder holds, so a label that trusts the folder goes wrong the moment someone logs in.

export const FIFTEEN_MIN = 15 * 60_000

export type AccountConfig = { label: string; dir: string }

/** `main=~/.claude, work=~/.claude-work` into rows. `~` becomes `home`. Bad entries are skipped. */
export function parseAccountList(text: string, home: string): AccountConfig[] {
  const out: AccountConfig[] = []
  for (const part of text.split(/[;,\n]/)) {
    const [label, ...rest] = part.split('=')
    const dir = rest.join('=').trim()
    if (!label?.trim() || !dir) continue
    if (/[\s"'`$|&<>]/.test(label.trim())) continue
    out.push({ label: label.trim(), dir: dir.replace(/^~(?=\/|$)/, home) })
  }
  return out.slice(0, 8)
}

/** `work=out of credits 4 Nov` into a map of notes shown until a reading replaces them. */
export function parseNotes(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of text.split(/[;\n]/)) {
    const [label, ...rest] = part.split('=')
    const note = rest.join('=').trim()
    if (label?.trim() && note) out[label.trim()] = note.slice(0, 60)
  }
  return out
}

// ---------- parsing what the binary prints ----------

const METER = /^\s*Current (session|week \(all models\))[^:\n]*:\s*(\d{1,3})%\s*used(?:\s*[·•-]\s*resets\s+([^\n]+?))?\s*$/i

const ERRORS: Array<{ re: RegExp; kind: NonNullable<AccountReading['error']> }> = [
  { re: /credit|billing|payment|out of (?:extra )?usage|spend limit|plan limit/i, kind: 'billing_error' },
  { re: /log(?:ged)? ?in|sign(?:ed)? ?in|auth|expired|token|401/i, kind: 'authentication_failed' },
  { re: /rate.?limit|too many requests|429|overload/i, kind: 'rate_limit' },
]

export type UsageParse = { session?: Meter; week?: Meter; error?: AccountReading['error'] }

/**
 * The "Current session" and "Current week (all models)" lines of `claude -p /usage`, and nothing else.
 * No lines at all: an error kind if the text reads like one, else 'unreadable'. The text itself is not kept.
 */
export function parseUsageLines(text: string): UsageParse {
  const out: UsageParse = {}
  for (const line of text.split('\n')) {
    const m = METER.exec(line)
    if (!m) continue
    const percent = Math.min(100, Number(m[2]))
    const meter: Meter = { percent, resets: m[3]?.trim().slice(0, 48) }
    if ((m[1] ?? '').toLowerCase() === 'session') out.session = meter
    else out.week = meter
  }
  if (!out.session && !out.week) {
    if (!text.trim()) out.error = 'unreadable'
    else out.error = ERRORS.find(e => e.re.test(text))?.kind ?? 'unreadable'
  }
  return out
}

export type AuthParse = { loggedIn: boolean; email?: string; plan?: string; orgId?: string }

/** `claude auth status --json`: the email, the plan and an org id for comparing. Every other field is dropped. */
export function parseAuthStatus(text: string): AuthParse | null {
  try {
    const d = JSON.parse(text) as Record<string, unknown>
    if (typeof d !== 'object' || d === null) return null
    const email = typeof d.email === 'string' && /^[^@\s]+@[^@\s]+$/.test(d.email) ? d.email.toLowerCase() : undefined
    return {
      loggedIn: d.loggedIn === true,
      email,
      plan: typeof d.subscriptionType === 'string' ? d.subscriptionType.slice(0, 20) : undefined,
      orgId: typeof d.orgId === 'string' ? d.orgId.slice(0, 64) : undefined,
    }
  } catch {
    return null
  }
}

/** A short one-way hash of an email, so an error can be remembered on disk without writing the address. */
export function emailKey(email: string): string {
  let h = 0x811c9dc5
  for (const c of email.trim().toLowerCase()) {
    h ^= c.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// ---------- choosing and labelling ----------

/**
 * What to call this session's account: the configured label of the row whose learned email matches, else
 * "not in your list" with the folder. The folder name alone never names an account.
 */
export function labelFor(rows: AccountRow[], self: Who | undefined, folder: string): { label: string; isKnown: boolean } {
  const row = rowFor(rows, self)
  return row ? { label: row.label, isKnown: true } : { label: self?.email ? 'not in your list' : `account unknown (${folder})`, isKnown: false }
}

export type Who = { email?: string; orgId?: string }

/**
 * Whether two readings are one account: the same email, and the same organisation when both are known. A team
 * plan and a personal plan can share an email, so the email alone is not enough.
 */
export const isSameAccount = (a: Who | undefined, b: Who | undefined) =>
  Boolean(a?.email && a.email === b?.email && (!a.orgId || !b.orgId || a.orgId === b.orgId))

/** The row that is the session's account, or null: "not in your list". */
export function rowFor(rows: AccountRow[], self?: Who): AccountRow | null {
  return rows.find(r => isSameAccount(r.reading, self)) ?? null
}

export const isOutOfCredits = (row: AccountRow) => row.reading?.error === 'billing_error' || Boolean(row.note && /credit/i.test(row.note) && !row.reading?.week)

const readable = (r: AccountRow) => r.reading?.week !== undefined && r.reading.error === undefined

/** Lowest weekly percent among the other rows that can be read and are not out of credits. */
export function bestAccount(rows: AccountRow[], self?: Who): AccountRow | null {
  const others = rows.filter(r => !isSameAccount(r.reading, self) && readable(r) && !isOutOfCredits(r))
  others.sort((a, b) => (a.reading?.week?.percent ?? 100) - (b.reading?.week?.percent ?? 100) || (a.reading?.session?.percent ?? 100) - (b.reading?.session?.percent ?? 100))
  return others[0] ?? null
}

/**
 * The account to offer for a swap: the best other account that is under the auto-move line (`pct`) on both the
 * 5-hour and the weekly meter. `best` is null when every other account is at or over the line (or none can be
 * read); the card then says "No other account under N%". An off line (0) still never offers an account at 100.
 */
export function swapCandidate(rows: AccountRow[], self: Who | undefined, pct: number): { best: AccountRow | null; line: number } {
  const line = pct > 0 ? pct : 100
  const isUnder = (r: AccountRow) => (r.reading?.session?.percent ?? 0) < line && (r.reading?.week?.percent ?? 100) < line
  return { best: bestAccount(rows.filter(isUnder), self), line }
}

// ---------- tone ----------

export type Level = 0 | 1 | 2

export const meterLevel = (percent: number | undefined, warn: number, urgent: number): Level => (percent === undefined ? 0 : percent >= urgent ? 2 : percent >= warn ? 1 : 0)

/** Minutes until a reset time, when it is an ISO time. Raw text from a probe has none. */
export const minutesToReset = (resetsAt: string | undefined, now: number): number | undefined => {
  if (!resetsAt) return undefined
  const t = Date.parse(resetsAt)
  return Number.isNaN(t) ? undefined : Math.round((t - now) / 60_000)
}

/**
 * Green under the warning on both meters. Amber at the warning, or over 95 with the window resetting in under
 * 30 minutes (the wait is short). Red at the urgent line, or after a billing, auth or rate-limit error just
 * seen. Grey when nothing can be read.
 */
export function accountTone(limits: Limit[], o: { warn: number; urgent: number; now: number; recentError?: boolean }): 'ok' | 'warn' | 'act' | 'quiet' {
  if (o.recentError) return 'act'
  if (limits.length === 0) return 'quiet'
  let level: Level = 0
  for (const l of limits) {
    const lv = meterLevel(l.percent, o.warn, o.urgent)
    if (lv > level) level = lv
    const mins = minutesToReset(l.resetsAt, o.now)
    if (l.percent >= 95 && mins !== undefined && mins < 30 && level === 2) level = 1
  }
  return level === 2 ? 'act' : level === 1 ? 'warn' : 'ok'
}

export const ageLabel = (at: number, now: number) => {
  const m = Math.floor((now - at) / 60_000)
  return m < 1 ? 'now' : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`
}

/** Which error kinds clear by themselves and which need a person. */
export const errorClears = (kind: string) => kind === 'rate_limit' || kind === 'overloaded' || kind === 'server_error'
export const errorNeedsAction = (kind: string) => kind === 'billing_error' || kind === 'authentication_failed'

export const throttleOk = (lastAt: number, now: number, minutes: number, force = false) => force || lastAt === 0 || now - lastAt >= minutes * 60_000
