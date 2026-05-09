"use strict";

// ─── State elements ────────────────────────────────────────────────────────────

const states = {
  setup:   document.getElementById("setup-state"),
  idle:    document.getElementById("idle-state"),
  loading: document.getElementById("loading-state"),
  result:  document.getElementById("result-state"),
  error:   document.getElementById("error-state"),
};

function show(name) {
  Object.entries(states).forEach(([key, el]) => {
    el.classList.toggle("hidden", key !== name);
  });
}

// ─── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const { apiKey } = await store.get(["apiKey"]);
  if (!apiKey) {
    show("setup");
    return;
  }
  show("idle");
  loadTabInfo();
}

// ─── Tab info ─────────────────────────────────────────────────────────────────

let currentTab = null;

async function loadTabInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;

  const titleEl   = document.getElementById("page-title");
  const faviconEl = document.getElementById("favicon");

  titleEl.textContent = tab?.title || "Unknown page";

  if (tab?.favIconUrl) {
    faviconEl.src = tab.favIconUrl;
  } else {
    faviconEl.style.display = "none";
  }
}

// ─── Summarize flow ────────────────────────────────────────────────────────────

async function summarize() {
  if (!currentTab) return;
  show("loading");

  try {
    // Step 1: ask content.js for the page text
    const contentResp = await sendToTab(currentTab.id, "GET_CONTENT");
    if (!contentResp?.success) {
      throw new Error(contentResp?.error || "Could not read page content.");
    }

    // Step 2: send text to background.js for the AI call
    const aiResp = await sendToBackground("SUMMARIZE", contentResp.data);

    if (aiResp?.error === "NO_KEY") {
      await store.remove(["apiKey"]);
      show("setup");
      return;
    }
    if (!aiResp?.success) {
      throw new Error(aiResp?.error || "AI request failed.");
    }

    // Step 3: render the result
    renderResult(aiResp.data);
    show("result");
  } catch (err) {
    document.getElementById("error-msg").textContent = err.message;
    show("error");
  }
}

// ─── Render ────────────────────────────────────────────────────────────────────

function renderResult(data) {
  document.getElementById("read-time").textContent =
    `${data.readingTimeMinutes ?? "—"} min read`;
  document.getElementById("word-count").textContent =
    `${(data.wordCount ?? 0).toLocaleString()} words`;

  const ul = document.getElementById("bullets");
  ul.innerHTML = "";

  (data.summary || []).forEach((point) => {
    const li   = document.createElement("li");
    li.className = "flex items-start gap-2 text-sm text-zinc-300 leading-relaxed";

    const dot  = document.createElement("span");
    dot.className = "mt-[7px] w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0";

    const text = document.createElement("span");
    text.textContent = point;   // textContent — never innerHTML

    li.appendChild(dot);
    li.appendChild(text);
    ul.appendChild(li);
  });
}

// ─── Chrome storage helpers ────────────────────────────────────────────────────

const store = {
  get:    (keys) => new Promise((res) => chrome.storage.local.get(keys, res)),
  set:    (obj)  => new Promise((res) => chrome.storage.local.set(obj, res)),
  remove: (keys) => new Promise((res) => chrome.storage.local.remove(keys, res)),
};

// ─── Chrome messaging helpers ─────────────────────────────────────────────────

function sendToBackground(type, payload = null) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (resp) => {
      if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
      else resolve(resp);
    });
  });
}

async function sendToTab(tabId, type, payload = null) {
  const msg = { type, payload };

  // First attempt — works if content script is already injected
  const first = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp);
    });
  });
  if (first !== null) return first;

  // Content script not present — inject it then retry
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/content.js"],
    });
  } catch (err) {
    return { error: "Cannot run on this page." };
  }

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
      else resolve(resp);
    });
  });
}

// ─── Event listeners ──────────────────────────────────────────────────────────

document.getElementById("save-key-btn").addEventListener("click", async () => {
  const key = document.getElementById("key-input").value.trim();
  if (!key) return;
  await store.set({ apiKey: key });
  show("idle");
  loadTabInfo();
});

document.getElementById("summarize-btn").addEventListener("click", summarize);
document.getElementById("again-btn").addEventListener("click", summarize);
document.getElementById("retry-btn").addEventListener("click", summarize);

document.getElementById("change-key-btn").addEventListener("click", () => {
  document.getElementById("key-input").value = "";
  show("setup");
});

document.getElementById("clear-btn").addEventListener("click", () => show("idle"));

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", init);
