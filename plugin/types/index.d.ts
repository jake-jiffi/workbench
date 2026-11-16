export type Worker = {
  id: string
  description: string
  type: string
  status: string
  startedAt: number
  endedAt?: number
  lastActiveAt?: number
  worktree?: string
  model?: string
  // Set when a failure inside five minutes of an account swap read as an account fault, not a code fault.
  tag?: 'account'
}

// One claude-worker worker, read from its state.json and the name in spec.json. Nothing else of either file is kept.
export type CWorker = {
  id: string
  name: string
  state: string
  account?: string
  reason?: string
  createdAt: number
  // claude-worker rewrites state every 15 seconds while its supervisor lives, so this is also its heartbeat.
  updatedAt: number
  endedAt?: number
  legs: number
}

export type Checks = { pass: number; fail: number; pending: number }

export type Pr = {
  app: string
  number: number
  title: string
  base: string
  // Whether the PR goes into its app's production branch: those need a review and a release.
  toProduction: boolean
  author: string
  isDraft: boolean
  isHeld: boolean
  isBot: boolean
  review: string
  checks: Checks
  url: string
}

// `live` and `head` are short commit ids: what the production branch is at, and what the integration branch is at.
export type Release = { app: string; integration: string; production: string; ahead: number; live: string; head: string }

export type Snapshot = {
  prs: Pr[]
  releases: Release[]
  waiting: string[]
  at: number
  error?: string
}

// Left undone: Claude's own open commitments (kept apart from what is waiting on the owner, which is theirs).
export type UndoneKind = 'report' | 'commit' | 'todo' | 'manual'
export type UndoneTag = 'Not done' | "Couldn't run" | 'Noticed' | 'Said' | 'TODO' | 'Note'
export type UndoneSource = { label: string; agentId?: string; worktree?: string; file?: string }

export type UndoneItem = {
  id: string
  key: string
  kind: UndoneKind
  tag: UndoneTag
  text: string
  sources: UndoneSource[]
  refs: string[]
  confidence: 'high' | 'medium' | 'low'
  firstAt: number
  lastAt: number
  seen: number
  status: 'open' | 'done' | 'dropped'
  resolvedBy?: 'owner' | 'claude' | 'auto'
  resolvedAt?: number
  note?: string
  // Set when a PR this item names has left the open list. Flagged, never auto-cleared.
  flag?: string
  sessionId: string
  // The workspace folder (resolved path) this item belongs to. Absent on items stored before scoping: they show everywhere.
  root?: string
}

export type UndoneStore = {
  v: 1
  counter: number
  items: UndoneItem[]
  // A dropped item leaves its key here so the same words do not bring it back.
  tombstones: Array<{ key: string; at: number; root?: string }>
}

// The pane's small view state (help open, resolved fold open, when 'clear all' was first pressed).
export type UndoneUi = { help: boolean; resolvedOpen: boolean; clearArmedAt: number }

// Context, cache and cost. Plain numbers only: nothing here is conversation text.
export type UsageCategory = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' | 'deferred' }

export type UsageSnapshot = {
  at: number
  startedAt: number
  window: number
  tokens?: number
  percent?: number
  costUsd?: number
  categories: UsageCategory[]
  // The highest warning level already toasted; it drops when the context does.
  level: 0 | 1 | 2
}

export type CacheState = {
  // When the last main-loop response finished: the stand-in for the last cache read or write. null: unknown.
  lastAt: number | null
  // Input side of that response: what the next request re-sends.
  lastContext: number
  isObserved: boolean
  read: number
  total: number
  model?: string
}

// Where the band's counts stood when Hide was pressed.
export type HiddenAt = { red: number; yours: number; undone: number; level: number; acct?: number }

// Accounts. Emails live in memory only; what reaches disk is a one-way hash.
export type Meter = { percent: number; resets?: string }
export type AccountReading = {
  email?: string
  plan?: string
  orgId?: string
  session?: Meter
  week?: Meter
  error?: 'billing_error' | 'authentication_failed' | 'rate_limit' | 'unreadable'
  at: number
}
export type AccountRow = { label: string; dir: string; reading?: AccountReading; note?: string }
export type Limit = { kind: string; percent: number; resetsAt?: string }
export type AccountsState = {
  self?: { email?: string; plan?: string; orgId?: string; dir: string; at: number }
  limits: Limit[]
  limitsAt: number
  rows: AccountRow[]
  lastError?: { kind: string; at: number }
  // Last error seen per account, by email hash. Mirrored in $.store so /clear and a restart keep it.
  seen: Record<string, { kind: string; at: number }>
  // Per meter kind, the warning already toasted: "level@resetsAt".
  warned: Record<string, string>
  probeAt: number
  models: { main?: string; fellBack?: { from: string; to: string; at: number } }
}

// The swap sheet. The mod leaves a move request and fills /exit for the person to press Enter on; the claude
// wrapper reopens the conversation on the other account. It never signs anyone in.
export type SwapResultLine = { text: string; isProblem: boolean }
export type SwapState = {
  isOpen: boolean
  target?: string
  isChoosing: boolean
  // First press on a held swap; a second inside 60 seconds goes ahead.
  armedAt: number
  // When /exit was filled for a move.
  movedAt?: number
  // In the reopened session: poll for the email changing until this time.
  watchUntil: number
  lastWatch: number
  fromEmail?: string
  fromOrg?: string
  changedAt?: number
  result?: { label: string; email?: string; lines: SwapResultLine[] }
}

export type HandoverState = {
  queued?: { at: number; step: 'queued' | 'clear-filled' | 'clear-run' }
  // The owner pressed b twice: the door lets a clear through until this time.
  overrideAt: number
  armedAt: number
  // A brief saved for the next context, and when.
  readyAt?: number
}

export type ContextUi = { showAll: boolean }

export type TaskLine = { id: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'workbench': {
      workers: Shaped<Worker[]>
      cworkers: Shaped<CWorker[]>
      snapshot: Shaped<Snapshot | null>
      bandHiddenAt: Shaped<HiddenAt | null>
      undone: Shaped<UndoneItem[]>
      tasksOpen: Shaped<TaskLine[]>
      undoneUi: Shaped<UndoneUi>
      usage: Shaped<UsageSnapshot | null>
      cache: Shaped<CacheState>
      contextUi: Shaped<ContextUi>
      accounts: Shaped<AccountsState>
      swap: Shaped<SwapState>
      handover: Shaped<HandoverState>
      tick: number
    }
  }
}
