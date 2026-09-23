type JsonRecord = Record<string, unknown>;

interface User { id: string; email: string; createdAt: string }
interface NoteSummary {
  id: string;
  title: string;
  isEncrypted: boolean;
  createdAt: string;
  attachmentCount: number;
  isPinned: boolean;
  updatedAt: string;
  totalReads?: number;
}
interface Attachment {
  id: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  originalName: string;
}
interface NoteDetail extends NoteSummary {
  content: string;
  attachments: Attachment[];
  links?: LinkItem[];
}
interface LinkItem {
  id: string;
  noteId: string;
  noteTitle?: string;
  isNoteEncrypted?: boolean;
  slug: string;
  hasPassphrase: boolean;
  expiresAt: string | null;
  maxReads: number | null;
  readsCount: number;
  isBurned: boolean;
  webhookId: string | null;
  createdAt: string;
}
interface WebhookItem { id: string; url: string; createdAt: string }
interface WebhookDetail extends WebhookItem { secret: string }
interface Paged<T> { data: T[]; page: number; limit: number }
interface Analytics {
  linkId: string;
  slug: string;
  noteTitle: string;
  summary: { totalClicks: number; uniqueVisitors: number; isBurned: boolean; readsCount: number; maxReads: number | null };
  breakdown: {
    clicksByDate: Record<string, number>;
    devices: Record<string, number>;
    browsers: Record<string, number>;
    operatingSystems: Record<string, number>;
    topReferrers: Record<string, number>;
  };
  recentAccesses: Array<{ ip: string; browser: string; os: string; device: string; referrer: string; accessedAt: string }>;
}
interface ShareInspection { slug: string; requiresPassphrase: boolean; isEncrypted?: boolean }
interface SharedNote {
  requiresPassphrase: false;
  title: string;
  content: string;
  isEncrypted: false;
  isBurned: boolean;
  readsCount: number;
  maxReads: number | null;
  attachments: Attachment[];
}

class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly details?: unknown) {
    super(message);
  }
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setHidden(id: string, hidden: boolean): void { byId(id).hidden = hidden; }
function value(id: string): string { return byId<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id).value; }
function setValue(id: string, next: string): void { byId<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id).value = next; }
function checked(id: string): boolean { return byId<HTMLInputElement>(id).checked; }

function formatDate(raw: string | null, withTime = false): string {
  if (!raw) return "Never";
  const options: Intl.DateTimeFormatOptions = withTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { year: "numeric", month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(undefined, options).format(new Date(raw));
}

function messageFrom(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}

let toastTimer: number | undefined;
function toast(message: string, isError = false): void {
  const node = byId("toast");
  node.textContent = message;
  node.className = `toast${isError ? " error" : ""}`;
  requestAnimationFrame(() => node.classList.add("show"));
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    node.classList.remove("show");
    node.textContent = "";
  }, 3600);
}

function setMessage(id: string, message = ""): void {
  const node = byId(id);
  node.textContent = message;
  node.hidden = !message;
}

function setBusy(control: HTMLButtonElement, busy: boolean, label?: string): void {
  if (busy) control.dataset.label = control.textContent ?? "";
  control.disabled = busy;
  control.textContent = busy ? "Working…" : (label ?? control.dataset.label ?? "Submit");
}

async function responseJson(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return null;
  return response.json();
}

function responseMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "message" in data && typeof data.message === "string") return data.message;
  return fallback;
}

let refreshPromise: Promise<boolean> | null = null;
let sessionExpired = false;
let currentUserId: string | null = null;
let expiredDraftUserId: string | null = null;

async function refreshSession(): Promise<boolean> {
  try {
    const response = await fetch("/auth/refresh", { method: "POST", credentials: "same-origin" });
    return response.ok;
  } catch {
    return false;
  }
}

async function refreshOnce(): Promise<boolean> {
  refreshPromise ??= refreshSession().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const request = withRequestDefaults(init);
  let response: Response;
  try {
    response = await fetch(path, request);
  } catch {
    throw new ApiError("Network error. The request may not have completed; it was not retried.", 0);
  }
  if (response.status === 401 && shouldRecoverSession(path)) response = await recoverAndRepeat(path, request);
  const data = await responseJson(response);
  if (!response.ok) throw new ApiError(responseMessage(data, `Request failed (${response.status})`), response.status, data);
  return data as T;
}

function shouldRecoverSession(path: string): boolean {
  return path !== "/auth/refresh" && path !== "/auth/login" && path !== "/auth/signup";
}

function withRequestDefaults(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return { ...init, headers, credentials: "same-origin" };
}

async function recoverAndRepeat(path: string, request: RequestInit): Promise<Response> {
  if (await refreshOnce()) return fetch(path, request);
  const hadWorkspace = !byId("app-screen").hidden;
  if (hadWorkspace) {
    sessionExpired = true;
    expiredDraftUserId = currentUserId;
  }
  showAuth(sessionExpired ? "Your session expired. Sign in again; your unsaved draft remains in this tab." : "");
  throw new ApiError("Session expired. Your unsaved draft remains in this tab.", 401);
}

async function publicRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, withRequestDefaults(init));
  } catch {
    throw new ApiError("Connection lost. This read was not retried and may have been consumed.", 0);
  }
  const data = await responseJson(response);
  if (!response.ok) throw new ApiError(responseMessage(data, `Request failed (${response.status})`), response.status, data);
  return data as T;
}

function applyTheme(theme: string): void {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch { /* storage may be blocked */ }
}

function toggleTheme(): void {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}

function showAuth(message = ""): void {
  document.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach((dialog) => dialog.close());
  setValue("login-password", "");
  setValue("signup-password", "");
  setHidden("public-share", true);
  setHidden("app-screen", true);
  setHidden("auth-screen", false);
  setMessage("auth-message", message);
}

function selectAuthTab(tab: "login" | "signup"): void {
  const login = tab === "login";
  byId("login-tab").classList.toggle("active", login);
  byId("signup-tab").classList.toggle("active", !login);
  byId("login-tab").setAttribute("aria-selected", String(login));
  byId("signup-tab").setAttribute("aria-selected", String(!login));
  setHidden("login-form", !login);
  setHidden("signup-form", login);
  setMessage("auth-message");
  byId<HTMLInputElement>(login ? "login-email" : "signup-email").focus();
}

async function submitAuth(event: SubmitEvent, mode: "login" | "signup"): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const submit = form.querySelector<HTMLButtonElement>("button[type=submit]");
  if (!submit || submit.disabled) return;
  const email = value(`${mode}-email`).trim();
  const password = value(`${mode}-password`);
  const names = mode === "signup" ? { firstName: value("signup-first-name"), lastName: value("signup-last-name") } : {};
  setBusy(submit, true);
  setMessage("auth-message");
  try {
    await api(`/auth/${mode}`, { method: "POST", body: JSON.stringify({ email, password, ...names }) });
    await enterApp();
  } catch (error) {
    setMessage("auth-message", messageFrom(error));
  } finally {
    setBusy(submit, false);
  }
}

async function enterApp(): Promise<void> {
  const { user } = await api<{ user: User }>("/auth/me");
  const preserveDraft = sessionExpired && noteState.dirty && expiredDraftUserId === user.id;
  if (!preserveDraft) resetPrivateState();
  currentUserId = user.id;
  expiredDraftUserId = null;
  sessionExpired = false;
  byId("user-email").textContent = user.email;
  setHidden("auth-screen", true);
  setHidden("public-share", true);
  setHidden("app-screen", false);
  showView("notes", false);
  if (preserveDraft) {
    toast("Signed in. Your unsaved draft is still open.");
    return;
  }
  await loadNotes(1);
}

