# forgejo

A dsh plugin for the agent dsh inside an idea machine. It gives the agent the
machine's Forgejo:

- `forgejo_issue(repo, number)`: read an issue or pull request with its comments.
- `forgejo_pull_request(repo, head, title, body?, base?)`: open a pull request from
  a pushed branch, or return the one already open for it.
- `forgejo_comment(repo, number, body)`: comment on an issue or pull request.
- `forgejo_checks(repo, ref)`: combined commit status (the test gate result).

The API address and token come from the environment of the dsh process
(`FORGEJO_API`, `FORGEJO_TOKEN`). The token is only sent in a request header.

It is loaded by absolute path from the agent dsh's patch
(`images/worker/rootfs/etc/idea/dsh/web.patch.yml`).
