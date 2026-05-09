/**
 * popup.js — PageLens Popup Controller
 *
 * Manages all UI state transitions and wires up user interactions.
 * Communicates with background.js via chrome.runtime.sendMessage.
 * Communicates with content.js via chrome.tabs.sendMessage.
 */

"use strict";

// ─── DOM References ──────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const els = {
  // Panels
  mainPanel: $("main-panel"),
  settingsPanel: $("settings-panel"),

  // Page info
  pageTitle: $("page-title-text"),
  pageFavicon: $("page-favicon"),
  pageFaviconWrap: $("page-favicon-wrap"),

  // States
  idleState: $("idle-state"),
  loadingState: $("loading-state"),
  errorState: $("error-state"),
  summaryState: $("summary-state"),

  // Loading steps
  stepExtract: $("step-extract"),
  stepSend: $("step-send"),
  stepFormat: $("step-format"),

  // Meta chips
  metaReadTime: $("meta-read-time"),
  metaWordCount: $("meta-word-count"),
  metaSentiment: $("meta-sentiment"),
  metaSentimentText: $("meta-sentiment-text"),
  cacheChip: $("cache-chip"),

  // Summary content
  summaryBullets: $("summary-bullets"),
  insightsList: $("insights-list"),

  // Error
  errorMessage: $("error-message"),

  // Buttons
  summarizeBtn: $("summarize-btn"),
  retryBtn: $("retry-btn"),
  clearBtn: $("clear-btn"),
  refreshBtn: $("refresh-btn"),
  copyBtn: $("copy-btn"),
  highlightBtn: $("highlight-btn"),
  settingsBtn: $("settings-btn"),
  closeSettingsBtn: $("close-settings-btn"),
  saveSettingsBtn: $("save-settings-btn"),
  clearCacheBtn: $("clear-cache-btn"),
  errorSettingsBtn: $("error-settings-btn"),

  // Settings fields
  apiKeyInput: $("api-key-input"),
  toggleKeyBtn: $("toggle-key-btn"),
  eyeShow: $("eye-show"),
  eyeHide: $("eye-hide"),
  modelSelect: $("model-select"),
  themeDark: $("theme-dark"),
  themeLight: $("theme-light"),
  settingsStatus: $("settings-status"),
};

// ─── State ───────────────────────────────────────────────────────────────────

let currentTab = null;
let currentSummary = null;
let isHighlighting = false;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await loadTheme();
  await loadCurrentTab();
  bindEvents();
}

// ─── Tab Info ─────────────────────────────────────────────────────────────────

async function loadCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;

    if (tab?.title) {
      els.pageTitle.textContent = tab.title;
    }

    if (tab?.favIconUrl) {
      els.pageFavicon.src = tab.favIconUrl;
      els.pageFavicon.style.display = "block";
    } else {
      els.pageFavicon.style.display = "none";
    }
  } catch {
    els.pageTitle.textContent = "Unable to read page info";
  }
}

// ─── Theme ────────────────────────────────────────────────────────────────────

async function loadTheme() {
  try {
    const resp = await sendToBackground("GET_SETTINGS");
    const theme = resp?.data?.theme || "dark";
    applyTheme(theme);
  } catch {
    applyTheme("dark");
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  els.themeDark.classList.toggle("active", theme === "dark");
  els.themeLight.classList.toggle("active", theme === "light");
}

// ─── Event Bindings ───────────────────────────────────────────────────────────

function bindEvents() {
  // Main actions
  els.summarizeBtn.addEventListener("click", () => startSummarize(false));
  els.retryBtn.addEventListener("click", () => startSummarize(false));
  els.refreshBtn.addEventListener("click", () => startSummarize(true));
  els.clearBtn.addEventListener("click", resetToIdle);
  els.copyBtn.addEventListener("click", copySummary);
  els.highlightBtn.addEventListener("click", toggleHighlights);

  // Settings navigation
  els.settingsBtn.addEventListener("click", openSettings);
  els.closeSettingsBtn.addEventListener("click", closeSettings);
  els.errorSettingsBtn.addEventListener("click", openSettings);

  // Settings actions
  els.saveSettingsBtn.addEventListener("click", saveSettings);
  els.clearCacheBtn.addEventListener("click", clearCache);

  // Theme toggle
  els.themeDark.addEventListener("click", () => setTheme("dark"));
  els.themeLight.addEventListener("click", () => setTheme("light"));

  // API key visibility toggle
  els.toggleKeyBtn.addEventListener("click", () => {
    const isPassword = els.apiKeyInput.type === "password";
    els.apiKeyInput.type = isPassword ? "text" : "password";
    els.eyeShow.classList.toggle("hidden", isPassword);
    els.eyeHide.classList.toggle("hidden", !isPassword);
  });

  // Keyboard: Summarize on Enter from idle
  els.summarizeBtn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      startSummarize(false);
    }
  });
}

