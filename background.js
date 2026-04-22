const OFFSCREEN_PATH = "offscreen.html";
const SCROLL_SETTLE_DELAY_MS = 180;
const MIN_CAPTURE_INTERVAL_MS = 600;

let activeCapture = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "capture-full-page") {
    return false;
  }

  if (activeCapture) {
    sendResponse({
      ok: false,
      message: "A capture is already running.",
    });

    return false;
  }

  activeCapture = captureFullPage(message.tabId, message.format || "png")
    .then((result) => {
      sendResponse(result);
    })
    .catch(async (error) => {
      const errorMessage = error?.message || "Capture failed.";
      await notifyPopup({ type: "capture-finished", text: errorMessage });
      sendResponse({ ok: false, message: errorMessage });
    })
    .finally(() => {
      activeCapture = null;
    });

  return true;
});

async function captureFullPage(tabId, format) {
  const tab = await chrome.tabs.get(tabId);

  if (isRestrictedUrl(tab.url)) {
    throw new Error("This page cannot be captured by a Chrome extension.");
  }

  await notifyPopup({ type: "capture-progress", text: "Reading page metrics..." });

  const [{ result: metrics }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: readPageMetrics,
  });

  const scrollStops = buildScrollStops(metrics.totalHeight, metrics.viewportHeight);
  const captures = [];
  let lastScrollY = -1;
  let lastCaptureTimestamp = 0;

  try {
    for (let index = 0; index < scrollStops.length; index += 1) {
      const requestedScrollY = scrollStops[index];
      const progress = `Capturing frame ${index + 1} of ${scrollStops.length}...`;
      await notifyPopup({ type: "capture-progress", text: progress });

      const [{ result: scrollState }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: scrollToPosition,
        args: [requestedScrollY, SCROLL_SETTLE_DELAY_MS],
      });

      if (scrollState.scrollY === lastScrollY) {
        continue;
      }

      lastScrollY = scrollState.scrollY;
      lastCaptureTimestamp = await waitForCaptureQuota(lastCaptureTimestamp);

      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png",
      });

      captures.push({
        dataUrl,
        scrollY: scrollState.scrollY,
      });
    }
  } finally {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: restoreScrollPosition,
      args: [metrics.originalScrollX, metrics.originalScrollY],
    });
  }

  if (!captures.length) {
    throw new Error("No frames were captured.");
  }

  await notifyPopup({ type: "capture-progress", text: "Stitching frames..." });

  const ext = format === "pdf" ? "pdf" : "png";
  const filename = createFileName(tab.title, ext);
  const result = await stitchAndDownload({ captures, metrics, format });

  await notifyPopup({ type: "capture-progress", text: "Downloading image..." });

  await chrome.downloads.download({
    url: result.blobUrl,
    filename,
    saveAs: true,
  });

  const successMessage = `Saved ${filename}`;
  await notifyPopup({ type: "capture-finished", text: successMessage });

  return { ok: true, message: successMessage };
}

async function waitForCaptureQuota(lastCaptureTimestamp) {
  const now = Date.now();
  const elapsed = now - lastCaptureTimestamp;

  if (elapsed < MIN_CAPTURE_INTERVAL_MS) {
    await delay(MIN_CAPTURE_INTERVAL_MS - elapsed);
  }

  return Date.now();
}

function delay(durationMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function stitchAndDownload(payload) {
  await ensureOffscreenDocument();

  const response = await chrome.runtime.sendMessage({
    type: "stitch-and-download",
    payload,
  });

  if (!response?.ok) {
    throw new Error(response?.message || "Unable to stitch captured frames.");
  }

  return response;
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl],
    });

    if (contexts.length > 0) {
      return;
    }
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["BLOBS"],
      justification: "Stitch scrolling screenshots into one image using canvas.",
    });
  } catch (error) {
    if (!String(error?.message || "").includes("Only a single offscreen document")) {
      throw error;
    }
  }
}

function buildScrollStops(totalHeight, viewportHeight) {
  if (totalHeight <= viewportHeight) {
    return [0];
  }

  const stops = new Set();

  for (let current = 0; current < totalHeight; current += viewportHeight) {
    stops.add(Math.max(0, Math.min(current, totalHeight - viewportHeight)));
  }

  return [...stops];
}

function isRestrictedUrl(url) {
  return /^(chrome|chrome-extension|devtools|edge|about|view-source):/i.test(url || "");
}

async function notifyPopup(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // Ignore when the popup is closed.
  }
}

function createFileName(title, ext = "png") {
  const safeTitle = (title || "page")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `longshot-${safeTitle || "page"}-${stamp}.${ext}`;
}

function readPageMetrics() {
  const scrollingElement = document.scrollingElement || document.documentElement;

  return {
    totalHeight: Math.max(
      scrollingElement.scrollHeight,
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0
    ),
    viewportHeight: window.innerHeight,
    originalScrollX: window.scrollX,
    originalScrollY: window.scrollY,
  };
}

async function scrollToPosition(targetScrollY, delayMs) {
  const scrollingElement = document.scrollingElement || document.documentElement;
  const maxScrollY = Math.max(0, scrollingElement.scrollHeight - window.innerHeight);
  const boundedScrollY = Math.max(0, Math.min(targetScrollY, maxScrollY));

  window.scrollTo(0, boundedScrollY);

  await new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        window.setTimeout(resolve, delayMs);
      });
    });
  });

  return {
    scrollY: window.scrollY,
  };
}

function restoreScrollPosition(scrollX, scrollY) {
  window.scrollTo(scrollX, scrollY);
}