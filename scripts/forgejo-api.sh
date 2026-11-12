#!/usr/bin/env bash
# Call the in-cluster Forgejo API as the administrator, for the things a human
# does by hand (for example opening an issue).
#
#   forgejo-api.sh GET  /repos/idea/hello-calc/issues
#   forgejo-api.sh POST /repos/idea/hello-calc/issues '{"title":"...","body":"..."}'
#
# The password goes from the cluster Secret to the request over stdin; it is
# never placed on a command line and never printed.

. "$(dirname "$0")/lib.sh"
need kubectl

method="${1:?usage: forgejo-api.sh METHOD PATH [JSON]}"
path="${2:?usage: forgejo-api.sh METHOD PATH [JSON]}"
body="${3:-}"
ns=idea-system

{
  kubectl -n "$ns" get secret idea-forgejo-admin -o jsonpath='{.data.username}' | base64 -d; echo
  kubectl -n "$ns" get secret idea-forgejo-admin -o jsonpath='{.data.password}' | base64 -d; echo
  printf '%s\n' "$method" "$path"
  printf '%s' "$body"
} | kubectl -n "$ns" exec -i deploy/idea-main -- node --input-type=module -e '
import { text } from "node:stream/consumers"
const input = await text(process.stdin)
const [user, pass, method, path, ...rest] = input.split("\n")
const body = rest.join("\n")
const res = await fetch("http://forgejo-http:3000/api/v1" + path, {
  method,
  headers: {
    Authorization: "Basic " + Buffer.from(user + ":" + pass).toString("base64"),
    ...(body ? { "Content-Type": "application/json" } : {}),
  },
  body: body || undefined,
})
process.stdout.write(await res.text())
if (!res.ok) { console.error("\nHTTP " + res.status); process.exit(1) }
'
