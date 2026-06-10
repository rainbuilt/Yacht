# ChatGPT Visual Threads

A minimal Manifest V3 Chrome extension that adds visual nested subthreads to ChatGPT. It uses ChatGPT's native **Ask ChatGPT** flow, then hides and shows existing conversation turns to present a virtual thread tree.

## Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder.
5. Open or refresh `https://chatgpt.com/`.

## What it does

- Extends ChatGPT's native **Ask ChatGPT** button so every Ask ChatGPT follow-up becomes a visual subthread.
- Clicking **Ask ChatGPT** preserves the native Ask flow and waits for you to send the follow-up.
- When the follow-up user turn appears, the extension creates a visual subthread and assigns that user turn plus the next assistant turn to it.
- Main and subthread views are created by hiding or showing existing ChatGPT turn DOM nodes.
- Selected source text becomes a clickable anchor back into child subthreads.
- A compact bottom-right thread tree groups Main by answer and nests subthreads under their source answer.
- Subthreads are titled as `[selected text] follow-up question`, with long parts clipped.
- Native Ask ChatGPT reply-context buttons in subthread user turns jump back to the source thread and source anchor when possible.

## Known limitations

- This is visual threading only. It does not isolate or change the model's actual conversation context.
- It does not intercept network requests, modify OpenAI API payloads, or change ChatGPT's composer state manually.
- Turn assignment is intentionally simple: after **Ask ChatGPT**, the next submitted user turn creates the subthread, and the next assistant turn is assigned to it.
- Source anchors are best effort. Very complex selections spanning multiple DOM text nodes may not be re-wrapped perfectly after ChatGPT rerenders.
- Selectors are based on the provided `references/` HTML files and may need updates if ChatGPT changes its DOM.
