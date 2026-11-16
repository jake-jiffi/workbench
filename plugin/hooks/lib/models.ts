import type { Worker } from '../../types'
import { isEnded } from './tones'

// Which model the session runs on and which model each worker runs on. Builders run on Sonnet by default; the rule
// is not enforced here, only shown. There is no API to switch a model, so the
// card offers `/model` as a prompt fill and never changes it.

export const BUILDER_MODEL = 'sonnet'

export const familyOf = (model: string | undefined): string => {
  if (!model) return 'unknown'
  const m = /opus|sonnet|haiku|fable/i.exec(model)
  return m ? m[0].toLowerCase() : model.slice(0, 16)
}

export const isBuilderType = (type: string) => /(?:^|-)builder$/.test(type)

export type ModelSummary = { line: string; flags: Array<{ id: string; text: string }> }

/** "Model opus · agents: 2 sonnet, 1 opus", plus a flag for each builder not on Sonnet. */
export function modelSummary(workers: Worker[], main: string | undefined): ModelSummary {
  const running = workers.filter(w => !isEnded(w.status))
  const counts = new Map<string, number>()
  for (const w of running) counts.set(familyOf(w.model), (counts.get(familyOf(w.model)) ?? 0) + 1)
  const agents = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${n} ${f}`).join(', ')
  const flags = running
    .filter(w => isBuilderType(w.type) && w.model && familyOf(w.model) !== BUILDER_MODEL)
    .map(w => ({ id: w.id, text: `${w.type} ${w.id} is on ${familyOf(w.model)}; the rule is ${BUILDER_MODEL}` }))
  return { line: `Model ${main ? familyOf(main) : 'unknown'}${agents ? ` · agents: ${agents}` : ''}`, flags }
}

/** The plan names that carry Opus and the 1M window. An unknown or smaller plan is flagged on the swap sheet. */
export const planKeepsOpus = (plan: string | undefined) => plan === undefined || /max|team|enterprise/i.test(plan)
