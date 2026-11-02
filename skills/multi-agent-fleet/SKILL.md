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
- **Model policy (user, 2026-10-27): do not use `gpt-6-astra` for codex; use `gpt-6.1-sol`.**
  Set it as the config default as well as passing `-m`, so a launcher that forgets the flag
  cannot silently fall back. Check before dispatch:
  `grep -E '^model\s*=' ~/.codex/config.toml` and
  `ps -eo args | grep '[c]odex exec' | grep -oE '\-m [a-zA-Z0-9._-]+' | sort | uniq -c`.
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

### Alive is three signals, not one

`tmux` keeps the window after the agent exits, so a session whose pane command is `bash`
means the agent is **gone**. And an agent grinding a 70-minute `cargo test` writes nothing to
its progress file, so file mtime alone says "dead" when it is busy. Check all three:

```bash
echo "agent=$(pgrep -fc <agent-cli>) build=$(pgrep -cx cargo)/$(pgrep -cx rustc) \
      progress=$(date -r "$f" +%H:%M:%S) $(wc -c < "$f")"
```

| codex | cargo/rustc | progress file | verdict |
|---|---|---|---|
| ≥1 | ≥1 | stale | **working** — it is compiling, leave it alone |
| ≥1 | 0 | stale | wedged — re-dispatch or restart |
| 0 | any | any | dead — restart the session, it will not recover |

Both single-signal mistakes were made in one afternoon: a session showing `bash` was called
alive, and a 38-minute test run was called dead. Neither is recoverable by reading tmux alone.

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
| Agent says "ready for review" with nothing measured | Put the preconditions in the **PR body as a checkbox list** and convert it back to draft; task text alone is forgotten by both parties |
| `git push` fails while `curl` to the same host works | Three independent proxy settings — `curl -x`, `http_proxy`, and `git config http.proxy`. A dead global git proxy silently blocks every push while HTTPS looks fine |
| SSH to a fresh instance refused, "host key changed" | Preemptible IPs are recycled. `ssh-keygen -f ~/.ssh/known_hosts -R <ip>`, or always pass `-o StrictHostKeyChecking=accept-new` |
| `rustc: command not found` on a box where it is installed | Toolchains live under `~/.cargo/bin` and are invisible to `bash -lc` / `ssh host "cmd"`. Export PATH explicitly in every non-interactive command; never rely on `.bashrc` |
| `git bundle` from an agent's clone cannot be cloned elsewhere | Agents clone with `--depth`, so bundling produces a thin bundle with missing parents. Use `git format-patch`, transfer the patch, and `git am` it **on the patch's original base**, not on current main |

## 10. Reporting

The human wants a table, not prose: per-agent state (running/idle/blocked, elapsed), open
issue and PR counts, disk and memory, blockers, next step. Keep it short and repeat the same
shape every sweep so drift is obvious at a glance.

## 11. Closing out

Before declaring done: open issues 0, open PRs 0, every worktree removed, every `target/`
cleaned, every tmux session either finished or deliberately kept. Write down what was left
open and why — in the original run one issue had green tests and no PR, which is a failure,
not a pending item.

## 12. Task shape dominates throughput — not the model

Same model, same host, same agent CLI: a task that stalled three times for three hours
produced a diff in **five minutes** once the coordinator did the reconnaissance itself and
wrote the file:line into the task. Treat task authoring as the real work.

What separates the two:

| Give the agent | It produces |
|---|---|
| "investigate and design attribute caching" | 3 stalled sessions, 0 commits |
| "`src/fuse/mod.rs:3773` returns `Duration::ZERO` when the writable ACL capability is present; four call sites at 762/829/1205/1244; split it and measure with `/path/bench2.py` against 937 ops/s" | a diff plus tests in 5 minutes |

Four habits that follow from this:

1. **Do the 10-minute reconnaissance yourself.** A `grep` for the symptom costs seconds and
   converts a research task into an implementation task.
2. **Put a number in the acceptance criterion.** "stat ≥ 2× the 937 baseline" is checkable;
   "make it faster" is not, and agents will write prose about it instead.
3. **Cap analysis output.** A progress file past ~10 KB with no diff is a warning sign, not
   diligence. One agent produced a 77 KB analysis in 40 minutes and zero code until told
   "stop analysing, implement proposal 1".
4. **Timebox to the first diff.** Say "if you have not produced a diff in 20 minutes, report
   what blocked you". Otherwise the default failure mode is silent reading followed by an idle
   prompt.

Agents are also, empirically, **~40–60 minute workers**. Proactively re-dispatch the next step
rather than expecting one session to finish a multi-hour job; when several died in one day,
the pattern was retirement, not crash — no OOM, no error, just an idle prompt and a stale
progress file.

