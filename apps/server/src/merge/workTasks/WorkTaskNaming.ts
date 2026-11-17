import { WorkTaskOperationError, type WorkTask, type WorkTaskId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../../serverSettings.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { WorkTaskInsights } from "./WorkTaskInsights.ts";
import { WorkTaskStore } from "./WorkTaskStore.ts";

const INSTRUCTIONS =
  "Name this work item for a sidebar in plain words: at most 6 words, sentence case, no ticket numbers, customer codes or prefixes.";

/** "#607374 MXC00463 - Foo" gives "Foo". A title that would end up empty stays as it is. */
export const stripWorkItemPrefixes = (title: string): string => {
  const stripped = title
    .replace(/^\s*#?\d+\s*(?:[A-Z]{2,}\d+\s*)?[-:]?\s*/, "")
    .replace(/^\s*[A-Z]{2,}\d+\s*[-:]\s*/, "")
    .trim();
  return stripped === "" ? title : stripped;
};

const htmlToText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

export class WorkTaskNaming extends Context.Service<
  WorkTaskNaming,
  {
    /** Names the task from its ADO item. Never fails; a user-typed title is never replaced. */
    readonly name: (taskId: WorkTaskId) => Effect.Effect<void>;
    /** With a title: the user's. Without: names it with the text model, replacing any title. */
    readonly rename: (input: {
      readonly taskId: WorkTaskId;
      readonly title?: string;
    }) => Effect.Effect<WorkTask, WorkTaskOperationError>;
  }
>()("t3/merge/workTasks/WorkTaskNaming") {}

export const make = Effect.gen(function* () {
  const store = yield* WorkTaskStore;
  const insights = yield* WorkTaskInsights;
  const settings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration;

  const generate = Effect.fn("WorkTaskNaming.generate")(function* (
    taskId: WorkTaskId,
    force: boolean,
  ) {
    const task = yield* store.get(taskId);
    if (task === null || (!force && task.titleSource === "user")) return;
    const found = yield* insights.workItem(taskId);
    if (found === null) return;
    const fallback = stripWorkItemPrefixes(found.item.title);
    const description = htmlToText(found.details?.descriptionHtml ?? "").slice(0, 1000);
    const resolved = resolveProjectSettings(
      yield* settings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new WorkTaskOperationError({
              reason: "failed",
              message: "Could not read the server settings.",
              cause,
            }),
        ),
      ),
      task.projectId,
    ).settings;
    const title = yield* Effect.gen(function* () {
      if (task.workspace.path === null) return fallback;
      const result = yield* textGeneration.generateThreadTitle({
        cwd: task.workspace.path,
        message: `${found.item.type ?? "Work item"}: ${found.item.title}\n\n${description}`,
        instructions: INSTRUCTIONS,
        modelSelection: resolved.textGenerationModelSelection,
        projectId: task.projectId,
        linkedContext: "",
      });
      return result.title.trim() === "" ? fallback : result.title.trim();
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Work Task naming failed; using the ADO title", {
          taskId,
          error: String(error),
        }).pipe(Effect.as(fallback)),
      ),
    );
    // The write itself skips a title the user typed while the model was running.
    yield* store.update(
      taskId,
      { title, titleSource: "generated" },
      force ? undefined : { unlessUserTitled: true },
    );
  });

  const name = (taskId: WorkTaskId) =>
    generate(taskId, false).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Work Task naming failed", { taskId, cause: String(cause) }),
      ),
    );

  const rename = Effect.fn("WorkTaskNaming.rename")(function* (input: {
    readonly taskId: WorkTaskId;
    readonly title?: string;
  }) {
    if (input.title === undefined) yield* generate(input.taskId, true);
    const task =
      input.title === undefined
        ? yield* store.get(input.taskId)
        : yield* store.update(input.taskId, { title: input.title, titleSource: "user" });
    if (task === null) {
      return yield* new WorkTaskOperationError({
        reason: "not-found",
        message: "Work Task not found.",
      });
    }
    return task;
  });

  return WorkTaskNaming.of({ name, rename });
});

export const layer = Layer.effect(WorkTaskNaming, make);
