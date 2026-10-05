import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import {
  SourceControlRepositoryError,
  type BranchWorkItems,
  type BranchWorkItemsInput,
  type CreateChildWorkItemInput,
  type LinkBranchWorkItemInput,
  type UpdateWorkItemInput,
  type WorkItem,
  type SourceControlCloneRepositoryInput,
  type SourceControlCloneRepositoryResult,
  type SourceControlCloneProtocol,
  type SourceControlProviderKind,
  type SourceControlPublishRepositoryInput,
  type SourceControlPublishRepositoryResult,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryInfo,
  type SourceControlRepositoryLookupInput,
} from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import { expandHomePathWith } from "../pathExpansion.ts";
import {
  parseGitCloneProgressLine,
  type GitCloneProgressLine,
} from "../project/gitCloneProgress.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);

export class SourceControlRepositoryService extends Context.Service<
  SourceControlRepositoryService,
  {
    readonly lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Effect.Effect<SourceControlRepositoryInfo, SourceControlRepositoryError>;
    /**
     * Everything `cloneRepository` checks before running git: the resolved
     * remote, the normalized destination, and that the destination is empty.
     * Lets a caller create the project first and clone afterwards.
     */
    readonly prepareClone: (
      input: SourceControlCloneRepositoryInput,
    ) => Effect.Effect<SourceControlPreparedClone, SourceControlRepositoryError>;
    readonly cloneRepository: (
      input: SourceControlCloneRepositoryInput,
      options?: SourceControlCloneOptions,
    ) => Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
    /** Removes a partial or failed clone so the destination is empty again. */
    readonly discardClone: (
      destinationPath: string,
    ) => Effect.Effect<void, SourceControlRepositoryError>;
    readonly publishRepository: (
      input: SourceControlPublishRepositoryInput,
    ) => Effect.Effect<SourceControlPublishRepositoryResult, SourceControlRepositoryError>;
    /** The checked-out branch's work item and its children. */
    readonly branchWorkItems: (
      input: BranchWorkItemsInput,
    ) => Effect.Effect<BranchWorkItems, SourceControlRepositoryError>;
    /** Ties the checked-out branch to a work item, or clears that link. */
    readonly linkBranchWorkItem: (
      input: LinkBranchWorkItemInput,
    ) => Effect.Effect<void, SourceControlRepositoryError>;
    readonly updateWorkItem: (
      input: UpdateWorkItemInput,
    ) => Effect.Effect<void, SourceControlRepositoryError>;
    readonly createChildWorkItem: (
      input: CreateChildWorkItemInput,
    ) => Effect.Effect<{ readonly id: number }, SourceControlRepositoryError>;
  }
>()("merge-agent/sourceControl/SourceControlRepositoryService") {}

export interface SourceControlPreparedClone {
  readonly destinationPath: string;
  /** Credential-free; safe to show and to store in snapshots. */
  readonly remoteUrl: string;
  /** What git is given; may carry embedded credentials. */
  readonly cloneUrl: string;
  readonly repository: SourceControlRepositoryInfo | null;
}

export interface SourceControlCloneOptions {
  readonly onProgress?: (line: GitCloneProgressLine) => Effect.Effect<void>;
  /** Overrides the default clone budget; `null` disables the deadline. */
  readonly timeoutMs?: number | null;
}

// The synchronous RPC (older clients, mobile) keeps a deadline: nothing else
// tells the user a clone stalled. The tracked path passes null and relies on
// progress and Cancel instead.
const CLONE_TIMEOUT_MS = 120_000;
const CLONE_ENV = {
  // `--progress` forces the transfer counters through the pipe; the delay env
  // makes the checkout counter start immediately. No tty means a credential
  // prompt would hang forever, so tell git to fail instead.
  GIT_PROGRESS_DELAY: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
} satisfies NodeJS.ProcessEnv;

// NUL cannot appear in a path, a project name, or a work item type.
const STATE_KEY_SEPARATOR = "\u0000";

/** Git config key holding a work item linked to a branch by hand. */
const branchWorkItemConfigKey = (branch: string) => `branch.${branch}.work-item`;

/**
 * The work item a branch is tied to: a hand-made link wins over the id in the
 * branch name. Shared with commit and PR generation so both agree.
 */
