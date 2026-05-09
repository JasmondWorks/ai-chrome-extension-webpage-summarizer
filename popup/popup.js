"use strict";

// ─── State machine ─────────────────────────────────────────────────────────────

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

// ─── Sanitize ──────────────────────────────────────────────────────────────────
// Escapes characters that would be parsed as HTML when inserted via
// insertAdjacentHTML. Any string coming from outside the extension
// (AI response, page title, URL) must pass through this first.

function sanitize(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const { apiKey, model } = await store.get(["apiKey", "model"]);
  if (!apiKey) {
    show("setup");
    return;
  }

  // Restore the previously saved model selection, if any
  if (model) {
    document.querySelector(".model-select").value = model;
  }

  show("idle");
  loadTabInfo();
}

// ─── Tab info ─────────────────────────────────────────────────────────────────

let currentTab = null;

async function loadTabInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  console.log(tab);

  const html = `
    ${tab?.favIconUrl
      ? `<img class="w-4 h-4 rounded-sm shrink-0" src="${sanitize(tab.favIconUrl)}" alt="" />`
      : ""
    }
    <span class="text-xs text-zinc-400 truncate">${sanitize(tab?.title || "Unknown page")}</span>
  `;

  const pageInfo = document.querySelector(".page-info");
  pageInfo.innerHTML = "";
  pageInfo.insertAdjacentHTML("afterbegin", html);
}

// ─── Summarize flow ────────────────────────────────────────────────────────────

async function summarize() {
  if (!currentTab) return;
  show("loading");

  try {
    const contentResp = await sendToTab(currentTab.id, "GET_CONTENT");
    console.log(contentResp);
    if (!contentResp?.success) {
      throw new Error(contentResp?.error || "Could not read page content.");
    }

    const aiResp = await sendToBackground("SUMMARIZE", contentResp.data);

    if (aiResp?.error === "NO_KEY") {
      await store.remove(["apiKey"]);
      show("setup");
      return;
    }
    if (!aiResp?.success) {
      throw new Error(aiResp?.error || "AI request failed.");
    }

    renderResult(aiResp.data);
    show("result");
  } catch (err) {
    const html = sanitize(err.message);

    const errorMsg = document.querySelector(".error-msg");
    errorMsg.innerHTML = "";
    errorMsg.insertAdjacentHTML("afterbegin", html);

    show("error");
  }
}

// ─── Render result ─────────────────────────────────────────────────────────────

function renderResult(data) {
  // ── Meta row: reading time and word count ──
  const metaHtml = `
    <span class="text-xs text-zinc-500">${sanitize(String(data.readingTimeMinutes ?? "—"))} min read</span>
    <span class="text-zinc-700 text-xs">·</span>
    <span class="text-xs text-zinc-500">${(data.wordCount ?? 0).toLocaleString()} words</span>
  `;

  const metaRow = document.querySelector(".meta-row");
  metaRow.innerHTML = "";
  metaRow.insertAdjacentHTML("afterbegin", metaHtml);

  // ── Bullet list: one <li> per summary point ──
  const bulletsHtml = (data.summary || []).map((text) => `
    <li class="flex items-start gap-2 text-sm text-zinc-300 leading-relaxed">
      <span class="mt-[7px] w-1.5 h-1.5 rounded-full bg-green-500 shrink-0"></span>
      <span>${sanitize(text)}</span>
    </li>
  `).join("");

  const bullets = document.querySelector(".bullets");
  bullets.innerHTML = "";
  bullets.insertAdjacentHTML("afterbegin", bulletsHtml);
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

// Persist the chosen model immediately when the user changes it.
// background.js reads chrome.storage.local "model" on every SUMMARIZE call,
// so it will pick up whatever is saved here without any further wiring.
document.querySelector(".model-select").addEventListener("change", async (e) => {
  await store.set({ model: e.target.value });
});

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
document.querySelector(".reset-btn").addEventListener("click", () => init());

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", init);
