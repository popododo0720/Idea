#!/usr/bin/env node
// idea-pr "<title>" "<body>": open a pull request for the current task's
// branch against main. Reads the Forgejo address, repository, branch and
// token from the environment; the token is sent in a header, never printed.
const [title, body = ''] = process.argv.slice(2)
const { FORGEJO_API, FORGEJO_TOKEN, IDEA_REPO, IDEA_BRANCH } = process.env
if (!title) { console.error('usage: idea-pr "<title>" "<body>"'); process.exit(2) }
for (const [k, v] of Object.entries({ FORGEJO_API, FORGEJO_TOKEN, IDEA_REPO, IDEA_BRANCH })) {
  if (!v) { console.error(`idea-pr: ${k} is not set`); process.exit(2) }
}
const res = await fetch(`${FORGEJO_API}/repos/${IDEA_REPO}/pulls`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `token ${FORGEJO_TOKEN}` },
  body: JSON.stringify({ title, body, head: IDEA_BRANCH, base: 'main' }),
})
const text = await res.text()
if (!res.ok) { console.error(`idea-pr: HTTP ${res.status}: ${text.slice(0, 300)}`); process.exit(1) }
const pr = JSON.parse(text)
console.log(`pull request #${pr.number} opened: ${pr.html_url}`)