// ─── Summarize Flow ───────────────────────────────────────────────────────────

async function startSummarize(forceRefresh = false) {
  if (!currentTab) return;

  showState("loading");
  setLoadingStep(0);

  try {
    // Step 1: Extract page content
    setLoadingStep(0);
    const contentResp = await sendToTab(currentTab.id, "GET_PAGE_CONTENT");

    if (!contentResp?.success) {
      throw new Error(contentResp?.error || "Failed to extract page content. Try refreshing the page.");
    }

    const { content, title, url, wordCount } = contentResp.data;

    // Step 2: Send to AI
    setLoadingStep(1);
    const summaryResp = await sendToBackground("SUMMARIZE", {
      url: url || currentTab.url,
      content,
      title: title || currentTab.title,
      forceRefresh,
    });

    if (!summaryResp?.success) {
      const errCode = summaryResp?.error;
      const errMsg = summaryResp?.message || "Something went wrong.";

      if (errCode === "NO_API_KEY") {
        showError(`No API key found. ${errMsg}`, true);
      } else {
        showError(errMsg);
      }
      return;
    }

    // Step 3: Render
    setLoadingStep(2);
    currentSummary = summaryResp.data;

    // Small delay for perceived smoothness
    await sleep(300);

    renderSummary(summaryResp.data, summaryResp.fromCache);
    showState("summary");
  } catch (err) {
    console.error("[PageLens Popup]", err);
    showError(err.message || "An unexpected error occurred.");
  }
}

// ─── Loading Steps ────────────────────────────────────────────────────────────

const steps = ["step-extract", "step-send", "step-format"];

function setLoadingStep(activeIndex) {
  steps.forEach((id, i) => {
    const el = $(id);
    if (!el) return;
    el.classList.remove("active", "done");
    if (i < activeIndex) el.classList.add("done");
    else if (i === activeIndex) el.classList.add("active");
  });
}

// ─── Summary Rendering ────────────────────────────────────────────────────────

function renderSummary(data, fromCache) {
  // Meta chips
  els.metaReadTime.textContent = `${data.readingTimeMinutes} min read`;
  els.metaWordCount.textContent = `${(data.wordCount || 0).toLocaleString()} words`;

  const sentimentLabels = {
    positive: "😊 Positive",
    negative: "😐 Negative",
    neutral: "Neutral",
    mixed: "Mixed",
  };
  els.metaSentimentText.textContent = sentimentLabels[data.sentiment] || "Neutral";
  els.metaSentiment.setAttribute("data-sentiment", data.sentiment || "neutral");

  // Cache chip
  els.cacheChip.classList.toggle("hidden", !fromCache);

  // Summary bullets — sanitized (textContent only, never innerHTML for user data)
  els.summaryBullets.innerHTML = "";
  (data.summary || []).forEach((point) => {
    const li = document.createElement("li");
    li.textContent = point; // textContent prevents XSS
    els.summaryBullets.appendChild(li);
  });

  // Insights
  els.insightsList.innerHTML = "";
  (data.keyInsights || []).forEach((insight) => {
    const li = document.createElement("li");
    li.textContent = insight;
    els.insightsList.appendChild(li);
  });

  // Reset highlight button state
  isHighlighting = false;
  els.highlightBtn.setAttribute("aria-pressed", "false");
}

// ─── Highlight Toggle ─────────────────────────────────────────────────────────

async function toggleHighlights() {
  if (!currentTab || !currentSummary) return;

  if (isHighlighting) {
    // Clear highlights
    await sendToTab(currentTab.id, "CLEAR_HIGHLIGHTS");
    isHighlighting = false;
    els.highlightBtn.setAttribute("aria-pressed", "false");
  } else {
    // Apply highlights
    const phrases = currentSummary.keyHighlights || [];
    if (phrases.length === 0) return;

    const resp = await sendToTab(currentTab.id, "HIGHLIGHT_PHRASES", { phrases });
    if (resp?.success) {
      isHighlighting = true;
      els.highlightBtn.setAttribute("aria-pressed", "true");
    }
  }
}

// ─── Copy Summary ─────────────────────────────────────────────────────────────

