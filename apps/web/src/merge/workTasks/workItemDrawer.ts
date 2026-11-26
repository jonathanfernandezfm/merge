import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  selectRunningSubprocessTerminalIds,
  type KnownTerminalSession,
} from "@t3tools/client-runtime/state/terminal";
import {
  isPathInside,
  isWorkItemTerminalThreadId,
  ThreadId,
  workItemIdFromBranch,
  workItemTerminalThreadId,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { useState } from "react";

import { useKnownTerminalSessions } from "~/state/terminalSessions";

import type { WorkTaskView } from "./logic";
import { useThreadWorkTask, useWorkTaskItems, useWorkTaskProjects } from "./state";

// Same shape as the private type in PersistentThreadTerminals.
interface TerminalLaunchLocationWithEnv {
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly runtimeEnv: Record<string, string>;
}

export interface WorkItemDrawerMember {
  readonly worktreePath: string;
  readonly projectRoot: string;
  readonly projectRef: ScopedProjectRef;
  readonly label: string;
}

/** The drawer of a Work Task thread belongs to its ADO item; other threads keep their own. */
export function workItemDrawerThreadRef(
  threadRef: ScopedThreadRef,
  view: WorkTaskView | null,
): ScopedThreadRef {
  const id = view === null ? null : workItemIdFromBranch(view.task.workspace.branch);
  return id === null
    ? threadRef
    : scopeThreadRef(threadRef.environmentId, ThreadId.make(workItemTerminalThreadId(id)));
}

/** Keeps `value`'s identity while `key` is unchanged (the inputs are rebuilt every render). */
export function useStableByKey<T>(value: T, key: string): T {
  const [state, setState] = useState({ key, value });
  if (state.key === key) return state.value;
  setState({ key, value });
  return value;
}

export function useWorkItemDrawerRef(threadRef: ScopedThreadRef): ScopedThreadRef {
  const drawerRef = workItemDrawerThreadRef(threadRef, useThreadWorkTask(threadRef));
  const stable = useStableByKey(drawerRef, `${drawerRef.environmentId}:${drawerRef.threadId}`);
  return drawerRef === threadRef ? threadRef : stable;
}

export function useWorkItemDrawerMembers(
  threadRef: ScopedThreadRef,
): ReadonlyArray<WorkItemDrawerMember> | null {
  const isItem = isWorkItemTerminalThreadId(threadRef.threadId);
  // A thread's own drawer reads empty atoms here, so it neither rebuilds nor re-renders.
  const items = useWorkTaskItems(isItem);
  const projects = useWorkTaskProjects(isItem);
  const roots = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project.workspaceRoot]),
  );
  const members: WorkItemDrawerMember[] = [];
  if (isItem) {
    for (const item of items) {
      for (const member of item.members) {
        const { task } = member.view;
        if (task.environmentId !== threadRef.environmentId || task.workspace.path === null)
          continue;
        const id = workItemIdFromBranch(task.workspace.branch);
        if (id === null || workItemTerminalThreadId(id) !== threadRef.threadId) continue;
        members.push({
          worktreePath: task.workspace.path,
          projectRoot: roots.get(`${task.environmentId}:${task.projectId}`) ?? task.workspace.path,
          projectRef: scopeProjectRef(task.environmentId, task.projectId),
          label: member.label,
        });
      }
    }
  }
  const key = !isItem
    ? null
    : JSON.stringify(
        members.map((m) => [m.worktreePath, m.projectRoot, m.projectRef.projectId, m.label]),
      );
  const stable = useStableByKey(members, key ?? "");
  return key === null ? null : stable;
}

/** An item drawer's terminals. They live under the item's key, apart from the thread's panel. */
export interface ItemDrawerTerminals {
  readonly runningTerminalIds: ReadonlyArray<string>;
  readonly orderedTerminalIds: ReadonlyArray<string>;
  readonly labelsById: ReadonlyMap<string, string>;
}

