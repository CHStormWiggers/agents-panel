import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentsPanelAgent, AgentsPanelRun } from '../types'

const PLUGIN = 'agents-panel'
const PANE = 'agents'
const COMMAND = 'agents-panel'
const MODELS = ['inherit', 'haiku', 'sonnet', 'opus'] as const
const DOTS = ['#79b8d1', '#e5c07b', '#e0875a', '#c49bbb', '#e06c75', '#9ccc8a', '#8fa9e6', '#d6a35c']
const ACCENT = '#d97757'
const SECTION = '#8fa9e6'
const RUNNING = '#e5c07b'
const DONE = '#9ccc8a'
const FAILED = '#e06c75'
const LOST_AFTER_MS = 30_000

const roster = atom({ plugin: 'agents-panel', key: 'roster' } as const, [])
const runs = atom({ plugin: 'agents-panel', key: 'runs' } as const, {})
const models = atom({ plugin: 'agents-panel', key: 'models' } as const, {})
const brief = atom({ plugin: 'agents-panel', key: 'brief' } as const, '')
const briefGen = atom({ plugin: 'agents-panel', key: 'briefGen' } as const, 0)
const view = atom({ plugin: 'agents-panel', key: 'view' } as const, '')
const folders = atom({ plugin: 'agents-panel', key: 'folders' } as const, {})
const editing = atom({ plugin: 'agents-panel', key: 'editing' } as const, '')
const oneDrive = atom({ plugin: 'agents-panel', key: 'oneDrive' } as const, '')
const sessionId = atom({ plugin: 'agents-panel', key: 'sessionId' } as const, '')
const dataDir = atom({ plugin: 'agents-panel', key: 'dataDir' } as const, '')

// Agent types registered by this load of the module that the Agent tool does
// not dispatch yet: a registered type dispatches from the next main-loop turn.
const fresh = new Set<string>()

// Each agent's last run is kept in a file of its own, so chats share them and
// never overwrite each other's. A chat writes only the runs it started, and
// beats a live one's file every half minute; one silent for two is taken as
// stopped with its chat.
const BEAT_MS = 30_000
const STALE_MS = 120_000
// What this load last wrote per skill, so an unchanged run is not written again.
const written = new Map<string, string>()

// The person's data, in their own profile rather than the plugin's folder:
// `<home>/.claude/agents-panel/`, holding `folders.json` (each agent's working
// folder, by skill name) and `runs/` (each agent's last run).
const FOLDERS_FILE = 'folders.json'
const RUNS_FOLDER = 'runs'

const AGENT_RULES = `How you work:
- Your skill's own rules come first. Where it says to stop and ask the user, or to wait for a confirmation, stop at that point: do not guess past it. Put the question under "Needs your go-ahead" and end your run there.
- Otherwise you own the task end to end. Plan, act with your tools, check your own results, and keep going until the job is done or you hit a real blocker. Do not stop to ask for confirmation of steps your skill already prescribes.
- Nobody watches you live and you cannot ask the user questions mid-run. Where something is ambiguous and your skill does not say to stop, take the most reasonable reading (the skill's defaults, today's date, the files you find), note the assumption, and carry on.
- Stop short of anything irreversible or outward-facing the brief did not explicitly ask for: sending mail or messages, publishing, deleting or overwriting data you did not create, payments. Prepare it, then list it under "Needs your go-ahead".
- Verify before you report: re-read what you produced and run the checks your skill describes.

Your final message is your report to the user. Keep it short and concrete:
**Result**: one or two lines: done, partly done, or blocked, and why.
**What I did**: the key steps.
**Files**: every file you created or changed, with its full path.
**Assumptions**: any you made.
**Needs your go-ahead**: anything left for the user, or "nothing".`

const NO_BRIEF =
  'No brief was given. Run your skill for its usual purpose, right now, in the current working directory, working out the inputs (period, files, targets) yourself.'

function systemPrompt(agent: AgentsPanelAgent): string {
  return `You are the "${agent.label}" agent: an autonomous agent built on the ${agent.skill} skill, which is preloaded in your context. That skill is your operating procedure. If you cannot see it, load it first with the Skill tool (skill: "${agent.skill}").

${agent.description ? `What the skill is for: ${agent.description}\n\n` : ''}${AGENT_RULES}`
}

/** Where the agent works, and how the skill's Cowork terms map onto this PC. */
function workspace(folder: string, root: string): string {
  const where = folder
    ? `Your working folder is: ${folder}
- It is the folder your skill calls "the connected folder" or its project folder (projectmap). Wherever the skill uses ~/mnt/<name>, $HOME/mnt/<name> or mnt/<name>, use this folder instead: it is that folder.`
    : `Your working folder is the session's current folder. If your skill names a connected folder, find it under the OneDrive folder below; if you cannot find it for certain, stop and say so.`
  return `WORKSPACE
${where}
- Paths your skill writes as "OneDrive > A > B" are ${root ? `${root}\\A\\B` : 'under the OneDrive folder in your user profile'} on this PC.
- You run in Claude Code on this computer, not in a Cowork sandbox: there is no device_bash, no ~/mnt and no outputs folder to hand files over through. Use your own shell and file tools, and write results where your skill says, inside the working folder. Keep scratch work in your system temp folder, never in the working folder.
- Tools your skill assumes (python, openpyxl, LibreOffice) may be missing here. Check first; if one is missing and there is no safe substitute, stop and report it.`
}

