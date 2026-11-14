<!-- idea: managed by the machine (images/worker). Edits are replaced at the
     next start; to keep your own instructions, delete this first line. -->
# Working on an idea worker VM

## pstack reasoning effort

For the panel roles `arena runners`, `architect runners` and `interrogate
reviewers`, choose the effort of every `pstack_subagent` call yourself with
`reasoningEffort`: `high` for ordinary questions, `max` for hard ones (many
trade-offs, subtle bugs, decisions that are expensive to undo). Use no other
value for these roles.