export function itemDrawerTerminals(
  sessions: ReadonlyArray<KnownTerminalSession>,
  itemThreadId: string,
): ItemDrawerTerminals {
  const ofItem = sessions.filter((session) => session.target.threadId === itemThreadId);
  return {
    runningTerminalIds: selectRunningSubprocessTerminalIds(ofItem),
    orderedTerminalIds: ofItem.map((session) => session.target.terminalId),
    labelsById: new Map(
      ofItem.map((session) => [
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      ]),
    ),
  };
}

/** The item drawer's terminals, or null when `drawerRef` is a thread's own drawer. */
export function useItemDrawerTerminals(
  drawerRef: ScopedThreadRef | null,
): ItemDrawerTerminals | null {
  const itemRef =
    drawerRef !== null && isWorkItemTerminalThreadId(drawerRef.threadId) ? drawerRef : null;
  const sessions = useKnownTerminalSessions({
    environmentId: itemRef?.environmentId ?? null,
    threadId: itemRef?.threadId ?? null,
  });
  return itemRef === null ? null : itemDrawerTerminals(sessions ?? [], itemRef.threadId);
}

/** The member whose worktree contains `cwd`; the deepest one wins. */
export function memberForCwd(
  members: ReadonlyArray<WorkItemDrawerMember>,
  cwd: string,
): WorkItemDrawerMember | null {
  let best: WorkItemDrawerMember | null = null;
  for (const member of members) {
    if (
      isPathInside(cwd, member.worktreePath) &&
      (best === null || member.worktreePath.length > best.worktreePath.length)
    ) {
      best = member;
    }
  }
  return best;
}

/**
 * Where an item tab re-attaches: exactly where it launched. The env root is the project that owns
 * the tab's worktree, else the one whose worktree holds its cwd, else `fallbackRoot`.
 */
export function itemTabLaunchLocation(
  summary: { readonly cwd: string; readonly worktreePath: string | null },
  members: ReadonlyArray<WorkItemDrawerMember>,
  fallbackRoot: string,
): TerminalLaunchLocationWithEnv {
  const owner =
    members.find((member) => member.worktreePath === summary.worktreePath) ??
    memberForCwd(members, summary.cwd);
  const root = owner?.projectRoot ?? fallbackRoot;
  return {
    cwd: summary.cwd,
    worktreePath: summary.worktreePath,
    runtimeEnv: projectScriptRuntimeEnv({
      project: { cwd: root },
      worktreePath: summary.worktreePath,
    }),
  };
}

export function itemTabLabel(
  label: string,
  members: ReadonlyArray<WorkItemDrawerMember>,
  cwd: string,
): string {
  const member = memberForCwd(members, cwd);
  return member === null ? label : `${label} (${member.label})`;
}

/**
 * The running command of each item member, by key: a terminal in its worktree under the item's
 * drawer, or one under its own thread ids (the only kind a task without an ADO id has).
 */
export function runningItemMemberCommands(
  sessions: ReadonlyArray<KnownTerminalSession>,
  itemThreadId: string | null,
  members: ReadonlyArray<{
    readonly key: string;
    readonly path: string | null;
    readonly threadIds: ReadonlyArray<string>;
  }>,
): ReadonlyMap<string, string> {
  const drawerMembers = members.flatMap(({ path }) =>
    path === null ? [] : [{ worktreePath: path } as WorkItemDrawerMember],
  );
  const commands = new Map<string, string>();
  for (const session of sessions) {
    if (!session.state.hasRunningSubprocess) continue;
    const { threadId, terminalId } = session.target;
    const cwd = session.state.summary?.cwd;
    const owner =
      members.find((member) => member.threadIds.includes(threadId)) ??
      (threadId === itemThreadId && cwd !== undefined
        ? members.find(({ path }) => path === memberForCwd(drawerMembers, cwd)?.worktreePath)
        : undefined);
    if (owner !== undefined && !commands.has(owner.key)) {
      commands.set(owner.key, resolveTerminalSessionLabel(terminalId, session.state.summary));
    }
  }
  return commands;
}
