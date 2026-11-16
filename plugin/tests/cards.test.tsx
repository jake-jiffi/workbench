import { expect, test } from 'claude-code/testing'

import { GAPPED_STATE, PANE, PRS, STATE, check, engine } from './helpers'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

type Node = { type: string; props: Record<string, any>; children: unknown[] }

// Every Box and Text in the drawn tree, by walking it.
function walk(node: unknown, found: Node[] = []): Node[] {
  if (node && typeof node === 'object' && 'type' in node) {
    const n = node as Node
    found.push(n)
    for (const child of n.children ?? []) walk(child, found)
  }
  return found
}

async function mountPane($: any, surface: (typeof SURFACES)[number], columns = 90) {
  const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: columns } })
  await ui.press({ key: 'refresh' })
  return ui
}

test('every surface accepts the card tree and draws round borders', async ($: any, on: any) => {
  engine(on)
  await $.session.start({ cwd: '/work/acme', surface: 'terminal', isInteractive: true })
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const boxes = (await ui.findAll({ type: 'Box' })).filter((b: Node) => b.props.borderStyle)
    expect(boxes.length).toBeGreaterThanOrEqual(4)
    for (const b of boxes) expect(b.props.borderStyle).toBe('round')
    await ui.unmount()
  }
})

test('nothing inside a card is wider than the card', async ($: any, on: any) => {
  engine(on)
  await $.session.start({ cwd: '/work/acme', surface: 'terminal', isInteractive: true })
  for (const columns of [60, 90, 120]) {
    const ui = await mountPane($, 'terminal', columns)
    for (const t of await ui.findAll({ type: 'Text' })) expect(t.text.length).toBeLessThanOrEqual(columns - 4)
    await ui.unmount()
  }
})

test('a 40 column pane draws no borders and still shows the text', async ($: any, on: any) => {
  engine(on)
  await $.session.start({ cwd: '/work/acme', surface: 'terminal', isInteractive: true })
  const ui = await mountPane($, 'terminal', 40)
  const boxes = (await ui.findAll({ type: 'Box' })).filter((b: Node) => b.props.borderStyle)
  expect(boxes).toHaveLength(0)
  const texts = (await ui.findAll({ type: 'Text' })).map((t: Node & { text: string }) => t.text).join('\n')
  expect(texts).toContain('Waiting on Sam')
  expect(texts).toContain('Web release timing')
  for (const t of await ui.findAll({ type: 'Text' })) expect(`${t.text.length > 40 ? t.text : ''}`).toBe('')
  await ui.unmount()
})

const borderOf = async (ui: any, title: string) => {
  const tree = await ui.drawn()
  const cardBox = walk(tree).find(n => n.type === 'Box' && n.props.borderStyle && JSON.stringify(n.children).includes(`"${title}"`))
  return cardBox?.props.borderColor as string | undefined
}

test('red borders only where a person must act', async ($: any, on: any) => {
  // Nothing waits on Sam, no PR is approved, no CI is red, no worker is stuck.
  const quietPrs = { 'acme/web-app': [PRS['acme/web-app']![0]], 'acme/mobile-app': [] }
  engine(on, (_: unknown, e: { argv: string[] }) => {
    const argv = e.argv
    if (argv.includes('list')) {
      const repo = argv[argv.indexOf('--repo') + 1] ?? ''
      return { value: { exitCode: 0, stdout: JSON.stringify((quietPrs as Record<string, unknown[]>)[repo] ?? []), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 0, stdout: JSON.stringify({ ahead: 3, live: 'a', head: 'b' }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  }, '# State\n\n## Waiting on Sam\n\nNothing.\n')
  await $.session.start({ cwd: '/work/acme', surface: 'terminal', isInteractive: true })
  const ui = await mountPane($, 'terminal')
  for (const title of ['Waiting on Sam', 'Workers', 'Pull requests', 'Production']) expect(await borderOf(ui, title)).not.toBe('error')
  expect(await borderOf(ui, 'Waiting on Sam')).toBe('subtle')
  await ui.unmount()
})

test('red borders appear for a waiting item, an approved PR or red CI', async ($: any, on: any) => {
  engine(on)
  await $.session.start({ cwd: '/work/acme', surface: 'terminal', isInteractive: true })
  const ui = await mountPane($, 'terminal')
  expect(await borderOf(ui, 'Waiting on Sam')).toBe('error')
  expect(await borderOf(ui, 'Pull requests')).toBe('error')
  expect(await borderOf(ui, 'Production')).toBe('subtle')
  await ui.unmount()
})

test('a running PR is amber, not red', async ($: any, on: any) => {
  const running = [{ number: 5, title: 'Build', baseRefName: 'staging', author: { login: 'sam-dev' }, isDraft: false, reviewDecision: '',
    statusCheckRollup: [check('verify', '', 'IN_PROGRESS')], url: 'https://github.com/x/5' }]
  engine(on, (_: unknown, e: { argv: string[] }) => e.argv.includes('list')
    ? { value: { exitCode: 0, stdout: JSON.stringify(e.argv.includes('acme/web-app') ? running : []), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    : { value: { exitCode: 0, stdout: JSON.stringify({ ahead: 0, live: 'a', head: 'a' }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }, STATE)
  await $.session.start({ cwd: '/work/acme', surface: 'terminal', isInteractive: true })
  const ui = await mountPane($, 'terminal')
  expect(await borderOf(ui, 'Pull requests')).toBe('warning')
  await ui.unmount()
})

test('the Waiting on Sam count and its rows agree: nine rows, then "and 2 more" for the other two of eleven', async ($: any, on: any) => {
  engine(on, undefined, GAPPED_STATE)
  await $.session.start({ cwd: '/work/acme', surface: 'terminal', isInteractive: true })
  const ui = await mountPane($, 'terminal', 120)
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => String(t.text ?? ''))
  const card = (await ui.findAll({ type: 'Box' })).find((b: Node) => b.props.borderStyle && JSON.stringify(b.children).includes('"Waiting on Sam"'))
  expect(String(card?.text)).toContain('Waiting on Sam 11')
  const rows = texts.filter((t: string) => /Made-up item \d+/.test(t))
  expect(rows).toHaveLength(9)
  expect(texts.filter((t: string) => /^and \d+ more/.test(t))).toEqual(['and 2 more (STATE.md)'])
  // Nothing is lost: rows shown + the "more" count is the header count.
  expect(rows.length + 2).toBe(11)
  await ui.unmount()
})

test('with nine or fewer waiting items there is no "more" line', async ($: any, on: any) => {
  engine(on)
  await $.session.start({ cwd: '/work/acme', surface: 'terminal', isInteractive: true })
  const ui = await mountPane($, 'terminal', 120)
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => String(t.text ?? ''))
  expect(texts.filter((t: string) => /^and \d+ more \(STATE/.test(t))).toEqual([])
  await ui.unmount()
})
