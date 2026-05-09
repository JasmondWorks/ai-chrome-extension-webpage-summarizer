# PageLens — AI Page Summarizer Chrome Extension

A clean, production-grade Chrome Extension (Manifest V3) that extracts content from any webpage and returns structured AI-powered summaries: bullet points, key insights, sentiment, and estimated reading time — with optional in-page highlighting.

---

## Setup Instructions

### Prerequisites
- Google Chrome (or any Chromium-based browser)
- An [OpenAI API key](https://platform.openai.com/api-keys)

### Install the Extension

1. **Clone or download** this repository:
   ```bash
   git clone https://github.com/your-username/pagelens-extension.git
   ```

2. Open Chrome and go to `chrome://extensions`

3. Enable **Developer Mode** (toggle in the top-right corner)

4. Click **"Load unpacked"**

5. Select the root folder of this project (the one containing `manifest.json`)

6. The PageLens icon will appear in your Chrome toolbar

### Add Your API Key

1. Click the PageLens icon in the toolbar
2. Click the **Settings (⚙)** icon
3. Paste your OpenAI API key (starts with `sk-`)
4. Select your preferred model (GPT-4o Mini is recommended for speed and cost)
5. Click **Save Settings**

You're ready to summarize pages.

---

## How to Use

1. Navigate to any article or webpage
2. Click the **PageLens** icon
3. Click **"Summarize Page"**
4. The extension will:
   - Extract the page content
   - Send it to OpenAI
   - Display a structured summary with reading time, word count, and sentiment
5. Use the **Highlight** button to mark key phrases directly on the page
6. Use **Copy** to copy the full summary to your clipboard

---

## Architecture Explanation

```
pagelens-extension/
├── manifest.json        # Extension config (Manifest V3)
├── background.js        # Service worker — AI calls, caching, settings
├── content.js           # Content script — DOM extraction, in-page highlighting
├── popup.html           # Extension popup UI
├── popup.css            # Popup styles (dark/light theme, CSS variables)
├── popup.js             # Popup controller — state machine, messaging
└── icons/               # Extension icons (16, 48, 128px)
```

### File Responsibilities

**`manifest.json`**
- Declares Manifest V3 compliance
- Requests only `activeTab`, `scripting`, and `storage` permissions
- Restricts host permissions to `api.openai.com` only
- Registers the background service worker as an ES module

**`background.js`** (Service Worker)
- The only file that ever touches the OpenAI API
- Validates all incoming messages before processing
- Manages a 30-minute cache layer in `chrome.storage.local`
- Sanitizes AI responses to prevent XSS before passing to popup
- Handles all error types (401, 429, 5xx) with clear error codes

**`content.js`** (Content Script)
- Runs in the context of every page
- Extracts readable content using a priority selector chain, then a heuristic paragraph-density algorithm, then a filtered body fallback
- Handles in-page phrase highlighting using a safe TreeWalker-based approach (never uses `innerHTML`)
- Normalizes text nodes after un-highlighting

**`popup.js`**
- Pure UI controller with a simple state machine: `idle → loading → summary | error`
- Never makes network requests directly
- Always communicates with background via `chrome.runtime.sendMessage`
- Always communicates with the content script via `chrome.tabs.sendMessage`

---

## AI Integration Explanation

### Provider
OpenAI via `https://api.openai.com/v1/chat/completions`

### Model
Configurable by the user. Defaults to `gpt-4o-mini` (best balance of cost, speed, and quality for summarization).

### Prompt Design
The prompt instructs the model to return a strict JSON object with:
- `summary` — 3–6 bullet points
- `keyInsights` — 2–4 notable takeaways
- `readingTimeMinutes` — estimated at 200 wpm
- `wordCount` — approximate count
- `sentiment` — one of: positive, neutral, negative, mixed
- `keyHighlights` — short phrases (≤8 words) suitable for page highlighting

Using `response_format: { type: "json_object" }` enforces JSON-only output from the API, eliminating the need to parse markdown-wrapped JSON.

### Content Truncation
Page content is truncated to ~12,000 characters before sending to avoid token limit errors while keeping costs minimal.

---

## Security Decisions

### API Key Storage
- The API key is stored exclusively in `chrome.storage.local` (device-local, not synced across devices)
- It is **never** stored in `chrome.storage.sync`, `localStorage`, or any accessible-to-content-scripts storage
- The key is only read by `background.js` — the content script and popup never see it

### No Key in Frontend
The popup sends a summarize request to the background worker. The background worker fetches the key from storage and makes the API call. The key never passes through message channels.

### Message Validation
All `chrome.runtime.onMessage` handlers validate:
- Message shape (must have a string `type`)
- Whitelisted message types (unknown types are rejected)
- Payload fields are individually validated before use

Settings saved via message only accept whitelisted keys (`apiKey`, `model`, `theme`).

### XSS Prevention
- Summary content rendered into the DOM uses `element.textContent` exclusively — never `innerHTML`
- In-page highlights use `document.createTextNode()` for text fragments — never string interpolation into HTML
- AI responses are normalized (HTML tags stripped) in `background.js` before being sent to the popup

### Permissions
- `activeTab` — only access the current tab when the user clicks the icon
- `scripting` — needed to inject content scripts dynamically
- `storage` — for caching and settings
- `host_permissions` only covers `api.openai.com` — no broad `<all_urls>` host access

---

## Trade-offs

| Decision | Trade-off |
|---|---|
| Vanilla JS (no framework) | Simpler build, faster load — but no component reuse |
| `chrome.storage.local` for API key | More secure than sync — but key doesn't roam across devices |
| Content truncated at ~12K chars | Prevents token errors and cost overruns — but may miss content on very long pages |
| 30-minute cache TTL | Reduces API calls — but might show stale summary for live/updating pages |
| Single AI provider (OpenAI) | Simple integration — but not portable if user doesn't have OpenAI access |
| In-page highlighting via TreeWalker | Safe and accurate — but reflows the DOM; could affect page layout on edge cases |
| Service worker (MV3) | Required for MV3 compliance — but worker can be killed by browser; handled gracefully |

---

## Optional Enhancements (not yet implemented)

- **Gemini / Claude API support** — add alternate AI provider options in settings
- **PDF support** — extract text from in-browser PDFs
- **Summarize selection** — right-click context menu to summarize highlighted text only
- **Export to Markdown** — save summary as `.md` file
- **Multi-language support** — detect page language and respond in-kind

---

## Tech Stack

- **Chrome Extension**: Manifest V3
- **UI**: Vanilla HTML, CSS (CSS custom properties), JavaScript (ES2022)
- **Fonts**: Syne (headings), DM Sans (body) via Google Fonts
- **AI**: OpenAI Chat Completions API
- **Storage**: `chrome.storage.local`
- **No build step required** — load directly as unpacked extension