## 13. Some hosts cannot host agents — classify before dispatching

Do not assume "a spare machine" means "a place an agent can run". Two disqualifiers cost a
whole day:

**WSL cannot run long unattended work.** In one day, six attempts died silently on two WSL
hosts: agent TUI, non-interactive `exec`, `setsid nohup`, and finally `tmux` — the `tmux`
session itself was reaped while the WSL VM stayed up (`uptime` unchanged, memory free, no OOM
in `dmesg`). WSL2 suspends the VM when it looks idle and takes the processes with it.
Foreground commands driven by the coordinator work fine; nothing that must outlive a turn.

**A host can have working HTTPS and no outbound SSH.** One box reached the cloud API and
GitHub only through an HTTP proxy and could not open TCP 22 to anything, so it could build and
push but could never drive a remote instance. Test the exact capability you need
(`ssh -o ConnectTimeout=8 root@<instance> true`), not "does it have internet".

| capability needed | test before dispatch |
|---|---|
| agent sessions that survive between turns | native Linux; `tmux` session still there after 10 min idle |
| drive cloud instances | outbound TCP 22 to a throwaway host |
| push to git | `git ls-remote` through the same env the agent will use |
| build | one `cargo build` fits in RAM — see the next section |

## 14. Build memory is the most likely way to lose a machine

A single `rustc` for a large Rust crate reached **18–25 GB RSS** in this run. That number
drives three rules:

- Always `CARGO_PROFILE_TEST_DEBUG=0 CARGO_PROFILE_DEV_DEBUG=0`. Debug info is most of the
  peak; with it on, a 31 GB host dies, and with it off the same build fits in ~16 GB.
- `cargo test --workspace` → `-j 1`; ordinary builds `-j 2` to `-j 4`. `-j 8` on a 31 GB box
  means eight units × up to 25 GB and a guaranteed OOM.
- **Never let two agents compile on the same host at once.** Two such outages in one day, both
  from a coordinator action (starting a second build while one was running) rather than from
  the agents. Cheap guard in every task file:

```bash
pgrep -a cargo; pgrep -a rustc   # if either prints, wait
```

When a host goes down this way the symptom is not an error message: `sshd` accepts the TCP
connection and then stalls at banner exchange, and the cloud run-command API returns `Aborted`.
Recovery that worked: stop + start the instance (not reboot — the least-privilege account
often lacks `RebootInstance` but has `StopInstance`/`StartInstance`), then remount the data
disk and re-bind the home directory before SSH will accept a login at all. A box whose
`/home/<user>` is unmounted closes the connection immediately after the handshake, which is a
different symptom from a busy box and points straight at the mount.

Refinement observed later: that 18–25 GB figure is for a **cold** build. A `cargo test
--workspace --lib --bins` against a warm `target/` peaked under 300 MB per rustc. So the rule
is not "test builds are dangerous" but "the first full build is"; size the guard by whether the
target directory is warm.

**Measure before you intervene.** Twice in one session a build looked dangerous because of
memory recalled rather than memory observed: two `rustc` processes on a 27 GB host turned out to
be **994 MB total** with 25 GB available and zero swap. Had the remembered 18–25 GB figure been
acted on, a healthy build would have been killed, twice, for nothing. The habit that works:

```bash
free -g | sed -n 2p
ps -eo rss,comm | awk '/rustc/{n++; s+=$1} END{printf "rustc=%d total=%dMB\n", n, s/1024}'
```

Act on the second number, not on the anecdote. A single rustc at 18–25 GB and two rustc at
0.5 GB each look identical in a process count and nothing alike in reality.

## 15. Preemptible instances: ask for a protection period

Spot is cheaper than on-demand and, with the right parameter, is not a lottery. On Alibaba
Cloud the knob is `--SpotDuration`:

- `0` = no protection. Two runs on `SpotDuration 0` were reclaimed **mid-benchmark**, one after
  ~11 minutes and one after ~40, and a fresh probe instance went to `Stopped` **within seconds
  of creation** and disappeared a minute later.
- `1`–`6` = hours of protection. The same instance types accepted `--SpotDuration 1` and
  instantiated normally.

**The allowed durations are per instance family, not global.** On the general-purpose family
(`ecs.e-*`) `--SpotDuration 6` returns `InvalidSpotDuration` while `--SpotDuration 1` succeeds,
so a script written with `6` fails outright on the exact type that supports `1`. Probe the value
you intend to use, on the type you intend to use, before baking it into a launcher.

Use `SpotDuration` 1–6 for any job longer than a few minutes, and treat "instance created" as
**not** meaning "capacity obtained": with no spot capacity the create call still returns an
instance id and the broker immediately interrupts it. Corollaries:

