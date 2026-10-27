import { EnvironmentId, FolderId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ENV, shell } from "../workTasks/testFixtures";
import {
  buildFolderViews,
  filedThreadKeys,
  folderMenuItems,
  parseFolderMenuId,
  unfiledThreads,
  type EnvironmentFolder,
} from "./logic";

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

  it("groups live threads under their folder and searches titles", () => {
    const shells = [
      shell({ id: "t1" }),
      shell({ id: "t2", archivedAt: "2026-10-02T00:00:00.000Z" }),
      shell({ id: "t4" }),
    ];
    const views = buildFolderViews({ folders, filed, shells });
    expect(views.map((view) => [view.folder.title, view.threads.map((t) => t.id)])).toEqual([
      ["Parked", ["t1"]],
      ["Later", []],
    ]);
    expect(
      buildFolderViews({ folders, filed, shells, query: "later" }).map((v) => v.folder.title),
    ).toEqual(["Later"]);
    expect(
      buildFolderViews({ folders, filed, shells, query: "thread t1" }).map((v) => [
        v.folder.title,
        v.threads.length,
      ]),
    ).toEqual([["Parked", 1]]);
    expect(buildFolderViews({ folders, filed, shells, query: "nothing" })).toEqual([]);
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
