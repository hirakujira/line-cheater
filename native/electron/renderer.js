"use strict";

const bridge = window.lineNativeBridge;
const NativeDataProvider = window.LineNativeDataProvider;
let provider = null;
let chatCursor = null;
let messageCursor = null;
let selectedChatPk = null;
let selectedChat = null;
let activeSearch = null;
let activeSourceBytes = 0;
let activeWorkspaceView = "browse";
let selectedSourceKind = null;
let messageRenderGeneration = 0;
let packageInProgress = false;
let imageModalTrigger = null;
let cleanupPage = null;
let cleanupOverview = null;
let cleanupLoading = false;
let cleanupSearchTimer = null;
let cleanupResizeTimer = null;
let cleanupRenderGeneration = 0;
let cleanupAlbumSession = null;
const CLEANUP_ALBUM_PAGE_SIZE = 24;
const CLEANUP_ALBUM_MAX_PAGES = 3;
const cleanupState = {
  page: 1,
  search: "",
  kind: "all",
  category: "all",
  sort: "recent",
  groupKey: null
};

const elements = {
  appShell: document.querySelector("#app-shell"),
  welcomeScreen: document.querySelector("#welcome-screen"),
  workspaceScreen: document.querySelector("#workspace-screen"),
  enterWorkspace: document.querySelector("#enter-workspace"),
  changeSource: document.querySelector("#change-source"),
  sourceReadyCard: document.querySelector("#source-ready-card"),
  selectedSourceName: document.querySelector("#selected-source-name"),
  selectedSourceDetail: document.querySelector("#selected-source-detail"),
  sidebarSourceName: document.querySelector("#sidebar-source-name"),
  sidebarSourceDetail: document.querySelector("#sidebar-source-detail"),
  workspaceTitle: document.querySelector("#workspace-title"),
  workspaceSubtitle: document.querySelector("#workspace-subtitle"),
  workspaceStatus: document.querySelector("#workspace-status"),
  browseView: document.querySelector("#browse-view"),
  cleanupView: document.querySelector("#cleanup-view"),
  status: document.querySelector("#status"),
  sessionSummary: document.querySelector("#session-summary"),
  chats: document.querySelector("#chats"),
  messages: document.querySelector("#messages"),
  selectedChatTitle: document.querySelector("#selected-chat-title"),
  selectedChatMeta: document.querySelector("#selected-chat-meta"),
  messageStatus: document.querySelector("#message-status"),
  chatPageInfo: document.querySelector("#chat-page-info"),
  nextChats: document.querySelector("#next-chats"),
  nextMessages: document.querySelector("#next-messages"),
  scanCatalog: document.querySelector("#scan-catalog"),
  buildCandidate: document.querySelector("#build-candidate"),
  searchForm: document.querySelector("#search-form"),
  searchQuery: document.querySelector("#search-query"),
  searchButton: document.querySelector("#search-form button"),
  progress: document.querySelector("#progress"),
  catalogSummary: document.querySelector("#catalog-summary"),
  cleanupSearch: document.querySelector("#cleanup-search"),
  cleanupKind: document.querySelector("#cleanup-kind"),
  cleanupCategory: document.querySelector("#cleanup-category"),
  cleanupSort: document.querySelector("#cleanup-sort"),
  markedCount: document.querySelector("#marked-count"),
  markedSize: document.querySelector("#marked-size"),
  categorySummary: document.querySelector("#category-summary"),
  cleanupResultInfo: document.querySelector("#cleanup-result-info"),
  cleanupList: document.querySelector("#cleanup-list"),
  cleanupPrev: document.querySelector("#cleanup-prev"),
  cleanupNext: document.querySelector("#cleanup-next"),
  cleanupPageInfo: document.querySelector("#cleanup-page-info"),
  loadModal: document.querySelector("#load-modal"),
  loadModalCard: document.querySelector("#load-modal .package-modal-card"),
  loadModalMessage: document.querySelector("#load-modal-message"),
  loadModalProgress: document.querySelector("#load-modal-progress"),
  loadModalProgressLabel: document.querySelector("#load-modal-progress-label"),
  packageModal: document.querySelector("#package-modal"),
  packageModalCard: document.querySelector("#package-modal .package-modal-card"),
  packageModalTitle: document.querySelector("#package-modal-title"),
  packageModalMessage: document.querySelector("#package-modal-message"),
  packageModalProgress: document.querySelector("#package-modal-progress"),
  packageModalProgressLabel: document.querySelector("#package-modal-progress-label"),
  packageModalClose: document.querySelector("#package-modal-close"),
  imageModal: document.querySelector("#image-modal"),
  imageModalCard: document.querySelector("#image-modal .image-modal-card"),
  imageModalImage: document.querySelector("#image-modal-image"),
  imageModalCaption: document.querySelector("#image-modal-caption"),
  imageModalClose: document.querySelector("#image-modal-close")
};

const categoryLabels = {
  all: "全部檔案",
  individual: "個人聊天室",
  group: "群組聊天室",
  community: "社群",
  unreferenced: "SQLite 未引用",
  unconfirmed: "無法確認"
};

function setStatus(message, error) {
  for (const status of [elements.status, elements.workspaceStatus]) {
    status.textContent = message;
    status.classList.toggle("error", Boolean(error));
  }
  if (!elements.loadModal.classList.contains("hidden")) {
    elements.loadModalMessage.textContent = message;
  }
}

function sourceKindLabel(kind) {
  return {
    directory: "備份資料夾",
    imazing_archive: ".imazingapp",
    sqlite: "Line.sqlite"
  }[kind] || "LINE 備份";
}

function sourceDisplayName(path, kind) {
  const parts = String(path || "").split(/[\\/]/).filter(Boolean);
  return parts.pop() || sourceKindLabel(kind);
}

function renderSessionSummary(info) {
  elements.sessionSummary.replaceChildren();
  for (const [label, value] of [
    ["類型", sourceKindLabel(info.source.kind)],
    ["SQLite 檢查", info.quickCheck],
    ["來源唯讀", info.readOnly ? "是" : "否"],
    ["群組名稱資料", info.unifiedGroupLoaded ? "已載入" : "未提供"],
    ["社群名稱資料", info.lineSquareLoaded ? "已載入" : "未提供"],
    ["附件索引", info.catalog.scanStatus === "complete" ? "已完成" : info.catalog.scanStatus]
  ]) {
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = String(value);
    elements.sessionSummary.append(term, description);
  }
  elements.sessionSummary.classList.remove("hidden");
}

function setWorkspaceView(view) {
  if (!["browse", "cleanup"].includes(view)) return;
  activeWorkspaceView = view;
  const browse = view === "browse";
  elements.browseView.classList.toggle("hidden", !browse);
  elements.cleanupView.classList.toggle("hidden", browse);
  elements.workspaceTitle.textContent = browse ? "瀏覽" : "清理";
  elements.workspaceSubtitle.textContent = browse
    ? "查看聊天室與訊息內容"
    : "審核附件並建立瘦身備份";
  for (const button of document.querySelectorAll("[data-view]")) {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    button.toggleAttribute("aria-current", active);
  }
  if (!browse && provider && !cleanupPage) void loadCleanupPage();
}

function enterWorkspace() {
  if (!provider) return;
  elements.welcomeScreen.classList.add("hidden");
  elements.workspaceScreen.classList.remove("hidden");
  setWorkspaceView(activeWorkspaceView);
  document.querySelector(`[data-view="${activeWorkspaceView}"]`).focus();
}

function returnToWelcome() {
  elements.workspaceScreen.classList.add("hidden");
  elements.welcomeScreen.classList.remove("hidden");
  elements.enterWorkspace.focus();
}

function waitForUiPaint() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
  });
}

function setModalBusy(isBusy, bodyClass) {
  elements.appShell.inert = isBusy;
  elements.appShell.toggleAttribute("aria-busy", isBusy);
  document.body.classList.toggle(bodyClass, isBusy);
}

function showLoadModal(message) {
  elements.loadModal.classList.remove("hidden");
  elements.loadModal.setAttribute("aria-hidden", "false");
  elements.loadModalMessage.textContent = message;
  updateLoadModalProgress(0, message);
  setModalBusy(true, "load-modal-open");
  window.requestAnimationFrame(() => elements.loadModalCard.focus());
}

