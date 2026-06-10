(() => {
  const MAIN = "main";
  const TURN_SELECTOR = "section[data-turn]";
  const WRAPPER_SELECTOR = "[data-turn-id-container]";
  const BUTTON_ATTR = "data-cgpt-thread-hooked";
  const HIDDEN = "cgpt-thread-hidden";
  const CLIP = 40;
  const PENDING_USER_TURN_TIMEOUT = 10 * 60 * 1000;

  let state;
  let storageKey;
  let scanTimer;
  let saveTimer;
  let panel;
  let menu;
  let enabled = true;
  let anchorColor = "#2f7df6";
  let panelOpen = false;
  let lastPath = location.pathname;
  let lastSelection = null;
  let forwardingAskClick = false;
  let anchorPointer = null;

  init();

  async function init() {
    await loadSettings();
    await loadState();
    chrome.runtime.onMessage.addListener(handleMessage);
    new MutationObserver((mutations) => {
      const onlyExtensionUi = mutations.every((mutation) =>
        asElement(mutation.target)?.closest(".cgpt-thread-panel, .cgpt-thread-menu")
      );
      if (!onlyExtensionUi) scheduleScan();
    }).observe(document.body, { attributes: true, childList: true, subtree: true });
    ["selectionchange", "mouseup", "touchend"].forEach((type) => document.addEventListener(type, scheduleScan));
    [
      ["pointerdown", onPointerDown],
      ["pointermove", onPointerMove],
      ["pointerup", onPointerUp],
      ["click", onDocumentClick],
      ["keydown", onDocumentKeydown]
    ].forEach(([type, handler]) => document.addEventListener(type, handler, true));
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

  async function loadSettings() {
    const saved = await chrome.storage.local.get(["cgpt-thread-enabled", "cgpt-thread-anchor-color"]);
    enabled = saved["cgpt-thread-enabled"] !== false;
    anchorColor = validColor(saved["cgpt-thread-anchor-color"]) || anchorColor;
    document.documentElement.classList.toggle("cgpt-thread-disabled", !enabled);
    applyAnchorColor();
  }

  function handleMessage(message, _sender, sendResponse) {
    (async () => {
      if (message?.type === "getStatus") return statusForPopup();
      if (message?.type === "setEnabled") return setEnabledForPopup(message.enabled);
      if (message?.type === "setPanelOpen") return setPanelOpenForPopup(message.open);
      if (message?.type === "setAnchorColor") return setAnchorColorForPopup(message.color);
      if (message?.type === "resetConversation") return resetConversationForPopup();
      return null;
    })().then(sendResponse);
    return true;
  }

  async function setEnabledForPopup(value) {
    enabled = !!value;
    await chrome.storage.local.set({ "cgpt-thread-enabled": enabled });
    document.documentElement.classList.toggle("cgpt-thread-disabled", !enabled);
    if (enabled) {
      scheduleScan();
    } else {
      cleanupDisabledUi();
    }
    return statusForPopup();
  }

  function setPanelOpenForPopup(open) {
    panelOpen = !!open;
    renderPanel();
    return statusForPopup();
  }

  async function setAnchorColorForPopup(color) {
    const nextColor = validColor(color);
    if (!nextColor) return statusForPopup();
    anchorColor = nextColor;
    applyAnchorColor();
    await chrome.storage.local.set({ "cgpt-thread-anchor-color": anchorColor });
    return statusForPopup();
  }

  async function resetConversationForPopup() {
    cleanupDisabledUi();
    unwrapAllAnchors();
    state = freshState(getConversationId());
    await chrome.storage.local.remove(storageKey);
    await chrome.storage.local.set({ [storageKey]: state });
    scheduleScan();
    return statusForPopup();
  }

  function statusForPopup() {
    return {
      enabled,
      conversationId: state?.conversationId || getConversationId(),
      activeThreadId: state?.activeThreadId || MAIN,
      activeThreadTitle: state?.threads?.[state.activeThreadId]?.title || "Main",
      threadCount: Math.max(0, Object.keys(state?.threads || {}).length - 1),
      anchorCount: Object.keys(state?.anchors || {}).length,
      panelOpen: enabled && panelOpen && panelHasContent(),
      anchorColor
    };
  }

  function cleanupDisabledUi() {
    document.querySelectorAll("." + HIDDEN).forEach((node) => node.classList.remove(HIDDEN));
    closeMenu();
    if (panel) {
      panel.classList.remove("is-open", "is-visible");
      panel.hidden = true;
    }
  }

  function unwrapAllAnchors() {
    document.querySelectorAll(".cgpt-thread-anchor").forEach(unwrapAnchorElement);
  }

  function applyAnchorColor() {
    document.documentElement.style.setProperty("--cgpt-thread-anchor-color", anchorColor);
  }

  function freshState(id) {
    return {
      conversationId: id,
      activeThreadId: MAIN,
      threads: {
        [MAIN]: newThread(MAIN, "Main", null, null)
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
    if (!enabled) {
      cleanupDisabledUi();
      return;
    }
    const entries = readTurns();
    assignNewTurns(entries);
    repairReloadedReplies(entries);
    applyVisibility(entries);
    applyAnchors(entries);
    hookAskChatGptButtons();
    syncPendingAskContext();
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
      const uniqueTurnId = turnId && turnIdCounts.get(turnId) === 1 ? turnId : "";
      const key = uniqueTurnId || testId || role + ":" + index;
      const aliases = [key, testId, turnId && testId && turnId + ":" + testId, uniqueTurnId];
      return {
        section,
        wrapper: section.closest(WRAPPER_SELECTOR) || section,
        role,
        key,
        aliases: [...new Set(aliases.filter(Boolean))]
      };
    });
  }

  function assignNewTurns(entries) {
    let changed = false;
    const lastKnownIndex = entries.reduce((last, entry, index) => threadFor(entry) ? index : last, -1);
    const pendingKnownTurnKeys = state.pending?.knownTurnKeys || [];
    const pendingParentThreadId = state.pending?.parentThreadId || MAIN;

    entries.forEach((entry, index) => {
      const knownForPending = pendingKnownTurnKeys.includes(entry.key);
      const newForPending = pendingKnownTurnKeys.length ? !knownForPending : index > lastKnownIndex;
      const pendingThreadId = state.pending && newForPending && pendingTarget(entry);
      if (pendingThreadId) {
        changed = assignTurn(entry, pendingThreadId) || changed;
        return;
      }

      const existingThreadId = threadFor(entry);
      if (existingThreadId) {
        changed = (state.turnToThread[entry.key] !== existingThreadId && assignTurn(entry, existingThreadId)) || changed;
        return;
      }

      let threadId = MAIN;
      if (knownForPending && state.threads[pendingParentThreadId]) {
        threadId = pendingParentThreadId;
      } else if (index > lastKnownIndex) {
        threadId = state.activeThreadId;
      }
      changed = assignTurn(entry, threadId) || changed;
    });

    if (changed) saveSoon();
  }

  function threadFor(entry) {
    for (const key of aliasesOf(entry)) {
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
    const parentThreadId = state.threads[state.pending.parentThreadId] ? state.pending.parentThreadId : MAIN;

    state.threads[threadId] = newThread(threadId, "", parentThreadId, anchor.id);
    state.threads[parentThreadId].childrenThreadIds.push(threadId);
    anchor.childThreadIds.push(threadId);
    state.pending = {
      threadId,
      phase: "waiting-assistant-turn",
      parentThreadId,
      knownTurnKeys: [...new Set([...(state.pending.knownTurnKeys || []), entry.key])]
    };
    state.activeThreadId = threadId;

    state.threads[threadId].title = titleFromUserTurn(entry, state.threads[threadId]);
    return threadId;
  }

  function assignTurn(entry, threadId) {
    const oldThreadId = threadFor(entry);
    const aliases = aliasesOf(entry);
    if (oldThreadId === threadId && state.turnToThread[entry.key] === threadId) return false;
    if (oldThreadId && state.threads[oldThreadId]) {
      state.threads[oldThreadId].turnIds = state.threads[oldThreadId].turnIds.filter((key) => !aliases.includes(key));
    }
    state.turnToThread[entry.key] = threadId;
    aliases.forEach((alias) => {
      if (alias !== entry.key && state.turnToThread[alias] === threadId) delete state.turnToThread[alias];
    });
    const thread = state.threads[threadId];
    if (thread) {
      thread.turnIds = thread.turnIds.filter((key) => !aliases.includes(key));
      thread.turnIds.push(entry.key);
    }
    return true;
  }

  function newThread(id, title, parentThreadId, sourceAnchorId) {
    return { id, title, parentThreadId, childrenThreadIds: [], sourceAnchorId, turnIds: [] };
  }

  function titleFromUserTurn(entry, thread) {
    const rawSource = normalize(state.anchors[thread.sourceAnchorId]?.selectedText || "");
    const source = clip(rawSource, 24);
    let question = userTurnText(entry);
    if (rawSource && question.startsWith(rawSource)) question = normalize(question.slice(rawSource.length));
    return "[" + source + "] " + clip(question, 36);
  }

  function userTurnText(entry) {
    return normalize(entry.section.querySelector('[data-testid="collapsible-user-message-content"]')?.innerText
      || entry.section.querySelector(".user-message-bubble-color")?.innerText
      || entry.section.innerText).replace(/^You said:\s*/i, "");
  }

  function applyVisibility(entries) {
    entries.forEach((entry) => {
      const threadId = threadFor(entry) || MAIN;
      const visible = state.activeThreadId === MAIN ? threadId === MAIN : threadId === state.activeThreadId;
      entry.wrapper.classList.toggle(HIDDEN, !visible);
    });
  }

  function hookAskChatGptButtons() {
    [...document.querySelectorAll("button")].forEach((nativeButton) => {
      if (nativeButton.hasAttribute(BUTTON_ATTR)) return;
      if (!buttonLabel(nativeButton).includes("Ask ChatGPT")) return;
      if (!isVisible(nativeButton) || nativeButton.closest(".cgpt-thread-panel")) return;

      nativeButton.setAttribute(BUTTON_ATTR, "true");
      nativeButton.addEventListener("mousedown", () => {
        if (!enabled) return;
        lastSelection = captureSelection();
      });
      nativeButton.addEventListener("click", (event) => {
        if (!enabled) return;
        if (forwardingAskClick) return;
        stopEvent(event);
        startAskInThread(nativeButton, lastSelection || captureSelection());
        lastSelection = null;
      }, true);
    });
  }

  function startAskInThread(nativeButton, selection) {
    let anchor = null;
    if (selection) {
      anchor = findOrCreateAnchor(selection);
      state.pending = {
        phase: "waiting-user-turn",
        createdAt: Date.now(),
        contextSeen: false,
        parentThreadId: state.activeThreadId,
        knownTurnKeys: snapshotTurnKeys(readTurns()),
        selection: {
          selectedText: selection.selectedText,
          normalizedSelectedText: selection.normalizedSelectedText,
          sourceTurnKey: selection.sourceTurnKey,
          sourceThreadId: selection.sourceThreadId,
          occurrenceIndex: selection.occurrenceIndex,
          sourceAnchorId: anchor.id
        }
      };
      saveSoon();
    }
    forwardingAskClick = true;
    nativeButton.click();
    forwardingAskClick = false;
    if (anchor && selection.range) setTimeout(() => wrapLiveRange(selection.range, anchor), 0);
    [0, 60, 400].forEach((delay) => setTimeout(scheduleScan, delay));
  }

  function snapshotTurnKeys(entries) {
    return [...new Set(entries.map((entry) => entry.key))];
  }

  function syncPendingAskContext() {
    const pending = state.pending;
    if (pending?.phase !== "waiting-user-turn") return;

    if (pendingAskContextVisible(pending)) {
      if (!pending.contextSeen) {
        pending.contextSeen = true;
        saveSoon();
      }
      return;
    }

    // Sending a native Ask follow-up can hide the context before the new user turn appears.
    const age = Date.now() - (pending.createdAt || 0);
    if (age > PENDING_USER_TURN_TIMEOUT) {
      cancelPendingAsk();
    }
  }

  function pendingAskContextVisible(pending) {
    const root = document.querySelector("#thread-bottom-container");
    return !!root && fuzzyTextMatch(comparableText(root.innerText), comparableText(pending.selection?.selectedText || ""), 3, 2);
  }

  function cancelPendingAsk() {
    const anchorId = state.pending?.selection?.sourceAnchorId;
    state.pending = null;
    removeUnusedAnchor(anchorId);
    saveSoon();
  }

  function removeUnusedAnchor(anchorId) {
    const anchor = anchorId && state.anchors[anchorId];
    if (!anchor || anchor.childThreadIds.length) return;
    document.querySelectorAll('[data-cgpt-anchor-id="' + anchorId + '"]').forEach(unwrapAnchorElement);
    delete state.anchors[anchorId];
  }

  function unwrapAnchorElement(element) {
    const parent = element.parentNode;
    if (!parent) return;
    while (element.firstChild) parent.insertBefore(element.firstChild, element);
    element.remove();
    parent.normalize();
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
      occurrenceIndex: occurrenceIndex(source, selectedText, range),
      range: range.cloneRange()
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
    entries.forEach((entry) => aliasesOf(entry).forEach((key) => map.set(key, entry)));
    return map;
  }

  function wrapAnchor(section, anchor) {
    if (section.querySelector('[data-cgpt-anchor-id="' + anchor.id + '"]')) return;
    const pieces = findTextPieces(section, anchor.selectedText, anchor.occurrenceIndex);
    if (!pieces.length) return;

    [...pieces].reverse().forEach((piece) => wrapTextPiece(piece, anchor));
  }

  function wrapLiveRange(range, anchor) {
    const section = range && (
      closestTurn(range.commonAncestorContainer)
      || closestTurn(range.startContainer)
      || closestTurn(range.endContainer)
    );
    if (!section || section.querySelector('[data-cgpt-anchor-id="' + anchor.id + '"]')) return;

    const pieces = textNodes(section)
      .filter((node) => range.intersectsNode(node))
      .map((node) => ({
        node,
        index: node === range.startContainer ? range.startOffset : 0,
        length: (node === range.endContainer ? range.endOffset : node.nodeValue.length)
          - (node === range.startContainer ? range.startOffset : 0)
      }))
      .filter((piece) => piece.length > 0);

    [...pieces].reverse().forEach((piece) => wrapTextPiece(piece, anchor));
  }

  function textNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest("script, style, textarea")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    return nodes;
  }

  function findTextPieces(root, text, wantedIndex) {
    const nodes = textNodes(root);
    return piecesFromIndex(textIndex(nodes), text, wantedIndex)
      || piecesFromIndex(textIndex(nodes, true), normalize(text), wantedIndex)
      || [];
  }

  function textIndex(nodes, collapseSpaces = false) {
    let text = "";
    const map = [];
    let lastWasSpace = true;

    const add = (node, index, char) => {
      text += char;
      map.push({ node, index });
    };

    nodes.forEach((node) => {
      for (let index = 0; index < node.nodeValue.length; index += 1) {
        const char = node.nodeValue[index];
        if (collapseSpaces && /\s/.test(char)) {
          if (!lastWasSpace) {
            add(node, index, " ");
            lastWasSpace = true;
          }
          continue;
        }
        add(node, index, char);
        lastWasSpace = false;
      }
    });

    if (collapseSpaces && text.endsWith(" ")) {
      text = text.slice(0, -1);
      map.pop();
    }
    return { text, map };
  }

  function piecesFromIndex(index, needle, wantedIndex) {
    const start = nthIndexOf(index.text, needle, wantedIndex) ?? index.text.indexOf(needle);
    if (start < 0) return null;

    return index.map.slice(start, start + needle.length).reduce((pieces, item) => {
      const last = pieces[pieces.length - 1];
      if (last?.node === item.node && last.index + last.length === item.index) {
        last.length += 1;
      } else {
        pieces.push({ node: item.node, index: item.index, length: 1 });
      }
      return pieces;
    }, []);
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
    const span = element("span", "cgpt-thread-anchor", text.slice(index, index + length));
    span.dataset.cgptAnchorId = anchor.id;
    span.role = "button";
    span.tabIndex = 0;
    span.title = anchor.childThreadIds.length === 1 ? "Open thread" : "Open thread menu";

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
    if (!enabled) return;
    const target = asElement(event.target);
    const clickedPanel = target?.closest(".cgpt-thread-panel");
    const clickedMenu = target?.closest(".cgpt-thread-menu");
    const button = target?.closest("button");

    if (button) maybeCancelPendingAskReferenceRemove(button);

    const anchorElement = target?.closest(".cgpt-thread-anchor");
    if (anchorElement) {
      if (anchorPointer?.suppressClick || window.getSelection()?.toString().trim()) {
        anchorPointer = null;
        stopEvent(event);
        return;
      }
      stopEvent(event);
      openAnchorStack(anchorElement);
      return;
    }

    if (panelOpen && !clickedPanel && !clickedMenu) closePanelTree();
    if (menu && !target?.closest(".cgpt-thread-menu")) closeMenu();
    if (button) maybeHandleNativeContextButton(event, button);
  }

  function onPointerDown(event) {
    if (!enabled) return;
    const anchor = asElement(event.target)?.closest(".cgpt-thread-anchor");
    anchorPointer = anchor ? { x: event.clientX, y: event.clientY, moved: false } : null;
  }

  function onPointerMove(event) {
    if (!enabled) return;
    if (!anchorPointer) return;
    if (Math.abs(event.clientX - anchorPointer.x) > 3 || Math.abs(event.clientY - anchorPointer.y) > 3) {
      anchorPointer.moved = true;
    }
  }

  function onPointerUp() {
    if (!enabled) return;
    if (!anchorPointer) return;
    anchorPointer.suppressClick = anchorPointer.moved || !!window.getSelection()?.toString().trim();
  }

  function onDocumentKeydown(event) {
    if (!enabled) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    const anchorElement = asElement(event.target)?.closest(".cgpt-thread-anchor");
    if (!anchorElement) return;
    stopEvent(event);
    openAnchorStack(anchorElement);
  }

  function openAnchorStack(anchorElement) {
    const uniqueThreadIds = [...new Set(anchorStack(anchorElement).flatMap((anchor) => anchor.childThreadIds))]
      .filter((threadId) => state.threads[threadId]);
    if (!uniqueThreadIds.length) return;
    if (uniqueThreadIds.length === 1) {
      activateThread(uniqueThreadIds[0]);
      return;
    }
    showThreadMenu(anchorElement, uniqueThreadIds);
  }

  function anchorStack(anchorElement) {
    const anchors = [];
    for (let node = anchorElement; node; node = node.parentElement) {
      if (node.classList?.contains("cgpt-thread-anchor")) {
        const anchor = state.anchors[node.dataset.cgptAnchorId];
        if (anchor?.childThreadIds.length) anchors.push(anchor);
      }
      if (node.matches?.(TURN_SELECTOR)) break;
    }
    return anchors;
  }

  function showThreadMenu(anchorElement, threadIds) {
    closeMenu();
    menu = element("div", "cgpt-thread-menu");
    threadIds.forEach((threadId) => {
      const thread = state.threads[threadId];
      if (thread) menu.append(button("", () => activateThread(threadId), thread.title));
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

    stopEvent(event);
    activateThread(thread.parentThreadId || MAIN, anchor.id);
  }

  function maybeCancelPendingAskReferenceRemove(button) {
    const pending = state.pending;
    if (pending?.phase !== "waiting-user-turn") return;
    if (!button.closest("#thread-bottom-container")) return;

    const label = buttonLabel(button).toLowerCase();
    if (!/\bremove\b|삭제|제거/.test(label)) return;
    if (!buttonBelongsToPendingContext(button, pending)) return;

    cancelPendingAsk();
  }

  function buttonBelongsToPendingContext(button, pending) {
    const root = button.closest("#thread-bottom-container");
    const sourceText = comparableText(pending.selection?.selectedText || "");
    for (let node = button.parentElement; node && node !== root; node = node.parentElement) {
      if (fuzzyTextMatch(comparableText(node.innerText), sourceText, 3, 2)) return true;
    }
    return false;
  }

  function isNativeContextButton(button, anchor) {
    const label = (button.getAttribute("aria-label") || "").toLowerCase();
    if (label.includes("replied content")) return true;
    if (label === "remove" || label.includes("message actions")) return false;

    const buttonText = comparableText(button.innerText);
    const sourceText = comparableText(anchor.selectedText);
    if (fuzzyTextMatch(sourceText, buttonText, 2, 1) || fuzzyTextMatch(buttonText, sourceText, 2, 1)) return true;
    return !!button.querySelector(".line-clamp-3") && sharedTokenCount(sourceText, buttonText, 2) > 0;
  }

  function fuzzyTextMatch(haystack, needle, minTokenLength, minTokenHits) {
    if (!haystack || !needle) return false;
    if (haystack.includes(needle)) return true;
    const head = needle.slice(0, 30);
    if (head.length >= 8 && haystack.includes(head)) return true;
    return sharedTokenCount(haystack, needle, minTokenLength) >= minTokenHits;
  }

  function sharedTokenCount(haystack, needle, minLength) {
    return needle.split(/\s+/).filter((token) => token.length >= minLength && haystack.includes(token)).length;
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
    const anchor = state.anchors[anchorId];
    const entry = anchor && turnMap(readTurns()).get(anchor.sourceTurnKey);
    scrollTo(anchorElement || entry?.wrapper);
  }

  function renderPanel() {
    if (!enabled) {
      cleanupDisabledUi();
      return;
    }
    panel ||= createPanel();

    if (!panelHasContent()) {
      closePanelTree();
      setTimeout(() => {
        if (panelHasContent()) return;
        panel.classList.remove("is-visible");
        setTimeout(() => {
          if (!panelHasContent()) panel.hidden = true;
        }, 340);
      }, 380);
      return;
    }

    if (panel.hidden) {
      panel.hidden = false;
      requestAnimationFrame(() => panel.classList.add("is-visible"));
    } else {
      panel.classList.add("is-visible");
    }
    updatePanelBottom();

    panel.classList.toggle("is-open", panelOpen);
    updatePanelToggleLabel();

    const tree = panel.querySelector(".cgpt-thread-tree");
    tree.replaceChildren();
    renderMainTree(tree);
  }

  function panelHasContent() {
    return state.threads[MAIN].childrenThreadIds.length > 0 || state.activeThreadId !== MAIN;
  }

  function createPanel() {
    const panelElement = element("div", "cgpt-thread-panel");
    panelElement.hidden = true;
    const toggle = button("cgpt-thread-toggle", () => {
      panelOpen = !panelOpen;
      if (panelOpen) {
        renderPanel();
      } else {
        closePanelTree();
      }
    });

    panelElement.append(toggle, element("div", "cgpt-thread-tree"));
    document.body.append(panelElement);
    return panelElement;
  }

  function closePanelTree() {
    panelOpen = false;
    panel?.classList.remove("is-open");
    updatePanelToggleLabel();
  }

  function updatePanelToggleLabel() {
    const toggle = panel?.querySelector(".cgpt-thread-toggle");
    if (!toggle) return;
    const active = state.threads[state.activeThreadId] || state.threads[MAIN];
    const toggleLabel = element("span", "cgpt-thread-toggle-label", panelOpen ? "Hide" : "Thread");
    toggle.replaceChildren(toggleLabel, threadTitleElement(active));
  }

  function renderMainTree(root) {
    renderThreadRow(root, MAIN, 0);

    const entries = readTurns();
    const entryByKey = turnMap(entries);
    const mainEntries = entries.filter((entry) => (threadFor(entry) || MAIN) === MAIN);
    mainEntries.forEach((entry, index) => {
      if (entry.role !== "assistant") return;
      renderAnswerRow(root, entry, previousUserTitle(mainEntries, index), 1);
      sourceChildThreads(MAIN, entry).forEach((threadId) => renderThreadRow(root, threadId, 2));
    });

    threadsWithoutVisibleSource(MAIN, entryByKey).forEach((threadId) => renderThreadRow(root, threadId, 1));
  }

  function renderAnswerRow(root, entry, title, depth) {
    root.append(row("cgpt-thread-row cgpt-thread-answer", depth, () => {
      activateThread(MAIN);
      setTimeout(() => scrollTo(entry.wrapper), 80);
    }, element("span", "cgpt-thread-title", title)));
  }

  function previousUserTitle(entries, assistantIndex) {
    for (let index = assistantIndex - 1; index >= 0; index -= 1) {
      if (entries[index].role === "user") return clip(userTurnText(entries[index]), 44);
    }
    return "Answer";
  }

  function sourceChildThreads(sourceThreadId, entry) {
    const sourceKeys = new Set(aliasesOf(entry));
    return [...new Set(Object.values(state.anchors)
      .filter((anchor) => anchor.sourceThreadId === sourceThreadId && sourceKeys.has(anchor.sourceTurnKey))
      .flatMap((anchor) => anchor.childThreadIds)
      .filter((threadId) => state.threads[threadId]))];
  }

  function threadsWithoutVisibleSource(sourceThreadId, entryByKey) {
    return state.threads[sourceThreadId].childrenThreadIds.filter((threadId) => {
      const anchor = state.anchors[state.threads[threadId]?.sourceAnchorId];
      return !anchor || !entryByKey.get(anchor.sourceTurnKey);
    });
  }

  function renderThreadRow(root, threadId, depth) {
    const thread = state.threads[threadId];
    if (!thread) return;

    root.append(row(
      "cgpt-thread-row" + (threadId === state.activeThreadId ? " is-active" : ""),
      depth,
      () => activateThread(threadId),
      threadTitleElement(thread)
    ));

    if (threadId !== MAIN) thread.childrenThreadIds.forEach((childId) => renderThreadRow(root, childId, depth + 1));
  }

  function threadTitleElement(thread) {
    const match = thread.id !== MAIN && thread.title.match(/^\[([^\]]+)]\s*(.*)$/);
    if (!match) {
      return element("span", "cgpt-thread-title", thread.title);
    }

    const title = element("span", "cgpt-thread-title cgpt-thread-title-two-line");
    const source = element("span", "cgpt-thread-source", "[" + match[1] + "]");
    const question = element("span", "cgpt-thread-question", match[2] || "Thread");
    title.append(source, question);
    return title;
  }

  function row(className, depth, onClick, child) {
    const item = button(className, onClick);
    item.style.paddingLeft = 8 + depth * 14 + "px";
    item.append(child);
    return item;
  }

  function button(className, onClick, text) {
    const item = element("button", className, text);
    item.type = "button";
    item.addEventListener("click", onClick);
    return item;
  }

  function element(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text != null) item.textContent = text;
    return item;
  }

  function updatePanelBottom() {
    if (!panel) return;
    const composer = document.querySelector("#thread-bottom-container");
    const bottom = composer ? Math.max(16, window.innerHeight - composer.getBoundingClientRect().top + 12) + "px" : "16px";
    panel.style.setProperty("--cgpt-thread-panel-bottom", bottom);
  }

  function scrollTo(node) {
    node?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function stopEvent(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => chrome.storage.local.set({ [storageKey]: state }), 180);
  }

  function normalize(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function clip(text, limit = CLIP) {
    const clean = normalize(text);
    return clean.length > limit ? clean.slice(0, limit - 3) + "..." : clean || "Thread";
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function buttonLabel(button) {
    return [button.textContent, button.getAttribute("aria-label"), button.getAttribute("title")].filter(Boolean).join(" ");
  }

  function validColor(color) {
    return /^#[0-9a-f]{6}$/i.test(color || "") ? color.toLowerCase() : "";
  }

  function asElement(target) {
    return target instanceof Element ? target : target?.parentElement || null;
  }

  function aliasesOf(entry) {
    return entry.aliases || [entry.key];
  }
})();
