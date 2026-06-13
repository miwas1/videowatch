import { expect, test, chromium, type BrowserContext, type Worker } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile, mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(__dirname, "../../dist");

async function launchExtension(): Promise<BrowserContext> {
  const userDataDir = await mkdtemp(join(tmpdir(), "describeops-extension-e2e-"));
  return chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });
}

async function extensionWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? context.waitForEvent("serviceworker");
}

async function scanFixtureTab(context: BrowserContext) {
  const worker = await extensionWorker(context);
  return worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) {
      throw new Error("No active fixture tab.");
    }
    return chrome.tabs.sendMessage(tab.id, {
      id: "e2e_scan",
      name: "PAGE_SCAN_REQUESTED",
      createdAt: new Date().toISOString(),
      payload: { tabId: tab.id }
    }, { frameId: 0 });
  });
}

async function serveFixture(fileName: string): Promise<{ url: string; close: () => Promise<void> }> {
  const html = await readFile(resolve(__dirname, "../fixtures", fileName), "utf8");
  const server: Server = createServer((request, response) => {
    if (request.url !== "/") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture server did not expose a TCP port.");
  }

  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolveClose) => {
      server.closeAllConnections();
      server.close(() => resolveClose());
    })
  };
}

test("detects an HTML5 video page through the content script", async () => {
  const context = await launchExtension();
  const fixture = await serveFixture("video-page.html");
  const page = await context.newPage();
  await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
  await page.bringToFront();

  const snapshot = await scanFixtureTab(context);

  expect(snapshot.payload.media).toHaveLength(1);
  expect(snapshot.payload.media[0].label).toBe("Fixture video");
  await fixture.close();
  await context.close();
});

test("returns a readable accessibility scan when no video exists", async () => {
  const context = await launchExtension();
  const fixture = await serveFixture("no-video-page.html");
  const page = await context.newPage();
  await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
  await page.bringToFront();

  const snapshot = await scanFixtureTab(context);

  expect(snapshot.payload.media).toEqual([]);
  expect(snapshot.payload.visibleText.join(" ")).toContain("readable text");
  await fixture.close();
  await context.close();
});

test("popup and side panel documents have no serious or critical axe violations", async () => {
  const context = await launchExtension();
  const background = await extensionWorker(context);
  const extensionId = background.url().split("/")[2];

  for (const path of ["popup.html", "sidepanel.html"]) {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/${path}`);
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? "")
    );
    expect(serious).toEqual([]);
  }

  await context.close();
});
