/* global initSqlJs */

(function () {
  "use strict";

  var SQL_WASM_CDN = "https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/";
  var MESSAGE_PAGE_SIZE = 180;
  var CHAT_ITEM_FALLBACK_HEIGHT = 65;
  var MAX_ATTACHMENT_PREVIEW = 120;
  var chatResizeTimer = null;

  var state = {
    files: [],
    fileByPath: new Map(),
    sourceMode: "folder",
    sourceRoot: "",
    sourceSize: 0,
    database: null,
    sqlReady: false,
    chats: [],
    chatPage: 1,
    users: new Map(),
    groupsById: new Map(),
    groupsByPk: new Map(),
    groupNamesByChatPk: new Map(),
    groupMemberNamesByChatPk: new Map(),
    currentChat: null,
    currentMessages: [],
    currentOffset: 0,
    attachmentFiles: [],
    attachmentByBasename: new Map(),
    attachmentByToken: new Map(),
    selfId: ""
  };

  var el = {};

  document.addEventListener("DOMContentLoaded", function () {
    el.folderInput = document.getElementById("folderInput");
    el.databaseInput = document.getElementById("databaseInput");
    el.sourceModeInputs = Array.from(document.querySelectorAll('input[name="sourceMode"]'));
    el.folderSourcePicker = document.getElementById("folderSourcePicker");
    el.databaseSourcePicker = document.getElementById("databaseSourcePicker");
    el.runtimeBadge = document.getElementById("runtimeBadge");
    el.loadStatus = document.getElementById("loadStatus");
    el.progressBar = document.getElementById("progressBar");
    el.workspace = document.getElementById("workspace");
    el.chatCount = document.getElementById("chatCount");
    el.messageCount = document.getElementById("messageCount");
    el.attachmentCount = document.getElementById("attachmentCount");
    el.sourceSize = document.getElementById("sourceSize");
    el.chatSearch = document.getElementById("chatSearch");
    el.chatList = document.getElementById("chatList");
    el.chatPrevButton = document.getElementById("chatPrevButton");
    el.chatNextButton = document.getElementById("chatNextButton");
    el.chatPageInfo = document.getElementById("chatPageInfo");
    el.clearButton = document.getElementById("clearButton");
    el.selectedChatTitle = document.getElementById("selectedChatTitle");
    el.selectedChatMeta = document.getElementById("selectedChatMeta");
    el.messageStatus = document.getElementById("messageStatus");
    el.messageList = document.getElementById("messageList");
    el.loadMoreButton = document.getElementById("loadMoreButton");
    el.exportHtmlButton = document.getElementById("exportHtmlButton");
    el.exportJsonButton = document.getElementById("exportJsonButton");
    el.exportAttachmentsButton = document.getElementById("exportAttachmentsButton");
    el.attachmentPreview = document.getElementById("attachmentPreview");

    el.folderInput.addEventListener("change", function (event) {
      loadSource(event.target.files, "folder");
    });
    el.databaseInput.addEventListener("change", function (event) {
      loadSource(event.target.files, "database");
    });
    el.sourceModeInputs.forEach(function (input) {
      input.addEventListener("change", function (event) {
        switchSourceMode(event.target.value);
      });
    });
    el.chatSearch.addEventListener("input", function () {
      state.chatPage = 1;
      renderChatList();
    });
    el.chatPrevButton.addEventListener("click", function () {
      if (state.chatPage > 1) {
        state.chatPage -= 1;
        renderChatList();
      }
    });
    el.chatNextButton.addEventListener("click", function () {
      var totalPages = getChatTotalPages();
      if (state.chatPage < totalPages) {
        state.chatPage += 1;
        renderChatList();
      }
    });
    el.clearButton.addEventListener("click", clearWorkspace);
    el.loadMoreButton.addEventListener("click", loadMoreMessages);
    el.exportHtmlButton.addEventListener("click", exportCurrentHtml);
    el.exportJsonButton.addEventListener("click", exportCurrentJson);
    el.exportAttachmentsButton.addEventListener("click", exportAttachmentCsv);
    window.addEventListener("resize", scheduleChatLayoutRefresh);
    updateSourceModeUi();

    if (typeof window.initSqlJs !== "function") {
      setRuntime("SQL.js 載入失敗", true);
      setStatus("無法載入資料解析引擎。請確認網路連線正常，或重新整理頁面再試。", true);
    }
  });

  function setRuntime(text, isError) {
    el.runtimeBadge.textContent = text;
    el.runtimeBadge.classList.toggle("error", Boolean(isError));
  }

  function setStatus(text, isError) {
    el.loadStatus.textContent = text;
    el.loadStatus.classList.toggle("error", Boolean(isError));
  }

  function setProgress(value) {
    el.progressBar.style.width = Math.max(0, Math.min(100, value)) + "%";
  }

  function switchSourceMode(mode) {
    var nextMode = mode === "database" ? "database" : "folder";
    clearWorkspace(true);
    state.sourceMode = nextMode;
    updateSourceModeUi();
    setStatus(nextMode === "database" ? "請選取 Messages/Line.sqlite。" : "請選取完整 LINE 備份資料夾。", false);
  }

  function updateSourceModeUi() {
    var databaseOnly = state.sourceMode === "database";
    if (el.folderSourcePicker) el.folderSourcePicker.classList.toggle("hidden", databaseOnly);
    if (el.databaseSourcePicker) el.databaseSourcePicker.classList.toggle("hidden", !databaseOnly);
  }

  async function loadSource(fileList, mode) {
    var sourceMode = mode === "database" ? "database" : "folder";
    clearWorkspace(false);
    state.sourceMode = sourceMode;
    updateSourceModeUi();
    if (!fileList || !fileList.length) {
      setStatus(sourceMode === "database" ? "尚未選取 Line.sqlite。" : "尚未選取備份資料夾。", false);
      return;
    }

    try {
      setRuntime("讀取中…", false);
      setProgress(5);
      state.files = Array.from(fileList);
      state.sourceSize = state.files.reduce(function (sum, file) { return sum + file.size; }, 0);
      state.fileByPath = new Map(state.files.map(function (file) { return [relativePath(file), file]; }));
      state.sourceRoot = sourceMode === "database" ? relativePath(state.files[0]) : inferRoot(state.files);
      state.attachmentFiles = sourceMode === "folder" ? state.files.filter(function (file) {
        var path = relativePath(file);
        return /\/Message Attachments\//.test(path) || /\/Message Thumbnails\//.test(path);
      }) : [];
      buildAttachmentIndex();

      var lineFile = sourceMode === "database" ? state.files[0] : findFileEnding("/Messages/Line.sqlite");
      if (!lineFile) {
        throw new Error("找不到 Messages/Line.sqlite。請選取包含 Container 的完整 LINE 資料夾。");
      }
      if (sourceMode === "database" && !/Line\.sqlite$/i.test(lineFile.name)) {
        throw new Error("只讀訊息模式需要選取 Messages/Line.sqlite。");
      }

      setStatus("正在載入 SQLite 資料庫…", false);
      var buffer = await lineFile.arrayBuffer();
      setProgress(35);
      var SQL = await initSqlJs({ locateFile: function (file) { return SQL_WASM_CDN + file; } });
      state.database = new SQL.Database(new Uint8Array(buffer));
      state.sqlReady = true;
      setProgress(60);

      loadReferenceData();
      setProgress(78);
      loadChats();
      setProgress(92);
      renderAttachmentPreview();
      updateStats();
      el.workspace.classList.remove("hidden");
      setRuntime("已載入", false);
      setStatus(
        sourceMode === "database"
          ? "訊息資料庫載入完成；只讀訊息模式不包含附件檔案。"
          : "完整備份解析完成，資料只留在目前瀏覽器分頁。",
        false
      );
      setProgress(100);
      renderChatList();
    } catch (error) {
      setRuntime("載入失敗", true);
      setStatus(error && error.message ? error.message : String(error), true);
      setProgress(0);
      console.error(error);
    }
  }

  function inferRoot(files) {
    var first = relativePath(files[0]);
    return first.split("/")[0] || "";
  }

  function relativePath(file) {
    return file.webkitRelativePath || file.name;
  }

  function findFileEnding(suffix) {
    for (var i = 0; i < state.files.length; i += 1) {
      if (relativePath(state.files[i]).endsWith(suffix)) return state.files[i];
    }
    return null;
  }

  function query(sql, params) {
    if (!state.database) throw new Error("資料庫尚未載入。");
    var statement = state.database.prepare(sql);
    var rows = [];
    try {
      statement.bind(params || {});
      while (statement.step()) rows.push(statement.getAsObject());
    } finally {
      statement.free();
    }
    return rows;
  }

  function loadReferenceData() {
    state.users.clear();
    state.groupsById.clear();
    state.groupsByPk.clear();
    state.groupNamesByChatPk.clear();
    state.groupMemberNamesByChatPk.clear();

    safeQuery("SELECT Z_PK, ZMID, ZNAME, ZADDRESSBOOKNAME, ZCUSTOMNAME, ZSTATUSMESSAGE FROM ZUSER", {}).forEach(function (row) {
      var user = {
        pk: numberOrNull(row.Z_PK),
        id: stringOrEmpty(row.ZMID),
        name: firstNonEmpty(row.ZCUSTOMNAME, row.ZADDRESSBOOKNAME, row.ZNAME, row.ZMID, "未知使用者"),
        status: stringOrEmpty(row.ZSTATUSMESSAGE)
      };
      if (user.id) {
        state.users.set(user.id, user);
        state.users.set(user.id.toLowerCase(), user);
      }
      state.users.set("pk:" + user.pk, user);
    });

    safeQuery("SELECT Z_PK, ZID, ZNAME, ZCREATEDTIME FROM ZGROUP", {}).forEach(function (row) {
      var group = {
        pk: numberOrNull(row.Z_PK),
        id: stringOrEmpty(row.ZID),
        name: firstNonEmpty(row.ZNAME, row.ZID, "未命名群組"),
        createdAt: normalizeTimestamp(row.ZCREATEDTIME)
      };
      if (group.id) state.groupsById.set(group.id, group);
      state.groupsByPk.set("pk:" + group.pk, group);
    });

    loadGroupTitleData();

    var accountMatch = state.files.map(relativePath).join("\n").match(/P_([^/]+)/);
    state.selfId = accountMatch ? accountMatch[1] : "";
  }

  function loadGroupTitleData() {
    safeQuery("SELECT ZCHAT AS chatPk, ZMEMBERDATA AS memberData FROM ZCHATMETADATA WHERE ZMEMBERDATA IS NOT NULL", {}).forEach(function (row) {
      var names = extractMemberNames(row.memberData);
      if (names.length) state.groupMemberNamesByChatPk.set(Number(row.chatPk), names);
    });

    safeQuery(
      "SELECT m.ZCHAT AS chatPk, m.Z_PK AS messagePk, m.ZTIMESTAMP AS timestamp, m.ZTEXT AS text " +
      "FROM ZMESSAGE m JOIN ZCHAT c ON c.Z_PK = m.ZCHAT " +
      "WHERE c.ZTYPE IN (1, 2, 100) AND m.ZCONTENTTYPE = 18 AND m.ZTEXT IS NOT NULL " +
      "ORDER BY m.ZCHAT ASC, COALESCE(m.ZTIMESTAMP, 0) ASC, m.Z_PK ASC",
      {}
    ).forEach(function (row) {
      var name = extractGroupNameFromSystemText(row.text);
      if (name) state.groupNamesByChatPk.set(Number(row.chatPk), { name: name, source: "rename" });
    });
  }

  function extractMemberNames(blob) {
    var bytes = toUint8Array(blob);
    if (!bytes || bytes.length < 16) return [];
    var names = [];
    for (var offset = 0; offset + 16 <= bytes.length; offset += 16) {
      var user = state.users.get("u" + bytesToHex(bytes, offset, 16));
      if (!user || !user.name || names.indexOf(user.name) !== -1) continue;
      names.push(user.name);
    }
    return names;
  }

  function extractGroupNameFromSystemText(value) {
    var text = stringOrEmpty(value).replace(/[\u2068\u2069\u200b\ufeff]/g, "").trim();
    var patterns = [
      /群組名稱\s*改為\s*[「『"“](.*?)[」』"”]/,
      /(?:change|changed)\s+the\s+group\s+name\s+to\s*[「『"“](.*?)[」』"”]/i,
      /(?:群組名稱|group\s+name)[^「『"“]{0,24}[「『"“](.*?)[」』"”]/i
    ];
    for (var i = 0; i < patterns.length; i += 1) {
      var match = text.match(patterns[i]);
      if (match && match[1] && match[1].trim()) return match[1].trim();
    }
    return "";
  }

  function loadChats() {
    var rows = safeQuery(
      "SELECT c.Z_PK AS chatPk, c.ZMID AS chatId, c.ZTYPE AS chatType, " +
      "c.ZLASTUPDATED AS lastUpdated, c.ZLASTMESSAGE AS lastMessage, " +
      "COUNT(m.Z_PK) AS messageCount, MAX(m.ZTIMESTAMP) AS lastMessageTimestamp " +
      "FROM ZCHAT c LEFT JOIN ZMESSAGE m ON m.ZCHAT = c.Z_PK " +
      "GROUP BY c.Z_PK ORDER BY COALESCE(MAX(m.ZTIMESTAMP), c.ZLASTUPDATED, 0) DESC, c.Z_PK DESC",
      {}
    );

    state.chats = rows.map(function (row) {
      var titleInfo = resolveChatTitle(row.chatId, row.chatType, row.chatPk);
      return {
        pk: numberOrNull(row.chatPk),
        id: stringOrEmpty(row.chatId),
        type: titleInfo.type,
        title: titleInfo.title,
        titleSource: titleInfo.source,
        messageCount: Number(row.messageCount || 0),
        lastMessage: stringOrEmpty(row.lastMessage),
        lastTimestamp: normalizeTimestamp(row.lastMessageTimestamp || row.lastUpdated)
      };
    });
  }

  function resolveChatTitle(chatId, chatType, chatPk) {
    var id = stringOrEmpty(chatId);
    var normalizedType = Number(chatType);
    var group = state.groupsById.get(id);
    var user = state.users.get(id);
    if (user && normalizedType === 0) return { title: user.name, type: "direct", source: "user" };

    var groupName = state.groupNamesByChatPk.get(Number(chatPk));
    if (groupName) return { title: groupName.name, type: chatTypeLabel(normalizedType), source: groupName.source };
    if (group) return { title: group.name, type: "group", source: "group" };

    var memberNames = state.groupMemberNamesByChatPk.get(Number(chatPk)) || [];
    if (memberNames.length && normalizedType !== 0) {
      return { title: formatMemberTitle(memberNames), type: chatTypeLabel(normalizedType), source: "members" };
    }
    if (user) return { title: user.name, type: "direct", source: "user" };
    return { title: normalizedType === 0 ? "未命名聊天室" : "未命名群組", type: chatTypeLabel(normalizedType), source: "unresolved" };
  }

  function renderChatList() {
    if (!el.chatList) return;
    var term = (el.chatSearch.value || "").trim().toLowerCase();
    var visible = state.chats.filter(function (chat) {
      return !term || (chat.title + " " + chat.id).toLowerCase().indexOf(term) !== -1;
    });
    var pageSize = getChatPageSize();
    var totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
    state.chatPage = Math.min(Math.max(1, state.chatPage), totalPages);
    var pageStart = (state.chatPage - 1) * pageSize;
    var pageItems = visible.slice(pageStart, pageStart + pageSize);
    el.chatList.innerHTML = "";
    if (!visible.length) {
      el.chatList.innerHTML = '<div class="empty-state">找不到符合的聊天室。</div>';
      updateChatPagination(0, 1);
      return;
    }
    pageItems.forEach(function (chat) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "chat-item" + (state.currentChat && state.currentChat.pk === chat.pk ? " selected" : "");
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", state.currentChat && state.currentChat.pk === chat.pk ? "true" : "false");
      button.innerHTML = '<span class="chat-item-title"></span><span class="chat-item-meta"><span></span><span></span></span>';
      button.querySelector(".chat-item-title").textContent = chat.title;
      button.querySelector(".chat-item-meta span:first-child").textContent = formatNumber(chat.messageCount) + " 則";
      button.querySelector(".chat-item-meta span:last-child").textContent = formatDate(chat.lastTimestamp);
      button.addEventListener("click", function () { selectChat(chat); });
      el.chatList.appendChild(button);
    });
    updateChatPagination(visible.length, totalPages);
  }

  function getChatTotalPages() {
    var term = (el.chatSearch && el.chatSearch.value || "").trim().toLowerCase();
    var visibleCount = state.chats.filter(function (chat) {
      return !term || (chat.title + " " + chat.id).toLowerCase().indexOf(term) !== -1;
    }).length;
    return Math.max(1, Math.ceil(visibleCount / getChatPageSize()));
  }

  function getChatPageSize() {
    if (!el.chatList) return 1;
    var listHeight = el.chatList.clientHeight;
    var sample = el.chatList.querySelector(".chat-item");
    var itemHeight = sample ? sample.getBoundingClientRect().height : CHAT_ITEM_FALLBACK_HEIGHT;
    var computedStyle = window.getComputedStyle(el.chatList);
    var gap = parseFloat(computedStyle.rowGap || computedStyle.gap) || 4;
    if (!listHeight || !itemHeight) return 1;
    return Math.max(1, Math.floor((listHeight + gap) / (itemHeight + gap)));
  }

  function scheduleChatLayoutRefresh() {
    if (chatResizeTimer) window.clearTimeout(chatResizeTimer);
    chatResizeTimer = window.setTimeout(function () {
      chatResizeTimer = null;
      if (state.chats.length) renderChatList();
    }, 120);
  }

  function updateChatPagination(visibleCount, totalPages) {
    if (!el.chatPageInfo) return;
    el.chatPageInfo.textContent = visibleCount ? "第 " + state.chatPage + " / " + totalPages + " 頁 · " + formatNumber(visibleCount) + " 個聊天室" : "沒有聊天室";
    el.chatPrevButton.disabled = !visibleCount || state.chatPage <= 1;
    el.chatNextButton.disabled = !visibleCount || state.chatPage >= totalPages;
  }

  function selectChat(chat) {
    state.currentChat = chat;
    state.currentMessages = [];
    state.currentOffset = 0;
    el.selectedChatTitle.textContent = chat.title;
    el.selectedChatMeta.textContent = typeLabel(chat.type) + " · " + formatNumber(chat.messageCount) + " 則訊息 · 名稱來源：" + titleSourceLabel(chat.titleSource) + " · " + (chat.id || "無 ID");
    el.exportHtmlButton.disabled = false;
    el.exportJsonButton.disabled = false;
    renderChatList();
    loadMoreMessages();
  }

  function loadMoreMessages() {
    if (!state.currentChat) return;
    var rows = safeQuery(
      "SELECT m.Z_PK AS messagePk, m.ZID AS messageId, m.ZTIMESTAMP AS timestamp, " +
      "m.ZSENDER AS senderPk, m.ZCONTENTTYPE AS contentType, m.ZTEXT AS text, " +
      "m.ZMESSAGETYPE AS messageType, m.ZLATITUDE AS latitude, m.ZLONGITUDE AS longitude, " +
      "m.ZCONTENTMETADATA AS contentMetadata " +
      "FROM ZMESSAGE m WHERE m.ZCHAT = $chatPk " +
      "ORDER BY COALESCE(m.ZTIMESTAMP, 0) ASC, m.Z_PK ASC LIMIT $limit OFFSET $offset",
      { $chatPk: state.currentChat.pk, $limit: MESSAGE_PAGE_SIZE, $offset: state.currentOffset }
    );
    var mapped = rows.map(mapMessage);
    state.currentMessages = state.currentMessages.concat(mapped);
    state.currentOffset += mapped.length;
    renderMessages();
    el.loadMoreButton.classList.toggle("hidden", state.currentOffset >= state.currentChat.messageCount || mapped.length === 0);
  }

  function mapMessage(row) {
    var sender = state.users.get("pk:" + numberOrNull(row.senderPk));
    var text = stringOrEmpty(row.text);
    var kind = messageKind(row.contentType, row.messageType, text);
    return {
      pk: numberOrNull(row.messagePk),
      id: stringOrEmpty(row.messageId),
      timestampRaw: row.timestamp,
      timestamp: normalizeTimestamp(row.timestamp),
      senderId: sender ? sender.id : "",
      sender: sender ? sender.name : "未知使用者",
      isSelf: Boolean(sender && state.selfId && sender.id === state.selfId),
      contentType: row.contentType,
      messageType: stringOrEmpty(row.messageType),
      kind: kind,
      text: text,
      latitude: numberOrNull(row.latitude),
      longitude: numberOrNull(row.longitude),
      attachmentHints: extractAttachmentHints(row.contentMetadata, stringOrEmpty(row.messageId)),
      attachments: resolveAttachments(row.contentMetadata, stringOrEmpty(row.messageId))
    };
  }

  function renderMessages() {
    el.messageList.innerHTML = "";
    if (!state.currentMessages.length) {
      el.messageList.innerHTML = '<div class="empty-state">這個聊天室沒有可顯示的訊息。</div>';
      el.messageStatus.textContent = "";
      return;
    }
    var fragment = document.createDocumentFragment();
    state.currentMessages.forEach(function (message) {
      var row = document.createElement("article");
      row.className = "message-row" + (message.isSelf ? " self" : "");
      var card = document.createElement("div");
      card.className = "message-card";
      var meta = document.createElement("div");
      meta.className = "message-meta";
      var sender = document.createElement("span");
      sender.className = "message-sender";
      sender.textContent = message.sender;
      var date = document.createElement("time");
      date.dateTime = message.timestamp ? message.timestamp.toISOString() : "";
      date.textContent = formatDate(message.timestamp, true);
      meta.appendChild(sender);
      meta.appendChild(date);
      card.appendChild(meta);
      if (message.text) {
        var body = document.createElement("p");
        body.className = "message-text";
        body.textContent = message.text;
        card.appendChild(body);
      } else {
        var kind = document.createElement("p");
        kind.className = "message-kind";
        kind.textContent = "[" + message.kind + "]";
        card.appendChild(kind);
      }
      if (message.latitude !== null && message.longitude !== null) {
        var coordinates = document.createElement("p");
        coordinates.className = "message-coordinates";
        coordinates.textContent = "位置：" + message.latitude + ", " + message.longitude;
        card.appendChild(coordinates);
      }
      appendAttachmentLinks(card, message.attachments);
      row.appendChild(card);
      fragment.appendChild(row);
    });
    el.messageList.appendChild(fragment);
    el.messageStatus.textContent = "已顯示 " + formatNumber(state.currentMessages.length) + " / " + formatNumber(state.currentChat.messageCount) + " 則訊息";
  }

  function renderAttachmentPreview() {
    if (state.sourceMode === "database") {
      el.exportAttachmentsButton.disabled = true;
      el.attachmentPreview.innerHTML = '<div class="empty-state">目前是只讀訊息模式；如需附件索引與下載連結，請切換為完整 LINE 備份。</div>';
      return;
    }
    el.exportAttachmentsButton.disabled = state.attachmentFiles.length === 0;
    if (!state.attachmentFiles.length) {
      el.attachmentPreview.innerHTML = '<div class="empty-state">沒有偵測到 Message Attachments 或 Message Thumbnails。</div>';
      return;
    }
    var rows = state.attachmentFiles.slice(0, MAX_ATTACHMENT_PREVIEW).map(function (file) {
      return '<tr><td class="file-name">' + escapeHtml(relativePath(file)) + '</td><td>' + escapeHtml(formatBytes(file.size)) + '</td><td>' + escapeHtml(file.type || "未知") + '</td></tr>';
    }).join("");
    var more = state.attachmentFiles.length > MAX_ATTACHMENT_PREVIEW
      ? '<p class="muted">目前顯示前 ' + MAX_ATTACHMENT_PREVIEW + ' 筆，完整清單可匯出附件清單。</p>'
      : "";
    el.attachmentPreview.innerHTML = '<table class="attachment-table"><thead><tr><th>來源路徑</th><th>大小</th><th>MIME</th></tr></thead><tbody>' + rows + '</tbody></table>' + more;
  }

  function updateStats() {
    el.chatCount.textContent = formatNumber(state.chats.length);
    el.messageCount.textContent = formatNumber(state.chats.reduce(function (sum, chat) { return sum + chat.messageCount; }, 0));
    el.attachmentCount.textContent = formatNumber(state.attachmentFiles.length);
    el.sourceSize.textContent = formatBytes(state.sourceSize);
  }

  function exportCurrentHtml() {
    if (!state.currentChat) return;
    var messages = loadAllMessagesForExport();
    var html = buildChatHtml(state.currentChat, messages);
    downloadText(slugify(state.currentChat.title) + ".html", html, "text/html;charset=utf-8");
  }

  function exportCurrentJson() {
    if (!state.currentChat) return;
    var messages = loadAllMessagesForExport();
    var payload = {
      schemaVersion: "0.1",
      exportedAt: new Date().toISOString(),
      source: state.sourceMode === "database" ? "LINE Messages/Line.sqlite" : "LINE iOS App Container",
      sourceMode: state.sourceMode,
      conversation: state.currentChat,
      messages: messages.map(sanitizeMessageForExport)
    };
    downloadText(slugify(state.currentChat.title) + ".json", JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
  }

  function loadAllMessagesForExport() {
    var rows = safeQuery(
      "SELECT m.Z_PK AS messagePk, m.ZID AS messageId, m.ZTIMESTAMP AS timestamp, " +
      "m.ZSENDER AS senderPk, m.ZCONTENTTYPE AS contentType, m.ZTEXT AS text, " +
      "m.ZMESSAGETYPE AS messageType, m.ZLATITUDE AS latitude, m.ZLONGITUDE AS longitude, " +
      "m.ZCONTENTMETADATA AS contentMetadata " +
      "FROM ZMESSAGE m WHERE m.ZCHAT = $chatPk ORDER BY COALESCE(m.ZTIMESTAMP, 0) ASC, m.Z_PK ASC",
      { $chatPk: state.currentChat.pk }
    );
    return rows.map(mapMessage);
  }

  function buildChatHtml(chat, messages) {
    var body = messages.map(function (message) {
      var content = message.text ? '<p class="message-text">' + escapeHtml(message.text) + '</p>' : '<p class="message-kind">[' + escapeHtml(message.kind) + ']</p>';
      if (message.latitude !== null && message.longitude !== null) {
        content += '<p class="coordinates">位置：' + escapeHtml(message.latitude + ", " + message.longitude) + '</p>';
      }
      if (message.attachments && message.attachments.length) {
        content += '<ul class="attachments">' + message.attachments.map(function (attachment) {
          return '<li>' + escapeHtml(attachment.name) + ' <span>(' + escapeHtml(formatBytes(attachment.size)) + ')</span></li>';
        }).join("") + '</ul>';
      }
      return '<article class="message ' + (message.isSelf ? "self" : "") + '"><header><strong>' + escapeHtml(message.sender) + '</strong><time>' + escapeHtml(formatDate(message.timestamp, true)) + '</time></header>' + content + '</article>';
    }).join("\n");
    var note = state.sourceMode === "database"
      ? "這份封存來自 Line.sqlite 只讀訊息模式；未載入附件檔案。"
      : "附件在目前閱讀器中提供本機下載連結；匯出的單一 HTML 會保留附件名稱與大小。";
    return '<!doctype html><html lang="zh-Hant-TW"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escapeHtml(chat.title) + '</title><style>' + exportCss() + '</style><main><h1>' + escapeHtml(chat.title) + '</h1><p class="meta">' + escapeHtml(typeLabel(chat.type) + " · " + formatNumber(messages.length) + " 則訊息") + '</p><p class="note">' + escapeHtml(note) + '</p><section>' + body + '</section></main></html>';
  }

  function exportCss() {
    return "body{margin:0;padding:24px;background:#f3f5f7;color:#1f2937;font:16px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}main{max-width:860px;margin:auto}h1{letter-spacing:-.03em}.meta,.note{color:#6b7280}.note{padding:10px 12px;border-radius:10px;background:#fff}.message{max-width:78%;margin:12px 0;padding:10px 12px;border:1px solid #e5e7eb;border-radius:12px;background:#fff}.message.self{margin-left:auto;border-color:#99f6e4;background:#f0fdfa}.message header{display:flex;gap:12px;justify-content:space-between;color:#6b7280;font-size:.78rem}.message-text{white-space:pre-wrap;overflow-wrap:anywhere}.message-kind{color:#92400e}.coordinates{color:#6b7280;font-size:.8rem}.attachments{margin:8px 0 0;padding-left:20px;color:#0f766e}.attachments span{color:#6b7280}";
  }

  function exportAttachmentCsv() {
    var lines = ["path,size,mime"]; 
    state.attachmentFiles.forEach(function (file) {
      lines.push([relativePath(file), file.size, file.type || ""].map(csvEscape).join(","));
    });
    downloadText("line-attachments.csv", "\ufeff" + lines.join("\n"), "text/csv;charset=utf-8");
  }

  function clearWorkspace(resetInput) {
    if (state.database) {
      try { state.database.close(); } catch (error) { console.warn(error); }
    }
    state.database = null;
    state.sqlReady = false;
    state.files = [];
    state.fileByPath = new Map();
    state.chats = [];
    state.chatPage = 1;
    state.users.clear();
    state.groupsById.clear();
    state.groupsByPk.clear();
    state.groupNamesByChatPk.clear();
    state.groupMemberNamesByChatPk.clear();
    state.currentChat = null;
    state.currentMessages = [];
    state.currentOffset = 0;
    state.attachmentFiles = [];
    state.attachmentByBasename = new Map();
    state.attachmentByToken = new Map();
    state.sourceSize = 0;
    if (resetInput !== false && el.folderInput) el.folderInput.value = "";
    if (resetInput !== false && el.databaseInput) el.databaseInput.value = "";
    if (el.workspace) el.workspace.classList.add("hidden");
    if (el.chatList) el.chatList.innerHTML = "";
    if (el.chatPageInfo) el.chatPageInfo.textContent = "第 1 頁";
    if (el.chatPrevButton) el.chatPrevButton.disabled = true;
    if (el.chatNextButton) el.chatNextButton.disabled = true;
    if (el.messageList) el.messageList.innerHTML = '<div class="empty-state">尚未選取聊天室。</div>';
    if (el.attachmentPreview) el.attachmentPreview.innerHTML = "";
    if (el.exportHtmlButton) el.exportHtmlButton.disabled = true;
    if (el.exportJsonButton) el.exportJsonButton.disabled = true;
    if (el.exportAttachmentsButton) el.exportAttachmentsButton.disabled = true;
    if (el.selectedChatTitle) el.selectedChatTitle.textContent = "選取聊天室";
    if (el.selectedChatMeta) el.selectedChatMeta.textContent = "請從左側選取聊天室開始。";
    if (el.messageStatus) el.messageStatus.textContent = "";
    if (el.chatCount) el.chatCount.textContent = "—";
    if (el.messageCount) el.messageCount.textContent = "—";
    if (el.attachmentCount) el.attachmentCount.textContent = "—";
    if (el.sourceSize) el.sourceSize.textContent = "—";
    if (el.progressBar) setProgress(0);
    if (el.runtimeBadge) setRuntime("等待選取", false);
  }

  function safeQuery(sql, params) {
    try {
      return query(sql, params);
    } catch (error) {
      console.warn("SQL query failed", sql, error);
      return [];
    }
  }

  function buildAttachmentIndex() {
    state.attachmentByBasename = new Map();
    state.attachmentByToken = new Map();
    state.attachmentFiles.forEach(function (file) {
      var path = relativePath(file);
      var basename = normalizeFileName(fileNameOf(path));
      if (basename) addToIndex(state.attachmentByBasename, basename, file);
      extractInternalTokens(path).forEach(function (token) {
        addToIndex(state.attachmentByToken, token, file);
      });
    });
  }

  function addToIndex(index, key, file) {
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(file);
  }

  function extractAttachmentHints(blob, messageId) {
    var strings = extractBinaryPlistStrings(blob);
    var hints = [];
    strings.forEach(function (value) {
      var cleaned = value.replace(/[\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u000b\u000c\u000e\u000f]/g, "").trim();
      var extensionPattern = "jpg|jpeg|png|gif|webp|heic|mp4|mov|m4a|mp3|aac|caf|amr|pdf|zip|xlsx|xls|doc|docx|txt|csv|webm";
      var extensionOnly = cleaned.match(new RegExp("^(" + extensionPattern + ")$", "i"));
      var filenameMatch = cleaned.match(new RegExp("([A-Za-z0-9_\\-\\u0080-\\uFFFF .()]{3,180}\\.((?:" + extensionPattern + ")))(?:[^A-Za-z0-9]|$)", "i"));
      var detectedExtension = extensionOnly ? extensionOnly[1] : (filenameMatch ? filenameMatch[2] : "");
      if (messageId && detectedExtension) {
        var generatedName = messageId + "." + detectedExtension.toLowerCase();
        if (hints.indexOf(generatedName) === -1) hints.push(generatedName);
      }
      var uriMatch = cleaned.match(/(?:file|https?):\/\/[^\s"']+/i);
      var candidate = uriMatch ? uriMatch[0].split(/[?#]/)[0] : (filenameMatch ? filenameMatch[1] : cleaned);
      var basename = fileNameOf(candidate).replace(/[._-]+$/g, "");
      if (!basename || !/\.[A-Za-z0-9]{1,8}$/.test(basename)) return;
      if (!/\.(?:jpg|jpeg|png|gif|webp|heic|mp4|mov|m4a|mp3|aac|caf|amr|pdf|zip|xlsx|xls|doc|docx|txt|csv|webm)$/i.test(basename)) return;
      if (hints.indexOf(basename) === -1) hints.push(basename);
    });
    return hints;
  }

  function extractBinaryPlistStrings(blob) {
    if (!blob) return [];
    var bytes = blob instanceof Uint8Array ? blob : (blob.buffer ? new Uint8Array(blob.buffer, blob.byteOffset || 0, blob.byteLength) : null);
    if (!bytes || !bytes.length) return [];
    var decoded = [];
    ["utf-8", "utf-16be", "utf-16le"].forEach(function (encoding) {
      try { decoded.push(new TextDecoder(encoding).decode(bytes)); } catch (error) { /* optional decoder */ }
    });
    var values = [];
    var ascii = "";
    function flushAscii() {
      var value = ascii.trim();
      if (value.length >= 3 && value.length <= 512) values.push(value);
      ascii = "";
    }
    for (var i = 0; i < bytes.length; i += 1) {
      if (bytes[i] >= 32 && bytes[i] <= 126) ascii += String.fromCharCode(bytes[i]);
      else flushAscii();
    }
    flushAscii();
    decoded.forEach(function (text) {
      text.split(/[\u0000-\u001f\u007f]+/).forEach(function (part) {
        var value = part.trim();
        if (value.length >= 3 && value.length <= 512) values.push(value);
      });
    });
    return Array.from(new Set(values));
  }

  function resolveAttachments(blob, messageId) {
    var hints = extractAttachmentHints(blob, messageId);
    var candidates = [];
    hints.forEach(function (hint) {
      var files = state.attachmentByBasename.get(normalizeFileName(hint)) || [];
      files.forEach(function (file) {
        candidates.push({file: file, status: files.length === 1 ? "exact" : "ambiguous", hint: hint});
      });
    });
    var tokens = extractInternalTokens(extractBinaryPlistStrings(blob).join(" "));
    tokens.forEach(function (token) {
      (state.attachmentByToken.get(token) || []).forEach(function (file) {
        candidates.push({file: file, status: "token", hint: token});
      });
    });
    var unique = new Map();
    candidates.forEach(function (candidate) {
      var path = relativePath(candidate.file);
      if (!unique.has(path) || unique.get(path).status === "token") unique.set(path, candidate);
    });
    return Array.from(unique.values()).slice(0, 8).map(function (candidate) {
      return {
        name: candidate.file.name,
        path: relativePath(candidate.file),
        size: candidate.file.size,
        mime: candidate.file.type || "",
        linkStatus: candidate.status,
        hint: candidate.hint
      };
    });
  }

  function appendAttachmentLinks(card, attachments) {
    if (!attachments || !attachments.length) return;
    var list = document.createElement("ul");
    list.className = "message-attachments";
    attachments.forEach(function (attachment) {
      var file = state.fileByPath.get(attachment.path);
      var item = document.createElement("li");
      if (file) {
        var link = document.createElement("a");
        link.href = URL.createObjectURL(file);
        link.download = file.name;
        link.textContent = file.name + " (" + formatBytes(file.size) + ")";
        link.title = attachment.linkStatus === "ambiguous" ? "檔名重複，這是可能的附件" : "下載原始附件";
        item.appendChild(link);
      } else {
        item.textContent = attachment.name;
      }
      if (attachment.linkStatus !== "exact") {
        var status = document.createElement("small");
        status.textContent = " · " + (attachment.linkStatus === "ambiguous" ? "可能附件" : "候選附件");
        item.appendChild(status);
      }
      list.appendChild(item);
    });
    card.appendChild(list);
  }

  function sanitizeMessageForExport(message) {
    return {
      pk: message.pk,
      id: message.id,
      timestampRaw: message.timestampRaw,
      timestamp: message.timestamp ? message.timestamp.toISOString() : null,
      senderId: message.senderId,
      sender: message.sender,
      isSelf: message.isSelf,
      contentType: message.contentType,
      messageType: message.messageType,
      kind: message.kind,
      text: message.text,
      latitude: message.latitude,
      longitude: message.longitude,
      attachmentHints: message.attachmentHints,
      attachments: message.attachments
    };
  }

  function fileNameOf(path) {
    var normalized = String(path || "").replace(/\\/g, "/").split(/[?#]/)[0];
    var pieces = normalized.split("/");
    return pieces[pieces.length - 1] || "";
  }

  function normalizeFileName(name) {
    return String(name || "").trim().normalize("NFKC").toLowerCase();
  }

  function extractInternalTokens(value) {
    var matches = String(value || "").match(/(?:u[a-f0-9]{32}|c[a-f0-9]{32})/gi) || [];
    return Array.from(new Set(matches.map(function (match) { return match.toLowerCase(); })));
  }

  function messageKind(contentType, messageType, text) {
    if (text) return "text";
    var code = Number(contentType);
    var known = { 1: "image", 2: "video", 3: "audio", 4: "file", 5: "sticker", 6: "location", 7: "system", 9: "contact", 12: "poll", 13: "call", 14: "file", 16: "image", 17: "video", 18: "audio", 96: "system", 100: "sticker", 101: "sticker", 107: "file", 111: "system", 112: "unknown" };
    return known[code] || (messageType || "unknown");
  }

  function typeLabel(type) {
    return { direct: "單人聊天室", group: "群組聊天室", community: "社群", unknown: "未知類型" }[type] || "聊天室";
  }

  function chatTypeLabel(chatType) {
    if (Number(chatType) === 0) return "direct";
    if (Number(chatType) === 100) return "community";
    if (Number(chatType) === 1 || Number(chatType) === 2) return "group";
    return "unknown";
  }

  function titleSourceLabel(source) {
    return {
      user: "LINE 使用者資料",
      rename: "群組改名系統訊息",
      group: "LINE 群組資料",
      members: "群組成員名稱",
      unresolved: "尚未找到可靠名稱"
    }[source] || "未知來源";
  }

  function formatMemberTitle(names) {
    var visibleNames = names.slice(0, 8);
    var title = visibleNames.join("、");
    if (names.length > visibleNames.length) title += "…（共" + names.length + "位）";
    return title || "未命名群組";
  }

  function toUint8Array(value) {
    if (value instanceof Uint8Array) return value;
    if (value && value.buffer && Number.isFinite(value.byteLength)) {
      return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength);
    }
    if (Array.isArray(value)) return new Uint8Array(value);
    return null;
  }

  function bytesToHex(bytes, offset, length) {
    var hex = "";
    for (var i = offset; i < offset + length; i += 1) hex += bytes[i].toString(16).padStart(2, "0");
    return hex;
  }

  function normalizeTimestamp(value) {
    var number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    if (number < 100000000000) number *= 1000;
    var date = new Date(number);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDate(date, includeTime) {
    if (!date) return "未知時間";
    return new Intl.DateTimeFormat("zh-TW", includeTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "short" }).format(date);
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("zh-TW").format(Number(value) || 0);
  }

  function formatBytes(bytes) {
    var value = Number(bytes) || 0;
    if (value < 1024) return value + " B";
    var units = ["KB", "MB", "GB", "TB"];
    var index = -1;
    do { value /= 1024; index += 1; } while (value >= 1024 && index < units.length - 1);
    return value.toFixed(value >= 10 ? 1 : 2) + " " + units[index];
  }

  function stringOrEmpty(value) { return value === null || value === undefined ? "" : String(value); }
  function numberOrNull(value) { var number = Number(value); return Number.isFinite(number) ? number : null; }
  function firstNonEmpty() {
    for (var i = 0; i < arguments.length; i += 1) if (arguments[i] !== null && arguments[i] !== undefined && String(arguments[i]).trim()) return String(arguments[i]);
    return "";
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>\"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character];
    });
  }

  function csvEscape(value) {
    var text = String(value === null || value === undefined ? "" : value);
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function slugify(value) {
    return String(value || "chat").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "chat";
  }

  function downloadText(filename, content, type) {
    var blob = new Blob([content], { type: type });
    downloadBlob(filename, blob);
  }

  function downloadBlob(filename, blob) {
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
}());
