# dsh-idea

DeepSeek Harness plugin for an idea machine. It adds an **idea** entry to the dsh
sidebar (desktop app and `dsh web`). Inside it is the machine's own dsh: every
project is a workspace there, every task a session, and you watch and steer them
exactly as dsh draws its own sessions (thinking, tool calls, files).

The agents run on the idea machine. This plugin only shows them.

## Install

```sh
dsh plugin --profile <your profile> add "github:popododo0720/Idea#path:/plugins/idea"
```

or add the same address on the Plugins page. Running it again updates the
plugin to the latest version. Restart dsh, open **idea** in the sidebar, and enter the machine's address
(`https://<machine>:30443`) and the setup code shown on its console. That pairs
this dsh once; the code is not needed again.

Set up models (DeepSeek key, Claude, other providers) in this dsh's own
**Settings → Models**. The plugin copies them to the machine, so the agents
there use the same models without entering keys twice.

## How it works

```
idea panel (iframe) ──▶ 127.0.0.1:<port> view proxy ──HTTPS, pinned──▶ machine dsh (:30444)
idea panel          ──/idea/*──▶ this plugin ──HTTPS, pinned──▶ machine API (:30443/api/v1)
```

- `lib/client.js` draws the panel: the pairing form, then three tabs.
  **Sessions** is a full-size iframe of the machine's dsh (the main VM or a
  worker VM, picked from a menu like dsh's model picker). **Team** lists every agent (each team member with its role, VM,
  whether it is working, its last message; and the task agents with their
  issue, phase and pull request) next to the messages the agents send each
  other. Picking an agent filters the messages; "Open session" shows that
  VM's dsh, where the agent's whole session is. The owner can stop a
  teammate or delete a team there (its members stop and its messages are
  removed; the sessions stay). Picking a team or a member shows the team's
  task board (To do, Doing, Blocked, Done), and each card says what that
  agent is doing. **Git** works like lazygit, by mouse: on the left the
  changed files (stage, unstage, discard, commit, amend), the branches
  (check out, create, merge, delete; remote branches check out as tracking
  branches), the commits of the picked branch (revert, cherry-pick, new
  branch, copy the SHA) and the stashes (apply, pop, drop); on the right the
  diff of what is picked. It shows the git repositories of this dsh's
  workspaces. The panel uses dsh's design tokens, so it follows the dsh theme
  and font settings.
- `lib/git-local.js` runs the Git tab's commands for this dsh's workspaces.
  A repository is named by its workspace id, never by a path from the
  browser; each command is a fixed argument list run without a shell, branch
  names and commit ids are checked first, and file paths always come after
  `--`. Fetch, pull and push use the person's own git credentials and never
  prompt.
- `lib/team-view.js` builds the Team tab: it reads every VM's team log
  (`/idea-team/log`, written by the machine's idea-team plugin) through the
  view proxies, keeps one copy of each message, and asks each member's dsh
  whether its session is working (`session/state`).
- `lib/index.js` (host side) answers `/idea/*` behind dsh's own login check
  (`connection.requestRejection`). Pairing sends the setup code once and
  receives a device token; the machine's certificate is pinned at that moment.
- `lib/view-proxy.js` is a reverse proxy on 127.0.0.1. The machine's dsh only
  trusts its own Host name and keeps its login in a `SameSite=Strict` cookie,
  so a page of this dsh cannot frame it directly. The proxy asks the machine
  API for a login (`GET /api/v1/dsh`), keeps that cookie itself, rewrites Host
  and Origin, and pipes WebSockets. It only answers a browser that entered
  through a one-time ticket handed to the panel.
- `lib/model-sync.js` copies the models set up in this dsh to the machine's
  dsh: the `llm-deepseek` and `llm-pi-ai` settings sections (DeepSeek, Claude
  and any other provider the Models page adds) and the keys they reference.
  It writes through the machine dsh's own Remote API (`settings/replace`,
  `credentials/set`), at start, after pairing and whenever a model setting or
  key changes here. It only adds and overwrites; nothing set on the machine
  itself is removed.
  The DeepSeek account sign-in goes along too (to the machine dsh's
  idea-machine-sync plugin), so the machine needs no DeepSeek API key.
- `lib/subscriptions-sync.js` keeps the sign-ins of dsh-plugin-subscriptions
  (Claude, ChatGPT/Codex, Grok, Copilot, Antigravity) in step with the
  machine: both sides are merged account by account, the later expiry winning.
  This plugin installs dsh-plugin-subscriptions (pinned) when it is missing.
- The pairing (address, certificate, token) is kept in `$DSH_HOME/idea/pairing.json`
  with mode 600. Disconnecting revokes the token on the machine and deletes the file.

No build step: `lib/client.js` is written directly in the client-module format
dsh serves, and React comes from dsh's shared module table.

For development, `IDEA_DEV_DSH_LOGIN=<login URL of a dsh web>` makes the panel
frame that dsh without pairing.
