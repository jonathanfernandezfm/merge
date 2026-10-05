import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { memo, useMemo } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { unified } from "unified";

// Azure Boards stores rich text as HTML written by its editor. Styles, classes
// and ids are dropped so the text takes the app's look instead of the editor's.
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  clobberPrefix: "work-item-",
  attributes: {
    ...defaultSchema.attributes,
    "*": (defaultSchema.attributes?.["*"] ?? []).filter(
      (attribute) => attribute !== "title" && attribute !== "id",
    ),
  },
  // Images are skipped: Azure attachment URLs need the user's ADO session.
  tagNames: (defaultSchema.tagNames ?? []).filter((tag) => tag !== "img"),
} satisfies Parameters<typeof rehypeSanitize>[0];

const processor = unified().use(rehypeRaw).use(rehypeSanitize, SANITIZE_SCHEMA);

export function renderWorkItemHtml(html: string) {
  const tree = processor.runSync({
    type: "root",
    children: [{ type: "raw", value: html }],
  } as Parameters<typeof processor.runSync>[0]);
  return toJsxRuntime(tree, {
    Fragment,
    jsx,
    jsxs,
    components: {
      a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,
    },
  });
}

/** Sanitized Azure Boards rich text (description, acceptance criteria, repro steps). */
export const WorkItemHtml = memo(function WorkItemHtml({ html }: { html: string }) {
  const content = useMemo(() => renderWorkItemHtml(html), [html]);
  return (
    <div className="space-y-2 text-sm leading-relaxed text-foreground/[calc(80%+var(--appearance-contrast-boost)/5)] text-pretty [overflow-wrap:anywhere] [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_code]:font-mono [&_code]:text-xs [&_li]:my-1 [&_ol]:list-decimal [&_ol]:ps-6 [&_table]:w-full [&_td]:border [&_td]:border-border/60 [&_td]:px-2 [&_td]:py-1 [&_ul]:list-disc [&_ul]:ps-6">
      {content}
    </div>
  );
});
