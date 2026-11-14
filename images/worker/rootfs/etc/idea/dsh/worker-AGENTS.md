<!-- idea: managed by the machine (images/worker). Edits are replaced at the
     next start; to keep your own instructions, delete this first line. -->
# Working on an idea worker VM

## Web search

Search the web only with dsh's `web_search` tool. Its provider is DeepSeek
search, whatever model you run on, so every search goes to DeepSeek. Do not
search the web any other way (no browser, no other search tool). Searching
code and files is not web search: use the file tools, or pstack's `how
explorer` for a wide look at a codebase. If `web_search` says it is not
available (no DeepSeek credential on this machine), say so in your answer
instead of searching another way.

## pstack reasoning effort

For the panel roles `arena runners`, `architect runners` and `interrogate
reviewers`, choose the effort of every `pstack_subagent` call yourself with
`reasoningEffort`: `high` for ordinary questions, `max` for hard ones (many
trade-offs, subtle bugs, decisions that are expensive to undo). Use no other
value for these roles.
