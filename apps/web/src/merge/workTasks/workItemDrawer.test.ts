import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { describe, expect, it } from "vite-plus/test";

import {
  itemDrawerTerminals,
  itemTabLabel,
  itemTabLaunchLocation,
  memberForCwd,
  runningItemMemberCommands,
  workItemDrawerThreadRef,
  type WorkItemDrawerMember,
} from "./workItemDrawer";
import { ENV, workTask } from "./testFixtures";
import { workTaskKey, type WorkTaskView } from "./logic";

const members: ReadonlyArray<WorkItemDrawerMember> = [
  {
    worktreePath: "/wt/esm-607374",
    projectRoot: "/repos/esm",
    projectRef: scopeProjectRef(EnvironmentId.make("env"), ProjectId.make("p-esm")),
    label: "esm",
  },
  {
    worktreePath: "/wt/esm-ui-607374",
    projectRoot: "/repos/esm-ui",
    projectRef: scopeProjectRef(EnvironmentId.make("env"), ProjectId.make("p-ui")),
    label: "esm-ui",
  },
];

function view(branch: string): WorkTaskView {
  const task = workTask({ id: "t1", branch });
  return {
    key: workTaskKey(ENV, task.id),
    task,
    tabs: [],
    status: "working",
  } as unknown as WorkTaskView;
}

describe("workItemDrawer", () => {
  const threadRef = scopeThreadRef(ENV, ThreadId.make("thread-1"));

  it("workItemDrawerThreadRef keys the drawer by the branch's item", () => {
    const ref = workItemDrawerThreadRef(threadRef, view("feature/#607374-copy-link"));
    expect(ref.threadId).toBe("work-item:607374");
    expect(ref.environmentId).toBe(threadRef.environmentId);
  });

  it("workItemDrawerThreadRef keeps the thread ref without an id in the branch", () => {
    expect(workItemDrawerThreadRef(threadRef, view("fix/copy-link"))).toBe(threadRef);
    expect(workItemDrawerThreadRef(threadRef, null)).toBe(threadRef);
  });

  it("itemTabLaunchLocation ignores the active launch context", () => {
    const location = itemTabLaunchLocation(
      { cwd: "/wt/esm-607374", worktreePath: "/wt/esm-607374" },
      members,
      "/repos/other",
    );
    expect(location.cwd).toBe("/wt/esm-607374");
    expect(location.runtimeEnv).toEqual(
      projectScriptRuntimeEnv({
        project: { cwd: "/repos/esm" },
        worktreePath: "/wt/esm-607374",
      }),
    );
  });

  it("itemTabLaunchLocation takes the root from the worktree owner when cwd is outside it", () => {
    const location = itemTabLaunchLocation(
      { cwd: "/tmp/elsewhere", worktreePath: "/wt/esm-607374" },
      members,
      "/repos/other",
    );
    expect(location.cwd).toBe("/tmp/elsewhere");
    expect(location.runtimeEnv).toEqual(
      projectScriptRuntimeEnv({ project: { cwd: "/repos/esm" }, worktreePath: "/wt/esm-607374" }),
    );
  });

  it("itemTabLaunchLocation falls back to the given root when no member owns the tab", () => {
    const location = itemTabLaunchLocation(
      { cwd: "/tmp/elsewhere", worktreePath: null },
      members,
      "/repos/other",
    );
    expect(location.runtimeEnv).toEqual(
      projectScriptRuntimeEnv({ project: { cwd: "/repos/other" }, worktreePath: null }),
    );
  });

  it("memberForCwd picks the deepest matching worktree", () => {
    const nested = [...members, { ...members[0]!, worktreePath: "/wt/esm-607374/sub" }];
    expect(memberForCwd(members, "/wt/esm-ui-607374/app")?.label).toBe("esm-ui");
    expect(memberForCwd(nested, "/wt/esm-607374/sub/x")?.worktreePath).toBe("/wt/esm-607374/sub");
    expect(memberForCwd(members, "/elsewhere")).toBeNull();
  });

  it("itemTabLabel uses the member label", () => {
    expect(itemTabLabel("Dev server", members, "/wt/esm-ui-607374")).toBe("Dev server (esm-ui)");
    const branched = [{ ...members[0]!, label: "esm · feature/x" }];
    expect(itemTabLabel("Dev", branched, "/wt/esm-607374")).toBe("Dev (esm · feature/x)");
    expect(itemTabLabel("Dev", members, "/elsewhere")).toBe("Dev");
  });
});

describe("runningItemMemberCommands", () => {
  const session = (threadId: string, cwd: string, running = true) =>
    ({
      target: { threadId, terminalId: "t" },
      state: {
        hasRunningSubprocess: running,
        summary: { cwd, worktreePath: cwd, label: "bun dev" },
      },
    }) as never;
  const item = [
    { key: "k-esm", path: "/wt/esm-607374", threadIds: ["shell-esm"] },
    { key: "k-ui", path: "/wt/esm-ui-607374", threadIds: ["shell-ui"] },
  ];

  it("lights only the repo whose worktree runs an item terminal", () => {
    const sessions = [
      session("work-item:607374", "/wt/esm-ui-607374"),
      session("work-item:607374", "/wt/esm-607374", false),
      session("other", "/wt/esm-607374"),
    ];
    expect(runningItemMemberCommands(sessions, "work-item:607374", item)).toEqual(
      new Map([["k-ui", "bun dev"]]),
    );
  });

  it("keeps the member's own thread terminals, also without an item id", () => {
    const sessions = [session("shell-esm", "/wt/esm-607374")];
    expect(runningItemMemberCommands(sessions, null, item)).toEqual(
      new Map([["k-esm", "bun dev"]]),
    );
  });
});

describe("itemDrawerTerminals", () => {
  const session = (terminalId: string, running: boolean, threadId = "work-item:607374") =>
    ({
      target: { threadId, terminalId },
      state: { hasRunningSubprocess: running, summary: null },
    }) as never;

  it("keeps only the item's terminals, in order, apart from the thread's same-named ones", () => {
    const sessions = [
      session("default", false, "thread-1"),
      session("default", false),
      session("terminal-2", true),
    ];
    const terminals = itemDrawerTerminals(sessions, "work-item:607374");
    expect(terminals.orderedTerminalIds).toEqual(["default", "terminal-2"]);
    expect(terminals.runningTerminalIds).toEqual(["terminal-2"]);
    expect([...terminals.labelsById.keys()]).toEqual(["default", "terminal-2"]);
  });
});
