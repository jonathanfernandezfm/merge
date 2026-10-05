import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { renderWorkItemHtml } from "./WorkItemHtml";

describe("renderWorkItemHtml", () => {
  it("keeps Azure Boards structure and drops scripts, handlers, styles and images", () => {
    const html = renderToStaticMarkup(
      <>
        {renderWorkItemHtml(
          '<div style="color:red" onclick="steal()"><ol><li>Removed in <b>Admin UI</b></li></ol>' +
            '<script>alert(1)</script><img src="https://x/_apis/wit/attachments/1">' +
            '<a href="javascript:alert(1)">bad</a><a href="https://dev.azure.com">ok</a></div>',
        )}
      </>,
    );
    expect(html).toContain("<ol><li>Removed in <b>Admin UI</b></li></ol>");
    expect(html).toContain('href="https://dev.azure.com"');
    expect(html).not.toMatch(/script|onclick|style=|<img|javascript:/u);
  });
});
