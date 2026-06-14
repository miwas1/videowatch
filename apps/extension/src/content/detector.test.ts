import { describe, expect, it } from "vitest";
import { scanDocument } from "./detector";

describe("scanDocument", () => {
  it("detects HTML5 video and caption tracks", () => {
    document.body.innerHTML = `
      <main>
        <h1>Training</h1>
        <video aria-label="Safety briefing" width="640" height="360" controls>
          <source src="/safety.mp4" type="video/mp4" />
          <track kind="captions" label="English" srclang="en" src="/safety.vtt" default />
        </video>
      </main>
    `;

    const snapshot = scanDocument(document);

    expect(snapshot.media).toHaveLength(1);
    expect(snapshot.media[0]).toMatchObject({
      kind: "video",
      label: "Safety briefing",
      width: 640,
      height: 360,
      hasCaptions: true
    });
    expect(snapshot.captions).toContain("English");
  });

  it("detects a normal video src element", () => {
    document.body.innerHTML = `
      <main>
        <h1>Demo</h1>
        <video src="https://cdn.example.test/demo.mp4" controls></video>
      </main>
    `;

    const snapshot = scanDocument(document);

    expect(snapshot.media).toHaveLength(1);
    expect(snapshot.media[0]).toMatchObject({
      kind: "video",
      currentTime: 0,
      source: "https://cdn.example.test/demo.mp4"
    });
    expect(snapshot.media[0].source).toContain("demo.mp4");
  });

  it("chooses the largest visible playable video before ads, thumbnails, and hidden videos", () => {
    document.body.innerHTML = `
      <main>
        <video aria-label="Autoplay ad" width="120" height="70" autoplay muted src="/ad.mp4"></video>
        <video aria-label="Main lesson" width="1280" height="720" controls src="/main.mp4"></video>
        <video aria-label="Hidden tracker" width="1920" height="1080" hidden src="/tracker.mp4"></video>
      </main>
    `;

    const snapshot = scanDocument(document);

    expect(snapshot.media).toHaveLength(1);
    expect(snapshot.media[0]).toMatchObject({
      label: "Main lesson",
      width: 1280,
      height: 720,
      source: "/main.mp4"
    });
  });

  it("returns readable page evidence when no media exists", () => {
    document.body.innerHTML = `
      <header>DescribeOps</header>
      <main aria-label="Article">
        <h1>Course overview</h1>
        <p>This page explains the learning goals and assessment schedule.</p>
      </main>
    `;

    const snapshot = scanDocument(document);

    expect(snapshot.media).toEqual([]);
    expect(snapshot.headings).toEqual(["Course overview"]);
    expect(snapshot.landmarks).toContain("Article");
    expect(snapshot.visibleText.join(" ")).toContain("learning goals");
  });

  it("flags canvas-heavy inaccessible regions for visual sampling", () => {
    document.body.innerHTML = `
      <main>
        <h1>Simulation</h1>
        <canvas width="800" height="450"></canvas>
      </main>
    `;

    const snapshot = scanDocument(document);

    expect(snapshot.inaccessibleRegions).toEqual([
      expect.objectContaining({
        kind: "canvas",
        reason: "needs visual sampling"
      })
    ]);
  });

  it("detects YouTube watch pages as custom embedded players", () => {
    document.title = "Demo lesson - YouTube";
    document.body.innerHTML = `
      <ytd-watch-flexy>
        <div id="movie_player" style="width: 1280px; height: 720px">
          <video class="html5-main-video"></video>
        </div>
        <h1><yt-formatted-string>Demo lesson</yt-formatted-string></h1>
      </ytd-watch-flexy>
    `;

    const snapshot = scanDocument(document);

    expect(snapshot.media).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "embedded-player",
        label: "Demo lesson"
      })
    ]));
    expect(snapshot.inaccessibleRegions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "youtube-player",
        reason: "YouTube custom player needs browser visual sampling"
      })
    ]));
  });
});
