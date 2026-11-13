# Stage 5. dsh and browser control

Date: 2026-11-12
Result: **pass** (5a and 5b pass, 5c works conditionally, 5d works, hooks exist)

## Verification

| Item | Result |
| --- | --- |
| 5a. Headless run with the DeepSeek key | Pass. Reproduced in a fresh pod with no extra preparation |
| 5b. Open a page, read the title, save a screenshot with the desktop Chrome | Pass. Reproduced in a fresh pod |
| 5c. Linux desktop control plugin works on XFCE | Works conditionally (below) |
| 5d. Claude subscription | Works. Delegation succeeded, no conflict with 2 worker pods in use at once |
| dsh hook API | Exists (below) |
| Flux Kustomizations Ready without the API key Secret | Pass. With the Secret deleted and the pod restarted, the pod and all 6 Kustomizations are fine |

## What was actually done

### dsh install (image 0.3.0)

- The only install method in the official repository README is `npx @deepseek-ai/dsh web`. There is no documented way to install a pinned version, so the npm package `@deepseek-ai/dsh@0.2.2-rc.1` was pinned with a lock file (`images/worker/dsh/package-lock.json`) and installed with `npm ci`.
- `dsh plugin` uses pnpm, so `pnpm@11.28.5` (the version pinned by the dsh repository) is in the same lock file.
- `bubblewrap`, used by the dsh Linux tool sandbox, was added with apt.
- Profiles are created at image build time. There is no install step after the pod starts.

| Profile | Content |
| --- | --- |
| `headless` | One task at a time (`dsh headless "<task>"`) + browser control + Claude Code subagent |
| `desk` | `headless` + desktop control |

### 5a. headless

```
dsh headless --approval-policy never "Reply with exactly the single word: pong"
```

- Answer `pong`, exit code 0. First run about 24 seconds (including profile preparation).
- The key comes from the Secret `idea-model-keys` created by `scripts/apply-secrets.sh`, referenced as the pod environment variable `DEEPSEEK_API_KEY` (`optional: true`).
- The shell tool also worked in the default sandbox (`workspace-write`, bubblewrap). It works as non-root inside the Kata guest.
- With `--json`, `tool_call`, `tool_result` and `final` events come out one per line. Completion must be judged on both exit code 0 and `final.reason.kind == "completed"`.

### 5b. Browser control