function updateLoadModalProgress(percent, message) {
  const progress = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  elements.loadModalProgress.style.width = `${progress}%`;
  elements.loadModalProgress.setAttribute("aria-valuenow", String(progress));
  elements.loadModalProgressLabel.textContent = `${progress}%`;
  if (message) elements.loadModalMessage.textContent = message;
}

function closeLoadModal() {
  elements.loadModal.classList.add("hidden");
  elements.loadModal.setAttribute("aria-hidden", "true");
  setModalBusy(false, "load-modal-open");
}

function showPackageModal(message) {
  elements.packageModal.classList.remove("hidden", "is-success", "is-error");
  elements.packageModal.classList.add("is-processing");
  elements.packageModal.setAttribute("aria-hidden", "false");
  elements.packageModalTitle.textContent = "正在建立 .imazingapp";
  elements.packageModalMessage.textContent = message;
  elements.packageModalClose.classList.add("hidden");
  updatePackageModalProgress(0, message);
  setModalBusy(true, "package-modal-open");
  window.requestAnimationFrame(() => elements.packageModalCard.focus());
}

function updatePackageModalProgress(percent, message) {
  const progress = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  elements.packageModalProgress.style.width = `${progress}%`;
  elements.packageModalProgress.setAttribute("aria-valuenow", String(progress));
  elements.packageModalProgressLabel.textContent = `${progress}%`;
  if (message) elements.packageModalMessage.textContent = message;
}

function completePackageModal(error, title, message) {
  elements.packageModal.classList.remove("is-processing", "is-success", "is-error");
  elements.packageModal.classList.add(error ? "is-error" : "is-success");
  elements.packageModalTitle.textContent = title;
  elements.packageModalMessage.textContent = message;
  if (!error) updatePackageModalProgress(100);
  elements.packageModalClose.textContent = error ? "關閉" : "完成";
  elements.packageModalClose.classList.remove("hidden");
  elements.packageModalClose.focus();
}

function closePackageModal() {
  if (packageInProgress) return;
  elements.packageModal.classList.add("hidden");
  elements.packageModal.setAttribute("aria-hidden", "true");
  setModalBusy(false, "package-modal-open");
}

function showImageModal(url, caption, trigger) {
  imageModalTrigger = trigger || null;
  elements.imageModalImage.src = url;
  elements.imageModalImage.alt = caption || "LINE 圖片";
  elements.imageModalCaption.textContent = caption || "LINE 圖片";
  elements.imageModal.classList.remove("hidden");
  elements.imageModal.setAttribute("aria-hidden", "false");
  setModalBusy(true, "image-modal-open");
  window.requestAnimationFrame(() => elements.imageModalCard.focus());
}

function closeImageModal() {
  if (elements.imageModal.classList.contains("hidden")) return;
  elements.imageModal.classList.add("hidden");
  elements.imageModal.setAttribute("aria-hidden", "true");
  elements.imageModalImage.removeAttribute("src");
  setModalBusy(false, "image-modal-open");
  if (imageModalTrigger) imageModalTrigger.focus();
  imageModalTrigger = null;
}

function replaceChildren(container, items, render) {
  const fragment = document.createDocumentFragment();
  for (const item of items) fragment.append(render(item));
  container.replaceChildren(fragment);
}

function record(primary, secondary) {
  const item = document.createElement("li");
  const title = document.createElement("strong");
  title.textContent = primary;
  const detail = document.createElement("span");
  detail.textContent = secondary;
  item.append(title, detail);
  return item;
}

function normalizedTimestamp(value) {
  if (!Number.isFinite(Number(value))) return null;
  let numeric = Number(value);
  if (numeric === 0) return null;
  if (Math.abs(numeric) < 100_000_000_000) {
    if (numeric > -978_307_200 && numeric < 1_200_000_000) numeric += 978_307_200;
    numeric *= 1000;
  }
  const date = new Date(numeric);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function formatTimestamp(value) {
  const date = normalizedTimestamp(value);
  return date ? date.toLocaleString() : "時間不明";
}

function formatBytes(value) {
  let bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let unit = -1;
  do {
    bytes /= 1024;
    unit += 1;
  } while (bytes >= 1024 && unit < units.length - 1);
  return `${bytes.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`;
}

function fileName(path) {
  return String(path || "").split("/").pop() || "未命名附件";
}

function cleanupStatusLabel(status) {
  return {
    referenced: "聊天室附件",
    unreferenced: "SQLite 未引用",
    unconfirmed: "無法確認"
  }[status] || "附件";
}

function cleanupStatusSummary(status) {
  if (status === "unreferenced") {
    return "附件未被路徑所屬聊天室的 SQLite 訊息引用，請人工確認後再刪除。";
  }
  if (status === "unconfirmed") {
    return "路徑或訊息 ID 無法可靠比對，未列為孤兒檔案。";
  }
  return {
    direct: "個人聊天室",
    group: "群組聊天室",
    community: "社群"
  }[status] || "";
}

function chatIcon(kind) {
  return {
    direct: "人",
    group: "群",
    community: "社",
    unreferenced: "鬼",
    unknown: "?"
  }[kind] || "聊";
}

function emptyState(message) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = message;
  return empty;
}

async function openSource(kind) {
  showLoadModal("請在系統視窗選擇 LINE 備份來源。");
  updateLoadModalProgress(2);
  await waitForUiPaint();
  try {
    setStatus("正在開啟備份…");
    const ready = await bridge.selectSource(kind);
    if (!ready) {
      setStatus("已取消。");
      closeLoadModal();
      return;
    }
    elements.enterWorkspace.disabled = true;
    elements.sourceReadyCard.classList.add("hidden");
    elements.sessionSummary.classList.add("hidden");
    updateLoadModalProgress(12, "正在以唯讀模式開啟 SQLite…");
    provider = new NativeDataProvider(bridge);
    chatCursor = messageCursor = null;
    selectedChatPk = activeSearch = selectedChat = null;
    messageRenderGeneration += 1;
    disposeCleanupAlbum();
    cleanupPage = cleanupOverview = null;
    Object.assign(cleanupState, {
      page: 1,
      search: "",
      kind: "all",
      category: "all",
      sort: "recent",
      groupKey: null
    });
    elements.cleanupSearch.value = "";
    elements.cleanupKind.value = "all";
    elements.cleanupCategory.value = "all";
    elements.cleanupSort.value = "recent";
    elements.cleanupList.replaceChildren(emptyState("請先掃描附件。"));
    elements.chats.replaceChildren(emptyState("正在載入聊天室…"));
    elements.messages.replaceChildren(emptyState("尚未選取聊天室。"));
    elements.selectedChatTitle.textContent = "選取聊天室";
    elements.selectedChatMeta.textContent = "請從左側選取聊天室開始。";
    elements.messageStatus.textContent = "";
    const info = await provider.sessionInfo();
    activeSourceBytes = Number(info.source.sourceBytes) || 0;
    const sourceName = sourceDisplayName(info.source.sourcePath, info.source.kind);
    const sourceType = sourceKindLabel(info.source.kind);
    const sourceSize = Number(info.source.sourceBytes) || Number(info.source.databaseBytes) || 0;
    updateLoadModalProgress(20, "正在整理聊天室名稱與附件索引…");
    elements.scanCatalog.disabled = false;
    elements.searchButton.disabled = false;
    elements.buildCandidate.disabled = true;
    if (kind !== "sqlite" &&
        (info.catalog.scanStatus !== "complete" || info.catalog.attachmentCount === 0)) {
      await scanCatalog({ keepLoadModal: true });
    } else if (info.catalog.scanStatus === "complete") {
      const overview = await provider.cleanupOverview();
      if (overview.contextStatus === "complete") {
        await loadCleanupPage();
        elements.buildCandidate.disabled = false;
      } else {
        await scanCatalog({ keepLoadModal: true });
      }
    }
    const finalInfo = await provider.sessionInfo();
    renderSessionSummary(finalInfo);
    updateLoadModalProgress(93, "正在顯示聊天室…");
    await loadChats(null);
    updateLoadModalProgress(100, "完整備份解析完成。");
    setStatus("備份已以唯讀模式開啟，可以進入工作區。");
    selectedSourceKind = kind;
    elements.selectedSourceName.textContent = sourceName;
    elements.selectedSourceDetail.textContent =
      `${sourceType} · ${formatBytes(sourceSize)} · SQLite ${finalInfo.quickCheck}`;
    elements.sidebarSourceName.textContent = sourceName;
    elements.sidebarSourceDetail.textContent = `${sourceType} · 唯讀`;
    elements.sourceReadyCard.classList.remove("hidden");
    elements.enterWorkspace.disabled = false;
    for (const button of document.querySelectorAll("[data-source]")) {
      button.classList.toggle("is-selected", button.dataset.source === selectedSourceKind);
    }
    await waitForUiPaint();
    closeLoadModal();
    elements.enterWorkspace.focus();
  } catch (error) {
    provider = null;
    elements.enterWorkspace.disabled = true;
    elements.sourceReadyCard.classList.add("hidden");
    elements.sessionSummary.classList.add("hidden");
    setStatus(error.message, true);
    closeLoadModal();
  }
}

