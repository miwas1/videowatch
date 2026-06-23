import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client";

describe("DescribeOps API client", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("uses PATCH and returns the persisted block correction", async () => {
    const block = { id: "block-1", body: "Server body", is_user_edited: true };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ block }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient("http://api.test", "secret-token");

    const result = await client.correctBlock("block-1", "Draft body", "Reviewer note");

    expect(result.block.body).toBe("Server body");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/api/v1/reading-blocks/block-1",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({ "X-DescribeOps-Token": "secret-token" }),
        body: JSON.stringify({ body: "Draft body", note: "Reviewer note" }),
      }),
    );
  });

  it("downloads raw Markdown with header authentication and no token query string", async () => {
    fetchMock.mockResolvedValue(new Response("# Reading document", { status: 200 }));
    const client = createApiClient("http://api.test", "secret-token");

    await expect(client.downloadRawMarkdown("session-1")).resolves.toBe("# Reading document");
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://api.test/api/v1/sessions/session-1/export/markdown");
    expect(url).not.toContain("token=");
    expect(options.headers).toEqual({ "X-DescribeOps-Token": "secret-token" });
  });
});
