import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope, type ThreadId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, FolderClosedIcon, FolderOpenIcon, FolderPlusIcon } from "lucide-react";
import { memo, type MouseEvent } from "react";

import { hasUnseenCompletion } from "~/components/Sidebar.logic";
import { SidebarHeaderIconButton } from "~/components/sidebar/SidebarThreadHeader";
import { SidebarGroup, useSidebar } from "~/components/ui/sidebar";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { readEnvironmentScope } from "~/state/session";
import { confirmDeleteFolder, openNewFolderDialog, openRenameFolderDialog } from "./FolderDialogs";
import type { EnvironmentFolder } from "./logic";
import { readFolderMenuItems, useFolderEnvironments, useFolderViews } from "./state";
import { folderThreadMenu } from "./threadMenu";

const EXPANDED_KEY = "merge:folders:expanded";
const OPEN_FOLDERS_KEY = "merge:folders:open";
const OpenFoldersSchema = Schema.Record(Schema.String, Schema.Boolean);

/**
 * Folders that park threads out of the Threads list. Open state is per browser; a search opens
 * every folder with a match. Renders nothing when no folder exists and none can be created.
 */
export const SidebarFolders = memo(function SidebarFolders({
  searchQuery = "",
}: {
  searchQuery?: string;
}) {
  const views = useFolderViews(searchQuery);
  const environments = useFolderEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const createIn =
    primaryEnvironmentId !== null && environments.includes(primaryEnvironmentId)
      ? primaryEnvironmentId
      : (environments[0] ?? null);
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const activeThreadId = useParams({
    strict: false,
    select: (value) => ("threadId" in value ? (value.threadId as ThreadId | undefined) : undefined),
  });
  const [storedExpanded, setExpanded] = useLocalStorage(EXPANDED_KEY, true, Schema.Boolean);
  const [openFolders, setOpenFolders] = useLocalStorage(OPEN_FOLDERS_KEY, {}, OpenFoldersSchema);
  const searching = searchQuery.trim().length > 0;
  const expanded = searching || storedExpanded;

  if (searching ? views.length === 0 : views.length === 0 && createIn === null) return null;

  const openFolderMenu = async (folder: EnvironmentFolder, position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const disabled = !readEnvironmentScope(folder.environmentId, AuthOrchestrationOperateScope);
    const clicked = await settlePromise(() =>
      api.contextMenu.show<"rename" | "delete">(
        [
          { id: "rename", label: "Rename folder", icon: "pencil", disabled },
          { id: "delete", label: "Delete folder", icon: "trash", destructive: true, disabled },
        ],
        position,
      ),
    );
    if (clicked._tag === "Failure") return;
    if (clicked.value === "rename") openRenameFolderDialog(folder);
    else if (clicked.value === "delete") await confirmDeleteFolder(folder);
  };

  const openThreadMenu = async (
    thread: EnvironmentThreadShell,
    position: { x: number; y: number },
  ) => {
    const api = readLocalApi();
    if (!api) return;
    const threadRef = scopeThreadRef(thread.environmentId, thread.id);
    const disabled = !readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
    const items = readFolderMenuItems(threadRef).map((item) => ({ ...item, disabled }));
    const clicked = await settlePromise(() => api.contextMenu.show(items, position));
    if (clicked._tag === "Failure" || clicked.value == null) return;
    folderThreadMenu.handle(clicked.value, threadRef);
  };

  return (
    <SidebarGroup className="shrink-0">
      <div className="group/folders-header flex h-8 items-center gap-1 ps-2">
        <button
          type="button"
          aria-expanded={expanded}
          disabled={searching}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left text-sm text-sidebar-muted-foreground/70 hover:text-sidebar-foreground"
        >
          <span className="shrink-0">Folders</span>
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 opacity-0 transition-[opacity,transform] group-hover/folders-header:opacity-100 group-focus-within/folders-header:opacity-100",
              !expanded && "-rotate-90 opacity-100",
            )}
          />
        </button>
        {createIn !== null ? (
          <SidebarHeaderIconButton label="New folder" onClick={() => openNewFolderDialog(createIn)}>
            <FolderPlusIcon />
          </SidebarHeaderIconButton>
        ) : null}
      </div>
      {!expanded ? null : views.length === 0 ? (
        <p className="h-8 ps-2 pe-2 text-sm leading-8 text-sidebar-muted-foreground/70">
          No folders
        </p>
      ) : (
        <ul className="flex flex-col gap-px pb-2">
          {views.map(({ key, folder, threads }) => {
            const open = searching || (openFolders[key] ?? false);
            const Icon = open ? FolderOpenIcon : FolderClosedIcon;
            return (
              <li key={key} className="flex flex-col">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label={`${folder.title}, ${threads.length} threads`}
                  disabled={searching}
                  onClick={() => setOpenFolders((value) => ({ ...value, [key]: !open }))}
                  onContextMenu={(event: MouseEvent) => {
                    event.preventDefault();
                    void openFolderMenu(folder, { x: event.clientX, y: event.clientY });
                  }}
                  className="flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md ps-2 pe-2 text-left text-sidebar-foreground/85 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                >
                  <Icon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">{folder.title}</span>
                  <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
                    {threads.length}
                  </span>
                </button>
                {!open ? null : threads.length === 0 ? (
                  <p className="h-8 ps-8 pe-2 text-sm leading-8 text-sidebar-muted-foreground/70">
                    No threads
                  </p>
                ) : (
                  <ul className="flex flex-col gap-px">
                    {threads.map((thread) => {
                      const unseen = hasUnseenCompletion({
                        ...thread,
                        lastVisitedAt: thread.lastVisitedAt,
                      });
                      const active = thread.id === activeThreadId;
                      return (
                        <li key={thread.id}>
                          <button
                            type="button"
                            aria-current={active ? "page" : undefined}
                            onClick={() => {
                              if (isMobile) setOpenMobile(false);
                              void navigate({
                                to: "/$environmentId/$threadId",
                                params: {
                                  environmentId: thread.environmentId,
                                  threadId: thread.id,
                                },
                              });
                            }}
                            onContextMenu={(event: MouseEvent) => {
                              event.preventDefault();
                              void openThreadMenu(thread, { x: event.clientX, y: event.clientY });
                            }}
                            className={cn(
                              "flex h-8 w-full min-w-0 cursor-pointer items-center rounded-md ps-8 pe-2 text-left text-sm",
                              active
                                ? "bg-primary/8 text-sidebar-foreground"
                                : "text-sidebar-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                              unseen && "font-semibold text-sidebar-foreground",
                            )}
                          >
                            <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SidebarGroup>
  );
});