- `DescribeAvailableResource` reports **on-demand** stock. It does not tell you whether spot
  capacity exists. The only honest test is an actual `RunInstances`, then delete the probe.
- A job longer than the protection window must checkpoint and resume, or be split into
  windows. The protection expiring does not kill the instance immediately, but it becomes
  reclaimable again.
- Always leave a **billing guard**: a loop that deletes the instance when the work is done or a
  hard deadline passes, whichever comes first. Never let an unattended pay-as-you-go or
  unprotected spot instance run overnight.

## 16. Progress ledgers lie in the same way tests do

A long benchmark wrote two progress files: `coverage.csv`, with a `status` column enumerating
all 180 cells, and `cells.csv`, holding the measured rows. After 40 minutes of work
`coverage.csv` still said `not-run` for **every** row while `cells.csv` held 60 measured cells.
Resuming from the wrong file would have re-run 40 minutes of measurements and silently
overwritten good data.

Rules that follow:

- Decide which file is the **source of truth** and say so in the task file. Prefer the file that
  contains measured values over the one that contains an intention.
- Require the agent to **reconcile** the two: backfill the status column from the measured rows.
- Judge completion from the measurement columns together (`status == complete AND n == required`),
  never from a row count. The same table looked like 60/180, then 60/60, and was actually 28/60 —
  three different wrong answers from counting rows.

## 17. Operating notes that cost real time

- `aliyun --output cols=A,B` **changes shape when the result has a single row**: the header
  disappears and fixed-position `awk -F'|'` parsing silently yields empty fields. Parse JSON by
  key, or pin four columns and strip brackets; and **echo the resolved id before any delete**,
  because a delete with an empty variable fails with `InvalidInstanceId.NotFound` while the
  instance is still running and still billing.
- `#requires -Version 7` at the top of a `.ps1` aborts the whole script on a Windows box that
  only has PowerShell 5.1, and a hidden `Start-Process` makes it look like nothing happened.
  `Start-Process pwsh` also fails outright when `pwsh` is not installed — use
  `powershell.exe` and keep the script 5.1-compatible.
- Editing a task file does **not** change the prompt of an already-running agent: the text was
  read at startup. To change course you must kill and relaunch, which is why the task file has to
  be right the first time and why a "timeboxed partial" from an agent whose timebox you lifted
  five minutes later is expected, not anomalous.
- `codex exec` is non-interactive; `send-keys` into its tmux pane does nothing useful. There is
  no way to steer a running one, only to replace it.
- In a goal loop, continuation rounds can fire every 10–20 seconds while the underlying work
  needs minutes. Repeated identical readings are not evidence of a stall; check a monotonically
  increasing counter (a byte count, an mtime age, a cell count) against wall-clock, not against
  round number.
- An agent that stops inside its timebox and reports `n/3` repetitions with the reason recorded is
  succeeding, not failing. An agent that reports 3/3 without a harness run is the failure mode;
  that is what the "state `n` in the same file you write results to" rule is for.

## 18. Agents finish the work and skip `git commit`

Across one night this happened three times out of three substantive agents:

| agent | work | commits made by the agent |
|---|---|---|
| evidence | report generator + tests, xfstests evidence | 0 |
| metacache | fencing + 251 test lines + 36 measurement windows | 0 |
| p1-alloc | −50% payload copy, byte-identical proof, fail-first evidence | 0 |

All three reached "analysis done, evidence written, tests green, `git status` shows 6–19 changed files" and stopped. One of them (`metacache`) *did* open its own follow-up PR afterwards, so the capability is not missing — the step is simply skipped.

Consequence: every one of these had to be committed by the coordinator, and each wait cost 20–30 minutes of nothing. Do not wait, and do not infer intent from `dirty=6` sitting there. Check three things and commit:

```bash
git status --porcelain | wc -l          # > 0 and not changing
pgrep -cx cargo; pgrep -cx rustc        # both 0: nothing is building
ls -lt <evidence dir> | head -3         # newest evidence older than a few minutes
```

When those hold, commit on the agent's behalf with **its** numbers, not invented ones — read them out of the evidence files it wrote (`comparison.json`, `*.jsonl`, test result lines) and quote them exactly.

**Put the exact commands in the task file.** "Remember to commit" is not an instruction an agent acts on; a copy-pasteable block is:

```bash
export CARGO_PROFILE_TEST_DEBUG=0 CARGO_PROFILE_DEV_DEBUG=0
git add -A src tests doc tools CONFIG.md
git -c user.name='Xiao Han' -c user.email='dev@example.com' commit -m '<subject>

<what changed, and the measured numbers with units>'
git push -u origin HEAD
# gh pr create is broken in this repo; use the API:
gh api -X POST repos/brewfs/brewfs/pulls \
  -f title='<same subject>' -f head="$(git branch --show-current)" -f base=main \
  -f body='<evidence table + scope limits>'
```

