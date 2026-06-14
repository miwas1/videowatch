import { expect, test, chromium, type BrowserContext, type Worker } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(__dirname, "../../dist");
const systemChromePath = ["/bin/google-chrome", "/bin/google-chrome-stable"].find((path) => existsSync(path));

async function launchExtension(): Promise<BrowserContext> {
  const userDataDir = await mkdtemp(join(tmpdir(), "describeops-extension-e2e-"));
  return chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: systemChromePath,
    args: [
      "--disable-breakpad",
      "--disable-crash-reporter",
      "--disable-crashpad",
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });
}

async function extensionWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? context.waitForEvent("serviceworker");
}

async function scanFixtureTab(context: BrowserContext) {
  return sendFixtureTabMessage(context, {
    id: "e2e_scan",
    name: "PAGE_SCAN_REQUESTED",
    createdAt: new Date().toISOString(),
    payload: {}
  });
}

async function sendFixtureTabMessage(context: BrowserContext, message: unknown) {
  const worker = await extensionWorker(context);
  return worker.evaluate(async (request) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) {
      throw new Error("No active fixture tab.");
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        return await chrome.tabs.sendMessage(tab.id, request, { frameId: 0 });
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError;
  }, message);
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

test("starts direct video accessibility mode and injects the playback overlay", async () => {
  const context = await launchExtension();
  const fixture = await serveFixture("video-page.html");
  const page = await context.newPage();
  await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
  await page.bringToFront();

  await scanFixtureTab(context);
  const result = await sendFixtureTabMessage(context, {
    name: "ACCESSIBILITY_MODE_START_REQUESTED",
    payload: {
      mediaId: "video-0",
      detailLevel: "balanced",
      options: {
        readOnScreenText: true,
        describeActions: true,
        avoidDialogue: true
      },
      cues: [
        {
          id: "cue-e2e-1",
          start: 1,
          end: 4,
          text: "A demonstration video is ready for audio description.",
          evidenceRefs: ["fixture"],
          confidence: 0.9,
          needsReview: false,
          impact: "high",
          qaWarnings: [],
          status: "accepted",
          rememberable: false
        }
      ],
      ducking: { enabled: true, level: 0.35 }
    }
  });

  expect(result).toMatchObject({ ok: true, status: "ready", cueCount: 1 });
  const overlay = page.locator("#describeops-accessibility-layer");
  const overlayText = await overlay.evaluate((element) => element.shadowRoot?.textContent ?? "");
  const focusableLabels = await overlay.evaluate((element) =>
    Array.from(element.shadowRoot?.querySelectorAll("button") ?? []).map((button) =>
      button.getAttribute("aria-label") || button.textContent?.trim()
    )
  );
  expect(overlayText).toContain("Accessibility layer ready");
  expect(overlayText).toContain("Accessible Video Assistant");
  expect(overlayText).toContain("AD On/Off");
  expect(overlayText).toContain("Minimal");
  expect(overlayText).toContain("Balanced");
  expect(overlayText).toContain("Detailed");
  expect(overlayText).toContain("What happened?");
  expect(overlayText).toContain("Read screen text");
  expect(focusableLabels).toContain("Toggle audio descriptions");
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

test("creates the offscreen capture document and handles stop messages", async () => {
  const context = await launchExtension();
  const worker = await extensionWorker(context);
  const extensionId = worker.url().split("/")[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  const response = await page.evaluate(() =>
    chrome.runtime.sendMessage({ name: "TAB_CAPTURE_STOP_REQUESTED" })
  );

  expect(response).toMatchObject({
    ok: true,
    status: "inactive",
    message: "Tab capture stopped."
  });
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
