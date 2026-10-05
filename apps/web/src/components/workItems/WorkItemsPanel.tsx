import type { BranchWorkItems, EnvironmentId, WorkItem, WorkItemState } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  LinkIcon,
  ListTodoIcon,
  PlusIcon,
  UnlinkIcon,
  UserRoundIcon,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MetaRow, Section } from "../pullRequest/PullRequestSummaryTab";
import { WorkItemCopyButtons, WorkItemDetailsSection } from "./WorkItemDetails";
import {
  copyText,
  failureMessage,
  stateCategory,
  StateGlyph,
  useBranchWorkItems,
} from "./workItemPresentation";

interface PanelTarget {
  environmentId: EnvironmentId;
  cwd: string;
}

/** The work item the thread's branch is tied to, with its subtasks. */
export function WorkItemsPanel({ environmentId, cwd }: PanelTarget) {
  const query = useBranchWorkItems(environmentId, cwd);
  const data = query.data;

  if (data === null) {
    if (query.error !== null) {
      return (
        <PanelMessage title="Could not load work items" description={query.error}>
          <RetryButton refreshing={query.isPending} onRetry={query.refresh} />
        </PanelMessage>
      );
    }
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="md" tone="muted" />
      </div>
    );
  }
  if (!data.supported) {
    return (
      <PanelMessage
        title="No work items here"
        description="Work items are read from Azure Boards, so they appear for Azure DevOps repositories."
      />
    );
  }
  if (data.branch === null) {
    return (
      <PanelMessage
        title="No branch checked out"
        description="Check out a branch to see the work item it belongs to."
      />
    );
  }
  if (data.root === null) {
    return (
      <PanelMessage
        title={
          data.workItemId === null
            ? "No work item for this branch"
            : `#${data.workItemId} not found`
        }
        description={
          data.workItemId === null
            ? "Link one by id. Branches named like feature/#123456-name link themselves."
            : "It may have been removed, or it lives in an organization this Azure CLI login cannot read."
        }
      >
        <LinkWorkItemForm environmentId={environmentId} cwd={cwd} />
        {data.source === "linked" ? <UnlinkButton environmentId={environmentId} cwd={cwd} /> : null}
      </PanelMessage>
    );
  }

  return (
    <WorkItemFamily
      environmentId={environmentId}
      cwd={cwd}
      data={{ ...data, root: data.root }}
      refreshing={query.isPending}
      onRefresh={query.refresh}
    />
  );
}

