"use strict";

// ─── State elements ────────────────────────────────────────────────────────────
// Each key maps to one <div> in the HTML. show() hides all of them
// then removes "hidden" from whichever one was requested.

const states = {
  setup:   document.querySelector(".setup-state"),
  idle:    document.querySelector(".idle-state"),
  loading: document.querySelector(".loading-state"),
  result:  document.querySelector(".result-state"),
  error:   document.querySelector(".error-state"),
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

  const titleEl   = document.querySelector(".page-title");
  const faviconEl = document.querySelector(".favicon");

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
    // Step 1: message content.js — it extracts the page text and replies
    const contentResp = await sendToTab(currentTab.id, "GET_CONTENT");
    if (!contentResp?.success) {
      throw new Error(contentResp?.error || "Could not read page content.");
    }

    // Step 2: message background.js — it calls the OpenRouter API and replies
    // with the parsed summary. The API key never leaves background.js.
    const aiResp = await sendToBackground("SUMMARIZE", contentResp.data);

    if (aiResp?.error === "NO_KEY") {
      await store.remove(["apiKey"]);
      show("setup");
      return;
    }
    if (!aiResp?.success) {
      throw new Error(aiResp?.error || "AI request failed.");
    }

    // Step 3: background.js replied with { success: true, data: {...} }
    // aiResp.data is the parsed JSON from the AI: { summary, readingTimeMinutes, wordCount }
    renderResult(aiResp.data);
    show("result");
  } catch (err) {
    document.querySelector(".error-msg").textContent = err.message;
    show("error");
  }
}

// ─── HTML template functions ───────────────────────────────────────────────────
// Each function accepts data ("props") and returns an HTML string.
// sanitize() escapes any data that came from outside before it touches innerHTML.

function sanitize(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function BulletItem({ text }) {
  return `
    <li class="flex items-start gap-2 text-sm text-zinc-300 leading-relaxed">
      <span class="mt-[7px] w-1.5 h-1.5 rounded-full bg-green-500 shrink-0"></span>
      <span>${sanitize(text)}</span>
    </li>
  `;
}

function BulletList({ items }) {
  return items.map((text) => BulletItem({ text })).join("");
}

// ─── Render result ─────────────────────────────────────────────────────────────

function renderResult(data) {
  document.querySelector(".read-time").textContent =
    `${data.readingTimeMinutes ?? "—"} min read`;
  document.querySelector(".word-count").textContent =
    `${(data.wordCount ?? 0).toLocaleString()} words`;

  document.querySelector(".bullets").innerHTML =
    BulletList({ items: data.summary || [] });
}

// ─── Chrome storage helpers ────────────────────────────────────────────────────

const store = {
  get:    (keys) => new Promise((res) => chrome.storage.local.get(keys, res)),
  set:    (obj)  => new Promise((res) => chrome.storage.local.set(obj, res)),
  remove: (keys) => new Promise((res) => chrome.storage.local.remove(keys, res)),
};

// ─── Chrome messaging helpers ─────────────────────────────────────────────────

// Sends a message to background.js. background.js calls sendResponse(data)
// which resolves this Promise with that data — that's how the reply travels back.
function sendToBackground(type, payload = null) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (resp) => {
      if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
      else resolve(resp);
    });
  });
}

// Sends a message to content.js running inside the active tab.
// Falls back to injecting the script first if the tab was already open
// before the extension loaded.
async function sendToTab(tabId, type, payload = null) {
  const msg = { type, payload };

  const first = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp);
    });
  });
  if (first !== null) return first;

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/content.js"] });
  } catch {
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

document.querySelector(".save-key-btn").addEventListener("click", async () => {
  const key = document.querySelector(".key-input").value.trim();
  if (!key) return;
  await store.set({ apiKey: key });
  show("idle");
  loadTabInfo();
});

document.querySelector(".summarize-btn").addEventListener("click", summarize);
document.querySelector(".again-btn").addEventListener("click", summarize);
document.querySelector(".retry-btn").addEventListener("click", summarize);

document.querySelector(".change-key-btn").addEventListener("click", () => {
  document.querySelector(".key-input").value = "";
  show("setup");
});

document.querySelector(".clear-btn").addEventListener("click", () => show("idle"));

// reset-btn: wipes the current flow and goes back to the very first screen
document.querySelector(".reset-btn").addEventListener("click", () => init());

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", init);