function fallbackPrompt(agent: AgentsPanelAgent, task: string): string {
  return `You are the "${agent.label}" agent: an autonomous agent built on the ${agent.skill} skill. Start by loading that skill with the Skill tool (skill: "${agent.skill}"), then follow it as your operating procedure.

${AGENT_RULES}

${task}`
}

/** A stable, unique agent-type name for a skill: readable stem plus a hash of the full name. */
function slug(skill: string): string {
  let hash = 2166136261
  for (const char of skill) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
  const stem = skill.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'skill'
  return `${stem}-${hash.toString(36)}`
}

/** Text the engine would refuse to draw: escape sequences and control characters out, newlines kept. */
function clean(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}

function labelOf(skill: string): string {
  const at = skill.lastIndexOf(':')
  return at >= 0 ? skill.slice(at + 1) : skill
}

// Skills the person made in Claude, or, where Claude keeps no record of who
// made which, the skills in the person's own skills folder.
const MINE = 'mine'
const LOCAL = 'local'

function groupTitle(group: string): [string, string] {
  if (group === MINE) return ['YOURS', 'skills you made']
  if (group === LOCAL) return ['YOURS', 'your skills folder']
  return [group.toUpperCase(), '']
}

function dotOf(skill: string): string {
  let hash = 0
  for (const char of skill) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return DOTS[hash % DOTS.length] ?? DOTS[0]!
}