export const resolveBranchWorkItemId = Effect.fn("resolveBranchWorkItemId")(function* (
  git: GitVcsDriver.GitVcsDriver["Service"],
  cwd: string,
  branch: string,
) {
  const linked = yield* git
    .readConfigValue(cwd, branchWorkItemConfigKey(branch))
    .pipe(Effect.orElseSucceed(() => null));
  const linkedId = linked === null ? Number.NaN : Number(linked.trim());
  if (Number.isSafeInteger(linkedId) && linkedId > 0) {
    return { id: linkedId, source: "linked" as const };
  }
  const named = SourceControlProvider.workItemIdFromBranch(branch);
  return named === null ? null : { id: named, source: "branch-name" as const };
});

function toWorkItem(item: SourceControlProvider.SourceControlWorkItem): WorkItem {
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    state: item.state,
    parentId: item.parentId,
    assignedTo: item.assignedTo ?? null,
    url: item.url ?? null,
  };
}

function mapRepositoryError(operation: string, provider: SourceControlProviderKind) {
  return Effect.mapError((cause: unknown) =>
    isSourceControlRepositoryError(cause)
      ? cause
      : new SourceControlRepositoryError({
          operation,
          provider,
          detail: "The source control operation could not be completed.",
          cause,
        }),
  );
}

function toRepositoryInfo(
  provider: SourceControlProviderKind,
  urls: SourceControlRepositoryCloneUrls,
): SourceControlRepositoryInfo {
  return {
    provider,
    nameWithOwner: urls.nameWithOwner,
    url: urls.url,
    sshUrl: urls.sshUrl,
  };
}

/**
 * The URL clients see. A pasted `https://user:token@host/…` must not travel
 * back over `subscribeProjectClones` to every reader; git still gets the
 * original.
 */
