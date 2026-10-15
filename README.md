# Agents panel

A Claude Code plugin. Type `/agents-panel` and a panel opens that lists the skills you made, each as an agent with a **▶ run** button.

Pressing **run** starts that skill as a real agent: a subagent with its own context, running in the background while you keep working. It follows the skill as its procedure, checks its own work and ends with a short report.

## What you get

- **Your skills only.** Skills you made in Claude, not Anthropic's or built-in ones. Where the session has no skills from Claude's record of who made which (Claude Code in a terminal, for instance), it lists the skills and custom commands from your own and the open project's Claude folders (`~/.claude/skills`, `~/.claude/commands`, and the project's `.claude/skills` and `.claude/commands`).
- **Live status per agent.** ◌ running with a timer, then ✓ done, ! blocked, ? needs your answer, or ✗ failed, plus a toast and a notification when it ends.
- **Reports and replies.** Press **report** (or **answer** when the agent stopped to ask you something) to read the report in the panel. Type a reply underneath and send it: in the same chat it goes to that agent, which carries on where it stopped; for a run from another chat, a new agent carries on from the report and your answer.
- **A working folder per agent.** Click the `in …` line on a row and paste the folder that agent should work in. Skills written for Cowork's "connected folder" or `~/mnt/<name>` are told that this folder is that one.
- **A model per agent.** Click the model name on a row: inherit, haiku, sonnet or opus.
- **Shared between chats.** Each agent's last run (status and report) and its folder show in every chat. A run still going in another chat shows as "running in another chat".
- **An optional brief.** Type in the field at the top, for example `period 09-2026`, and the next agent you start gets it.

## Install

You need read access to this repository, and Git signed in to GitHub on your PC (the first install opens a GitHub sign-in window if it isn't).

In a Claude Code **terminal** session:

```
/plugin install agents-panel --marketplace CHStormWiggers/agents-panel
```

Answer `y` to add the marketplace, then pick the user scope. Once installed at user scope, it also works in the Claude desktop app's Code tab. Start a new chat after installing.

If that line doesn't work for you, use the two-step form:

```
/plugin marketplace add CHStormWiggers/agents-panel
/plugin install agents-panel@cohedron-plugins
```

**Updates:** run `claude plugin update agents-panel`, then start a new chat.

## Use

1. Type `/agents-panel`. The panel opens; type it again to hide it.
2. Set each agent's working folder: click `in session folder` on its row, paste the folder path, press **save**.
3. Optionally type a brief at the top, then press **▶ run**.
4. When it ends, press **report** or **answer** on its row.

## Good to know

- **Permissions.** Agents use your chat's permission mode. Their permission prompts appear in your main chat, labelled with the agent's name. In plan mode the panel refuses to start an agent, because it could only make a plan. Expect prompts for edits in folders outside your chat's folder.
- **Stop rules win.** When your skill says to stop and ask, the agent stops and puts the question in its report. It doesn't guess past it.
- **Outward actions.** Agents are told not to send mail, publish, delete or pay unless your brief asks for it; they list such steps under "Needs your go-ahead".
- **The first run in a new chat** may use a general-purpose agent that loads the skill itself, because Claude Code accepts newly registered agent types only from the next message on.
- **Your data stays in your profile:** `~/.claude/agents-panel/folders.json` (folders) and `~/.claude/agents-panel/runs/` (each agent's last run). Delete that folder to start fresh. Model choices are kept in the plugin's own settings store; click a row's model until it shows `inherit` to reset it.
- **Early-access API.** The plugin API this is built on may change between Claude Code releases; update the plugin if the panel stops loading after an update.

## Development

From the repository root: `claude plugin validate .` checks the plugin and the marketplace; `claude plugin test .` runs the tests.

`.claude-plugin/plugin.json` deliberately has no `version`: each pushed commit then counts as a new version, so `claude plugin update` always picks it up. If you add a version, bump it with every change, or updates will report "already at the latest version" and keep the old copy.
