# dsh-idea

DeepSeek Harness plugin for an idea machine. It adds an **idea** panel to the dsh
sidebar (desktop app and `dsh web`): projects, their tasks, what the agents did,
and the controls: new project, new task, retry a failed task with an extra
instruction, stop a running one, model keys, paired devices.

The agents run on the idea machine. This plugin only shows and steers them.

## Install

```sh
dsh plugin add github:popododo0720/Idea#path:/plugins/idea
```

Restart dsh, open the **idea** panel in the sidebar, and enter the machine's
address (`https://<machine>:30443`) and the setup code shown on its console.
That pairs this dsh once; the code is not needed again.

## How it works

- `lib/client.js` draws the panel. It calls `/idea/*` on the local dsh only.
- `lib/index.js` (host side) answers those calls behind dsh's own login check
  (`connection.requestRejection`) and forwards an allowlist of them to the
  machine's API (`/api/v1`, see `controller/api.go`).
- Pairing sends the setup code once and receives a device token. The machine's
  certificate is pinned at that moment; later calls accept only that certificate.
- The pairing (address, certificate, token) is kept in `$DSH_HOME/idea/pairing.json`
  with mode 600. Unpairing revokes the token on the machine and deletes the file.

No build step: `lib/client.js` is written directly in the client-module format
dsh serves, and React comes from dsh's shared module table.
