/**
 * content.js — PageLens Content Script
 *
 * Guard against double-injection (happens when popup injects
 * programmatically into a tab that already has the script).
 */
if (window.__pageLensInjected) {
  // Already running — do nothing
} else {
window.__pageLensInjected = true;

/**
 * Responsibilities:
 * - Extract clean, readable page content
 * - Respond to popup messages requesting content
 * - Handle in-page highlight injection (sanitized)
 */

// ─── Message Listener ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "GET_PAGE_CONTENT") {
    try {
      const extracted = extractContent();
      sendResponse({ success: true, data: extracted });
    } catch (err) {
      sendResponse({ error: err.message });
    }
    return false; // Synchronous response
  }

  if (message.type === "HIGHLIGHT_PHRASES") {
    try {
      const { phrases } = message.payload || {};
      if (Array.isArray(phrases) && phrases.length > 0) {
        highlightPhrases(phrases);
        sendResponse({ success: true });
      } else {
        sendResponse({ error: "No phrases provided" });
      }
    } catch (err) {
      sendResponse({ error: err.message });
    }
    return false;
  }

  if (message.type === "CLEAR_HIGHLIGHTS") {
    clearHighlights();
    sendResponse({ success: true });
    return false;
  }

  return false;
});

// ─── Content Extraction ──────────────────────────────────────────────────────

function extractContent() {
  const title = document.title || "";
  const url = window.location.href;

  // Try to find the main article content with priority order
  const content = extractMainContent();

  return {
    title,
    url,
    content,
    wordCount: countWords(content),
  };
}

function extractMainContent() {
  // Priority selectors — ordered from most to least semantic
  const candidateSelectors = [
    "article",
    '[role="main"]',
    "main",
    ".article-body",
    ".article-content",
    ".post-content",
    ".entry-content",
    ".content-body",
    "#article-body",
    "#main-content",
    ".story-body",
    ".page-content",
  ];

  for (const selector of candidateSelectors) {
    const el = document.querySelector(selector);
    if (el && hasSubstantialText(el)) {
      return cleanText(el.innerText);
    }
  }

  // Heuristic fallback: find the element with the most text paragraphs
  const heuristic = findContentByHeuristic();
  if (heuristic) return cleanText(heuristic.innerText);

  // Last resort: strip nav/header/footer and use body
  return cleanText(extractFallbackBody());
}

function findContentByHeuristic() {
  const candidates = document.querySelectorAll(
    "div, section, article"
  );

  let best = null;
  let bestScore = 0;

  for (const el of candidates) {
    // Skip navigation, header, footer, sidebar elements
    if (isNoise(el)) continue;

    const paragraphs = el.querySelectorAll("p");
    const textLength = (el.innerText || "").length;

    // Score based on paragraph count and text length
    const score = paragraphs.length * 100 + textLength;

    if (score > bestScore && hasSubstantialText(el)) {
      bestScore = score;
      best = el;
    }
  }

  return best;
}

function extractFallbackBody() {
  // Clone body, remove noise elements, return text
  const clone = document.body.cloneNode(true);
  const noiseSelectors = [
    "nav", "header", "footer", "aside",
    ".nav", ".navbar", ".sidebar", ".menu",
    ".footer", ".header", ".advertisement", ".ad",
    ".cookie-banner", ".popup", "#cookie-notice",
    "script", "style", "noscript", "iframe",
  ];

  for (const sel of noiseSelectors) {
    clone.querySelectorAll(sel).forEach((el) => el.remove());
  }

  return clone.innerText || "";
}

function isNoise(el) {
  const noisePatterns = [
    "nav", "sidebar", "menu", "footer", "header",
    "comment", "advertisement", "ad-", "widget",
    "social", "share", "related", "recommend",
  ];

  const id = (el.id || "").toLowerCase();
  const cls = (el.className || "").toLowerCase();
  const tag = el.tagName.toLowerCase();

  if (["nav", "header", "footer", "aside"].includes(tag)) return true;

  return noisePatterns.some(
    (p) => id.includes(p) || cls.includes(p)
  );
}

function hasSubstantialText(el) {
  const text = (el.innerText || "").trim();
  return text.length > 200 && countWords(text) > 40;
}

function cleanText(text) {
  return text
    .replace(/\t/g, " ")                // Replace tabs
    .replace(/[ ]{2,}/g, " ")           // Collapse multiple spaces
    .replace(/\n{3,}/g, "\n\n")         // Collapse excessive newlines
    .trim();
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─── In-Page Highlighting ────────────────────────────────────────────────────

const HIGHLIGHT_CLASS = "pagelens-highlight";
const HIGHLIGHT_MARK_TAG = "pagelens-mark";

function highlightPhrases(phrases) {
  clearHighlights(); // Remove previous highlights first

  const style = document.createElement("style");
  style.id = "pagelens-highlight-styles";
  style.textContent = `
    ${HIGHLIGHT_MARK_TAG} {
      background: linear-gradient(120deg, rgba(253, 224, 71, 0.6) 0%, rgba(251, 191, 36, 0.5) 100%);
      border-radius: 3px;
      padding: 0 2px;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }
  `;
  document.head.appendChild(style);

  // Walk text nodes and wrap matched phrases
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        // Skip script, style, and already-highlighted nodes
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT"].includes(parent.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.tagName.toUpperCase() === HIGHLIGHT_MARK_TAG.toUpperCase()) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  // Build a combined regex from all phrases (escaped, case-insensitive)
  const escaped = phrases
    .filter((p) => p && p.trim().length > 3) // Skip very short phrases
    .map(escapeRegex)
    .join("|");

  if (!escaped) return;

  const regex = new RegExp(`(${escaped})`, "gi");

  const nodesToReplace = [];
  let node;
  while ((node = walker.nextNode())) {
    if (regex.test(node.textContent)) {
      nodesToReplace.push(node);
    }
  }

  for (const textNode of nodesToReplace) {
    replaceTextNodeWithHighlight(textNode, regex);
  }
}

function replaceTextNodeWithHighlight(textNode, regex) {
  const text = textNode.textContent;
  const parts = text.split(regex);

  if (parts.length <= 1) return;

  const fragment = document.createDocumentFragment();
  let isMatch = false;

  for (const part of parts) {
    if (!part) {
      isMatch = !isMatch;
      continue;
    }

    if (isMatch) {
      const mark = document.createElement(HIGHLIGHT_MARK_TAG);
      mark.className = HIGHLIGHT_CLASS;
      // Sanitize: only set textContent, never innerHTML
      mark.textContent = part;
      fragment.appendChild(mark);
    } else {
      fragment.appendChild(document.createTextNode(part));
    }

    isMatch = !isMatch;
  }

  textNode.parentNode.replaceChild(fragment, textNode);
}

function clearHighlights() {
  // Remove all highlight marks, restoring original text nodes
  document.querySelectorAll(HIGHLIGHT_MARK_TAG).forEach((mark) => {
    const text = document.createTextNode(mark.textContent);
    mark.parentNode.replaceChild(text, mark);
  });

  // Remove style tag
  const style = document.getElementById("pagelens-highlight-styles");
  if (style) style.remove();

  // Normalize text nodes
  document.body.normalize();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

} // end __pageLensInjected guard
