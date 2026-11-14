# Contributing

Every pull request runs `scripts/ci.sh` on the machine's own runner
(`.forgejo/workflows/test.yml`), in a clean worker VM. A pull request is merged
only when every step passes. Run the same steps before you push.

## Checks

```sh
scripts/ci.sh setup          # once: pinned tools and the Node dev tools
scripts/ci.sh                # every step
scripts/ci.sh go js          # some steps
```

| Step | What it checks | Configuration |
| --- | --- | --- |
| `go` | controller: formatting (gofmt, goimports), golangci-lint (vet, staticcheck, errcheck, gosec, ...), tests with coverage (floor in `scripts/ci.sh`) | `.golangci.yml` |
| `js` | dsh plugins: ESLint, TypeScript type check, `node:test` unit tests with coverage (floors: 95% lines, 85% branches and functions), every plugin module loads | `eslint.config.js`, `tsconfig.json` |
| `shell` | shellcheck and shfmt on every shell script | `.shellcheckrc`, `.editorconfig` |
| `workflows` | actionlint on `.forgejo/workflows` | `.forgejo/actionlint.yaml` |
| `manifests` | kubeconform (strict) on `deploy/` | |
| `docker` | hadolint on every Dockerfile | `.hadolint.yaml` |
| `secrets` | gitleaks on the tree and the history | |

Tool versions and SHA-256 sums are in `versions.env`; the Node tools are
pinned in `package.json` and `package-lock.json`. `setup` downloads them to
`$RUNNER_TEMP/idea-ci-tools` (or `$TMPDIR`), checks every checksum, and
reuses what is already there. Never use "latest".

The `js` step links `plugins/node_modules` to dsh's packages, as the worker
image does. Outside the image, point it at a dsh install:
`DSH_NODE_MODULES=/path/to/dsh/node_modules scripts/ci.sh js`.

## Fixing findings

- Go: `cd controller && golangci-lint fmt ./... && golangci-lint run --fix ./...`
- JavaScript and TypeScript: `npx eslint --fix .`
- Shell: `shfmt -w <files>` (settings come from `.editorconfig`)

Silence a finding only when it is wrong for that line, with the rule and the
reason on the same line, for example
`//nolint:gosec // G101: a Secret name, not a credential` or
`# shellcheck disable=SC2016 # expanded by git, not here`.
golangci-lint and ESLint reject unexplained or unused suppressions.

## Tests

- Go tests live next to the code (`controller/*_test.go`). Use
  `net/http/httptest` for Forgejo and the client-go fakes for Kubernetes.
- Plugin tests live in `plugins/idea/test/` and use `node:test` only.
- Test behaviour (status codes, replies, calls made), not source text.
- Tests must not need the network beyond 127.0.0.1 or sleep for long.

## Commits

- Commit messages, code, comments and docs are in English.
- Use a GitHub noreply e-mail address. The pre-commit hook
  (`git config core.hooksPath .githooks`) runs `scripts/check-secrets.sh`.
