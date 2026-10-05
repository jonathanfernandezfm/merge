import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { buildBaseRefChoices, filterBaseRefChoices } from "~/lib/baseRefChoices";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const AUTOMATIC_BASE_REF = "__automatic_base_ref__";

/**
 * Picks the ref a branch is compared against. `selectedBaseRef` is the explicit choice (null means
 * automatic) and `resolvedBaseRef` is what the server actually compared against, shown on the
 * trigger.
 */
export function BaseRefCombobox(props: {
  environmentId: EnvironmentId;
  cwd: string;
  headRef: string | null;
  selectedBaseRef: string | null;
  resolvedBaseRef: string;
  onSelect: (baseRef: string | null) => void;
}) {
  const { environmentId, cwd, headRef, selectedBaseRef, resolvedBaseRef, onSelect } = props;
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();
  const refsInput = (refKind: "local" | "remote") => ({
    environmentId,
    input: {
      cwd,
      includeMatchingRemoteRefs: true,
      refKind,
      ...(trimmedQuery.length > 0 ? { query: trimmedQuery } : {}),
      limit: 100,
    },
  });
  const localBranchRefs = useEnvironmentQuery(vcsEnvironment.listRefs(refsInput("local")));
  const remoteBranchRefs = useEnvironmentQuery(vcsEnvironment.listRefs(refsInput("remote")));
  const choices = buildBaseRefChoices(
    localBranchRefs.data?.refs.filter((ref) => ref.name !== headRef) ?? [],
    remoteBranchRefs.data?.refs ?? [],
  );
  const matchingChoices = filterBaseRefChoices(choices, query);
  const valueForChoice = (choice: (typeof choices)[number]) =>
    selectedBaseRef && selectedBaseRef === choice.remote?.name
      ? selectedBaseRef
      : (choice.local?.name ?? choice.remote?.name ?? choice.id);
  const items = [AUTOMATIC_BASE_REF, ...choices.map(valueForChoice)];
  const filteredItems = [
    ...(trimmedQuery.length === 0 ? [AUTOMATIC_BASE_REF] : []),
    ...matchingChoices.map(valueForChoice),
  ];

  return (
    <Combobox
      items={items}
      filteredItems={filteredItems}
      value={selectedBaseRef ?? AUTOMATIC_BASE_REF}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
      onValueChange={(value) => {
        if (!value) return;
        onSelect(value === AUTOMATIC_BASE_REF ? null : value);
      }}
    >
      <ComboboxTrigger
        render={<Button variant="ghost-muted" size="xs" />}
        className="min-w-0 max-w-48"
        aria-label={`Change comparison target. Currently ${resolvedBaseRef}`}
      >
        <span className="min-w-0 truncate">{resolvedBaseRef}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
      </ComboboxTrigger>
      <ComboboxPopup
        align="start"
        className="w-72 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden"
      >
        <ComboboxSearchInput
          placeholder="Search refs..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="grid shrink-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 border-b border-border/70 ps-3 pe-6.5 pt-2 pb-1.5 font-medium text-3xs text-muted-foreground uppercase tracking-wide">
          <span aria-hidden="true" />
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center">
            <span>Branch</span>
            <span className="text-right">Remote</span>
          </div>
        </div>
        <ComboboxEmpty>No matching refs.</ComboboxEmpty>
        <ComboboxList className="max-h-64 min-w-0 overflow-x-hidden">
          <ComboboxItem
            className="w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)]"
            value={AUTOMATIC_BASE_REF}
          >
            <span className="block min-w-0 truncate">Automatic</span>
          </ComboboxItem>
          {choices.map((choice) => {
            const item = valueForChoice(choice);
            const hasBoth = choice.local !== null && choice.remote !== null;
            const useRemote = choice.remote?.name === item;
            return (
              <ComboboxItem
                key={choice.id}
                className="w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)]"
                value={item}
              >
                <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center overflow-hidden">
                  <span className="block min-w-0 truncate pe-2">{choice.label}</span>
                  {hasBoth ? (
                    <div
                      className="flex justify-end"
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <Switch
                        aria-label={`Use remote version of ${choice.label}`}
                        checked={useRemote}
                        className="[--thumb-size:--spacing(3)]"
                        onCheckedChange={(checked) => {
                          const nextRef = checked ? choice.remote?.name : choice.local?.name;
                          if (nextRef) onSelect(nextRef);
                        }}
                      />
                    </div>
                  ) : choice.remote ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="flex justify-end text-muted-foreground">
                            <CheckIcon role="img" aria-label="Remote only" className="size-3" />
                          </span>
                        }
                      />
                      <TooltipPopup side="top">Remote only</TooltipPopup>
                    </Tooltip>
                  ) : null}
                </div>
              </ComboboxItem>
            );
          })}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
