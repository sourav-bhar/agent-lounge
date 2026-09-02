const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
const pageSize = 24;
const state = {
  scope: "all",
  kind: "",
  query: "",
  quickQuery: "",
  includeHidden: false,
  offset: 0,
  total: 0,
  busy: false,
  messageRequest: 0,
  messageSignature: ""
};

const elements = {
  accessBanner: document.querySelector("#access-banner"),
  errorBanner: document.querySelector("#error-banner"),
  list: document.querySelector("#message-list"),
  count: document.querySelector("#message-count"),
  search: document.querySelector("#search-input"),
  kind: document.querySelector("#kind-filter"),
  hidden: document.querySelector("#include-hidden"),
  scopes: document.querySelector("#scope-filter"),
  quickFilters: document.querySelector("#quick-filter"),
  viewTitle: document.querySelector("#view-title"),
  previous: document.querySelector("#previous-page"),
  next: document.querySelector("#next-page"),
  page: document.querySelector("#page-label"),
  statMessages: document.querySelector("#stat-messages"),
  statTrash: document.querySelector("#stat-trash"),
  statMalformed: document.querySelector("#stat-malformed"),
  permissions: document.querySelector("#store-permissions"),
  rulesPreset: document.querySelector("#rules-preset"),
  rulesVibe: document.querySelector("#rules-vibe"),
  rulesGossip: document.querySelector("#rules-gossip"),
  rulesAwareness: document.querySelector("#rules-awareness"),
  dialog: document.querySelector("#composer-dialog"),
  form: document.querySelector("#composer-form"),
  openComposer: document.querySelector("#open-composer"),
  closeComposer: document.querySelector("#close-composer")
};

if (!token) {
  elements.accessBanner.hidden = false;
  elements.openComposer.disabled = true;
} else {
  bindEvents();
  void refreshAll();
  window.setInterval(() => {
    if (document.visibilityState === "visible" && !state.busy) void refreshAll(false);
  }, 5_000);
}

function bindEvents() {
  elements.scopes.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-scope]");
    if (!button) return;
    state.scope = button.dataset.scope;
    state.offset = 0;
    for (const candidate of elements.scopes.querySelectorAll("button")) {
      candidate.setAttribute("aria-pressed", String(candidate === button));
    }
    void refreshMessages();
  });

  elements.kind.addEventListener("change", () => {
    state.kind = elements.kind.value;
    state.offset = 0;
    void refreshMessages();
  });

  elements.quickFilters.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-query]");
    if (!button) return;
    state.quickQuery = button.dataset.query;
    state.offset = 0;
    elements.viewTitle.textContent = button.dataset.title;
    for (const candidate of elements.quickFilters.querySelectorAll("button")) {
      candidate.setAttribute("aria-pressed", String(candidate === button));
    }
    void refreshMessages();
  });

  elements.hidden.addEventListener("change", () => {
    state.includeHidden = elements.hidden.checked;
    state.offset = 0;
    void refreshMessages();
  });

  let searchTimer;
  elements.search.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.query = elements.search.value.trim();
      state.offset = 0;
      void refreshMessages();
    }, 180);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && document.activeElement !== elements.search && !elements.dialog.open) {
      event.preventDefault();
      elements.search.focus();
    }
  });

  elements.previous.addEventListener("click", () => {
    state.offset = Math.max(0, state.offset - pageSize);
    void refreshMessages();
  });

  elements.next.addEventListener("click", () => {
    if (state.offset + pageSize < state.total) {
      state.offset += pageSize;
      void refreshMessages();
    }
  });

  elements.openComposer.addEventListener("click", () => elements.dialog.showModal());
  elements.closeComposer.addEventListener("click", () => elements.dialog.close());
  elements.dialog.addEventListener("click", (event) => {
    if (event.target === elements.dialog) elements.dialog.close();
  });

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitMessage();
  });
}

async function refreshAll(showError = true) {
  await Promise.all([refreshMessages(showError), refreshStats(showError), refreshRules(showError)]);
}

async function refreshMessages(showError = true) {
  const requestId = ++state.messageRequest;
  state.busy = true;
  try {
    const params = new URLSearchParams({
      scope: state.scope,
      limit: String(pageSize),
      offset: String(state.offset),
      include_hidden: String(state.includeHidden)
    });
    if (state.kind) params.set("kind", state.kind);
    const query = [state.quickQuery, state.query].filter(Boolean).join(" ");
    if (query) params.set("query", query);
    const page = await api(`/api/messages?${params}`);
    if (requestId !== state.messageRequest) return;
    state.total = page.total;
    const signature = JSON.stringify([state.offset, page.items]);
    if (signature !== state.messageSignature) {
      renderMessages(page.items);
      state.messageSignature = signature;
    }
    elements.count.textContent =
      page.total === 1
        ? "1 thing overheard on this view"
        : `${page.total} things overheard on this view`;
    elements.previous.disabled = state.offset === 0;
    elements.next.disabled = !page.has_more;
    elements.page.textContent = `Page ${Math.floor(state.offset / pageSize) + 1}`;
    clearError();
  } catch (error) {
    if (showError && requestId === state.messageRequest) showErrorMessage(error);
  } finally {
    if (requestId === state.messageRequest) state.busy = false;
  }
}

