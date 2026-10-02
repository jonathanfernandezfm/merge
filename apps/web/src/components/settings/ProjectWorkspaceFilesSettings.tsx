import {
  EnvironmentId,
  T3_PROJECT_FILE_NAME,
  type T3ProjectFileWorkspaceCopyRule,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { parseT3ProjectFile, setT3ProjectFileCopyRules } from "@t3tools/shared/t3ProjectFile";
import { PlusIcon, SettingsIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";

import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  setProjectFileQueryData,
  useProjectFileQuery,
} from "../files/projectFilesQueryState";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const NO_RULES: ReadonlyArray<T3ProjectFileWorkspaceCopyRule> = [];

/** `index: null` means "add". */
interface CopyRuleEditorRequest {
  index: number | null;
  initial: T3ProjectFileWorkspaceCopyRule;
}

/**
 * The `workspace.copy` rules in the selected checkout's `t3.json`: files and
 * folders copied from the main checkout into each new task workspace. Edits
 * rewrite that checkout's `t3.json`, so they reach teammates once committed.
 */
export function ProjectWorkspaceFilesSettings() {
  const { scope, target } = useSettingsScope();
  const member =
    (scope.kind === "project" || scope.kind === "checkout") && target?.projectId
      ? scope.members.find((entry) => entry.id === target.projectId)
      : undefined;
  const environmentId = member?.environmentId;
  const cwd = member?.workspaceRoot ?? "";
  const query = useProjectFileQuery(
    environmentId ?? EnvironmentId.make("none"),
    cwd,
    T3_PROJECT_FILE_NAME,
    member !== undefined,
  );
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const [request, setRequest] = useState<CopyRuleEditorRequest | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!member || !environmentId) return null;

  const contents = query.data?.contents ?? null;
  const file = contents === null ? null : parseT3ProjectFile(contents);
  const rules = file?.workspace?.copy ?? NO_RULES;
  // A file that exists but cannot be decoded (or is too large to read whole)
  // is never rewritten, so a typo in t3.json cannot cost the user its contents.
  const unreadable = query.data?.truncated === true || (contents !== null && file === null);
  const disabled = saving || query.isPending || unreadable;

  const save = async (next: ReadonlyArray<T3ProjectFileWorkspaceCopyRule>) => {
    const nextContents = setT3ProjectFileCopyRules(contents, next);
    if (nextContents === null) {
      return "t3.json could not be updated. Check that the rule paths are valid.";
    }
    setSaving(true);
    setProjectFileQueryData(environmentId, cwd, T3_PROJECT_FILE_NAME, nextContents);
    const result = await writeFile({
      environmentId,
      input: { cwd, relativePath: T3_PROJECT_FILE_NAME, contents: nextContents },
    });
    setSaving(false);
    if (result._tag === "Success") {
      confirmProjectFileQueryData(environmentId, cwd, T3_PROJECT_FILE_NAME, nextContents);
      setError(null);
      return null;
    }
    clearProjectFileQueryData(environmentId, cwd, T3_PROJECT_FILE_NAME);
    if (isAtomCommandInterrupted(result)) return null;
    const failure = squashAtomCommandFailure(result);
    return failure instanceof Error ? failure.message : "Failed to save t3.json.";
  };

  const remove = async (index: number) => {
    setError(await save(rules.filter((_, position) => position !== index)));
  };

  return (
    <SettingsSection id="project-workspace-files" title="Workspace files">
      <SettingsRow
        title="Files to copy"
        description={
          <>
            Untracked files, such as local env files, copied from this checkout into each new task
            workspace before its setup actions run. Saved in this checkout's{" "}
            <code className="font-mono">t3.json</code>.
          </>
        }
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => setRequest({ index: null, initial: { from: "" } })}
          >
            <PlusIcon className="size-3.5" />
            Add file
          </Button>
        }
      />
      {rules.length === 0 ? (
        <p className="px-3 py-2 text-base text-muted-foreground sm:px-4 sm:text-sm">
          {unreadable ? "t3.json could not be read." : "No files configured."}
        </p>
      ) : (
        rules.map((rule, index) => (
          <SettingsRow
            key={rule.from}
            className="group py-2"
            title={
              <span className="flex min-w-0 items-center gap-2">
                <code className="min-w-0 truncate font-mono">{rule.from}</code>
                {rule.required ? (
                  <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-2xs font-normal text-muted-foreground">
                    required
                  </span>
                ) : null}
                {rule.overwrite ? (
                  <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-2xs font-normal text-muted-foreground">
                    overwrite
                  </span>
                ) : null}
              </span>
            }
            description={
              rule.to && rule.to !== rule.from ? (
                <span className="block max-w-full truncate">
                  Copied to <code className="font-mono">{rule.to}</code>
                </span>
              ) : undefined
            }
            control={
              <span className="flex shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Edit ${rule.from}`}
                  disabled={disabled}
                  onClick={() => setRequest({ index, initial: rule })}
                >
                  <SettingsIcon className="size-3.5" />
                </Button>
              </span>
            }
          />
        ))
      )}
      {unreadable ? (
        <SettingsRow
          title="t3.json is invalid"
          description="Fix the file in this checkout before editing its workspace files here."
          className="text-warning"
        />
      ) : null}
      {error ? (
        <SettingsRow title="Could not save" description={error} className="text-destructive" />
      ) : null}
      {request ? (
        <CopyRuleEditorDialog
          key={request.index ?? "new"}
          request={request}
          saving={saving}
          onSubmit={async (rule) => {
            const duplicate = rules.some(
              (entry, position) => entry.from === rule.from && position !== request.index,
            );
            if (duplicate) return `${rule.from} is already in the list.`;
            const next =
              request.index === null
                ? [...rules, rule]
                : rules.map((entry, position) => (position === request.index ? rule : entry));
            return save(next);
          }}
          onDelete={() => {
            if (request.index !== null) void remove(request.index);
          }}
          onClose={() => setRequest(null)}
        />
      ) : null}
    </SettingsSection>
  );
}

