import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type {
  ChangeRequest,
  ChangeRequestState,
  SourceControlProviderError,
  SourceControlProviderInfo,
  SourceControlProviderKind,
  SourceControlRepositoryCloneUrls,
  SourceControlRepositoryVisibility,
} from "@t3tools/contracts";

export interface SourceControlLinkSubject {
  readonly title: string;
  readonly body: string | null;
}

/** Return undefined synchronously for unsupported URLs, without starting a lookup. */
export type ResolveSourceControlLink = (input: {
  readonly cwd: string;
  readonly url: URL;
}) => Effect.Effect<SourceControlLinkSubject, SourceControlProviderError> | undefined;

export interface SourceControlProviderContext {
  readonly provider: SourceControlProviderInfo;
  readonly remoteName: string;
  readonly remoteUrl: string;
  /** An explicit web authority can disambiguate Forgejo logins sharing an SSH alias. */
  readonly requestedHost?: string;
}

export interface SourceControlRefSelector {
  readonly refName: string;
  readonly owner?: string;
  readonly repository?: string;
}

const MAX_ERROR_TRANSPORT_VALUE_LENGTH = 256;

/**
 * Sanitizes user-provided source-control identifiers before attaching them to
 * contract errors. This is intentionally narrower than request validation: it
 * only strips URL secrets and bounds diagnostic values sent over transport.
 */
export function transportSafeSourceControlErrorValue(value: string): string {
  let printable = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    printable += codePoint !== undefined && (codePoint < 32 || codePoint === 127) ? " " : character;
  }
  const normalized = printable.trim().replace(/\s+/gu, " ");

  let safe = normalized;
  try {
    const url = new URL(normalized);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    safe = url.toString();
  } catch {
    // Plain repository and change-request identifiers are not URLs.
  }

  return safe.slice(0, MAX_ERROR_TRANSPORT_VALUE_LENGTH);
}

export function parseSourceControlOwnerRef(
  headSelector: string,
): SourceControlRefSelector | undefined {
  const match = /^([^:/\s]+):(.+)$/u.exec(headSelector.trim());
  const owner = match?.[1]?.trim();
  const refName = match?.[2]?.trim();
  return owner && refName ? { owner, refName } : undefined;
}

function normalizeSourceBranch(headSelector: string): string {
  return parseSourceControlOwnerRef(headSelector)?.refName ?? headSelector.trim();
}

export function sourceBranch(input: {
  readonly headSelector: string;
  readonly source?: SourceControlRefSelector;
}): string {
  return input.source?.refName ?? normalizeSourceBranch(input.headSelector);
}

export function sourceControlRefFromInput(input: {
  readonly headSelector: string;
  readonly source?: SourceControlRefSelector;
}): SourceControlRefSelector | undefined {
  return input.source ?? parseSourceControlOwnerRef(input.headSelector);
}

/** A tracked work item (Azure Boards) that commits and change requests can reference. */
export interface SourceControlWorkItem {
  readonly id: number;
  readonly title: string;
  readonly type: string | null;
  readonly state: string | null;
  readonly parentId: number | null;
  readonly assignedTo?: string | null;
  /** Azure Boards project the item lives in; needed to read its type's states. */
  readonly project?: string | null;
  readonly url?: string | null;
  readonly details?: SourceControlWorkItemDetails;
}

/** Long-form fields; providers fill them only for the item a family was read for. */
export interface SourceControlWorkItemDetails {
  readonly descriptionHtml: string | null;
  readonly criteriaHtml: string | null;
  readonly criteriaLabel: "Acceptance criteria" | "Repro steps";
  readonly sprint: string | null;
  readonly priority: number | null;
  readonly tags: ReadonlyArray<string>;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly stateChangedAt: string | null;
}

export interface SourceControlWorkItemState {
  readonly name: string;
  readonly category: "proposed" | "in-progress" | "resolved" | "completed" | "removed";
}

/**
 * The work item a branch is named after: the first 4+ digit run that stands
 * alone between separators, as in `feature/#123456-x` or `bugfix/ESP-123456`.
 */
export function workItemIdFromBranch(branch: string): number | null {
  const match = /(?:^|[/#_-])(\d{4,})(?=$|[/_-])/u.exec(branch);
  return match?.[1] === undefined ? null : Number(match[1]);
}

export class SourceControlProvider extends Context.Service<
  SourceControlProvider,
  {
    readonly kind: SourceControlProviderKind;
    /** Optional capability for issue and change-request subjects. */
    readonly resolveLink?: ResolveSourceControlLink;
    readonly listChangeRequests: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
      readonly source?: SourceControlRefSelector;
      readonly headSelector: string;
      readonly state: ChangeRequestState | "all";
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<ChangeRequest>, SourceControlProviderError>;
    readonly getChangeRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
      readonly reference: string;
    }) => Effect.Effect<ChangeRequest, SourceControlProviderError>;
    readonly createChangeRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
      readonly source?: SourceControlRefSelector;
      readonly target?: SourceControlRefSelector;
      readonly baseRefName: string;
      readonly headSelector: string;
      readonly title: string;
      readonly bodyFile: string;
      /** Work items to link; providers without work items ignore them. */
      readonly workItemIds?: ReadonlyArray<number>;
    }) => Effect.Effect<void, SourceControlProviderError>;
    /** Optional capability: a work item and its direct children. */
    readonly listWorkItemFamily?: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
      readonly id: number;
    }) => Effect.Effect<ReadonlyArray<SourceControlWorkItem>, SourceControlProviderError>;
    /** Optional capability: the states a work item type moves through. */
    readonly listWorkItemStates?: (input: {
      readonly cwd: string;
      readonly project: string;
      readonly type: string;
    }) => Effect.Effect<ReadonlyArray<SourceControlWorkItemState>, SourceControlProviderError>;
    /** Optional capability: change a work item's state or assign it to the CLI user. */
    readonly updateWorkItem?: (input: {
      readonly cwd: string;
      readonly id: number;
      readonly state?: string;
      readonly assignToMe?: boolean;
    }) => Effect.Effect<void, SourceControlProviderError>;
    /** Optional capability: a new work item under `parentId`, in the parent's area and iteration. */
    readonly createChildWorkItem?: (input: {
      readonly cwd: string;
      readonly parentId: number;
      readonly type: string;
      readonly title: string;
    }) => Effect.Effect<{ readonly id: number }, SourceControlProviderError>;
    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
      readonly repository: string;
    }) => Effect.Effect<SourceControlRepositoryCloneUrls, SourceControlProviderError>;
    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<SourceControlRepositoryCloneUrls, SourceControlProviderError>;
    readonly getDefaultBranch: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
    }) => Effect.Effect<string | null, SourceControlProviderError>;
    readonly checkoutChangeRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, SourceControlProviderError>;
  }
>()("merge-agent/sourceControl/SourceControlProvider") {}
