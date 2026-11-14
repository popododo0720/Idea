<!-- idea: managed by the machine (images/worker). Edits are replaced at the
     next start; to keep your own instructions, delete this first line. -->
# Working on this idea machine

You are in the machine's main dsh, where the owner plans work. Code is not
built here: it is built by agents on worker VMs, many at once.

## Projects

- `idea_project_create` makes a project: a repository in the machine's
  Forgejo, empty or copied from a public Git URL (for example a GitHub
  repository the owner names). `idea_status` shows the projects, the worker
  VMs and every task with its pull request.
- When the owner asks for work on code that is not a project yet, create the
  project first (copying the repository when there is one), wait until
  `idea_status` shows it ready, then plan the work.
- A pull request is merged only when the repository's tests pass, run by
  `.forgejo/workflows/` on the machine's runner (`runs-on: idea`). A copied
  repository often has none: make adding that workflow (and the tests it
  runs) the first issue, and plan the rest after it is merged.
- To publish a project somewhere else (for example the owner's GitHub
  repository), use `idea_project_mirror` with the repository's SSH address.
  `idea_status` then shows a deploy key: give it to the owner to add to that
  repository with write access. Nothing is pushed before that. The machine
  pushes main only after checking each new commit, and a pull request that
  would fail the check goes back to its agent instead of being merged;
  `idea_status` shows the outcome of the last check.

## Running work in parallel

- Every project is a repository in the machine's Forgejo. Open issues with
  `forgejo_issue_create`. Every issue opened in it becomes a task: the
  controller starts a session for it on a worker VM, the agent there opens a pull request, the
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

## Working as a team

For work whose pieces need to talk while they are built (an API and its
client, a schema and the code using it), start a team instead of separate
issues:

- `team_spawn` starts a teammate on a worker VM of its own (like another PC)
  with its task: the Forgejo repository to clone, what to build, what done
  means, and which teammates it has to agree with.
- Teammates message each other and you directly with `team_send`; their
  messages arrive here as user messages, so you can end your turn while they
  work. `team_list` shows who is working; `team_stop` ends a teammate.
- Keep the plan on the team's task board: split the work into tasks with
  `team_task_add` (owner, what it waits for), and have teammates claim and
  close them with `team_task_update`. `team_tasks` shows the board; the owner
  sees it in the idea panel too.
- They still deliver through branches and pull requests, which are tested
  and merged as usual. Do not write the code here yourself.
