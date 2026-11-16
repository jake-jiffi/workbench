import type { CWorker, Pr, Worker } from '../../types'
import { ci, nextStep } from './github'
import type { Tone } from './cards'

export const QUIET_MS = 10 * 60_000
export const RECENT_MS = 3 * 3600_000
export const ENDED = ['completed', 'failed', 'killed']
export const isEnded = (status: string) => ENDED.includes(status)

export const isQuietWorker = (w: Worker, now: number) => !isEnded(w.status) && now - (w.lastActiveAt ?? w.startedAt) > QUIET_MS

// Red is only for what a person must act on now. These return the card's tone.

export const waitingTone = (count: number): Tone => (count > 0 ? 'act' : 'quiet')

export function workersTone(list: Worker[], now: number, cw: CWorker[] = []): Tone {
  const hasTrouble =
    list.some(w => isQuietWorker(w, now) || (w.status === 'failed' && w.tag !== 'account' && now - (w.endedAt ?? now) < RECENT_MS)) ||
    cw.some(w => (w.state === 'running' && now - w.updatedAt > 60_000) || (w.state === 'failed' && now - (w.endedAt ?? now) < RECENT_MS))
  return hasTrouble ? 'warn' : 'quiet'
}

export function prsTone(prs: Pr[]): Tone {
  const live = prs.filter(p => !p.isBot)
  if (live.some(p => nextStep(p).rank <= 1)) return 'act'
  if (live.some(p => !p.isHeld && ci(p.checks) === 'running')) return 'warn'
  return 'quiet'
}
