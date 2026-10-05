import type { ReviewCommit, ScopedThreadRef } from "@t3tools/contracts";
import { ArrowRightIcon, CheckIcon, CopyIcon, GitGraphIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { type DraftId } from "~/composerDraftStore";
import { selectThreadBranchBaseRef, useDiffPanelStore } from "~/diffPanelStore";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { formatChatTimestampTooltip, formatRelativeTimeLabel } from "~/timestampFormat";
import { useClientSettings } from "~/hooks/useSettings";
import { DiffPanelShell } from "../DiffPanelShell";
import { BaseRefCombobox } from "../diffs/BaseRefCombobox";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GitGraphCommitDiff } from "./GitGraphCommitDiff";
import {
  GIT_GRAPH_ROW_HEIGHT,
  GitGraphBaseLanes,
  GitGraphCommitLanes,
  gitGraphWidth,
} from "./GitGraphLanes";
import { layoutGitGraph } from "./gitGraphLayout";

const shortSha = (sha: string) => sha.slice(0, 7);

/** The branch's own commits as a graph, with the selected commit's files below. */
export function GitGraphPanel(props: {
  threadRef: ScopedThreadRef;
  cwd: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
  workspaceMutationId: string | null;
}) {
  const { threadRef, cwd, composerDraftTarget, workspaceMutationId } = props;
  const environmentId = threadRef.environmentId;
  const selectedBaseRef = useDiffPanelStore((state) => selectThreadBranchBaseRef(state, threadRef));
  const commitsQuery = useEnvironmentQuery(
    reviewEnvironment.commits({
      environmentId,
      input: { cwd, ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}) },
    }),
  );
  const data = commitsQuery.data;
  const commits = data?.commits;
  const graph = useMemo(() => layoutGitGraph(commits ?? []), [commits]);
  const graphWidth = gitGraphWidth(graph.laneCount);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  // Until the reader picks one (or when theirs is gone after a rebase), show the newest commit.
  const selectedCommit =
    commits?.find((commit) => commit.sha === selectedSha) ?? commits?.[0] ?? null;
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = commitsQuery.refresh;
  useWorkspaceMutationRefresh({
    mutationId: workspaceMutationId,
    refresh,
    resourceKey: `git-graph:${threadRef.environmentId}:${threadRef.threadId}`,
  });
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const selectBaseRef = useCallback(
    (baseRef: string | null) => useDiffPanelStore.getState().setBranchBaseRef(threadRef, baseRef),
    [threadRef],
  );

  const moveSelection = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!commits?.length) return;
    const step =
      event.key === "ArrowDown" || event.key === "j"
        ? 1
        : event.key === "ArrowUp" || event.key === "k"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = selectedCommit ? commits.indexOf(selectedCommit) : -1;
    const next = commits[Math.min(commits.length - 1, Math.max(0, index + step))];
    if (!next) return;
    setSelectedSha(next.sha);
    listRef.current
      ?.querySelector(`[data-sha="${next.sha}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  const header = (
    <>
      <div
        className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground [-webkit-app-region:no-drag]"
        aria-label={
          data?.baseRef
            ? `Commits on ${data.headRef ?? "HEAD"} since ${data.baseRef}`
            : "Branch commits"
        }
      >
        <span className="min-w-0 max-w-48 truncate font-medium text-foreground">
          {data?.headRef ?? "HEAD"}
        </span>
        {data?.baseRef ? (
          <>
            <ArrowRightIcon className="size-3.5 shrink-0 opacity-70" />
            <BaseRefCombobox
              environmentId={environmentId}
              cwd={data.cwd}
              headRef={data.headRef}
              selectedBaseRef={selectedBaseRef}
              resolvedBaseRef={data.baseRef}
              onSelect={selectBaseRef}
            />
          </>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        {commits ? (
          <span className="mr-1 text-2xs tabular-nums text-muted-foreground">
            {commits.length === 1
              ? "1 commit"
              : `${commits.length}${data?.truncated ? "+" : ""} commits`}
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={commitsQuery.isPending ? "Refreshing commits" : "Refresh commits"}
                onClick={refresh}
              />
            }
          >
            <RefreshIcon size="sm" refreshing={commitsQuery.isPending} />
          </TooltipTrigger>
          <TooltipPopup side="top">Refresh commits</TooltipPopup>
        </Tooltip>
      </div>
    </>
  );

  return (
    <DiffPanelShell mode="embedded" header={header}>
      {!data ? (
        commitsQuery.error ? (
          <PanelMessage title="Could not load commits" description={commitsQuery.error} />
        ) : (
          <CommitListSkeleton />
        )
      ) : data.commits.length === 0 ? (
        <PanelMessage
          title="No commits on this branch yet"
          description={
            data.baseRef
              ? `${data.headRef ?? "HEAD"} has no commits that ${data.baseRef} doesn't already have. Pick another branch to compare against, or commit some work.`
              : "Commit some work and it will appear here."
          }
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            ref={listRef}
            role="listbox"
            aria-label="Branch commits"
            aria-activedescendant={selectedCommit ? `commit-${selectedCommit.sha}` : undefined}
            tabIndex={0}
            onKeyDown={moveSelection}
            className="max-h-[42%] min-h-24 shrink-0 overflow-y-auto border-b border-border/60 py-1 outline-none focus-visible:bg-accent/20"
          >
            {data.commits.map((commit, index) => (
              <CommitRow
                key={commit.sha}
                commit={commit}
                row={graph.rows[index]!}
                graphWidth={graphWidth}
                selected={commit.sha === selectedCommit?.sha}
                onSelect={setSelectedSha}
              />
            ))}
            {data.truncated ? (
              <p className="px-3 py-1.5 text-2xs text-muted-foreground">
                Showing the newest {data.commits.length} commits.
              </p>
            ) : data.mergeBase ? (
              <div
                className="flex items-center gap-1.5 pe-3 text-2xs text-muted-foreground"
                style={{ height: GIT_GRAPH_ROW_HEIGHT, paddingInlineStart: 4 }}
              >
                <GitGraphBaseLanes
                  openLanes={graph.openLanes}
                  mergeBase={data.mergeBase}
                  width={graphWidth}
                />
                <span className="min-w-0 truncate">Branched from {data.baseRef ?? "base"}</span>
                <span className="ml-auto font-mono tabular-nums opacity-70">
                  {shortSha(data.mergeBase)}
                </span>
              </div>
            ) : null}
          </div>
          {selectedCommit ? (
            <>
              <CommitSummary commit={selectedCommit} />
              <GitGraphCommitDiff
                key={selectedCommit.sha}
                environmentId={environmentId}
                threadRef={threadRef}
                cwd={data.cwd}
                sha={selectedCommit.sha}
                shortSha={shortSha(selectedCommit.sha)}
                composerDraftTarget={composerDraftTarget}
              />
            </>
          ) : null}
        </div>
      )}
    </DiffPanelShell>
  );
}

