"use strict";

// Guard against double-injection when popup injects programmatically
if (!window.__pageLensInjected) {
  window.__pageLensInjected = true;

  // ─── Message listener ───────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "GET_CONTENT") {
      try {
        const data = extractContent();
        console.log("[content.js] extracted data:", data);
        sendResponse({ success: true, data });
      } catch (err) {
        console.log("[content.js] extraction error:", err.message);
        sendResponse({ success: false, error: err.message });
      }
    }
    return false;
  });

  // ─── Content extraction ─────────────────────────────────────────────────────

  function extractContent() {
    const title = document.title;

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

    // for...of so that return exits extractContent, not just the callback
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 300) {
        console.log("[content.js] matched selector:", sel);
        return { title, content: clean(el.innerText) };
      }
    }

    // Fallback: strip noise elements from a body clone
    console.log("[content.js] no selector matched — using body fallback");
    const clone = document.body.cloneNode(true);
    ["nav", "header", "footer", "aside", "script", "style", "noscript"].forEach(
      (tag) => clone.querySelectorAll(tag).forEach((el) => el.remove())
    );

    return { title, content: clean(clone.innerText) };
  }

  function clean(text) {
    return text
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 12000);
  }
}