function WorkItemFamily({
  environmentId,
  cwd,
  data,
  refreshing,
  onRefresh,
}: PanelTarget & {
  data: BranchWorkItems & { root: WorkItem };
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { root, children, states } = data;
  const [relinking, setRelinking] = useState(false);
  const done = children.filter((child) => {
    const category = stateCategory(child, states);
    return category === "completed" || category === "resolved";
  }).length;

  return (
    <div className="h-full overflow-y-auto" data-pull-request-summary-scroll>
      <header className="border-b border-border/60 px-4 pb-4">
        <div className="flex h-7 min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <span className="min-w-0 truncate font-medium">{root.type ?? "Work item"}</span>
          <WorkItemId id={root.id} />
          <span className="flex-1" />
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost-muted" aria-label="Link options" />}
            >
              <LinkIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => setRelinking(true)}>
                <LinkIcon className="size-3.5" />
                Link another work item
              </MenuItem>
              {data.source === "linked" ? (
                <UnlinkMenuItem environmentId={environmentId} cwd={cwd} />
              ) : null}
            </MenuPopup>
          </Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Refresh"
                  onClick={onRefresh}
                  disabled={refreshing}
                />
              }
            >
              <RefreshIcon size="sm" refreshing={refreshing} />
            </TooltipTrigger>
            <TooltipPopup>Refresh from Azure Boards</TooltipPopup>
          </Tooltip>
        </div>
        <h1 className="mt-1 text-base font-semibold leading-snug text-pretty">{root.title}</h1>
        <div className="mt-2 flex min-h-5 min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="shrink-0">
            {data.source === "linked" ? "Linked by you" : "From the branch name"}
          </span>
          <code className="ml-auto min-w-0 truncate font-mono text-muted-foreground/70">
            {data.branch}
          </code>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {root.url ? (
            <Button
              size="xs"
              variant="outline"
              render={<a href={root.url} target="_blank" rel="noopener noreferrer" />}
            >
              <ExternalLinkIcon className="size-3.5" />
              Open in Azure Boards
            </Button>
          ) : null}
          <WorkItemCopyButtons root={root} details={data.rootDetails} subtasks={children} />
        </div>
        {relinking ? (
          <div className="mt-3">
            <LinkWorkItemForm
              environmentId={environmentId}
              cwd={cwd}
              onDone={() => setRelinking(false)}
            />
          </div>
        ) : null}
      </header>

      <WorkItemDetailsSection details={data.rootDetails}>
        <MetaRow icon={<StateGlyph category={stateCategory(root, states)} />} label="State">
          <span className="-ml-2 flex">
            <StateMenu environmentId={environmentId} cwd={cwd} item={root} states={states} />
          </span>
        </MetaRow>
        <MetaRow icon={<UserRoundIcon className="size-3.5" />} label="Assigned">
          <span className="-ml-2 flex">
            <AssignToMeButton environmentId={environmentId} cwd={cwd} item={root} />
          </span>
        </MetaRow>
      </WorkItemDetailsSection>

      <Section
        title={children.length > 0 ? `Subtasks (${done} of ${children.length} done)` : "Subtasks"}
        actions={
          children.length > 0 ? (
            <Button
              size="xs"
              variant="ghost-muted"
              className="shrink-0"
              onClick={() =>
                copyText(children.map((child) => `#${child.id}`).join(" "), "Subtask ids")
              }
            >
              <CopyIcon aria-hidden className="size-3" />
              Copy ids
            </Button>
          ) : null
        }
      >
        {children.length > 0 ? (
          <ul className="-mx-2 flex flex-col">
            {children.map((child) => (
              <SubtaskRow
                key={child.id}
                environmentId={environmentId}
                cwd={cwd}
                item={child}
                states={states}
              />
            ))}
          </ul>
        ) : (
          <p className="py-2 text-xs text-muted-foreground">
            No subtasks yet. Commits reference #{root.id} until one exists.
          </p>
        )}
        <AddSubtaskForm
          environmentId={environmentId}
          cwd={cwd}
          parentId={root.id}
          types={childTypes(children)}
        />
      </Section>
    </div>
  );
}

/** Types already used under the parent come first; Task is the Azure Boards default. */
function childTypes(children: ReadonlyArray<WorkItem>): ReadonlyArray<string> {
  const types = new Set<string>();
  for (const child of children) if (child.type) types.add(child.type);
  types.add("Task");
  return [...types];
}

function SubtaskRow({
  environmentId,
  cwd,
  item,
  states,
}: PanelTarget & { item: WorkItem; states: BranchWorkItems["states"] }) {
  return (
    <li className="group flex min-h-8 items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent/60">
      <StateGlyph category={stateCategory(item, states)} />
      <WorkItemId id={item.id} />
      {item.url ? (
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 flex-1 truncate text-foreground hover:underline"
        >
          {item.title}
        </a>
      ) : (
        <span className="min-w-0 flex-1 truncate text-foreground">{item.title}</span>
      )}
      {item.assignedTo ? (
        <Tooltip>
          <TooltipTrigger
            render={<span className="hidden shrink-0 text-muted-foreground sm:inline" />}
          >
            {initials(item.assignedTo)}
          </TooltipTrigger>
          <TooltipPopup>Assigned to {item.assignedTo}</TooltipPopup>
        </Tooltip>
      ) : null}
      <StateMenu environmentId={environmentId} cwd={cwd} item={item} states={states} />
    </li>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/** The id copies on click: it is what commit subjects and PR links need. */
function WorkItemId({ id }: { id: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="shrink-0 rounded-sm font-mono text-xs text-muted-foreground tabular-nums outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              void writeTextToClipboard(String(id)).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1000);
              });
            }}
          />
        }
      >
        {copied ? <CheckIcon aria-label="Copied" className="inline size-3" /> : null}#{id}
      </TooltipTrigger>
      <TooltipPopup>Copy id</TooltipPopup>
    </Tooltip>
  );
}

