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
    await chrome.scripting.executeScript({
      target: { tabId },
      func: preparePageForCapture,
    });

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
      func: restorePageAfterCapture,
    });

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

  const ext = format.startsWith("pdf") ? "pdf" : "png";
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

  const overlap = Math.min(150, Math.floor(viewportHeight * 0.15));
  const step = viewportHeight - overlap;
  const stops = [];

  for (let current = 0; current < totalHeight - viewportHeight; current += step) {
    stops.push(current);
  }

  // Always include the final position that shows the bottom of the page
  stops.push(totalHeight - viewportHeight);

  return stops;
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

function preparePageForCapture() {
  const STYLE_ID = "__longshot_capture_style__";
  const MARK_ATTR = "data-longshot-hidden";
  const root = document.documentElement;

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [${MARK_ATTR}="true"] {
        visibility: hidden !important;
      }
    `;
    document.head.appendChild(style);
  }

  if (!root.hasAttribute("data-longshot-prev-scroll-behavior")) {
    root.setAttribute(
      "data-longshot-prev-scroll-behavior",
      root.style.scrollBehavior || ""
    );
  }
  root.style.scrollBehavior = "auto";

  const viewportHeight = window.innerHeight;
  const elements = document.body ? document.body.querySelectorAll("*") : [];
  for (const element of elements) {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      continue;
    }

    if (style.position !== "fixed" && style.position !== "sticky") {
      continue;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      continue;
    }

    if (rect.height >= viewportHeight * 0.9) {
      continue;
    }

    element.setAttribute(MARK_ATTR, "true");
  }
}

function restorePageAfterCapture() {
  const STYLE_ID = "__longshot_capture_style__";
  const MARK_ATTR = "data-longshot-hidden";
  const root = document.documentElement;

  for (const element of document.querySelectorAll(`[${MARK_ATTR}]`)) {
    element.removeAttribute(MARK_ATTR);
  }

  const prevScrollBehavior = root.getAttribute("data-longshot-prev-scroll-behavior");
  if (prevScrollBehavior === null) {
    root.style.removeProperty("scroll-behavior");
  } else if (prevScrollBehavior) {
    root.style.scrollBehavior = prevScrollBehavior;
    root.removeAttribute("data-longshot-prev-scroll-behavior");
  } else {
    root.style.removeProperty("scroll-behavior");
    root.removeAttribute("data-longshot-prev-scroll-behavior");
  }

  const style = document.getElementById(STYLE_ID);
  if (style) {
    style.remove();
  }
}