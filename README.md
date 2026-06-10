# ChatGPT Visual Threads

A minimal Manifest V3 Chrome extension that adds visual nested subthreads to ChatGPT. It uses ChatGPT's native **Ask ChatGPT** flow, then hides and shows existing conversation turns to present a virtual thread tree.

## Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder.
5. Open or refresh `https://chatgpt.com/`.

## What it does

- Adds an **Ask in Thread** button beside ChatGPT's native **Ask ChatGPT** floating button.
- Clicking it clicks the native Ask ChatGPT button and waits for you to send the follow-up.
- When the follow-up user turn appears, the extension creates a visual subthread and assigns that user turn plus the next assistant turn to it.
- Main and subthread views are created by hiding or showing existing ChatGPT turn DOM nodes.
- Selected source text becomes a clickable anchor back into child subthreads.
- A compact bottom-right thread tree lets you switch between Main and nested subthreads.
- Native Ask ChatGPT reply-context buttons in subthread user turns jump back to the source thread and source anchor when possible.

## Known limitations

- This is visual threading only. It does not isolate or change the model's actual conversation context.
- It does not intercept network requests, modify OpenAI API payloads, or change ChatGPT's composer state manually.
- Turn assignment is intentionally simple: after **Ask in Thread**, the next submitted user turn creates the subthread, and the next assistant turn is assigned to it.
- Source anchors are best effort. Very complex selections spanning multiple DOM text nodes may not be re-wrapped perfectly after ChatGPT rerenders.
- Selectors are based on the provided `references/` HTML files and may need updates if ChatGPT changes its DOM.
