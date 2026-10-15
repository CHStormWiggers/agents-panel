import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { CommandInfo, On } from 'claude-code'

const COMMANDS: CommandInfo[] = [
  { name: 'anthropic-skills:docx', description: 'Create and edit Word documents', source: 'plugin', plugin: 'anthropic-skills' },
  { name: 'anthropic-skills:ic-invoices', description: 'Create intercompany invoices', source: 'plugin', plugin: 'anthropic-skills' },
  { name: 'browser-harness', description: 'Direct browser control via CDP', source: 'user' },
  { name: 'my-report', description: 'Builds the \u001b[1mmonthly\u001b[0m report', source: 'user' },
  { name: 'compact', description: 'Compact the conversation', source: 'builtin' },
]

// Claude's own record of the account's skills and who made each.
const BASE = 'C:/AppData/Claude/local-agent-mode-sessions/skills-plugin'
const MANIFEST = {
  skills: [
    { name: 'ic-invoices', creatorType: 'user', enabled: true },
    { name: 'my-report', creatorType: 'user', enabled: true },
    { name: 'docx', creatorType: 'anthropic', enabled: true },
  ],
}

// Windows paths, as the mod joins them.
const win = (...parts: string[]) => parts.join('\\')
const OD = win('C:', 'Users', 'me', 'OneDrive - House Of HR NV')
const INVOICES = win(OD, 'Documenten - CO - Consolidatie', 'Admin FI', 'Doorbelastingen', '2026', 'Facturen', '01. Automatisering 181424 doorbelastingen')
const ELSEWHERE = win('D:', 'Reports')

type World = {
  spawned: Record<string, unknown>[]
  registered: string[]
  mode: { value: string }
  sent: { to: string; text: string }[]
  gone: Set<string>
  unlisted: Set<string>
  files: Map<string, string>
}

// Where every chat keeps each agent's last run.
const DATA = win('C:', 'Users', 'me', '.claude', 'agents-panel')
const RUNS = win(DATA, 'runs')
const FOLDERS = `${DATA.split('\\').join('/')}/folders.json`

/** The folders file as the person left it. */
function foldersFile(files: Map<string, string>, chosen: Record<string, string>) {
  files.set(FOLDERS, JSON.stringify(chosen))
}

type WorldOptions = {
  hasManifest?: boolean
  missing?: boolean
  /** This chat's session id. */
  chat?: string
  /** The run files on disk, shared with other chats; a test passes the same map to two chats. */
  files?: Map<string, string>
  /** The session's commands and skills, in place of COMMANDS. */
  commands?: CommandInfo[]
}

