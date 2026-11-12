# worker-ssh

A dsh plugin for the idea main agent. It adds the tool `worker_run(worker, task)`,
which runs a task inside a work VM over SSH (`dsh headless --json` on the worker)
and returns the outcome.

- The task is sent on stdin, never on a command line.
- The remote event stream is saved under `/tmp/idea-runs/` in the main pod.
- The private key is mounted from a Secret generated inside the cluster.

It is loaded by absolute path from the main agent's profile patch
(`images/main/dsh-home/profiles/headless/cordis.patch.yml`).
