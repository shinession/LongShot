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

  activeCapture = captureFullPage(message.tabId, message.format || "png", {
    disableJs: Boolean(message.disableJs),
  })
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

async function captureFullPage(tabId, format, options = {}) {
  const tab = await chrome.tabs.get(tabId);

  if (isRestrictedUrl(tab.url)) {
    throw new Error("This page cannot be captured by a Chrome extension.");
  }

  if (options.disableJs) {
    return captureFullPageWithDebugger(tab, format);
  }

  return captureFullPageWithScripting(tab, format);
}

async function captureFullPageWithScripting(tab, format) {
  const tabId = tab.id;

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

async function captureFullPageWithDebugger(tab, format) {
  const tabId = tab.id;
  const debuggee = { tabId };
  let debuggerAttached = false;

  await notifyPopup({
    type: "capture-progress",
    text: "Reading page metrics...",
  });

  const [{ result: metrics }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: readPageMetrics,
  });

  const scrollStops = buildScrollStops(metrics.totalHeight, metrics.viewportHeight);
  const captures = [];
  let lastScrollY = -1;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: preparePageForCapture,
    });

    await notifyPopup({
      type: "capture-progress",
      text: "Attaching debugger...",
    });

    try {
      await chrome.debugger.attach(debuggee, "1.3");
      debuggerAttached = true;
    } catch {
      throw new Error("Unable to enable JS-disabled capture. Close DevTools for this tab and try again.");
    }

    await chrome.debugger.sendCommand(debuggee, "Page.enable");
    await chrome.debugger.sendCommand(debuggee, "Page.bringToFront");
    await trySendDebuggerCommand(debuggee, "Emulation.setScrollbarsHidden", {
      hidden: true,
    });
    await chrome.debugger.sendCommand(debuggee, "Emulation.setScriptExecutionDisabled", {
      value: true,
    });

    for (let index = 0; index < scrollStops.length; index += 1) {
      const requestedScrollY = scrollStops[index];
      await notifyPopup({
        type: "capture-progress",
        text: `Capturing frame ${index + 1} of ${scrollStops.length}...`,
      });

      const scrollY = await scrollToPositionWithDebugger(debuggee, requestedScrollY);
      if (scrollY === lastScrollY) {
        continue;
      }

      lastScrollY = scrollY;
      const { data } = await chrome.debugger.sendCommand(
        debuggee,
        "Page.captureScreenshot",
        {
          format: "png",
          fromSurface: true,
          optimizeForSpeed: true,
        }
      );

      captures.push({
        dataUrl: `data:image/png;base64,${data}`,
        scrollY,
      });
    }
  } finally {
    if (debuggerAttached) {
      await trySendDebuggerCommand(debuggee, "Emulation.setScriptExecutionDisabled", {
        value: false,
      });
      await trySendDebuggerCommand(debuggee, "Emulation.setScrollbarsHidden", {
        hidden: false,
      });
      await detachDebuggerSafely(debuggee);
    }

    await restorePageState(tabId, metrics.originalScrollX, metrics.originalScrollY);
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

async function scrollToPositionWithDebugger(debuggee, targetScrollY) {
  const before = await getDebuggerPageMetrics(debuggee);
  const viewportWidth = Math.max(1, Math.floor(before.viewportWidth));
  const viewportHeight = Math.max(1, Math.floor(before.viewportHeight));
  const maxScrollY = Math.max(0, before.totalHeight - before.viewportHeight);
  const boundedScrollY = Math.max(0, Math.min(targetScrollY, maxScrollY));
  const deltaY = boundedScrollY - before.scrollY;

  if (Math.abs(deltaY) < 1) {
    return before.scrollY;
  }

  await chrome.debugger.sendCommand(debuggee, "Input.synthesizeScrollGesture", {
    x: Math.floor(viewportWidth / 2),
    y: Math.floor(viewportHeight / 2),
    yDistance: -deltaY,
    preventFling: true,
    speed: Math.max(800, Math.min(3000, Math.ceil(Math.abs(deltaY) * 3))),
    gestureSourceType: "mouse",
  });

  await delay(SCROLL_SETTLE_DELAY_MS);

  const after = await getDebuggerPageMetrics(debuggee);
  return after.scrollY;
}

async function getDebuggerPageMetrics(debuggee) {
  const metrics = await chrome.debugger.sendCommand(debuggee, "Page.getLayoutMetrics");

  return {
    totalHeight: Math.ceil(metrics.cssContentSize?.height || 0),
    viewportWidth: Math.ceil(metrics.cssLayoutViewport?.clientWidth || 0),
    viewportHeight: Math.ceil(metrics.cssLayoutViewport?.clientHeight || 0),
    scrollY: Math.round(
      metrics.cssVisualViewport?.pageY ?? metrics.cssLayoutViewport?.pageY ?? 0
    ),
  };
}

async function trySendDebuggerCommand(debuggee, method, commandParams) {
  try {
    return await chrome.debugger.sendCommand(debuggee, method, commandParams);
  } catch {
    return undefined;
  }
}

async function detachDebuggerSafely(debuggee) {
  try {
    await chrome.debugger.detach(debuggee);
  } catch {
    // Ignore detach failures when the tab closed or the debugger was already released.
  }
}

async function restorePageState(tabId, scrollX, scrollY) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: restorePageAfterCapture,
    });
  } catch {
    // Ignore when the tab navigated or closed while capturing.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: restoreScrollPosition,
      args: [scrollX, scrollY],
    });
  } catch {
    // Ignore when the tab navigated or closed while capturing.
  }
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

      html,
      body,
      * {
        scrollbar-width: none !important;
      }

      html::-webkit-scrollbar,
      body::-webkit-scrollbar,
      *::-webkit-scrollbar {
        width: 0 !important;
        height: 0 !important;
        display: none !important;
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