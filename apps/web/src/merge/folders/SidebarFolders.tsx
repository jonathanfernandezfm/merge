import { useAtomValue } from "@effect/atom-react";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, FolderClosedIcon, FolderOpenIcon, FolderPlusIcon } from "lucide-react";
import { memo, useState, type MouseEvent } from "react";

import { canShareWithGuestAtom } from "~/components/chat/guestShareAvailability";
import { hasUnseenCompletion, resolveThreadLastVisitedAt } from "~/components/Sidebar.logic";
import { SidebarHeaderIconButton } from "~/components/sidebar/SidebarThreadHeader";
import {
  ThreadRowLeadingStatus,
  ThreadRowTrailingStatus,
} from "~/components/ThreadStatusIndicators";
import { SidebarGroup, useSidebar } from "~/components/ui/sidebar";
import { toastManager } from "~/components/ui/toast";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { useProject } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { readEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { useUiStateStore } from "~/uiStateStore";
import { confirmDeleteFolder, openNewFolderDialog, openRenameFolderDialog } from "./FolderDialogs";
import type { EnvironmentFolder } from "./logic";
import { useFolderEnvironments, useFolderViews } from "./state";

const EXPANDED_KEY = "merge:folders:expanded";
const OPEN_FOLDERS_KEY = "merge:folders:open";
const OpenFoldersSchema = Schema.Record(Schema.String, Schema.Boolean);

/**
 * Folders that park threads out of the Threads list, in the sidebar's project scope. Hidden while
 * searching: upstream's search lists filed threads itself. Open state is per browser. Renders
 * nothing when no folder exists and none can be created.
 */
export const SidebarFolders = memo(function SidebarFolders({
  searchQuery = "",
  scopedProjectKeys = null,
}: {
  searchQuery?: string;
  scopedProjectKeys?: ReadonlySet<string> | null;
}) {
  const views = useFolderViews(scopedProjectKeys);
  const environments = useFolderEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const createIn =
    primaryEnvironmentId !== null && environments.includes(primaryEnvironmentId)
      ? primaryEnvironmentId
      : (environments[0] ?? null);
  const active = useParams({
    strict: false,
    select: (value) => ({
      environmentId: value.environmentId as EnvironmentId | undefined,
      threadId: "threadId" in value ? (value.threadId as ThreadId | undefined) : undefined,
    }),
  });
  const [expanded, setExpanded] = useLocalStorage(EXPANDED_KEY, true, Schema.Boolean);
  const [openFolders, setOpenFolders] = useLocalStorage(OPEN_FOLDERS_KEY, {}, OpenFoldersSchema);

  if (searchQuery.trim().length > 0 || (views.length === 0 && createIn === null)) return null;

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

  return (
    <SidebarGroup className="shrink-0">
      <div className="group/folders-header flex h-8 items-center gap-1 ps-2">
        <button
          type="button"
          aria-expanded={expanded}
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
            const open = openFolders[key] ?? false;
            const Icon = open ? FolderOpenIcon : FolderClosedIcon;
            return (
              <li key={key} className="flex flex-col">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label={`${folder.title}, ${threads.length} threads`}
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
                    {threads.map((thread) => (
                      <FolderThreadRow
                        key={thread.id}
                        thread={thread}
                        active={
                          thread.environmentId === active.environmentId &&
                          thread.id === active.threadId
                        }
                      />
                    ))}
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

/** A filed thread with upstream's status indicators and its full thread menu. */
const FolderThreadRow = memo(function FolderThreadRow({
  thread,
  active,
}: {
  thread: EnvironmentThreadShell;
  active: boolean;
}) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const project = useProject(scopeProjectRef(thread.environmentId, thread.projectId));
  const canShareWithGuest = useAtomValue(canShareWithGuestAtom(thread.environmentId));
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const unseen = hasUnseenCompletion({
    ...thread,
    lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
  });
  const [renaming, setRenaming] = useState<string | null>(null);
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const { openMenu } = useThreadActionMenu({
    threadRef,
    projectCwd: thread.worktreePath ?? project?.workspaceRoot ?? null,
    onStartRename: () => setRenaming(thread.title),
    canShareWithGuest,
  });
  const commitRename = (title: string) => {
    setRenaming(null);
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
      return;
    }
    if (trimmed === thread.title) return;
    void updateMetadata({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, title: trimmed },
    }).then((result) => {
      if (result._tag === "Failure") {
        toastManager.add({ type: "error", title: "Failed to rename thread" });
      }
    });
  };

  return (
    <li>
      {renaming !== null ? (
        <input
          autoFocus
          aria-label="Thread title"
          value={renaming}
          onChange={(event) => setRenaming(event.target.value)}
          onBlur={() => commitRename(renaming)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitRename(renaming);
            else if (event.key === "Escape") setRenaming(null);
          }}
          className="ms-8 h-8 w-[calc(100%-2rem)] rounded-sm border border-input bg-card px-1 text-sm text-card-foreground outline-none focus:border-foreground"
        />
      ) : (
        <button
          type="button"
          aria-current={active ? "page" : undefined}
          onClick={() => {
            if (isMobile) setOpenMobile(false);
            void navigate({ to: "/$environmentId/$threadId", params: threadRef });
          }}
          onContextMenu={(event: MouseEvent) => {
            event.preventDefault();
            openMenu({ x: event.clientX, y: event.clientY });
          }}
          className={cn(
            "flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md ps-8 pe-2 text-left text-sm",
            active
              ? "bg-primary/8 text-sidebar-foreground"
              : "text-sidebar-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
            unseen && "font-semibold text-sidebar-foreground",
          )}
        >
          <ThreadRowLeadingStatus thread={thread} />
          <span className="min-w-0 flex-1 truncate">{thread.title}</span>
          <ThreadRowTrailingStatus thread={thread} />
        </button>
      )}
    </li>
  );
});
