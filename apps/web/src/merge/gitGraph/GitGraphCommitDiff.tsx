import type { FileDiffContentsLoader } from "@pierre/diffs";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDown, ChevronRight } from "lucide";
import { FolderTreeIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useCallback, useMemo, useRef, useState } from "react";

import { DiffStatLabel } from "~/components/chat/DiffStatLabel";
import { DiffFilePathCopyButton } from "~/components/DiffFilePathCopyButton";
import { MorphIcon } from "~/components/MorphIcon";
import { DiffPanelLoadingState } from "~/components/DiffPanelShell";
import { AnnotatableCodeView } from "~/components/diffs/AnnotatableCodeView";
import { DiffFileTree } from "~/components/diffs/DiffFileTree";
import { diffFileTreeEntries } from "~/components/diffs/diffFileTree.logic";
import { useCodeViewFileReveal } from "~/components/diffs/useCodeViewFileReveal";
import { Button } from "~/components/ui/button";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { type DraftId } from "~/composerDraftStore";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useTheme } from "~/hooks/useTheme";
import { useClientSettings } from "~/hooks/useSettings";
import { createGitDiffFileContentsLoader } from "~/lib/diffFileContents";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { useAtomCommand } from "~/state/use-atom-command";
import { gitGraphEnvironment } from "./state";

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
    "merge.gitGraphFileTreeOpen",
    false,
    Schema.Boolean,
  );
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const getDiffFileContents = useAtomCommand(reviewEnvironment.diffFileContents);

  const query = useEnvironmentQuery(
    gitGraphEnvironment.commitDiff({
      environmentId,
      input: { cwd, sha, ignoreWhitespace: settings.diffIgnoreWhitespace },
    }),
  );
  const result = query.data;
  const renderablePatch = useMemo(
    () =>
      getRenderablePatch(result?.diff, `git-graph:${resolvedTheme}`, {
        compactPartialHunkOffsets: true,
      }),
    [resolvedTheme, result?.diff],
  );
  const renderableFiles = useMemo(
    () =>
      (renderablePatch?.kind === "files" ? renderablePatch.files : []).toSorted((a, b) =>
        resolveFileDiffPath(a).localeCompare(resolveFileDiffPath(b)),
      ),
    [renderablePatch],
  );

  // A root commit's base is the empty tree, which has no merge base to expand context from.
  const loader = useMemo<FileDiffContentsLoader | undefined>(
    () =>
      result?.parentSha
        ? createGitDiffFileContentsLoader(getDiffFileContents, {
            environmentId,
            cwd: result.cwd,
            sourceKind: "branch-range",
            baseRef: result.parentSha,
            headRef: result.sha,
            cacheKey: result.sha,
          })
        : undefined,
    [environmentId, getDiffFileContents, result],
  );
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const loadDiffFiles = useCallback<FileDiffContentsLoader>(async (fileDiff) => {
    if (!loaderRef.current) throw new Error("This commit's files are unavailable.");
    return loaderRef.current(fileDiff);
  }, []);

  const files = useMemo(
    () =>
      renderableFiles.map((fileDiff) => {
        const fileKey = buildFileDiffIdentityKey(fileDiff);
        return {
          fileDiff,
          filePath: resolveFileDiffPath(fileDiff),
          fileKey,
          fileVersion: buildFileDiffContentVersion(fileDiff),
          collapsed: collapsed.has(fileKey),
        };
      }),
    [collapsed, renderableFiles],
  );
  const toggleCollapsed = useCallback((fileKey: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(fileKey)) next.add(fileKey);
      return next;
    });
  }, []);
  const codeViewReveal = useCodeViewFileReveal();
  const unfold = useCallback((fileKey: string) => {
    setCollapsed((current) => {
      if (!current.has(fileKey)) return current;
      const next = new Set(current);
      next.delete(fileKey);
      return next;
    });
  }, []);
  const revealFile = useCallback(
    (filePath: string) => {
      const fileDiff = renderableFiles.find(
        (candidate) => resolveFileDiffPath(candidate) === filePath,
      );
      if (!fileDiff) return;
      const fileKey = buildFileDiffIdentityKey(fileDiff);
      unfold(fileKey);
      codeViewReveal.request(fileKey);
    },
    [codeViewReveal, renderableFiles, unfold],
  );
  const treeEntries = useMemo(() => diffFileTreeEntries(renderableFiles), [renderableFiles]);

  if (!result || result.truncated || !renderableFiles.length) {
    if (query.error) {
      return <p className="px-3 py-3 text-2xs text-error/80">{query.error}</p>;
    }
    if (query.isPending || !result) {
      return <DiffPanelLoadingState label="Loading commit diff..." />;
    }
    return (
      <p className="px-3 py-6 text-center text-xs text-muted-foreground/70">
        {result.truncated
          ? "This commit's diff is too large to display."
          : renderablePatch?.kind === "raw"
            ? renderablePatch.reason
            : "This commit changes no files."}
      </p>
    );
  }

  const fileCount = result.fileCount;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-2xs text-muted-foreground">
        <span className="tabular-nums">{fileCount === 1 ? "1 file" : `${fileCount} files`}</span>
        <DiffStatLabel additions={result.additions} deletions={result.deletions} layout="inline" />
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
            viewerRef={codeViewReveal.attach}
            codeViewKey={`git-graph:${sha}`}
            className="h-full min-h-0 overflow-auto"
            files={files}
            pendingFiles={[]}
            onRevealSearchMatch={unfold}
            sectionId={`commit:${sha}`}
            sectionTitle={`Commit ${shortSha}`}
            composerDraftTarget={composerDraftTarget}
            renderHeaderFilenameSuffix={(fileDiff) => (
              <DiffFilePathCopyButton filePath={resolveFileDiffPath(fileDiff)} />
            )}
            renderHeaderPrefix={(fileDiff, fileKey) => {
              const isCollapsed = collapsed.has(fileKey);
              const filePath = resolveFileDiffPath(fileDiff);
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
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleCollapsed(fileKey);
                        }}
                      />
                    }
                  >
                    <MorphIcon
                      className="size-4 text-muted-foreground/80"
                      icon={isCollapsed ? ChevronRight : ChevronDown}
                    />
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
              onPostRender: codeViewReveal.flush,
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
