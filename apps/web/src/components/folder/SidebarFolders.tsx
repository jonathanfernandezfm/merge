import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, FolderClosedIcon, FolderOpenIcon, FolderPlusIcon } from "lucide-react";
import { memo, useCallback, type MouseEvent, type ReactNode } from "react";

import { useFolderActions } from "~/hooks/useFolderActions";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { type EnvironmentFolder, folderKey } from "~/state/folders";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import { SidebarGroup } from "../ui/sidebar";
import { TooltipProvider } from "../ui/tooltip";

const SECTION_EXPANDED_KEY = "t3code:sidebar:folders-expanded";
const FOLDERS_EXPANDED_KEY = "t3code:sidebar:folders-open";
const FoldersExpandedSchema = Schema.Record(Schema.String, Schema.Boolean);

/** Which list a filed thread's row mimics: parked threads keep their slim shelf look. */
export type SidebarFolderThreadSection = "active" | "snoozed" | "settled";

export interface SidebarFolderThread {
  readonly thread: EnvironmentThreadShell;
  readonly section: SidebarFolderThreadSection;
}

type FolderMenuAction = "rename" | "delete";

/**
 * User folders for parking threads, between Tasks and Threads. Filed threads
 * render with the Threads list's own row (`renderThread`), so status,
 * opening, and the thread menu behave the same. Open state is device-local.
 * Renders nothing when no folder exists and no environment can create one.
 */
export const SidebarFolders = memo(function SidebarFolders({
  folders,
  threadsByFolder,
  createEnvironmentId,
  renderThread,
}: {
  folders: ReadonlyArray<EnvironmentFolder>;
  /** Filed threads keyed by `folderKey`, in display order. */
  threadsByFolder: ReadonlyMap<string, ReadonlyArray<SidebarFolderThread>>;
  /** Where the header's New folder creates; null hides the button. */
  createEnvironmentId: EnvironmentId | null;
  renderThread: (entry: SidebarFolderThread) => ReactNode;
}) {
  const { promptCreateFolder, promptRenameFolder, confirmDeleteFolder } = useFolderActions();
  const [expanded, setExpanded] = useLocalStorage(SECTION_EXPANDED_KEY, true, Schema.Boolean);
  const [openFolders, setOpenFolders] = useLocalStorage(
    FOLDERS_EXPANDED_KEY,
    {},
    FoldersExpandedSchema,
  );

  const openFolderMenu = useCallback(
    (folder: EnvironmentFolder, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const clicked = await settlePromise(() =>
          api.contextMenu.show<FolderMenuAction>(
            [
              { id: "rename", label: "Rename folder", icon: "pencil" },
              { id: "delete", label: "Delete folder", icon: "trash", destructive: true },
            ],
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        if (clicked.value === "rename") await promptRenameFolder(folder);
        else if (clicked.value === "delete") await confirmDeleteFolder(folder);
      })();
    },
    [confirmDeleteFolder, promptRenameFolder],
  );

  if (folders.length === 0 && createEnvironmentId === null) return null;

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
        {createEnvironmentId !== null ? (
          <SidebarHeaderIconButton
            label="New folder"
            onClick={() => void promptCreateFolder(createEnvironmentId)}
          >
            <FolderPlusIcon />
          </SidebarHeaderIconButton>
        ) : null}
      </div>
      {!expanded ? null : folders.length === 0 ? (
        <p className="h-8 ps-2 pe-2 text-sm leading-8 text-sidebar-muted-foreground/70">
          No folders
        </p>
      ) : (
        <TooltipProvider delay={150} closeDelay={0} timeout={400}>
          <ul className="flex flex-col gap-px pb-2">
            {folders.map((folder) => {
              const key = folderKey(folder);
              const threads = threadsByFolder.get(key) ?? [];
              const open = openFolders[key] ?? false;
              const Icon = open ? FolderOpenIcon : FolderClosedIcon;
              return (
                <li key={key} className="flex flex-col">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpenFolders((value) => ({ ...value, [key]: !open }))}
                    onContextMenu={(event: MouseEvent) => {
                      event.preventDefault();
                      openFolderMenu(folder, { x: event.clientX, y: event.clientY });
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
                    <ul role="presentation" className="flex flex-col gap-px">
                      {threads.map(renderThread)}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </TooltipProvider>
      )}
    </SidebarGroup>
  );
});
