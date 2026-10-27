import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  WorkTaskId,
  type ThreadPullRequestLink,
  type WorkTaskLink,
} from "@t3tools/contracts";

import type { EnvironmentWorkTask } from "./logic";

export const ENV = EnvironmentId.make("env-1");
export const PROJECT = ProjectId.make("project-1");

export function workTask(
  overrides: Partial<Omit<EnvironmentWorkTask, "workspace" | "id">> & {
    readonly id: string;
    readonly branch?: string;
    readonly setup?: "pending" | "running" | "ready" | "failed";
  },
): EnvironmentWorkTask {
  const { id, branch = "feature/x", setup = "ready", ...rest } = overrides;
  return {
    environmentId: ENV,
    id: WorkTaskId.make(id),
    projectId: PROJECT,
    title: `Task ${id}`,
    description: null,
    workspace: {
      path: `/tmp/${id}`,
      branch,
      remoteName: "origin",
      remoteBranch: branch,
      baseBranch: null,
      setup: { status: setup, steps: [], error: null, updatedAt: "2026-10-01T09:00:00.000Z" },
    },
    legacyPullRequest: null,
    autoHandleReviewFeedback: true,
    waitingForUserReason: null,
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
    mergedAt: null,
    archivedAt: null,
    deletedAt: null,
    ...rest,
  };
}

type ShellOverrides = {
  readonly id: string;
  readonly running?: boolean;
  readonly ran?: boolean;
  readonly waiting?: boolean;
  readonly monitoring?: boolean;
  readonly subagentOf?: string;
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink>;
} & Partial<
  Pick<
    EnvironmentThreadShell,
    "createdAt" | "updatedAt" | "latestUserMessageAt" | "archivedAt" | "settledAt"
  >
>;

export function shell(overrides: ShellOverrides): EnvironmentThreadShell {
  const {
    id,
    running,
    ran,
    waiting,
    monitoring,
    subagentOf,
    pullRequests = [],
    ...rest
  } = overrides;
  const lineage = {
    rootThreadId: subagentOf ?? id,
    parentThreadId: subagentOf ?? null,
    relationshipToParent: subagentOf === undefined ? null : "subagent",
  };
  const source = {
    id,
    lineage,
    latestRunId: ran || running ? "run-1" : null,
    activeRunId: running ? "run-1" : null,
    status: running ? "running" : "idle",
    pendingRuntimeRequest: waiting ? { kind: "approval" } : null,
    pendingBackgroundTasks: monitoring ? [{ id: "watch" }] : [],
    pullRequests,
  };
  return {
    environmentId: ENV,
    id: ThreadId.make(id),
    title: `Thread ${id}`,
    lineage,
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
    latestUserMessageAt: null,
    archivedAt: null,
    deletedAt: null,
    settledAt: null,
    pullRequests,
    source,
    ...rest,
  } as unknown as EnvironmentThreadShell;
}

export function link(threadId: string, taskId: string, origin: WorkTaskLink["origin"] = "user") {
  return { threadId: ThreadId.make(threadId), taskId: WorkTaskId.make(taskId), origin };
}
