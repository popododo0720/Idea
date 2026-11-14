# Worker golden image: Debian + XFCE + VNC + noVNC + Chromium + Node.js + sshd.
# Everything in it may be redistributed (no Google Chrome, no Claude Agent SDK),
# so the image can live in a public registry.
# Runs as a non-root user. Contains no keys, tokens or logged-in state:
# SSH host keys are generated at container start, credentials are mounted.
# Never pass secrets through ARG or ENV.

ARG DEBIAN_TAG
FROM docker.io/library/debian:${DEBIAN_TAG}

ARG NODE_VERSION
ARG NODE_SHA256

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git openssh-server openssh-client \
      procps iproute2 less nano supervisor \
      dbus-x11 xauth x11-xserver-utils xdg-utils \
      xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-settings xfce4-terminal thunar \
      tigervnc-standalone-server novnc websockify \
      fonts-liberation fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

# Chromium from Debian (open source; Google Chrome may not be redistributed).
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium \
 && rm -rf /var/lib/apt/lists/*

# Node.js, pinned by version and checksum.
RUN curl -fsSL -o /tmp/node.tar.xz \
      "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" \
 && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
      --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE' \
 && rm -f /tmp/node.tar.xz

# No baked SSH host keys; one unprivileged user.
# dsh (DeepSeek Harness) and pnpm, pinned by images/worker/dsh/package-lock.json.
# pnpm is what `dsh plugin` uses; bubblewrap is dsh's Linux tool sandbox.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap \
 && rm -rf /var/lib/apt/lists/*
COPY images/worker/dsh/package.json images/worker/dsh/package-lock.json /opt/dsh/
RUN cd /opt/dsh \
 && npm ci --no-audit --no-fund \
 && npm cache clean --force \
 && ln -s /opt/dsh/node_modules/.bin/dsh /usr/local/bin/dsh \
 && ln -s /opt/dsh/node_modules/.bin/pnpm /usr/local/bin/pnpm \
 && rm -rf /root/.npm /tmp/*

# Forgejo Actions runner (used by the runner pod for the test gate).
ARG FORGEJO_RUNNER_VERSION
ARG FORGEJO_RUNNER_SHA256
RUN curl -fsSL -o /usr/local/bin/forgejo-runner \
      "https://code.forgejo.org/forgejo/runner/releases/download/v${FORGEJO_RUNNER_VERSION}/forgejo-runner-${FORGEJO_RUNNER_VERSION}-linux-amd64" \
 && echo "${FORGEJO_RUNNER_SHA256}  /usr/local/bin/forgejo-runner" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/forgejo-runner

# The X server runs unprivileged and cannot create its socket directory.
RUN rm -f /etc/ssh/ssh_host_* \
 && mkdir -p /run/sshd \
 && mkdir -p -m 1777 /tmp/.X11-unix \
 && useradd --create-home --uid 1000 --shell /bin/bash idea

COPY images/worker/rootfs/ /
RUN chmod 0755 /usr/local/bin/idea-entrypoint /usr/local/bin/idea-pr /usr/local/bin/idea-runner \
      /usr/local/bin/idea-claude-subagent /usr/local/bin/idea-dsh

# dsh plugins of the agent dsh (idea-dsh), loaded from source by absolute
# path. They import dsh's own packages, which Node resolves through this link.
COPY plugins/forgejo/ /opt/idea/plugins/forgejo/
COPY plugins/machine-sync/ /opt/idea/plugins/machine-sync/
COPY plugins/team/ /opt/idea/plugins/team/
# dsh-plugin-subscriptions for the agent dsh: installed into its profile (on
# the persistent volume) at start by idea-dsh, at this exact version.
ARG SUBSCRIPTIONS_PLUGIN_VERSION
ENV IDEA_SUBSCRIPTIONS_PLUGIN_VERSION=${SUBSCRIPTIONS_PLUGIN_VERSION}
# dsh-pstack (skills, roles, "Poteto mode" as the default agent preset), the
# same way.
ARG PSTACK_PLUGIN_VERSION
ENV IDEA_PSTACK_PLUGIN_VERSION=${PSTACK_PLUGIN_VERSION}
RUN ln -s /opt/dsh/node_modules /opt/idea/plugins/node_modules

USER 1000:1000
WORKDIR /home/idea
ENV HOME=/home/idea \
    DISPLAY=:1 \
    DSH_TELEMETRY_MODE=DISABLED

# dsh profiles, prepared at build time so a pod needs no install step:
#   headless  one-shot tasks + browser control
#   desk      headless + desktop control
# Plugins are the official packages at the same version as dsh itself.
# The Claude Code subagent is not in the image (its Agent SDK is proprietary);
# a pod that is given a Claude token installs it at start
# (idea-claude-subagent).
ARG DSH_VERSION
ENV DSH_VERSION=${DSH_VERSION}
RUN dsh --profile headless --dump-config >/dev/null \
 && dsh plugin --profile headless add \
      "@deepseek-ai/dsh-browser-use@${DSH_VERSION}" \
      "@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp@${DSH_VERSION}" \
 && dsh --profile desk --from-default-profile headless --dump-config >/dev/null \
 && dsh plugin --profile desk add \
      "@deepseek-ai/dsh-computer-use@${DSH_VERSION}" \
      "@deepseek-ai/dsh-experimental-computer-use-cua-driver-native@${DSH_VERSION}" \
 && rm -rf /home/idea/.cache /home/idea/.npm /home/idea/.local/share/pnpm \
           /home/idea/.dsh/sessions /home/idea/.dsh/storages \
 && mkdir -p /home/idea/work
COPY --chown=1000:1000 images/worker/dsh/home/ /home/idea/.dsh/

# 6080: noVNC (HTTP + WebSocket)   2222: sshd   4443: agent dsh (idea-dsh)
EXPOSE 6080 2222 4443
ENTRYPOINT ["/usr/local/bin/idea-entrypoint"]
