import { expect, test } from 'claude-code/testing'

import { PANE, STATE, engine, PRS } from './helpers'

test('the pane shows workers, PRs by next step, releases and what waits on Sam, on every surface', async ($: any, on: any) => {
  engine(on)
  await $.session.start({ cwd: '/work/acme', surface: 'desktop', isInteractive: true })
  await ($.agent as any).spawn({ prompt: 'Work in ~/work/acme/worktrees/web/chore-workspace-layout', description: 'Web PR: workspace layout', subagentType: 'web-builder' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })

    const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('\n')
    expect(texts).toContain('Web PR: workspace layout')
    expect(texts).toContain('web/chore-workspace-layout')
    // The mobile app's engine and e2e have no runner: two green checks make it green.
    expect(texts).toMatch(/green: ready to merge/)
    expect(texts).toContain('approved: merge and release')
    expect(texts).toContain('CI red')
    expect(texts).toContain('29 commits to release')
    expect(texts).toContain('Web release timing')
    expect(texts).not.toContain("Not Sam's")
    // A bot's bump is one quiet line, never its own red row.
    expect(texts).toContain('1 dependency bump from bots, 1 with CI red')
    expect(texts).not.toContain('#8')
    // A PR labelled hold says so instead of "ready to merge".
    expect(texts).toMatch(/#206 → staging\s+on hold/)
    // Every row fits one line: no text element on a row is wider than the pane's body.
    for (const t of await ui.findAll({ type: 'Text' })) expect(t.text.length).toBeLessThanOrEqual(PANE.props.bodyColumns - 4)

    // Most urgent first: the approved release, then the red PR, then the green ones.
    const order = ['#198', '#122', '#197'].map(n => texts.indexOf(n))
    expect(order[0]).toBeLessThan(order[1] ?? 0)
    expect(order[1]).toBeLessThan(order[2] ?? 0)
    await ui.unmount()
  }
})

test('a GitHub failure keeps the last PRs and says what went wrong', async ($: any, on: any) => {
  let isDown = false
  engine(on, (_, e) =>
    isDown
      ? { value: { exitCode: 1, stdout: '', stderr: 'HTTP 502 from api.github.com', isStdoutTruncated: false, isStderrTruncated: false } }
      : { value: { exitCode: 0, stdout: JSON.stringify(e.argv.includes('list') ? PRS['acme/web-app'] : { ahead: 1, live: 'a', head: 'b' }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } },
  )
  await $.session.start({ cwd: '/work/acme', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  isDown = true
  await ui.press({ key: 'refresh' })

  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('\n')
  expect(texts).toContain('#197')
  expect(texts).toContain('HTTP 502')
  await ui.unmount()
})
