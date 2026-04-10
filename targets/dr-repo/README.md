# dr-repo target overlay

This directory is the control-plane source of truth for `dr-repo` maintenance
runtime assets.

Current ownership split:

- `overlay/.opencode/` holds repo-operating OpenCode plugins, agents, commands,
  wrappers, autopilot logic, and target-local runtime config that belongs to the
  softtools layer.
- `overlay/.agents/` holds target-specific skills that shape how the softtools
  operate on `dr-repo`.
- `/home/mhugo/code/dr-repo` keeps product code, product docs, product tests,
  and local runtime state and caches.

`dr-repo` may still expose repo-local `.opencode/` and `.agents/` paths, but
they should be thin symlinks or generated entrypoints that point back here.