async function loadChats(cursor) {
  const page = await provider.listChats({ limit: 100, cursor });
  replaceChildren(elements.chats, page.items, (chat) => {
    const button = document.createElement("button");
    button.type = "button";
    const selected = selectedChatPk === chat.pk &&
      (selectedChat ? selectedChat.source : "line") === (chat.source || "line");
    button.className = `chat-item${selected ? " selected" : ""}`;
    button.dataset.chatPk = String(chat.pk);
    button.dataset.chatSource = chat.source || "line";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(selected));
    const title = document.createElement("span");
    title.className = "chat-item-title";
    title.textContent = chat.title;
    const meta = document.createElement("span");
    meta.className = "chat-item-meta";
    const count = document.createElement("span");
    count.textContent = `${chat.humanMessageCount.toLocaleString()} 則`;
    const date = document.createElement("span");
    date.textContent = formatTimestamp(chat.lastUpdated);
    meta.append(count, date);
    button.append(title, meta);
    button.addEventListener("click", () => void selectChat(chat));
    return button;
  });
  chatCursor = page.nextCursor;
  elements.nextChats.disabled = !chatCursor;
  elements.chatPageInfo.textContent =
    `${page.items.length.toLocaleString()} 個聊天室${chatCursor ? " · 尚有下一頁" : ""}`;
}

async function selectChat(chat) {
  selectedChat = chat;
  selectedChatPk = chat.pk;
  activeSearch = null;
  messageCursor = null;
  elements.selectedChatTitle.textContent = chat.title;
  elements.selectedChatMeta.textContent =
    `${chatKindLabel(chat.kind)} · ${chat.humanMessageCount.toLocaleString()} 則人類訊息 · 名稱來源：${titleSourceLabel(chat.titleSource)}`;
  for (const item of elements.chats.querySelectorAll(".chat-item")) {
    const selected = item.dataset.chatPk === String(chat.pk) &&
      item.dataset.chatSource === (chat.source || "line");
    item.classList.toggle("selected", selected);
    item.setAttribute("aria-selected", String(selected));
  }
  elements.messages.replaceChildren(emptyState("正在讀取訊息…"));
  elements.messageStatus.textContent = "正在讀取訊息…";
  await loadMessages(null);
}

async function loadMessages(cursor) {
  if (activeSearch) {
    renderMessagePage(await provider.searchMessages(activeSearch, {
      chatPk: selectedChatPk,
      source: selectedChat.source || "line",
      limit: 180,
      cursor
    }));
    return;
  }
  if (selectedChatPk === null) return;
  renderMessagePage(await provider.listMessages(selectedChatPk, {
    source: selectedChat.source || "line",
    limit: 180,
    cursor
  }));
}

function renderMessagePage(page) {
  const renderGeneration = ++messageRenderGeneration;
  replaceChildren(elements.messages, page.items, renderMessage);
  if (!page.items.length) {
    elements.messages.replaceChildren(emptyState("這個聊天室沒有可顯示的訊息。"));
  }
  elements.messageStatus.textContent = page.items.length
    ? `本頁顯示 ${page.items.length.toLocaleString()} 則訊息`
    : "";
  void hydrateMessagePreviews(elements.messages, renderGeneration);
  messageCursor = page.nextCursor;
  elements.nextMessages.disabled = !messageCursor;
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    return url.href;
  } catch (_error) {
    return "";
  }
}

function trimUrlMatch(value) {
  let trimmed = String(value || "");
  while (/[.,!?;:，。！？；：、》】」』]$/.test(trimmed)) trimmed = trimmed.slice(0, -1);
  for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
    while (trimmed.endsWith(closing) &&
           trimmed.split(opening).length < trimmed.split(closing).length) {
      trimmed = trimmed.slice(0, -1);
    }
  }
  return trimmed;
}

function findHttpUrls(text) {
  const source = String(text || "");
  const pattern = /https?:\/\/[^\s<>"']+/gi;
  const matches = [];
  const seen = new Set();
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const raw = trimUrlMatch(match[0]);
    const href = safeHttpUrl(raw);
    if (!href) continue;
    const key = href.replace(/#.*$/, "");
    matches.push({
      href,
      start: match.index,
      end: match.index + raw.length,
      duplicate: seen.has(key)
    });
    seen.add(key);
  }
  return matches;
}

function bindExternalLink(link, href) {
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.referrerPolicy = "no-referrer";
  link.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void bridge.openExternal(href).catch((error) => setStatus(error.message, true));
  });
}

function appendLinkedText(container, text) {
  const source = String(text || "");
  const matches = findHttpUrls(source);
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      container.append(document.createTextNode(source.slice(cursor, match.start)));
    }
    const link = document.createElement("a");
    link.textContent = source.slice(match.start, match.end);
    bindExternalLink(link, match.href);
    container.append(link);
    cursor = match.end;
  }
  if (cursor < source.length) container.append(document.createTextNode(source.slice(cursor)));
}

function linkPreviewFor(href) {
  const url = new URL(href);
  const domain = url.hostname.replace(/^www\./i, "") || "連結";
  const youtube = /^(?:www\.|m\.)?youtube\.com$/i.test(url.hostname) ||
    /^youtu\.be$/i.test(url.hostname);
  return {
    url: href,
    domain,
    title: youtube ? "YouTube 影片" : domain,
    summary: href
  };
}

function appendLinkPreviews(card, text) {
  const matches = findHttpUrls(text).filter((match) => !match.duplicate).slice(0, 4);
  if (!matches.length) return;
  const list = document.createElement("div");
  list.className = "link-previews";
  for (const match of matches) {
    const data = linkPreviewFor(match.href);
    const preview = document.createElement("a");
    preview.className = "link-preview";
    preview.setAttribute("aria-label", `在瀏覽器開啟：${data.title}`);
    bindExternalLink(preview, data.url);
    const content = document.createElement("span");
    content.className = "link-preview-content";
    const domain = document.createElement("span");
    domain.className = "link-preview-domain";
    domain.textContent = data.domain;
    const title = document.createElement("strong");
    title.className = "link-preview-title";
    title.textContent = data.title;
    const summary = document.createElement("span");
    summary.className = "link-preview-summary";
    summary.textContent = data.summary;
    const icon = document.createElement("span");
    icon.className = "link-preview-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "↗";
    content.append(domain, title, summary);
    preview.append(content, icon);
    list.append(preview);
  }
  card.append(list);
}

