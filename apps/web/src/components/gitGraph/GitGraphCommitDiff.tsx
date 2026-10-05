import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, FolderTreeIcon } from "lucide-react";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { useCallback, useMemo, useRef, useState } from "react";

import { type DraftId } from "~/composerDraftStore";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useTheme } from "~/hooks/useTheme";
import { useClientSettings } from "~/hooks/useSettings";
import { createGitDiffFileContentsLoader } from "~/lib/diffFileContents";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  getDiffCollapseIconClassName,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { useAtomCommand } from "~/state/use-atom-command";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { DiffFilePathCopyButton } from "../DiffFilePathCopyButton";
import { DiffPanelLoadingState } from "../DiffPanelShell";
import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "../diffs/AnnotatableCodeView";
import { DiffFileLoadingBoundary } from "../diffs/DiffFileLoadingBoundary";
import { DiffFileStatus } from "../diffs/DiffFileStatus";
import { DiffFileTree } from "../diffs/DiffFileTree";
import { diffFileTreeEntries } from "../diffs/diffFileTree.logic";
import { useCodeViewFileReveal } from "../diffs/useCodeViewFileReveal";
import { useReviewFilePatches } from "../diffs/useReviewFilePatches";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The files one commit changed against its first parent, in the Diff panel's viewer. */
export function GitGraphCommitDiff(props: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  cwd: string;
  sha: string;
  shortSha: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
}) {
  const { environmentId, cwd, sha, shortSha, composerDraftTarget } = props;
  const [fileTreeOpen, setFileTreeOpen] = useLocalStorage(
    "t3code.gitGraphFileTreeOpen",
    false,
    Schema.Boolean,
  );
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const [codeView, setCodeView] = useState<AnnotatableCodeViewHandle | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const getDiffFileContents = useAtomCommand(reviewEnvironment.diffFileContents);

  const preview = useEnvironmentQuery(
    reviewEnvironment.diffPreview({
      environmentId,
      input: { cwd, headRef: sha, ignoreWhitespace: settings.diffIgnoreWhitespace },
    }),
  );
  const source = preview.data?.sources.find((candidate) => candidate.kind === "branch-range");
  const lazySource = source?.truncated && source.files ? source : null;
  const renderablePatch = useMemo(
    () =>
      lazySource
        ? null
        : getRenderablePatch(source?.diff, `git-graph:${resolvedTheme}`, {
            compactPartialHunkOffsets: true,
          }),
    [lazySource, resolvedTheme, source?.diff],
  );
  const patches = useReviewFilePatches({
    environmentId,
    cwd: preview.data?.cwd,
    source: lazySource,
    baseRef: source?.baseRef ?? null,
    headRef: sha,
    ignoreWhitespace: settings.diffIgnoreWhitespace,
    theme: resolvedTheme,
    revision: preview.data ? DateTime.formatIso(preview.data.generatedAt) : undefined,
    preview: renderablePatch,
  });

  const loader = useMemo<FileDiffContentsLoader | undefined>(
    () =>
      preview.data && source
        ? createGitDiffFileContentsLoader(getDiffFileContents, {
            environmentId,
            cwd: preview.data.cwd,
            sourceKind: source.kind,
            baseRef: source.baseRef,
            headRef: source.headRef,
            cacheKey: source.diffHash,
          })
        : undefined,
    [environmentId, getDiffFileContents, preview.data, source],
  );
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const loadDiffFiles = useCallback<FileDiffContentsLoader>(async (fileDiff) => {
    if (!loaderRef.current) throw new Error("This commit's files are unavailable.");
    return loaderRef.current(fileDiff);
  }, []);

  const fileStats = useMemo(
    () => new Map(lazySource?.files?.map((file) => [file.path, file])),
    [lazySource?.files],
  );
  const files = useMemo(
    () =>
      patches.renderableFiles
        .filter(
          (fileDiff) => !lazySource || patches.readyFilePaths.has(resolveFileDiffPath(fileDiff)),
        )
        .map((fileDiff) => {
          const fileKey = buildFileDiffIdentityKey(fileDiff);
          return {
            fileDiff,
            filePath: resolveFileDiffPath(fileDiff),
            fileKey,
            fileVersion: buildFileDiffContentVersion(fileDiff),
            collapsed: collapsed.has(fileKey) || fileDiff.cacheKey?.endsWith(":pending") === true,
          };
        }),
    [collapsed, lazySource, patches.readyFilePaths, patches.renderableFiles],
  );
  const toggleCollapsed = useCallback((fileKey: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(fileKey)) next.add(fileKey);
      return next;
    });
  }, []);
  const revealScope = useMemo(() => ({ sha }), [sha]);
  const requestReveal = useCodeViewFileReveal(
    codeView,
    revealScope,
    files.map((file) => file.fileKey),
  );
  const revealFile = useCallback(
    (filePath: string) => {
      const index = patches.renderableFiles.findIndex(
        (candidate) => resolveFileDiffPath(candidate) === filePath,
      );
      const fileDiff = patches.renderableFiles[index];
      if (!fileDiff) return;
      const fileKey = buildFileDiffIdentityKey(fileDiff);
      setCollapsed((current) => {
        const next = new Set(current);
        next.delete(fileKey);
        return next;
      });
      if (lazySource && index >= patches.settledFileCount) patches.requestFile(index);
      requestReveal(fileKey);
    },
    [lazySource, patches, requestReveal],
  );
  const renderFooter = useCallback(
    () =>
      patches.settledFileCount < patches.renderableFiles.length ? (
        <DiffFileLoadingBoundary
          load={patches.loadNextFiles}
          count={patches.renderableFiles.length - patches.settledFileCount}
        />
      ) : null,
    [patches.loadNextFiles, patches.renderableFiles.length, patches.settledFileCount],
  );
  const treeEntries = useMemo(
    () => diffFileTreeEntries(patches.renderableFiles),
    [patches.renderableFiles],
  );
  const stat = useMemo(
    () =>
      (source?.files ?? []).reduce(
        (total, file) => ({
          additions: total.additions + file.additions,
          deletions: total.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
      ),
    [source?.files],
  );

  if (!source || !patches.renderableFiles.length) {
    if (preview.error) {
      return <p className="px-3 py-3 text-2xs text-error/80">{preview.error}</p>;
    }
    if (preview.isPending || !preview.data) {
      return <DiffPanelLoadingState label="Loading commit diff..." />;
    }
    return (
      <p className="px-3 py-6 text-center text-xs text-muted-foreground/70">
        {renderablePatch?.kind === "raw" ? renderablePatch.reason : "This commit changes no files."}
      </p>
    );
  }

  const fileCount = source.files?.length ?? patches.renderableFiles.length;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-2xs text-muted-foreground">
        <span className="tabular-nums">{fileCount === 1 ? "1 file" : `${fileCount} files`}</span>
        {source.files ? (
          <DiffStatLabel additions={stat.additions} deletions={stat.deletions} layout="inline" />
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={fileTreeOpen ? "Hide file tree" : "Show file tree"}
                variant="ghost"
                size="sm"
                className="ml-auto"
                pressed={fileTreeOpen}
                onPressedChange={(pressed) => setFileTreeOpen(Boolean(pressed))}
              />
            }
          >
            <FolderTreeIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {fileTreeOpen ? "Hide file tree" : "Show file tree"}
          </TooltipPopup>
        </Tooltip>
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-h-0 min-w-0 flex-1">
          <AnnotatableCodeView
            key={sha}
            viewerRef={setCodeView}
            codeViewKey={`git-graph:${sha}:${lazySource ? patches.scope : "preview"}`}
            className="h-full min-h-0 overflow-auto"
            files={files}
            renderCodeViewFooter={renderFooter}
            sectionId={`commit:${sha}`}
            sectionTitle={`Commit ${shortSha}`}
            composerDraftTarget={composerDraftTarget}
            renderHeaderFilenameSuffix={(fileDiff) => {
              const path = resolveFileDiffPath(fileDiff);
              return (
                <>
                  <DiffFilePathCopyButton filePath={path} />
                  {fileStats.has(path) ? (
                    <DiffFileStatus
                      {...patches.fileStates.get(path)}
                      retry={() => patches.retry(path)}
                    />
                  ) : null}
                </>
              );
            }}
            {...(lazySource
              ? {
                  unsafeCSSExtra:
                    "[data-additions-count], [data-deletions-count] { display: none; }",
                  renderHeaderMetadata: (fileDiff: FileDiffMetadata) => {
                    const stat = fileStats.get(resolveFileDiffPath(fileDiff));
                    return stat ? (
                      <DiffStatLabel additions={stat.additions} deletions={stat.deletions} />
                    ) : null;
                  },
                }
              : {})}
            renderHeaderPrefix={(fileDiff, fileKey) => {
              const unavailable = fileDiff.cacheKey?.endsWith(":pending") === true;
              const isCollapsed = unavailable || collapsed.has(fileKey);
              const filePath = resolveFileDiffPath(fileDiff);
              const Icon = isCollapsed ? ChevronRightIcon : ChevronDownIcon;
              return (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-micro"
                        variant="ghost"
                        className="-ms-0.5"
                        aria-label={isCollapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
                        aria-expanded={!isCollapsed}
                        disabled={unavailable}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleCollapsed(fileKey);
                        }}
                      />
                    }
                  >
                    <Icon className={cn("size-4", getDiffCollapseIconClassName(fileDiff))} />
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    {isCollapsed ? "Expand diff" : "Collapse diff"}
                  </TooltipPopup>
                </Tooltip>
              );
            }}
            options={{
              diffStyle: settings.diffLayout === "split" ? "split" : "unified",
              lineDiffType: "none",
              overflow: settings.wordWrap ? "wrap" : "scroll",
              theme: resolveDiffThemeName(resolvedTheme),
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
              themeType: resolvedTheme,
              stickyHeaders: true,
              ...(loader ? { loadDiffFiles } : {}),
            }}
          />
        </div>
        {fileTreeOpen ? (
          <aside className="flex w-[min(14rem,40%)] min-w-36 shrink-0 border-l border-border/60">
            <DiffFileTree
              ariaLabel={`Files in ${shortSha}`}
              entries={treeEntries}
              onSelectFile={revealFile}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
