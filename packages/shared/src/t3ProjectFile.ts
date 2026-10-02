import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  T3ProjectFile,
  T3_PROJECT_FILE_SCHEMA_URL,
  type T3ProjectFileWorkspaceCopyRule,
} from "@t3tools/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `t3.json` file contents (lenient JSONC string) and the
 * decoded {@link T3ProjectFile}.
 */
export const T3ProjectFileFromJson = fromLenientJson(T3ProjectFile);

const decodeT3ProjectFile = Schema.decodeExit(T3ProjectFileFromJson);

/**
 * Decode raw `t3.json` contents, treating invalid or malformed files as
 * absent. Clients use this to read optional defaults (scripts, thread env
 * mode) without surfacing decode errors to the user.
 */
export function parseT3ProjectFile(contents: string): T3ProjectFile | null {
  const decoded = decodeT3ProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

const decodeJsonObject = Schema.decodeExit(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * Rewrite raw `t3.json` contents with a new `workspace.copy` list, keeping
 * every other key. `null` contents create a new file. Returns null when the
 * existing file is not a JSON object or the result would not decode, so a
 * broken file is never overwritten. Comments are not preserved.
 */
export function setT3ProjectFileCopyRules(
  contents: string | null,
  rules: ReadonlyArray<T3ProjectFileWorkspaceCopyRule>,
): string | null {
  let document: Record<string, unknown> = { $schema: T3_PROJECT_FILE_SCHEMA_URL };
  if (contents !== null && contents.trim().length > 0) {
    const decoded = decodeJsonObject(contents);
    if (!Exit.isSuccess(decoded)) return null;
    document = { ...decoded.value };
  }
  const { copy: _previous, ...workspace } =
    typeof document.workspace === "object" && document.workspace !== null
      ? (document.workspace as Record<string, unknown>)
      : {};
  const nextWorkspace = rules.length > 0 ? { ...workspace, copy: rules } : workspace;
  if (Object.keys(nextWorkspace).length > 0) document.workspace = nextWorkspace;
  else delete document.workspace;
  const next = `${JSON.stringify(document, null, 2)}\n`;
  return parseT3ProjectFile(next) === null ? null : next;
}

/**
 * Build the publishable JSON Schema document for `t3.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link T3_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildT3ProjectFileJsonSchema(): Record<string, unknown> {
  // Closed objects, as before effect rc.113 changed the generator default;
  // editors then flag unknown keys in t3.json.
  const document = Schema.toJsonSchemaDocument(T3ProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: T3_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
