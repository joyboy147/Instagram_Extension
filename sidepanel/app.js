const SEND_TIMEOUT_MS = 35000;
const BETWEEN_SENDS_MS = 8000;

const elements = {
  selectionToggle: document.querySelector("#selection-toggle"),
  recipientCount: document.querySelector("#recipient-count"),
  recipientList: document.querySelector("#recipient-list"),
  clearRecipients: document.querySelector("#clear-recipients"),
  message: document.querySelector("#message"),
  characterCount: document.querySelector("#character-count"),
  confirm: document.querySelector("#confirm"),
  start: document.querySelector("#start"),
  stop: document.querySelector("#stop"),
  runStatus: document.querySelector("#run-status"),
  dialog: document.querySelector("#confirmation-dialog"),
  confirmationCopy: document.querySelector("#confirmation-copy"),
  messagePreview: document.querySelector("#message-preview")
};

let running = false;
let stopRequested = false;
let selectionMode = false;

init();

async function init() {
  const state = await chrome.storage.local.get({
    recipients: [],
    message: "",
    selectionMode: false
  });
  selectionMode = state.selectionMode;
  elements.message.value = state.message;
  updateCharacterCount();
  updateSelectionToggle();
  renderRecipients(state.recipients);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.recipients) renderRecipients(changes.recipients.newValue || []);
  });
}

elements.selectionToggle.addEventListener("click", async () => {
  selectionMode = !selectionMode;
  await chrome.storage.local.set({ selectionMode });
  updateSelectionToggle();
  const tabs = await chrome.tabs.query({ url: "https://www.instagram.com/*" });
  await Promise.allSettled(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, {
    type: "ICM_SET_SELECTION_MODE",
    enabled: selectionMode
  })));
  elements.runStatus.textContent = selectionMode
    ? "Selection enabled. Use the checkboxes beside each Following button."
    : "Selection disabled.";
});

elements.clearRecipients.addEventListener("click", async () => {
  if (running) return;
  await chrome.storage.local.set({ recipients: [] });
  elements.confirm.checked = false;
});

elements.message.addEventListener("input", () => {
  updateCharacterCount();
  chrome.storage.local.set({ message: elements.message.value });
});

elements.start.addEventListener("click", async () => {
  const { recipients = [] } = await chrome.storage.local.get({ recipients: [] });
  const pending = recipients.filter((recipient) => recipient.status !== "sent");
  const message = elements.message.value.trim();
  if (!pending.length) return setStatus("Select at least one recipient.", true);
  if (!message) return setStatus("Write a message first.", true);
  if (!elements.confirm.checked) return setStatus("Confirm that you checked the recipients and message.", true);

  elements.confirmationCopy.textContent = `This will send to ${pending.length} selected account${pending.length === 1 ? "" : "s"}, one at a time.`;
  elements.messagePreview.textContent = message;
  elements.dialog.showModal();
  const choice = await new Promise((resolve) => elements.dialog.addEventListener("close", () => resolve(elements.dialog.returnValue), { once: true }));
  if (choice !== "confirm") return;
  await runQueue(pending.map((recipient) => recipient.username), message);
});

elements.stop.addEventListener("click", () => {
  stopRequested = true;
  elements.runStatus.textContent = "Stopping after the current recipient…";
});

async function runQueue(usernames, message) {
  running = true;
  stopRequested = false;
  setRunningUi(true);

  for (let index = 0; index < usernames.length; index += 1) {
    if (stopRequested) break;
    const username = usernames[index];
    await updateRecipient(username, { status: "sending", error: "" });
    setStatus(`Sending ${index + 1} of ${usernames.length} to @${username}…`);

    const result = await sendToRecipient(username, message);
    if (result.ok) {
      await updateRecipient(username, { status: "sent", error: "" });
    } else {
      await updateRecipient(username, { status: "failed", error: result.error || "Send failed" });
      if (result.blocked) {
        stopRequested = true;
        setStatus(`Stopped: ${result.error}`, true);
        break;
      }
    }

    if (!stopRequested && index < usernames.length - 1) await delay(BETWEEN_SENDS_MS);
  }

  running = false;
  setRunningUi(false);
  if (!stopRequested) setStatus("Queue finished. Check the recipient list for results.");
  else if (!elements.runStatus.textContent.startsWith("Stopped:")) setStatus("Queue stopped. Unsent recipients remain saved; press Resume queue when ready.");
}

async function sendToRecipient(username, message) {
  let tab;
  try {
    tab = await chrome.tabs.create({
      url: `https://www.instagram.com/${encodeURIComponent(username)}/`,
      active: false
    });
    await waitForTabComplete(tab.id, 20000);
    await delay(1200);
    return await sendMessageWithTimeout(tab.id, { type: "ICM_SEND_MESSAGE", message }, SEND_TIMEOUT_MS);
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  } finally {
    if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Profile page timed out.")), timeoutMs);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    function finish(error) {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish();
    }).catch(finish);
  });
}

function sendMessageWithTimeout(tabId, payload, timeoutMs) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, payload),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Message operation timed out.")), timeoutMs))
  ]);
}

async function updateRecipient(username, patch) {
  const { recipients = [] } = await chrome.storage.local.get({ recipients: [] });
  const next = recipients.map((recipient) => recipient.username === username ? { ...recipient, ...patch } : recipient);
  await chrome.storage.local.set({ recipients: next });
}

function renderRecipients(recipients) {
  elements.recipientCount.textContent = recipients.length;
  const remaining = recipients.filter((recipient) => recipient.status !== "sent").length;
  elements.start.textContent = recipients.some((recipient) => ["failed", "sending"].includes(recipient.status))
    ? `Resume queue (${remaining})`
    : "Send queued messages";
  elements.recipientList.replaceChildren(...recipients.map((recipient) => {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = `@${recipient.username}`;
    const status = document.createElement("span");
    status.className = `status ${recipient.status || "pending"}`;
    status.textContent = recipient.status || "pending";
    if (recipient.error) status.title = recipient.error;
    item.append(name, status);
    return item;
  }));
}

function updateSelectionToggle() {
  elements.selectionToggle.textContent = selectionMode ? "Disable" : "Enable";
  elements.selectionToggle.setAttribute("aria-pressed", String(selectionMode));
}

function updateCharacterCount() {
  elements.characterCount.textContent = `${elements.message.value.length} / 1000`;
}

function setRunningUi(isRunning) {
  elements.start.hidden = isRunning;
  elements.stop.hidden = !isRunning;
  elements.selectionToggle.disabled = isRunning;
  elements.clearRecipients.disabled = isRunning;
  elements.message.disabled = isRunning;
}

function setStatus(message, isError = false) {
  elements.runStatus.textContent = message;
  elements.runStatus.style.color = isError ? "#b91c1c" : "#4b5563";
}

function friendlyError(error) {
  const message = error?.message || String(error);
  if (message.includes("Receiving end does not exist")) return "Instagram did not load the extension helper. Reload Instagram and try again.";
  return message;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
