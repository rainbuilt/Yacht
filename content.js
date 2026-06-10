(() => {
  const MAIN = "main";
  const TURN_SELECTOR = "section[data-turn]";
  const WRAPPER_SELECTOR = "[data-turn-id-container]";
  const BUTTON_ATTR = "data-cgpt-thread-button";
  const HIDDEN = "cgpt-thread-hidden";
  const CLIP = 40;

  let state;
  let storageKey;
  let scanTimer;
  let saveTimer;
  let panel;
  let menu;
  let panelOpen = false;
  let lastPath = location.pathname;
  let lastSelection = null;

  init();

  async function init() {
    await loadState();
    new MutationObserver((mutations) => {
      const onlyExtensionUi = mutations.every((mutation) =>
        asElement(mutation.target)?.closest(".cgpt-thread-panel, .cgpt-thread-menu")
      );
      if (!onlyExtensionUi) scheduleScan();
    }).observe(document.body, { attributes: true, childList: true, subtree: true });
    document.addEventListener("selectionchange", scheduleScan);
    document.addEventListener("mouseup", scheduleScan);
    document.addEventListener("touchend", scheduleScan);
    document.addEventListener("click", onDocumentClick, true);
    document.addEventListener("keydown", onDocumentKeydown, true);
    window.addEventListener("resize", updatePanelBottom);
    setInterval(checkUrl, 700);
    scheduleScan();
  }

  async function checkUrl() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    document.querySelectorAll("." + HIDDEN).forEach((node) => node.classList.remove(HIDDEN));
    closeMenu();
    await loadState();
    scheduleScan();
  }

  async function loadState() {
    const conversationId = getConversationId();
    storageKey = "cgpt-thread-state:" + conversationId;
    const saved = await chrome.storage.local.get(storageKey);
    state = saved[storageKey] || freshState(conversationId);
    if (!state.threads?.[MAIN]) state = freshState(conversationId);
    if (!state.threads[MAIN].childrenThreadIds) state.threads[MAIN].childrenThreadIds = [];
    state.activeThreadId = state.threads[state.activeThreadId] ? state.activeThreadId : MAIN;
  }

  function freshState(id) {
    return {
      conversationId: id,
      activeThreadId: MAIN,
      threads: {
        [MAIN]: {
          id: MAIN,
          title: "Main",
          parentThreadId: null,
          childrenThreadIds: [],
          sourceAnchorId: null,
          turnIds: [],
          status: "active"
        }
      },
      anchors: {},
      turnToThread: {},
      pending: null
    };
  }

  function getConversationId() {
    return location.pathname.match(/^\/c\/([^/?#]+)/)?.[1] || "new";
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 140);
  }

  function scan() {
    if (!state) return;
    const entries = readTurns();
    assignNewTurns(entries);
    repairReloadedReplies(entries);
    applyVisibility(entries);
    applyAnchors(entries);
    ensureAskInThreadButtons();
    renderPanel();
  }

  function readTurns() {
    const sections = [...document.querySelectorAll(TURN_SELECTOR)];
    const turnIds = sections.map((section) => section.getAttribute("data-turn-id")).filter(Boolean);
    const turnIdCounts = turnIds.reduce((map, id) => map.set(id, (map.get(id) || 0) + 1), new Map());

    return sections.map((section, index) => {
      const testId = section.getAttribute("data-testid");
      const turnId = section.getAttribute("data-turn-id");
      const role = section.getAttribute("data-turn") || "";
      const key = testId || turnId || role + ":" + index;
      const aliases = [key];
      if (turnId && testId) aliases.push(turnId + ":" + testId);
      if (turnId && turnIdCounts.get(turnId) === 1) aliases.push(turnId);
      return {
        section,
        wrapper: section.closest(WRAPPER_SELECTOR) || section,
        role,
        key,
        aliases: [...new Set(aliases)]
      };
    });
  }

  function assignNewTurns(entries) {
    let changed = false;
    const knownIndices = entries
      .map((entry, index) => threadFor(entry) ? index : -1)
      .filter((index) => index >= 0);
    const lastKnownIndex = knownIndices.length ? Math.max(...knownIndices) : -1;

    entries.forEach((entry, index) => {
      const existingThreadId = threadFor(entry);
      if (existingThreadId) {
        if (state.turnToThread[entry.key] !== existingThreadId) {
          changed = assignTurn(entry, existingThreadId) || changed;
        }
        return;
      }

      let threadId = MAIN;
      if (state.pending && index > lastKnownIndex) {
        threadId = pendingTarget(entry) || MAIN;
      } else if (!state.pending && state.activeThreadId !== MAIN && index > lastKnownIndex) {
        threadId = state.activeThreadId;
      }

      changed = assignTurn(entry, threadId) || changed;
    });

    if (changed) saveSoon();
  }

  function threadFor(entry) {
    for (const key of entry.aliases || [entry.key]) {
      const threadId = state.turnToThread[key];
      if (threadId && state.threads[threadId]) return threadId;
    }
    return "";
  }

  function repairReloadedReplies(entries) {
    let changed = false;

    entries.forEach((entry, index) => {
      const threadId = threadFor(entry);
      if (!threadId || threadId === MAIN || entry.role !== "user") return;

      const reply = entries[index + 1];
      if (reply?.role !== "assistant") return;

      const assigned = threadFor(reply);
      if (assigned === threadId || (assigned && assigned !== MAIN)) return;

      changed = assignTurn(reply, threadId) || changed;
    });

    if (changed) saveSoon();
  }

  function pendingTarget(entry) {
    const pending = state.pending;
    if (pending.phase === "waiting-user-turn" && entry.role === "user") {
      return createThreadFromPending(entry);
    }

    const thread = pending.threadId && state.threads[pending.threadId];
    if (!thread) {
      state.pending = null;
      return null;
    }

    if (pending.phase === "waiting-assistant-turn" && entry.role === "assistant") {
      state.pending = null;
      thread.status = "active";
      return thread.id;
    }

    return null;
  }

  function createThreadFromPending(entry) {
    const selection = state.pending?.selection;
    if (!selection) {
      state.pending = null;
      return null;
    }

    const anchor = state.anchors[selection.sourceAnchorId] || findOrCreateAnchor(selection);
    const threadId = "t-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    const parentThreadId = state.threads[state.pending.parentThreadId]
      ? state.pending.parentThreadId
      : MAIN;

    state.threads[threadId] = {
      id: threadId,
      title: clip(selection.selectedText),
      parentThreadId,
      childrenThreadIds: [],
      sourceAnchorId: anchor.id,
      turnIds: [],
      status: "active"
    };
    state.threads[parentThreadId].childrenThreadIds.push(threadId);
    anchor.childThreadIds.push(threadId);
    state.pending = { threadId, phase: "waiting-assistant-turn", createdAt: Date.now() };
    state.activeThreadId = threadId;

    const thread = state.threads[threadId];
    thread.title = titleFromUserTurn(entry, thread) || thread.title;
    return threadId;
  }

  function assignTurn(entry, threadId) {
    const oldThreadId = threadFor(entry);
    if (oldThreadId === threadId && state.turnToThread[entry.key] === threadId) return false;
    if (oldThreadId && state.threads[oldThreadId]) {
      const aliases = new Set(entry.aliases || [entry.key]);
      state.threads[oldThreadId].turnIds = state.threads[oldThreadId].turnIds.filter((key) => !aliases.has(key));
    }
    state.turnToThread[entry.key] = threadId;
    (entry.aliases || []).forEach((alias) => {
      if (alias !== entry.key && state.turnToThread[alias] === threadId) delete state.turnToThread[alias];
    });
    const thread = state.threads[threadId];
    if (thread) {
      thread.turnIds = thread.turnIds.filter((key) => !(entry.aliases || []).includes(key));
      thread.turnIds.push(entry.key);
    }
    return true;
  }

  function titleFromUserTurn(entry, thread) {
    const source = normalize(state.anchors[thread.sourceAnchorId]?.selectedText || "");
    let text = normalize(entry.section.querySelector('[data-testid="collapsible-user-message-content"]')?.innerText
      || entry.section.querySelector(".user-message-bubble-color")?.innerText
      || entry.section.innerText);
    text = text.replace(/^You said:\s*/i, "");
    if (source && text.startsWith(source)) text = normalize(text.slice(source.length));
    return clip(text);
  }

  function applyVisibility(entries) {
    entries.forEach((entry) => {
      const threadId = threadFor(entry) || MAIN;
      const visible = state.activeThreadId === MAIN ? threadId === MAIN : threadId === state.activeThreadId;
      entry.wrapper.classList.toggle(HIDDEN, !visible);
    });
  }

  function ensureAskInThreadButtons() {
    [...document.querySelectorAll("button")].forEach((nativeButton) => {
      if (nativeButton.hasAttribute(BUTTON_ATTR)) return;
      if (!buttonLabel(nativeButton).includes("Ask ChatGPT")) return;
      if (!isVisible(nativeButton) || nativeButton.closest(".cgpt-thread-panel")) return;

      const parent = nativeButton.parentElement;
      if (!parent || parent.querySelector("[" + BUTTON_ATTR + "]")) return;

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Ask in Thread";
      button.className = "cgpt-thread-ask";
      button.setAttribute(BUTTON_ATTR, "true");
      button.addEventListener("mousedown", (event) => {
        lastSelection = captureSelection();
        event.preventDefault();
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        startAskInThread(nativeButton, lastSelection || captureSelection());
        lastSelection = null;
      });
      nativeButton.insertAdjacentElement("afterend", button);
    });
  }

  function startAskInThread(nativeButton, selection) {
    if (!selection) return;
    selection.sourceAnchorId = findOrCreateAnchor(selection).id;
    state.pending = {
      phase: "waiting-user-turn",
      parentThreadId: state.activeThreadId || MAIN,
      selection,
      createdAt: Date.now()
    };
    saveSoon();
    nativeButton.click();
    scheduleScan();
    setTimeout(scheduleScan, 60);
    setTimeout(scheduleScan, 400);
  }

  function captureSelection() {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();
    if (!selectedText || !selection.rangeCount) return null;

    const range = selection.getRangeAt(0);
    const source = closestTurn(range.commonAncestorContainer)
      || closestTurn(selection.anchorNode)
      || closestTurn(selection.focusNode);
    if (!source) return null;

    const entry = readTurns().find((turn) => turn.section === source);
    if (!entry) return null;

    return {
      selectedText,
      normalizedSelectedText: normalize(selectedText),
      sourceTurnKey: entry.key,
      sourceThreadId: threadFor(entry) || state.activeThreadId || MAIN,
      occurrenceIndex: occurrenceIndex(source, selectedText, range)
    };
  }

  function closestTurn(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return element?.closest(TURN_SELECTOR) || null;
  }

  function findOrCreateAnchor(selection) {
    const existing = Object.values(state.anchors).find((anchor) =>
      anchor.sourceThreadId === selection.sourceThreadId
      && anchor.sourceTurnKey === selection.sourceTurnKey
      && anchor.normalizedSelectedText === selection.normalizedSelectedText
      && anchor.occurrenceIndex === selection.occurrenceIndex
    );
    if (existing) return existing;

    const id = "a-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    state.anchors[id] = {
      id,
      sourceThreadId: selection.sourceThreadId,
      sourceTurnKey: selection.sourceTurnKey,
      selectedText: selection.selectedText,
      normalizedSelectedText: selection.normalizedSelectedText,
      occurrenceIndex: selection.occurrenceIndex,
      childThreadIds: []
    };
    return state.anchors[id];
  }

  function applyAnchors(entries) {
    const byKey = turnMap(entries);
    Object.values(state.anchors).forEach((anchor) => {
      if (anchor.sourceThreadId !== state.activeThreadId) return;
      const entry = byKey.get(anchor.sourceTurnKey);
      if (entry) wrapAnchor(entry.section, anchor);
    });
  }

  function turnMap(entries) {
    const map = new Map();
    entries.forEach((entry) => (entry.aliases || [entry.key]).forEach((key) => map.set(key, entry)));
    return map;
  }

  function wrapAnchor(section, anchor) {
    if (section.querySelector('[data-cgpt-anchor-id="' + anchor.id + '"]')) return;
    const pieces = findTextPieces(section, anchor.selectedText, anchor.occurrenceIndex);
    if (!pieces.length) return;

    [...pieces].reverse().forEach((piece) => wrapTextPiece(piece, anchor));
  }

  function textNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest(".cgpt-thread-anchor, script, style, textarea")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    return nodes;
  }

  function findTextPieces(root, text, wantedIndex) {
    const nodes = textNodes(root);
    const fullText = nodes.map((node) => node.nodeValue).join("");
    const start = nthIndexOf(fullText, text, wantedIndex) ?? fullText.indexOf(text);
    if (start < 0) return normalizedTextPieces(nodes, text, wantedIndex);

    const end = start + text.length;
    let offset = 0;
    const pieces = [];
    nodes.forEach((node) => {
      const next = offset + node.nodeValue.length;
      const from = Math.max(start, offset);
      const to = Math.min(end, next);
      if (from < to) pieces.push({ node, index: from - offset, length: to - from });
      offset = next;
    });
    return pieces;
  }

  function normalizedTextPieces(nodes, text, wantedIndex) {
    const normalized = normalizedTextMap(nodes);
    const needle = normalize(text);
    const start = nthIndexOf(normalized.text, needle, wantedIndex) ?? normalized.text.indexOf(needle);
    if (start < 0) return [];

    const selected = normalized.map.slice(start, start + needle.length);
    const pieces = [];
    selected.forEach((item) => {
      const last = pieces[pieces.length - 1];
      if (last?.node === item.node && last.index + last.length === item.index) {
        last.length += 1;
      } else {
        pieces.push({ node: item.node, index: item.index, length: 1 });
      }
    });
    return pieces;
  }

  function normalizedTextMap(nodes) {
    let text = "";
    const map = [];
    let lastWasSpace = true;

    nodes.forEach((node) => {
      for (let index = 0; index < node.nodeValue.length; index += 1) {
        const char = node.nodeValue[index];
        if (/\s/.test(char)) {
          if (!lastWasSpace) {
            text += " ";
            map.push({ node, index });
            lastWasSpace = true;
          }
          return;
        }
        text += char;
        map.push({ node, index });
        lastWasSpace = false;
      }
    });

    if (text.endsWith(" ")) {
      text = text.slice(0, -1);
      map.pop();
    }
    return { text, map };
  }

  function nthIndexOf(text, needle, wantedIndex) {
    let seen = 0;
    let from = 0;
    while (needle) {
      const index = text.indexOf(needle, from);
      if (index < 0) return null;
      if (seen === wantedIndex) return index;
      seen += 1;
      from = index + needle.length;
    }
    return null;
  }

  function wrapTextPiece({ node, index, length }, anchor) {
    const text = node.nodeValue;
    const span = document.createElement("span");
    span.className = "cgpt-thread-anchor";
    span.dataset.cgptAnchorId = anchor.id;
    span.role = "button";
    span.tabIndex = 0;
    span.title = anchor.childThreadIds.length === 1 ? "Open thread" : "Open thread menu";
    span.textContent = text.slice(index, index + length);

    const fragment = document.createDocumentFragment();
    if (index) fragment.append(text.slice(0, index));
    fragment.append(span);
    if (index + length < text.length) fragment.append(text.slice(index + length));
    node.replaceWith(fragment);
  }

  function occurrenceIndex(root, text, range) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const limit = node === range.startContainer ? range.startOffset : node.nodeValue.length;
      let from = 0;
      let index = node.nodeValue.indexOf(text, from);
      while (index >= 0 && index < limit) {
        seen += 1;
        from = index + text.length;
        index = node.nodeValue.indexOf(text, from);
      }
      if (node === range.startContainer) return seen;
    }
    return 0;
  }

  function onDocumentClick(event) {
    const target = asElement(event.target);
    const anchorElement = target?.closest(".cgpt-thread-anchor");
    if (anchorElement) {
      event.preventDefault();
      event.stopPropagation();
      openAnchor(anchorElement);
      return;
    }

    if (menu && !target?.closest(".cgpt-thread-menu")) closeMenu();
    const button = target?.closest("button");
    if (button) maybeHandleNativeContextButton(event, button);
  }

  function onDocumentKeydown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const anchorElement = asElement(event.target)?.closest(".cgpt-thread-anchor");
    if (!anchorElement) return;
    event.preventDefault();
    openAnchor(anchorElement);
  }

  function openAnchor(anchorElement) {
    const anchor = state.anchors[anchorElement.dataset.cgptAnchorId];
    if (!anchor) return;
    if (!anchor.childThreadIds.length) return;
    if (anchor.childThreadIds.length === 1) {
      activateThread(anchor.childThreadIds[0]);
      return;
    }
    showAnchorMenu(anchorElement, anchor);
  }

  function showAnchorMenu(anchorElement, anchor) {
    closeMenu();
    menu = document.createElement("div");
    menu.className = "cgpt-thread-menu";
    anchor.childThreadIds.forEach((threadId) => {
      const thread = state.threads[threadId];
      if (!thread) return;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = thread.title;
      button.addEventListener("click", () => activateThread(threadId));
      menu.append(button);
    });
    document.body.append(menu);

    const rect = anchorElement.getBoundingClientRect();
    const width = menu.offsetWidth || 240;
    let left = Math.min(rect.left, window.innerWidth - width - 12);
    let top = rect.bottom + 6;
    if (top + menu.offsetHeight > window.innerHeight) top = rect.top - menu.offsetHeight - 6;
    menu.style.left = Math.max(12, left) + "px";
    menu.style.top = Math.max(12, top) + "px";
  }

  function closeMenu() {
    menu?.remove();
    menu = null;
  }

  function maybeHandleNativeContextButton(event, button) {
    if (button.hasAttribute(BUTTON_ATTR)) return;
    const section = button.closest(TURN_SELECTOR);
    if (!section?.matches('[data-turn="user"]')) return;

    const entry = readTurns().find((turn) => turn.section === section);
    const threadId = entry && threadFor(entry);
    const thread = threadId && state.threads[threadId];
    const anchor = thread?.sourceAnchorId && state.anchors[thread.sourceAnchorId];
    if (!thread || thread.id === MAIN || !anchor || !isNativeContextButton(button, anchor)) return;

    event.preventDefault();
    event.stopPropagation();
    activateThread(thread.parentThreadId || MAIN, anchor.id);
  }

  function isNativeContextButton(button, anchor) {
    const label = (button.getAttribute("aria-label") || "").toLowerCase();
    if (label.includes("replied content")) return true;
    if (label === "remove" || label.includes("message actions")) return false;

    const buttonText = comparableText(button.innerText);
    const sourceText = comparableText(anchor.selectedText);
    if (!buttonText || !sourceText) return false;
    if (sourceText.includes(buttonText) || buttonText.includes(sourceText.slice(0, 30))) return true;

    const tokens = buttonText.split(/\s+/).filter((token) => token.length > 1);
    return button.querySelector(".line-clamp-3") && tokens.some((token) => sourceText.includes(token));
  }

  function comparableText(text) {
    return normalize(text)
      .replace(/[“”"']/g, "")
      .replace(/[*_`~]/g, "")
      .trim();
  }

  function activateThread(threadId, anchorIdToScroll) {
    if (!state.threads[threadId]) return;
    state.activeThreadId = threadId;
    closeMenu();
    saveSoon();
    scan();
    if (anchorIdToScroll) setTimeout(() => scrollToAnchor(anchorIdToScroll), 80);
  }

  function scrollToAnchor(anchorId) {
    const anchorElement = document.querySelector('[data-cgpt-anchor-id="' + anchorId + '"]');
    if (anchorElement) {
      anchorElement.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }

    const anchor = state.anchors[anchorId];
    const entries = readTurns();
    const entry = anchor && turnMap(entries).get(anchor.sourceTurnKey);
    entry?.wrapper.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function renderPanel() {
    panel ||= createPanel();
    updatePanelBottom();

    const hasThreads = state.threads[MAIN].childrenThreadIds.length > 0;
    panel.hidden = !hasThreads && state.activeThreadId === MAIN;
    if (panel.hidden) return;

    const active = state.threads[state.activeThreadId] || state.threads[MAIN];
    panel.classList.toggle("is-open", panelOpen);
    panel.replaceChildren();

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "cgpt-thread-toggle";
    toggle.textContent = (panelOpen ? "Hide" : "Thread") + ": " + active.title;
    toggle.addEventListener("click", () => {
      panelOpen = !panelOpen;
      renderPanel();
    });
    panel.append(toggle);

    const tree = document.createElement("div");
    tree.className = "cgpt-thread-tree";
    renderThreadRow(tree, MAIN, 0);
    panel.append(tree);
  }

  function createPanel() {
    const element = document.createElement("div");
    element.className = "cgpt-thread-panel";
    document.body.append(element);
    return element;
  }

  function renderThreadRow(root, threadId, depth) {
    const thread = state.threads[threadId];
    if (!thread) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "cgpt-thread-row" + (threadId === state.activeThreadId ? " is-active" : "");
    button.style.paddingLeft = 8 + depth * 14 + "px";
    button.dataset.threadId = threadId;
    button.addEventListener("click", () => activateThread(threadId));

    const title = document.createElement("span");
    title.className = "cgpt-thread-title";
    title.textContent = thread.title;
    button.append(title);
    root.append(button);

    thread.childrenThreadIds.forEach((childId) => renderThreadRow(root, childId, depth + 1));
  }

  function updatePanelBottom() {
    if (!panel) return;
    const composer = document.querySelector("#thread-bottom-container");
    if (!composer) {
      panel.style.setProperty("--cgpt-thread-panel-bottom", "16px");
      return;
    }
    const bottom = Math.max(16, window.innerHeight - composer.getBoundingClientRect().top + 12);
    panel.style.setProperty("--cgpt-thread-panel-bottom", bottom + "px");
  }

  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => chrome.storage.local.set({ [storageKey]: state }), 180);
  }

  function normalize(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function clip(text) {
    const clean = normalize(text);
    return clean.length > CLIP ? clean.slice(0, CLIP - 3) + "..." : clean || "Thread";
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function buttonLabel(button) {
    return [
      button.textContent,
      button.getAttribute("aria-label"),
      button.getAttribute("title")
    ].filter(Boolean).join(" ");
  }

  function asElement(target) {
    return target instanceof Element ? target : target?.parentElement || null;
  }
})();