function redactRemoteUrl(remoteUrl: string): string {
  try {
    const url = new URL(remoteUrl);
    // Clone URLs have no legitimate query; when one is present it is a token.
    if (url.username.length === 0 && url.password.length === 0 && url.search.length === 0) {
      return remoteUrl;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch {
    return remoteUrl;
  }
}

// Userinfo may itself contain `@`; everything up to the last one before the
// host boundary goes.
const URL_WITH_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi;

/** Drops `user:token@` from any URL embedded in free text. */
function redactUrlCredentials(text: string): string {
  return text.replace(URL_WITH_USERINFO, "$1");
}

function selectRemoteUrl(
  urls: SourceControlRepositoryCloneUrls,
  protocol: SourceControlCloneProtocol | undefined,
): string {
  switch (protocol ?? "auto") {
    case "https":
      return urls.url;
    case "ssh":
    case "auto":
      return urls.sshUrl;
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  const ensureConcreteProvider = (input: {
    readonly operation: string;
    readonly provider: SourceControlProviderKind;
  }) => {
    if (input.provider !== "unknown") {
      return Effect.succeed(input.provider);
    }

    return Effect.fail(
      new SourceControlRepositoryError({
        operation: input.operation,
        provider: input.provider,
        detail: "Choose a source control provider before continuing.",
      }),
    );
  };

  const lookupRepository = Effect.fn("SourceControlRepositoryService.lookupRepository")(function* (
    input: SourceControlRepositoryLookupInput,
  ) {
    const providerKind = yield* ensureConcreteProvider({
      operation: "lookupRepository",
      provider: input.provider,
    });
    const provider = yield* providers.get(providerKind);
    const urls = yield* provider.getRepositoryCloneUrls({
      cwd: input.cwd ?? config.cwd,
      repository: input.repository.trim(),
    });
    return toRepositoryInfo(providerKind, urls);
  });

  const normalizeDestinationPath = Effect.fn("SourceControlRepositoryService.normalizeDestination")(
    function* (destinationPath: string) {
      const trimmed = destinationPath.trim();
      if (trimmed.length === 0) {
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: "unknown",
          detail: "Choose a destination path before cloning.",
        });
      }

      return path.resolve(expandHomePathWith(trimmed, path));
    },
  );

  const prepareDestination = Effect.fn("SourceControlRepositoryService.prepareDestination")(
    function* (destinationPath: string) {
      const normalizedDestination = yield* normalizeDestinationPath(destinationPath);
      if (yield* fileSystem.exists(normalizedDestination)) {
        const entries = yield* fileSystem
          .readDirectory(normalizedDestination, { recursive: false })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: "unknown",
                  detail: "Destination path already exists and is not a directory.",
                  cause,
                }),
            ),
          );
        if (entries.length > 0) {
          return yield* new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: "unknown",
            detail: "Destination path already exists and is not empty.",
          });
        }
      } else {
        yield* fileSystem.makeDirectory(path.dirname(normalizedDestination), { recursive: true });
      }

      return {
        destinationPath: normalizedDestination,
        parentPath: path.dirname(normalizedDestination),
        directoryName: path.basename(normalizedDestination),
      };
    },
  );

  const prepareClone = Effect.fn("SourceControlRepositoryService.prepareClone")(function* (
    input: SourceControlCloneRepositoryInput,
  ) {
    const preparedDestination = yield* prepareDestination(input.destinationPath);
    let repository: SourceControlRepositoryInfo | null = null;
    let remoteUrl = input.remoteUrl?.trim() ?? null;
    let provider: SourceControlProviderKind = input.provider ?? "unknown";

    if (input.provider && input.repository) {
      repository = yield* lookupRepository({
        provider: input.provider,
        repository: input.repository,
        cwd: preparedDestination.parentPath,
      });
      remoteUrl = selectRemoteUrl(repository, input.protocol);
      provider = input.provider;
    }

    if (!remoteUrl) {
      return yield* new SourceControlRepositoryError({
        operation: "cloneRepository",
        provider,
        detail: "Enter a repository path or clone URL before cloning.",
      });
    }

    return {
      destinationPath: preparedDestination.destinationPath,
      remoteUrl: redactRemoteUrl(remoteUrl),
      cloneUrl: remoteUrl,
      repository,
    } satisfies SourceControlPreparedClone;
  });

  const cloneRepository = Effect.fn("SourceControlRepositoryService.cloneRepository")(function* (
    input: SourceControlCloneRepositoryInput,
    options?: SourceControlCloneOptions,
  ) {
    const prepared = yield* prepareClone(input);
    const onProgress = options?.onProgress;
    // Git interleaves progress redraws with its real messages on stderr. The
    // last non-progress lines are what explain a failure ("Repository not
    // found", "Permission denied"), so keep them for the error detail.
    const stderrTail: Array<string> = [];
    const onStderrLine = (line: string) => {
      const parsed = parseGitCloneProgressLine(line);
      if (parsed) return onProgress ? onProgress(parsed) : Effect.void;
      return Effect.sync(() => {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("Cloning into")) return;
        // Git echoes the remote in some failures; the tail becomes user-facing text.
        stderrTail.push(redactUrlCredentials(trimmed));
        if (stderrTail.length > 4) stderrTail.shift();
      });
    };
    yield* git
      .execute({
        operation: "SourceControlRepositoryService.cloneRepository",
        cwd: path.dirname(prepared.destinationPath),
        args: ["clone", "--progress", prepared.cloneUrl, path.basename(prepared.destinationPath)],
        timeoutMs: options?.timeoutMs === undefined ? CLONE_TIMEOUT_MS : options.timeoutMs,
        // Progress redraws add up on a slow multi-GB clone. The buffered copy
        // is never read (the tail is kept by hand above), so keep it small
        // and let the line callbacks keep flowing past the cap.
        maxOutputBytes: 256 * 1024,
        appendTruncationMarker: true,
        keepLineCallbacksAfterTruncation: true,
        env: CLONE_ENV,
        progress: { onStderrLine },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider: input.provider ?? "unknown",
              detail:
                stderrTail.length > 0
                  ? stderrTail.join(" ")
                  : "The repository could not be cloned.",
              cause,
            }),
        ),
      );

    return {
      cwd: prepared.destinationPath,
      remoteUrl: prepared.remoteUrl,
      repository: prepared.repository,
    };
  });

  const discardClone = Effect.fn("SourceControlRepositoryService.discardClone")(function* (
    destinationPath: string,
  ) {
    const normalized = yield* normalizeDestinationPath(destinationPath);
    // Only what git left behind may go. The destination was empty when the
    // clone started, so anything without a `.git` inside was put there by
    // someone else since; refuse rather than delete their files.
    // A missing destination is already discarded; any other read failure
    // (a file in its place, permissions) is not something to remove through.
    const entries = yield* fileSystem.readDirectory(normalized).pipe(
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed<ReadonlyArray<string>>([]),
      ),
      Effect.mapError(
        (cause) =>
          new SourceControlRepositoryError({
            operation: "discardClone",
            provider: "unknown",
            detail: "The clone destination could not be inspected.",
            cause,
          }),
      ),
    );
    if (entries.length > 0 && !entries.includes(".git")) {
      return yield* new SourceControlRepositoryError({
        operation: "discardClone",
        provider: "unknown",
        detail: "Destination path contains files that are not from the clone.",
      });
    }
    // The directory itself is the project's workspace root and must stay;
    // only git's partial contents go. An interrupted git may still be closing
    // files, so removal retries briefly.
    yield* fileSystem.remove(normalized, { recursive: true, force: true }).pipe(
      Effect.andThen(fileSystem.makeDirectory(normalized, { recursive: true })),
      Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 5 }),
      Effect.mapError(
        (cause) =>
          new SourceControlRepositoryError({
            operation: "discardClone",
            provider: "unknown",
            detail: "The partial clone could not be removed.",
            cause,
          }),
      ),
    );
  });

  const publishRepository = Effect.fn("SourceControlRepositoryService.publishRepository")(
    function* (input: SourceControlPublishRepositoryInput) {
      const providerKind = yield* ensureConcreteProvider({
        operation: "publishRepository",
        provider: input.provider,
      });
      const provider = yield* providers.get(providerKind);
      const urls = yield* provider.createRepository({
        cwd: input.cwd,
        repository: input.repository.trim(),
        visibility: input.visibility,
      });
      const remoteUrl = selectRemoteUrl(urls, input.protocol);
      const remoteName = yield* git.ensureRemote({
        cwd: input.cwd,
        preferredName: input.remoteName?.trim() || "origin",
        url: remoteUrl,
      });

      // An empty local repo (no commits) would make `git push HEAD:...` fail
      // with an opaque "src refspec HEAD does not match any". Treat this as a
      // partial success: the remote was created and wired up, but there is
      // nothing to push yet.
      const hasCommits = yield* git
        .execute({
          operation: "SourceControlRepositoryService.publishRepository.headCheck",
          cwd: input.cwd,
          args: ["rev-parse", "--verify", "HEAD"],
        })
        .pipe(
          Effect.map(() => true),
          Effect.orElseSucceed(() => false),
        );
      if (!hasCommits) {
        const details = yield* git.statusDetails(input.cwd).pipe(Effect.orElseSucceed(() => null));
        return {
          repository: toRepositoryInfo(providerKind, urls),
          remoteName,
          remoteUrl,
          branch: details?.branch ?? "main",
          status: "remote_added" as const,
        };
      }

      const pushResult = yield* git.pushCurrentBranch(input.cwd, null, { remoteName });

      return {
        repository: toRepositoryInfo(providerKind, urls),
        remoteName,
        remoteUrl,
        branch: pushResult.branch,
        ...(pushResult.upstreamBranch ? { upstreamBranch: pushResult.upstreamBranch } : {}),
        status: "pushed" as const,
      };
    },
  );

  const readCurrentBranch = (cwd: string) =>
    git
      .execute({
        operation: "SourceControlRepositoryService.readCurrentBranch",
        cwd,
        args: ["symbolic-ref", "--short", "-q", "HEAD"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          const branch = result.stdout.trim();
          return result.exitCode === 0 && branch.length > 0 ? branch : null;
        }),
      );

  const requireCurrentBranch = (cwd: string, operation: string) =>
    readCurrentBranch(cwd).pipe(
      Effect.filterOrFail(
        (branch): branch is string => branch !== null,
        () =>
          new SourceControlRepositoryError({
            operation,
            provider: "unknown",
            detail: "Check out a branch to link a work item.",
          }),
      ),
    );

  const workItemsUnsupported = (operation: string, provider: SourceControlProviderKind) =>
    new SourceControlRepositoryError({
      operation,
      provider,
      detail: "This repository's source control provider has no work items.",
    });

  // A type's states change only when an admin edits the process, and every
  // lookup boots `az`, so they are kept for an hour.
  const workItemStates = yield* Cache.makeWith(
    (key: string) => {
      const [cwd = "", project = "", type = ""] = key.split(STATE_KEY_SEPARATOR);
      return providers
        .resolve({ cwd })
        .pipe(
          Effect.flatMap((provider) =>
            provider.listWorkItemStates
              ? provider.listWorkItemStates({ cwd, project, type })
              : Effect.succeed([]),
          ),
        );
    },
    {
      capacity: 64,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.hours(1) : Duration.zero),
    },
  );

  const branchWorkItems = Effect.fn("SourceControlRepositoryService.branchWorkItems")(function* (
    input: BranchWorkItemsInput,
  ) {
    const branch = yield* readCurrentBranch(input.cwd);
    const provider = yield* providers.resolve({ cwd: input.cwd });
    const empty = {
      branch,
      supported: provider.listWorkItemFamily !== undefined,
      source: null,
      workItemId: null,
      root: null,
      children: [],
      states: {},
    } satisfies BranchWorkItems;
    if (branch === null || !provider.listWorkItemFamily) return empty;
    const resolved = yield* resolveBranchWorkItemId(git, input.cwd, branch);
    if (resolved === null) return empty;
    const items = yield* provider.listWorkItemFamily({ cwd: input.cwd, id: resolved.id });
    const root = items.find((item) => item.id === resolved.id) ?? null;
    const typeKeys = new Map<string, string>();
    for (const item of items) {
      if (item.type && item.project) {
        typeKeys.set(item.type, [input.cwd, item.project, item.type].join(STATE_KEY_SEPARATOR));
      }
    }
    // States only feed the edit menu; a failed lookup must not hide the items.
    const stateEntries = yield* Effect.forEach(
      [...typeKeys],
      ([type, key]) =>
        Cache.get(workItemStates, key).pipe(
          Effect.map((states) => [type, states] as const),
          Effect.orElseSucceed(() => [type, []] as const),
        ),
      { concurrency: "unbounded" },
    );
    return {
      ...empty,
      source: resolved.source,
      workItemId: resolved.id,
      root: root === null ? null : toWorkItem(root),
      rootDetails: root?.details ?? null,
      children: items.filter((item) => item.id !== resolved.id).map(toWorkItem),
      states: Object.fromEntries(stateEntries),
    } satisfies BranchWorkItems;
  });

  const linkBranchWorkItem = Effect.fn("SourceControlRepositoryService.linkBranchWorkItem")(
    function* (input: LinkBranchWorkItemInput) {
      const branch = yield* requireCurrentBranch(input.cwd, "linkBranchWorkItem");
      const key = branchWorkItemConfigKey(branch);
      yield* git.execute({
        operation: "SourceControlRepositoryService.linkBranchWorkItem",
        cwd: input.cwd,
        // `--unset` exits 5 when nothing was linked, which is already the goal.
        args: input.id === null ? ["config", "--unset", key] : ["config", key, String(input.id)],
        allowNonZeroExit: input.id === null,
      });
    },
  );

  const updateWorkItem = Effect.fn("SourceControlRepositoryService.updateWorkItem")(function* (
    input: UpdateWorkItemInput,
  ) {
    const provider = yield* providers.resolve({ cwd: input.cwd });
    if (!provider.updateWorkItem) {
      return yield* workItemsUnsupported("updateWorkItem", provider.kind);
    }
    yield* provider.updateWorkItem({
      cwd: input.cwd,
      id: input.id,
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.assignToMe === undefined ? {} : { assignToMe: input.assignToMe }),
    });
  });

  const createChildWorkItem = Effect.fn("SourceControlRepositoryService.createChildWorkItem")(
    function* (input: CreateChildWorkItemInput) {
      const provider = yield* providers.resolve({ cwd: input.cwd });
      if (!provider.createChildWorkItem) {
        return yield* workItemsUnsupported("createChildWorkItem", provider.kind);
      }
      return yield* provider.createChildWorkItem(input);
    },
  );

  // Work item failures carry the provider's own reason (a rejected state
  // transition, a missing type) instead of a generic message.
  const mapWorkItemError = (operation: string) =>
    Effect.mapError((cause: unknown) =>
      isSourceControlRepositoryError(cause)
        ? cause
        : new SourceControlRepositoryError({
            operation,
            provider:
              typeof cause === "object" && cause !== null && "provider" in cause
                ? (cause.provider as SourceControlProviderKind)
                : "unknown",
            detail:
              typeof cause === "object" && cause !== null && "detail" in cause
                ? String(cause.detail)
                : "The work item operation could not be completed.",
            cause,
          }),
    );

  return SourceControlRepositoryService.of({
    lookupRepository: (input) =>
      lookupRepository(input).pipe(mapRepositoryError("lookupRepository", input.provider)),
    prepareClone: (input) =>
      prepareClone(input).pipe(mapRepositoryError("cloneRepository", input.provider ?? "unknown")),
    cloneRepository: (input, options) =>
      cloneRepository(input, options).pipe(
        mapRepositoryError("cloneRepository", input.provider ?? "unknown"),
      ),
    discardClone: (destinationPath) =>
      discardClone(destinationPath).pipe(mapRepositoryError("discardClone", "unknown")),
    publishRepository: (input) =>
      publishRepository(input).pipe(mapRepositoryError("publishRepository", input.provider)),
    branchWorkItems: (input) => branchWorkItems(input).pipe(mapWorkItemError("branchWorkItems")),
    linkBranchWorkItem: (input) =>
      linkBranchWorkItem(input).pipe(mapWorkItemError("linkBranchWorkItem")),
    updateWorkItem: (input) => updateWorkItem(input).pipe(mapWorkItemError("updateWorkItem")),
    createChildWorkItem: (input) =>
      createChildWorkItem(input).pipe(mapWorkItemError("createChildWorkItem")),
  });
});

export const layer = Layer.effect(SourceControlRepositoryService, make);
