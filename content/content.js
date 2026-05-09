"use strict";

// Guard against double-injection when popup injects programmatically
if (!window.__pageLensInjected) {
  window.__pageLensInjected = true;

  // ─── Message listener ───────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "GET_CONTENT") {
      try {
        sendResponse({ success: true, data: extractContent() });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    }
    return false; // synchronous response — no need to keep channel open
  });

  // ─── Content extraction ─────────────────────────────────────────────────────

  function extractContent() {
    const title = document.title;

    // Try semantic selectors first, in priority order
    const selectors = [
      "article",
      '[role="main"]',
      "main",
      ".post-content",
      ".article-body",
      ".entry-content",
      "#article-body",
      "#main-content",
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 300) {
        return { title, content: clean(el.innerText) };
      }
    }

    // Fallback: strip noise elements from a body clone
    const clone = document.body.cloneNode(true);
    ["nav", "header", "footer", "aside", "script", "style", "noscript"].forEach(
      (tag) => clone.querySelectorAll(tag).forEach((el) => el.remove())
    );

    return { title, content: clean(clone.innerText) };
  }

  function clean(text) {
    return text
      .replace(/[ \t]+/g, " ")       // collapse horizontal whitespace
      .replace(/\n{3,}/g, "\n\n")    // collapse excessive blank lines
      .trim()
      .slice(0, 12000);              // cap length for token limits
  }
}