function renderMessage(message) {
  const system = isSystemMessage(message);
  const self = !system && isSelfMessage(message);
  const row = document.createElement("article");
  row.className = `message-row${system ? " system" : (self ? " self" : "")}`;
  const card = document.createElement("div");
  card.className = "message-card";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const sender = document.createElement("span");
  sender.className = "message-sender";
  sender.textContent = self ? "我" : (system ? "系統" : (message.senderName || "未知使用者"));
  const time = document.createElement("time");
  time.textContent = formatTimestamp(message.timestamp);
  meta.append(sender, time);
  card.append(meta);

  if (message.text) {
    const body = document.createElement("p");
    body.className = "message-text";
    appendLinkedText(body, message.text);
    card.append(body);
    appendLinkPreviews(card, message.text);
  } else {
    const kind = document.createElement("p");
    kind.className = "message-kind";
    kind.textContent = `[${messageContentLabel(message.contentType)}]`;
    card.append(kind);
  }
  if (Number.isFinite(message.latitude) && Number.isFinite(message.longitude) &&
      (message.latitude !== 0 || message.longitude !== 0)) {
    const coordinates = document.createElement("p");
    coordinates.className = "message-coordinates";
    coordinates.textContent = `位置：${message.latitude}, ${message.longitude}`;
    card.append(coordinates);
  }

  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const originals = attachments.filter((attachment) => attachment.kind === "original");
  const thumbnails = attachments.filter((attachment) => attachment.kind === "thumbnail");
  const previewPaths = originals.concat(thumbnails).map((attachment) => attachment.path);
  if (previewPaths.length && isImageContent(message.contentType, previewPaths)) {
    const media = document.createElement("div");
    media.className = "message-media";
    media.previewPaths = previewPaths.slice(0, 8);
    media.previewCaption = fileName(previewPaths[0]);
    const placeholder = document.createElement("span");
    placeholder.className = "muted small";
    placeholder.textContent = "載入圖片…";
    media.append(placeholder);
    card.append(media);
  }
  if (attachments.length) {
    const list = document.createElement("ul");
    list.className = "message-attachments";
    for (const attachment of attachments) {
      const item = document.createElement("li");
      item.textContent = fileName(attachment.path);
      const detail = document.createElement("span");
      detail.textContent =
        ` · ${attachment.kind === "thumbnail" ? "縮圖" : "原始附件"} · ${formatBytes(attachment.bytes)}`;
      item.append(detail);
      list.append(item);
    }
    card.append(list);
  }
  row.append(card);
  return row;
}

async function hydrateMessagePreviews(container, renderGeneration) {
  const mediaItems = Array.from(container.querySelectorAll(".message-media"))
    .filter((media) => Array.isArray(media.previewPaths) && media.previewPaths.length);
  let next = 0;
  async function worker() {
    while (next < mediaItems.length) {
      const media = mediaItems[next++];
      let url = null;
      let caption = media.previewCaption;
      for (const path of media.previewPaths) {
        try {
          url = await bridge.attachmentPreviewUrl(path);
          caption = fileName(path);
          if (url) break;
        } catch (_error) {
          // Unsupported originals fall back to the matching thumbnail.
        }
      }
      if (!url || renderGeneration !== messageRenderGeneration || !media.isConnected) {
        continue;
      }
      const figure = document.createElement("figure");
      figure.className = "message-image";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "message-image-button";
      button.setAttribute("aria-label", `放大預覽：${caption}`);
      const image = document.createElement("img");
      image.alt = caption;
      image.loading = "eager";
      image.decoding = "async";
      image.addEventListener("error", () => figure.classList.add("preview-error"), { once: true });
      button.addEventListener("click", () => showImageModal(url, caption, button));
      button.append(image);
      const note = document.createElement("figcaption");
      note.textContent = "開啟圖片預覽";
      figure.append(button, note);
      media.replaceChildren(figure);
      image.src = url;
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, mediaItems.length) }, () => worker()));
}

function isSystemMessage(message) {
  const contentType = Number(message.contentType);
  return [7, 18, 96, 111].includes(contentType) ||
    (message.senderPk == null && Number(message.sendStatus) === 0 && !message.id);
}

function isSelfMessage(message) {
  if (typeof message.isSelf === "boolean") return message.isSelf;
  const hasSender = message.senderPk !== null && message.senderPk !== undefined;
  return !hasSender && (
    Number(message.sendStatus) === 1 ||
    String(message.messageType || "").toUpperCase() === "S"
  );
}

function isImageContent(contentType, paths) {
  return [1, 16, 112].includes(Number(contentType)) ||
    paths.some((path) => /\.(?:jpe?g|png|gif|webp|bmp|avif|heic|thumb)$/i.test(path));
}

function messageContentLabel(contentType) {
  return {
    1: "照片",
    2: "影片",
    3: "語音",
    4: "檔案",
    5: "貼圖",
    7: "系統訊息",
    14: "檔案",
    16: "照片",
    17: "影片",
    18: "系統訊息",
    100: "位置",
    101: "貼圖",
    107: "連結",
    111: "系統訊息",
    112: "照片"
  }[Number(contentType)] || "附件";
}

function chatKindLabel(kind) {
  return {
    direct: "個人聊天室",
    group: "群組聊天室",
    community: "社群"
  }[kind] || "聊天室";
}

function titleSourceLabel(source) {
  return {
    user: "聯絡人",
    group: "群組資料",
    chat: "聊天室資料",
    rename: "群組改名訊息",
    "unified-group": "UnifiedGroup.sqlite",
    "line-square": "LineSquare.sqlite",
    id: "原始 ID",
    unresolved: "尚未解析"
  }[source] || source || "尚未解析";
}

async function scanCatalog(options) {
  options = options || {};
  const ownsModal = elements.loadModal.classList.contains("hidden");
  if (ownsModal) {
    showLoadModal("正在建立磁碟附件索引…");
    updateLoadModalProgress(18);
    await waitForUiPaint();
  }
  try {
    setStatus("正在建立磁碟附件索引…");
    elements.scanCatalog.disabled = true;
    elements.buildCandidate.disabled = true;
    const stats = await provider.scanCatalog();
    elements.progress.max = 1;
    elements.progress.value = 1;
    elements.catalogSummary.textContent =
      `${stats.attachmentCount.toLocaleString()} 個附件，${formatBytes(stats.attachmentBytes)}`;
    cleanupState.page = 1;
    cleanupState.groupKey = null;
    await loadCleanupPage();
    elements.buildCandidate.disabled = stats.attachmentCount === 0;
    setStatus("附件索引與聊天室關聯完成。");
    if (ownsModal) {
      updateLoadModalProgress(100, "附件索引與聊天室關聯完成。");
      await waitForUiPaint();
    }
    return stats;
  } catch (error) {
    setStatus(error.message, true);
    if (!ownsModal) throw error;
    return null;
  } finally {
    elements.scanCatalog.disabled = !provider;
    if (ownsModal && !options.keepLoadModal) closeLoadModal();
  }
}

function cleanupOptions(overrides) {
  overrides = overrides || {};
  return {
    page: overrides.page || cleanupState.page,
    pageSize: overrides.pageSize || 4,
    search: cleanupState.search,
    kind: cleanupState.kind,
    category: cleanupState.category,
    sort: cleanupState.sort
  };
}

async function loadCleanupPage() {
  if (!provider || cleanupLoading) return;
  if (cleanupState.groupKey) {
    await loadCleanupAlbum();
    return;
  }
  disposeCleanupAlbum();
  cleanupLoading = true;
  elements.cleanupList.setAttribute("aria-busy", "true");
  try {
    const [overview, page] = await Promise.all([
      provider.cleanupOverview(),
      provider.listCleanupGroups(cleanupOptions())
    ]);
    cleanupOverview = overview;
    cleanupPage = page;
    renderCleanupOverview();
    renderCleanupPage();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    cleanupLoading = false;
    elements.cleanupList.removeAttribute("aria-busy");
  }
}

function renderCleanupOverview() {
  if (!cleanupOverview) return;
  elements.markedCount.textContent = cleanupOverview.markedCount.toLocaleString();
  elements.markedSize.textContent = formatBytes(cleanupOverview.markedBytes);
  const fragment = document.createDocumentFragment();
  for (const total of cleanupOverview.categories) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "category-card";
    button.classList.toggle("active", cleanupState.category === total.category);
    button.setAttribute("aria-pressed", String(cleanupState.category === total.category));
    button.dataset.category = total.category;
    const title = document.createElement("strong");
    title.textContent = categoryLabels[total.category] || total.category;
    const summary = document.createElement("span");
    summary.textContent = `${total.fileCount.toLocaleString()} 個 · ${formatBytes(total.bytes)}`;
    button.append(title, summary);
    fragment.append(button);
  }
  elements.categorySummary.replaceChildren(fragment);
}

