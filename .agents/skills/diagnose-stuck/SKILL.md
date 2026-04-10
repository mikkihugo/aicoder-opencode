---
name: diagnose-stuck
description: Triage a stalled aicoder-opencode server, dr-repo autopilot loop, or child tool process — decide whether it is working, waiting, blocked, or dead before signalling anything
user-invocable: true
models:
  - ollama-cloud/kimi-k2-thinking
  - ollama-cloud/glm-5.1
  - ollama-cloud/minimax-m2.7
routing_role: maintenance
routing_complexity: small
---

# diagnose-stuck

Triage a suspected stuck agent, autopilot loop, opencode server, or child tool process. Answer one question first:

- **Working** — CPU busy, making progress
- **Waiting** — idle on I/O, socket, or model stream
- **Blocked** — paused on a pending tool-approval prompt or held lock
- **Dead** — zombie, orphaned, or parent gone

Diagnose before killing. Reflexive `kill -9` destroys session state, loses the resumable session-id, and leaves stale lock files that block the next autopilot cycle.

## When to use

- An autopilot timer fired but no progress is visible in logs
- An opencode session has been "thinking" for several minutes with no token output
- A maintenance run is holding `run.lock` and the next cycle refuses to start
- A child tool (git, node, ripgrep, codex) looks hung under an opencode worker

## Check sequence

Run top-to-bottom. Stop at the first check that fully explains the symptom.

Paths below use `$REPO` for the control-plane repo root (`/home/mhugo/code/aicoder-opencode` on this host). Substitute your own checkout if different.

### 1. Process tree

Identify parent and children. Never assume the top-level `opencode` PID is the one stuck — it is usually a child tool.

```
pgrep -a -f opencode
pgrep -a -f 'dr-maintenance-autonomous'
ps -axo pid=,ppid=,pcpu=,rss=,etime=,state=,comm=,command= | grep -E '(opencode|autopilot|aicoder)' | grep -v grep
pgrep -lP <suspect_pid>
```

Process state column (first char only; ignore `+`, `s`, `<`):

- `R` running · `S` sleeping (normal idle) · `D` uninterruptible sleep (I/O hang) · `T` stopped (stray Ctrl+Z) · `Z` zombie (parent not reaping)

### 2. CPU + RSS, sampled twice

One sample lies. Take two, one second apart.

```
ps -p <pid> -o pid=,pcpu=,rss=,state= ; sleep 1 ; ps -p <pid> -o pid=,pcpu=,rss=,state=
```

- Both samples ≥90% CPU → likely infinite loop (working-but-wrong)
- Both samples ~0% CPU, state `S` → waiting on I/O or model stream (probably fine)
- RSS ≥4GB and climbing across samples → leak; sluggishness will get worse

### 3. Open FDs and sockets

Only if the process looks network-bound or file-bound.

```
lsof -p <pid> 2>/dev/null | head -50
ss -tnp 2>/dev/null | grep <pid>
```

Look for an ESTABLISHED socket to a model provider (ollama-cloud, iflowcn, openrouter) — if present and in state 2 above, it is waiting on a model stream, not hung.

### 4. Recent log tails

Autopilot state and run logs:

```
ls -lt $REPO/targets/dr-repo/overlay/.opencode/state/autopilot/
tail -100 $REPO/targets/dr-repo/overlay/.opencode/state/autopilot/status.json
```

Opencode server logs for the repo the suspect belongs to (check whichever server is attached):

```
ls -lt $REPO/targets/dr-repo/overlay/.opencode/xdg-state/
ls -lt $REPO/targets/dr-repo/overlay/.opencode/xdg-cache/
```

The last few hundred lines usually show the tool call that did not return.

### 5. Autopilot lock file

```
ls -l $REPO/targets/dr-repo/overlay/.opencode/state/autopilot/run.lock
cat  $REPO/targets/dr-repo/overlay/.opencode/state/autopilot/run.lock
```

A lock file whose recorded PID no longer exists in `ps` is stale. Stale locks block the next timer cycle and are the most common "autopilot silently stopped running" cause.

### 6. Pending tool-approval prompts

If an interactive opencode session exposes a tool-approval prompt and nothing answers it, the worker will sit at 0% CPU forever. Check the opencode portal / TUI for a pending approval before assuming the process is dead. Autonomous agents should not hit this — if one did, the agent is misconfigured (`user-invocable` path instead of autonomous path).

## Decision tree

Act only after the checks above identify a category.

- **Working (sustained high CPU, logs progressing)** → keep waiting. Do nothing.
- **Waiting (low CPU, ESTABLISHED model socket, recent log line)** → keep waiting. Model streams can stall 60–120s on slow free providers.
- **Blocked on tool approval** → answer the prompt in the opencode TUI/portal, or cancel that specific request. Do not kill the server.
- **Blocked on stale lock** → verify the recorded PID is gone, then remove:
  ```
  rm $REPO/targets/dr-repo/overlay/.opencode/state/autopilot/run.lock
  ```
  Next timer cycle will resume cleanly via the session-id file.
- **Stuck child tool (hung git, ripgrep, codex, node subprocess)** → kill the child, not the parent:
  ```
  kill -TERM <child_pid>    # wait 5s
  kill -KILL <child_pid>    # only if TERM was ignored
  ```
  The parent opencode worker will surface the tool error and continue.
- **Infinite loop in opencode worker (two samples ≥90%, no log progress)** → SIGTERM the worker PID, let it flush state, wait 5s, then SIGKILL only if still alive:
  ```
  kill -TERM <pid> ; sleep 5 ; kill -0 <pid> 2>/dev/null && kill -KILL <pid>
  ```
- **Zombie (`Z` state)** → the parent is the bug. Find `ppid`, restart the parent.
- **Opencode server itself wedged (port 8080/8082/8084 not responding, all workers idle)** → restart the per-repo server. Preserve the session-id file first so autopilot resumes:
  ```
  cp $REPO/targets/dr-repo/overlay/.opencode/state/autopilot/status.json /tmp/autopilot-status.backup
  # stop the repo-specific opencode server, then restart via its bin shim
  $REPO/targets/dr-repo/overlay/.opencode/bin/dr-maintenance-autonomous-start
  ```

## Rules

- Diagnose before signalling. Every `kill -9` on an opencode worker loses the resumable session.
- Never `kill -9` as the first action. Always `SIGTERM` first, wait, verify, then escalate.
- Never remove `run.lock` without confirming the recorded PID is gone from `ps`.
- Never restart the opencode server without first backing up or noting the current session-id.
- Child-tool hangs are fixed at the child, not by killing the parent.
- If the suspect is the autopilot runner unit itself, consult `control-plane-maintenance-base` Autopilot continuation rules before restarting — a second runner must not race the first.

## Avoid

- Reflexive `kill -9` on any opencode or autopilot PID
- Removing `run.lock` while its PID is still alive
- Restarting the opencode server to "clear" a stuck child process
- Treating a 60s model-stream wait as a hang
- Killing a worker that is blocked on an unanswered tool-approval prompt
