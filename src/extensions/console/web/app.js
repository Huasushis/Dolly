/*
 * Dolly Console browser client.
 *
 * Security model (console-extension.md sections 4, 6, 13):
 *
 * - The event channel (WebSocket /v1/events) is server-to-client only. This
 *   script never calls socket.send(); any client frame is rejected by the
 *   gateway with close 1008. Display items arrive as display.event envelopes
 *   or via the bounded resume route GET /v1/display/since/{cursor}.
 * - The CSRF token and session identity live in memory only. The HttpOnly
 *   SameSite=Strict session cookie is the sole persistent credential; the
 *   browser cannot read it and this script never stores credentials in
 *   localStorage or sessionStorage. A page reload re-derives everything from
 *   GET /v1/session via the cookie.
 * - All rendering uses textContent. No innerHTML, no eval, no dynamically
 *   constructed URLs. Media and block-reference presentation items are inert
 *   placeholders (no fetch route exists for them).
 * - All endpoints are same-origin, derived from window.location. The CSP
 *   (connect-src 'self') enforces this; no host, port, or token is hardcoded.
 */
(function () {
  "use strict";

  var WS_PROTOCOL = "dolly.console.v1";
  var MAX_MESSAGES = 256;
  var INITIAL_BACKOFF_MS = 1000;
  var MAX_BACKOFF_MS = 30000;

  // ---- DOM elements (IDs match index.html) ----

  var statusDot = document.getElementById("status-dot");
  var statusEl = document.getElementById("status");
  var reconnectInfo = document.getElementById("reconnect-info");
  var sessionLine = document.getElementById("session-line");
  var pairView = document.getElementById("pair-view");
  var pairForm = document.getElementById("pair-form");
  var pairCode = document.getElementById("pair-code");
  var pairSubmit = document.getElementById("pair-submit");
  var pairError = document.getElementById("pair-error");
  var chatView = document.getElementById("chat-view");
  var messages = document.getElementById("messages");
  var composerForm = document.getElementById("composer-form");
  var composerText = document.getElementById("composer-text");
  var composerSend = document.getElementById("composer-send");
  var logoutBtn = document.getElementById("logout");

  if (!pairForm || !composerForm || !messages || !logoutBtn) {
    return; // Inert: the shell is incomplete.
  }

  // ---- In-memory session state ----

  var csrfToken = null;
  var sessionId = null;
  var principalId = null;
  var routeAliases = [];
  var limits = null;

  var ws = null;
  var connected = false;
  var everConnected = false;
  var displayCursor = "0";
  var renderedSeqs = Object.create(null);
  var reconnectAttempts = 0;
  var reconnectTimer = null;
  var userClosed = false;
  var pairInFlight = false;
  var idCounter = 0;
  var pendingOptimistic = [];

  // ---- Utilities ----

  function wsUrl() {
    var proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + window.location.host + "/v1/events";
  }

  // Generates an identifier matching ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$.
  function newId(prefix) {
    idCounter += 1;
    return prefix + Date.now().toString(36) + "-" + idCounter.toString(36);
  }

  function utf8ByteLength(str) {
    var len = 0;
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      if (code < 0x80) len += 1;
      else if (code < 0x800) len += 2;
      else if (code >= 0xd800 && code <= 0xdbff) { len += 4; i++; }
      else len += 3;
    }
    return len;
  }

  // ---- Status and view helpers ----

  function setStatus(text, dotClass) {
    statusEl.textContent = text;
    statusDot.classList.remove("disconnected", "connecting");
    if (dotClass) statusDot.classList.add(dotClass);
  }

  function setReconnectInfo(text) {
    reconnectInfo.textContent = text || "";
  }

  function showPairView() {
    pairView.hidden = false;
    chatView.hidden = true;
    composerText.disabled = true;
    composerSend.disabled = true;
  }

  function showChatView() {
    pairView.hidden = true;
    chatView.hidden = false;
  }

  function showPairError(message) {
    pairError.hidden = false;
    pairError.textContent = message;
  }

  function hidePairError() {
    pairError.hidden = true;
    pairError.textContent = "";
  }

  function populateSessionLine() {
    var parts = [];
    if (principalId) parts.push(principalId);
    if (routeAliases.length > 0) parts.push("route: " + routeAliases.join(", "));
    if (limits) {
      var idleMin = Math.max(1, Math.round(limits.sessionIdleMs / 60000));
      parts.push("idle " + idleMin + "m");
    }
    sessionLine.textContent = parts.join("  \u00b7  ");
  }

  function updateComposer() {
    var authed = csrfToken !== null;
    composerText.disabled = !(connected && authed);
    if (composerText.disabled) {
      composerSend.disabled = true;
    } else {
      var text = composerText.value;
      var tooLong = limits && utf8ByteLength(text) > limits.maxTextBytes;
      composerSend.disabled = text.length === 0 || tooLong;
    }
  }

  // ---- Session lifecycle ----

  function resetSession() {
    csrfToken = null;
    sessionId = null;
    principalId = null;
    routeAliases = [];
    limits = null;
    connected = false;
    everConnected = false;
    displayCursor = "0";
    renderedSeqs = Object.create(null);
    pendingOptimistic = [];
    messages.textContent = "";
    sessionLine.textContent = "";
    closeWebSocket();
  }

  function handleExpired() {
    resetSession();
    showPairView();
    setStatus("Disconnected", "disconnected");
    setReconnectInfo("Session expired. Pair again to continue.");
    pairCode.focus();
  }

  async function loadSession() {
    setStatus("Checking session\u2026", "connecting");
    try {
      var response = await fetch("/v1/session", { credentials: "same-origin" });
      if (response.status === 200) {
        var body = await response.json();
        csrfToken = body.csrfToken;
        sessionId = body.sessionId;
        principalId = body.principalId;
        routeAliases = body.routeAliases || [];
        limits = body.limits || null;
        showChatView();
        populateSessionLine();
        await resumeDisplay();
        connectWebSocket();
      } else {
        showPairView();
        setStatus("Disconnected", "disconnected");
      }
    } catch (e) {
      showPairView();
      setStatus("Disconnected", "disconnected");
    }
  }

  // ---- Pairing ----

  async function submitPair() {
    if (pairInFlight) return;
    var code = pairCode.value;
    if (!code) return;
    pairInFlight = true;
    pairSubmit.disabled = true;
    hidePairError();
    pairCode.value = "";

    try {
      var response = await fetch("/v1/session/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code }),
      });
      if (response.status === 201) {
        hidePairError();
        userClosed = false;
        await loadSession();
      } else if (response.status === 401) {
        showPairError("Invalid pairing code.");
      } else if (response.status === 429) {
        showPairError("Too many attempts. Wait and try again.");
      } else {
        showPairError("Pairing failed (" + response.status + ").");
      }
    } catch (e) {
      showPairError("Network error. Try again.");
    } finally {
      pairInFlight = false;
      pairSubmit.disabled = false;
    }
  }

  // ---- WebSocket management ----

  function connectWebSocket() {
    closeWebSocket();
    if (everConnected) {
      setStatus("Reconnecting\u2026", "connecting");
    } else {
      setStatus("Connecting\u2026", "connecting");
    }
    connected = false;
    updateComposer();

    var socket = new WebSocket(wsUrl(), WS_PROTOCOL);
    ws = socket;
    socket.addEventListener("open", onWsOpen);
    socket.addEventListener("message", onWsMessage);
    socket.addEventListener("close", onWsClose);
    socket.addEventListener("error", onWsError);
  }

  function closeWebSocket() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.removeEventListener("open", onWsOpen);
      ws.removeEventListener("message", onWsMessage);
      ws.removeEventListener("close", onWsClose);
      ws.removeEventListener("error", onWsError);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      ws = null;
    }
  }

  function onWsOpen() {
    // Wait for session.ready before marking connected.
  }

  function onWsMessage(event) {
    var data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    if (!data || data.version !== "1") return;
    if (data.type === "session.ready") {
      var firstConnect = !everConnected;
      connected = true;
      everConnected = true;
      reconnectAttempts = 0;
      setStatus("Connected", null);
      setReconnectInfo("");
      updateComposer();
      resumeDisplay();
      // Restore focus only on the first connect; a later reconnect must not
      // steal focus while the user reads older items (spec section 12).
      if (firstConnect) composerText.focus();
    } else if (data.type === "display.event") {
      if (data.payload && typeof data.payload === "object") {
        handleDisplayItem(data.payload);
      }
    }
    // Unknown envelope types are ignored.
  }

  function onWsClose(event) {
    connected = false;
    updateComposer();

    if (ws) {
      ws.removeEventListener("open", onWsOpen);
      ws.removeEventListener("message", onWsMessage);
      ws.removeEventListener("close", onWsClose);
      ws.removeEventListener("error", onWsError);
      ws = null;
    }

    if (userClosed) {
      setStatus("Disconnected", "disconnected");
      return;
    }

    if (event.code === 1008) {
      // Session expired or channel violation; re-pairing is required.
      handleExpired();
      return;
    }

    // Transient close (1013 backpressure, 1006 abnormal, gateway stop):
    // reconnect with bounded backoff.
    scheduleReconnect();
  }

  function onWsError() {
    // The close event follows; no action here.
  }

  function scheduleReconnect() {
    reconnectAttempts += 1;
    var base = Math.min(
      INITIAL_BACKOFF_MS * Math.pow(2, reconnectAttempts - 1),
      MAX_BACKOFF_MS
    );
    var delay = Math.round(base * (0.5 + Math.random() * 0.5));
    setStatus("Reconnecting\u2026", "connecting");
    setReconnectInfo("Reconnecting in " + Math.max(1, Math.round(delay / 1000)) + "s\u2026");
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connectWebSocket();
    }, delay);
  }

  // ---- Display rendering ----

  async function resumeDisplay() {
    if (csrfToken === null) return;
    messages.setAttribute("aria-busy", "true");
    try {
      var response = await fetch("/v1/display/since/" + displayCursor, {
        credentials: "same-origin",
      });
      if (response.status === 200) {
        var body = await response.json();
        // Only the explicit versioned projection is consumed; anything else
        // is rejected outright, and never treated as display continuity.
        if (body.version !== "1" || body.type !== "display.resume") {
          messages.setAttribute("aria-busy", "false");
          return;
        }
        if (body.truncated) {
          setReconnectInfo("Some earlier messages were not retained.");
        }
        var items = body.items || [];
        for (var i = 0; i < items.length; i++) {
          handleDisplayItem(items[i]);
        }
      } else if (response.status === 401) {
        handleExpired();
      } else if (response.status === 409) {
        // Cursor is ahead of the frontier; reset and retry once.
        displayCursor = "0";
        renderedSeqs = Object.create(null);
        messages.textContent = "";
        pendingOptimistic = [];
        var retry = await fetch("/v1/display/since/0", { credentials: "same-origin" });
        if (retry.status === 200) {
          var retryBody = await retry.json();
          if (retryBody.version === "1" && retryBody.type === "display.resume") {
            var retryItems = retryBody.items || [];
            for (var j = 0; j < retryItems.length; j++) {
              handleDisplayItem(retryItems[j]);
            }
          }
        }
      }
    } catch (e) {
      // Network error; will retry on next reconnect.
    }
    messages.setAttribute("aria-busy", "false");
  }

  function handleDisplayItem(item) {
    if (!item || typeof item.displaySequence !== "string") return;
    var seq = item.displaySequence;
    if (renderedSeqs[seq]) return;
    renderedSeqs[seq] = true;

    if (item.selfEcho === true && reconcileSelfEcho(item)) {
      advanceCursor(seq);
      return;
    }

    renderMessage(item);
    advanceCursor(seq);
    messages.scrollTop = messages.scrollHeight;
  }

  function reconcileSelfEcho(item) {
    var text = extractItemText(item);
    if (text === null) return false;
    for (var i = 0; i < pendingOptimistic.length; i++) {
      if (pendingOptimistic[i].text === text) {
        var el = pendingOptimistic[i].element;
        var stateEl = el.querySelector(".send-state");
        if (stateEl) {
          stateEl.textContent = "Delivered";
          stateEl.classList.remove("failed");
        }
        pendingOptimistic.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  function extractItemText(item) {
    var presentation = item.presentation || [];
    for (var i = 0; i < presentation.length; i++) {
      if (
        presentation[i] &&
        presentation[i].kind === "text" &&
        typeof presentation[i].text === "string"
      ) {
        return presentation[i].text;
      }
    }
    return null;
  }

  function renderMessage(item) {
    var div = document.createElement("div");
    var own = item.selfEcho === true;
    var isSystem = item.source && item.source.kind === "system";
    var classes = "message";
    if (own) classes += " own";
    else if (isSystem) classes += " system";
    else classes += " bot";
    div.className = classes;
    div.setAttribute("data-seq", item.displaySequence);

    if (item.source && !own && !isSystem) {
      var src = document.createElement("div");
      src.className = "source";
      src.textContent = item.source.kind + "/" + item.source.id;
      div.appendChild(src);
    }

    var presentation = item.presentation || [];
    for (var i = 0; i < presentation.length; i++) {
      appendPresentation(div, presentation[i]);
    }

    messages.appendChild(div);
    trimMessages();
  }

  function appendPresentation(parent, item) {
    if (!item || typeof item.kind !== "string") return;
    switch (item.kind) {
      case "message-boundary": {
        parent.appendChild(document.createElement("hr"));
        break;
      }
      case "text": {
        var el = document.createElement("div");
        el.className = "message-text";
        // Markdown is rendered as plain text: no sanitizer is shipped, so the
        // safe fallback is textContent (never innerHTML).
        el.textContent = typeof item.text === "string" ? item.text : "";
        parent.appendChild(el);
        break;
      }
      case "media": {
        var m = document.createElement("div");
        m.className = "message-text";
        m.textContent = "[media " + (item.mediaId || "") + "]";
        parent.appendChild(m);
        break;
      }
      case "block-reference": {
        var r = document.createElement("div");
        r.className = "message-text";
        r.textContent = "[block " + (item.blockId || "") + "]";
        parent.appendChild(r);
        break;
      }
      case "structured": {
        var s = document.createElement("div");
        s.className = "message-text";
        s.textContent =
          "[" + (item.schema || "unknown") + "] " + (item.preview || "");
        parent.appendChild(s);
        break;
      }
      default: {
        var u = document.createElement("div");
        u.className = "message-text";
        u.textContent = "[unknown presentation]";
        parent.appendChild(u);
        break;
      }
    }
  }

  function trimMessages() {
    while (messages.children.length > MAX_MESSAGES) {
      var first = messages.firstChild;
      if (!first) break;
      var seq = first.getAttribute("data-seq");
      if (seq) delete renderedSeqs[seq];
      messages.removeChild(first);
    }
  }

  function advanceCursor(seq) {
    try {
      if (BigInt(seq) > BigInt(displayCursor)) {
        displayCursor = seq;
      }
    } catch (e) {
      // Ignore non-decimal sequence values.
    }
  }

  // ---- Composer (message enqueue) ----

  async function submitMessage() {
    if (!connected || csrfToken === null) return;
    var text = composerText.value;
    if (text.length === 0) return;
    if (limits && utf8ByteLength(text) > limits.maxTextBytes) return;
    var routeAlias = routeAliases[0];
    if (!routeAlias) return;

    var operationId = newId("op");
    var clientMessageId = newId("cm");

    composerText.value = "";
    updateComposer();

    // Optimistic own message.
    var msgEl = document.createElement("div");
    msgEl.className = "message own";
    var textEl = document.createElement("div");
    textEl.className = "message-text";
    textEl.textContent = text;
    msgEl.appendChild(textEl);
    var stateEl = document.createElement("div");
    stateEl.className = "send-state";
    stateEl.textContent = "Sending\u2026";
    msgEl.appendChild(stateEl);
    messages.appendChild(msgEl);
    messages.scrollTop = messages.scrollHeight;
    pendingOptimistic.push({ element: msgEl, text: text });
    trimMessages();

    try {
      var response = await fetch("/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dolly-csrf": csrfToken,
        },
        body: JSON.stringify({
          version: "1",
          type: "message.enqueue",
          operationId: operationId,
          clientMessageId: clientMessageId,
          routeAlias: routeAlias,
          text: text,
        }),
      });

      if (response.status === 202) {
        var body = await response.json();
        stateEl.textContent = "Sent";
        if (body.externalMessageId) {
          msgEl.setAttribute("data-external-id", body.externalMessageId);
        }
      } else if (response.status === 409) {
        stateEl.textContent = "Failed: duplicate";
        stateEl.classList.add("failed");
        removePending(msgEl);
      } else if (response.status === 429) {
        stateEl.textContent = "Failed: queue full";
        stateEl.classList.add("failed");
        removePending(msgEl);
        composerText.value = text;
      } else if (response.status === 400) {
        stateEl.textContent = "Failed: invalid message";
        stateEl.classList.add("failed");
        removePending(msgEl);
        composerText.value = text;
      } else if (response.status === 401) {
        handleExpired();
      } else {
        stateEl.textContent = "Failed: error " + response.status;
        stateEl.classList.add("failed");
        removePending(msgEl);
        composerText.value = text;
      }
    } catch (e) {
      stateEl.textContent = "Failed: network error";
      stateEl.classList.add("failed");
      removePending(msgEl);
      composerText.value = text;
    }
    updateComposer();
  }

  function removePending(el) {
    for (var i = 0; i < pendingOptimistic.length; i++) {
      if (pendingOptimistic[i].element === el) {
        pendingOptimistic.splice(i, 1);
        return;
      }
    }
  }

  // ---- Logout (session close) ----

  async function logout() {
    if (csrfToken === null) return;
    userClosed = true;
    try {
      await fetch("/v1/session/close", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dolly-csrf": csrfToken,
        },
        body: JSON.stringify({ version: "1", type: "session.close" }),
      });
    } catch (e) {
      // Best-effort close; clear local state regardless.
    }
    resetSession();
    showPairView();
    setStatus("Disconnected", "disconnected");
    setReconnectInfo("");
    pairCode.focus();
  }

  // ---- Initialization ----

  pairForm.addEventListener("submit", function (event) {
    event.preventDefault();
    submitPair();
  });
  composerForm.addEventListener("submit", function (event) {
    event.preventDefault();
    submitMessage();
  });
  composerText.addEventListener("input", updateComposer);
  logoutBtn.addEventListener("click", logout);

  loadSession();
})();