async function logout(): Promise<void> {
  if (!canLeaveDirty("log out")) return;
  try {
    await api("/auth/logout", { method: "POST" });
  } catch (error) {
    toast(`Could not log out: ${messageFrom(error)}`, true);
    return;
  }
  resetPrivateState();
  currentUserId = null;
  expiredDraftUserId = null;
  sessionExpired = false;
  showAuth();
}

function shareSlug(): string | null {
  const match = location.pathname.match(/^\/share\/([^/]+)\/?$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

async function initPublicShare(slug: string): Promise<void> {
  setHidden("public-share", false);
  setHidden("auth-screen", true);
  setHidden("app-screen", true);
  renderShareLoading();
  try {
    const inspection = await publicRequest<ShareInspection>(`/${encodeURIComponent(slug)}`);
    renderShareChallenge(inspection);
  } catch (error) {
    renderShareError(error);
  }
}

function renderShareLoading(): void {
  const view = byId("share-view");
  view.replaceChildren(element("p", "share-intro", "Checking this link…"));
}

function shareErrorCopy(error: unknown): { title: string; body: string } {
  if (error instanceof ApiError && error.status === 404) return { title: "Link not found", body: "This link does not exist or its note was removed." };
  if (error instanceof ApiError && error.status === 410) return { title: "Link unavailable", body: error.message };
  return { title: "Could not open link", body: messageFrom(error) };
}

function renderShareError(error: unknown): void {
  const copy = shareErrorCopy(error);
  const view = byId("share-view");
  const title = element("h1", "", copy.title);
  const body = element("p", "share-intro", copy.body);
  view.replaceChildren(title, body);
}

function renderShareChallenge(inspection: ShareInspection): void {
  const view = byId("share-view");
  const title = element("h1", "", "Open shared note");
  const intro = element("p", "share-intro", "Opening the note records one read. Review the access requirements, then open it when you are ready.");
  const form = element("form");
  form.id = "share-access-form";
  addShareFields(form, inspection);
  const submit = element("button", "button primary full", "Open note →");
  submit.type = "submit";
  form.append(submit);
  form.addEventListener("submit", (event) => { void submitShare(event, inspection); });
  view.replaceChildren(title, intro, form);
  form.querySelector<HTMLInputElement>("input")?.focus();
}

function addShareFields(form: HTMLFormElement, inspection: ShareInspection): void {
  if (inspection.requiresPassphrase) form.append(makePasswordField("share-link-passphrase", "Link passphrase", "Controls access to this share URL"));
  if (inspection.isEncrypted) form.append(makePasswordField("share-note-passphrase", "Note passphrase", "Decrypts the note content; it is separate from the link passphrase"));
  if (!inspection.requiresPassphrase && !inspection.isEncrypted) {
    form.append(element("p", "field-note", "This link does not require a passphrase."));
  }
}

function makePasswordField(id: string, labelText: string, placeholder: string): HTMLLabelElement {
  const label = element("label", "", labelText);
  const input = element("input");
  input.id = id;
  input.type = "password";
  input.autocomplete = "current-password";
  input.required = true;
  input.placeholder = placeholder;
  label.append(input);
  return label;
}

async function submitShare(event: SubmitEvent, inspection: ShareInspection): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const submit = form.querySelector<HTMLButtonElement>("button[type=submit]");
  if (!submit || submit.disabled) return;
  const payload = sharePayload(inspection);
  setBusy(submit, true);
  try {
    const note = await publicRequest<SharedNote>(`/${encodeURIComponent(inspection.slug)}`, { method: "POST", body: JSON.stringify(payload) });
    renderSharedNote(note);
  } catch (error) {
    toast(messageFrom(error), true);
    if (error instanceof ApiError && (error.status === 404 || error.status === 410)) renderShareError(error);
  } finally {
    if (submit.isConnected) setBusy(submit, false);
  }
}

function sharePayload(inspection: ShareInspection): JsonRecord {
  const payload: JsonRecord = {};
  if (inspection.requiresPassphrase) payload.passphrase = value("share-link-passphrase");
  if (inspection.isEncrypted) payload.notePassphrase = value("share-note-passphrase");
  return payload;
}

function renderSharedNote(note: SharedNote): void {
  byId("toast").textContent = "";
  byId("toast").classList.remove("show", "error");
  const view = byId("share-view");
  const eyebrow = element("span", "eyebrow", "Shared note");
  const title = element("h1", "", note.title);
  const content = element("div", "shared-content", note.content);
  const limit = note.maxReads === null ? `${note.readsCount} read${note.readsCount === 1 ? "" : "s"}` : `${note.readsCount} of ${note.maxReads} reads used`;
  const notice = element("div", "final-read", note.isBurned
    ? `Final read · ${limit}. Keep this page open; the link cannot be reopened.`
    : `${limit}. This successful read has been recorded.`);
  view.replaceChildren(eyebrow, title, content, notice);
  const metrics = element("p", "field-note", readingMetrics(note.content));
  view.append(metrics, attachmentPreviews(note.attachments ?? []));
}

type AppView = "notes" | "links" | "webhooks";
const PAGE_SIZE = 20;
const noteState = {
  summaries: [] as NoteSummary[],
  page: 1,
  hasNext: false,
  selected: null as NoteDetail | null,
  isNew: false,
  unlockedPassphrase: null as string | null,
  baseline: "",
  dirty: false,
  loadSequence: 0,
};
const linkState = { items: [] as LinkItem[], page: 1, hasNext: false };
const webhookState = { items: [] as WebhookItem[], page: 1, hasNext: false };
let currentView: AppView = "notes";
let noteSaving = false;
let privateEpoch = 0;
let notesListSequence = 0;
let linkLoadSequence = 0;
let webhookLoadSequence = 0;
let linkDialogSequence = 0;
let analyticsSequence = 0;
let webhookDetailSequence = 0;
let autosaveTimer: number | undefined;
let searchTimer: number | undefined;

function resetPrivateState(): void {
  window.clearTimeout(autosaveTimer);
  window.clearTimeout(searchTimer);
  privateEpoch++;
  noteState.loadSequence++;
  notesListSequence++;
  linkLoadSequence++;
  webhookLoadSequence++;
  linkDialogSequence++;
  analyticsSequence++;
  webhookDetailSequence++;
  noteState.summaries = [];
  noteState.selected = null;
  noteState.isNew = false;
  noteState.unlockedPassphrase = null;
  noteState.baseline = "";
  noteState.dirty = false;
  noteState.page = 1;
  noteState.hasNext = false;
  linkState.items = [];
  linkState.page = 1;
  linkState.hasNext = false;
  webhookState.items = [];
  webhookState.page = 1;
  webhookState.hasNext = false;
  document.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach((dialog) => dialog.close());
  ["login-form", "signup-form", "note-form", "unlock-form", "create-link-form", "create-webhook-form"].forEach((id) => byId<HTMLFormElement>(id).reset());
  byId("user-email").textContent = "";
  byId("notes-list").replaceChildren();
  byId("links-list").replaceChildren();
  byId("webhooks-list").replaceChildren();
  byId("attachments-list").replaceChildren();
  byId("analytics-content").replaceChildren();
  byId("webhook-detail").replaceChildren();
  setValue("notes-search", "");
  showEditorEmpty();
}

function canLeaveDirty(action: string): boolean {
  if (noteSaving) {
    toast("Wait for the note save to finish", true);
    return false;
  }
  if (!noteState.dirty) return true;
  return window.confirm(`Discard unsaved note changes and ${action}?`);
}

function showView(view: AppView, checkDirty = true): boolean {
  if (view !== "notes" && checkDirty && !canLeaveDirty(`open ${view}`)) return false;
  currentView = view;
  document.querySelectorAll<HTMLButtonElement>(".nav-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  setHidden("notes-layout", view !== "notes");
  setHidden("links-view", view !== "links");
  setHidden("webhooks-view", view !== "webhooks");
  byId("app-screen").classList.remove("mobile-nav-open", "notes-panel-open");
  byId("mobile-menu").setAttribute("aria-expanded", "false");
  if (view === "links") void loadLinks(linkState.page);
  if (view === "webhooks") void loadWebhooks(webhookState.page);
  return true;
}

function setListState(id: string, message: string): void {
  byId(id).replaceChildren(element("div", "list-state", message));
}

async function loadNotes(page = noteState.page): Promise<void> {
  const sequence = ++notesListSequence;
  const epoch = privateEpoch;
  setListState("notes-list", "Loading notes…");
  try {
    const result = await api<Paged<NoteSummary>>(`/notes?page=${page}&limit=${PAGE_SIZE}&search=${encodeURIComponent(value("notes-search").trim())}`);
    if (sequence !== notesListSequence || epoch !== privateEpoch) return;
    noteState.summaries = result.data;
    noteState.page = result.page;
    noteState.hasNext = result.data.length === result.limit;
    renderNotes();
  } catch (error) {
    if (sequence !== notesListSequence || epoch !== privateEpoch) return;
    setListState("notes-list", messageFrom(error));
  }
}

function visibleNotes(): NoteSummary[] {
  return noteState.summaries;
}

function renderNotes(): void {
  const list = byId("notes-list");
  const notes = visibleNotes();
  list.replaceChildren();
  if (notes.length === 0) setListState("notes-list", value("notes-search").trim() ? "No matching notes" : "No notes on this page");
  notes.forEach((note) => list.append(renderNoteRow(note)));
  byId("notes-page").textContent = `Page ${noteState.page}`;
  byId<HTMLButtonElement>("notes-prev").disabled = noteState.page <= 1;
  byId<HTMLButtonElement>("notes-next").disabled = !noteState.hasNext;
}

function renderNoteRow(note: NoteSummary): HTMLButtonElement {
  const row = element("button", `note-row${note.id === noteState.selected?.id ? " active" : ""}`);
  row.type = "button";
  const title = element("span", "note-row-title", `${note.isPinned ? "⌖ " : ""}${note.title}`);
  const meta = element("span", "note-row-meta");
  meta.append(element("span", "", formatDate(note.createdAt)));
  const detail = `${note.isEncrypted ? "◇ · " : ""}${note.totalReads ?? 0} reads · ${note.attachmentCount} files`;
  meta.append(element("span", note.isEncrypted ? "note-row-lock" : "", detail));
  row.append(title, meta);
  row.addEventListener("click", () => { void selectNote(note.id); });
  return row;
}

async function selectNote(id: string): Promise<void> {
  if (!canLeaveDirty("open another note")) return;
  window.clearTimeout(autosaveTimer);
  const sequence = ++noteState.loadSequence;
  noteState.dirty = false;
  noteState.unlockedPassphrase = null;
  renderNotes();
  showEditorLoading();
  try {
    const note = await api<NoteDetail>(`/notes/${encodeURIComponent(id)}`);
    if (sequence !== noteState.loadSequence) return;
    noteState.selected = note;
    noteState.isNew = false;
    renderEditor(note);
    renderNotes();
    byId("app-screen").classList.remove("notes-panel-open");
  } catch (error) {
    if (sequence !== noteState.loadSequence) return;
    showEditorEmpty(messageFrom(error));
  }
}

function showEditorLoading(): void {
  setHidden("notes-empty", false);
  setHidden("note-form", true);
  byId("notes-empty").querySelector("h1")!.textContent = "Opening note";
  byId("notes-empty").querySelector("p")!.textContent = "Loading the latest saved version…";
}

function showEditorEmpty(message = "Select a note from the list or start a new one."): void {
  setHidden("notes-empty", false);
  setHidden("note-form", true);
  byId("notes-empty").querySelector("h1")!.textContent = "Your quiet corner";
  byId("notes-empty").querySelector("p")!.textContent = message;
}

function newNote(): void {
  if (!canLeaveDirty("create a new note")) return;
  window.clearTimeout(autosaveTimer);
  showView("notes", false);
  noteState.loadSequence++;
  noteState.selected = null;
  noteState.isNew = true;
  noteState.unlockedPassphrase = null;
  setValue("note-title", "");
  setValue("note-content", "");
  byId<HTMLInputElement>("encrypt-note").checked = false;
  setValue("note-passphrase", "");
  renderEditor(null);
  updateBaseline();
  renderNotes();
  byId("app-screen").classList.remove("notes-panel-open");
  byId<HTMLInputElement>("note-title").focus();
}

function renderEditor(note: NoteDetail | null): void {
  setHidden("notes-empty", true);
  setHidden("note-form", false);
  const locked = Boolean(note?.isEncrypted && !noteState.unlockedPassphrase);
  setValue("note-title", note?.title ?? "");
  setValue("note-content", locked ? "" : (note?.content ?? ""));
  byId<HTMLTextAreaElement>("note-content").disabled = locked;
  setHidden("note-content", locked);
  setHidden("locked-note", !locked);
  setHidden("unlock-note-button", !locked);
  setHidden("new-encryption-controls", Boolean(note?.isEncrypted));
  setHidden("existing-encryption-controls", !note?.isEncrypted || locked);
  setHidden("attachments-panel", false);
  setHidden("note-sharing-panel", !note?.id);
  byId("pin-note-button").textContent = note?.isPinned ? "Unpin note" : "Pin note";
  byId<HTMLButtonElement>("pin-note-button").disabled = !note;
  byId<HTMLButtonElement>("duplicate-note-button").disabled = !note || locked;
  byId<HTMLButtonElement>("export-note-button").disabled = locked;
  byId<HTMLInputElement>("encrypt-note").checked = false;
  setValue("note-passphrase", "");
  setValue("encryption-action", "keep");
  setValue("new-note-passphrase", "");
  syncEncryptionControls();
  updateEncryptionBadge(Boolean(note?.isEncrypted));
  byId("note-meta").textContent = note ? `Updated ${formatDate(note.updatedAt || note.createdAt, true)}` : "Unsaved draft";
  renderNoteLinks(note?.links ?? []);
  renderAttachments(note?.attachments ?? []);
  updateWordCount();
  updateBaseline();
}

function updateEncryptionBadge(encrypted: boolean): void {
  const badge = byId("encryption-badge");
  badge.textContent = encrypted ? "Encrypted" : "Plain text";
  badge.classList.toggle("secure", encrypted);
}

function editorSignature(): string {
  const locked = Boolean(noteState.selected?.isEncrypted && !noteState.unlockedPassphrase);
  return JSON.stringify({
    title: value("note-title"),
    content: locked ? null : value("note-content"),
    encrypt: checked("encrypt-note"),
    action: value("encryption-action"),
    passphrase: value("note-passphrase"),
    nextPassphrase: value("new-note-passphrase"),
  });
}

function updateBaseline(): void {
  noteState.baseline = editorSignature();
  noteState.dirty = false;
  renderDirtyState();
}

function refreshDirtyState(): void {
  noteState.dirty = editorSignature() !== noteState.baseline;
  renderDirtyState();
  updateWordCount();
  scheduleAutosave();
}

function renderDirtyState(): void {
  byId("note-state").textContent = noteState.dirty || noteState.isNew ? "Unsaved changes" : "Saved";
  byId("note-state-dot").classList.toggle("dirty", noteState.dirty);
}

function updateWordCount(): void {
  byId("note-count").textContent = readingMetrics(value("note-content"));
}

function readingMetrics(content: string): string {
  const count = content.trim().split(/\s+/).filter(Boolean).length;
  return `${count} word${count === 1 ? "" : "s"} · ${Math.ceil(count / 200)} min read`;
}

function scheduleAutosave(): void {
  window.clearTimeout(autosaveTimer);
  if (!checked("autosave-enabled") || !noteState.selected || !noteState.dirty) return;
  if (checked("encrypt-note") || value("encryption-action") !== "keep") return;
  autosaveTimer = window.setTimeout(() => {
    if (!byId("app-screen").hidden && !noteSaving && !document.querySelector("dialog[open]")) void saveNote(undefined, true);
  }, 1500);
}

function showUnlockDialog(): void {
  if (!noteState.selected?.isEncrypted) return;
  const dialog = byId<HTMLDialogElement>("unlock-dialog");
  clearDialogError(dialog);
  setValue("unlock-passphrase", "");
  dialog.showModal();
}

async function unlockNote(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const note = noteState.selected;
  const form = event.currentTarget as HTMLFormElement;
  const submit = form.querySelector<HTMLButtonElement>("button[type=submit]");
  if (!note || !submit || submit.disabled) return;
  const passphrase = value("unlock-passphrase");
  const draftTitle = value("note-title");
  const selectedId = note.id;
  setBusy(submit, true);
  try {
    const unlocked = await api<NoteDetail>(`/notes/${encodeURIComponent(selectedId)}/decrypt`, { method: "POST", body: JSON.stringify({ passphrase }) });
    if (noteState.selected?.id !== selectedId) return;
    noteState.selected = unlocked;
    noteState.unlockedPassphrase = passphrase;
    byId<HTMLDialogElement>("unlock-dialog").close();
    renderEditor(unlocked);
    if (draftTitle !== unlocked.title) {
      setValue("note-title", draftTitle);
      refreshDirtyState();
    }
    toast("Note unlocked for this tab");
  } catch (error) {
    showDialogError(byId<HTMLDialogElement>("unlock-dialog"), messageFrom(error));
  } finally {
    setBusy(submit, false);
  }
}

function notePayload(): JsonRecord {
  if (noteState.isNew) return createNotePayload();
  return updateNotePayload();
}

function createNotePayload(): JsonRecord {
  const payload: JsonRecord = { title: value("note-title").trim(), content: value("note-content").trim() };
  if (checked("encrypt-note")) payload.passphrase = value("note-passphrase");
  return payload;
}

function updateNotePayload(): JsonRecord {
  const note = noteState.selected;
  if (!note) return {};
  const payload: JsonRecord = { title: value("note-title").trim() };
  const locked = note.isEncrypted && !noteState.unlockedPassphrase;
  if (locked) return payload;
  payload.content = value("note-content").trim();
  addEncryptionUpdate(payload, note);
  return payload;
}

function addEncryptionUpdate(payload: JsonRecord, note: NoteDetail): void {
  if (note.isEncrypted) {
    payload.currentPassphrase = noteState.unlockedPassphrase;
    const action = value("encryption-action");
    if (action === "change") payload.newPassphrase = value("new-note-passphrase");
    if (action === "remove") payload.newPassphrase = null;
    return;
  }
  if (checked("encrypt-note")) payload.newPassphrase = value("note-passphrase");
}

async function saveNote(event?: SubmitEvent, automatic = false): Promise<void> {
  event?.preventDefault();
  window.clearTimeout(autosaveTimer);
  const form = byId<HTMLFormElement>("note-form");
  if (automatic ? !form.checkValidity() : !form.reportValidity()) return;
  const submit = byId<HTMLButtonElement>("save-note-button");
  if (submit.disabled) return;
  const payload = notePayload();
  const content = value("note-content").trim();
  const previous = noteState.selected;
  const creating = noteState.isNew;
  setNoteSaving(true, automatic);
  setBusy(submit, true);
  try {
    if (creating) await createNote(payload, content);
    else if (previous) await updateNote(payload, content, previous);
    if (!automatic) toast("Note saved");
    await loadNotes(noteState.page);
    scheduleAutosave();
  } catch (error) {
    toast(messageFrom(error), true);
  } finally {
    setNoteSaving(false);
    setBusy(submit, false, "Save note");
  }
}

function setNoteSaving(saving: boolean, automatic = false): void {
  noteSaving = saving;
  byId<HTMLFormElement>("note-form").inert = saving && !automatic;
  if (saving) byId("note-state").textContent = "Saving…";
}

async function createNote(payload: JsonRecord, content: string): Promise<void> {
  const response = await api<NoteDetail>("/notes", { method: "POST", body: JSON.stringify(payload) });
  const encrypted = typeof payload.passphrase === "string";
  const passphrase = encrypted ? payload.passphrase as string : null;
  noteState.selected = { ...response, content, attachments: response.attachments ?? [] };
  noteState.isNew = false;
  noteState.unlockedPassphrase = passphrase;
  renderEditor(noteState.selected);
}

async function updateNote(payload: JsonRecord, content: string, note: NoteDetail): Promise<void> {
  const signature = editorSignature();
  const response = await api<NoteDetail>(`/notes/${encodeURIComponent(note.id)}`, { method: "PATCH", body: JSON.stringify(payload) });
  noteState.unlockedPassphrase = passphraseAfterSave(note, payload);
  const savedContent = "content" in payload ? content : note.content;
  noteState.selected = { ...note, ...response, content: savedContent, attachments: note.attachments };
  if (editorSignature() === signature) {
    noteState.baseline = signature;
    noteState.dirty = false;
    renderDirtyState();
    if (response.isEncrypted !== note.isEncrypted || payload.newPassphrase !== undefined) renderEditor(noteState.selected);
    byId("note-meta").textContent = `Updated ${formatDate(response.updatedAt, true)}`;
  } else {
    noteState.baseline = signature;
    refreshDirtyState();
  }
}

function passphraseAfterSave(previous: NoteDetail, payload: JsonRecord): string | null {
  if (!previous.isEncrypted && typeof payload.newPassphrase === "string") return payload.newPassphrase;
  if (previous.isEncrypted && payload.newPassphrase === null) return null;
  if (previous.isEncrypted && typeof payload.newPassphrase === "string") return payload.newPassphrase;
  return noteState.unlockedPassphrase;
}

async function deleteNote(): Promise<void> {
  const note = noteState.selected;
  if (!note?.id || noteSaving) return;
  if (!window.confirm("Permanently delete this note and its attachments? This cannot be undone, and its share links will stop working.")) return;
  const button = byId<HTMLButtonElement>("delete-note-button");
  setNoteSaving(true);
  setBusy(button, true);
  try {
    await api(`/notes/${encodeURIComponent(note.id)}`, { method: "DELETE" });
    if (noteState.selected === note) {
      noteState.selected = null;
      noteState.dirty = false;
      showEditorEmpty("The note was permanently deleted.");
    }
    toast("Note deleted");
    await loadNotes(noteState.page);
  } catch (error) {
    toast(messageFrom(error), true);
  } finally {
    setNoteSaving(false);
    setBusy(button, false, "Delete");
  }
}

function renderAttachments(attachments: Attachment[]): void {
  const list = byId("attachments-list");
  list.replaceChildren();
  if (attachments.length === 0) {
    list.append(element("div", "list-state", "No attachments"));
    return;
  }
  attachments.forEach((attachment) => {
    list.append(attachmentRow(attachment));
    const preview = attachmentPreview(attachment);
    if (preview) list.append(preview);
  });
}

function attachmentRow(attachment: Attachment): HTMLElement {
  const row = element("div", "attachment-row");
  const link = element("a", "", attachment.originalName || attachment.mimeType);
  link.href = attachment.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  const size = element("small", "", formatBytes(attachment.sizeBytes));
  const remove = element("button", "button danger", "Delete");
  remove.type = "button";
  remove.addEventListener("click", () => { void deleteAttachment(attachment.id); });
  row.append(link, size, remove);
  return row;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function uploadAttachment(): Promise<void> {
  const input = byId<HTMLInputElement>("attachment-input");
  const file = input.files?.[0];
  let note = noteState.selected;
  input.value = "";
  if (!file) return;
  if (!note) {
    await saveNote();
    note = noteState.selected;
  }
  if (!note) return;
  const noteId = note.id;
  if (file.size > 30 * 1024 * 1024) {
    toast("Attachment must be 30 MB or smaller", true);
    return;
  }
  const form = new FormData();
  form.append("file", file);
  input.disabled = true;
  try {
    const attachment = await api<Attachment>(`/notes/${encodeURIComponent(noteId)}/attachments`, { method: "POST", body: form });
    if (noteState.selected !== note) return;
    note.attachments.push(attachment);
    renderAttachments(note.attachments);
    toast("Attachment uploaded");
  } catch (error) {
    toast(messageFrom(error), true);
  } finally {
    input.disabled = false;
  }
}

async function deleteAttachment(id: string): Promise<void> {
  const note = noteState.selected;
  if (!note) return;
  const noteId = note.id;
  if (!window.confirm("Permanently delete this attachment? This cannot be undone.")) return;
  try {
    await api(`/notes/${encodeURIComponent(noteId)}/attachments/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (noteState.selected !== note) return;
    note.attachments = note.attachments.filter((attachment) => attachment.id !== id);
    renderAttachments(note.attachments);
    toast("Attachment deleted");
  } catch (error) {
    toast(messageFrom(error), true);
  }
}

async function loadLinks(page = linkState.page): Promise<void> {
  const sequence = ++linkLoadSequence;
  const epoch = privateEpoch;
  setMessage("links-message");
  setListState("links-list", "Loading links…");
  try {
    const result = await api<Paged<LinkItem>>(`/links?page=${page}&limit=${PAGE_SIZE}`);
    if (sequence !== linkLoadSequence || epoch !== privateEpoch) return;
    linkState.items = result.data;
    linkState.page = result.page;
    linkState.hasNext = result.data.length === result.limit;
    renderLinks();
  } catch (error) {
    if (sequence !== linkLoadSequence || epoch !== privateEpoch) return;
    setListState("links-list", messageFrom(error));
  }
}

function renderLinks(): void {
  const list = byId("links-list");
  list.replaceChildren();
  if (linkState.items.length === 0) setListState("links-list", "No share links on this page");
  linkState.items.forEach((link) => list.append(renderLinkCard(link)));
  byId("links-page").textContent = `Page ${linkState.page}`;
  byId<HTMLButtonElement>("links-prev").disabled = linkState.page <= 1;
  byId<HTMLButtonElement>("links-next").disabled = !linkState.hasNext;
}

function linkStatus(link: LinkItem): { label: string; closed: boolean } {
  if (link.isBurned) return { label: "Burned", closed: true };
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now()) return { label: "Expired", closed: true };
  if (link.maxReads !== null && link.readsCount >= link.maxReads) return { label: "Read limit reached", closed: true };
  return { label: "Active", closed: false };
}

function renderLinkCard(link: LinkItem): HTMLElement {
  const card = element("article", "resource-card");
  const title = element("div", "resource-title", link.noteTitle ?? "Saved note");
  title.append(element("small", "", `/share/${link.slug}`));
  const meta = element("div", "resource-meta");
  const status = linkStatus(link);
  meta.append(element("span", `pill ${status.closed ? "closed" : "active"}`, status.label));
  meta.append(element("span", "pill", link.maxReads === null ? `${link.readsCount} reads` : `${link.readsCount}/${link.maxReads} reads`));
  if (link.hasPassphrase) meta.append(element("span", "pill", "Link passphrase"));
  if (link.expiresAt) meta.append(element("span", "pill", `Expires ${formatDate(link.expiresAt, true)}`));
  const actions = element("div", "resource-actions");
  actions.append(
    actionButton("Copy", () => { void copyLink(link.slug); }),
    actionButton("Open", () => window.open(`/share/${encodeURIComponent(link.slug)}`, "_blank", "noopener")),
    actionButton("Analytics", () => { void showAnalytics(link.id); }),
    actionButton("QR", () => showQr(link)),
    actionButton("Delete", () => { void deleteLink(link); }, true),
  );
  card.append(title, meta, actions);
  return card;
}

function actionButton(label: string, action: () => void, danger = false): HTMLButtonElement {
  const button = element("button", `button ${danger ? "danger" : "secondary"}`, label);
  button.type = "button";
  button.addEventListener("click", action);
  return button;
}

async function copyText(text: string, success: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(success);
  } catch {
    toast("Clipboard access was unavailable", true);
  }
}

function copyLink(slug: string): Promise<void> {
  return copyText(`${location.origin}/share/${slug}`, "Share link copied");
}

async function openCreateLink(noteId?: string): Promise<void> {
  const dialog = byId<HTMLDialogElement>("create-link-dialog");
  const sequence = ++linkDialogSequence;
  const epoch = privateEpoch;
  clearDialogError(dialog);
  resetForm("create-link-form");
  updateLinkLimitControls();
  populateLinkDialog([], []);
  showDialogError(dialog, "Loading saved notes and webhooks…");
  dialog.showModal();
  try {
    const [notes, webhooks] = await Promise.all([
      loadAllPages<NoteSummary>("/notes"),
      loadAllPages<WebhookItem>("/webhooks"),
    ]);
    if (sequence !== linkDialogSequence || epoch !== privateEpoch || !dialog.open) return;
    clearDialogError(dialog);
    populateLinkDialog(notes, webhooks);
    if (noteId) setValue("link-note-id", noteId);
    if (notes.length === 0) showDialogError(dialog, "Create and save a note before creating a link.");
  } catch (error) {
    if (sequence !== linkDialogSequence || epoch !== privateEpoch || !dialog.open) return;
    showDialogError(dialog, messageFrom(error));
  }
}

async function loadAllPages<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const result = await api<Paged<T>>(`${path}?page=${page}&limit=100`);
    items.push(...result.data);
    if (result.data.length < result.limit) return items;
  }
}

function resetForm(id: string): void {
  byId<HTMLFormElement>(id).reset();
}

function populateSelect(select: HTMLSelectElement, items: Array<{ value: string; label: string }>, emptyLabel?: string): void {
  select.replaceChildren();
  if (emptyLabel !== undefined) {
    const empty = element("option", "", emptyLabel);
    empty.value = "";
    select.append(empty);
  }
  items.forEach((item) => {
    const option = element("option", "", item.label);
    option.value = item.value;
    select.append(option);
  });
}

function populateLinkDialog(notes: NoteSummary[], webhooks: WebhookItem[]): void {
  populateSelect(byId<HTMLSelectElement>("link-note-id"), notes.map((note) => ({ value: note.id, label: `${note.title}${note.isEncrypted ? " · encrypted" : ""}` })));
  populateSelect(byId<HTMLSelectElement>("link-webhook-id"), webhooks.map((hook) => ({ value: hook.id, label: hook.url })), "No webhook");
  byId<HTMLFormElement>("create-link-form").querySelector<HTMLButtonElement>("button[type=submit]")!.disabled = notes.length === 0;
}

function createLinkPayload(): JsonRecord {
  const payload: JsonRecord = { noteId: value("link-note-id") };
  const passphrase = value("link-passphrase");
  const expires = value("link-expires");
  const maxReads = value("link-max-reads");
  const webhookId = value("link-webhook-id");
  if (passphrase) payload.passphrase = passphrase;
  if (expires) payload.expiresAt = new Date(expires).toISOString();
  if (checked("link-burn")) payload.maxReads = 1;
  else if (maxReads) payload.maxReads = Number(maxReads);
  if (webhookId) payload.webhookId = webhookId;
  return payload;
}

async function createLink(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const dialog = byId<HTMLDialogElement>("create-link-dialog");
  const form = event.currentTarget as HTMLFormElement;
  const submit = form.querySelector<HTMLButtonElement>("button[type=submit]");
  if (!submit || submit.disabled || !form.reportValidity()) return;
  setBusy(submit, true);
  clearDialogError(dialog);
  try {
    const link = await api<LinkItem>("/links", { method: "POST", body: JSON.stringify(createLinkPayload()) });
    dialog.close();
    await loadLinks(1);
    toast("Share link created");
    await copyLink(link.slug);
    if (noteState.selected?.id === link.noteId) {
      noteState.selected.links = [link, ...(noteState.selected.links ?? [])];
      renderNoteLinks(noteState.selected.links);
    }
  } catch (error) {
    showDialogError(dialog, messageFrom(error));
  } finally {
    setBusy(submit, false, "Create link");
  }
}

async function deleteLink(link: LinkItem): Promise<void> {
  if (!window.confirm(`Permanently delete the share link for “${link.noteTitle ?? "this note"}”? This cannot be undone and the URL will stop working.`)) return;
  try {
    await api(`/links/${encodeURIComponent(link.id)}`, { method: "DELETE" });
    toast("Share link deleted");
    await loadLinks(linkState.page);
  } catch (error) {
    setMessage("links-message", messageFrom(error));
  }
}

async function showAnalytics(linkId: string): Promise<void> {
  const dialog = byId<HTMLDialogElement>("analytics-dialog");
  const sequence = ++analyticsSequence;
  const epoch = privateEpoch;
  clearDialogError(dialog);
  byId("analytics-content").replaceChildren(element("div", "list-state", "Loading analytics…"));
  dialog.showModal();
  try {
    const analytics = await api<Analytics>(`/links/${encodeURIComponent(linkId)}/analytics`);
    if (sequence !== analyticsSequence || epoch !== privateEpoch || !dialog.open) return;
    renderAnalytics(analytics);
  } catch (error) {
    if (sequence !== analyticsSequence || epoch !== privateEpoch || !dialog.open) return;
    showDialogError(dialog, messageFrom(error));
  }
}

function renderAnalytics(data: Analytics): void {
  const container = byId("analytics-content");
  const header = element("header");
  header.append(element("span", "eyebrow", "Link analytics"), element("h2", "", data.noteTitle), element("p", "", `/share/${data.slug}`));
  const summary = element("div", "analytics-summary");
  summary.append(
    metric("Total opens", data.summary.totalClicks),
    metric("Unique visitors", data.summary.uniqueVisitors),
    metric("Reads", data.summary.readsCount),
    metric("Limit", data.summary.maxReads ?? "∞"),
  );
  const grid = element("div", "analytics-grid");
  grid.append(
    breakdown("Opens by date", data.breakdown.clicksByDate),
    breakdown("Devices", data.breakdown.devices),
    breakdown("Browsers", data.breakdown.browsers),
    breakdown("Operating systems", data.breakdown.operatingSystems),
    breakdown("Referrers", data.breakdown.topReferrers),
    recentAccesses(data.recentAccesses),
  );
  container.replaceChildren(header, summary, grid);
}

function metric(label: string, value: string | number): HTMLElement {
  const box = element("div", "metric");
  box.append(element("strong", "", String(value)), element("span", "", label));
  return box;
}

function breakdown(title: string, values: Record<string, number>): HTMLElement {
  const box = element("section", "breakdown");
  box.append(element("h3", "", title));
  const entries = Object.entries(values).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) box.append(element("div", "breakdown-row", "No data yet"));
  entries.slice(0, 8).forEach(([label, count]) => {
    const row = element("div", "breakdown-row");
    row.append(element("span", "", label), element("strong", "", String(count)));
    box.append(row);
  });
  return box;
}

function recentAccesses(items: Analytics["recentAccesses"]): HTMLElement {
  const box = element("section", "breakdown recent-list");
  box.append(element("h3", "", "Recent access"));
  if (items.length === 0) box.append(element("div", "breakdown-row", "No access recorded yet"));
  items.forEach((item) => {
    const row = element("div", "breakdown-row");
    row.append(element("span", "", `${item.ip} · ${item.browser} · ${item.device}`), element("span", "", formatDate(item.accessedAt, true)));
    box.append(row);
  });
  return box;
}

async function loadWebhooks(page = webhookState.page): Promise<void> {
  const sequence = ++webhookLoadSequence;
  const epoch = privateEpoch;
  setMessage("webhooks-message");
  setListState("webhooks-list", "Loading webhooks…");
  try {
    const result = await api<Paged<WebhookItem>>(`/webhooks?page=${page}&limit=${PAGE_SIZE}`);
    if (sequence !== webhookLoadSequence || epoch !== privateEpoch) return;
    webhookState.items = result.data;
    webhookState.page = result.page;
    webhookState.hasNext = result.data.length === result.limit;
    renderWebhooks();
  } catch (error) {
    if (sequence !== webhookLoadSequence || epoch !== privateEpoch) return;
    setListState("webhooks-list", messageFrom(error));
  }
}

function renderWebhooks(): void {
  const list = byId("webhooks-list");
  list.replaceChildren();
  if (webhookState.items.length === 0) setListState("webhooks-list", "No webhooks on this page");
  webhookState.items.forEach((hook) => list.append(renderWebhookCard(hook)));
  byId("webhooks-page").textContent = `Page ${webhookState.page}`;
  byId<HTMLButtonElement>("webhooks-prev").disabled = webhookState.page <= 1;
  byId<HTMLButtonElement>("webhooks-next").disabled = !webhookState.hasNext;
}

function renderWebhookCard(hook: WebhookItem): HTMLElement {
  const card = element("article", "resource-card");
  const title = element("div", "resource-title", hook.url);
  title.append(element("small", "", `Created ${formatDate(hook.createdAt, true)}`));
  const meta = element("div", "resource-meta");
  meta.append(element("span", "pill active", "Active"), element("span", "pill", "Signed events"));
  const actions = element("div", "resource-actions");
  actions.append(actionButton("Details", () => showWebhook(hook)), actionButton("Delete", () => { void deleteWebhook(hook); }, true));
  card.append(title, meta, actions);
  return card;
}

function openCreateWebhook(): void {
  resetForm("create-webhook-form");
  const dialog = byId<HTMLDialogElement>("create-webhook-dialog");
  clearDialogError(dialog);
  dialog.showModal();
}

async function createWebhook(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const dialog = byId<HTMLDialogElement>("create-webhook-dialog");
  const submit = form.querySelector<HTMLButtonElement>("button[type=submit]");
  if (!submit || submit.disabled || !form.reportValidity()) return;
  setBusy(submit, true);
  clearDialogError(dialog);
  try {
    await api<WebhookDetail>("/webhooks", { method: "POST", body: JSON.stringify({ url: value("webhook-url").trim() }) });
    dialog.close();
    toast("Webhook created. Open Details to reveal its signing secret.");
    await loadWebhooks(1);
  } catch (error) {
    showDialogError(dialog, messageFrom(error));
  } finally {
    setBusy(submit, false, "Create webhook");
  }
}

function showWebhook(hook: WebhookItem): void {
  webhookDetailSequence++;
  const dialog = byId<HTMLDialogElement>("webhook-dialog");
  clearDialogError(dialog);
  const detail = byId("webhook-detail");
  const header = element("header");
  header.append(element("span", "eyebrow", "Webhook details"), element("h2", "", "Signed delivery"));
  const url = element("p", "", hook.url);
  const created = element("p", "field-note", `Created ${formatDate(hook.createdAt, true)}`);
  const reveal = actionButton("Reveal signing secret", () => { void revealWebhookSecret(hook.id, reveal, detail, dialog); });
  detail.replaceChildren(header, url, created, reveal);
  dialog.showModal();
}

async function revealWebhookSecret(id: string, button: HTMLButtonElement, container: HTMLElement, dialog: HTMLDialogElement): Promise<void> {
  if (button.disabled) return;
  const sequence = webhookDetailSequence;
  const epoch = privateEpoch;
  setBusy(button, true);
  clearDialogError(dialog);
  try {
    const hook = await api<WebhookDetail>(`/webhooks/${encodeURIComponent(id)}`);
    if (sequence !== webhookDetailSequence || epoch !== privateEpoch || !dialog.open || !button.isConnected) return;
    const box = element("div", "secret-box");
    const code = element("code", "", hook.secret);
    const copy = actionButton("Copy", () => { void copyText(hook.secret, "Signing secret copied"); });
    box.append(code, copy);
    button.replaceWith(box);
  } catch (error) {
    if (sequence !== webhookDetailSequence || epoch !== privateEpoch || !dialog.open) return;
    showDialogError(dialog, messageFrom(error));
    setBusy(button, false, "Reveal signing secret");
  }
}

async function deleteWebhook(hook: WebhookItem): Promise<void> {
  if (!window.confirm(`Permanently delete webhook “${hook.url}”? This cannot be undone, linked shares will stop sending events, and its signing secret cannot be recovered.`)) return;
  try {
    await api(`/webhooks/${encodeURIComponent(hook.id)}`, { method: "DELETE" });
    toast("Webhook deleted");
    await loadWebhooks(webhookState.page);
  } catch (error) {
    setMessage("webhooks-message", messageFrom(error));
  }
}

function showDialogError(dialog: HTMLDialogElement, message: string): void {
  let node = dialog.querySelector<HTMLElement>(".dialog-error");
  if (!node) {
    node = element("div", "dialog-error");
    const form = dialog.querySelector("form");
    const header = (form ?? dialog).querySelector("header");
    header?.insertAdjacentElement("afterend", node);
    if (!header) (form ?? dialog).prepend(node);
  }
  node.textContent = message;
  node.hidden = false;
}

function clearDialogError(dialog: HTMLDialogElement): void {
  const node = dialog.querySelector<HTMLElement>(".dialog-error");
  if (node) node.hidden = true;
}

function bindEvents(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-action=theme]").forEach((button) => button.addEventListener("click", toggleTheme));
  document.querySelectorAll<HTMLButtonElement>("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => button.closest<HTMLDialogElement>("dialog")?.close());
  });
  document.querySelectorAll<HTMLDialogElement>("dialog").forEach((dialog) => {
    dialog.addEventListener("close", () => {
      clearDialogError(dialog);
      if (dialog.id === "unlock-dialog") setValue("unlock-passphrase", "");
      if (dialog.id === "create-link-dialog") linkDialogSequence++;
      if (dialog.id === "analytics-dialog") analyticsSequence++;
      if (dialog.id === "webhook-dialog") {
        webhookDetailSequence++;
        byId("webhook-detail").replaceChildren();
      }
    });
  });
  byId("login-tab").addEventListener("click", () => selectAuthTab("login"));
  byId("signup-tab").addEventListener("click", () => selectAuthTab("signup"));
  byId<HTMLFormElement>("login-form").addEventListener("submit", (event) => { void submitAuth(event, "login"); });
  byId<HTMLFormElement>("signup-form").addEventListener("submit", (event) => { void submitAuth(event, "signup"); });
  byId("logout-button").addEventListener("click", () => { void logout(); });

  document.querySelectorAll<HTMLButtonElement>(".nav-button").forEach((button) => {
    button.addEventListener("click", () => {
      const view = button.dataset.view as AppView;
      if (showView(view) && view === "notes" && matchMedia("(max-width: 820px)").matches) {
        byId("app-screen").classList.add("notes-panel-open");
      }
    });
  });
  byId("mobile-menu").addEventListener("click", () => {
    const app = byId("app-screen");
    const open = app.classList.toggle("mobile-nav-open");
    byId("mobile-menu").setAttribute("aria-expanded", String(open));
  });

  document.querySelectorAll<HTMLButtonElement>("[data-action=new-note]").forEach((button) => button.addEventListener("click", newNote));
  byId("new-note-button").addEventListener("click", newNote);
  byId<HTMLFormElement>("note-form").addEventListener("submit", (event) => { void saveNote(event); });
  byId("delete-note-button").addEventListener("click", () => { void deleteNote(); });
  byId("unlock-note-button").addEventListener("click", showUnlockDialog);
  document.querySelectorAll<HTMLButtonElement>("[data-action=unlock-note]").forEach((button) => button.addEventListener("click", showUnlockDialog));
  byId<HTMLFormElement>("unlock-form").addEventListener("submit", (event) => { void unlockNote(event); });
  byId("note-title").addEventListener("input", refreshDirtyState);
  byId("note-content").addEventListener("input", refreshDirtyState);
  byId("encrypt-note").addEventListener("change", updateEncryptionControls);
  byId("note-passphrase").addEventListener("input", refreshDirtyState);
  byId("encryption-action").addEventListener("change", updateEncryptionControls);
  byId("new-note-passphrase").addEventListener("input", refreshDirtyState);
  byId("attachment-input").addEventListener("change", () => { void uploadAttachment(); });
  byId("notes-search").addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => { void loadNotes(1); }, 300);
  });
  bindNoteTools();
  byId("notes-prev").addEventListener("click", () => { if (canLeaveDirty("change page")) void loadNotes(Math.max(1, noteState.page - 1)); });
  byId("notes-next").addEventListener("click", () => { if (canLeaveDirty("change page")) void loadNotes(noteState.page + 1); });

  document.querySelectorAll<HTMLButtonElement>("[data-action=open-create-link]").forEach((button) => button.addEventListener("click", () => { void openCreateLink(); }));
  byId<HTMLFormElement>("create-link-form").addEventListener("submit", (event) => { void createLink(event); });
  byId("link-burn").addEventListener("change", updateLinkLimitControls);
  byId("links-prev").addEventListener("click", () => { void loadLinks(Math.max(1, linkState.page - 1)); });
  byId("links-next").addEventListener("click", () => { void loadLinks(linkState.page + 1); });

  document.querySelectorAll<HTMLButtonElement>("[data-action=open-create-webhook]").forEach((button) => button.addEventListener("click", openCreateWebhook));
  byId<HTMLFormElement>("create-webhook-form").addEventListener("submit", (event) => { void createWebhook(event); });
  byId("webhooks-prev").addEventListener("click", () => { void loadWebhooks(Math.max(1, webhookState.page - 1)); });
  byId("webhooks-next").addEventListener("click", () => { void loadWebhooks(webhookState.page + 1); });

  window.addEventListener("beforeunload", (event) => {
    if (!noteState.dirty) return;
    event.preventDefault();
  });
}

function updateEncryptionControls(): void {
  syncEncryptionControls();
  refreshDirtyState();
}

function syncEncryptionControls(): void {
  const encrypting = checked("encrypt-note");
  const changing = value("encryption-action") === "change";
  setHidden("note-passphrase-wrap", !encrypting);
  setHidden("new-passphrase-wrap", !changing);
  byId<HTMLInputElement>("note-passphrase").required = encrypting;
  byId<HTMLInputElement>("new-note-passphrase").required = changing;
}

function updateLinkLimitControls(): void {
  const input = byId<HTMLInputElement>("link-max-reads");
  input.disabled = checked("link-burn");
  if (input.disabled) input.value = "";
}

function closeNoteActions(): void {
  document.querySelector<HTMLDetailsElement>(".note-actions")?.removeAttribute("open");
}

async function togglePin(): Promise<void> {
  const note = noteState.selected;
  if (!note || noteSaving) return;
  const button = byId<HTMLButtonElement>("pin-note-button");
  if (button.disabled) return;
  setBusy(button, true);
  try {
    const result = await api<NoteDetail>(`/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ isPinned: !note.isPinned }) });
    if (noteState.selected !== note) return;
    note.isPinned = result.isPinned;
    button.textContent = result.isPinned ? "Unpin note" : "Pin note";
    await loadNotes(noteState.page);
  } catch (error) { toast(messageFrom(error), true); }
  finally { button.disabled = false; closeNoteActions(); }
}

