# Tasks

A task sits between a project and its threads. It owns one workspace, a worktree checked out on an
existing remote branch, and its threads all run in that worktree. The
[user guide](../user/tasks.md) covers the behavior; this page covers the constraints that are easy
to break from code that predates tasks.

## The task owns the worktree, not its threads

Task threads carry the workspace's `worktreePath` and `branch` so provider, terminal, git, and pull
request code works on them unchanged. That makes them look like ordinary worktree threads to every
path that cleans worktrees up after threads, and those paths assume the last thread out owns the
worktree. For a task that is wrong: deleting or archiving every thread must leave the workspace in
place, and only [`TaskWorkspaceService.archive`](../../apps/server/src/task/TaskWorkspaceService.ts)
removes it.

Two guards enforce this: [`storageCleanup`](../../apps/server/src/storageCleanup.ts) excludes active
task workspace paths from every cleanup rule, and `vcs.removeWorktree` in
[`ws.ts`](../../apps/server/src/ws.ts) refuses a path an active task owns. The web client's
[worktree cleanup](../../apps/web/src/worktreeCleanup.ts) also skips task threads. A new path that
removes worktrees needs the same check.

## Workspaces never create branches

Workspace creation fetches the remote, requires the branch to exist there, and checks out a local
branch of the same name tracking it. It must not pass a new ref name to `createWorktree`, which would
create a branch pointing elsewhere and leave the pull request unseen. The task's branch is the join
key to its pull request.

## The supervisor is stateless; the ledger is not

[`TaskSupervisorReactor`](../../apps/server/src/task/TaskSupervisorReactor.ts) holds no memory
between ticks or across restarts. Everything it has seen lives in the task read model and the
`task_scm_events` ledger ([`TaskScmEvents`](../../apps/server/src/persistence/TaskScmEvents.ts)).
Ledger keys are derived deterministically from the host, repository, pull request number, and the
event's own identity ([`taskWorkspaceEvents`](../../apps/server/src/task/taskWorkspaceEvents.ts)),
and `provider_event_key` is unique, so re-observing an event is a no-op. Dispatch claims pending rows
with one atomic `UPDATE … RETURNING` before creating a thread, so two evaluations cannot both act on
the same comment. Keep any new automation on this claim rather than on in-memory flags.

Comments that exist when a task first links its pull request are recorded as `ignored`. Without
that baseline, linking a long-running pull request would replay its whole review history into an
automated thread.

## Status has one owner

A task's status is decided only by
[`deriveTaskStatus`](../../packages/shared/src/taskStatus.ts), from persisted task inputs and what its
threads are doing. Neither the server nor a client stores or recomputes it elsewhere; add a new
input there instead of branching on task fields in UI code.

## Shell compatibility and projection

Task shell events reach only subscribers that pass `includeTasks`, so older clients that cannot
decode them keep working. Clients that need tasks must opt in.

Archived tasks stay in the shell as history (the Taskboard lists them), so `task.archived` is an
upsert and clients filter archived tasks out of navigation themselves. Server code that acts on
tasks must exclude archived ones explicitly: the supervisor reads `listActive`, and the worktree
guards above skip archived tasks. To keep the shell small, task shells drop the setup log of every
step that did not fail; the full logs stay in the read model.

An archived task's threads cannot be unarchived and cannot start a turn (the decider refuses both),
because either would let the provider reactor recreate the removed worktree.

Tasks are projected under the projects projector cursor in
[`ProjectionPipeline`](../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts) rather than
a cursor of their own, so they replay together with projects.
