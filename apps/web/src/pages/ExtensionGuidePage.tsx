import { ArrowLeftIcon, CheckIcon, DownloadIcon, GearIcon, PlayIcon, ReaderIcon, ReloadIcon } from "@radix-ui/react-icons";
import type { AuthUser } from "@/api/types";

type Props = {
  currentUser: AuthUser;
  onBack: () => void;
  onLogout: () => void;
};

const EXTENSION_DOWNLOAD_PATH = "/downloads/describeops-extension.zip";

const installSteps = [
  {
    label: "Download",
    title: "Get the extension zip",
    body: "Download the DescribeOps extension package from this site.",
  },
  {
    label: "Unzip",
    title: "Extract the folder",
    body: "Move the extracted folder somewhere stable, such as Documents or Applications.",
  },
  {
    label: "Chrome",
    title: "Open extensions",
    body: "Go to chrome://extensions, enable Developer mode, then choose Load unpacked.",
  },
  {
    label: "Folder",
    title: "Select the extracted folder",
    body: "Pick the folder that contains manifest.json, sidepanel.html, and content-script.js.",
  },
];

const useSteps = [
  {
    icon: ReloadIcon,
    title: "Scan the active tab",
    body: "Open the video page, start playback, then scan so DescribeOps can find the playable media and captions.",
  },
  {
    icon: PlayIcon,
    title: "Choose capture mode",
    body: "Use Capture for one segment, Auto for recorded videos with a known duration, or Live for streams and webinars.",
  },
  {
    icon: ReaderIcon,
    title: "Review the document",
    body: "Refresh the document as chunks finish, edit blocks when needed, then export the finished reading document.",
  },
];

const troubleshooting = [
  ["No video found", "Start playback first, then scan again. Some pages do not create the video element until playback starts."],
  ["Frames look generic", "The page may block direct video pixels. DescribeOps falls back to a tab screenshot or visible page context."],
  ["Backend offline", "Open connection settings in the extension and confirm the backend URL and API token."],
  ["Live capture is slow", "Use shorter chunks for faster updates, or fewer frames per chunk for lighter uploads."],
];

export function ExtensionGuidePage({ currentUser, onBack, onLogout }: Props) {
  return (
    <main className="guide-page">
      <header className="guide-header">
        <a className="site-header__brand guide-header__brand" href="#/" aria-label="DescribeOps home">
          Describe<span>Ops</span>
        </a>
        <nav className="guide-header__nav" aria-label="Guide navigation">
          <a href="#install">Install</a>
          <a href="#configure">Configure</a>
          <a href="#capture">Capture</a>
          <a href="#troubleshoot">Troubleshoot</a>
        </nav>
        <div className="site-header__account guide-header__account" title={currentUser.email}>
          <span>{currentUser.email}</span>
          <button type="button" onClick={onLogout}>Sign out</button>
        </div>
      </header>

      <section className="guide-hero">
        <button className="btn btn--ghost guide-back" type="button" onClick={onBack}>
          <ArrowLeftIcon aria-hidden="true" />
          Back to workspace
        </button>
        <p className="section-kicker">Extension guide</p>
        <h1>Install, connect,<br /><em>capture.</em></h1>
        <p>
          Use the browser extension when a video plays in Chrome but cannot be downloaded by the backend.
          It is the best path for logged-in pages, live streams, course portals, and embedded players.
        </p>
        <div className="guide-hero__actions">
          <a className="btn btn--primary" href={EXTENSION_DOWNLOAD_PATH} download>
            <DownloadIcon aria-hidden="true" />
            Download extension
          </a>
          <a className="btn btn--secondary" href="#install">Read install steps</a>
        </div>
      </section>

      <section className="guide-section guide-section--install" id="install">
        <div className="guide-section__heading">
          <p className="section-kicker">Install</p>
          <h2>Load it into Chrome.</h2>
        </div>
        <ol className="guide-install-grid">
          {installSteps.map((step, index) => (
            <li key={step.title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <small>{step.label}</small>
              <strong>{step.title}</strong>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="guide-section guide-split" id="configure">
        <div>
          <p className="section-kicker">Configure</p>
          <h2>Point the extension at your backend.</h2>
          <p>
            Open the DescribeOps side panel, use the connection settings, and set the backend URL used by this workspace.
            Add the API token if your deployment requires one.
          </p>
        </div>
        <div className="guide-terminal" aria-label="Connection values">
          <p><span>Backend URL</span><code>https://your-domain.example</code></p>
          <p><span>Local dev</span><code>http://127.0.0.1:8000</code></p>
          <p><span>Token header</span><code>X-DescribeOps-Token</code></p>
        </div>
      </section>

      <section className="guide-section" id="capture">
        <div className="guide-section__heading guide-section__heading--row">
          <div>
            <p className="section-kicker">Use</p>
            <h2>Capture the page you can already watch.</h2>
          </div>
          <p>Keep the video page open while DescribeOps samples frames, captions, visible text, and timing.</p>
        </div>
        <div className="guide-use-grid">
          {useSteps.map((step) => {
            const Icon = step.icon;
            return (
              <article key={step.title}>
                <Icon aria-hidden="true" />
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="guide-section guide-split guide-split--dark">
        <div>
          <p className="section-kicker">Mode picker</p>
          <h2>Recorded video or live stream.</h2>
        </div>
        <dl className="guide-mode-list">
          <div><dt>Capture</dt><dd>Analyze the current segment around the playhead.</dd></div>
          <div><dt>Auto</dt><dd>Walk through a recorded video with a known duration.</dd></div>
          <div><dt>Live</dt><dd>Sample the active stream continuously until you stop it.</dd></div>
          <div><dt>Attach</dt><dd>Play generated spoken cues back over the source video.</dd></div>
        </dl>
      </section>

      <section className="guide-section" id="troubleshoot">
        <div className="guide-section__heading">
          <p className="section-kicker">Troubleshoot</p>
          <h2>Common fixes.</h2>
        </div>
        <div className="guide-troubleshooting">
          {troubleshooting.map(([title, body]) => (
            <article key={title}>
              <CheckIcon aria-hidden="true" />
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="guide-final">
        <GearIcon aria-hidden="true" />
        <h2>Ready for browser capture?</h2>
        <a className="btn btn--dark" href={EXTENSION_DOWNLOAD_PATH} download>
          <DownloadIcon aria-hidden="true" />
          Download extension
        </a>
      </section>
    </main>
  );
}