function world(
  on: On,
  { hasManifest = true, missing = false, chat = 'chat-1', files = new Map(), commands = COMMANDS }: WorldOptions = {},
): World {
  // The kit hands a spawn over as the Agent tool's parameters (subagent_type, ...).
  const spawned: Record<string, unknown>[] = []
  const registered: string[] = []
  const mode = { value: 'default' }
  const sent: { to: string; text: string }[] = []
  // Agents a message can no longer reach.
  const gone = new Set<string>()
  // Finished agents the engine no longer lists; a message still resumes one from its transcript.
  const unlisted = new Set<string>()
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { APPDATA: 'C:/AppData', OneDriveCommercial: OD, USERPROFILE: win('C:', 'Users', 'me') })
  // Paths reach the hooks in the platform's own spelling.
  const at = (path: string) => path.split('\\').join('/')
  on('fs.exists', (_$, e) => {
    return { value: files.has(at(e.path)) || ([INVOICES, ELSEWHERE].includes(e.path) && !missing) }
  })
  const inData = (path: string) => at(path).startsWith(`${at(DATA)}/`)
  on('fs.list', (_$, e) => ({
    value:
      at(e.path) === at(RUNS)
        ? [...files.keys()]
            .filter(path => path.startsWith(`${at(RUNS)}/`))
            .map(path => ({ name: at(path).split('/').pop(), kind: 'file', size: 1 }))
        : !hasManifest
          ? []
          : at(e.path) === BASE
            ? [{ name: 'account', kind: 'dir', size: 0 }]
            : at(e.path) === `${BASE}/account`
              ? [{ name: 'org', kind: 'dir', size: 0 }]
              : [],
  }) as never)
  on('fs.read', (_$, e) => {
    if (inData(e.path)) {
      const text = files.get(at(e.path))
      return text === undefined ? { deny: 'no such file' } : { value: text }
    }
    return at(e.path) === `${BASE}/account/org/manifest.json` ? { value: JSON.stringify(MANIFEST) } : { deny: 'no such file' }
  })
  on('fs.write', (_$, e) => {
    files.set(at(e.path), e.text)
    return { value: undefined }
  })
  on('session.id', () => ({ value: chat }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.panes', () => ({ value: [] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.focus', () => ({ value: {} }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.list', () => ({ value: commands }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.usage', () => {
    throw new Error('no breakdown in tests')
  })
  on('agent.register', (_$, e) => {
    registered.push(e.name)
    return { value: { agent: `agents-panel:${e.name}` } }
  })
  // Stands for the engine's own spawn: the plugin's guard runs above it.
  on('agent.spawn', (_$, e) => {
    if (mode.value === 'plan') return { deny: 'should have been refused above' }
    spawned.push(e as unknown as Record<string, unknown>)
    return { model: 'claude-sonnet-5-5', agentId: `agent-${spawned.length}` }
  })
  // The kit keeps an agentId only the engine may set; the list is where the mod finds it.
  on('session.send', (_$, e) => {
    if (gone.has(e.to)) return { isDelivered: false, reason: 'no agent by that id' }
    sent.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  on('agent.list', () => ({
    value: spawned
      .map((one, at) => ({
        id: `agent-${at + 1}`,
        description: String(one.description),
        type: String(one.subagent_type ?? 'general-purpose'),
        status: 'running' as const,
        spawnedBy: 'agents-panel',
      }))
      .filter(one => !gone.has(one.id) && !unlisted.has(one.id)),
  }))
  return { spawned, registered, mode, sent, gone, unlisted, files }
}

async function startSession($: Engine, { withTurn = true } = {}) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  // Agent types dispatch from the next main-loop turn on.
  if (withTurn) await $.turn.start({ text: 'hello', turnId: 't0' } as never)
}

const PANE = {
  plugin: 'agents-panel',
  component: 'Pane',
  requestId: 'agents',
  props: {
    title: 'Agents',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** A row's button key, which carries a hash of the skill's full name. */
async function keyOf<P extends 'terminal' | 'desktop'>(ui: Mounted<P, 'Pane'>, prefix: string): Promise<string> {
  const found = (await ui.findAll({ type: 'Button' })).find(one => one.key?.startsWith(prefix))
  expect(found, `button ${prefix}`).toBeDefined()
  return found!.key!
}

async function inputKeyOf<P extends 'terminal' | 'desktop'>(ui: Mounted<P, 'Pane'>, prefix: string): Promise<string> {
  const found = (await ui.findAll({ type: 'Input' })).find(one => one.key?.startsWith(prefix))
  expect(found, `input ${prefix}`).toBeDefined()
  return found!.key!
}

async function finish($: Engine, agentId: string, answer: string) {
  await $.turn.complete({ answer, durationMs: 42_000, isAborted: false, turnId: `t-${agentId}`, agentId, reason: 'answer' })
}

test('only the skills the person made are enlisted, each as an agent type with a unique name', async ($, on) => {
  const { registered } = world(on)
  await startSession($)
  expect(registered).toHaveLength(2)
  expect(registered.some(name => /^anthropic-skills-ic-invoices-[0-9a-z]+$/.test(name))).toBe(true)
  expect(registered.some(name => /^my-report-[0-9a-z]+$/.test(name))).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /docx|browser-harness/ }), 'not made by the person').toBeUndefined()
  expect(await ui.find({ text: /YOURS/ }), 'section').toBeDefined()
})

test("without Claude's record of who made which, the skills in the person's own skills folder are listed", async ($, on) => {
  const { registered } = world(on, { hasManifest: false })
  await startSession($)
  expect(registered).toHaveLength(2)
  expect(registered.some(name => /^my-report-/.test(name))).toBe(true)
  expect(registered.some(name => /^browser-harness-/.test(name))).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /your skills folder/ }), 'section').toBeDefined()
  expect(await ui.find({ text: /docx|ic-invoices/ }), 'plugin skills left out').toBeUndefined()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`run starts the skill as a background agent and shows its report (${surface})`, async ($, on) => {
    const { spawned } = world(on)
    await startSession($)
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ text: /YOURS/ }), 'section').toBeDefined()
    expect(await ui.find({ text: /2 defined/ }), 'count').toBeDefined()
    expect(await ui.find({ text: 'Builds the monthly report' }), 'description cleaned').toBeDefined()

    await ui.input({ key: 'brief-0', text: 'period 09-2026' })
    await ui.press({ key: await keyOf(ui, 'run-my-report-') })

    expect(spawned).toHaveLength(1)
    expect(String(spawned[0]?.subagent_type)).toMatch(/^agents-panel:my-report-/)
    expect(spawned[0]?.run_in_background).toBe(true)
    expect(String(spawned[0]?.prompt).endsWith('YOUR BRIEF\nperiod 09-2026')).toBe(true)
    expect(await ui.find({ text: /running/ }), 'running').toBeDefined()

    await finish($, 'agent-1', '**Result**: report built for 09-2026 \u001b[32mOK\u001b[0m.\n**Files**: /work/report.xlsx')

    expect(await ui.find({ text: /done/ }), 'done').toBeDefined()
    expect(await ui.find({ text: /report built for 09-2026 OK/ }), 'first line, cleaned').toBeDefined()

    await ui.press({ key: await keyOf(ui, 'view-my-report-') })
    expect(await ui.find({ type: 'Markdown', text: /\/work\/report\.xlsx/ }), 'report').toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ text: /2 defined/ }), 'back to the list').toBeDefined()
  })
}