function StateMenu({
  environmentId,
  cwd,
  item,
  states,
}: PanelTarget & { item: WorkItem; states: BranchWorkItems["states"] }) {
  const update = useAtomCommand(sourceControlEnvironment.updateWorkItem, { reportFailure: false });
  const [pending, setPending] = useState<string | null>(null);
  const options: ReadonlyArray<WorkItemState> = item.type ? (states[item.type] ?? []) : [];
  const label = pending ?? item.state ?? "No state";

  if (options.length === 0) {
    return <span className="shrink-0 text-xs text-muted-foreground">{label}</span>;
  }
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={pending !== null}
            aria-label={`State of #${item.id}: ${label}`}
          />
        }
      >
        {pending !== null ? <Spinner size="xs" /> : null}
        {label}
        <ChevronDownIcon className="size-3" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Move #{item.id} to</MenuGroupLabel>
          <MenuRadioGroup
            value={item.state ?? ""}
            onValueChange={(next) => {
              const state = String(next);
              if (state === item.state) return;
              setPending(state);
              void update({ environmentId, input: { cwd, id: item.id, state } }).then((result) => {
                setPending(null);
                if (result._tag === "Failure") {
                  toastManager.add({
                    type: "error",
                    title: `Could not move #${item.id} to ${state}`,
                    description: failureMessage(result.cause, "Azure Boards rejected the change."),
                  });
                }
              });
            }}
          >
            {options.map((state) => (
              <MenuRadioItem key={state.name} value={state.name} closeOnClick>
                <span className="flex items-center gap-2">
                  <StateGlyph category={state.category} />
                  {state.name}
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function AssignToMeButton({ environmentId, cwd, item }: PanelTarget & { item: WorkItem }) {
  const update = useAtomCommand(sourceControlEnvironment.updateWorkItem, { reportFailure: false });
  const [pending, setPending] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={pending}
            onClick={() => {
              setPending(true);
              void update({ environmentId, input: { cwd, id: item.id, assignToMe: true } }).then(
                (result) => {
                  setPending(false);
                  if (result._tag === "Failure") {
                    toastManager.add({
                      type: "error",
                      title: `Could not assign #${item.id}`,
                      description: failureMessage(
                        result.cause,
                        "Azure Boards rejected the change.",
                      ),
                    });
                  }
                },
              );
            }}
          />
        }
      >
        {pending ? <Spinner size="xs" /> : null}
        {item.assignedTo ?? "Unassigned"}
      </TooltipTrigger>
      <TooltipPopup>Assign to me</TooltipPopup>
    </Tooltip>
  );
}

function LinkWorkItemForm({ environmentId, cwd, onDone }: PanelTarget & { onDone?: () => void }) {
  const link = useAtomCommand(sourceControlEnvironment.linkBranchWorkItem, {
    reportFailure: false,
  });
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const id = Number(value.trim().replace(/^#/u, ""));
  const valid = Number.isSafeInteger(id) && id > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || pending) return;
    setPending(true);
    void link({ environmentId, input: { cwd, id } }).then((result) => {
      setPending(false);
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: `Could not link #${id}`,
          description: failureMessage(result.cause, "The branch could not be updated."),
        });
        return;
      }
      setValue("");
      onDone?.();
    });
  };

  return (
    <form onSubmit={submit} className="flex w-full max-w-72 items-center gap-1.5">
      <Input
        size="sm"
        inputMode="numeric"
        placeholder="Work item id, like 582642"
        aria-label="Work item id"
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        autoFocus={onDone !== undefined}
      />
      <Button size="sm" type="submit" disabled={!valid || pending}>
        {pending ? <Spinner size="xs" /> : null}
        Link
      </Button>
    </form>
  );
}

