"use strict";

// ─── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type) {
    sendResponse({ error: "Invalid message" });
    return false;
  }

  if (msg.type === "SUMMARIZE") {
    handleSummarize(msg.payload, sendResponse);
    return true; // keep the channel open for the async response
  }

  sendResponse({ error: "Unknown message type" });
  return false;
});

// ─── Summarize handler ────────────────────────────────────────────────────────

async function handleSummarize({ content, title }, sendResponse) {
  // Read the API key from storage — never hardcoded
  const result = await chrome.storage.local.get(["apiKey", "model"]);
  const apiKey = result.apiKey;
  const model  = result.model || "openai/gpt-4o-mini";

  if (!apiKey) {
    sendResponse({ error: "NO_KEY" });
    return;
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/pagelens-extension",
        "X-Title": "PageLens",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: "You are a webpage summarizer. Always respond with valid JSON only — no markdown, no explanation outside the JSON.",
          },
          {
            role: "user",
            content: buildPrompt(title, content),
          },
        ],
        temperature: 0.3,
        max_tokens: 600,
      }),
    });

    if (!response.ok) {
      if (response.status === 401) throw new Error("Invalid API key. Check your settings.");
      if (response.status === 429) throw new Error("Rate limit hit. Try again in a moment.");
      throw new Error(`API error ${response.status}.`);
    }

    const data = await response.json();
    const raw  = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error("Empty response from AI.");

    // Strip markdown fences if the model wraps the JSON
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed  = JSON.parse(cleaned);

    sendResponse({ success: true, data: parsed });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(title, content) {
  // Truncate to ~10 000 chars to stay within token limits
  const truncated = content.slice(0, 10000);

  return `Summarize the following webpage as a JSON object with this exact shape:
{
  "summary": ["bullet 1", "bullet 2", "bullet 3"],
  "readingTimeMinutes": 3,
  "wordCount": 500
}
Rules:
- summary: 3 to 5 concise bullet points covering the main content
- readingTimeMinutes: realistic estimate (average 200 wpm)
- wordCount: approximate word count of the source content

Page title: ${title || "Unknown"}
Page content:
${truncated}`;
}