async function duplicateNote(): Promise<void> {
  const note = noteState.selected;
  if (!note || noteSaving) return;
  if (note.isEncrypted && !noteState.unlockedPassphrase) return toast("Unlock the note before duplicating it", true);
  if (!byId<HTMLFormElement>("note-form").reportValidity()) return;
  if (!canLeaveDirty("open a duplicate")) return;
  window.clearTimeout(autosaveTimer);
  const title = `${value("note-title").trim().slice(0, 248)} (Copy)`;
  const content = value("note-content").trim();
  const passphrase = note.isEncrypted ? noteState.unlockedPassphrase : undefined;
  setNoteSaving(true);
  try {
    await createNote({ title, content, ...(passphrase ? { passphrase } : {}) }, content);
    await loadNotes(1);
    toast("Note duplicated. File attachments and share links stay with the original.");
  } catch (error) { toast(messageFrom(error), true); }
  finally { setNoteSaving(false); closeNoteActions(); }
}

function exportMarkdown(): void {
  if (noteState.selected?.isEncrypted && !noteState.unlockedPassphrase) return toast("Unlock the note before exporting", true);
  const title = value("note-title").trim() || "Untitled";
  const blob = new Blob([`# ${title}\n\n${value("note-content")}`], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = element("a");
  link.href = url;
  link.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 100) || "note"}.md`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  closeNoteActions();
}

function shareCurrentNote(): void {
  const note = noteState.selected;
  if (!note) return toast("Save the note before sharing", true);
  if (noteState.dirty) return toast("Save your changes before sharing the note", true);
  closeNoteActions();
  void openCreateLink(note.id);
}

function renderNoteLinks(links: LinkItem[]): void {
  const list = byId("note-share-links");
  byId("note-total-reads").textContent = `${links.reduce((sum, link) => sum + link.readsCount, 0)} reads`;
  list.replaceChildren();
  if (!links.length) list.append(element("p", "field-note", "No links yet. This note is private."));
  links.forEach((link) => {
    const row = element("div", "attachment-row");
    const label = element("span", "field-note", `/share/${link.slug} · ${linkStatus(link).label}`);
    row.append(label, actionButton("Copy", () => { void copyLink(link.slug); }), actionButton("QR", () => showQr(link)));
    list.append(row);
  });
}

async function showQr(link: LinkItem): Promise<void> {
  try {
    await api("/auth/me");
    byId<HTMLImageElement>("qr-image").src = `/links/${encodeURIComponent(link.id)}/qr`;
    const url = `${location.origin}/share/${link.slug}`;
    const anchor = byId<HTMLAnchorElement>("qr-url");
    anchor.href = url;
    anchor.textContent = url;
    byId<HTMLDialogElement>("qr-dialog").showModal();
  } catch (error) { toast(messageFrom(error), true); }
}

async function loadStorageStatus(): Promise<void> {
  try {
    const config = await publicRequest<{ uploadsEnabled: boolean }>("/config");
    byId<HTMLInputElement>("attachment-input").disabled = !config.uploadsEnabled;
    if (!config.uploadsEnabled) byId("storage-status").textContent = "Uploads are unavailable until Supabase Storage is configured. Supported: images, PDF, Word, and video up to 30 MB. Files are stored in a private bucket and are not encrypted by note passphrases.";
  } catch { /* the next upload will report a connection error */ }
}

function attachmentPreviews(attachments: Attachment[]): HTMLElement {
  const section = element("section", "shared-attachments");
  if (!attachments.length) return section;
  section.append(element("h3", "", "Attachments"));
  attachments.forEach((attachment) => {
    const file = element("div", "attachment-file");
    const link = element("a", "", attachment.originalName || attachment.mimeType);
    link.href = attachment.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    file.append(link, element("small", "field-note", ` · ${formatBytes(attachment.sizeBytes)}`));
    const preview = attachmentPreview(attachment);
    if (preview) file.append(preview);
    section.append(file);
  });
  return section;
}

function attachmentPreview(file: Attachment): HTMLElement | null {
  if (file.mimeType.startsWith("image/")) {
    const image = element("img", "attachment-preview");
    image.src = file.url;
    image.alt = file.originalName || "Attached image";
    image.loading = "lazy";
    return image;
  }
  if (file.mimeType.startsWith("video/")) {
    const video = element("video", "attachment-preview");
    video.src = file.url;
    video.controls = true;
    video.preload = "metadata";
    return video;
  }
  if (file.mimeType === "application/pdf") {
    const frame = element("iframe", "attachment-preview");
    frame.src = file.url;
    frame.title = file.originalName || "Attached PDF";
    frame.loading = "lazy";
    return frame;
  }
  return null;
}

async function logoutEverywhere(): Promise<void> {
  if (!canLeaveDirty("log out all sessions")) return;
  try {
    await api("/auth/logout-all", { method: "POST" });
    resetPrivateState();
    currentUserId = null;
    showAuth("Refresh sessions revoked. Other devices lose access when their current tokens expire.");
  } catch (error) { showDialogError(byId<HTMLDialogElement>("shortcuts-dialog"), messageFrom(error)); }
}

function handleShortcut(event: KeyboardEvent): void {
  if (byId("app-screen").hidden || document.querySelector("dialog[open]")) return;
  if (!(event.ctrlKey || event.metaKey)) return;
  const actions: Record<string, () => void> = {
    s: () => { if (!byId("note-form").hidden) void saveNote(); },
    n: newNote,
    p: () => { void togglePin(); },
    d: () => { void duplicateNote(); },
    k: copyCurrentLink,
  };
  const action = actions[event.key.toLowerCase()];
  if (!action) return;
  event.preventDefault();
  action();
}

function copyCurrentLink(): void {
  const link = noteState.selected?.links?.find((item) => !linkStatus(item).closed);
  if (link) void copyLink(link.slug);
  else shareCurrentNote();
}

function bindNoteTools(): void {
  byId("pin-note-button").addEventListener("click", () => { void togglePin(); });
  byId("duplicate-note-button").addEventListener("click", () => { void duplicateNote(); });
  byId("export-note-button").addEventListener("click", exportMarkdown);
  byId("share-note-button").addEventListener("click", shareCurrentNote);
  byId("shortcuts-button").addEventListener("click", () => byId<HTMLDialogElement>("shortcuts-dialog").showModal());
  byId("logout-all-button").addEventListener("click", () => { void logoutEverywhere(); });
  byId("autosave-enabled").addEventListener("change", scheduleAutosave);
  document.addEventListener("keydown", handleShortcut);
}

async function init(): Promise<void> {
  let savedTheme = "";
  try { savedTheme = localStorage.getItem("theme") ?? ""; } catch { /* storage may be blocked */ }
  const preferredTheme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyTheme(savedTheme || preferredTheme);
  bindEvents();
  void loadStorageStatus();
  const slug = shareSlug();
  if (slug) {
    await initPublicShare(slug);
    return;
  }
  try {
    await enterApp();
  } catch (error) {
    showAuth(error instanceof ApiError && error.status === 401 ? "" : messageFrom(error));
  }
}

void init();
