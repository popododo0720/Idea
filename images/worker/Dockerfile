# Worker golden image: Debian + XFCE + VNC + noVNC + Chrome + Node.js + sshd.
# Runs as a non-root user. Contains no keys, tokens or logged-in state:
# SSH host keys are generated at container start, credentials are mounted.
# Never pass secrets through ARG or ENV.

ARG DEBIAN_TAG
FROM docker.io/library/debian:${DEBIAN_TAG}

ARG NODE_VERSION
ARG NODE_SHA256
ARG CHROME_VERSION
ARG CHROME_DEB_SHA256

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

# Google Chrome, pinned by version and checksum. The package's own apt source
# is removed so the browser is never upgraded behind our back.
RUN curl -fsSL -o /tmp/chrome.deb \
      "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}-1_amd64.deb" \
 && echo "${CHROME_DEB_SHA256}  /tmp/chrome.deb" | sha256sum -c - \
 && apt-get update \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -f /tmp/chrome.deb /etc/apt/sources.list.d/google-chrome* /etc/cron.daily/google-chrome \
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
COPY dsh/package.json dsh/package-lock.json /opt/dsh/
RUN cd /opt/dsh \
 && npm ci --no-audit --no-fund \
 && npm cache clean --force \
 && ln -s /opt/dsh/node_modules/.bin/dsh /usr/local/bin/dsh \
 && ln -s /opt/dsh/node_modules/.bin/pnpm /usr/local/bin/pnpm \
 && rm -rf /root/.npm /tmp/*

# The X server runs unprivileged and cannot create its socket directory.
RUN rm -f /etc/ssh/ssh_host_* \
 && mkdir -p /run/sshd \
 && mkdir -p -m 1777 /tmp/.X11-unix \
 && useradd --create-home --uid 1000 --shell /bin/bash idea

COPY rootfs/ /
RUN chmod 0755 /usr/local/bin/idea-entrypoint

USER 1000:1000
WORKDIR /home/idea
ENV HOME=/home/idea \
    DISPLAY=:1 \
    DSH_TELEMETRY_MODE=DISABLED

# 6080: noVNC (HTTP + WebSocket)   2222: sshd
EXPOSE 6080 2222
ENTRYPOINT ["/usr/local/bin/idea-entrypoint"]
