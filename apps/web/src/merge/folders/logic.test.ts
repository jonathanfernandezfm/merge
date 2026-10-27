import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, FolderId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ENV, PROJECT, shell as taskShell } from "../workTasks/testFixtures";
import {
  buildFolderViews,
  filedThreadKeys,
  filedVisibleThreads,
  folderMenuItems,
  parseFolderMenuId,
  unfiledThreads,
  type EnvironmentFolder,
} from "./logic";

const shell = (overrides: Parameters<typeof taskShell>[0]) => ({
  ...taskShell(overrides),
  projectId: PROJECT,
});
const folder = (id: string, title = `Folder ${id}`, environmentId = ENV): EnvironmentFolder => ({
  environmentId,
  id: FolderId.make(id),
  title,
  createdAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-01T09:00:00.000Z",
});
const fileIn = (threadId: string, folderId: string) => ({
  threadId: ThreadId.make(threadId),
  folderId: FolderId.make(folderId),
});

describe("folders logic", () => {
  const folders = [folder("a", "Parked"), folder("b", "Later")];
  const filed = filedThreadKeys(
    folders,
    new Map([[ENV, [fileIn("t1", "a"), fileIn("t2", "b"), fileIn("t3", "gone")]]]),
  );

  it("hides only threads filed in a folder this client knows", () => {
    const threads = [shell({ id: "t1" }), shell({ id: "t3" }), shell({ id: "t4" })];
    expect(unfiledThreads(threads, filed).map((thread) => thread.id)).toEqual(["t3", "t4"]);
    // Same thread in another environment stays.
    const elsewhere = [{ ...shell({ id: "t1" }), environmentId: EnvironmentId.make("env-2") }];
    expect(unfiledThreads(elsewhere, filed)).toBe(elsewhere);
  });

  it("groups visible threads under their folder in the sidebar's project scope", () => {
    const shells = [
      shell({ id: "t1" }),
      shell({ id: "t2", archivedAt: "2026-10-02T00:00:00.000Z" }),
      shell({ id: "t4" }),
    ];
    const views = buildFolderViews({ folders, filed, shells, scopedProjectKeys: null });
    expect(views.map((view) => [view.folder.title, view.threads.map((t) => t.id)])).toEqual([
      ["Parked", ["t1"]],
      ["Later", []],
    ]);
    // Another project in scope: folders stay, their threads leave.
    const otherScope = new Set([`${ENV}:other`]);
    expect(
      buildFolderViews({ folders, filed, shells, scopedProjectKeys: otherScope }).map(
        (view) => view.threads.length,
      ),
    ).toEqual([0, 0]);
  });

  it("gives upstream search the filed threads the list would show", () => {
    const shells = [
      shell({ id: "t1" }),
      shell({ id: "t2", archivedAt: "2026-10-02T00:00:00.000Z" }),
      shell({ id: "t3" }),
      shell({ id: "t4", subagentOf: "t1" }),
    ];
    const filedWithChild = new Map([
      ...filed,
      [scopedThreadKey(scopeThreadRef(ENV, ThreadId.make("t4"))), "folder"],
    ]);
    expect(filedVisibleThreads(shells, filedWithChild, null).map((thread) => thread.id)).toEqual([
      "t1",
    ]);
    expect(filedVisibleThreads(shells, filed, new Set([`${ENV}:${PROJECT}`]))).toHaveLength(1);
    expect(filedVisibleThreads(shells, filed, new Set([`${ENV}:other`]))).toEqual([]);
    expect(filedVisibleThreads(shells, new Map(), null)).toEqual([]);
  });

  it("builds the Move to folder menu and parses its ids back", () => {
    const [menu, remove] = folderMenuItems({ folders, currentFolderId: FolderId.make("a") });
    expect(menu?.children?.map((child) => [child.id, child.checked ?? false])).toEqual([
      ["merge:folder:move:a", true],
      ["merge:folder:move:b", false],
      ["merge:folder:new", false],
    ]);
    expect(remove?.label).toBe("Remove from folder");
    expect(folderMenuItems({ folders: [], currentFolderId: null })).toHaveLength(1);
    expect(parseFolderMenuId("merge:folder:move:b")).toEqual({ kind: "move", folderId: "b" });
    expect(parseFolderMenuId("merge:folder:new")).toEqual({ kind: "new" });
    expect(parseFolderMenuId("merge:folder:remove")).toEqual({ kind: "remove" });
    expect(parseFolderMenuId("merge:folder:menu")).toBeNull();
  });
});
