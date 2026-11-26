import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { FolderClosedIcon, FolderOpenIcon, FolderPlusIcon } from "lucide-react";
import { memo, type MouseEvent } from "react";

import { SidebarHeaderIconButton } from "~/components/sidebar/SidebarThreadHeader";
import { SidebarGroup } from "~/components/ui/sidebar";
import { TooltipProvider } from "~/components/ui/tooltip";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { readLocalApi } from "~/localApi";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { readEnvironmentScope } from "~/state/session";
import { MergeThreadRow, useMergeThreadRowProps } from "../MergeThreadRow";
import { SidebarSectionTitle } from "../SidebarSectionTitle";
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
  const [expanded, setExpanded] = useLocalStorage(EXPANDED_KEY, true, Schema.Boolean);
  const rowProps = useMergeThreadRowProps();
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
      <SidebarSectionTitle
        label="Folders"
        toggle={{ expanded, onToggle: () => setExpanded((value) => !value) }}
        actions={
          createIn !== null ? (
            <SidebarHeaderIconButton
              label="New folder"
              onClick={() => openNewFolderDialog(createIn)}
            >
              <FolderPlusIcon />
            </SidebarHeaderIconButton>
          ) : null
        }
      />
      {!expanded ? null : views.length === 0 ? (
        <p className="h-8 px-(--sidebar-row-content-inset) text-sm leading-8 text-sidebar-muted-foreground/70">
          No folders
        </p>
      ) : (
        <TooltipProvider delay={150} closeDelay={0} timeout={400}>
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
                    className="flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-(--sidebar-row-content-inset) text-left text-sidebar-foreground/85 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
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
                    <ul className="flex flex-col gap-px ps-3">
                      {threads.map((thread) => (
                        <MergeThreadRow key={thread.id} thread={thread} {...rowProps(thread)} />
                      ))}
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