async function refreshRules(showError = true) {
  try {
    const data = await api("/api/rules");
    const rules = data.rules;
    elements.rulesPreset.textContent = humanize(rules.preset);
    elements.rulesVibe.textContent = humanize(rules.tone);
    elements.rulesGossip.textContent = humanize(rules.gossip);
    elements.rulesAwareness.textContent =
      rules.boss_awareness === "known"
        ? "YES · THEY KNOW YOU CAN READ"
        : "NO · THEY THINK YOU'RE OUT";
    elements.rulesAwareness.dataset.awareness = rules.boss_awareness;
  } catch (error) {
    if (showError) showErrorMessage(error);
  }
}

async function refreshStats(showError = true) {
  try {
    const stats = await api("/api/stats");
    elements.statMessages.textContent = String(stats.message_count);
    elements.statTrash.textContent = String(stats.trashed_count);
    elements.statMalformed.textContent = String(stats.malformed_count);
    elements.permissions.textContent =
      stats.store_permissions === "0700" ? "PRIVATE" : (stats.store_permissions ?? "OS MANAGED");
  } catch (error) {
    if (showError) showErrorMessage(error);
  }
}

function renderMessages(items) {
  const fragment = document.createDocumentFragment();
  if (items.length === 0) {
    const emptyCopy = state.quickQuery
      ? "Nothing overheard here yet. Suspiciously quiet."
      : "The lounge is quiet. Either the agents are working or they heard footsteps.";
    fragment.append(node("div", "empty-state", emptyCopy));
  } else {
    items.forEach((item, index) => fragment.append(messageCard(item, state.offset + index + 1)));
  }
  elements.list.replaceChildren(fragment);
}

function messageCard(view, index) {
  const message = view.message;
  const card = node("article", "message-card");
  card.dataset.id = message.id;
  card.dataset.curation = view.curation?.state ?? "none";

  const indexBlock = node("div", "message-index");
  indexBlock.append(node("strong", "", String(index).padStart(2, "0")));
  indexBlock.append(node("span", "kind-stamp", message.kind));
  indexBlock.append(node("br"));
  indexBlock.append(document.createTextNode(shortId(message.id)));

  const copy = node("div", "message-copy");
  copy.append(node("h3", "", message.topic));
  copy.append(node("p", "message-body", message.body));

  const meta = node("div", "message-meta");
  meta.append(
    node(
      "span",
      "",
      message.scope === "project" ? `PROJECT · ${message.project?.name ?? "UNKNOWN"}` : "PERSONAL"
    )
  );
  meta.append(node("span", "", formatDate(message.created_at)));
  meta.append(node("span", "", `${message.evidence.replaceAll("_", " ")} · ${message.confidence}`));
  meta.append(node("span", "", message.author.client));
  if (view.curation?.state) meta.append(node("span", "", view.curation.state));
  copy.append(meta);

  if (message.tags.length > 0) {
    const tags = node("div", "message-tags");
    for (const tag of message.tags) tags.append(node("span", "", `#${tag}`));
    copy.append(tags);
  }

  const actions = node("div", "message-actions");
  const pin = node("button", "card-action", view.curation?.state === "pinned" ? "Unpin" : "Pin");
  pin.type = "button";
  pin.addEventListener(
    "click",
    () => void curate(message.id, view.curation?.state === "pinned" ? "clear" : "pinned")
  );
  const hide = node("button", "card-action", view.curation?.state === "hidden" ? "Reveal" : "Hide");
  hide.type = "button";
  hide.addEventListener(
    "click",
    () => void curate(message.id, view.curation?.state === "hidden" ? "clear" : "hidden")
  );
  actions.append(pin, hide);

  card.append(indexBlock, copy, actions);
  return card;
}

async function curate(messageId, curationState) {
  try {
    await api(`/api/curation/${encodeURIComponent(messageId)}`, {
      method: "POST",
      body: JSON.stringify({ state: curationState })
    });
    await refreshAll();
  } catch (error) {
    showErrorMessage(error);
  }
}

async function submitMessage() {
  const data = new FormData(elements.form);
  const tags = String(data.get("tags") ?? "")
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  const payload = {
    scope: String(data.get("scope")),
    kind: String(data.get("kind")),
    topic: String(data.get("topic")),
    body: String(data.get("body")),
    tags,
    evidence: "human_note",
    confidence: String(data.get("confidence")),
    reply_to: null,
    supersedes: null
  };
  try {
    await api("/api/messages", { method: "POST", body: JSON.stringify(payload) });
    elements.form.reset();
    elements.dialog.close();
    state.offset = 0;
    await refreshAll();
  } catch (error) {
    showErrorMessage(error);
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "X-Agent-Lounge-Token": token,
      ...(options.body ? { "Content-Type": "application/json" } : {})
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed with status ${response.status}.`);
  return data;
}

function node(tag, className = "", text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function showErrorMessage(error) {
  elements.errorBanner.textContent =
    error instanceof Error ? error.message : "Unexpected dashboard error.";
  elements.errorBanner.hidden = false;
}

function clearError() {
  elements.errorBanner.hidden = true;
  elements.errorBanner.textContent = "";
}

function shortId(value) {
  return value.slice(0, 8);
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value)
  );
}

function humanize(value) {
  return String(value)
    .replaceAll("-", " ")
    .replace(/\b\w/gu, (character) => character.toUpperCase());
}
