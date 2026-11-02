import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'conso-live',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

test('the band draws on the terminal and the desktop', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Discussion/ }))?.text).toBe('Discussion')
    expect(await ui.find({ type: 'Button', key: 'details' })).toBeTruthy()
    await ui.unmount()
  }
})

test('a survey keeps the band', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>survey</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, hasSurvey: true } })
  expect((await ui.find({ type: 'Text', text: /survey/ }))?.text).toBe('survey')
  await ui.unmount()
})

test('the band draws limits and context with meters', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  const resetsAt = new Date(Date.now() + 2 * 3600_000).toISOString()
  // @ts-ignore: raised the way the engine raises it
  await $.session.measure({
    context: { window: 200_000, tokens: 68_000, percent: 34 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 42, resetsAt },
      { kind: 'seven_day', percentUsed: 81, resetsAt },
    ],
    changed: [],
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /^42 %$/ }))?.text).toBe('42 %')
    expect((await ui.find({ type: 'Text', text: /^34 %$/ }))?.text).toBe('34 %')
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeTruthy()
    await ui.unmount()
  }
})