test('a type registered since the last turn runs as a general-purpose agent that loads the skill', async ($, on) => {
  const { spawned } = world(on)
  await startSession($, { withTurn: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: await keyOf(ui, 'run-anthropic-skills-ic-invoices-') })
  expect(spawned).toHaveLength(1)
  expect(spawned[0]?.subagent_type).toBeUndefined()
  expect(String(spawned[0]?.prompt)).toMatch(/Skill tool \(skill: "anthropic-skills:ic-invoices"\)/)
  expect(String(spawned[0]?.prompt)).toMatch(/No brief was given/)
})

test('a double press starts one agent', async ($, on) => {
  const { spawned } = world(on)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const key = await keyOf(ui, 'run-my-report-')
  await Promise.all([ui.press({ key }), ui.press({ key })])
  expect(spawned).toHaveLength(1)
})

test('the model column cycles through the models and the next run uses it', async ($, on) => {
  const { spawned } = world(on)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const model = await keyOf(ui, 'model-anthropic-skills-ic-invoices-')
  await ui.press({ key: model })
  await ui.press({ key: model })
  await ui.press({ key: await keyOf(ui, 'run-anthropic-skills-ic-invoices-') })
  expect(spawned[0]?.model).toBe('sonnet')
})

test('a blocked result is shown as blocked, not done', async ($, on) => {
  world(on)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: await keyOf(ui, 'run-my-report-') })
  await finish($, 'agent-1', '**Result**: blocked: the GL export for 09-2026 is missing.')
  expect(await ui.find({ text: /! blocked/ }), 'blocked').toBeDefined()
})

test("an agent works in the folder the person set for it and is told how the skill's folder terms map onto it", async ($, on) => {
  const files = new Map<string, string>()
  foldersFile(files, { 'ic-invoices': INVOICES })
  const { spawned } = world(on, { files })
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /in OneDrive.*01. Automatisering 181424 doorbelastingen/ }), 'folder shown').toBeDefined()
  await ui.press({ key: await keyOf(ui, 'run-anthropic-skills-ic-invoices-') })
  expect(spawned[0]?.cwd).toBe(INVOICES)
  expect(String(spawned[0]?.prompt)).toContain(`Your working folder is: ${INVOICES}`)
  expect(String(spawned[0]?.prompt)).toContain('~/mnt/<name>')
  expect(String(spawned[0]?.prompt)).toContain('YOUR BRIEF')
})

test('a skill with no folder of its own works in the session folder', async ($, on) => {
  const { spawned } = world(on)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /in session folder/ }), 'folder shown').toBeDefined()
  await ui.press({ key: await keyOf(ui, 'run-my-report-') })
  expect(spawned[0]?.cwd).toBeUndefined()
  expect(String(spawned[0]?.prompt)).toContain("the session's current folder")
})

test('a folder set on the row is saved for later chats and used by the next run', async ($, on) => {
  const { spawned, files } = world(on)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: await keyOf(ui, 'folder-my-report-') })
  // Pasted with quotes and a trailing separator, as Explorer's "Copy as path" gives it.
  await ui.input({ key: await inputKeyOf(ui, 'folder-input-my-report-'), text: `"${ELSEWHERE}\\"` })
  expect(await ui.find({ text: `in ${ELSEWHERE}` }), 'saved').toBeDefined()
  expect(JSON.parse(files.get(FOLDERS) ?? '{}')).toEqual({ 'my-report': ELSEWHERE })
  await ui.press({ key: await keyOf(ui, 'run-my-report-') })
  expect(spawned[0]?.cwd).toBe(ELSEWHERE)

  // Back to the session folder.
  await ui.press({ key: await keyOf(ui, 'folder-my-report-') })
  await ui.press({ key: await keyOf(ui, 'folder-clear-my-report-') })
  expect(JSON.parse(files.get(FOLDERS) ?? '{}')).toEqual({})
})

