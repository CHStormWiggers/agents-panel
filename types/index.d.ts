export type AgentsPanelAgent = {
  /** The skill's name as /skills lists it (`anthropic-skills:docx`). */
  skill: string
  /** What the panel calls it: the skill name without its plugin prefix. */
  label: string
  /** The agent type registered for it, `agents-panel:<slug>`, once registered. */
  type?: string
  description: string
  /** Section key: `user`, `project`, `plugin:<name>`, `built-in`, ... */
  group: string
}

export type AgentsPanelRunStatus = 'starting' | 'running' | 'done' | 'failed' | 'stopped'

export type AgentsPanelRun = {
  agentId?: string
  status: AgentsPanelRunStatus
  startedAt: number
  endedAt?: number
  model?: string
  answer?: string
  error?: string
  /** When the person last replied and the agent took up its task again. */
  resumedAt?: number
  /** The report the person replied to. */
  previous?: string
  /** The chat (session id) that started it and keeps its file. */
  sessionId?: string
  /** When that chat last said a live run is still going. */
  beat?: number
}

declare module 'claude-code' {
  interface PluginState {
    'agents-panel': {
      roster: AgentsPanelAgent[]
      runs: Record<string, AgentsPanelRun>
      models: Record<string, string>
      brief: string
      briefGen: number
      view: string
      /** Each agent's working folder by skill label; absent is the session's folder. */
      folders: Record<string, string>
      /** The skill label whose folder is being edited, or "". */
      editing: string
      /** The OneDrive root on this PC. */
      oneDrive: string
      /** This chat's session id. */
      sessionId: string
      /** The person's agents-panel data folder (folders.json, runs/), shared by every chat. */
      dataDir: string
    }
  }
}
