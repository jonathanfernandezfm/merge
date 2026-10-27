import "../../index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { SidebarProvider } from "~/components/ui/sidebar";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { render } from "../../../test/render";
import { FolderDialogsHost } from "./FolderDialogs";
import { SidebarFolders } from "./SidebarFolders";

const runFolderCommand = vi.hoisted(() => vi.fn(async () => ({ folderId: "new" })));

vi.mock("./state", async () => {
  const fixtures = await import("../workTasks/testFixtures");
  const logic = await import("./logic");
  const { FolderId, ThreadId } = await import("@t3tools/contracts");
  const folder = (id: string, title: string) => ({
    environmentId: fixtures.ENV,
    id: FolderId.make(id),
    title,
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
  });
  const folders = [folder("parked", "Parked"), folder("later", "Later")];
  const filed = logic.filedThreadKeys(
    folders,
    new Map([
      [fixtures.ENV, [{ threadId: ThreadId.make("t1"), folderId: FolderId.make("parked") }]],
    ]),
  );
  const shells = [fixtures.shell({ id: "t1" }), fixtures.shell({ id: "t2" })];
  const command = { label: "stub" };
  return {
    useFolderViews: (query: string) => logic.buildFolderViews({ folders, filed, shells, query }),
    useFolderEnvironments: () => [fixtures.ENV],
    readFolderMenuItems: () => [],
    runFolderCommand,
    foldersEnvironment: { create: command, rename: command, delete: command, assign: command },
  };
});

vi.mock("./threadMenu", () => ({ folderThreadMenu: { handle: () => true } }));

vi.mock("~/state/environments", async (importOriginal) => {
  const fixtures = await import("../workTasks/testFixtures");
  return {
    ...(await importOriginal<typeof import("~/state/environments")>()),
    usePrimaryEnvironmentId: () => fixtures.ENV,
  };
});

describe("SidebarFolders", () => {
  it("lists folders with their filed threads and creates a folder", async () => {
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <SidebarProvider>
          <SidebarFolders />
          <FolderDialogsHost />
        </SidebarProvider>
      </AppAtomRegistryProvider>,
    );
    await expect.element(page.getByText("Folders", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Later, 0 threads" })).toBeVisible();
    await page.getByRole("button", { name: "Parked, 1 threads" }).click();
    await expect.element(page.getByRole("button", { name: "Thread t1" })).toBeVisible();
    await expect.element(page.getByText("Thread t2")).not.toBeInTheDocument();

    await page.getByRole("button", { name: "New folder" }).click();
    await page.getByRole("dialog").getByLabelText("Name").fill("Someday");
    await page.getByRole("button", { name: "Create" }).click();
    await vi.waitFor(() =>
      expect(runFolderCommand).toHaveBeenCalledWith(
        { label: "stub" },
        { environmentId: "env-1", input: { title: "Someday" } },
        "Could not create the folder",
      ),
    );
  });

  it("shows only folders with a match while searching", async () => {
    await using _screen = await render(
      <SidebarProvider>
        <SidebarFolders searchQuery="thread t1" />
      </SidebarProvider>,
    );
    await expect.element(page.getByRole("button", { name: "Thread t1" })).toBeVisible();
    await expect.element(page.getByText("Later")).not.toBeInTheDocument();
  });
});
