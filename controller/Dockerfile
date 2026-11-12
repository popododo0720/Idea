# idea controller. Build context is the repository root.
ARG GO_IMAGE
ARG DEBIAN_TAG
FROM ${GO_IMAGE} AS build
WORKDIR /src
COPY controller/go.mod controller/go.sum ./
RUN go mod download
COPY controller/*.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/idea-controller .

FROM docker.io/library/debian:${DEBIAN_TAG}
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --no-create-home idea
COPY --from=build /out/idea-controller /usr/local/bin/idea-controller
# The example repository the controller seeds Forgejo with.
COPY examples/ /opt/idea/examples/
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/idea-controller"]