function CommitRow(props: {
  commit: ReviewCommit;
  row: ReturnType<typeof layoutGitGraph>["rows"][number];
  graphWidth: number;
  selected: boolean;
  onSelect: (sha: string) => void;
}) {
  const { commit, row, graphWidth, selected, onSelect } = props;
  return (
    <div
      id={`commit-${commit.sha}`}
      data-sha={commit.sha}
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(commit.sha)}
      className={cn(
        "flex cursor-default items-center gap-1.5 pe-3 text-xs",
        selected ? "bg-accent text-foreground" : "text-foreground/90 hover:bg-accent/50",
      )}
      style={{ height: GIT_GRAPH_ROW_HEIGHT, paddingInlineStart: 4 }}
    >
      <GitGraphCommitLanes
        row={row}
        width={graphWidth}
        isMerge={commit.parents.length > 1}
        selected={selected}
      />
      <span className="min-w-0 flex-1 truncate">{commit.subject || "(no message)"}</span>
      {commit.refs
        .filter((ref) => !ref.startsWith("tag: "))
        .slice(0, 1)
        .map((ref) => (
          <span
            key={ref}
            className="max-w-28 shrink truncate rounded-sm bg-primary/10 px-1 text-3xs text-primary"
          >
            {ref}
          </span>
        ))}
      <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
        {formatRelativeTimeLabel(commit.authoredAt).replace(" ago", "")}
      </span>
      <span className="w-[7ch] shrink-0 text-right font-mono text-2xs text-muted-foreground/80">
        {shortSha(commit.sha)}
      </span>
    </div>
  );
}

function CommitSummary({ commit }: { commit: ReviewCommit }) {
  const settings = useClientSettings();
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>();
  return (
    <div className="shrink-0 space-y-1 border-b border-border/60 px-3 py-2.5">
      <p className="text-sm font-medium leading-snug text-foreground">
        {commit.subject || "(no message)"}
      </p>
      {commit.body ? (
        <p className="line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
          {commit.body}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 truncate" />}>
            {commit.authorName}
          </TooltipTrigger>
          <TooltipPopup side="top">{commit.authorEmail}</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<span className="shrink-0 tabular-nums" />}>
            {formatRelativeTimeLabel(commit.authoredAt)}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {formatChatTimestampTooltip(commit.authoredAt, settings.timestampFormat)}
          </TooltipPopup>
        </Tooltip>
        {commit.parents.length > 1 ? (
          <span className="shrink-0">, merge shown against its first parent</span>
        ) : null}
        <Button
          size="xs"
          variant="ghost-muted"
          className="ml-auto"
          aria-label={`Copy commit ${commit.sha}`}
          onClick={() => copyToClipboard(commit.sha, undefined)}
        >
          <span className="font-mono">{shortSha(commit.sha)}</span>
          {isCopied ? (
            <CheckIcon className="size-3 text-success" />
          ) : (
            <CopyIcon className="size-3" />
          )}
        </Button>
      </div>
    </div>
  );
}

function CommitListSkeleton() {
  return (
    <div className="space-y-3 px-3 py-3" role="status" aria-label="Loading commits">
      {["70%", "50%", "80%", "60%"].map((width) => (
        <div key={width} className="flex items-center gap-3">
          <Skeleton shape="pill" className="size-2.5 shrink-0" />
          <Skeleton shape="pill" className="h-2.5" style={{ width }} />
        </div>
      ))}
    </div>
  );
}

function PanelMessage(props: { title: string; description: string }) {
  return (
    <div className="flex flex-1 items-center justify-center px-5">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitGraphIcon />
          </EmptyMedia>
          <EmptyTitle>{props.title}</EmptyTitle>
          <EmptyDescription>{props.description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