- Plugins: the official providers in the repository, `@deepseek-ai/dsh-browser-use` + `@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp` (runs Google's `chrome-devtools-mcp@1.9.0`, pinned).
- Settings: `mode: launch`, `headless: false`, `executablePath: /usr/bin/google-chrome`. Chrome opens as a window on the desktop (`DISPLAY=:1`). `--no-sandbox` is not used.
- Result: `new_page` → `evaluate_script` (`document.title` = "Example Domain") → `take_screenshot` (PNG, 75KB saved).
- Screenshot files are only saved under `/tmp`. Saving to the working directory is refused by the MCP server as "outside workspace roots", so the agent saved to `/tmp` and copied.

### 5c. Desktop control

- Plugins: the official providers `@deepseek-ai/dsh-computer-use` + `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native` (bundles `@trycua/cua-driver` 0.28.0).
- **Worked**: listing apps and windows, launching an app (`launch_app`), clicking, typing text, key presses. Without a shell tool it was told to "open a terminal, type a command and press Enter", and the file was actually created.
- **Conditions**:
  - Key presses such as Enter are not delivered in the background and had to be retried with foreground (XTest) delivery.
  - Elements inside windows are not visible (`elements=1`). The accessibility bus (AT-SPI) is not in the image, so control is by window title and coordinates only.
  - Screenshots only reach the model on a model path with image input. On the current DeepSeek path it cannot see the screen and guesses coordinates.
- The upstream docs list real Xorg as "not yet verified" and do not mention XFCE. On Xvnc + XFCE the scope above worked.

### Hook API

Exists. Cordis events that intercept tool calls before and after are defined in `packages/core/tools/src/events.ts`.

| Event | Role |
| --- | --- |
| `tools/pre-execute` | Allow, deny, cancel or ask before execution |
| `tools/execute` | Wraps execution (timeout, retry, instrumentation) |
| `tools/post-execute` | Accept, replace, enrich or block the result |
| `tools/result` | Observe the final result |

- There are agent-level events too: `agent/created`, `agent/pre-step`, `agent/turn-stopping`.
- An official package runs Claude Code's `hooks.json` as is (`@deepseek-ai/dsh-hooks-claude-code`, experimental).

### 5d. Claude subscription

- Plugin to use: the official bundle `@deepseek-ai/dsh-subagent-claude-code`. It drives Claude Code through the official Claude Agent SDK and neither creates nor changes login state. The tool name is `subagent_claude_code`.
- **Not used**: the Anthropic OAuth login in `llm-pi-ai` from the dsh default bundle. Its source mimics Claude Code's client ID and the `user-agent: claude-cli/…` header (the method the plan forbids). The headless profile turns this login path (stored credentials) off by default. Two community plugins using the same method are not used either.
- Injection path: a token the owner creates with `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` in `~/.idea-secrets/env` → `apply-secrets.sh` → Secret → pod environment variable → the profile patch passes it to the subagent's `env` (this provider strips credential-looking environment variables from child processes, so it must be passed explicitly).
- Login was done by the owner on the host with `claude setup-token`. The token went only into `~/.idea-secrets/env`, never through chat or the repository.
- Result: telling `dsh headless` to "delegate to the Claude Code subagent" called the `subagent_claude_code` tool and Claude's answer ("391; I'm Claude (Sonnet).") came back.
- **Concurrent use**: 3 delegations at once from each of 2 worker pods with the same token; all 6 succeeded. The `setup-token` token is a long-lived token used without refresh, so pods do not invalidate each other's refresh tokens (which could happen if several pods shared the login file `~/.claude/.credentials.json`).
- Delegation is one task at a time with no continuation. The subagent's default permission mode is `dontAsk` (anything not already allowed is denied).

## Versions

| Component | Version |
| --- | --- |
| Worker image | 0.3.0 (2.72GB) |
| dsh | 0.2.2-rc.1 (tag `dsh-v0.2.2-rc.1`, commit `66491b05`) |
| pnpm | 11.28.5 |
| Browser, desktop and Claude subagent plugins | 0.2.2-rc.1 (same version as dsh) |
| chrome-devtools-mcp | 1.9.0 (pinned by the provider) |
| cua-driver | 0.28.0 (pinned by the provider) |
| claude-agent-sdk | 0.3.263 (pinned by the provider) |

## Measured memory

| Target | Value |
| --- | --- |
| Node memory used (1 worker pod, idle after a dsh run) | about 2.4GB / 16GB, 12.9GB available |
| Host available memory | 15GB |

## Deviations from the plan

- **Browser plugin choice.** The plan said "start with ones that explicitly name Linux+Chrome". The only ones that do are community plugins (`dsh-ego-browser` and so on): unreviewed third-party code, some with a `--no-sandbox` wrapper. The official provider works on Linux as is, so it was used.
- **Session log upload turned off.** When dsh uses the official DeepSeek API, it uploads session logs (including the code being worked on) with requests by default. Turned off with `enabled: false` for `session-log-deepseek` in the home patch. Telemetry was turned off too with `DSH_TELEMETRY_MODE=DISABLED`.

## Problems and fixes

- **npm blocks install scripts.** npm in Node 26 does not run dependency install scripts by default (5 packages such as `node-pty`, `koffi`). They ship prebuilt binaries, so dsh worked anyway.
- **False positives in the image check.** Public API keys and example tokens inside the plugin packages were flagged by gitleaks. A configuration (`scripts/gitleaks-image.toml`) excludes third-party package trees (`node_modules`, the pnpm store) from the pattern check. The real-value comparison and key-file checks still cover the whole filesystem.
- **Profile patch file.** It contains `[]` by default, so appending breaks it. The whole file is written instead.

## Points for the design

- **dsh states it is a "developer preview" and that compatibility may break.** Pinning the version with a lock file is a must. `SAFETY.md` says not to trust the dsh sandbox alone and to run in a disposable VM. That matches the current layout of running work inside Kata VMs.
- **`dsh headless --json` is enough as the interface for the controller to hand off work.** It opens no port, takes one task, streams events and ends with an exit code. Continuation is `--session-id`.
- **Tool calls that need approval are denied in headless** (`--approval-policy never`). Widening the permission mode inside the worker VM (`DSH_PERMISSION_MODE`) must be decided in stage 6. Since the VM is the isolation boundary, it needs a judgement on whether widening is acceptable.
- **Screen-based control is only useful with an image-input model.** To really use desktop control, look at adding an image-input path and AT-SPI to the image.
- **dsh-yawn is not part of the dsh repository but a third-party distribution.** On Kubernetes it creates sandboxes with the agent-sandbox CRD, and its runner pods use privilege escalation and a privileged sidecar by default. Kata is not mentioned. This is examined in the stage 6 comparison.
- **Whether using a subscription token for automation is within the terms was not checked.** Tested within the scope of one person using their own account. Whether a public distribution should let users use a subscription login needs separate confirmation; keeping the API key as the default path is safer.
- The dsh repository has separate SSH remote execution packages (`dsh-ssh`, `dsh-subprocess-ssh` and so on). Check first whether they can replace the "hand-written SSH plugin" of stage 6.
- The image grew to 2.72GB (dsh and plugins about 1.1GB). First pull takes longer.
