import { AZURE_DEVOPS_EXPIRED_CHECK_DESCRIPTION } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { expiredCheckCount } from "./RequeueExpired";

describe("expiredCheckCount", () => {
  it("counts only the Azure DevOps builds the fork marked expired", () => {
    expect(
      expiredCheckCount([
        {
          name: "CI",
          status: "action-required",
          description: AZURE_DEVOPS_EXPIRED_CHECK_DESCRIPTION,
          url: null,
        },
        { name: "Deploy gate", status: "action-required", description: null, url: null },
        { name: "Lint", status: "pending", description: null, url: null },
      ]),
    ).toBe(1);
  });
});