function renderCleanupPage() {
  if (!cleanupPage) return;
  elements.cleanupView.classList.remove("is-detail");
  renderCleanupGroups(cleanupPage);
  elements.cleanupPageInfo.textContent = cleanupPage.totalItems
    ? `第 ${cleanupPage.page} / ${cleanupPage.totalPages} 頁 · ${cleanupPage.totalItems.toLocaleString()} 個分類`
    : "第 1 頁";
  elements.cleanupPrev.disabled = cleanupPage.page <= 1;
  elements.cleanupNext.disabled = cleanupPage.page >= cleanupPage.totalPages;
}

function renderCleanupGroups(page) {
  cleanupRenderGeneration += 1;
  elements.cleanupResultInfo.textContent = page.totalItems
    ? `找到 ${page.totalItems.toLocaleString()} 個聊天室或特殊分類；點入後才會顯示附件內容。`
    : "";
  if (!page.items.length) {
    elements.cleanupList.replaceChildren(emptyState(
      "找不到符合條件的聊天室。可以清除搜尋文字或切換「顯示」篩選。"
    ));
    return;
  }
  const list = document.createElement("div");
  list.className = "cleanup-group-list";
  for (const group of page.items) list.append(renderCleanupGroup(group));
  elements.cleanupList.replaceChildren(list);
}

function renderCleanupGroup(group) {
  const card = document.createElement("article");
  card.className = "cleanup-group-card";
  if (group.referenceStatus !== "referenced") {
    card.classList.add("special", group.referenceStatus);
  }
  const row = document.createElement("div");
  row.className = "cleanup-group-row";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "cleanup-group-open-button";
  open.dataset.openGroup = group.key;
  const avatar = document.createElement("span");
  avatar.className = "cleanup-chat-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = chatIcon(group.chatKind);
  const main = document.createElement("span");
  main.className = "cleanup-group-main";
  const heading = document.createElement("span");
  heading.className = "cleanup-group-heading";
  const title = document.createElement("strong");
  title.textContent = group.chatTitle;
  const badge = document.createElement("span");
  badge.className = "cleanup-chat-type";
  badge.textContent = cleanupStatusLabel(group.referenceStatus);
  heading.append(title, badge);
  const summary = document.createElement("small");
  summary.textContent = group.referenceStatus === "referenced"
    ? cleanupStatusSummary(group.chatKind)
    : cleanupStatusSummary(group.referenceStatus);
  const counts = document.createElement("span");
  counts.textContent = `${group.fileCount.toLocaleString()} 個檔案 · ${formatBytes(group.totalBytes)}`;
  if (group.markedCount) {
    const marked = document.createElement("b");
    marked.textContent = ` · 已標記 ${group.markedCount.toLocaleString()} 個`;
    counts.append(marked);
  }
  main.append(heading, summary, counts);
  open.append(avatar, main);

  const actions = document.createElement("div");
  actions.className = "cleanup-group-actions";
  const toggleAll = document.createElement("button");
  const fullyMarked = group.fileCount > 0 && group.markedCount === group.fileCount;
  toggleAll.type = "button";
  toggleAll.className = `cleanup-group-action ${fullyMarked ? "is-cancel" : "is-delete"}`;
  toggleAll.dataset.groupAction = "toggle_all";
  toggleAll.dataset.groupKey = group.key;
  toggleAll.textContent = fullyMarked ? "取消刪除全部" : "刪除全部";
  actions.append(toggleAll);
  if (group.thumbnailBackedImageCount > 0) {
    const keepThumbnail = document.createElement("button");
    keepThumbnail.type = "button";
    keepThumbnail.className =
      `cleanup-group-action ${group.keepingThumbnails ? "is-cancel" : "is-delete"}`;
    keepThumbnail.dataset.groupAction = "keep_thumbnail";
    keepThumbnail.dataset.groupKey = group.key;
    keepThumbnail.title = group.keepingThumbnails
      ? "還原具有對應縮圖的圖片原檔"
      : "只標記已有非空縮圖的圖片原檔；PDF、影片與無縮圖附件會保留";
    keepThumbnail.textContent = group.keepingThumbnails ? "還原原始圖片" : "只保留縮圖";
    actions.append(keepThumbnail);
  }
  const view = document.createElement("button");
  view.type = "button";
  view.className = "cleanup-group-action";
  view.dataset.openGroup = group.key;
  view.textContent = "查看";
  actions.append(view);
  row.append(open, actions);
  card.append(row);
  return card;
}

function disposeCleanupAlbum() {
  if (!cleanupAlbumSession) return;
  cleanupAlbumSession.disposed = true;
  if (cleanupAlbumSession.resizeObserver) cleanupAlbumSession.resizeObserver.disconnect();
  cleanupAlbumSession = null;
}

async function loadCleanupAlbum() {
  if (!provider || cleanupLoading || !cleanupState.groupKey) return;
  cleanupLoading = true;
  disposeCleanupAlbum();
  const groupKey = cleanupState.groupKey;
  const renderGeneration = ++cleanupRenderGeneration;
  elements.cleanupList.setAttribute("aria-busy", "true");
  try {
    const options = cleanupOptions({ page: 1, pageSize: CLEANUP_ALBUM_PAGE_SIZE });
    const [overview, firstPage] = await Promise.all([
      provider.cleanupOverview(),
      provider.listCleanupReviews(groupKey, options)
    ]);
    if (cleanupState.groupKey !== groupKey) return;
    cleanupOverview = overview;
    cleanupPage = firstPage;
    cleanupState.page = 1;
    renderCleanupOverview();
    renderCleanupAlbum(firstPage, renderGeneration);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    cleanupLoading = false;
    elements.cleanupList.removeAttribute("aria-busy");
  }
}

function cleanupAlbumSectionLabel(review) {
  if (cleanupState.sort === "size") return "依檔案大小排序";
  if (cleanupState.sort === "path") return "依來源路徑排序";
  const date = normalizedTimestamp(review.context && review.context.timestamp);
  if (!date) return "日期不明";
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "long"
  }).format(date);
}

function cleanupAlbumSections(items) {
  const sections = [];
  for (const review of items) {
    const label = cleanupAlbumSectionLabel(review);
    const current = sections[sections.length - 1];
    if (current && current.label === label) current.items.push(review);
    else sections.push({ label, items: [review] });
  }
  return sections;
}

function renderCleanupAlbumPage(page) {
  const wrapper = document.createElement("div");
  wrapper.className = "cleanup-album-page";
  wrapper.dataset.cleanupAlbumPage = String(page.page);
  const entries = cleanupAlbumSections(page.items);
  wrapper.cleanupFirstSection = entries.length ? entries[0].label : "";
  wrapper.cleanupLastSection = entries.length ? entries[entries.length - 1].label : "";
  for (const entry of entries) {
    const section = document.createElement("section");
    section.className = "cleanup-month-section";
    const heading = document.createElement("header");
    heading.className = "cleanup-month-header";
    const title = document.createElement("h4");
    title.textContent = entry.label;
    const count = document.createElement("span");
    count.textContent = `${entry.items.length.toLocaleString()} 組`;
    heading.append(title, count);
    const grid = document.createElement("div");
    grid.className = "cleanup-review-grid cleanup-album-grid";
    for (const review of entry.items) grid.append(renderCleanupReview(review));
    section.append(heading, grid);
    wrapper.append(section);
  }
  return wrapper;
}

function updateCleanupAlbumContinuations(session) {
  const pages = Array.from(session.pages.entries())
    .sort(([left], [right]) => left - right);
  let previous = null;
  for (const [pageNumber, entry] of pages) {
    const firstSection = entry.node.querySelector(".cleanup-month-section");
    const continues = Boolean(
      previous &&
      previous.pageNumber + 1 === pageNumber &&
      previous.node.cleanupLastSection &&
      previous.node.cleanupLastSection === entry.node.cleanupFirstSection
    );
    if (firstSection) firstSection.classList.toggle("is-continuation", continues);
    previous = { pageNumber, node: entry.node };
  }
}

function cleanupAlbumEstimatedPageHeight(session) {
  const width = Math.max(360, elements.cleanupList.clientWidth - 20);
  const columns = Math.max(2, Math.floor((width + 8) / 200));
  return Math.ceil(session.pageSize / columns) * 330 + 72;
}

