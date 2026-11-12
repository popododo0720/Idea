# Main agent image: dsh + the worker-ssh plugin + an SSH client.
# No desktop, no browser. Build context is the repository root.
# Contains no keys: the SSH private key and model keys are mounted at runtime.

ARG DEBIAN_TAG
FROM docker.io/library/debian:${DEBIAN_TAG}

ARG NODE_VERSION
ARG NODE_SHA256

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git openssh-client procps libatomic1 \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/node.tar.xz \
      "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" \
 && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
      --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE' \
 && rm -f /tmp/node.tar.xz

# Same pinned dsh as the worker image.
COPY images/worker/dsh/package.json images/worker/dsh/package-lock.json /opt/dsh/
RUN cd /opt/dsh \
 && npm ci --no-audit --no-fund \
 && npm cache clean --force \
 && ln -s /opt/dsh/node_modules/.bin/dsh /usr/local/bin/dsh \
 && ln -s /opt/dsh/node_modules/.bin/pnpm /usr/local/bin/pnpm \
 && rm -rf /root/.npm /tmp/*

RUN useradd --create-home --uid 1000 --shell /bin/bash idea

# Plugins are loaded from source by absolute path. They import dsh's own
# packages, which Node resolves through this link to the dsh installation.
COPY plugins/ /opt/idea/plugins/
RUN ln -s /opt/dsh/node_modules /opt/idea/plugins/node_modules
COPY examples/ /opt/idea/examples/

USER 1000:1000
WORKDIR /home/idea
ENV HOME=/home/idea \
    DSH_TELEMETRY_MODE=DISABLED

RUN dsh --profile headless --dump-config >/dev/null \
 && rm -rf /home/idea/.cache /home/idea/.npm /home/idea/.dsh/sessions /home/idea/.dsh/storages \
 && mkdir -p /home/idea/work
COPY --chown=1000:1000 images/main/dsh-home/ /home/idea/.dsh/

CMD ["sleep", "infinity"]
