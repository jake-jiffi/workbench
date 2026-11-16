import { expect, test } from 'claude-code/testing'

import { seen, spawn } from './helpers'
import { OPTIONS, SPAWN, iso, measure, mountPane, setup, texts } from './kit'
import { familyOf, isBuilderType, modelSummary, planKeepsOpus } from '../hooks/lib/models'
import { swapChecks } from '../hooks/lib/swap'

const SWITCH = (source: string, from = 'claude-opus-4-1-20250805', to = 'claude-sonnet-4-5') => ({
  from_model: from, to_model: to, requested_model: null, source, context_tokens: 100_000, prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 0.2, pricing: 'default',
})

test('a fallback to another model (source auto) toasts once and shows on the card', async ($: any, on: any) => {
  await setup($, on, { quiet: true })
  await $.classic.PostModelSwitch(SWITCH('auto'))
  expect(seen.toasts.filter(t => t.startsWith('Fell back'))).toEqual(['Fell back from opus to sonnet (auto). Likely limits.'])
  const ui = await mountPane($)
  const t = await texts(ui)
  expect(t).toContain('Fell back from opus to sonnet (auto)')
  expect(t).toContain('Model sonnet')
  await ui.unmount()
})

test('a switch Sam made is not a warning', async ($: any, on: any) => {
  await setup($, on, { quiet: true })
  await $.classic.PostModelSwitch(SWITCH('command'))
  await $.classic.PostModelSwitch(SWITCH('picker'))
  expect(seen.toasts.filter(t => t.startsWith('Fell back'))).toEqual([])
})

test('a builder spawned on a model other than Sonnet is an amber line item', async ($: any, on: any) => {
  await setup($, on, { quiet: true })
  spawn.model = 'claude-opus-4-1'
  await $.agent.spawn(SPAWN)
  const ui = await mountPane($)
  const rows = await ui.findAll({ type: 'Text' })
  const flag = rows.find((x: any) => x.text.includes('is on opus; the rule is sonnet'))
  expect(flag?.text).toContain('web-builder agent-1')
  expect(flag?.props.color).toBe('warning')
  expect(await texts(ui)).toContain('agents: 1 opus')
  await ui.unmount()
})

test('a builder on Sonnet raises no flag', async ($: any, on: any) => {
  await setup($, on, { quiet: true })
  spawn.model = 'claude-sonnet-4-5'
  await $.agent.spawn(SPAWN)
  const ui = await mountPane($)
  const t = await texts(ui)
  expect(t).toContain('agents: 1 sonnet')
  expect(t).not.toContain('the rule is')
  await ui.unmount()
})

test('/model opus and /model sonnet are filled, never run', async ($: any, on: any) => {
  await setup($, on, { quiet: true })
  const ui = await mountPane($)
  await ui.press({ key: 'model-sonnet' })
  await ui.press({ key: 'model-opus' })
  expect(seen.filled).toEqual(['/model sonnet', '/model opus'])
  expect(seen.submitted).toEqual([])
  await ui.unmount()
})

test('the limit toast offers the cheaper move: stay on the account, move the orchestrator to Sonnet', async ($: any, on: any) => {
  await setup($, on, { quiet: true })
  await measure($, [{ kind: 'seven_day', percentUsed: 92, resetsAt: iso(48 * 3600_000) }])
  const t = seen.toasts.at(-1) ?? ''
  expect(t).toContain('Or /model sonnet: the cache stays warm, a swap makes it cold.')
})

test('a target on a smaller plan is flagged on the swap sheet', { options: OPTIONS }, async () => {
  const w = swapChecks({ workers: [], isRelease: false, selfOrg: 'o', target: { at: 1, orgId: 'o', plan: 'pro' } })
  expect(w.warnings.join(' ')).toContain('may not include Opus or the 1M window')
  expect(swapChecks({ workers: [], isRelease: false, selfOrg: 'o', target: { at: 1, orgId: 'o', plan: 'max' } }).warnings.join(' ')).not.toContain('Opus')
})

test('pure: families, builder types, summary, plans', async () => {
  expect(familyOf('claude-opus-4-1-20250805')).toBe('opus')
  expect(familyOf('claude-sonnet-4-5')).toBe('sonnet')
  expect(familyOf(undefined)).toBe('unknown')
  expect(isBuilderType('web-builder')).toBe(true)
  expect(isBuilderType('mobile-builder')).toBe(true)
  expect(isBuilderType('critic')).toBe(false)
  const w = (id: string, type: string, model: string, status = 'running') => ({ id, description: 'x', type, status, startedAt: 1, model })
  const s = modelSummary([w('a', 'web-builder', 'claude-sonnet-4-5'), w('b', 'critic', 'claude-opus-4-1'), w('c', 'web-builder', 'claude-opus-4-1', 'completed')], 'claude-opus-4-1')
  expect(s.line).toBe('Model opus · agents: 1 sonnet, 1 opus')
  expect(s.flags).toEqual([])
  expect(planKeepsOpus('max')).toBe(true)
  expect(planKeepsOpus(undefined)).toBe(true)
  expect(planKeepsOpus('pro')).toBe(false)
})