function cleanupAlbumSpacerHeight(session, firstPage, lastPage) {
  if (lastPage < firstPage) return 0;
  const estimate = cleanupAlbumEstimatedPageHeight(session);
  let height = (lastPage - firstPage + 1) * estimate;
  for (const [page, measured] of session.pageHeights) {
    if (page >= firstPage && page <= lastPage) height += measured - estimate;
  }
  return Math.max(0, height);
}

function cleanupAlbumPageRange(session) {
  const pages = Array.from(session.pages.keys()).sort((left, right) => left - right);
  return {
    min: pages.length ? pages[0] : 1,
    max: pages.length ? pages[pages.length - 1] : 0
  };
}

function updateCleanupAlbumSpacers(session) {
  if (session.disposed || cleanupAlbumSession !== session) return;
  const range = cleanupAlbumPageRange(session);
  const topHeight = cleanupAlbumSpacerHeight(session, 1, range.min - 1);
  const bottomHeight = cleanupAlbumSpacerHeight(session, range.max + 1, session.totalPages);
  session.topSpacer.style.height = `${topHeight}px`;
  session.bottomSpacer.style.height = `${bottomHeight}px`;
  session.topSpacer.dataset.height = String(topHeight);
  session.bottomSpacer.dataset.height = String(bottomHeight);
}

function updateCleanupAlbumStatus(session) {
  if (session.disposed || cleanupAlbumSession !== session) return;
  const range = cleanupAlbumPageRange(session);
  const first = session.totalItems ? (range.min - 1) * session.pageSize + 1 : 0;
  const last = Math.min(session.totalItems, range.max * session.pageSize);
  const loaded = first ? `${first.toLocaleString()}–${last.toLocaleString()}` : "0";
  session.status.textContent = range.max < session.totalPages
    ? `已載入 ${loaded} / ${session.totalItems.toLocaleString()} 組；繼續捲動會自動載入`
    : `已載入 ${loaded} / ${session.totalItems.toLocaleString()} 組；已到最早的附件`;
  elements.cleanupPageInfo.textContent =
    `連續捲動 · ${session.totalItems.toLocaleString()} 組附件`;
}

function measureCleanupAlbumPage(session, pageNumber, node) {
  if (!node.isConnected || session.disposed) return 0;
  const height = Math.ceil(node.getBoundingClientRect().height);
  if (height > 0) session.pageHeights.set(pageNumber, height);
  return height;
}

function mountCleanupAlbumPage(session, page, direction) {
  if (session.pages.has(page.page)) return null;
  const node = renderCleanupAlbumPage(page);
  if (direction === "previous") session.pagesHost.prepend(node);
  else session.pagesHost.append(node);
  session.pages.set(page.page, { node });
  if (session.resizeObserver) session.resizeObserver.observe(node);
  updateCleanupAlbumContinuations(session);
  void hydrateCleanupPreviews(node, session.renderGeneration);
  return node;
}

function trimCleanupAlbumPages(session, direction) {
  while (session.pages.size > CLEANUP_ALBUM_MAX_PAGES) {
    const range = cleanupAlbumPageRange(session);
    const pageNumber = direction === "previous" ? range.max : range.min;
    const entry = session.pages.get(pageNumber);
    if (!entry) break;
    measureCleanupAlbumPage(session, pageNumber, entry.node);
    if (session.resizeObserver) session.resizeObserver.unobserve(entry.node);
    entry.node.remove();
    session.pages.delete(pageNumber);
  }
  updateCleanupAlbumContinuations(session);
}

async function loadCleanupAlbumPage(session, pageNumber, direction) {
  if (!provider || session.disposed || cleanupAlbumSession !== session ||
      session.loading || pageNumber < 1 || pageNumber > session.totalPages ||
      session.pages.has(pageNumber)) return;
  session.loading = true;
  session.status.textContent = "正在載入相鄰月份的附件…";
  const oldScrollTop = elements.cleanupList.scrollTop;
  const oldTopHeight = Number(session.topSpacer.dataset.height) || 0;
  let loaded = false;
  try {
    const page = await provider.listCleanupReviews(
      session.groupKey,
      cleanupOptions({ page: pageNumber, pageSize: session.pageSize })
    );
    if (session.disposed || cleanupAlbumSession !== session ||
        cleanupState.groupKey !== session.groupKey) return;
    const node = mountCleanupAlbumPage(session, page, direction);
    if (!node) return;
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    const insertedHeight = measureCleanupAlbumPage(session, pageNumber, node);
    trimCleanupAlbumPages(session, direction);
    updateCleanupAlbumSpacers(session);
    if (direction === "previous") {
      const newTopHeight = Number(session.topSpacer.dataset.height) || 0;
      elements.cleanupList.scrollTop =
        oldScrollTop + newTopHeight + insertedHeight - oldTopHeight;
    }
    updateCleanupAlbumStatus(session);
    loaded = true;
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    session.loading = false;
    if (loaded) window.requestAnimationFrame(handleCleanupAlbumScroll);
  }
}

function handleCleanupAlbumScroll() {
  const session = cleanupAlbumSession;
  if (!session || session.disposed || session.loading) return;
  const range = cleanupAlbumPageRange(session);
  const viewport = elements.cleanupList;
  const threshold = Math.max(320, viewport.clientHeight * 0.75);
  const topHeight = Number(session.topSpacer.dataset.height) || 0;
  const bottomHeight = Number(session.bottomSpacer.dataset.height) || 0;
  if (range.min > 1 && viewport.scrollTop <= topHeight + threshold) {
    void loadCleanupAlbumPage(session, range.min - 1, "previous");
    return;
  }
  if (range.max < session.totalPages &&
      viewport.scrollTop + viewport.clientHeight >=
        viewport.scrollHeight - bottomHeight - threshold) {
    void loadCleanupAlbumPage(session, range.max + 1, "next");
  }
}

function renderCleanupAlbum(page, renderGeneration) {
  elements.cleanupView.classList.add("is-detail");
  const group = page.group;
  elements.cleanupResultInfo.textContent = page.totalItems
    ? `正在檢視「${group.chatTitle}」的 ${page.totalItems.toLocaleString()} 組附件；依月份分段並按需載入。`
    : "";
  const section = document.createElement("section");
  section.className = "cleanup-chat-group";
  const header = document.createElement("header");
  header.className = "cleanup-chat-header";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "cleanup-back";
  back.dataset.cleanupBack = "";
  back.textContent = "返回聊天室列表";
  const avatar = document.createElement("span");
  avatar.className = "cleanup-chat-avatar";
  avatar.textContent = chatIcon(group.chatKind);
  const title = document.createElement("div");
  title.className = "cleanup-chat-title";
  const titleRow = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = group.chatTitle;
  const badge = document.createElement("span");
  badge.className = "cleanup-chat-type";
  badge.textContent = cleanupStatusLabel(group.referenceStatus);
  titleRow.append(heading, badge);
  const summary = document.createElement("p");
  summary.textContent =
    `${group.referenceStatus === "referenced" ? cleanupStatusSummary(group.chatKind) : cleanupStatusSummary(group.referenceStatus)} · ` +
    `${page.totalItems.toLocaleString()} 組附件 · 連續捲動`;
  title.append(titleRow, summary);
  header.append(back, avatar, title);
  section.append(header);

  if (!page.items.length) {
    section.append(emptyState("找不到符合條件的附件。可以清除搜尋文字或切換「顯示」篩選。"));
    elements.cleanupList.replaceChildren(section);
    elements.cleanupPageInfo.textContent = "連續捲動 · 0 組附件";
    elements.cleanupPrev.disabled = true;
    elements.cleanupNext.disabled = true;
    return;
  }

  const album = document.createElement("div");
  album.className = "cleanup-album";
  album.setAttribute("role", "feed");
  album.setAttribute("aria-label", `${group.chatTitle} 的附件相簿`);
  const topSpacer = document.createElement("div");
  topSpacer.className = "cleanup-album-spacer";
  topSpacer.setAttribute("aria-hidden", "true");
  const pagesHost = document.createElement("div");
  pagesHost.className = "cleanup-album-pages";
  const bottomSpacer = document.createElement("div");
  bottomSpacer.className = "cleanup-album-spacer";
  bottomSpacer.setAttribute("aria-hidden", "true");
  const status = document.createElement("p");
  status.className = "cleanup-album-status";
  status.setAttribute("role", "status");
  album.append(topSpacer, pagesHost, status, bottomSpacer);
  section.append(album);
  elements.cleanupList.replaceChildren(section);
  elements.cleanupList.scrollTop = 0;

  const session = {
    disposed: false,
    loading: false,
    groupKey: cleanupState.groupKey,
    pageSize: page.pageSize,
    totalItems: page.totalItems,
    totalPages: page.totalPages,
    renderGeneration,
    pages: new Map(),
    pageHeights: new Map(),
    topSpacer,
    pagesHost,
    bottomSpacer,
    status,
    resizeObserver: null
  };
  if (typeof ResizeObserver === "function") {
    session.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const pageNumber = Number(entry.target.dataset.cleanupAlbumPage);
        if (Number.isInteger(pageNumber)) {
          session.pageHeights.set(pageNumber, Math.ceil(entry.contentRect.height));
        }
      }
      updateCleanupAlbumSpacers(session);
    });
  }
  cleanupAlbumSession = session;
  mountCleanupAlbumPage(session, page, "next");
  updateCleanupAlbumSpacers(session);
  updateCleanupAlbumStatus(session);
  elements.cleanupPrev.disabled = true;
  elements.cleanupNext.disabled = true;
  window.requestAnimationFrame(() => {
    const entry = session.pages.get(page.page);
    if (entry) measureCleanupAlbumPage(session, page.page, entry.node);
    updateCleanupAlbumSpacers(session);
    handleCleanupAlbumScroll();
  });
}

