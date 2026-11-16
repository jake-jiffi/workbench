import type { EngineInterface } from 'claude-code'

// Limit, account and model toasts share one budget: at most one per turn. The caller marks a warning as given
// only when this returned true, so a toast held back by the cap is tried again on the next reading.
let isUsed = false

export function limitToast($: EngineInterface, text: string): boolean {
  if (isUsed) return false
  isUsed = true
  $.ui.toast(text)
  return true
}

export const resetToastCap = () => {
  isUsed = false
}
