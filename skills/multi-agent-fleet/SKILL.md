---
name: multi-agent-fleet
description: Run one DSH as the coordinator for coding agents spread across several machines — dispatch work over ssh/tmux, keep build and disk budgets, gate quality with an independent reviewer, and report on a timer. Use when the user wants many issues or repos worked in parallel across more than one host, or asks to take over an existing multi-machine agent operation.
---

# Multi-agent fleet

One DSH coordinates; the actual coding agents are separate CLI processes on other hosts
(`codex`, `dsh --profile headless`, `claude`, whatever the user has installed). DSH supplies
the loop, the schedule, the goal, and the shell — **not** the agents. Do not look for a DSH
"remote agent" mode; there isn't one. Plan for the external tooling.

This skill is distilled from a ~28 h operation that took a Rust repo from 39 open issues to 0
across 5 machines, so the numbers below are observed costs, not theory.

## When this fits

- Many independent work items (issues, repos, test suites) that can run truly in parallel.
- More than one machine, each with spare CPU, where builds are the bottleneck.
- A user willing to let agents work unattended and to accept a strict review gate.

It does **not** fit when the work items touch the same files, when one machine is the only
one that can build, or when the user wants to watch every step interactively.

## 1. Decide the topology first

Write this table down before dispatching anything; without it, "which agent is doing what"
becomes unanswerable within an hour.

| Host alias | Role | Reached with | Agent runtime |
|---|---|---|---|
| `build-1` | primary build host | `ssh build-1 "…"` | agent TUI in `tmux` sessions |
| `build-2` | issue fixing | `ssh build-2 '…'` | non-interactive `exec` in `tmux` |
| `win-a` | Windows boxes whose work runs in WSL | `ssh win-a 'wsl -d Ubuntu-22.04 -e …'` | `exec` in `tmux` |
| `local-wsl` | verification, long test sweeps | `wsl -d Ubuntu-24.04 -e bash …` | TUI sessions |
| this host | coordinator + merge gate | `pwsh` | one `exec` reviewer |

Rules that came out of the original run:

- **One work item per agent.** Never let one agent queue a second task.
- **One worktree per agent**, removed with `git worktree remove --force` plus deletion of the
  target directory at task end. Stale worktrees were the single biggest disk drain.
- Keep the coordinator free. It dispatches, sweeps, and merges; it does not write code.

## 2. Preconditions

- Passwordless `ssh` aliases in `~/.ssh/config` (`ConnectTimeout`, `ServerAliveInterval`).
- The agent CLI installed and configured on **every** target, with its own config file
  (provider, model, sandbox, approval policy). Pin `approval_policy = never` — an agent that
  stops to ask a question nobody sees is a silently dead agent.
- `tmux` on every Unix target; `gh` authenticated on the host that will open PRs.
- An **out-of-band root channel** to every machine. When SSH dies you still need in: cloud
  run-command APIs (e.g. Alibaba Cloud `RunCommand`), a console, or a second SSH path. The
  original operation saved hours this way when a rebuilt VM lost its authorised keys.

## 3. Arm the coordinator

```
/permission danger-full-access      # unattended operation cannot prompt
/goal <one sentence: fix every open issue, verify first, never merge without review>
schedule_create every_seconds=300  title="fleet sweep"  prompt="巡检所有 agent 的状态…"
```

A recurring schedule is what keeps the loop alive across compactions; without it the
coordinator only acts when the human speaks. Report cadence of 5–10 minutes worked well.

## 4. One baseline sweep, one script

Every monitoring turn should be a single command. Do not hand-run six `ssh` calls each time.

```powershell
ssh -o ConnectTimeout=15 build-1 "tmux list-sessions; df -h /data | tail -1"
ssh -o ConnectTimeout=15 win-a  'wsl -d Ubuntu-22.04 -e tmux list-sessions'
ssh -o ConnectTimeout=15 build-2 'bash /data/fix/status.sh'
gh pr list -R owner/repo --state open --limit 40
gh api "repos/owner/repo/issues?state=open&per_page=100" --jq '[.[] | select(.pull_request == null)] | length'
```

Session liveness is not enough — capture pane contents:

```bash
tmux list-panes -a -F '#{session_name}:#{window_index} dead=#{pane_dead} cmd=#{pane_current_command}'
tmux capture-pane -p -t "$s:0" -S "-$lines" | grep -v '^$' | tail -n "$lines"
```

## 5. Dispatch, three patterns

Pick by what the target runs. All three end up writing a task file, so the prompt stays
versioned and re-runnable.

**A. Non-interactive agent in tmux (preferred — no paste fragility):**

```bash
tmux new-session -d -s "task-$n" -c "$HOME/work"
# then send into it:
timeout -k 10 2700 <agent-cli> exec <model-flags> --skip-git-repo-check \
  --sandbox danger-full-access < /tmp/task-$n.txt 2>&1 | tee "$HOME/logs/$n.log"
```

**B. Agent TUI (only if you must) — paste the file, never `send-keys -l`:**

```bash
tmux load-buffer -b "task$n" /tmp/task-$n.txt
tmux paste-buffer -b "task$n" -t "$session" -d
tmux send-keys -t "$session" Enter
```

`send-keys -l` with a long string loses spaces and mangles the command; that is why the
original run standardised on `load-buffer` + `paste-buffer`.

**C. Portable worker — use DSH itself as the remote agent** when the target already has DSH
installed and you want identical model/tool behaviour everywhere:

```bash
ssh build-1 'dsh --profile headless --json "<task text>"'
ssh build-1 'dsh --profile headless --session-id <session-…> "<follow-up>"'
```

Headless prints the final answer, emits NDJSON with `--json`, resumes with `--session-id`,
and exits non-zero on failure — enough to build a dispatch loop without a TUI.

