/* global initSqlJs, fflate */

(function () {
  "use strict";

  var SQL_WASM_CDN = "https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/";
  var MESSAGE_PAGE_SIZE = 180;
  var CHAT_ITEM_FALLBACK_HEIGHT = 65;
  var MAX_ATTACHMENT_PREVIEW = 120;
  var ATTACHMENT_CLEANUP_PAGE_SIZE = 30;
  var MAX_BLOB_CANDIDATE_BYTES = 256 * 1024 * 1024;
  var chatResizeTimer = null;
  var packageInProgress = false;

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
    attachmentByMessageId: new Map(),
    attachmentByToken: new Map(),
    attachmentCleanupPage: 1,
    attachmentCleanupSearch: "",
    attachmentsMarkedForRemoval: new Set(),
    objectUrls: new Set(),
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
    el.attachmentSearch = document.getElementById("attachmentSearch");
    el.markedAttachmentCount = document.getElementById("markedAttachmentCount");
    el.markedAttachmentSize = document.getElementById("markedAttachmentSize");
    el.attachmentCleanupList = document.getElementById("attachmentCleanupList");
    el.attachmentPrevButton = document.getElementById("attachmentPrevButton");
    el.attachmentNextButton = document.getElementById("attachmentNextButton");
    el.attachmentPageInfo = document.getElementById("attachmentPageInfo");
    el.markFilteredAttachmentsButton = document.getElementById("markFilteredAttachmentsButton");
    el.keepAllAttachmentsButton = document.getElementById("keepAllAttachmentsButton");
    el.clearAttachmentSelectionButton = document.getElementById("clearAttachmentSelectionButton");
    el.exportCleanupPlanButton = document.getElementById("exportCleanupPlanButton");
    el.exportCleanupTextButton = document.getElementById("exportCleanupTextButton");
    el.buildImazingCandidateButton = document.getElementById("buildImazingCandidateButton");
    el.cleanupPackageStatus = document.getElementById("cleanupPackageStatus");

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
    el.attachmentSearch.addEventListener("input", function (event) {
      state.attachmentCleanupSearch = event.target.value.trim().toLowerCase();
      state.attachmentCleanupPage = 1;
      renderAttachmentCleanup();
    });
    el.attachmentPrevButton.addEventListener("click", function () {
      if (state.attachmentCleanupPage > 1) {
        state.attachmentCleanupPage -= 1;
        renderAttachmentCleanup();
      }
    });
    el.attachmentNextButton.addEventListener("click", function () {
      var totalPages = getAttachmentCleanupTotalPages();
      if (state.attachmentCleanupPage < totalPages) {
        state.attachmentCleanupPage += 1;
        renderAttachmentCleanup();
      }
    });
    el.keepAllAttachmentsButton.addEventListener("click", function () {
      state.attachmentsMarkedForRemoval.clear();
      renderAttachmentCleanup();
    });
    el.markFilteredAttachmentsButton.addEventListener("click", function () {
      getFilteredAttachmentFiles().forEach(function (file) {
        state.attachmentsMarkedForRemoval.add(relativePath(file));
      });
      renderAttachmentCleanup();
    });
    el.clearAttachmentSelectionButton.addEventListener("click", function () {
      getFilteredAttachmentFiles().forEach(function (file) {
        state.attachmentsMarkedForRemoval.delete(relativePath(file));
      });
      renderAttachmentCleanup();
    });
    el.attachmentCleanupList.addEventListener("change", function (event) {
      var checkbox = event.target.closest("input[data-attachment-path]");
      if (!checkbox) return;
      var path = checkbox.getAttribute("data-attachment-path");
      if (checkbox.checked) state.attachmentsMarkedForRemoval.add(path);
      else state.attachmentsMarkedForRemoval.delete(path);
      renderAttachmentCleanup();
    });
    el.exportCleanupPlanButton.addEventListener("click", exportAttachmentCleanupPlan);
    el.exportCleanupTextButton.addEventListener("click", exportAttachmentCleanupInstructions);
    el.buildImazingCandidateButton.addEventListener("click", buildImazingCandidatePackage);
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
      state.attachmentCleanupPage = 1;
      state.attachmentCleanupSearch = "";
      state.attachmentsMarkedForRemoval = new Set();
      if (el.attachmentSearch) el.attachmentSearch.value = "";
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
      renderAttachmentCleanup();
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
      "m.ZSENDER AS senderPk, m.ZSENDSTATUS AS sendStatus, m.ZCONTENTTYPE AS contentType, m.ZTEXT AS text, " +
      "m.ZMESSAGETYPE AS messageType, m.ZLATITUDE AS latitude, m.ZLONGITUDE AS longitude, " +
      "m.ZCONTENTMETADATA AS contentMetadata, m.ZTHUMBNAIL AS thumbnail " +
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
    var hasSender = row.senderPk !== null && row.senderPk !== undefined && row.senderPk !== "";
    var sender = hasSender ? state.users.get("pk:" + numberOrNull(row.senderPk)) : null;
    var text = stringOrEmpty(row.text);
    var call = extractCallInfo(row.contentType, row.contentMetadata, text, row.latitude, row.longitude);
    var kind = call ? "call" : messageKind(row.contentType, row.messageType, text);
    var messageId = stringOrEmpty(row.messageId);
    var sendStatus = numberOrNull(row.sendStatus);
    var isSystem = isSystemMessage(row.contentType, messageId, hasSender, sendStatus, call);
    var isSelf = Boolean(
      (sender && state.selfId && sender.id === state.selfId) ||
      (!hasSender && !isSystem && (sendStatus === 1 || stringOrEmpty(row.messageType).toUpperCase() === "S"))
    );
    var attachmentHints = extractAttachmentHints(row.contentMetadata, messageId);
    var linkPreviews = extractLinkPreviews(row.contentMetadata, text, row.contentType);
    return {
      pk: numberOrNull(row.messagePk),
      id: messageId,
      timestampRaw: row.timestamp,
      timestamp: normalizeTimestamp(row.timestamp),
      senderId: sender ? sender.id : "",
      sender: isSelf ? "我" : (isSystem ? "系統" : (sender ? sender.name : "未知使用者")),
      isSelf: isSelf,
      isSystem: isSystem,
      sendStatus: sendStatus,
      contentType: row.contentType,
      messageType: stringOrEmpty(row.messageType),
      kind: kind,
      call: call,
      text: text,
      latitude: numberOrNull(row.latitude),
      longitude: numberOrNull(row.longitude),
      thumbnail: toUint8Array(row.thumbnail),
      linkPreviews: linkPreviews,
      attachmentHints: attachmentHints,
      attachments: resolveAttachments(row.contentMetadata, messageId, attachmentHints)
    };
  }

  function isSystemMessage(contentType, messageId, hasSender, sendStatus, call) {
    var code = Number(contentType);
    if (call && call.isGroup) return true;
    if (code === 7 || code === 18 || code === 96 || code === 111) return true;
    return !hasSender && sendStatus === 0 && !messageId;
  }

  function renderMessages() {
    revokeObjectUrls();
    el.messageList.innerHTML = "";
    if (!state.currentMessages.length) {
      el.messageList.innerHTML = '<div class="empty-state">這個聊天室沒有可顯示的訊息。</div>';
      el.messageStatus.textContent = "";
      return;
    }
    var fragment = document.createDocumentFragment();
    state.currentMessages.forEach(function (message) {
      var row = document.createElement("article");
      row.className = "message-row" + (message.isSystem ? " system" : (message.isSelf ? " self" : ""));
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
      if (message.call) {
        var call = document.createElement("p");
        call.className = "message-call" + (isUnansweredCall(message.call) ? " unanswered" : "");
        call.textContent = "☎︎ " + formatCallLabel(message.call, message.isSelf);
        card.appendChild(call);
      } else if (message.text) {
        var body = document.createElement("p");
        body.className = "message-text";
        appendLinkedText(body, message.text);
        card.appendChild(body);
      } else {
        var kind = document.createElement("p");
        kind.className = "message-kind";
        kind.textContent = "[" + message.kind + "]";
        card.appendChild(kind);
      }
      if (hasValidLocation(message)) {
        var coordinates = document.createElement("p");
        coordinates.className = "message-coordinates";
        coordinates.textContent = "位置：" + message.latitude + ", " + message.longitude;
        card.appendChild(coordinates);
      }
      appendLinkPreviews(card, message.linkPreviews);
      appendImagePreviews(card, message);
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

  function getFilteredAttachmentFiles() {
    var search = state.attachmentCleanupSearch;
    return state.attachmentFiles.filter(function (file) {
      if (!search) return true;
      var path = relativePath(file).toLowerCase();
      return path.indexOf(search) !== -1;
    });
  }

  function getAttachmentCleanupTotalPages() {
    return Math.max(1, Math.ceil(getFilteredAttachmentFiles().length / ATTACHMENT_CLEANUP_PAGE_SIZE));
  }

  function archiveRelativePath(file) {
    var path = relativePath(file);
    var root = state.sourceMode === "folder" ? state.sourceRoot : "";
    if (root && path.indexOf(root + "/") === 0) return path.slice(root.length + 1);
    return path;
  }

  function attachmentCategory(path) {
    return /\/Message Thumbnails\//.test(path) ? "縮圖" : "原始附件";
  }

  function setCleanupPackageStatus(text, isError) {
    if (!el.cleanupPackageStatus) return;
    el.cleanupPackageStatus.textContent = text;
    el.cleanupPackageStatus.classList.toggle("error", Boolean(isError));
  }

  function renderAttachmentCleanup() {
    var databaseOnly = state.sourceMode === "database";
    var hasFiles = !databaseOnly && state.attachmentFiles.length > 0;
    var filtered = getFilteredAttachmentFiles();
    var totalPages = getAttachmentCleanupTotalPages();
    state.attachmentCleanupPage = Math.min(state.attachmentCleanupPage, totalPages);
    var start = (state.attachmentCleanupPage - 1) * ATTACHMENT_CLEANUP_PAGE_SIZE;
    var pageFiles = filtered.slice(start, start + ATTACHMENT_CLEANUP_PAGE_SIZE);

    if (databaseOnly) {
      el.attachmentCleanupList.innerHTML = '<div class="empty-state">只讀訊息模式沒有載入附件檔案；請切換為完整 LINE 備份後使用附件瘦身。</div>';
    } else if (!hasFiles) {
      el.attachmentCleanupList.innerHTML = '<div class="empty-state">沒有可供瘦身的附件或縮圖。</div>';
    } else if (!filtered.length) {
      el.attachmentCleanupList.innerHTML = '<div class="empty-state">找不到符合搜尋條件的附件。</div>';
    } else {
      var rows = pageFiles.map(function (file) {
        var path = relativePath(file);
        var archivePath = archiveRelativePath(file);
        var checked = state.attachmentsMarkedForRemoval.has(path) ? " checked" : "";
        return '<label class="attachment-cleanup-row"><input type="checkbox" data-attachment-path="' + escapeHtml(path) + '"' + checked + '><span class="attachment-cleanup-main"><span class="file-name">' + escapeHtml(archivePath) + '</span><small>' + escapeHtml(attachmentCategory(archivePath) + " · " + (file.type || "未知")) + '</small></span><span class="attachment-cleanup-size">' + escapeHtml(formatBytes(file.size)) + '</span></label>';
      }).join("");
      el.attachmentCleanupList.innerHTML = rows;
    }

    var markedFiles = getMarkedAttachmentFiles();
    var markedSize = markedFiles.reduce(function (sum, file) { return sum + (Number(file.size) || 0); }, 0);
    el.markedAttachmentCount.textContent = formatNumber(markedFiles.length);
    el.markedAttachmentSize.textContent = formatBytes(markedSize);
    el.attachmentPageInfo.textContent = hasFiles ? "第 " + state.attachmentCleanupPage + " / " + totalPages + " 頁" : "第 1 頁";
    el.attachmentPrevButton.disabled = !hasFiles || state.attachmentCleanupPage <= 1;
    el.attachmentNextButton.disabled = !hasFiles || state.attachmentCleanupPage >= totalPages;
    el.markFilteredAttachmentsButton.disabled = !hasFiles || filtered.length === 0;
    el.keepAllAttachmentsButton.disabled = !hasFiles || markedFiles.length === 0;
    el.clearAttachmentSelectionButton.disabled = !hasFiles || markedFiles.length === 0;
    el.exportCleanupPlanButton.disabled = !hasFiles;
    el.exportCleanupTextButton.disabled = !hasFiles;
    el.buildImazingCandidateButton.disabled = !hasFiles || packageInProgress;
  }

  function getMarkedAttachmentFiles() {
    return state.attachmentFiles.filter(function (file) {
      return state.attachmentsMarkedForRemoval.has(relativePath(file));
    });
  }

  function buildAttachmentCleanupPlan() {
    var markedFiles = getMarkedAttachmentFiles();
    var markedSize = markedFiles.reduce(function (sum, file) { return sum + (Number(file.size) || 0); }, 0);
    var lineFile = state.sourceMode === "folder" ? findFileEnding("/Messages/Line.sqlite") : state.files[0];
    return {
      schemaVersion: "0.1",
      planType: "line-attachment-cleanup",
      generatedAt: new Date().toISOString(),
      source: {
        mode: state.sourceMode,
        selectedRoot: state.sourceRoot,
        totalFiles: state.files.length,
        totalBytes: state.sourceSize,
        lineSqlitePath: lineFile ? archiveRelativePath(lineFile) : "",
        lineSqliteLastModified: lineFile && lineFile.lastModified ? new Date(lineFile.lastModified).toISOString() : null
      },
      policy: {
        originalFilesAreUntouched: true,
        keepAllFilesNotListed: true,
        estimatedReleaseBytes: markedSize,
        estimatedRemainingBytes: Math.max(0, state.sourceSize - markedSize),
        hashStatus: "未計算；此階段只輸出操作計畫"
      },
      markedForRemoval: markedFiles.map(function (file) {
        return {
          path: archiveRelativePath(file),
          category: attachmentCategory(archiveRelativePath(file)),
          size: Number(file.size) || 0,
          mime: file.type || "",
          lastModified: file.lastModified ? new Date(file.lastModified).toISOString() : null
        };
      }),
      warnings: [
        "這不是已驗證可直接還原的 .imazingapp；請在副本上執行。",
        "請保留 Container、Messages/Line.sqlite 與所有未列出的檔案。",
        "刪除原始附件可能使 LINE 聊天中的媒體無法開啟；刪除縮圖通常只會移除預覽圖。",
        "瀏覽器無法保證保留或設定 macOS 檔案的 creation time；SQLite 內的訊息時間不會由本計畫改寫。"
      ]
    };
  }

  function exportAttachmentCleanupPlan() {
    if (!state.attachmentFiles.length) return;
    var plan = buildAttachmentCleanupPlan();
    downloadText("line-attachment-cleanup-plan.json", JSON.stringify(plan, null, 2), "application/json;charset=utf-8");
  }

  function exportAttachmentCleanupInstructions() {
    if (!state.attachmentFiles.length) return;
    var plan = buildAttachmentCleanupPlan();
    var lines = [
      "LINE 附件瘦身操作說明",
      "====================",
      "產生時間：" + plan.generatedAt,
      "來源根目錄：" + (plan.source.selectedRoot || "（單檔模式）"),
      "標記移除：" + formatNumber(plan.markedForRemoval.length) + " 個檔案",
      "預估釋放：" + formatBytes(plan.policy.estimatedReleaseBytes),
      "",
      "安全操作順序：",
      "1. 保留原始 LINE.imazingapp，不要直接覆寫。",
      "2. 複製一份工作副本，再將副本副檔名改成 .zip。",
      "3. 使用支援原地編輯壓縮檔的工具，依下方路徑移除檔案。不要把整個封存檔解壓後重新壓縮。",
      "4. 確認 Container、Messages/Line.sqlite 與未列出的檔案都保留。",
      "5. 將工作副本改回 .imazingapp；在 iMazing 的 Manage Apps > Restore App Data 中先做 dry-run。",
      "6. 只有在確認 iMazing 接受檔案後，才考慮於測試裝置還原；原始檔仍須保留。",
      "",
      "標記移除的檔案："
    ];
    if (!plan.markedForRemoval.length) lines.push("（目前沒有標記，所有檔案都應保留）");
    plan.markedForRemoval.forEach(function (entry) {
      lines.push("- " + entry.path + " · " + entry.category + " · " + formatBytes(entry.size));
    });
    lines.push("", "注意：這份清單不會改寫 SQLite，也不能承諾保留 macOS creation time；LINE 訊息時間來自 SQLite。");
    downloadText("line-attachment-cleanup-instructions.txt", lines.join("\n"), "text/plain;charset=utf-8");
  }

  function getCandidateBackupFiles() {
    return state.files.filter(function (file) {
      var path = archiveRelativePath(file);
      return path === ".lock" || path === "iTunesArtwork" || path === "iTunesMetadata.plist" || path.indexOf("Container/") === 0 || path.indexOf("Payload/") === 0;
    });
  }

  function safeArchivePath(path) {
    return String(path || "").replace(/\\/g, "/").split("/").filter(function (part) {
      return part && part !== "." && part !== "..";
    }).join("/");
  }

  function candidateFilename() {
    return "LINE-slimmed-" + new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") + ".imazingapp.candidate";
  }

  async function openCandidateOutput(filename) {
    if (typeof window.showSaveFilePicker === "function") {
      var handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "iMazing 候選封裝", accept: { "application/octet-stream": [".imazingapp.candidate", ".imazingapp"] } }]
      });
      return { writable: await handle.createWritable(), chunks: [], bytes: 0, pending: Promise.resolve(), error: null, closed: false };
    }
    return { writable: null, chunks: [], bytes: 0, pending: Promise.resolve(), error: null, closed: false };
  }

  function queueCandidateChunk(output, chunk) {
    if (!chunk || !chunk.length) return;
    output.bytes += chunk.length;
    if (output.writable) {
      output.pending = output.pending.then(function () { return output.writable.write(chunk); });
    } else {
      output.chunks.push(chunk);
    }
  }

  async function flushCandidateOutput(output) {
    await output.pending;
    if (output.error) throw output.error;
  }

  function updateCandidateProgress(processedBytes, totalBytes, processedFiles, totalFiles) {
    var percent = totalBytes ? Math.round(processedBytes / totalBytes * 100) : 100;
    setCleanupPackageStatus("正在建立候選封裝… " + percent + "%（" + formatNumber(processedFiles) + " / " + formatNumber(totalFiles) + " 個檔案）", false);
  }

  async function writeCandidateZip(files, output) {
    var zipApi = window.fflate;
    if (!zipApi || typeof zipApi.Zip !== "function" || typeof zipApi.ZipPassThrough !== "function") {
      throw new Error("無法載入 ZIP 封裝引擎；請確認網路連線後重新整理頁面。");
    }
    var totalBytes = files.reduce(function (sum, file) { return sum + (Number(file.size) || 0); }, 0);
    var processedBytes = 0;
    var processedFiles = 0;
    var zip = new zipApi.Zip(function (error, chunk) {
      if (error) {
        output.error = error;
        return;
      }
      queueCandidateChunk(output, chunk);
    });

    for (var index = 0; index < files.length; index += 1) {
      var file = files[index];
      var archivePath = safeArchivePath(archiveRelativePath(file));
      if (!archivePath) continue;
      var entry = new zipApi.ZipPassThrough(archivePath);
      if (file.lastModified) entry.mtime = new Date(file.lastModified);
      zip.add(entry);
      if (typeof file.stream === "function") {
        var reader = file.stream().getReader();
        try {
          while (true) {
            var result = await reader.read();
            if (result.done) break;
            entry.push(result.value, false);
            await flushCandidateOutput(output);
          }
        } finally {
          reader.releaseLock();
        }
      } else {
        entry.push(new Uint8Array(await file.arrayBuffer()), false);
        await flushCandidateOutput(output);
      }
      entry.push(new Uint8Array(0), true);
      await flushCandidateOutput(output);
      processedBytes += Number(file.size) || 0;
      processedFiles += 1;
      updateCandidateProgress(processedBytes, totalBytes, processedFiles, files.length);
    }
    zip.end();
    await flushCandidateOutput(output);
    if (output.writable && !output.closed) {
      await output.writable.close();
      output.closed = true;
    }
    return output;
  }

  async function buildImazingCandidatePackage() {
    if (packageInProgress || state.sourceMode !== "folder" || !state.attachmentFiles.length) return;
    var allCandidateFiles = getCandidateBackupFiles();
    var markedPaths = new Set(getMarkedAttachmentFiles().map(function (file) { return relativePath(file); }));
    var packageFiles = allCandidateFiles.filter(function (file) { return !markedPaths.has(relativePath(file)); });
    var packageInputBytes = packageFiles.reduce(function (sum, file) { return sum + (Number(file.size) || 0); }, 0);
    var canStreamToFile = typeof window.showSaveFilePicker === "function";
    var hasContainer = packageFiles.some(function (file) { return archiveRelativePath(file).indexOf("Container/") === 0; });
    var lineFile = findFileEnding("/Messages/Line.sqlite");
    var hasLineSqlite = Boolean(lineFile && packageFiles.indexOf(lineFile) !== -1);
    var hasLock = packageFiles.some(function (file) { return archiveRelativePath(file) === ".lock"; });
    if (!hasContainer) {
      setCleanupPackageStatus("無法建立候選封裝：選取的資料夾沒有 Container/；請選取包含 Container 與 Payload 的完整 iMazing 備份資料夾。", true);
      return;
    }
    if (!hasLineSqlite) {
      setCleanupPackageStatus("無法建立候選封裝：Messages/Line.sqlite 不在保留檔案中。", true);
      return;
    }
    if (!canStreamToFile && packageInputBytes > MAX_BLOB_CANDIDATE_BYTES) {
      setCleanupPackageStatus("目前瀏覽器不支援直接寫入大型檔案；候選封裝預估超過 256 MB，請改用支援 File System Access API 的 Chrome／Edge 桌面版，以避免 Blob 下載造成記憶體峰值。", true);
      return;
    }

    packageInProgress = true;
    renderAttachmentCleanup();
    setCleanupPackageStatus("準備建立候選封裝…", false);
    var output = null;
    try {
      var filename = candidateFilename();
      output = await openCandidateOutput(filename);
      await writeCandidateZip(packageFiles, output);
      if (!output.writable) {
        downloadBlob(filename, new Blob(output.chunks, { type: "application/octet-stream" }));
      }
      var warnings = [];
      if (!hasLock) warnings.push("來源沒有 .lock，無法視為正式 iMazing 封裝");
      if (!packageFiles.some(function (file) { return archiveRelativePath(file).indexOf("Payload/") === 0; })) warnings.push("來源沒有 Payload/，請以 iMazing dry-run 驗證");
      warnings.push("此候選封裝由瀏覽器重新建立，尚未通過 iMazing 實機還原");
      setCleanupPackageStatus("候選封裝已建立：" + formatBytes(output.bytes) + "，保留 " + formatNumber(packageFiles.length) + " 個檔案。" + (warnings.length ? " 警告：" + warnings.join("；") + "。" : ""), Boolean(warnings.length));
    } catch (error) {
      if (output && output.writable && !output.closed) {
        try { await output.writable.abort(); } catch (abortError) { console.warn(abortError); }
      }
      if (error && error.name === "AbortError") setCleanupPackageStatus("已取消候選封裝輸出。", false);
      else setCleanupPackageStatus("候選封裝失敗：" + (error && error.message ? error.message : String(error)), true);
      console.error(error);
    } finally {
      packageInProgress = false;
      renderAttachmentCleanup();
    }
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
      "m.ZSENDER AS senderPk, m.ZSENDSTATUS AS sendStatus, m.ZCONTENTTYPE AS contentType, m.ZTEXT AS text, " +
      "m.ZMESSAGETYPE AS messageType, m.ZLATITUDE AS latitude, m.ZLONGITUDE AS longitude, " +
      "m.ZCONTENTMETADATA AS contentMetadata " +
      "FROM ZMESSAGE m WHERE m.ZCHAT = $chatPk ORDER BY COALESCE(m.ZTIMESTAMP, 0) ASC, m.Z_PK ASC",
      { $chatPk: state.currentChat.pk }
    );
    return rows.map(mapMessage);
  }

  function buildChatHtml(chat, messages) {
    var body = messages.map(function (message) {
      var content = message.call
        ? '<p class="message-call' + (isUnansweredCall(message.call) ? " unanswered" : "") + '">☎︎ ' + escapeHtml(formatCallLabel(message.call, message.isSelf)) + '</p>'
        : (message.text ? '<p class="message-text">' + linkifyMessageHtml(message.text) + '</p>' : '<p class="message-kind">[' + escapeHtml(message.kind) + ']</p>');
      if (hasValidLocation(message)) {
        content += '<p class="coordinates">位置：' + escapeHtml(message.latitude + ", " + message.longitude) + '</p>';
      }
      content += buildLinkPreviewHtml(message.linkPreviews);
      if (message.attachments && message.attachments.length) {
        content += '<ul class="attachments">' + message.attachments.map(function (attachment) {
          return '<li>' + escapeHtml(attachment.name) + ' <span>(' + escapeHtml(formatBytes(attachment.size)) + ')</span></li>';
        }).join("") + '</ul>';
      }
      return '<article class="message ' + (message.isSystem ? "system" : (message.isSelf ? "self" : "")) + '"><header><strong>' + escapeHtml(message.sender) + '</strong><time>' + escapeHtml(formatDate(message.timestamp, true)) + '</time></header>' + content + '</article>';
    }).join("\n");
    var note = state.sourceMode === "database"
      ? "這份封存來自 Line.sqlite 只讀訊息模式；未載入附件檔案。"
      : "附件在目前閱讀器中提供本機下載連結；匯出的單一 HTML 會保留附件名稱與大小。";
    return '<!doctype html><html lang="zh-Hant-TW"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escapeHtml(chat.title) + '</title><style>' + exportCss() + '</style><main><h1>' + escapeHtml(chat.title) + '</h1><p class="meta">' + escapeHtml(typeLabel(chat.type) + " · " + formatNumber(messages.length) + " 則訊息") + '</p><p class="note">' + escapeHtml(note) + '</p><section>' + body + '</section></main></html>';
  }

  function exportCss() {
    return "body{margin:0;padding:24px;background:#f3f5f7;color:#1f2937;font:16px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}main{max-width:860px;margin:auto}h1{letter-spacing:-.03em}.meta,.note{color:#6b7280}.note{padding:10px 12px;border-radius:10px;background:#fff}.message{max-width:78%;margin:12px 0;padding:10px 12px;border:1px solid #e5e7eb;border-radius:12px;background:#fff}.message.self{margin-left:auto;border-color:#99f6e4;background:#f0fdfa}.message.system{margin-left:auto;margin-right:auto;border-style:dashed;color:#6b7280;background:#f8fafc}.message header{display:flex;gap:12px;justify-content:space-between;color:#6b7280;font-size:.78rem}.message-text{white-space:pre-wrap;overflow-wrap:anywhere}.message-text a{color:#0f766e;text-decoration:underline}.message-call{margin:0;font-weight:700;color:#0f766e}.message-call.unanswered{color:#b45309}.message-kind{color:#92400e}.coordinates{color:#6b7280;font-size:.8rem}.link-previews{display:grid;gap:8px;margin-top:9px}.link-preview{display:grid;grid-template-columns:minmax(0,1fr) 132px;overflow:hidden;border:1px solid #dbe4ea;border-radius:10px;color:inherit;text-decoration:none;background:#f8fafc}.link-preview.no-image{grid-template-columns:minmax(0,1fr)}.link-preview-content{min-width:0;padding:9px 10px}.link-preview-domain{display:block;color:#64748b;font-size:.72rem;text-transform:uppercase}.link-preview-title{display:block;margin-top:2px;font-weight:750}.link-preview-summary{display:-webkit-box;overflow:hidden;margin-top:3px;color:#64748b;font-size:.78rem;-webkit-box-orient:vertical;-webkit-line-clamp:2}.link-preview img{width:132px;height:100%;min-height:96px;object-fit:cover;background:#e2e8f0}.attachments{margin:8px 0 0;padding-left:20px;color:#0f766e}.attachments span{color:#6b7280}";
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
    state.attachmentByMessageId = new Map();
    state.attachmentByToken = new Map();
    state.attachmentCleanupPage = 1;
    state.attachmentCleanupSearch = "";
    state.attachmentsMarkedForRemoval = new Set();
    revokeObjectUrls();
    state.selfId = "";
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
    if (el.attachmentSearch) el.attachmentSearch.value = "";
    if (el.attachmentCleanupList) el.attachmentCleanupList.innerHTML = "";
    if (el.attachmentPageInfo) el.attachmentPageInfo.textContent = "第 1 頁";
    if (el.attachmentPrevButton) el.attachmentPrevButton.disabled = true;
    if (el.attachmentNextButton) el.attachmentNextButton.disabled = true;
    if (el.markFilteredAttachmentsButton) el.markFilteredAttachmentsButton.disabled = true;
    if (el.keepAllAttachmentsButton) el.keepAllAttachmentsButton.disabled = true;
    if (el.clearAttachmentSelectionButton) el.clearAttachmentSelectionButton.disabled = true;
    if (el.exportCleanupPlanButton) el.exportCleanupPlanButton.disabled = true;
    if (el.exportCleanupTextButton) el.exportCleanupTextButton.disabled = true;
    if (el.buildImazingCandidateButton) el.buildImazingCandidateButton.disabled = true;
    packageInProgress = false;
    setCleanupPackageStatus("候選封裝會保留未標記的 Container／Payload 檔案，但尚未經 iMazing 實機驗證。", false);
    if (el.markedAttachmentCount) el.markedAttachmentCount.textContent = "0";
    if (el.markedAttachmentSize) el.markedAttachmentSize.textContent = "0 B";
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
    state.attachmentByMessageId = new Map();
    state.attachmentByToken = new Map();
    state.attachmentFiles.forEach(function (file) {
      var path = relativePath(file);
      var basename = normalizeFileName(fileNameOf(path));
      if (basename) addToIndex(state.attachmentByBasename, basename, file);
      var messageIdMatch = basename.match(/^(\d{8,})(?:[_.-]|$)/);
      if (messageIdMatch) addToIndex(state.attachmentByMessageId, messageIdMatch[1], file);
      // Directory names contain the chat MID. Indexing the whole path would
      // make every message in that chat look related to every attachment.
      // Token matching is only useful when the token is part of the file name.
      extractInternalTokens(basename).forEach(function (token) {
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

  function extractBinaryPlistObjectStrings(blob) {
    var bytes = toUint8Array(blob);
    if (!bytes || bytes.length < 40) return [];
    var header = "";
    for (var headerIndex = 0; headerIndex < 8; headerIndex += 1) header += String.fromCharCode(bytes[headerIndex]);
    if (header !== "bplist00") return [];

    var trailerOffset = bytes.length - 32;
    var offsetSize = bytes[trailerOffset + 6];
    var objectCount = readBigEndianNumber(bytes, trailerOffset + 8, 8);
    var offsetTableOffset = readBigEndianNumber(bytes, trailerOffset + 24, 8);
    if (!offsetSize || !objectCount || objectCount > 100000 || offsetTableOffset >= bytes.length) return [];

    var strings = [];
    for (var objectIndex = 0; objectIndex < objectCount; objectIndex += 1) {
      var tableEntry = offsetTableOffset + objectIndex * offsetSize;
      if (tableEntry + offsetSize > trailerOffset) break;
      var objectOffset = readBigEndianNumber(bytes, tableEntry, offsetSize);
      if (objectOffset < 8 || objectOffset >= offsetTableOffset) continue;
      var marker = bytes[objectOffset];
      var objectType = marker >> 4;
      if (objectType !== 5 && objectType !== 6 && objectType !== 7) continue;
      var lengthInfo = binaryPlistLength(bytes, objectOffset, marker & 15);
      if (!lengthInfo || lengthInfo.length < 1 || lengthInfo.length > 4096) continue;
      try {
        var byteLength = objectType === 6 ? lengthInfo.length * 2 : lengthInfo.length;
        if (lengthInfo.dataOffset + byteLength > bytes.length) continue;
        var encoding = objectType === 6 ? "utf-16be" : "utf-8";
        strings.push(new TextDecoder(encoding).decode(bytes.slice(lengthInfo.dataOffset, lengthInfo.dataOffset + byteLength)));
      } catch (error) { /* Ignore malformed optional metadata strings. */ }
    }
    return strings;
  }

  function binaryPlistLength(bytes, objectOffset, compactLength) {
    if (compactLength < 15) return { length: compactLength, dataOffset: objectOffset + 1 };
    var lengthMarkerOffset = objectOffset + 1;
    if (lengthMarkerOffset >= bytes.length || bytes[lengthMarkerOffset] >> 4 !== 1) return null;
    var integerSize = Math.pow(2, bytes[lengthMarkerOffset] & 15);
    if (integerSize > 8 || lengthMarkerOffset + 1 + integerSize > bytes.length) return null;
    return {
      length: readBigEndianNumber(bytes, lengthMarkerOffset + 1, integerSize),
      dataOffset: lengthMarkerOffset + 1 + integerSize
    };
  }

  function readBigEndianNumber(bytes, offset, length) {
    var value = 0;
    for (var index = 0; index < length; index += 1) value = value * 256 + bytes[offset + index];
    return value;
  }

  function parseBinaryPropertyList(blob) {
    var bytes = toUint8Array(blob);
    if (!bytes || bytes.length < 40) return null;
    var header = "";
    for (var headerIndex = 0; headerIndex < 8; headerIndex += 1) header += String.fromCharCode(bytes[headerIndex]);
    if (header !== "bplist00") return null;

    var trailerOffset = bytes.length - 32;
    var offsetSize = bytes[trailerOffset + 6];
    var objectRefSize = bytes[trailerOffset + 7];
    var objectCount = readBigEndianNumber(bytes, trailerOffset + 8, 8);
    var topObject = readBigEndianNumber(bytes, trailerOffset + 16, 8);
    var offsetTableOffset = readBigEndianNumber(bytes, trailerOffset + 24, 8);
    if (!offsetSize || !objectRefSize || !objectCount || objectCount > 100000 || topObject >= objectCount || offsetTableOffset >= trailerOffset) return null;

    var offsets = [];
    for (var offsetIndex = 0; offsetIndex < objectCount; offsetIndex += 1) {
      var tableEntry = offsetTableOffset + offsetIndex * offsetSize;
      if (tableEntry + offsetSize > trailerOffset) return null;
      offsets.push(readBigEndianNumber(bytes, tableEntry, offsetSize));
    }

    var cache = new Array(objectCount);
    var parsed = new Array(objectCount).fill(false);

    function parseObject(objectIndex) {
      if (objectIndex < 0 || objectIndex >= objectCount) return null;
      if (parsed[objectIndex]) return cache[objectIndex];
      var objectOffset = offsets[objectIndex];
      if (objectOffset < 8 || objectOffset >= offsetTableOffset) return null;
      var marker = bytes[objectOffset];
      var objectType = marker >> 4;
      var compactLength = marker & 15;
      var lengthInfo;
      var byteLength;
      var value;
      var cursor;
      var itemIndex;

      if (objectType === 0) {
        value = compactLength === 9 ? true : (compactLength === 8 ? false : null);
      } else if (objectType === 1) {
        byteLength = Math.pow(2, compactLength);
        value = byteLength <= 8 && objectOffset + 1 + byteLength <= bytes.length
          ? readBigEndianNumber(bytes, objectOffset + 1, byteLength)
          : null;
      } else if (objectType === 2) {
        byteLength = Math.pow(2, compactLength);
        try {
          var dataView = new DataView(bytes.buffer, bytes.byteOffset + objectOffset + 1, byteLength);
          value = byteLength === 4 ? dataView.getFloat32(0, false) : (byteLength === 8 ? dataView.getFloat64(0, false) : null);
        } catch (error) { value = null; }
      } else if (objectType === 3 && compactLength === 3) {
        try {
          value = new Date((new DataView(bytes.buffer, bytes.byteOffset + objectOffset + 1, 8).getFloat64(0, false) + 978307200) * 1000);
        } catch (error) { value = null; }
      } else if (objectType === 4 || objectType === 5 || objectType === 6 || objectType === 7) {
        lengthInfo = binaryPlistLength(bytes, objectOffset, compactLength);
        if (!lengthInfo) return null;
        byteLength = objectType === 6 ? lengthInfo.length * 2 : lengthInfo.length;
        if (lengthInfo.dataOffset + byteLength > bytes.length) return null;
        if (objectType === 4) {
          value = bytes.slice(lengthInfo.dataOffset, lengthInfo.dataOffset + byteLength);
        } else {
          try {
            value = new TextDecoder(objectType === 6 ? "utf-16be" : "utf-8").decode(bytes.slice(lengthInfo.dataOffset, lengthInfo.dataOffset + byteLength));
          } catch (error) { value = ""; }
        }
      } else if (objectType === 8) {
        byteLength = compactLength + 1;
        value = objectOffset + 1 + byteLength <= bytes.length
          ? { __plistUid: readBigEndianNumber(bytes, objectOffset + 1, byteLength) }
          : null;
      } else if (objectType === 10 || objectType === 11 || objectType === 12) {
        lengthInfo = binaryPlistLength(bytes, objectOffset, compactLength);
        if (!lengthInfo || lengthInfo.dataOffset + lengthInfo.length * objectRefSize > bytes.length) return null;
        value = [];
        parsed[objectIndex] = true;
        cache[objectIndex] = value;
        cursor = lengthInfo.dataOffset;
        for (itemIndex = 0; itemIndex < lengthInfo.length; itemIndex += 1) {
          value.push(parseObject(readBigEndianNumber(bytes, cursor + itemIndex * objectRefSize, objectRefSize)));
        }
        return value;
      } else if (objectType === 13) {
        lengthInfo = binaryPlistLength(bytes, objectOffset, compactLength);
        if (!lengthInfo || lengthInfo.dataOffset + lengthInfo.length * objectRefSize * 2 > bytes.length) return null;
        value = {};
        parsed[objectIndex] = true;
        cache[objectIndex] = value;
        cursor = lengthInfo.dataOffset;
        for (itemIndex = 0; itemIndex < lengthInfo.length; itemIndex += 1) {
          var keyRef = readBigEndianNumber(bytes, cursor + itemIndex * objectRefSize, objectRefSize);
          var valueRef = readBigEndianNumber(bytes, cursor + (lengthInfo.length + itemIndex) * objectRefSize, objectRefSize);
          var key = parseObject(keyRef);
          if (typeof key === "string") value[key] = parseObject(valueRef);
        }
        return value;
      } else {
        value = null;
      }

      parsed[objectIndex] = true;
      cache[objectIndex] = value;
      return value;
    }

    return parseObject(topObject);
  }

  function decodeKeyedArchive(blob) {
    var archive = parseBinaryPropertyList(blob);
    if (!archive || !Array.isArray(archive.$objects) || !archive.$top) return null;
    var objects = archive.$objects;
    var resolvedCache = new Map();

    function resolve(value, depth) {
      if (depth > 60 || value === null || value === undefined || value === "$null") return null;
      if (value && typeof value === "object" && Number.isInteger(value.__plistUid)) {
        var objectIndex = value.__plistUid;
        if (objectIndex < 0 || objectIndex >= objects.length) return null;
        if (resolvedCache.has(objectIndex)) return resolvedCache.get(objectIndex);
        var resolvedObject = resolve(objects[objectIndex], depth + 1);
        resolvedCache.set(objectIndex, resolvedObject);
        return resolvedObject;
      }
      if (Array.isArray(value)) return value.map(function (item) { return resolve(item, depth + 1); });
      if (value instanceof Uint8Array || value instanceof Date || typeof value !== "object") return value;

      if (Array.isArray(value["NS.keys"]) && Array.isArray(value["NS.objects"])) {
        var dictionary = {};
        var keys = resolve(value["NS.keys"], depth + 1) || [];
        var values = resolve(value["NS.objects"], depth + 1) || [];
        keys.forEach(function (key, index) {
          if (typeof key === "string") dictionary[key] = values[index];
        });
        return dictionary;
      }
      if (Array.isArray(value["NS.objects"])) return resolve(value["NS.objects"], depth + 1);

      var object = {};
      Object.keys(value).forEach(function (key) {
        if (key !== "$class") object[key] = resolve(value[key], depth + 1);
      });
      return object;
    }

    return resolve(archive.$top.root, 0);
  }

  function extractCallInfo(contentType, blob, text, latitude, longitude) {
    if (Number(contentType) !== 6) return null;
    var strings = extractBinaryPlistObjectStrings(blob);
    var knownResults = ["NO_RESPONSE", "CANCELED", "REJECTED", "NORMAL", "BUSY"];
    var result = "UNKNOWN";
    for (var resultIndex = 0; resultIndex < knownResults.length; resultIndex += 1) {
      if (strings.indexOf(knownResults[resultIndex]) !== -1) {
        result = knownResults[resultIndex];
        break;
      }
    }

    var isGroup = strings.some(function (value) {
      return value.indexOf("GroupCall") !== -1 || value === "GC_CHAT_MID" || value === "GC_EVT_TYPE";
    });
    var media = strings.indexOf("V") !== -1 || strings.indexOf("VIDEO") !== -1 ? "video" : "audio";
    var durations = strings.filter(function (value) { return /^\d{1,10}$/.test(value); }).map(Number).filter(function (value) {
      return value >= 1000 && value <= 86400000;
    });
    var durationMs = durations.length ? Math.max.apply(Math, durations) : 0;
    var legacyText = stringOrEmpty(text).match(/Call History\s*:\s*(\d+)\s*millisecs,\s*Result:\s*(\d+)/i);
    if (legacyText) {
      durationMs = Number(legacyText[1]) || 0;
      if (result === "UNKNOWN") result = durationMs > 0 ? "NORMAL" : "NO_RESPONSE";
    } else if (!durationMs) {
      var legacyDuration = numberOrNull(latitude);
      if (legacyDuration !== null && legacyDuration >= 1000) durationMs = legacyDuration;
    }
    if (result === "UNKNOWN" && durationMs > 0) result = "NORMAL";

    return {
      media: media,
      result: result,
      durationMs: durationMs,
      isGroup: isGroup,
      legacyCode: legacyText ? Number(legacyText[2]) : numberOrNull(longitude)
    };
  }

  function formatCallLabel(call, isSelf) {
    var medium = call.media === "video" ? "視訊" : "語音";
    if (call.isGroup) {
      return "群組" + medium + "通話" + (call.durationMs ? " · " + formatCallDuration(call.durationMs) : "");
    }
    if (call.result === "NORMAL") {
      return medium + "通話" + (call.durationMs ? " · " + formatCallDuration(call.durationMs) : "");
    }
    if (call.result === "NO_RESPONSE") return isSelf ? "對方未接" + medium + "通話" : "未接" + (medium === "視訊" ? "視訊來電" : "來電");
    if (call.result === "CANCELED") return isSelf ? "已取消" + medium + "通話" : "未接" + (medium === "視訊" ? "視訊來電" : "來電");
    if (call.result === "BUSY") return isSelf ? "對方忙線中" : "忙線中";
    if (call.result === "REJECTED") return isSelf ? "對方拒絕" + medium + "通話" : "已拒絕" + (medium === "視訊" ? "視訊來電" : "來電");
    return medium + "通話";
  }

  function formatCallDuration(milliseconds) {
    var seconds = Math.max(0, Math.round(Number(milliseconds) / 1000));
    var minutes = Math.floor(seconds / 60);
    var remainder = seconds % 60;
    if (!minutes) return remainder + " 秒";
    return minutes + " 分 " + remainder + " 秒";
  }

  function isUnansweredCall(call) {
    return call && call.result !== "NORMAL" && call.result !== "UNKNOWN";
  }

  function safeHttpUrl(value) {
    try {
      var parsed = new URL(String(value || "").trim());
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
    } catch (error) {
      return "";
    }
  }

  function trimUrlMatch(value) {
    var trimmed = String(value || "");
    while (/[.,!?;:，。！？；：、》】」』]$/.test(trimmed)) trimmed = trimmed.slice(0, -1);
    [["(", ")"], ["[", "]"], ["{", "}"]].forEach(function (pair) {
      while (trimmed.endsWith(pair[1]) && trimmed.split(pair[0]).length < trimmed.split(pair[1]).length) {
        trimmed = trimmed.slice(0, -1);
      }
    });
    return trimmed;
  }

  function findHttpUrls(text) {
    var source = stringOrEmpty(text);
    var pattern = /https?:\/\/[^\s<>"']+/gi;
    var matches = [];
    var seen = new Set();
    var match;
    while ((match = pattern.exec(source)) !== null) {
      var raw = trimUrlMatch(match[0]);
      var href = safeHttpUrl(raw);
      if (!href) continue;
      var key = href.replace(/#.*$/, "");
      matches.push({ href: href, text: raw, start: match.index, end: match.index + raw.length, duplicate: seen.has(key) });
      seen.add(key);
    }
    return matches;
  }

  function previewDomain(url, fallback) {
    try { return new URL(url).hostname.replace(/^www\./i, "") || stringOrEmpty(fallback); }
    catch (error) { return stringOrEmpty(fallback); }
  }

  function youtubeVideoId(url) {
    try {
      var parsed = new URL(url);
      var host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
      var id = "";
      if (host === "youtu.be") id = parsed.pathname.split("/").filter(Boolean)[0] || "";
      else if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
        if (parsed.pathname === "/watch") id = parsed.searchParams.get("v") || "";
        else if (/^\/(?:shorts|live|embed)\//.test(parsed.pathname)) id = parsed.pathname.split("/")[2] || "";
      }
      return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : "";
    } catch (error) {
      return "";
    }
  }

  function normalizeLinkPreviewImage(value, url) {
    var candidate = stringOrEmpty(value).trim();
    if (candidate.indexOf("//") === 0) candidate = "https:" + candidate;
    else if (candidate.charAt(0) === "/") candidate = "https://obs.line-scdn.net" + candidate;
    var safeCandidate = safeHttpUrl(candidate);
    if (safeCandidate) return safeCandidate;
    var videoId = youtubeVideoId(url);
    return videoId ? "https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg" : "";
  }

  function createLinkPreview(url, model) {
    var href = safeHttpUrl(url);
    if (!href) return null;
    var data = model && typeof model === "object" ? model : {};
    var domain = firstNonEmpty(data.domain, previewDomain(href), "連結");
    var videoId = youtubeVideoId(href);
    return {
      url: href,
      domain: domain,
      title: firstNonEmpty(data.Title, videoId ? "YouTube 影片" : domain),
      summary: firstNonEmpty(data.Summary, href),
      image: normalizeLinkPreviewImage(data.ThumbnailURLString, href),
      isVideo: Boolean(data.isVideo || videoId)
    };
  }

  function extractLinkPreviews(blob, text, contentType) {
    var urlMatches = findHttpUrls(text);
    if (!urlMatches.length && Number(contentType) !== 107) return [];
    var previews = [];
    var seen = new Set();
    var archive = decodeKeyedArchive(blob);
    var models = archive && archive.NLURLScrapModelsKey;
    if (models && !Array.isArray(models)) models = [models];
    (models || []).forEach(function (model) {
      var url = model && firstNonEmpty(model.URLString, model.redirectedURLString);
      var preview = createLinkPreview(url, model);
      if (!preview) return;
      var key = preview.url.replace(/#.*$/, "");
      if (!seen.has(key)) previews.push(preview);
      seen.add(key);
    });
    urlMatches.forEach(function (match) {
      var key = match.href.replace(/#.*$/, "");
      if (seen.has(key) || match.duplicate) return;
      var preview = createLinkPreview(match.href, null);
      if (preview) previews.push(preview);
      seen.add(key);
    });
    return previews.slice(0, 4);
  }

  function appendLinkedText(container, text) {
    var source = stringOrEmpty(text);
    var matches = findHttpUrls(source);
    var cursor = 0;
    matches.forEach(function (match) {
      if (match.start > cursor) container.appendChild(document.createTextNode(source.slice(cursor, match.start)));
      var link = document.createElement("a");
      link.href = match.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.referrerPolicy = "no-referrer";
      link.textContent = source.slice(match.start, match.end);
      container.appendChild(link);
      cursor = match.end;
    });
    if (cursor < source.length) container.appendChild(document.createTextNode(source.slice(cursor)));
  }

  function appendLinkPreviews(card, previews) {
    if (!previews || !previews.length) return;
    var list = document.createElement("div");
    list.className = "link-previews";
    previews.forEach(function (previewData) {
      var preview = document.createElement("a");
      preview.className = "link-preview" + (previewData.image ? "" : " no-image");
      preview.href = previewData.url;
      preview.target = "_blank";
      preview.rel = "noopener noreferrer";
      preview.referrerPolicy = "no-referrer";

      var content = document.createElement("span");
      content.className = "link-preview-content";
      var domain = document.createElement("span");
      domain.className = "link-preview-domain";
      domain.textContent = previewData.domain;
      var title = document.createElement("strong");
      title.className = "link-preview-title";
      title.textContent = previewData.title;
      var summary = document.createElement("span");
      summary.className = "link-preview-summary";
      summary.textContent = previewData.summary;
      content.appendChild(domain);
      content.appendChild(title);
      content.appendChild(summary);
      preview.appendChild(content);

      if (previewData.image) {
        var image = document.createElement("img");
        image.src = previewData.image;
        image.alt = "";
        image.loading = "lazy";
        image.decoding = "async";
        image.referrerPolicy = "no-referrer";
        image.addEventListener("error", function () {
          preview.classList.add("no-image");
          image.remove();
        });
        preview.appendChild(image);
      }
      list.appendChild(preview);
    });
    card.appendChild(list);
  }

  function linkifyMessageHtml(text) {
    var source = stringOrEmpty(text);
    var matches = findHttpUrls(source);
    var parts = [];
    var cursor = 0;
    matches.forEach(function (match) {
      if (match.start > cursor) parts.push(escapeHtml(source.slice(cursor, match.start)));
      parts.push('<a href="' + escapeHtml(match.href) + '" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">' + escapeHtml(source.slice(match.start, match.end)) + '</a>');
      cursor = match.end;
    });
    if (cursor < source.length) parts.push(escapeHtml(source.slice(cursor)));
    return parts.join("");
  }

  function buildLinkPreviewHtml(previews) {
    if (!previews || !previews.length) return "";
    return '<div class="link-previews">' + previews.map(function (preview) {
      var image = preview.image
        ? '<img src="' + escapeHtml(preview.image) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">'
        : "";
      return '<a class="link-preview' + (preview.image ? "" : " no-image") + '" href="' + escapeHtml(preview.url) + '" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"><span class="link-preview-content"><span class="link-preview-domain">' + escapeHtml(preview.domain) + '</span><strong class="link-preview-title">' + escapeHtml(preview.title) + '</strong><span class="link-preview-summary">' + escapeHtml(preview.summary) + '</span></span>' + image + '</a>';
    }).join("") + '</div>';
  }

  function resolveAttachments(blob, messageId, extractedHints) {
    var hints = extractedHints || extractAttachmentHints(blob, messageId);
    var candidates = [];
    var messageIdFiles = state.attachmentByMessageId.get(messageId) || [];
    var chatScopedFiles = messageIdFiles.filter(function (file) {
      return state.currentChat && relativePath(file).indexOf("/" + state.currentChat.id + "/") !== -1;
    });
    var directFiles = chatScopedFiles.length ? chatScopedFiles : messageIdFiles;
    var directStatus = chatScopedFiles.length || directFiles.length === 1 ? "exact" : "ambiguous";
    directFiles.forEach(function (file) {
      // A LINE image commonly has both a Message Thumbnails file and a full
      // Message Attachments file with the same message ID. Multiple variants
      // inside the selected chat are still an exact match, not an ambiguity.
      candidates.push({file: file, status: directStatus, hint: messageId});
    });
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
        link.href = createObjectUrl(file);
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

  function appendImagePreviews(card, message) {
    var exactAttachments = (message.attachments || []).filter(function (attachment) {
      return attachment.linkStatus === "exact";
    });
    var originalImages = exactAttachments.filter(isImageAttachment);
    var thumbnailImages = exactAttachments.filter(isThumbnailAttachment);
    // Prefer the original browser-readable image. Older backups often retain
    // only Message Thumbnails/*.thumb, which are still ordinary image bytes.
    var images = (originalImages.length ? originalImages : thumbnailImages).slice(0, 4);
    var media = null;

    images.forEach(function (attachment) {
      var file = state.fileByPath.get(attachment.path);
      if (!file) return;
      if (!media) {
        media = document.createElement("div");
        media.className = "message-media";
      }
      media.appendChild(createImagePreview(
        createObjectUrl(file),
        attachment.name,
        isThumbnailAttachment(attachment) ? "備份中的縮圖" : "開啟原始圖片"
      ));
    });

    if ((!media || !media.childNodes.length) && isImageContentType(message.contentType) && message.thumbnail && message.thumbnail.length) {
      var mime = detectImageMime(message.thumbnail);
      if (mime) {
        media = document.createElement("div");
        media.className = "message-media";
        media.appendChild(createImagePreview(
          createObjectUrl(new Blob([message.thumbnail], { type: mime })),
          "訊息圖片縮圖",
          "備份資料庫內的縮圖"
        ));
      }
    }

    if (media && media.childNodes.length) card.appendChild(media);
  }

  function createImagePreview(url, alt, captionText) {
    var figure = document.createElement("figure");
    figure.className = "message-image";
    var link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.title = captionText;
    var image = document.createElement("img");
    image.src = url;
    image.alt = alt || "LINE 圖片";
    // The message panel is its own scroll container. Some browsers never
    // activate native lazy loading for images deeper in that container.
    image.loading = "eager";
    image.decoding = "async";
    image.addEventListener("error", function () {
      figure.classList.add("preview-error");
      image.alt = "這個圖片格式無法由瀏覽器直接顯示";
    });
    link.appendChild(image);
    figure.appendChild(link);
    var caption = document.createElement("figcaption");
    caption.textContent = captionText;
    figure.appendChild(caption);
    return figure;
  }

  function isImageAttachment(attachment) {
    return /^image\/(?:jpe?g|png|gif|webp|bmp|avif)$/i.test(attachment.mime || "") || /\.(?:jpe?g|png|gif|webp|bmp|avif)$/i.test(attachment.name || "");
  }

  function isThumbnailAttachment(attachment) {
    return /\.thumb$/i.test(attachment.name || "") || /\/Message Thumbnails\//.test(attachment.path || "");
  }

  function isImageContentType(contentType) {
    var code = Number(contentType);
    return code === 1 || code === 16 || code === 112;
  }

  function isLocationContentType(contentType) {
    return Number(contentType) === 100;
  }

  function hasValidLocation(message) {
    if (!message || message.call || !isLocationContentType(message.contentType)) return false;
    var latitude = Number(message.latitude);
    var longitude = Number(message.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
    if (Math.abs(latitude) < 0.000001 && Math.abs(longitude) < 0.000001) return false;
    return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
  }

  function detectImageMime(bytes) {
    if (!bytes || bytes.length < 4) return "";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
    return "";
  }

  function createObjectUrl(blob) {
    var url = URL.createObjectURL(blob);
    state.objectUrls.add(url);
    return url;
  }

  function revokeObjectUrls() {
    state.objectUrls.forEach(function (url) { URL.revokeObjectURL(url); });
    state.objectUrls.clear();
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
      isSystem: message.isSystem,
      sendStatus: message.sendStatus,
      contentType: message.contentType,
      messageType: message.messageType,
      kind: message.kind,
      call: message.call,
      text: message.text,
      latitude: message.latitude,
      longitude: message.longitude,
      linkPreviews: message.linkPreviews,
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
    var known = { 1: "image", 2: "video", 3: "audio", 4: "file", 5: "sticker", 6: "call", 7: "system", 9: "contact", 12: "poll", 13: "call", 14: "file", 16: "image", 17: "video", 18: "system", 96: "system", 100: "location", 101: "sticker", 107: "link", 111: "system", 112: "image" };
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
  function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
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