function renderCleanupReview(review) {
  const card = document.createElement("article");
  card.className = "cleanup-review-card";
  const preview = document.createElement("button");
  preview.type = "button";
  preview.className = "cleanup-preview";
  preview.disabled = true;
  const previewIcon = document.createElement("span");
  previewIcon.className = "cleanup-preview-fallback";
  previewIcon.textContent = review.files.some((file) => file.kind === "thumbnail") ? "縮圖" : "附件";
  const previewNote = document.createElement("small");
  const originalImage = review.files.find((file) =>
    file.kind === "original" && /\.(?:jpe?g|png|gif|webp|bmp|avif)$/i.test(file.path)
  );
  const thumbnail = review.files.find((file) => file.kind === "thumbnail");
  const previewPaths = [originalImage, thumbnail]
    .filter(Boolean)
    .map((file) => file.path)
    .filter((path, index, paths) => paths.indexOf(path) === index);
  previewNote.textContent = previewPaths.length ? "載入預覽…" : "沒有影像預覽";
  preview.previewPaths = previewPaths;
  preview.append(previewIcon, previewNote);

  const content = document.createElement("div");
  content.className = "cleanup-review-context";
  if (review.context) {
    const meta = document.createElement("div");
    meta.className = "cleanup-message-meta";
    const sender = document.createElement("span");
    sender.textContent = review.context.senderName || "未知傳送者";
    const time = document.createElement("time");
    time.textContent = formatTimestamp(review.context.timestamp);
    meta.append(sender, time);
    const summary = document.createElement("p");
    summary.className = "cleanup-message-summary";
    summary.textContent = review.context.text || `沒有文字內容（類型 ${review.context.contentType ?? "?"}）`;
    content.append(meta, summary);
  } else {
    const meta = document.createElement("div");
    meta.className = "cleanup-message-meta uncertain";
    const heading = document.createElement("span");
    heading.textContent = review.referenceStatus === "unreferenced"
      ? "SQLite 未引用這個附件"
      : "無法確認對應訊息";
    const detail = document.createElement("span");
    detail.textContent = review.messageId ? `訊息 ID ${review.messageId}` : "無法取得訊息 ID";
    meta.append(heading, detail);
    const summary = document.createElement("p");
    summary.className = "cleanup-message-summary";
    summary.textContent = review.referenceStatus === "unreferenced"
      ? "此檔案暫未被目前資料庫引用，仍請檢視檔名後再決定是否刪除。"
      : "資料庫關聯不足，請保守處理。";
    content.append(meta, summary);
  }
  content.append(renderEvidence(review));
  const choices = document.createElement("div");
  choices.className = "cleanup-file-choices";
  for (const file of review.files) choices.append(renderFileChoice(file));
  content.append(choices);
  card.append(preview, content);
  return card;
}

async function hydrateCleanupPreviews(section, renderGeneration) {
  const previews = Array.from(section.querySelectorAll(".cleanup-preview"))
    .filter((preview) => Array.isArray(preview.previewPaths) && preview.previewPaths.length);
  let next = 0;
  async function worker() {
    while (next < previews.length) {
      const preview = previews[next];
      next += 1;
      let url = null;
      let caption = "附件預覽";
      for (const path of preview.previewPaths) {
        try {
          url = await bridge.attachmentPreviewUrl(path);
          caption = fileName(path);
          if (url) break;
        } catch (_error) {
          // Try the thumbnail fallback before leaving the bounded placeholder.
        }
      }
      if (!url || renderGeneration !== cleanupRenderGeneration || !preview.isConnected) continue;
      const image = document.createElement("img");
      image.alt = caption;
      image.loading = "lazy";
      image.decoding = "async";
      const open = document.createElement("span");
      open.className = "cleanup-preview-open";
      open.textContent = "點擊放大";
      image.addEventListener("error", () => {
        image.remove();
        open.remove();
        preview.disabled = true;
      }, { once: true });
      preview.disabled = false;
      preview.setAttribute("aria-label", `放大預覽：${caption}`);
      preview.addEventListener("click", () => showImageModal(url, caption, preview));
      preview.prepend(image);
      preview.append(open);
      image.src = url;
      const note = preview.querySelector("small");
      if (note) note.remove();
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, previews.length) }, () => worker()));
}

function renderEvidence(review) {
  const details = document.createElement("details");
  details.className = "cleanup-evidence";
  const summary = document.createElement("summary");
  summary.textContent = "查看 SQLite 證據";
  const evidence = document.createElement("small");
  evidence.textContent = [
    `messageId=${review.messageId || "無"}`,
    `messagePk=${review.context ? review.context.messagePk : "無"}`,
    `chatPk=${review.context ? review.context.chatPk : "無"}`,
    `referenceStatus=${review.referenceStatus}`,
    `confidence=${review.referenceStatus === "referenced" ? "exact" : "unconfirmed"}`
  ].join("；");
  details.append(summary, evidence);
  return details;
}

function renderFileChoice(file) {
  const choice = document.createElement("label");
  choice.className = "cleanup-file-choice";
  const impactText = file.kind === "thumbnail"
    ? "刪除縮圖可能讓聊天紀錄失去預覽，即使原始附件仍存在。"
    : "刪除後 LINE 可能無法顯示原始畫質；保留縮圖時仍可能看到低畫質預覽。";
  choice.title = impactText;
  choice.setAttribute("aria-description", impactText);
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = file.markedForRemoval;
  checkbox.dataset.attachmentPath = file.path;
  const main = document.createElement("span");
  main.className = "cleanup-file-choice-main";
  const title = document.createElement("span");
  title.className = "cleanup-file-title";
  const name = document.createElement("strong");
  name.textContent = fileName(file.path);
  const kind = document.createElement("span");
  kind.className = `cleanup-kind-badge ${file.kind}`;
  kind.textContent = file.kind === "thumbnail" ? "縮圖" : "原始附件";
  title.append(name, kind);
  const size = document.createElement("small");
  size.textContent = `${file.kind === "thumbnail" ? "縮圖" : "原始附件"} · ${formatBytes(file.bytes)}`;
  const impact = document.createElement("span");
  impact.className = "cleanup-impact";
  impact.textContent = impactText;
  const path = document.createElement("details");
  path.className = "cleanup-path";
  const pathSummary = document.createElement("summary");
  pathSummary.textContent = "查看實際檔名與路徑";
  const code = document.createElement("code");
  code.textContent = file.path;
  path.append(pathSummary, code);
  main.append(title, size, impact, path);
  const deleteLabel = document.createElement("span");
  deleteLabel.className = "cleanup-delete-label";
  deleteLabel.textContent = "刪除此檔";
  choice.append(checkbox, main, deleteLabel);
  return choice;
}

