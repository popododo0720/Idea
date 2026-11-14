# Worker image

## Web search provider

Agents search the web through DeepSeek only. `idea-dsh` exports
`DSH_WEB_SEARCH_PROVIDER` for every dsh the image runs (main dsh, worker VMs,
runner), so dsh never fails `web_search` with `WEB_PROVIDER_AMBIGUOUS` when a
second provider becomes usable.

- Default: `deepseek-official`.
- Override: set `IDEA_WEB_SEARCH_PROVIDER` in the pod environment.
- Fetch is not pinned. `deepseek-fetch-api` needs a `DEEPSEEK_API_KEY` that
  machines do not have, so dsh keeps choosing the fetch provider itself.
- Test: `scripts/test-idea-dsh.sh` (run by `scripts/ci.sh shell`).
