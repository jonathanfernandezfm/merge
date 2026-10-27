import DOMPurify from "dompurify";

let purifier: ReturnType<typeof DOMPurify> | null = null;

/**
 * Azure Boards stores rich text as HTML written by its editor. Styles, classes and ids are dropped
 * so the text takes the app's look, and images too: attachment URLs need the user's ADO session.
 */
export function sanitizeWorkItemHtml(html: string): string {
  if (purifier === null) {
    purifier = DOMPurify(window);
    purifier.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    });
  }
  return purifier.sanitize(html, {
    FORBID_TAGS: ["img", "style", "form", "input", "button"],
    FORBID_ATTR: ["style", "class", "id", "title"],
  });
}

/** Sanitized Azure Boards rich text (description, acceptance criteria, repro steps). */
export function WorkItemHtml({ html }: { html: string }) {
  const clean = sanitizeWorkItemHtml(html);
  return (
    <div
      className="space-y-2 text-sm leading-relaxed text-foreground/[calc(80%+var(--appearance-contrast-boost)/5)] text-pretty [overflow-wrap:anywhere] [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_code]:font-mono [&_code]:text-xs [&_li]:my-1 [&_ol]:list-decimal [&_ol]:ps-6 [&_table]:w-full [&_td]:border [&_td]:border-border/60 [&_td]:px-2 [&_td]:py-1 [&_ul]:list-disc [&_ul]:ps-6"
      // Sanitized above with DOMPurify.
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}
