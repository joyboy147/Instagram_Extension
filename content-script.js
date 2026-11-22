const SELECT_CONTROL_CLASS = "icm-select-control";
const SELECTED_ROW_CLASS = "icm-selected-row";
const RESERVED_ROUTES = new Set([
  "accounts",
  "direct",
  "explore",
  "reels",
  "stories",
  "p",
  "legal",
  "about"
]);

let selectionMode = false;
let observer;
let decorateTimer;

chrome.storage.local.get({ selectionMode: false }).then(({ selectionMode: enabled }) => {
  selectionMode = enabled;
  if (selectionMode) startSelectionObserver();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.recipients) {
    syncVisibleSelections(changes.recipients.newValue || []);
  }
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === "ICM_SET_SELECTION_MODE") {
    selectionMode = Boolean(request.enabled);
    chrome.storage.local.set({ selectionMode });
    if (selectionMode) {
      startSelectionObserver();
    } else {
      stopSelectionObserver();
      removeSelectionControls();
    }
    sendResponse({ ok: true });
    return false;
  }

  if (request.type === "ICM_SEND_MESSAGE") {
    sendDirectMessage(request.message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

function startSelectionObserver() {
  if (!observer) {
    observer = new MutationObserver(scheduleDecoration);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  scheduleDecoration();
}

function stopSelectionObserver() {
  observer?.disconnect();
  observer = undefined;
  clearTimeout(decorateTimer);
}

function scheduleDecoration() {
  clearTimeout(decorateTimer);
  decorateTimer = setTimeout(decorateFollowingDialog, 150);
}

function getUsernameFromHref(href) {
  try {
    const url = new URL(href, location.origin);
    if (url.origin !== location.origin) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1 || RESERVED_ROUTES.has(parts[0])) return null;
    return decodeURIComponent(parts[0]);
  } catch {
    return null;
  }
}

function findAccountControls(anchor, dialog) {
  let node = anchor;
  for (let depth = 0; node && node !== dialog && depth < 9; depth += 1) {
    const parent = node.parentElement;
    if (!parent) break;
    const action = [...parent.querySelectorAll('button, [role="button"]')]
      .find((element) => buttonLabel(element) === "following");
    if (action) return { row: parent, action };
    node = parent;
  }
  return null;
}

async function decorateFollowingDialog() {
  if (!selectionMode) return;
  const dialogs = [...document.querySelectorAll('[role="dialog"]')];
  for (const dialog of dialogs) {
    const anchors = [...dialog.querySelectorAll('a[href]')];
    for (const anchor of anchors) {
      const username = getUsernameFromHref(anchor.getAttribute("href"));
      if (!username) continue;
      const controls = findAccountControls(anchor, dialog);
      if (!controls) continue;
      const { row, action } = controls;
      if (row.querySelector(`.${SELECT_CONTROL_CLASS}[data-username="${CSS.escape(username)}"]`)) continue;

      const label = document.createElement("label");
      label.className = SELECT_CONTROL_CLASS;
      label.dataset.username = username;
      label.title = `Select @${username}`;

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.setAttribute("aria-label", `Select ${username}`);
      checkbox.addEventListener("click", (event) => event.stopPropagation());
      checkbox.addEventListener("change", (event) => {
        event.stopPropagation();
        setRecipientSelected(username, row, checkbox, checkbox.checked);
      });
      label.addEventListener("click", (event) => event.stopPropagation());
      label.appendChild(checkbox);
      action.insertAdjacentElement("afterend", label);
      await syncSelectionCheckbox(username, row, checkbox);
    }
  }
}

async function setRecipientSelected(username, row, checkbox, selected) {
  const { recipients = [] } = await chrome.storage.local.get({ recipients: [] });
  const exists = recipients.some((recipient) => recipient.username === username);
  const next = selected && !exists
    ? [...recipients, { username, status: "pending", error: "" }]
    : !selected && exists
      ? recipients.filter((recipient) => recipient.username !== username)
      : recipients;
  await chrome.storage.local.set({ recipients: next });
  setCheckboxState(row, checkbox, selected);
}

async function syncSelectionCheckbox(username, row, checkbox) {
  const { recipients = [] } = await chrome.storage.local.get({ recipients: [] });
  setCheckboxState(row, checkbox, recipients.some((recipient) => recipient.username === username));
}

function setCheckboxState(row, checkbox, selected) {
  checkbox.checked = selected;
  row.classList.toggle(SELECTED_ROW_CLASS, selected);
}

function syncVisibleSelections(recipients) {
  const selected = new Set(recipients.map((recipient) => recipient.username));
  document.querySelectorAll(`.${SELECT_CONTROL_CLASS}`).forEach((control) => {
    const checkbox = control.querySelector('input[type="checkbox"]');
    if (!checkbox) return;
    const isSelected = selected.has(control.dataset.username);
    checkbox.checked = isSelected;
    control.closest(`.${SELECTED_ROW_CLASS}`)?.classList.toggle(SELECTED_ROW_CLASS, isSelected);
  });
}

function removeSelectionControls() {
  document.querySelectorAll(`.${SELECT_CONTROL_CLASS}`).forEach((control) => control.remove());
  document.querySelectorAll(`.${SELECTED_ROW_CLASS}`).forEach((row) => row.classList.remove(SELECTED_ROW_CLASS));
}

async function sendDirectMessage(message) {
  if (!message?.trim()) return { ok: false, error: "The message is empty." };
  if (isBlockedPage()) return { ok: false, blocked: true, error: "Instagram is requesting login or verification." };

  const messageButton = await waitFor(() => findButtonByText(["message"]), 12000);
  if (!messageButton) return { ok: false, error: "Could not find the Message button on this profile." };
  messageButton.click();

  const composer = await waitFor(findComposer, 15000);
  if (!composer) {
    if (isBlockedPage()) return { ok: false, blocked: true, error: "Instagram interrupted the send with a checkpoint." };
    return { ok: false, error: "Could not open the message composer." };
  }

  focusAndInsertText(composer, message.trim());
  const sendButton = await waitFor(() => findButtonByText(["send"]), 5000);
  if (!sendButton || sendButton.disabled) return { ok: false, error: "Could not find an enabled Send button." };
  sendButton.click();

  await delay(1200);
  if (isBlockedPage()) return { ok: false, blocked: true, error: "Instagram stopped the send and requested verification." };
  return { ok: true };
}

function findComposer() {
  const candidates = [
    ...document.querySelectorAll('textarea[placeholder*="essage" i]'),
    ...document.querySelectorAll('[contenteditable="true"][role="textbox"]'),
    ...document.querySelectorAll('[contenteditable="true"][aria-label*="essage" i]')
  ];
  return candidates.find(isVisible);
}

function findButtonByText(labels) {
  const normalized = labels.map((label) => label.toLowerCase());
  const candidates = [...document.querySelectorAll('button, [role="button"]')].filter((element) => {
    if (!isVisible(element)) return false;
    return true;
  });
  return candidates.find((element) => normalized.includes(buttonLabel(element))) || null;
}

function buttonLabel(element) {
  const visibleText = element.textContent?.replace(/\s+/g, " ").trim().toLowerCase();
  const ariaLabel = element.getAttribute("aria-label")?.trim().toLowerCase();
  return visibleText || ariaLabel || "";
}

function focusAndInsertText(element, text) {
  element.focus();
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
    setter?.call(element, text);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  element.textContent = "";
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  const inserted = document.execCommand?.("insertText", false, text);
  if (!inserted) {
    element.textContent = text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }
}

function isBlockedPage() {
  const body = document.body?.innerText?.toLowerCase() || "";
  const path = location.pathname.toLowerCase();
  return path.startsWith("/accounts/login") ||
    path.includes("challenge") ||
    body.includes("confirm it's you") ||
    body.includes("suspicious login attempt") ||
    body.includes("try again later") ||
    body.includes("we restrict certain activity");
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

async function waitFor(finder, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = finder();
    if (result) return result;
    await delay(250);
  }
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
