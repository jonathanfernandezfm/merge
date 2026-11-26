import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { memo, useState } from "react";

import { canShareWithGuestAtom } from "~/components/chat/guestShareAvailability";
import { SidebarThreadRow, type SidebarProviderEntry } from "~/components/sidebar/SidebarThreadRow";
import { useSidebar } from "~/components/ui/sidebar";
import { toastManager } from "~/components/ui/toast";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useClientSettings } from "~/hooks/useSettings";
import { useAcknowledgeThreadWoke } from "~/hooks/useThreadActions";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { deriveProviderEntriesByEnvironment } from "~/providerInstances";
import { useProject, useServerConfigs } from "~/state/entities";
import {
  useEnvironmentMachines,
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

/**
 * The per-thread props a list of `MergeThreadRow`s shares, read once per list: the route's
 * thread, environment labels and the Threads list's provider icons.
 */
export function useMergeThreadRowProps() {
  const active = useParams({
    strict: false,
    select: (value) => ({
      environmentId: value.environmentId as EnvironmentId | undefined,
      threadId: "threadId" in value ? (value.threadId as ThreadId | undefined) : undefined,
    }),
  });
  const environmentLabelById = new Map(
    useEnvironments().environments.map((environment) => [
      environment.environmentId,
      environment.label,
    ]),
  );
  const serverConfigs = useServerConfigs();
  const providersByEnvironment = useEnvironmentProviders();
  // Same derivation as the Threads list, so rows show the same provider icons.
  const providerEntriesByEnvironment = deriveProviderEntriesByEnvironment(
    [...serverConfigs].map(
      ([environmentId, config]) =>
        [environmentId, providersByEnvironment.get(environmentId) ?? [], config.settings] as const,
    ),
  );
  return (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) => ({
    active: thread.environmentId === active.environmentId && thread.id === active.threadId,
    environmentLabel: environmentLabelById.get(thread.environmentId) ?? null,
    providerEntryByInstanceId:
      providerEntriesByEnvironment.get(thread.environmentId) ?? EMPTY_PROVIDER_ENTRIES,
  });
}

/**
 * A thread outside the Threads list (in a folder or the Needs you lane) drawn by upstream's own
 * row, so it reads the same. Settling, snoozing and pinning stay in the Threads list: their
 * handlers live in its Sidebar.
 */
export const MergeThreadRow = memo(function MergeThreadRow({
  thread,
  active,
  environmentLabel,
  providerEntryByInstanceId,
}: {
  thread: EnvironmentThreadShell;
  active: boolean;
  environmentLabel: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
}) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const project = useProject(scopeProjectRef(thread.environmentId, thread.projectId));
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const machines = useEnvironmentMachines();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const acknowledgeWoke = useAcknowledgeThreadWoke();
  const now = useNowMinute();
  const canShareWithGuest = useAtomValue(canShareWithGuestAtom(thread.environmentId));
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
  const activate = () => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/$environmentId/$threadId", params: threadRef });
  };
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
  const settled = thread.settledOverride === "settled";
  return (
    <SidebarThreadRow
      thread={thread}
      variant={settled ? "slim" : "card"}
      variantAction={settled ? "unsettle" : "settle"}
      settlementSupported={false}
      snoozeSupported={false}
      pinningSupported={false}
      isPinned={thread.pinnedAt != null}
      dropVerb={null}
      dragOverPinned={false}
      sweepAction={null}
      snoozeWakeLabelText={null}
      wokeAt={threadWokeAt(thread, { now })}
      isActive={active}
      isRouteThread={active}
      openPullRequestsInRightPanel={active}
      jumpLabel={null}
      currentEnvironmentId={primaryEnvironmentId}
      environmentLabel={environmentLabel}
      environmentMachine={machines.get(thread.environmentId) ?? "server"}
      scratchMachineLabel={null}
      project={project ?? null}
      projectDisplayName={project?.title ?? null}
      providerEntryByInstanceId={providerEntryByInstanceId}
      timestampFormat={timestampFormat}
      onThreadClick={activate}
      onThreadActivate={activate}
      onStartRename={(_, title) => setRenaming(title)}
      onRenameTitleChange={setRenaming}
      onCommitRename={(_, title) => commitRename(title)}
      onCancelRename={() => setRenaming(null)}
      isRenaming={renaming !== null}
      renamingTitle={renaming ?? ""}
      onContextMenu={(_, position) => openMenu(position)}
      onSettle={NOOP}
      onActionSweepStart={NOOP}
      onUnsettle={NOOP}
      onSnooze={NOOP}
      onUnsnooze={NOOP}
      onUnpin={NOOP}
      onAcknowledgeWoke={acknowledgeWoke}
    />
  );
});

const NOOP = () => {};
const EMPTY_PROVIDER_ENTRIES: ReadonlyMap<string, SidebarProviderEntry> = new Map();