async function copySummary() {
  if (!currentSummary) return;

  const bullets = (currentSummary.summary || []).map((b) => `• ${b}`).join("\n");
  const insights = (currentSummary.keyInsights || []).map((i) => `→ ${i}`).join("\n");

  const text = [
    `📄 ${currentSummary.title || "Summary"}`,
    `⏱ ${currentSummary.readingTimeMinutes} min read · ${(currentSummary.wordCount || 0).toLocaleString()} words`,
    "",
    "Summary",
    bullets,
    "",
    "Key Insights",
    insights,
    "",
    `Summarized with PageLens`,
  ].join("\n");

  try {
    await navigator.clipboard.writeText(text);
    const orig = els.copyBtn.innerHTML;
    els.copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 7l3 3 6-6" stroke="var(--accent)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg> Copied!`;
    setTimeout(() => { els.copyBtn.innerHTML = orig; }, 1800);
  } catch {
    // Clipboard unavailable
  }
}

// ─── Reset ────────────────────────────────────────────────────────────────────

async function resetToIdle() {
  // Clear highlights if active
  if (isHighlighting && currentTab) {
    await sendToTab(currentTab.id, "CLEAR_HIGHLIGHTS").catch(() => {});
    isHighlighting = false;
  }
  currentSummary = null;
  showState("idle");
}

// ─── Error Display ────────────────────────────────────────────────────────────

function showError(message, isApiKeyError = false) {
  els.errorMessage.textContent = message;

  // Show/hide settings shortcut based on error type
  els.errorSettingsBtn.style.display = isApiKeyError ? "inline-flex" : "none";

  showState("error");
}

// ─── State Machine ────────────────────────────────────────────────────────────

function showState(state) {
  const stateMap = {
    idle: els.idleState,
    loading: els.loadingState,
    error: els.errorState,
    summary: els.summaryState,
  };

  Object.entries(stateMap).forEach(([key, el]) => {
    el.classList.toggle("hidden", key !== state);
  });
}

// ─── Settings Panel ───────────────────────────────────────────────────────────

async function openSettings() {
  // Load current settings into form
  const resp = await sendToBackground("GET_SETTINGS");
  const settings = resp?.data || {};

  if (settings.apiKey) {
    // Show masked version
    els.apiKeyInput.value = settings.apiKey;
  }

  if (settings.model) {
    els.modelSelect.value = settings.model;
  }

  applyTheme(settings.theme || "dark");

  els.settingsStatus.textContent = "";
  els.mainPanel.classList.add("hidden");
  els.settingsPanel.classList.remove("hidden");
}

function closeSettings() {
  els.settingsPanel.classList.add("hidden");
  els.mainPanel.classList.remove("hidden");
}

async function saveSettings() {
  const apiKey = els.apiKeyInput.value.trim();
  const model = els.modelSelect.value;
  const theme = document.documentElement.getAttribute("data-theme") || "dark";

  if (apiKey && !apiKey.startsWith("sk-or-")) {
    els.settingsStatus.textContent = "⚠ That doesn't look like a valid OpenRouter key (should start with sk-or-)";
    els.settingsStatus.style.color = "var(--error)";
    return;
  }

  const resp = await sendToBackground("SAVE_SETTINGS", { apiKey, model, theme });
  if (resp?.success) {
    els.settingsStatus.textContent = "✓ Settings saved";
    els.settingsStatus.style.color = "var(--accent)";
    setTimeout(() => {
      els.settingsStatus.textContent = "";
    }, 2000);
  } else {
    els.settingsStatus.textContent = "Failed to save settings";
    els.settingsStatus.style.color = "var(--error)";
  }
}

function setTheme(theme) {
  applyTheme(theme);
}

async function clearCache() {
  const resp = await sendToBackground("CLEAR_CACHE");
  if (resp?.success) {
    els.settingsStatus.textContent = `✓ Cleared ${resp.cleared} cached summar${resp.cleared === 1 ? "y" : "ies"}`;
    els.settingsStatus.style.color = "var(--accent)";
    setTimeout(() => { els.settingsStatus.textContent = ""; }, 2500);
  }
}

// ─── Messaging Helpers ────────────────────────────────────────────────────────

function sendToBackground(type, payload = null) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type, ...(payload ? { payload } : {}) },
      (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
        } else {
          resolve(resp);
        }
      }
    );
  });
}

async function sendToTab(tabId, type, payload = null) {
  const message = { type, ...(payload ? { payload } : {}) };

  // First attempt
  const first = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp);
    });
  });

  if (first !== null) return first;

  // Content script not loaded — inject it now then retry
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/content.js"],
    });
  } catch (err) {
    return { success: false, error: "Cannot run on this page: " + err.message };
  }

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp);
      }
    });
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", init);
