/**
 * background.js — PageLens Background Service Worker
 *
 * Responsibilities:
 * - Receive messages from popup
 * - Make AI API requests (API key never touches the popup or content script)
 * - Cache summaries per URL using chrome.storage.local
 * - Handle errors and rate limiting
 */

const CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes cache

// ─── Message Router ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Validate message shape — prevents spoofed messages
  if (!message || typeof message.type !== "string") {
    sendResponse({ error: "Invalid message format" });
    return false;
  }

  if (message.type === "SUMMARIZE") {
    handleSummarize(message.payload, sendResponse);
    return true; // Keep channel open for async response
  }

  if (message.type === "GET_SETTINGS") {
    getSettings(sendResponse);
    return true;
  }

  if (message.type === "SAVE_SETTINGS") {
    saveSettings(message.payload, sendResponse);
    return true;
  }

  if (message.type === "CLEAR_CACHE") {
    clearCache(sendResponse);
    return true;
  }

  sendResponse({ error: "Unknown message type" });
  return false;
});

// ─── Summarize Handler ───────────────────────────────────────────────────────

async function handleSummarize({ url, content, title, forceRefresh = false }, sendResponse) {
  try {
    // Input validation
    if (!url || typeof url !== "string") throw new Error("Invalid URL");
    if (!content || typeof content !== "string") throw new Error("No content provided");
    if (content.length < 100) throw new Error("Page content is too short to summarize");

    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cached = await getCachedSummary(url);
      if (cached) {
        sendResponse({ success: true, data: cached, fromCache: true });
        return;
      }
    }

    // Get API key from storage
    const settings = await getSettingsAsync();
    if (!settings.apiKey) {
      sendResponse({ error: "NO_API_KEY", message: "Please add your OpenAI API key in settings." });
      return;
    }

    // Truncate content to avoid token limits (~12,000 chars ≈ ~3000 tokens)
    const truncatedContent = content.slice(0, 12000);

    // Call AI API
    const summary = await callOpenAI({
      apiKey: settings.apiKey,
      model: settings.model || "gpt-4o-mini",
      title,
      content: truncatedContent,
    });

    // Cache the result
    await cacheSummary(url, summary);

    sendResponse({ success: true, data: summary, fromCache: false });
  } catch (err) {
    console.error("[PageLens] Summarize error:", err);

    if (err.message.includes("401")) {
      sendResponse({ error: "INVALID_API_KEY", message: "Your API key is invalid. Please check settings." });
    } else if (err.message.includes("429")) {
      sendResponse({ error: "RATE_LIMIT", message: "Rate limit hit. Please wait a moment and try again." });
    } else if (err.message.includes("500") || err.message.includes("503")) {
      sendResponse({ error: "API_DOWN", message: "OpenAI is temporarily unavailable. Try again shortly." });
    } else {
      sendResponse({ error: "GENERIC", message: err.message || "Something went wrong. Please try again." });
    }
  }
}

// ─── OpenRouter API Call ──────────────────────────────────────────────────────

