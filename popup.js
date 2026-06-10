const statusBox = document.getElementById("status");
const statusTitle = document.getElementById("status-title");
const statusDetail = document.getElementById("status-detail");
const threadCount = document.getElementById("thread-count");
const anchorCount = document.getElementById("anchor-count");
const enabledToggle = document.getElementById("enabled-toggle");
const anchorColor = document.getElementById("anchor-color");
const swatches = document.getElementById("swatches");
const resetButton = document.getElementById("reset-button");
const version = document.getElementById("version");

let activeTabId = null;
let ready = false;

version.textContent = "v" + chrome.runtime.getManifest().version;

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id || null;

  enabledToggle.addEventListener("change", async () => applyStatus(await send({ type: "setEnabled", enabled: enabledToggle.checked })));
  anchorColor.addEventListener("input", async () => applyStatus(await send({ type: "setAnchorColor", color: anchorColor.value })));
  swatches.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-color]");
    if (!button) return;
    applyStatus(await send({ type: "setAnchorColor", color: button.dataset.color }));
  });
  resetButton.addEventListener("click", resetChat);

  await refresh();
}

async function refresh() {
  const status = await send({ type: "getStatus" });
  if (!status) {
    setUnavailable();
    return;
  }

  applyStatus(status);
}

function applyStatus(status) {
  if (!status) {
    setUnavailable();
    return;
  }

  ready = true;
  document.body.classList.remove("is-unavailable");
  statusBox.classList.toggle("is-active", status.enabled);
  statusBox.classList.toggle("is-off", !status.enabled);
  statusTitle.textContent = status.enabled ? "ChatGPT active" : "Yacht disabled";
  statusDetail.textContent = status.conversationId === "new" ? "New chat" : "Conversation loaded";
  threadCount.textContent = status.threadCount;
  anchorCount.textContent = status.anchorCount;
  enabledToggle.checked = status.enabled;
  anchorColor.value = status.anchorColor;
  [...swatches.querySelectorAll("[data-color]")].forEach((button) => {
    button.classList.toggle("is-active", button.dataset.color.toLowerCase() === status.anchorColor.toLowerCase());
  });
}

async function resetChat() {
  if (!ready) return;
  if (!confirm("Reset Yacht data for this ChatGPT conversation?")) return;
  await send({ type: "resetConversation" });
  await refresh();
}

async function send(message) {
  if (!activeTabId) return null;
  try {
    return await chrome.tabs.sendMessage(activeTabId, message);
  } catch {
    return null;
  }
}

function setUnavailable() {
  ready = false;
  document.body.classList.add("is-unavailable");
  statusBox.classList.remove("is-active", "is-off");
  statusTitle.textContent = "ChatGPT not detected";
  statusDetail.textContent = "Open chatgpt.com to use Yacht";
}