test('a folder that is not there stops the start', async ($, on) => {
  const files = new Map<string, string>()
  foldersFile(files, { 'ic-invoices': INVOICES })
  const { spawned } = world(on, { missing: true, files })
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: await keyOf(ui, 'run-anthropic-skills-ic-invoices-') })
  expect(spawned).toHaveLength(0)
  expect(await ui.find({ text: /folder not found/ }), 'failed').toBeDefined()
})

const BLOCKED = [
  '**Result**: blocked: 181424 has a column I do not recognise.',
  '**What I did**: read the month file and the 14 analysis files.',
  '**Needs your go-ahead**: is the extra column "Kostdrager" in 181424 expected?',
].join('\n')

test('a reply to an agent that stopped to ask goes to that same agent, which carries on', async ($, on) => {
  const { spawned, sent } = world(on)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: await keyOf(ui, 'run-my-report-') })
  await finish($, 'agent-1', BLOCKED)

  expect(await ui.find({ text: /! blocked/ }), 'row says blocked').toBeDefined()
  expect((await ui.find({ key: await keyOf(ui, 'view-my-report-') }))?.text, 'button').toBe('answer')
  await ui.press({ key: await keyOf(ui, 'view-my-report-') })
  expect(await ui.find({ text: /my-report is waiting for your answer/ }), 'reply prompt').toBeDefined()

  await ui.input({ key: 'reply', text: 'Ja, Kostdrager hoort erbij. Ga door.' })
  expect(sent).toHaveLength(1)
  expect(sent[0]?.to).toBe('agent-1')
  expect(sent[0]?.text).toContain('Ja, Kostdrager hoort erbij. Ga door.')
  expect(spawned).toHaveLength(1)
  expect(await ui.find({ text: /running/ }), 'back to the list, running').toBeDefined()

  await finish($, 'agent-1', '**Result**: done: 14 files appended.\n**Needs your go-ahead**: nothing')
  expect(await ui.find({ text: /✓ done/ }), 'done after the reply').toBeDefined()
  expect((await ui.find({ key: await keyOf(ui, 'view-my-report-') }))?.text, 'button').toBe('report')
})

test('a reply still reaches an agent the engine no longer lists: it resumes from its transcript', async ($, on) => {
  const { spawned, sent, unlisted } = world(on)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: await keyOf(ui, 'run-my-report-') })
  await finish($, 'agent-1', BLOCKED)
  unlisted.add('agent-1')

  await ui.press({ key: await keyOf(ui, 'view-my-report-') })
  await ui.input({ key: 'reply', text: 'Ja, ga door.' })
  expect(sent).toHaveLength(1)
  expect(sent[0]?.to).toBe('agent-1')
  expect(spawned).toHaveLength(1)
})

test('a reply that cannot be delivered starts a new agent from the report and the answer', async ($, on) => {
  const { spawned, sent, gone } = world(on)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: await keyOf(ui, 'run-my-report-') })
  await finish($, 'agent-1', BLOCKED)
  gone.add('agent-1')

  await ui.press({ key: await keyOf(ui, 'view-my-report-') })
  await ui.input({ key: 'reply', text: 'Ja, ga door.' })
  expect(sent).toHaveLength(0)
  expect(spawned).toHaveLength(2)
  const prompt = String(spawned[1]?.prompt)
  expect(prompt).toContain('181424 has a column I do not recognise')
  expect(prompt).toContain('Ja, ga door.')
  expect(prompt).toContain('do not redo finished steps')
})

test('a report that leaves a question asks for an answer; one that leaves nothing does not', async ($, on) => {
  world(on)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: await keyOf(ui, 'run-my-report-') })
  await finish($, 'agent-1', '**Result**: done.\n**Needs your go-ahead**: confirm the period is 10-2026 before I post it.')
  expect(await ui.find({ text: /\? needs your answer/ }), 'asks').toBeDefined()
  await ui.press({ key: await keyOf(ui, 'run-anthropic-skills-ic-invoices-') })
  await finish($, 'agent-2', '**Result**: done.\n**Needs your go-ahead**: Nothing.')
  expect((await ui.find({ key: await keyOf(ui, 'view-my-report-') }))?.text, 'first asks').toBe('answer')
  expect((await ui.find({ key: await keyOf(ui, 'view-anthropic-skills-ic-invoices-') }))?.text, 'second does not').toBe('report')
})

