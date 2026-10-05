# Tasks

A task is a unit of work on one existing branch. It gets its own worktree, and every
thread you start in it shares that worktree, so you can run several conversations against the
same branch side by side. The task follows the branch's pull request through review and merge.

Tasks are available on web and desktop.

## Start a task

Choose **New task** in the sidebar or the command palette and pick an existing branch. Local
branches show right away; remote branches appear once the remote has been fetched. Merge checks
the branch out in a new worktree that tracks the remote branch, and sets up the workspace. A
local branch that isn't on the remote yet is checked out as is; its pull request is found once
you push it. A task never creates a branch.

Git lets only one worktree check out a branch at a time. If another worktree already has the
branch checked out, choose **Detach and continue**: that worktree switches to a detached HEAD at
the same commit, keeping its files and uncommitted changes, and the task gets its own worktree.
Uncommitted changes don't move to the task. Commit and push them first if the task needs them. A
branch checked out in the project's main checkout must be switched away by hand.

Agents can start tasks too. When an agent finds that the work belongs in another project, for
example a fix that turns out to be in the backend, it can create the branch there and call the
`create_task` tool. The new task takes over the agent's worktree as is, uncommitted changes
included, and shows up on the Taskboard. The other project must already be added to Merge.

## Workspace setup

Setup runs in order: fetch, worktree, copy rules, then the project's setup scripts (the actions
set to run when a worktree is created). Each step keeps its log. When a step fails, the worktree stays and
you can retry; finished steps are not repeated, so fix the cause (for example the `t3.json` rule
or the script) and retry.

Untracked files your branch needs, such as local env files, are not in the checkout. Add them in
**Settings → Projects → Workspace files** to copy them from the project's main checkout. They are
saved under `workspace.copy` in that checkout's `t3.json`, which you can also edit directly:

```json
{
  "workspace": {
    "copy": [
      { "from": ".env.local", "required": true },
      { "from": "config/dev.json", "to": "config/local.json", "overwrite": true }
    ]
  }
}
```

`from` is relative to the main checkout and can be a file or a folder. `to` defaults to `from`.
A missing source is skipped unless `required` is set, in which case setup fails. An existing
destination is kept unless `overwrite` is set.

## Pull requests, checks, and review

You don't link a pull request yourself. Merge looks for a pull request from the task's branch
about once a minute, links it, and keeps its checks, review decision, and merge state current on
the task. The task's status sums this up together with what its threads are doing, such as
**Checks failing**, **Changes requested**, or **Ready to merge**.

When the pull request is merged, the task shows **Merged**. Nothing is cleaned up: the worktree
and threads stay until you archive the task.

## Review feedback

With **Auto-handle review feedback** on, new review comments start an automated thread in the
task that asks the agent to address them. Comments that arrive together go into one thread.
Comments from bots or your own account, approvals, and comments in resolved conversations don't
count.

- If any thread in the task is running, the comments wait and are picked up once it stops, so
  only one agent changes the worktree at a time.
- Comments that already existed when the task first linked the pull request are never handled
  automatically.
- The option is on by default. Turn it off when creating the task or from the task's actions
  menu; comments that arrive while it is off are handled once you turn it back on.

Failing checks are tracked in the task's status but don't start a thread.

## Linked tasks

When the same change spans several repositories, give each repository's task the same branch
name. Tasks on the same branch are linked: the sidebar shows a link count next to them, hovering
one highlights the others, and right-clicking a task offers **Open in…** to jump to another.
Archiving a task removes it from its links.

## Archive a task

Archiving stops the task's agents, closes its terminals, removes the worktree, and archives its
threads. The remote branch, the pull request, and the thread history stay.

Merge asks you to confirm when archiving could lose work: uncommitted changes, commits that
were never pushed, an open pull request, or an agent that is still running.

## Taskboard

The Taskboard, from the sidebar or **Open Taskboard** in the command palette, shows one card per
task across projects in five columns: working, needs you, in review, ready to merge, and merged.
Merged tasks stay in their column until you archive them; archived tasks collect in the Archive
section at the bottom. Click a card to open its latest thread; right-click it for the same
actions as in the sidebar.

To keep the sidebar's Tasks section focused, use the filter menu in the Tasks header to pick which
projects show. Hidden projects keep their tasks, still appear on the Taskboard, and show up again
while you search. The same menu sorts tasks within each project by newest, recent activity, or
status.

## Known limits

- The mobile app shows task threads as ordinary threads, without the task around them.
- CI failures are tracked but not fixed automatically.