Also tell it what "done" excludes: no uncommitted files, no `--draft` left set, and the PR body must carry the numbers rather than a promise to add them.

### Three PR-state traps that cost a merge each

- **`--force-with-lease` fails with `stale info`** after you rebase a branch the remote also moved. On a branch you own, plain `--force` is the correct tool; `--force-with-lease` refuses because its cached remote sha is stale, not because someone else pushed.
- **`Pull Request is still a draft`** comes back from `gh pr merge`. Run `gh pr ready <n>` first; an agent that died mid-flight often left the draft flag set.
- **`merge commit cannot be cleanly created`** means the branch is behind `main`, not that the content conflicts. `git rebase origin/main`, resolve, `--force` push. When two sides edited the same doc paragraph, check whether they are complementary before picking one: in one case `main` described a kernel-notification limitation while the branch described a new opt-in scope, and keeping both was the only lossless resolution.

### A task body that never reaches the host

A two-step dispatch (fetch the body to the coordinator, then write the launcher there) silently dropped the `scp`. The agent received a 1,065-byte file containing only the "Environment for this run" appendix — no objective — and wandered the repository while every liveness signal looked healthy. Guard the dispatch:

```bash
[ -s "$SRC" ] || { echo "ABORT: task body missing"; exit 1; }
head -2 "$T"          # must be the task's own heading, not the appendix
```

And because a running `codex exec` cannot be steered, a wrong task means kill and relaunch, not edit.

## 19. Never enumerate "all instances"

A namespace shared with the user can contain machines that are not yours. During one session
`DescribeInstances` returned four live instances and **two of them were the user's own** (both named
`sdt1`), running experiments elsewhere. The only reason nothing bad happened is that every delete path
was written against an explicit name or a locally recorded id:

```bash
# right: delete by the id this session recorded
ID=$(cat /tmp/perf-final-id); aliyun ecs DeleteInstance --InstanceId "$ID"

# wrong: delete whatever looks idle
for i in $(aliyun ecs DescribeInstances ... | awk '{print $1}'); do ...; done
```

Rules that follow from it:

- Sweeps may be read-only and broad; **mutations must be narrowed to a recorded id or a name this
  session created**. Keep an append-only `registry.tsv` of `name / id / created / owner` and treat it
  as the only authority for "mine".
- Before any bulk cleanup, print the live inventory and check that every target appears in your
  registry. If an entry does not, it is not yours.
- Cost reporting must be able to name the instances it is counting. "Total instances" is not a number
  you can act on when someone else is spending in the same account.
- The same applies to paths. A disk cleanup should match `pulled/<my-instance-name>` and
  `*/target` directories verified to have no open files, never "the largest directories on the box".
  In this session that distinction removed 57 GB of rebuildable `target/` output and 610 MB of dead
  instance backups, while leaving four unrelated repositories and two of the user's instances intact.

## 20. Liveness thresholds, learned by getting them wrong ten times

Every false alarm in this session came from reading a signal that does not track liveness. The
thresholds that do work:

| signal | healthy | call it stuck at | what it does *not* tell you |
|---|---|---|---|
| agent log mtime age | < 60 s | > 300 s | nothing about progress rate |
| `n / required_n` in the ledger | increments per repetition | same cell unchanged 30 min | it is not a verdict — a row's `failures` text is *last attempt's reason*, not a death sentence |
| instance `mounts` + `fio`/`brewfs` processes | at least one present | both absent for 5 min | `mounts=0` during teardown is normal |
| `cells.csv` mtime age | < 300 s | > 1800 s (guard uses 2400) | it advances once per repetition, not per syscall |
| `tmux ls` output | — | — | truncated output looks exactly like deleted sessions |
| `git status --porcelain \| wc -l` | — | — | **useless for liveness**: editing a tracked file does not change the count |
| a log file's *size* | — | — | xfstests writes only at case boundaries; a static byte count is normal mid-case |
| `aliyun ... --output cols=... rows=...` | — | — | can return an empty table for a healthy account; parse the JSON instead |

Two concrete cases, both of which nearly caused a wrong action:

- `dirty=10` sat unchanged for minutes while the agent was editing five files and compiling in a
  loop; the only signals that moved were the log's mtime and a fresh `rustc`.
- `DescribeInstances --output cols` printed a header and **no rows**, which reads as "everything was
  deleted". Parsing the JSON showed the instances present, and `ssh ... uptime` on each confirmed
  them alive at 2 h 31 m and 57 m.

So: when a signal says "nothing is happening", cross-check with a signal of a different kind before
acting. Cheap cross-checks in order of preference: `ssh <box> 'echo alive; uptime'`, the log's mtime,
the process list, then the ledger.