async function callOpenAI({ apiKey, model, title, content }) {
  const prompt = buildPrompt(title, content);

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      // OpenRouter requires these headers to identify your app
      "HTTP-Referer": "https://github.com/pagelens-extension",
      "X-Title": "PageLens",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are an expert content analyst. Your job is to produce concise, accurate, structured summaries of web pages. Always respond with valid JSON only — no markdown fences, no explanation outside the JSON.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.3,
      max_tokens: 800,
      // Note: response_format is only supported by select models on OpenRouter
      // We parse JSON from the response text instead of requiring it
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`${response.status}: ${errBody}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error("Empty response from AI");

  // Strip markdown code fences if the model wraps its JSON response
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/,"").trim();
  const parsed = JSON.parse(cleaned);
  return normalizeSummary(parsed);
}

// ─── Prompt Builder ──────────────────────────────────────────────────────────

function buildPrompt(title, content) {
  return `Analyze the following webpage and return a JSON object with this exact structure:

{
  "title": "the page title or a clean inferred title",
  "summary": ["bullet point 1", "bullet point 2", "bullet point 3", "bullet point 4", "bullet point 5"],
  "keyInsights": ["insight 1", "insight 2", "insight 3"],
  "readingTimeMinutes": 4,
  "wordCount": 850,
  "sentiment": "neutral",
  "keyHighlights": ["short phrase 1", "short phrase 2", "short phrase 3"]
}

Rules:
- summary: 3–6 concise bullet points covering the main content
- keyInsights: 2–4 notable takeaways or important points
- readingTimeMinutes: realistic estimate based on word count (average 200 wpm)
- wordCount: approximate word count of the source content
- sentiment: one of "positive", "neutral", "negative", "mixed"
- keyHighlights: 2–5 short phrases (under 8 words each) suitable for in-page highlighting

Page Title: ${title || "Unknown"}
Page Content:
${content}`;
}

// ─── Normalize AI Response ────────────────────────────────────────────────────

function normalizeSummary(parsed) {
  return {
    title: sanitizeText(parsed.title || "Summary"),
    summary: Array.isArray(parsed.summary)
      ? parsed.summary.map(sanitizeText).filter(Boolean).slice(0, 6)
      : [],
    keyInsights: Array.isArray(parsed.keyInsights)
      ? parsed.keyInsights.map(sanitizeText).filter(Boolean).slice(0, 4)
      : [],
    readingTimeMinutes: Number(parsed.readingTimeMinutes) || 1,
    wordCount: Number(parsed.wordCount) || 0,
    sentiment: ["positive", "neutral", "negative", "mixed"].includes(parsed.sentiment)
      ? parsed.sentiment
      : "neutral",
    keyHighlights: Array.isArray(parsed.keyHighlights)
      ? parsed.keyHighlights.map(sanitizeText).filter(Boolean).slice(0, 5)
      : [],
    generatedAt: Date.now(),
  };
}

// ─── XSS Prevention ─────────────────────────────────────────────────────────

function sanitizeText(text) {
  if (typeof text !== "string") return "";
  // Strip HTML tags, trim whitespace
  return text.replace(/<[^>]*>/g, "").trim();
}

// ─── Cache Helpers ───────────────────────────────────────────────────────────

async function getCachedSummary(url) {
  const cacheKey = `cache_${hashUrl(url)}`;
  const result = await chrome.storage.local.get(cacheKey);
  const entry = result[cacheKey];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    // Expired — remove it
    chrome.storage.local.remove(cacheKey);
    return null;
  }
  return entry.data;
}

async function cacheSummary(url, data) {
  const cacheKey = `cache_${hashUrl(url)}`;
  await chrome.storage.local.set({
    [cacheKey]: { data, timestamp: Date.now() },
  });
}

async function clearCache(sendResponse) {
  try {
    const all = await chrome.storage.local.get(null);
    const cacheKeys = Object.keys(all).filter((k) => k.startsWith("cache_"));
    if (cacheKeys.length > 0) await chrome.storage.local.remove(cacheKeys);
    sendResponse({ success: true, cleared: cacheKeys.length });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

// Simple URL hash for cache keys (avoids long/special chars in storage keys)
function hashUrl(url) {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = (hash << 5) - hash + url.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

// ─── Settings Helpers ────────────────────────────────────────────────────────

async function getSettingsAsync() {
  const result = await chrome.storage.local.get("settings");
  return result.settings || {};
}

function getSettings(sendResponse) {
  getSettingsAsync()
    .then((s) => sendResponse({ success: true, data: s }))
    .catch((err) => sendResponse({ error: err.message }));
}

function saveSettings(payload, sendResponse) {
  // Only save whitelisted keys — prevents arbitrary data injection
  const safe = {};
  if (typeof payload.apiKey === "string") safe.apiKey = payload.apiKey.trim();
  if (typeof payload.model === "string") safe.model = payload.model;
  if (typeof payload.theme === "string") safe.theme = payload.theme;

  chrome.storage.local
    .set({ settings: safe })
    .then(() => sendResponse({ success: true }))
    .catch((err) => sendResponse({ error: err.message }));
}