function useUnlink({ environmentId, cwd }: PanelTarget) {
  const link = useAtomCommand(sourceControlEnvironment.linkBranchWorkItem, {
    reportFailure: false,
  });
  return () =>
    void link({ environmentId, input: { cwd, id: null } }).then((result) => {
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Could not unlink the work item",
          description: failureMessage(result.cause, "The branch could not be updated."),
        });
      }
    });
}

function UnlinkButton(target: PanelTarget) {
  const unlink = useUnlink(target);
  return (
    <Button size="sm" variant="ghost-muted" onClick={unlink}>
      <UnlinkIcon className="size-3.5" />
      Remove link
    </Button>
  );
}

function UnlinkMenuItem(target: PanelTarget) {
  const unlink = useUnlink(target);
  return (
    <>
      <MenuSeparator />
      <MenuItem onClick={unlink}>
        <UnlinkIcon className="size-3.5" />
        Remove link, use the branch name
      </MenuItem>
    </>
  );
}

function AddSubtaskForm({
  environmentId,
  cwd,
  parentId,
  types,
}: PanelTarget & { parentId: number; types: ReadonlyArray<string> }) {
  const create = useAtomCommand(sourceControlEnvironment.createChildWorkItem, {
    reportFailure: false,
  });
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [type, setType] = useState(types[0] ?? "Task");
  const [pending, setPending] = useState(false);

  if (!open) {
    return (
      <div className="-mx-2 pt-1">
        <Button size="xs" variant="ghost-muted" onClick={() => setOpen(true)}>
          <PlusIcon className="size-3.5" />
          Add subtask
        </Button>
      </div>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed.length === 0 || pending) return;
    setPending(true);
    void create({ environmentId, input: { cwd, parentId, type, title: trimmed } }).then(
      (result) => {
        setPending(false);
        if (result._tag === "Failure") {
          toastManager.add({
            type: "error",
            title: "Could not add the subtask",
            description: failureMessage(result.cause, "Azure Boards rejected the new work item."),
          });
          return;
        }
        toastManager.add({
          type: "success",
          title: `Added #${result.value.id}`,
          description: trimmed,
        });
        setTitle("");
        setOpen(false);
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex items-center gap-1.5 pt-2">
      <Menu>
        <MenuTrigger render={<Button size="sm" variant="outline" aria-label={`Type: ${type}`} />}>
          {type}
          <ChevronDownIcon className="size-3" />
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuRadioGroup value={type} onValueChange={(next) => setType(String(next))}>
            {types.map((option) => (
              <MenuRadioItem key={option} value={option} closeOnClick>
                {option}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
      <Input
        size="sm"
        placeholder="Subtask title"
        aria-label="Subtask title"
        value={title}
        maxLength={255}
        autoFocus
        onChange={(event) => setTitle(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      />
      <Button size="sm" type="submit" disabled={title.trim().length === 0 || pending}>
        {pending ? <Spinner size="xs" /> : null}
        Add
      </Button>
    </form>
  );
}

function RetryButton({ refreshing, onRetry }: { refreshing: boolean; onRetry: () => void }) {
  return (
    <Button size="sm" variant="outline" onClick={onRetry} disabled={refreshing}>
      <RefreshIcon size="sm" refreshing={refreshing} />
      Retry
    </Button>
  );
}

function PanelMessage({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <Empty className="min-h-0 justify-center-safe overflow-y-auto [&>*]:shrink-0">
      <EmptyMedia variant="icon">
        <ListTodoIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children ? <div className="mt-4 flex flex-col items-center gap-2">{children}</div> : null}
    </Empty>
  );
}
