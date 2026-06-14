type CaptureSample = {
  timestamp: number;
  luminance: number;
  audioLevel: number;
  width: number;
  height: number;
};

type CaptureSummary = {
  ok: boolean;
  status: "capturing" | "complete" | "error" | "inactive";
  sampleCount: number;
  speechGaps: Array<{ start: number; end: number }>;
  samples: CaptureSample[];
  message: string;
  diagnostics?: string;
};

type CaptureStartMessage = {
  name: "OFFSCREEN_CAPTURE_START_REQUESTED";
  streamId: string;
  durationMs?: number;
  sampleEveryMs?: number;
};

let activeStream: MediaStream | null = null;
let activeVideo: HTMLVideoElement | null = null;
let audioContext: AudioContext | null = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.name === "OFFSCREEN_CAPTURE_START_REQUESTED") {
    startCapture(message).then(sendResponse).catch((error) => {
      sendResponse({
        ok: false,
        status: "error",
        sampleCount: 0,
        speechGaps: [],
        samples: [],
        message: "DescribeOps could not sample the captured tab.",
        diagnostics: String(error)
      } satisfies CaptureSummary);
    });
    return true;
  }

  if (message?.name === "OFFSCREEN_CAPTURE_STOP_REQUESTED") {
    stopCapture();
    sendResponse({
      ok: true,
      status: "inactive",
      sampleCount: 0,
      speechGaps: [],
      samples: [],
      message: "Tab capture stopped."
    } satisfies CaptureSummary);
    return true;
  }

  return false;
});

async function startCapture(message: CaptureStartMessage): Promise<CaptureSummary> {
  stopCapture();

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: message.streamId
      }
    } as MediaTrackConstraints,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: message.streamId
      }
    } as MediaTrackConstraints
  });

  activeStream = stream;
  activeVideo = document.createElement("video");
  activeVideo.muted = true;
  activeVideo.playsInline = true;
  activeVideo.srcObject = stream;
  document.body.append(activeVideo);
  await activeVideo.play();

  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  source.connect(audioContext.destination);

  const samples = await collectSamples(
    activeVideo,
    analyser,
    message.durationMs ?? 2500,
    message.sampleEveryMs ?? 500
  );
  const speechGaps = findQuietGaps(samples);

  return {
    ok: true,
    status: "complete",
    sampleCount: samples.length,
    speechGaps,
    samples,
    message: `Captured ${samples.length} frame/audio sample(s) from the active tab.`
  };
}

async function collectSamples(
  video: HTMLVideoElement,
  analyser: AnalyserNode,
  durationMs: number,
  sampleEveryMs: number
): Promise<CaptureSample[]> {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas sampling is unavailable.");
  }

  const samples: CaptureSample[] = [];
  const started = performance.now();
  while (performance.now() - started < durationMs) {
    const width = Math.max(1, video.videoWidth || 320);
    const height = Math.max(1, video.videoHeight || 180);
    canvas.width = Math.min(width, 160);
    canvas.height = Math.min(height, 90);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);

    samples.push({
      timestamp: Math.round((performance.now() - started) / 100) / 10,
      luminance: averageLuminance(imageData.data),
      audioLevel: audioLevel(analyser),
      width,
      height
    });

    await wait(sampleEveryMs);
  }

  return samples;
}

function averageLuminance(data: Uint8ClampedArray): number {
  let total = 0;
  const pixels = Math.max(1, data.length / 4);
  for (let index = 0; index < data.length; index += 4) {
    total += (0.2126 * data[index]) + (0.7152 * data[index + 1]) + (0.0722 * data[index + 2]);
  }
  return Math.round((total / pixels) * 100) / 100;
}

function audioLevel(analyser: AnalyserNode): number {
  const values = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(values);
  let sum = 0;
  for (const value of values) {
    const centered = value - 128;
    sum += centered * centered;
  }
  return Math.round((Math.sqrt(sum / values.length) / 128) * 1000) / 1000;
}

function findQuietGaps(samples: CaptureSample[]): Array<{ start: number; end: number }> {
  const gaps: Array<{ start: number; end: number }> = [];
  let current: { start: number; end: number } | null = null;

  for (const sample of samples) {
    if (sample.audioLevel < 0.035) {
      current ??= { start: sample.timestamp, end: sample.timestamp };
      current.end = sample.timestamp + 0.5;
    } else if (current) {
      gaps.push(current);
      current = null;
    }
  }

  if (current) {
    gaps.push(current);
  }

  return gaps;
}

function stopCapture() {
  activeStream?.getTracks().forEach((track) => track.stop());
  activeStream = null;
  activeVideo?.remove();
  activeVideo = null;
  audioContext?.close().catch(() => undefined);
  audioContext = null;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
