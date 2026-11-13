# dsh-idea

DeepSeek Harness plugin for an idea machine. It adds an **idea** entry to the dsh
sidebar (desktop app and `dsh web`). Inside it is the machine's own dsh: every
project is a workspace there, every task a session, and you watch and steer them
exactly as dsh draws its own sessions (thinking, tool calls, files).

The agents run on the idea machine. This plugin only shows them.

## Install

```sh
dsh plugin add github:popododo0720/Idea#path:/plugins/idea
```

Restart dsh, open **idea** in the sidebar, and enter the machine's address
(`https://<machine>:30443`) and the setup code shown on its console. That pairs
this dsh once; the code is not needed again.

## How it works

```
idea panel (iframe) ──▶ 127.0.0.1:<port> view proxy ──HTTPS, pinned──▶ machine dsh (:30444)
idea panel          ──/idea/*──▶ this plugin ──HTTPS, pinned──▶ machine API (:30443/api/v1)
```

- `lib/client.js` draws the panel: the pairing form, then a full-size iframe.
- `lib/index.js` (host side) answers `/idea/*` behind dsh's own login check
  (`connection.requestRejection`). Pairing sends the setup code once and
  receives a device token; the machine's certificate is pinned at that moment.
- `lib/view-proxy.js` is a reverse proxy on 127.0.0.1. The machine's dsh only
  trusts its own Host name and keeps its login in a `SameSite=Strict` cookie,
  so a page of this dsh cannot frame it directly. The proxy asks the machine
  API for a login (`GET /api/v1/dsh`), keeps that cookie itself, rewrites Host
  and Origin, and pipes WebSockets. It only answers a browser that entered
  through a one-time ticket handed to the panel.
- The pairing (address, certificate, token) is kept in `$DSH_HOME/idea/pairing.json`
  with mode 600. Disconnecting revokes the token on the machine and deletes the file.

No build step: `lib/client.js` is written directly in the client-module format
dsh serves, and React comes from dsh's shared module table.

For development, `IDEA_DEV_DSH_LOGIN=<login URL of a dsh web>` makes the panel
frame that dsh without pairing.