/** A run file as an earlier chat left it. */
function runFile(files: Map<string, string>, skill: string, run: Record<string, unknown>) {
  const name = `${skill.replace(/[^A-Za-z0-9_-]+/g, '-')}-earlier.json`
  files.set(`${RUNS.split('\\').join('/')}/${name}`, JSON.stringify({ skill, run }))
}

test("a run is written to its file, so another chat can show it", async ($, on) => {
  const { files } = world(on)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: await keyOf(ui, 'run-my-report-') })
  await finish($, 'agent-1', BLOCKED)
  const saved = [...files.values()].map(text => JSON.parse(text) as { skill: string; run: Record<string, unknown> })
  const mine = saved.find(one => one.skill === 'my-report')
  expect(mine?.run.status).toBe('done')
  expect(mine?.run.sessionId).toBe('chat-1')
  expect(String(mine?.run.answer)).toContain('181424 has a column I do not recognise')
})

test('a blocked run from an earlier chat is shown, and answering it starts a new agent from its report', async ($, on) => {
  const files = new Map<string, string>()
  runFile(files, 'my-report', {
    status: 'done', startedAt: 900_000, endedAt: 950_000, agentId: 'old-agent', sessionId: 'chat-0', answer: BLOCKED,
  })
  const { spawned, sent } = world(on, { chat: 'chat-1', files })
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /! blocked.*earlier chat/ }), 'shown with its chat').toBeDefined()

  await ui.press({ key: await keyOf(ui, 'view-my-report-') })
  await ui.input({ key: 'reply', text: 'Ja, ga door.' })
  expect(sent, 'an earlier chat\'s agent is not messaged').toHaveLength(0)
  expect(spawned).toHaveLength(1)
  expect(String(spawned[0]?.prompt)).toContain('181424 has a column I do not recognise')
  expect(String(spawned[0]?.prompt)).toContain('Ja, ga door.')
})

test('a run still beating in another chat is shown as running there and is not started twice', async ($, on) => {
  const files = new Map<string, string>()
  runFile(files, 'my-report', { status: 'running', startedAt: 990_000, beat: 995_000, agentId: 'theirs', sessionId: 'chat-0' })
  const { spawned } = world(on, { chat: 'chat-1', files })
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /running in another chat/ }), 'running elsewhere').toBeDefined()
  await ui.press({ key: await keyOf(ui, 'run-my-report-') })
  expect(spawned).toHaveLength(0)
})

test('a run whose chat stopped beating is shown as stopped and can be run again', async ($, on) => {
  const files = new Map<string, string>()
  runFile(files, 'my-report', { status: 'running', startedAt: 600_000, beat: 650_000, agentId: 'theirs', sessionId: 'chat-0' })
  const { spawned } = world(on, { chat: 'chat-1', files })
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /its chat closed before it finished/ }), 'stopped').toBeDefined()
  await ui.press({ key: await keyOf(ui, 'run-my-report-') })
  expect(spawned).toHaveLength(1)
})

test('a folder set in another chat is kept when this chat sets one, and used at once', async ($, on) => {
  const { files, spawned } = world(on)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Another chat sets ic-invoices' folder after this one started.
  foldersFile(files, { 'ic-invoices': INVOICES })
  await ui.press({ key: await keyOf(ui, 'folder-my-report-') })
  await ui.input({ key: await inputKeyOf(ui, 'folder-input-my-report-'), text: ELSEWHERE })
  expect(JSON.parse(files.get(FOLDERS) ?? '{}')).toEqual({ 'ic-invoices': INVOICES, 'my-report': ELSEWHERE })
  await ui.press({ key: await keyOf(ui, 'run-anthropic-skills-ic-invoices-') })
  expect(spawned[0]?.cwd).toBe(INVOICES)
})

test("in a session without the skills Claude's record names (a terminal), the skills folder is listed", async ($, on) => {
  // Claude's record on this PC names ic-invoices and my-report, but this session has neither.
  const { registered } = world(on, {
    commands: [
      { name: 'anthropic-skills:docx', description: 'Create and edit Word documents', source: 'plugin', plugin: 'anthropic-skills' },
      { name: 'browser-harness', description: 'Direct browser control via CDP', source: 'user' },
    ],
  })
  await startSession($)
  expect(registered).toHaveLength(1)
  expect(registered[0]).toMatch(/^browser-harness-/)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /your skills folder/ }), 'section').toBeDefined()
})