async function changeAttachmentMark(checkbox) {
  const path = checkbox.dataset.attachmentPath;
  checkbox.disabled = true;
  try {
    await provider.setAttachmentMarked(path, checkbox.checked);
    if (cleanupState.kind === "marked") {
      await loadCleanupPage();
    } else {
      cleanupOverview = await provider.cleanupOverview();
      renderCleanupOverview();
    }
  } catch (error) {
    checkbox.checked = !checkbox.checked;
    setStatus(error.message, true);
  } finally {
    checkbox.disabled = false;
  }
}

async function applyGroupAction(groupKey, action, button) {
  button.disabled = true;
  try {
    await provider.applyCleanupGroupAction(groupKey, action);
    await loadCleanupPage();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function buildCandidate() {
  let modalShown = false;
  try {
    const output = await bridge.chooseCandidateOutput();
    if (!output) return;
    const initialMessage = `正在建立 ${output.displayName}，請勿關閉此視窗。`;
    setStatus(initialMessage);
    showPackageModal(initialMessage);
    modalShown = true;
    packageInProgress = true;
    elements.buildCandidate.disabled = true;
    const report = await provider.buildCandidate(output.token, { fullCrc: true });
    const successMessage =
      `候選檔完成：保留 ${report.outputEntries.toLocaleString()} 筆、` +
      `移除 ${report.removedEntries.toLocaleString()} 筆，完整 CRC 驗證完成。`;
    setStatus(successMessage);
    packageInProgress = false;
    completePackageModal(false, "瘦身 .imazingapp 已建立", successMessage);
  } catch (error) {
    setStatus(error.message, true);
    packageInProgress = false;
    if (modalShown) {
      completePackageModal(true, "建立失敗", `瘦身 .imazingapp 建立失敗：${error.message}`);
    }
  } finally {
    packageInProgress = false;
    elements.buildCandidate.disabled = false;
  }
}

function updateCleanupFilter() {
  cleanupState.kind = elements.cleanupKind.value;
  cleanupState.category = elements.cleanupCategory.value;
  cleanupState.sort = elements.cleanupSort.value;
  cleanupState.page = 1;
  void loadCleanupPage();
}

for (const button of document.querySelectorAll("[data-source]")) {
  button.addEventListener("click", () => void openSource(button.dataset.source));
}
elements.enterWorkspace.addEventListener("click", enterWorkspace);
elements.changeSource.addEventListener("click", returnToWelcome);
const sidebarItems = Array.from(document.querySelectorAll("[data-view]"));
for (const button of sidebarItems) {
  button.addEventListener("click", () => setWorkspaceView(button.dataset.view));
  button.addEventListener("keydown", (event) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = sidebarItems.indexOf(button);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? sidebarItems.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + sidebarItems.length) %
          sidebarItems.length;
    sidebarItems[next].focus();
  });
}
elements.nextChats.addEventListener("click", () => void loadChats(chatCursor));
elements.nextMessages.addEventListener("click", () => void loadMessages(messageCursor));
elements.scanCatalog.addEventListener("click", () => void scanCatalog());
elements.buildCandidate.addEventListener("click", () => void buildCandidate());
elements.packageModalClose.addEventListener("click", closePackageModal);
elements.imageModalClose.addEventListener("click", closeImageModal);
elements.imageModal.addEventListener("click", (event) => {
  if (event.target === elements.imageModal ||
      event.target.classList.contains("image-modal-backdrop")) {
    closeImageModal();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeImageModal();
});
elements.searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  activeSearch = elements.searchQuery.value.trim();
  messageCursor = null;
  if (!activeSearch) return;
  try {
    await loadMessages(null);
  } catch (error) {
    setStatus(error.message, true);
  }
});
elements.cleanupKind.addEventListener("change", updateCleanupFilter);
elements.cleanupCategory.addEventListener("change", updateCleanupFilter);
elements.cleanupSort.addEventListener("change", updateCleanupFilter);
elements.cleanupSearch.addEventListener("input", () => {
  clearTimeout(cleanupSearchTimer);
  cleanupSearchTimer = setTimeout(() => {
    cleanupState.search = elements.cleanupSearch.value.trim();
    cleanupState.page = 1;
    void loadCleanupPage();
  }, 250);
});
window.addEventListener("resize", () => {
  clearTimeout(cleanupResizeTimer);
  cleanupResizeTimer = setTimeout(() => {
    if (cleanupAlbumSession) updateCleanupAlbumSpacers(cleanupAlbumSession);
  }, 180);
});
elements.categorySummary.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-category]");
  if (!button) return;
  cleanupState.category = button.dataset.category || "all";
  cleanupState.groupKey = null;
  cleanupState.page = 1;
  elements.cleanupCategory.value = cleanupState.category;
  void loadCleanupPage();
});
elements.cleanupPrev.addEventListener("click", () => {
  if (cleanupState.groupKey || !cleanupPage || cleanupState.page <= 1) return;
  cleanupState.page -= 1;
  void loadCleanupPage();
});
elements.cleanupNext.addEventListener("click", () => {
  if (cleanupState.groupKey || !cleanupPage || cleanupState.page >= cleanupPage.totalPages) return;
  cleanupState.page += 1;
  void loadCleanupPage();
});
elements.cleanupList.addEventListener("scroll", handleCleanupAlbumScroll, { passive: true });
elements.cleanupList.addEventListener("click", (event) => {
  const open = event.target.closest("button[data-open-group]");
  if (open) {
    cleanupState.groupKey = open.dataset.openGroup;
    cleanupState.page = 1;
    void loadCleanupPage();
    return;
  }
  const back = event.target.closest("button[data-cleanup-back]");
  if (back) {
    cleanupState.groupKey = null;
    cleanupState.page = 1;
    void loadCleanupPage();
    return;
  }
  const action = event.target.closest("button[data-group-action]");
  if (action) {
    void applyGroupAction(action.dataset.groupKey, action.dataset.groupAction, action);
  }
});
elements.cleanupList.addEventListener("change", (event) => {
  const checkbox = event.target.closest("input[data-attachment-path]");
  if (checkbox) void changeAttachmentMark(checkbox);
});

bridge.on("catalogProgress", (event) => {
  elements.progress.removeAttribute("value");
  elements.catalogSummary.textContent =
    `已掃描 ${event.files.toLocaleString()} 個檔案，找到 ${event.attachments.toLocaleString()} 個附件`;
  if (!elements.loadModal.classList.contains("hidden")) {
    const percent = activeSourceBytes > 0
      ? 20 + Math.min(38, (Number(event.bytes) / activeSourceBytes) * 38)
      : Math.min(58, 20 + Math.log10(Math.max(1, Number(event.files))) * 9);
    updateLoadModalProgress(
      percent,
      `正在建立檔案索引…（${event.files.toLocaleString()} 個檔案）`
    );
  }
});
bridge.on("catalogContextProgress", (event) => {
  elements.progress.max = Math.max(event.totalFiles, 1);
  elements.progress.value = event.processedFiles;
  elements.catalogSummary.textContent =
    `正在比對 SQLite：${event.processedFiles.toLocaleString()} / ${event.totalFiles.toLocaleString()} 個附件`;
  if (!elements.loadModal.classList.contains("hidden")) {
    const ratio = event.totalFiles
      ? Number(event.processedFiles) / Number(event.totalFiles)
      : 1;
    updateLoadModalProgress(
      60 + ratio * 30,
      `正在比對 SQLite…（${event.processedFiles.toLocaleString()} / ${event.totalFiles.toLocaleString()}）`
    );
  }
});
bridge.on("candidateProgress", (event) => {
  elements.progress.max = Math.max(event.totalBytes, 1);
  elements.progress.value = event.processedBytes;
  if (!elements.packageModal.classList.contains("hidden")) {
    const ratio = event.totalBytes
      ? Number(event.processedBytes) / Number(event.totalBytes)
      : 1;
    updatePackageModalProgress(
      ratio * 100,
      `正在寫入檔案…（${event.processedEntries.toLocaleString()} / ${event.totalEntries.toLocaleString()}）`
    );
  }
});
