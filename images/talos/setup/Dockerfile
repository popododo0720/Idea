# Talos system extension "idea-setup": two extension services that share one
# small root filesystem (busybox, talosctl, the scripts, the config patches).
ARG BUSYBOX_IMAGE
# The -musl variant is statically linked; the extension root has no libc.
FROM ${BUSYBOX_IMAGE}-musl AS root
RUN mkdir -p /r/bin /r/work /r/etc/idea/patches /r/proc /r/sys /r/dev /r/tmp /r/run \
 && cp /bin/busybox /r/bin/busybox \
 && for a in sh sed cat cp rm seq sleep ip tail head tr echo; do ln -s busybox /r/bin/$a; done
COPY talosctl /r/bin/talosctl
COPY setup.sh bootstrap.sh /r/
COPY setup.env /r/etc/idea/setup.env
COPY patches/ /r/etc/idea/patches/
# Mount points for the files Talos binds in from ExtensionServiceConfig.
RUN chmod 0755 /r/bin/talosctl /r/setup.sh /r/bootstrap.sh \
 && : > /r/etc/idea/secrets.yaml && : > /r/etc/idea/talosconfig && : > /r/etc/idea/setup-code

FROM scratch
COPY manifest.yaml /manifest.yaml
COPY idea-setup.yaml idea-setup-embedded.yaml idea-bootstrap.yaml /rootfs/usr/local/etc/containers/
COPY --from=root /r/ /rootfs/usr/local/lib/containers/idea-setup/
COPY --from=root /r/ /rootfs/usr/local/lib/containers/idea-setup-embedded/
COPY --from=root /r/ /rootfs/usr/local/lib/containers/idea-bootstrap/
