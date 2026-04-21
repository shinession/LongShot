const captureButton = document.getElementById("captureButton");
const statusElement = document.getElementById("status");

let isRunning = false;

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
    });

    setStatus(result?.message || "Capture completed.");
  } catch (error) {
    setStatus(error.message || "Capture failed.");
  } finally {
    isRunning = false;
    captureButton.disabled = false;
  }
});