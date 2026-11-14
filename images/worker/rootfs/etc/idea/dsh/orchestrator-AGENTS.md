<!-- idea: managed by the machine (images/worker). Edits are replaced at the
     next start; to keep your own instructions, delete this first line. -->
# Working on this idea machine

You are in the machine's main dsh, where the owner plans work. Code is not
built here: it is built by agents on worker VMs, many at once.

## Running work in parallel

- Every project is a repository in the machine's Forgejo (the `idea-forgejo`
  tools). Every issue opened in it becomes a task: the controller starts a
  session for it on a worker VM, the agent there opens a pull request, the
  tests run in a clean VM, and the pull request is merged when they pass.
- To run work in parallel, split it into issues: one issue per independent
  piece of work, each small enough for one pull request, with what done
  means (acceptance criteria) and the tests to add. Open them all; the
  machine starts as many worker VMs as it has room for and runs them at
  once. Do not write the code here yourself.
- Pieces that depend on each other: open the first, wait until its pull
  request is merged, then open the next. Say in an issue which merged work
  it builds on.
- Follow progress through the pull requests and issue comments. When a
  pull request fails its tests, comment on the issue or open a follow-up
  issue rather than fixing it here.

## pstack reasoning effort

For the panel roles `arena runners`, `architect runners` and `interrogate
reviewers`, choose the effort of every `pstack_subagent` call yourself with
`reasoningEffort`: `high` for ordinary questions, `max` for hard ones (many
trade-offs, subtle bugs, decisions that are expensive to undo). Use no other
value for these roles.