For a task that must survive the SSH connection, wrap in `tmux new-session -d` or `nohup`,
and return the session name so the next sweep can find it.

### Mixed Windows + WSL targets

A Windows box whose work happens inside WSL needs two hops, and the script has to be reachable
from both sides. Copy it to the Windows side, then call it through the WSL mount:

```bash
scp panes.sh win-a:C:/Users/<user>/panes.sh
ssh win-a 'wsl -d Ubuntu-22.04 -e bash /mnt/c/Users/<user>/panes.sh 8'
```

Keep those scripts ASCII with LF endings — CRLF breaks `bash` on the first line, and a BOM
breaks it in a way that looks like a missing interpreter.

### When the target cannot reach GitHub

Do not copy credentials around. Open a SOCKS tunnel from a host that can, and point the target
at it:

```bash
ssh -f -N -D 127.0.0.1:1080 <jump-host>
export HTTPS_PROXY=socks5://127.0.0.1:1080
```

Then remember the inverse: a proxy exported WSL-wide will break `git`/`gh` for the commands
that already had direct access — those need `env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY`.

### Launching a reviewer on Windows

A reviewer agent started as a child of the coordinator will keep the console attached and can
steal focus mid-run. Start it detached and poll its log instead:

```powershell
Start-Process -FilePath cmd.exe -ArgumentList '/c','C:\work\run-review.cmd' -WindowStyle Hidden -PassThru
```

## 6. Resource guardrails (these prevent outages, not slow-downs)

Set them **inside the dispatch script and inside the task text**, because an agent that
forgets them can take the host down.

```bash
export CARGO_BUILD_JOBS=2                 # or the equivalent for your toolchain
export CARGO_PROFILE_DEV_CODEGEN_UNITS=16
export CARGO_PROFILE_TEST_CODEGEN_UNITS=16
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
export CARGO_INCREMENTAL=0
flock /data/fix/build.lock <single command>   # per command, never around a whole script
rm -rf target/debug/incremental                # after each build
```

- **Never gate on a global `pgrep -f 'cargo|rustc'`.** In the original run that guard blocked
  one agent for ~18 h while a different agent compiled. Check only the agent's own pane state.
- Default codegen units (256) let one `rustc` grow past 22 GB and get OOM-killed. The caps
  above are the fix, not a speed/quality trade-off.
- Set disk thresholds and act on them: below ~15 % free, delete finished worktrees and
  `target/debug/incremental` before dispatching anything new.

## 7. Kill sessions properly

`tmux kill-session` does **not** kill children. An orphaned build or lock holder starves every
later task and looks like "the machine is idle but nothing runs". After any kill:

```bash
ps -eo pid,ppid,etime,cmd | grep -E '<agent-cli>|cargo|rustc' | grep -v grep
lsof /data/fix/build.lock   # or: fuser -v /data/fix/build.lock
```

Hunt and kill holders whose worktree no longer exists.

## 8. Quality gate

Two shapes; pick one per operation and write it into the task text.

**Self-gating** — each agent reviews its own diff adversarially and merges:

> SELF-REVIEW the diff adversarially, then merge. You are the only quality gate. A timeout or a
> compile failure is NOT a pass.

**Independent reviewer** — a dedicated agent on the coordinator host reviews and merges:

> Do NOT consider CI status or check results at all. Ignore failing, pending, or skipped checks.
> Base the decision solely on the code diff and mergeability.

Shared rules that worked:

- **Verify first**: reproduce or validate the issue before writing a fix. Issues that turn out
  invalid get closed *with evidence*, not silently fixed.
- Agents open PRs; only the gate merges: `gh pr merge <N> -R owner/repo --squash --delete-branch --admin`.
- **Never rely on CI** for the merge decision; review the diff and conflicts instead.
- On conflict, rebase preserving intent — do not drop the other side's hunks.
- Keep a stale-fork guard: `gh api -X POST repos/<user>/<fork>/merge-upstream -f branch=main`,
  or PR conflicts will recur for hours.
- Use REST, not GraphQL, for issues: `gh api repos/owner/repo/issues/<n>`. `gh issue view`
  breaks on repositories with classic Projects.

## 9. The pitfalls that actually cost time

| Symptom | Cause / fix |
|---|---|
| Agent silent for hours, PR never opens | Its TUI lost the turn relay (`serverShuttingDown`). Kill the process, `stty sane; reset`, relaunch, wait for the prompt, re-paste |
| Pasted command lost spaces | `send-keys -l`; use `load-buffer` + `paste-buffer` |
| Dispatch blocked for ~18 h | Global `pgrep` build guard; remove it |
| `rustc` killed, host OOM | Default codegen units; cap them |
| Nothing runs, host looks idle | Orphan `flock`/child processes after a session kill |
| PR opened against the fork | Missing `--repo owner/repo` on `gh pr create` |
| "Passed all 0 tests" | Empty case list looks green; assert `Ran:`/`Failures:` counts, treat exit 124 as failure |
| VM rebuilt, SSH key gone | Out-of-band channel (cloud RunCommand) to remount and restore; then `ssh-keygen -R` + re-add host key |
| Provider refuses a task | Content filter on large dumps; restart as a new session with a de-escalated prompt |

## 10. Reporting

The human wants a table, not prose: per-agent state (running/idle/blocked, elapsed), open
issue and PR counts, disk and memory, blockers, next step. Keep it short and repeat the same
shape every sweep so drift is obvious at a glance.

## 11. Closing out

Before declaring done: open issues 0, open PRs 0, every worktree removed, every `target/`
cleaned, every tmux session either finished or deliberately kept. Write down what was left
open and why — in the original run one issue had green tests and no PR, which is a failure,
not a pending item.