function CopyRuleEditorDialog({
  request,
  saving,
  onSubmit,
  onDelete,
  onClose,
}: {
  request: CopyRuleEditorRequest;
  saving: boolean;
  /** Resolves to an error message, or null once saved. */
  onSubmit: (rule: T3ProjectFileWorkspaceCopyRule) => Promise<string | null>;
  onDelete: () => void;
  onClose: () => void;
}) {
  const formId = useId();
  const [from, setFrom] = useState(request.initial.from);
  const [to, setTo] = useState(request.initial.to ?? "");
  const [required, setRequired] = useState(request.initial.required ?? false);
  const [overwrite, setOverwrite] = useState(request.initial.overwrite ?? false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedFrom = from.trim();
    const trimmedTo = to.trim();
    if (trimmedFrom.length === 0) {
      setValidationError("Source path is required.");
      return;
    }
    const error = await onSubmit({
      from: trimmedFrom,
      ...(trimmedTo.length > 0 && trimmedTo !== trimmedFrom ? { to: trimmedTo } : {}),
      ...(required ? { required: true } : {}),
      ...(overwrite ? { overwrite: true } : {}),
    });
    if (error) setValidationError(error);
    else onClose();
  };

  const switchRowClassName =
    "flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035]";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{request.index !== null ? "Edit File" : "Add File"}</DialogTitle>
          <DialogDescription>
            Copied from this checkout into each new task workspace. Files and folders both work.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form id={formId} onSubmit={submit}>
            <fieldset className="space-y-4" disabled={saving}>
              <div className="space-y-1.5">
                <Label htmlFor="copy-rule-from">Source</Label>
                <Input
                  id="copy-rule-from"
                  autoFocus
                  placeholder=".env.local"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Path relative to this checkout. Exact paths only, no globs.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="copy-rule-to">Destination (optional)</Label>
                <Input
                  id="copy-rule-to"
                  placeholder={from.trim() || "Same as source"}
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                />
              </div>
              <label className={switchRowClassName}>
                <span>Fail setup when the source is missing</span>
                <Switch checked={required} onCheckedChange={(checked) => setRequired(checked)} />
              </label>
              <label className={switchRowClassName}>
                <span>Replace a destination that already exists</span>
                <Switch checked={overwrite} onCheckedChange={(checked) => setOverwrite(checked)} />
              </label>
              {validationError && <p className="text-sm text-destructive">{validationError}</p>}
            </fieldset>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          {request.index !== null && (
            <Button
              type="button"
              variant="destructive-outline"
              className="mr-auto"
              disabled={saving}
              onClick={() => {
                onClose();
                onDelete();
              }}
            >
              Delete
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button form={formId} type="submit" disabled={saving}>
            {saving ? "Saving…" : request.index !== null ? "Save changes" : "Add file"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
