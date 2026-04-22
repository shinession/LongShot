const captureButton = document.getElementById("captureButton");
const statusElement = document.getElementById("status");
const disableJsToggle = document.getElementById("disableJsToggle");
const formatButtons = document.querySelectorAll(".format-btn");

let isRunning = false;
let selectedFormat = "png";

formatButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (isRunning) return;
    formatButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    selectedFormat = btn.dataset.format;
  });
});

function setStatus(message) {
  statusElement.textContent = message;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "capture-progress") {
    setStatus(message.text);
  }

  if (message?.type === "capture-finished") {
    isRunning = false;
    captureButton.disabled = false;
    setStatus(message.text);
  }
});

captureButton.addEventListener("click", async () => {
  if (isRunning) {
    return;
  }

  isRunning = true;
  captureButton.disabled = true;
  setStatus("Preparing tab...");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) {
      throw new Error("No active tab was found.");
    }

    const result = await chrome.runtime.sendMessage({
      type: "capture-full-page",
      tabId: tab.id,
      format: selectedFormat,
      disableJs: Boolean(disableJsToggle?.checked),
    });

    setStatus(result?.message || "Capture completed.");
  } catch (error) {
    setStatus(error.message || "Capture failed.");
  } finally {
    isRunning = false;
    captureButton.disabled = false;
  }
});