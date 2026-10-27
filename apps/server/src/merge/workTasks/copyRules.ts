// @effect-diagnostics nodeBuiltinImport:off - Effect's FileSystem.copy has no filter for special files.
import * as NodeFSP from "node:fs/promises";

import {
  T3_PROJECT_FILE_NAME,
  TrimmedNonEmptyString,
  WorkTaskOperationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** A file or directory copied from the main checkout into a new Work Task worktree. */
export const WorkTaskCopyRule = Schema.Struct({
  from: TrimmedNonEmptyString,
  /** Relative to the worktree. Defaults to `from`. */
  to: Schema.optionalKey(TrimmedNonEmptyString),
  /** A missing source fails setup instead of being skipped. */
  required: Schema.optionalKey(Schema.Boolean),
  /** Replaces an existing destination instead of keeping it. */
  overwrite: Schema.optionalKey(Schema.Boolean),
});
export type WorkTaskCopyRule = typeof WorkTaskCopyRule.Type;

/** Only the fork's `workspace.copy` key; upstream decodes the rest of t3.json and ignores it. */
const CopyRulesFile = Schema.fromJsonString(
  Schema.Struct({
    workspace: Schema.optionalKey(
      Schema.Struct({ copy: Schema.optionalKey(Schema.Array(WorkTaskCopyRule)) }),
    ),
  }),
);

const decodeCopyRulesFile = Schema.decodeEffect(CopyRulesFile);

export type WorkTaskStepOutcome =
  | { readonly status: "done" | "skipped"; readonly log: string | null }
  | { readonly status: "failed"; readonly log: string | null; readonly error: string };

const failure = (error: string): WorkTaskStepOutcome => ({ status: "failed", log: null, error });

/** The copy rules in `<root>/t3.json`; none when the file is absent. */
export const readCopyRules = Effect.fn("WorkTaskCopyRules.read")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(root, T3_PROJECT_FILE_NAME);
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return [];
  const invalid = (cause: unknown) =>
    new WorkTaskOperationError({
      reason: "failed",
      message: `${T3_PROJECT_FILE_NAME} has an invalid workspace.copy entry.`,
      cause,
    });
  const text = yield* fs.readFileString(file).pipe(Effect.mapError(invalid));
  const decoded = yield* decodeCopyRulesFile(text).pipe(Effect.mapError(invalid));
  return decoded.workspace?.copy ?? [];
});

/** Copies one rule. Never fails: every problem is a `failed` outcome for the setup step. */
export const applyCopyRule = Effect.fn("WorkTaskCopyRules.apply")(
  function* (root: string, worktreePath: string, rule: WorkTaskCopyRule) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const inside = (parent: string, target: string) => {
      const relative = path.relative(parent, target);
      return (
        relative !== "" &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      );
    };
    const to = rule.to ?? rule.from;
    const source = path.resolve(root, rule.from);
    const destination = path.resolve(worktreePath, to);
    if (!inside(root, source)) return failure(`Copy source '${rule.from}' is outside the project.`);
    if (!inside(worktreePath, destination)) {
      return failure(`Copy destination '${to}' is outside the worktree.`);
    }
    const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));
    if (!(yield* exists(source))) {
      return rule.required === true
        ? failure(`Required file '${rule.from}' is missing from the project.`)
        : ({ status: "skipped", log: `${rule.from} not found` } as const);
    }
    // Lexical checks miss symlinks: re-check against real paths, resolving the deepest
    // existing ancestor of a destination that does not exist yet.
    const canonical = Effect.fnUntraced(function* (target: string) {
      const missing: Array<string> = [];
      let existing = target;
      while (!(yield* exists(existing)) && path.dirname(existing) !== existing) {
        missing.unshift(path.basename(existing));
        existing = path.dirname(existing);
      }
      return path.join(yield* fs.realPath(existing), ...missing);
    });
    if (!inside(yield* fs.realPath(root), yield* fs.realPath(source))) {
      return failure(`Copy source '${rule.from}' resolves outside the project.`);
    }
    if (!inside(yield* fs.realPath(worktreePath), yield* canonical(destination))) {
      return failure(`Copy destination '${to}' resolves outside the worktree.`);
    }
    const destinationLink = yield* Effect.tryPromise(() => NodeFSP.lstat(destination)).pipe(
      Effect.map((stat) => stat.isSymbolicLink()),
      Effect.orElseSucceed(() => false),
    );
    if (destinationLink) return failure(`Copy destination '${to}' is a symbolic link.`);
    if (yield* exists(destination)) {
      if (rule.overwrite !== true) {
        return { status: "skipped", log: `${to} already exists, kept it` } as const;
      }
      yield* fs.remove(destination, { recursive: true });
    }
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
    // Node's cp rejects sockets, FIFOs and devices (a daemon socket in `.codegraph`, say).
    yield* Effect.tryPromise(() =>
      NodeFSP.cp(source, destination, {
        recursive: true,
        filter: async (entry) => {
          const stat = await NodeFSP.lstat(entry);
          return stat.isFile() || stat.isDirectory() || stat.isSymbolicLink();
        },
      }),
    );
    return { status: "done", log: `Copied ${rule.from} to ${to}` } as const;
  },
  (effect, _root, _worktree, rule) =>
    Effect.catch(effect, (cause) =>
      Effect.succeed(failure(`Could not copy ${rule.from}: ${String(cause)}`)),
    ),
);