function since(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

function ago(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map(one => one.replace(/[*_`#>]/g, '').trim())
    .find(one => one.length > 0 && !/^result:?$/i.test(one))
  return line ?? ''
}

/** What the agent's own **Result** line says, when it says it fell short. */
function shortfall(answer: string | undefined): 'blocked' | 'partly done' | undefined {
  const line = (answer ?? '').split('\n').find(one => /^\W*result\W*:/i.test(one.trim()))
  if (!line) return undefined
  if (/\bblocked\b/i.test(line)) return 'blocked'
  if (/\bpart(ly|ially)\b/i.test(line)) return 'partly done'
  return undefined
}

/** Whether the report leaves something for the person under "Needs your go-ahead". */
function asksUser(answer: string | undefined): boolean {
  const lines = (answer ?? '').split('\n')
  const at = lines.findIndex(one => /needs your go-ahead/i.test(one))
  if (at < 0) return false
  const rest = [lines[at]!.replace(/^.*needs your go-ahead\W*/i, '')]
  for (const line of lines.slice(at + 1)) {
    if (/^\s*\*\*[^*]+\*\*\s*:/.test(line)) break
    rest.push(line)
  }
  const said = rest.join(' ').replace(/[*_`#>\s.]+/g, ' ').trim()
  return said.length > 0 && !/^(nothing|none|niets|geen|n\/?a)$/i.test(said)
}

function isLive(run: AgentsPanelRun | undefined): boolean {
  return run !== undefined && (run.status === 'starting' || run.status === 'running')
}

/**
 * The names of the skills the person made themselves. Claude keeps a
 * manifest of the account's skills per account and organization, under
 * `<app data>/Claude/local-agent-mode-sessions/skills-plugin/<account>/<org>/`,
 * and marks each one's maker: `creatorType` is `user` for the person's own,
 * `anthropic` for the rest.
 */
async function ownSkills($: EngineInterface): Promise<Set<string>> {
  const appData = await $.env.get('APPDATA')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const roots = [
    appData && `${appData}/Claude`,
    home && `${home}/Library/Application Support/Claude`,
    home && `${home}/.config/Claude`,
  ].filter((one): one is string => Boolean(one))
  const names = new Set<string>()
  for (const root of roots) {
    const base = `${root}/local-agent-mode-sessions/skills-plugin`
    const accounts = await $.fs.list(base).catch(() => [])
    for (const account of accounts.filter(one => one.kind === 'dir')) {
      const orgs = await $.fs.list(`${base}/${account.name}`).catch(() => [])
      for (const org of orgs.filter(one => one.kind === 'dir')) {
        try {
          const manifest = JSON.parse(await $.fs.read(`${base}/${account.name}/${org.name}/manifest.json`)) as {
            skills?: { name?: unknown; creatorType?: unknown; enabled?: unknown }[]
          }
          for (const skill of manifest.skills ?? []) {
            if (skill.creatorType === 'user' && skill.enabled !== false && typeof skill.name === 'string') {
              names.add(skill.name)
            }
          }
        } catch {
          // No manifest here, or one this version cannot read.
        }
      }
    }
  }
  return names
}

/**
 * The skills of this session that the person made, with the typeahead's
 * descriptions. Without Claude's record of who made which (a terminal-only
 * install), the skills from the person's or project's own skills folder.
 */
async function discover($: EngineInterface): Promise<AgentsPanelAgent[]> {
  const commands = await $.command.list()
  const describe = new Map(commands.map(command => [command.name, command.description]))
  let listed: string[] = []
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    listed = (usage.context.breakdown?.skills?.skillFrontmatter ?? []).map(skill => skill.name)
  } catch {
    listed = []
  }
  // The listing can leave skills out past its budget; the typeahead has them all.
  listed.push(...commands.filter(command => command.source === 'user' || command.source === 'plugin').map(command => command.name))
  const own = await ownSkills($)
  const group = own.size > 0 ? MINE : LOCAL
  const local = new Set(commands.filter(command => command.source === 'user').map(command => command.name))
  const isOwn = (name: string) => (group === MINE ? own.has(labelOf(name)) : local.has(name))
  const seen = new Set<string>()
  const agents: AgentsPanelAgent[] = []
  for (const name of listed) {
    const label = labelOf(name)
    if (name === COMMAND || seen.has(label) || !isOwn(name)) continue
    seen.add(label)
    agents.push({ skill: name, label, description: clean(describe.get(name) ?? ''), group })
  }
  return agents.sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Registers one agent type per skill: its own system prompt, the skill
 * preloaded, always in the background. With `isRefresh`, skills that already
 * have a type keep it, so a type the Agent tool dispatches stays dispatchable.
 */
async function enlist($: EngineInterface, isRefresh: boolean): Promise<AgentsPanelAgent[]> {
  const found = await discover($)
  const known = new Map((await read($, roster)).map(agent => [agent.skill, agent]))
  const agents = await Promise.all(
    found.map(async agent => {
      const kept = known.get(agent.skill)?.type
      if (isRefresh && kept) return { ...agent, type: kept }
      try {
        const { agent: type } = await $.agent.register({
          name: slug(agent.skill),
          description: `Runs the ${agent.skill} skill autonomously, end to end, and reports back.`,
          prompt: systemPrompt(agent),
          skills: [agent.skill],
          background: true,
        })
        fresh.add(type)
        return { ...agent, type }
      } catch {
        return { ...agent, type: kept }
      }
    }),
  )
  await update($, roster, () => agents)
  return agents
}

/** The id of this plugin's newest agent with that description that no run holds yet. */
async function findAgentId($: EngineInterface, description: string): Promise<string | undefined> {
  const held = new Set(Object.values(await read($, runs)).map(run => run.agentId))
  const mine = (await $.agent.list()).filter(
    one => one.spawnedBy === PLUGIN && one.description === description && !held.has(one.id),
  )
  return mine[mine.length - 1]?.id
}

// Data paths are joined with "/", which every platform's file APIs take.
async function runsDirOf($: EngineInterface): Promise<string> {
  const data = await read($, dataDir)
  return data ? `${data}/${RUNS_FOLDER}` : ''
}

/**
 * The folders file as it stands: `{}` when there is none yet, undefined when
 * it cannot be read as a map (so a damaged file is never taken for empty).
 */
async function readFoldersFile($: EngineInterface): Promise<Record<string, string> | undefined> {
  const data = await read($, dataDir)
  if (!data) return undefined
  const path = `${data}/${FOLDERS_FILE}`
  if (!(await $.fs.exists(path).catch(() => false))) return {}
  try {
    const kept = JSON.parse(await $.fs.read(path)) as unknown
    if (!kept || typeof kept !== 'object' || Array.isArray(kept)) return undefined
    return Object.fromEntries(
      Object.entries(kept as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  } catch {
    return undefined
  }
}

/** Each agent's working folder, by skill name, as the person last set them in any chat. */
async function loadFolders($: EngineInterface) {
  const onDisk = await readFoldersFile($)
  if (onDisk) await update($, folders, () => onDisk)
}

/** Writes this chat's runs that changed since they were last written. */
async function saveRuns($: EngineInterface) {
  const dir = await runsDirOf($)
  const me = await read($, sessionId)
  if (!dir || !me) return
  for (const [skill, run] of Object.entries(await read($, runs))) {
    if (run.sessionId !== me) continue
    const text = JSON.stringify({ skill, run })
    if (written.get(skill) === text) continue
    try {
      await $.fs.write(`${dir}/${slug(skill)}.json`, text)
      written.set(skill, text)
    } catch {
      // Tried again on the next tick.
    }
  }
}

function isRun(value: unknown): value is AgentsPanelRun {
  if (!value || typeof value !== 'object') return false
  const run = value as Record<string, unknown>
  return typeof run.status === 'string' && typeof run.startedAt === 'number'
}

/**
 * Takes in the runs other chats wrote: the newer of each skill's, though a
 * live run of this chat stays. A live run whose chat stopped beating is shown
 * as stopped.
 */
async function loadRuns($: EngineInterface) {
  const dir = await runsDirOf($)
  const me = await read($, sessionId)
  if (!dir) return
  const now = await $.clock.now()
  const files = await $.fs.list(dir).catch(() => [])
  for (const file of files.filter(one => one.kind === 'file' && one.name.endsWith('.json'))) {
    let skill: unknown
    let run: unknown
    try {
      ;({ skill, run } = JSON.parse(await $.fs.read(`${dir}/${file.name}`)) as { skill?: unknown; run?: unknown })
    } catch {
      continue
    }
    if (typeof skill !== 'string' || !isRun(run) || run.sessionId === me) continue
    const theirs: AgentsPanelRun =
      isLive(run) && now - (run.beat ?? run.startedAt) > STALE_MS
        ? { ...run, status: 'stopped', endedAt: run.beat ?? run.startedAt, error: 'its chat closed before it finished' }
        : run
    await update($, runs, all => {
      const ours = all[skill as string]
      if (ours && ours.sessionId === me && (isLive(ours) || ours.startedAt >= theirs.startedAt)) return all
      if (ours && JSON.stringify(ours) === JSON.stringify(theirs)) return all
      return { ...all, [skill as string]: theirs }
    })
  }
}

async function isPaneShown($: EngineInterface): Promise<boolean> {
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  return pane !== undefined && pane.isShown && pane.isPlaced
}

async function start($: EngineInterface, agent: AgentsPanelAgent, given?: string) {
  const startedAt = await $.clock.now()
  const me = await read($, sessionId)
  // Claim the row in one compare-and-set write, so a double press starts one agent.
  let holder: AgentsPanelRun | undefined
  await update($, runs, all => {
    const current = all[agent.skill]
    holder = isLive(current) ? current : undefined
    return holder ? all : { ...all, [agent.skill]: { status: 'starting' as const, startedAt, sessionId: me } }
  })
  const busy: AgentsPanelRun | undefined = holder
  if (busy) {
    $.ui.toast(
      busy.sessionId && busy.sessionId !== me
        ? `${agent.label} is already running in another chat.`
        : `${agent.label} is already running.`,
    )
    return
  }
  // The agent works in its skill's folder; one that is not there stops the start.
  const root = await read($, oneDrive)
  // The latest folder, even one another chat set a moment ago.
  await loadFolders($).catch(() => undefined)
  const folder = folderOf(agent.label, await read($, folders))
  if (folder && !(await $.fs.exists(folder).catch(() => false))) {
    const now = await $.clock.now()
    await update($, runs, all => ({
      ...all,
      [agent.skill]: { status: 'failed' as const, startedAt, endedAt: now, error: `folder not found: ${folder}`, sessionId: me },
    }))
    $.ui.toast(`${agent.label} could not start: its folder is not there. Click the folder on its row to change it.`)
    return
  }
  // Take the brief in the same way: one run gets it, and the field starts over.
  // A brief handed in (a reply that restarts the agent) leaves the field alone.
  let taken = given ?? ''
  if (given === undefined) {
    await update($, brief, current => {
      taken = current
      return ''
    })
    if (taken.trim()) await update($, briefGen, n => n + 1)
  }
  const task = `${workspace(folder, root)}\n\nYOUR BRIEF\n${taken.trim() || NO_BRIEF}`
  const chosen = (await read($, models))[agent.skill]
  const model = chosen && chosen !== 'inherit' ? chosen : undefined
  const description = `${agent.label} agent`
  const cwd = folder || undefined

  // A type the Agent tool dispatches is the agent proper, and its refusal is
  // final. A type registered since the last turn is not dispatchable yet: a
  // general-purpose agent loads the skill itself instead.
  const isTyped = agent.type !== undefined && !fresh.has(agent.type)
  const spawned = await (isTyped
    ? $.agent.spawn({ prompt: task, description, subagentType: agent.type, model, cwd })
    : $.agent.spawn({ prompt: fallbackPrompt(agent, task), description, model, cwd })
  ).catch((error: unknown) => ({ deny: String(error) }))

  if (spawned.deny !== undefined) {
    const reason = clean(spawned.deny)
    const now = await $.clock.now()
    await update($, runs, all => ({
      ...all,
      [agent.skill]: { status: 'failed' as const, startedAt, endedAt: now, error: reason, sessionId: me },
    }))
    if (given === undefined && taken.trim()) await update($, brief, current => (current.trim() ? current : taken))
    $.ui.toast(`${agent.label} could not start: ${reason}`)
    return
  }
  const agentId = spawned.agentId ?? (await findAgentId($, description).catch(() => undefined))
  await update($, runs, all => {
    const latest = all[agent.skill]
    if (latest && latest.startedAt !== startedAt) return all
    return {
      ...all,
      [agent.skill]: { status: 'running' as const, startedAt, agentId, model: spawned.model ?? model, sessionId: me, beat: startedAt },
    }
  })
  $.ui.toast(`${agent.label} started in the background.`)
  await saveRuns($)
}

/**
 * Answers an agent that ended: the reply goes to that same agent, which picks
 * up with its own context: one that finished is resumed from its transcript.
 * Only when the message cannot be delivered does a new agent take over,
 * starting from the report and the answer.
 */
async function reply($: EngineInterface, agent: AgentsPanelAgent, typed: string) {
  const text = typed.trim()
  if (!text) return
  const now = await $.clock.now()
  const me = await read($, sessionId)
  let ended: AgentsPanelRun | undefined
  await update($, runs, all => {
    const run = all[agent.skill]
    ended = run && !isLive(run) ? run : undefined
    if (!ended) return all
    return {
      ...all,
      [agent.skill]: {
        ...ended,
        status: 'running' as const,
        startedAt: now,
        resumedAt: now,
        beat: now,
        sessionId: me,
        endedAt: undefined,
        previous: ended.answer ?? ended.error,
        answer: undefined,
        error: undefined,
      },
    }
  })
  const before: AgentsPanelRun | undefined = ended
  if (!before) {
    $.ui.toast(`${agent.label} is still running; wait for its report.`)
    return
  }
  await update($, view, () => '')

  const message = `The user's answer to your report, relayed by the Agents panel:

${text}

Continue your task from where you stopped, keeping to your skill's rules, and end with a report in the same format.`
  // A finished agent is resumed from its transcript, listed still or not. A
  // chat reaches only its own agents: one from an earlier chat is carried on
  // by a new agent.
  const agentId = before.agentId
  const isOurs = !before.sessionId || before.sessionId === me
  const sent =
    agentId !== undefined && isOurs
      ? await $.session
          .send({ to: { agentId }, text: message })
          .catch((error: unknown) => ({ isDelivered: false as const, reason: String(error) }))
      : { isDelivered: false as const, reason: isOurs ? 'its run left no agent id' : 'it ran in another chat' }
  if (sent.isDelivered) {
    $.ui.toast(`Sent to ${agent.label}: it carries on in the background.`)
    await saveRuns($)
    return
  }

  // Gone: put the ended run back so a new start can claim the row.
  await update($, runs, all => ({ ...all, [agent.skill]: before }))
  await start(
    $,
    agent,
    `An earlier ${agent.label} agent stopped with this report:

${before.answer ?? before.error ?? '(no report)'}

The user answered:

${text}

Pick up from where that run stopped. Check on disk what it already did before you change anything, and do not redo finished steps.`,
  )
  $.ui.toast(`${agent.label} could not be reached (${clean(sent.reason)}), so a new agent carries on from its report and your answer.`)
  await saveRuns($)
}

async function cycleModel($: EngineInterface, skill: string) {
  const next = await update($, models, all => {
    const at = MODELS.indexOf((all[skill] ?? 'inherit') as (typeof MODELS)[number])
    const model = MODELS[(at + 1) % MODELS.length] ?? 'inherit'
    return { ...all, [skill]: model }
  })
  await $.store.set('models', next)
}

/** The folder an agent works in, as the person set it, or "" for the session's. */
function folderOf(label: string, chosen: Record<string, string>): string {
  return chosen[label] ?? ''
}

/** A folder as a row shows it: OneDrive-relative, the head cut when it is long. */
function shortFolder(folder: string, root: string, room: number): string {
  if (!folder) return 'session folder'
  const shown = root && folder.startsWith(root) ? `OneDrive${folder.slice(root.length)}` : folder
  if (shown.length <= room) return shown
  // Keep the head and as many trailing folders as fit: OneDrive\…\Facturen\01. Automatisering
  const sep = shown.includes('\\') ? '\\' : '/'
  const parts = shown.split(/[\\/]/)
  const head = `${parts[0]}${sep}…`
  let tail = ''
  for (let at = parts.length - 1; at > 0; at -= 1) {
    const next = `${sep}${parts[at]}${tail}`
    if (head.length + next.length > room) break
    tail = next
  }
  return tail ? `${head}${tail}` : `…${shown.slice(shown.length - room + 1)}`
}

/** Sets an agent's working folder; empty sets it back to the session's. */
async function saveFolder($: EngineInterface, label: string, typed: string) {
  const folder = typed.trim().replace(/^["']|["']$/g, '').replace(/[\\/]+$/, '')
  if (folder && !(await $.fs.exists(folder).catch(() => false))) {
    $.ui.toast(`Folder not found: ${folder}`)
    return
  }
  // Merged into the file as it stands now, so a folder another chat set since
  // is kept; a file that cannot be read is left alone and this chat's map used.
  const onDisk = await readFoldersFile($)
  const next = await update($, folders, all => {
    const copy = { ...(onDisk ?? all) }
    if (folder) copy[label] = folder
    else delete copy[label]
    return copy
  })
  const data = await read($, dataDir)
  if (data) {
    await $.fs
      .write(`${data}/${FOLDERS_FILE}`, JSON.stringify(next, null, 2))
      .catch(() => $.ui.toast('The folder is set for this chat, but could not be saved for later ones.'))
  }
  await update($, editing, () => '')
}

async function showReport($: EngineInterface, skill: string) {
  await update($, view, () => skill)
  await $.ui.focus({ requestId: PANE, key: 'back' }).catch(() => undefined)
}

async function openPanel($: EngineInterface) {
  const hasRoster = (await read($, roster)).length > 0
  const agents = hasRoster ? await read($, roster) : await enlist($, false)
  const opened = await $.ui.open({ id: PANE, title: 'Agents', focus: true })
  // The other chats' latest runs and folders, without holding the panel up for them.
  void loadRuns($).catch(() => undefined)
  void loadFolders($).catch(() => undefined)
  if (hasRoster) {
    // Pick up skills added since, without holding the panel up for it.
    void enlist($, true)
      .then(() => $.ui.invalidate('ui.render'))
      .catch(() => undefined)
  }
  return { opened, count: agents.length }
}

/** Settles a live run with no agent id: found in the engine's list, or given up on. */
async function settleLost($: EngineInterface, skill: string, run: AgentsPanelRun, now: number) {
  if (now - run.startedAt < LOST_AFTER_MS) return
  const found = await findAgentId($, `${labelOf(skill)} agent`).catch(() => undefined)
  await update($, runs, all => {
    const latest = all[skill]
    if (!latest || !isLive(latest) || latest.agentId !== undefined || latest.startedAt !== run.startedAt) return all
    return {
      ...all,
      [skill]: found
        ? { ...latest, status: 'running' as const, agentId: found }
        : {
            ...latest,
            status: 'failed' as const,
            endedAt: now,
            error: 'lost track of this run while it started; check the tasks list',
          },
    }
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: COMMAND,
      description: 'Show or hide the Agents panel: every skill as a one-click background agent',
      immediate: true,
    })
    const kept = await $.store.get('models')
    if (kept && typeof kept === 'object') {
      await update($, models, current => ({ ...(kept as Record<string, string>), ...current }))
    }
    const profile = await $.env.get('USERPROFILE')
    const root = (await $.env.get('OneDriveCommercial')) ?? (await $.env.get('OneDrive')) ?? ''
    await update($, oneDrive, () => root.replace(/[\\/]+$/, ''))
    // Folders and runs live in the person's profile, shared by every chat.
    const me = await $.session.id().catch(() => '')
    await update($, sessionId, () => me)
    const home = profile ?? (await $.env.get('HOME'))
    if (home) await update($, dataDir, () => `${home.replace(/[\\/]+$/, '')}/.claude/agents-panel`)
    await loadFolders($)
    await loadRuns($).catch(() => undefined)
    try {
      await enlist($, false)
    } catch (error) {
      $.ui.log(`agents-panel: could not list skills yet (${String(error)}); /agents-panel retries`, { to: 'debug' })
    }

    // Each second: write this chat's changed runs. While an agent runs: redraw
    // the clock, beat its file, and every few seconds reconcile with the
    // engine's own record in case an end went unseen; a run another chat has
    // going is read again from its file. With none running, read the other
    // chats' runs each minute and redraw now and then so "ago" stays true.
    let ticks = 0
    $.clock.every(1000, async () => {
      ticks += 1
      await saveRuns($)
      const me = await read($, sessionId)
      const others = Object.values(await read($, runs)).some(
        run => isLive(run) && run.sessionId !== undefined && run.sessionId !== me,
      )
      if ((others && ticks % 5 === 0) || ticks % 60 === 0) await loadRuns($).catch(() => undefined)
      if (ticks % 60 === 0) await loadFolders($).catch(() => undefined)
      const current = await read($, runs)
      const live = Object.entries(current).filter(
        ([, run]) => isLive(run) && (run.sessionId === undefined || run.sessionId === me),
      )
      if (ticks % (BEAT_MS / 1000) === 0 && live.length > 0) {
        const beat = await $.clock.now()
        await update($, runs, latest => {
          const beaten = { ...latest }
          for (const [skill] of live) {
            const run = beaten[skill]
            if (run && isLive(run)) beaten[skill] = { ...run, beat }
          }
          return beaten
        })
      }
      if (others) $.ui.invalidate('ui.render')
      if (live.length === 0) {
        if (ticks % 30 === 0 && Object.values(current).some(run => run.endedAt !== undefined)) {
          $.ui.invalidate('ui.render')
        }
        return
      }
      $.ui.invalidate('ui.render')
      if (ticks % 5 !== 0) return
      const listed = new Map((await $.agent.list()).map(agent => [agent.id, agent.status]))
      const now = await $.clock.now()
      for (const [skill, run] of live) {
        // A resumed agent can still read as completed until its new turn starts.
        if (run.resumedAt !== undefined && now - run.resumedAt < 20_000) continue
        if (run.agentId === undefined) {
          await settleLost($, skill, run, now)
          continue
        }
        const status = listed.get(run.agentId)
        const ended =
          status === 'failed'
            ? ('failed' as const)
            : status === 'killed'
              ? ('stopped' as const)
              : status === 'completed'
                ? ('done' as const)
                : undefined
        if (ended === undefined) continue
        await update($, runs, all => {
          const latest = all[skill]
          if (!latest || !isLive(latest) || latest.agentId !== run.agentId) return all
          return {
            ...all,
            [skill]: {
              ...latest,
              status: ended,
              endedAt: now,
              answer:
                latest.answer ??
                (ended === 'done' ? 'The agent finished; its report is in its transcript (open it from the tasks list).' : undefined),
            },
          }
        })
      }
    })

    return started
  })

  // A main-loop turn makes every type registered before it dispatchable.
  on('turn.start', ($, e, next) => {
    fresh.clear()
    return next(e)
  })

  // The agent types are the panel's to start; they stay out of the model's
  // listing so forty skills do not crowd every request.
  on('agent.offer', { agent: /^agents-panel:/ }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))

  // An agent started from the panel inherits the session's permission mode.
  // In plan mode it could only write a plan and would report "done": refuse
  // the start with the reason instead.
  on('agent.spawn', ($, e, next) =>
    next.origin.plugin === PLUGIN && e.permissionMode === 'plan'
      ? { deny: 'plan mode is on; leave it (shift+tab) and press run again' }
      : next(e),
  ).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async $ => {
    if (await isPaneShown($)) {
      await $.ui.close({ id: PANE })
      return { text: 'Agents panel hidden.' }
    }
    const { opened, count } = await openPanel($)
    if (!opened.isPlaced) return { text: 'Agents panel is open but has no room to show; widen the window.' }
    return { text: `Agents panel opened: ${count} agents.` }
  })

  // A run ends in the subagent's own turn.complete, carrying its agentId.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) return result
    const current = await read($, runs)
    const entry = Object.entries(current).find(([, run]) => run.agentId === e.agentId)
    if (!entry) return result
    const [skill, run] = entry
    const status: AgentsPanelRun['status'] = e.isAborted ? 'stopped' : e.reason === 'answer' ? 'done' : 'failed'
    const now = await $.clock.now()
    const answer = clean(e.answer)
    await update($, runs, all => {
      const latest = all[skill] ?? run
      return { ...all, [skill]: { ...latest, status, endedAt: now, answer, model: e.usage?.model ?? latest.model } }
    })
    // The report is what another chat answers, so it is written at once.
    await saveRuns($).catch(() => undefined)
    const label = labelOf(skill)
    const asks = status === 'done' && (shortfall(answer) !== undefined || asksUser(answer))
    const word =
      status === 'stopped'
        ? 'was stopped'
        : status === 'failed'
          ? 'failed'
          : (shortfall(answer) ?? (asks ? 'needs your answer' : 'finished'))
    const button = asks ? 'answer' : 'report'
    const where = (await isPaneShown($).catch(() => false))
      ? `press ${button} on its row in the Agents panel`
      : `type /agents-panel, then press ${button}`
    $.ui.toast(`${label} ${word} after ${since(now - run.startedAt)}: ${where}.`, { timeoutMs: 8000 })
    void $.ui.notify(`${label} ${word}`, { title: 'Agents' }).catch(() => undefined)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const width = Math.max(30, e.props.bodyColumns)
    const allRuns = await read($, runs)
    const shown = await read($, view)
    const report = shown ? allRuns[shown] : undefined

    if (shown && report) {
      const text = clean(report.answer || report.error || 'No report yet.')
      const agent = (await read($, roster)).find(one => one.skill === shown)
      const asks = shortfall(report.answer) !== undefined || asksUser(report.answer)
      // Text fields exist on every surface but mobile.
      const ReplyInput =
        e.surface === 'terminal' || e.surface === 'desktop' || e.surface === 'vscode' ? $.ui.resolve(e).Input : undefined
      const canReply = agent !== undefined && !isLive(report) && ReplyInput !== undefined
      return (
        <Box flexDirection="column" width={width}>
          <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
            <Text>
              <Text color={ACCENT}>◆ </Text>
              <Text bold>{labelOf(shown)}</Text>
              <Text dimColor> · report</Text>
            </Text>
            <Box flexDirection="row">
              <Button key="copy" label="copy" dimColor onPress={press => void $.ui.copy({ text, surface: press.surface })} />
              <Button key="back" label="back" onPress={() => update($, view, () => '')} />
            </Box>
          </Box>
          <Markdown key="report" text={text} />
          {canReply && agent && ReplyInput ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={asks ? RUNNING : SECTION} bold>
                {asks ? `${agent.label} is waiting for your answer` : `Reply to ${agent.label}`}
              </Text>
              <ReplyInput
                key="reply"
                placeholder={
                  asks ? 'Your answer; the agent carries on from where it stopped' : 'Ask it to do more; it carries on with what it knows'
                }
                submitLabel="send"
                autoFocus={asks ? true : undefined}
                onSubmit={typed => reply($, agent, typed)}
              />
            </Box>
          ) : null}
        </Box>
      )
    }

    const agents = await read($, roster)
    const chosen = await read($, models)
    const gen = await read($, briefGen)
    const chosenFolders = await read($, folders)
    const root = await read($, oneDrive)
    const editingLabel = await read($, editing)
    const me = await read($, sessionId)
    // Text fields exist on every surface but mobile.
    const Input =
      e.surface === 'terminal' || e.surface === 'desktop' || e.surface === 'vscode' ? $.ui.resolve(e).Input : undefined
    const now = await $.clock.now()
    const liveCount = Object.values(allRuns).filter(isLive).length

    const groups: { group: string; agents: AgentsPanelAgent[] }[] = []
    for (const agent of agents) {
      const last = groups[groups.length - 1]
      if (last && last.group === agent.group) last.agents.push(agent)
      else groups.push({ group: agent.group, agents: [agent] })
    }

    const briefField = Input ? (
      <Box marginBottom={1}>
        <Input
          key={`brief-${gen}`}
          placeholder="Brief for the next agent you start (optional), e.g. period 09-2026"
          submitLabel="set"
          onInput={text => update($, brief, () => text)}
          onSubmit={text => {
            void update($, brief, () => text)
            if (text.trim()) $.ui.toast('Brief set: the next agent you start gets it.')
          }}
        />
      </Box>
    ) : null

    function folderLine(agent: AgentsPanelAgent, id: string) {
      const folder = folderOf(agent.label, chosenFolders)
      if (Input && editingLabel === agent.label) {
        return (
          <Box key={`folder-edit-${id}`} flexDirection="column">
            <Input
              key={`folder-input-${id}`}
              label="Folder"
              placeholder="Full path of the folder this agent works in; empty = the session folder"
              value={folder}
              submitLabel="save"
              autoFocus
              onSubmit={text => saveFolder($, agent.label, text)}
            />
            <Box flexDirection="row">
              {folder ? (
                <Button key={`folder-clear-${id}`} label="session folder" dimColor onPress={() => saveFolder($, agent.label, '')} />
              ) : null}
              <Button key={`folder-cancel-${id}`} label="cancel" dimColor onPress={() => update($, editing, () => '')} />
            </Box>
          </Box>
        )
      }
      return (
        <Button
          key={`folder-${id}`}
          plain
          dimColor
          onPress={() =>
            Input ? update($, editing, () => agent.label) : $.ui.toast('Change folders from the desktop app or the terminal.')
          }
        >
          {`in ${shortFolder(folder, root, Math.max(20, width - 4))}`}
        </Button>
      )
    }

    function row(agent: AgentsPanelAgent) {
      const id = slug(agent.skill)
      const run = allRuns[agent.skill]
      const model = chosen[agent.skill] ?? 'inherit'
      const live = isLive(run)
      // A run another chat started: it is shown here, and runs or is answered there.
      const elsewhere = run?.sessionId !== undefined && me !== '' && run.sessionId !== me
      let status: JSX.Element | null = null
      if (run && live) {
        status = (
          <Text color={RUNNING} wrap="truncate-end">
            ◌ {run.status === 'starting' ? 'starting' : 'running'}
            {elsewhere ? ' in another chat' : ''} · {since(now - run.startedAt)}
            {run.model ? ` · ${run.model}` : ''}
          </Text>
        )
      } else if (run && run.status === 'done') {
        const short = shortfall(run.answer) ?? (asksUser(run.answer) ? 'needs your answer' : undefined)
        status = (
          <Text color={short ? RUNNING : DONE} wrap="truncate-end">
            {short ? `${short === 'needs your answer' ? '?' : '!'} ${short}` : '✓ done'} in {since((run.endedAt ?? now) - run.startedAt)} · {ago(now - (run.endedAt ?? now))}
            {elsewhere ? ' · earlier chat' : ''}
            {run.answer ? <Text dimColor> · {firstLine(clean(run.answer))}</Text> : ''}
          </Text>
        )
      } else if (run) {
        status = (
          <Text color={FAILED} wrap="truncate-end">
            ✗ {run.status === 'stopped' ? 'stopped' : 'failed'}
            {elsewhere ? ' · earlier chat' : ''}
            {run.error ? ` · ${clean(run.error)}` : run.answer ? ` · ${firstLine(clean(run.answer))}` : ''}
          </Text>
        )
      }

      return (
        <Box key={`row-${id}`} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row" flexShrink={1}>
              <Text color={live ? RUNNING : dotOf(agent.skill)}>● </Text>
              <Text bold wrap="truncate-end">
                {agent.label}
              </Text>
              <Text> </Text>
              <Button key={`model-${id}`} plain dimColor onPress={() => cycleModel($, agent.skill)}>
                {model}
              </Button>
            </Box>
            <Box flexDirection="row" flexShrink={0}>
              {run && !live && (run.answer || run.error) ? (
                shortfall(run.answer) !== undefined || asksUser(run.answer) ? (
                  <Button key={`view-${id}`} label="answer" variant="primary" onPress={() => showReport($, agent.skill)} />
                ) : (
                  <Button key={`view-${id}`} label="report" dimColor onPress={() => showReport($, agent.skill)} />
                )
              ) : null}
              <Button
                key={`run-${id}`}
                label={live ? '◌ running' : '▶ run'}
                dimColor={live}
                onPress={() => start($, agent)}
              />
            </Box>
          </Box>
          <Text dimColor wrap="truncate-end">
            {agent.description || 'No description.'}
          </Text>
          {folderLine(agent, id)}
          {status}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Text>
            <Text color={ACCENT}>◆ </Text>
            <Text bold>Agents</Text>
            <Text dimColor> from your skills</Text>
          </Text>
          <Text dimColor>
            {liveCount > 0 ? `${liveCount} running · ` : ''}
            {agents.length} defined
          </Text>
        </Box>
        {briefField}
        {agents.length === 0 ? <Text dimColor>No skills of your own found yet. Skills you make in Claude, or put in ~/.claude/skills, show up here; run /agents-panel again once the session has started.</Text> : null}
        {groups.map(({ group, agents: members }) => {
          const [title, where] = groupTitle(group)
          return (
            <Box key={`group-${slug(group)}`} flexDirection="column">
              <Box marginBottom={1}>
                <Text>
                  <Text bold color={SECTION}>
                    {title}
                  </Text>
                  <Text dimColor>
                    {' '}
                    {where ? `${where} · ` : ''}
                    {members.length}
                  </Text>
                </Text>
              </Box>
              {members.map(row)}
            </Box>
          )
        })}
        <Text dimColor>click ▶ run to start one · click a model or folder to change it · /agents-panel to hide</Text>
      </Box>
    )
  })
}
