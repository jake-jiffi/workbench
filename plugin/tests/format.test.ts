import { expect, test } from 'claude-code/testing'

import { ago, contextLevel, countdown, duration, fitLine, kTokens, trunc } from '../hooks/lib/format'
import { countChecks, nextStep, parseWaiting } from '../hooks/lib/github'
import { GAPPED, GAPPED_STATE } from './helpers'

test('formatters', async () => {
  expect(kTokens(182340)).toBe('182.3K')
  expect(kTokens(999)).toBe('999')
  expect(kTokens(1_250_000)).toBe('1.3M')
  expect(duration(3_725_000)).toBe('1h02m')
  expect(duration(192_000)).toBe('3m12s')
  expect(duration(-5)).toBe('0s')
  expect(countdown(212_000)).toBe('3:32')
  expect(countdown(-1)).toBe('0:00')
  expect(ago(30_000)).toBe('now')
  expect(ago(125_000)).toBe('2m')
  expect(ago(7_500_000)).toBe('2h5m')
  expect(trunc('abcdef', 4)).toBe('abc…')
  expect(trunc('abc', 4)).toBe('abc')
  expect(fitLine('xx', 'a very long tail indeed', 14).length).toBeLessThanOrEqual(11)
})

test('context levels follow the settings', async () => {
  expect(contextLevel(undefined, 60, 80)).toBe(0)
  expect(contextLevel(59, 60, 80)).toBe(0)
  expect(contextLevel(60, 60, 80)).toBe(1)
  expect(contextLevel(80, 60, 80)).toBe(2)
  expect(contextLevel(70, 50, 70)).toBe(2)
})

test('github helpers keep their rules', async () => {
  const checks = countChecks(
    [{ name: 'verify', conclusion: 'SUCCESS' }, { name: 'e2e', status: 'QUEUED' }, { name: 'security', conclusion: 'FAILURE' }],
    ['e2e'],
  )
  expect(checks).toEqual({ pass: 1, fail: 1, pending: 0 })
  const pr = { app: 'web', number: 1, title: 't', base: 'main', toProduction: true, author: 'a', isDraft: false, isHeld: false, isBot: false, review: 'APPROVED', checks: { pass: 1, fail: 0, pending: 0 }, url: '' }
  expect(nextStep(pr).rank).toBe(0)
  expect(nextStep({ ...pr, isHeld: true }).label).toBe('on hold')
  expect(parseWaiting('## Waiting on Sam\n\n1. **A thing**: why\n2. plain\n\n## Waiting on Alex\n1. **No**: x', 'Sam')).toEqual(['A thing'])
})

test('parseWaiting keeps every numbered bold line when the numbering has gaps (11 Nov shape)', async () => {
  const items = parseWaiting(GAPPED_STATE, 'Sam')
  expect(items).toHaveLength(11)
  expect(items.map(i => Number(i.replace('Made-up item ', '')))).toEqual(GAPPED)
})
