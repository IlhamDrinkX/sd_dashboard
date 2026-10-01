import React from "https://esm.sh/react@18.2.0";
import ReactDOM from "https://esm.sh/react-dom@18.2.0/client";
import htm from "https://esm.sh/htm@3.1.1";
import Chart from "https://esm.sh/chart.js@4.4.1/auto";

const html = htm.bind(React.createElement);
const { useState, useEffect, useMemo, useCallback, useRef } = React;

// ---------------------------------------------------------------- API ----

const API = "";

async function apiGet(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}
async function apiPatch(path, body) {
  const r = await fetch(API + path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}
async function apiPost(path) {
  const r = await fetch(API + path, { method: "POST" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}
async function apiPostJson(path, body) {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}
async function apiDelete(path) {
  const r = await fetch(API + path, { method: "DELETE" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json().catch(() => ({ ok: true }));
}

// ------------------------------------------------------------- helpers ----

function fmtDt(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}
function fmtDateShort(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}`;
}
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(v) {
  if (!v) return null;
  const d = new Date(v);
  return d.toISOString();
}
function padDatePart(n) { return String(n).padStart(2, "0"); }
function normalizePastedDatetime(text) {
  if (!text) return null;
  text = text.trim();
  // уже похоже на "YYYY-MM-DD[T ]HH:mm[:ss]" — берём как есть
  const m = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (m) return `${m[1]}T${m[2]}`;
  // иначе пробуем распарсить как произвольную дату (ISO с Z/офсетом, локальный формат и т.п.)
  const d = new Date(text);
  if (!isNaN(d)) {
    return `${d.getFullYear()}-${padDatePart(d.getMonth() + 1)}-${padDatePart(d.getDate())}T${padDatePart(d.getHours())}:${padDatePart(d.getMinutes())}`;
  }
  return null;
}
function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
// Методика влияние+приоритет (зеркало backend/analysis.py compute_downtime, 2026-08-12,
// уточнено в тот же день). severity в DOWNTIME_SEVERITIES ("Комплекс остановлен"/
// "Комплекс в стопе"/"Функционал ограничен"): приоритет Высокий/Срочный -> начало =
// incidentAt, иначе -> начало = workStartedAt. "Функционал не ограничен" — ОСОБЫЙ
// случай: при Высоком/Срочном приоритете ВСЁ РАВНО считается, но начало = workStartedAt
// (не incidentAt); при любом другом приоритете — не даунтайм. Конец всегда closedAt.
// Считается вживую из текущих значений формы, без сохранения — если методика ещё
// раз изменится, обновлять ОБА места (тут и analysis.py::compute_downtime).
const HIGH_PRIORITIES = new Set(["Высокий", "Срочный"]);
const DOWNTIME_SEVERITIES = new Set(["Комплекс остановлен", "Функционал ограничен", "Комплекс в стопе"]);
const DOWNTIME_FIELD_LABELS = { incidentAt: "времени инцидента", workStartedAt: "времени начала работ" };

function computeDowntimePreview(form) {
  const sev = form.severity || "";
  const highPriority = HIGH_PRIORITIES.has(form.priority || "");
  let startField;
  if (sev === "Функционал не ограничен") {
    if (!highPriority) return { reason: "excluded_priority", hours: null, startField: null };
    startField = "workStartedAt";
  } else if (DOWNTIME_SEVERITIES.has(sev)) {
    startField = highPriority ? "incidentAt" : "workStartedAt";
  } else {
    return { reason: "excluded_severity", hours: null, startField: null };
  }
  const startRaw = form[startField];
  if (!startRaw) return { reason: "no_start", hours: null, startField };
  const start = new Date(startRaw);
  if (isNaN(start)) return { reason: "no_start", hours: null, startField };
  const endRaw = form.closedAt;
  if (!endRaw) return { reason: "still_open", hours: null, startField };
  const end = new Date(endRaw);
  if (isNaN(end)) return { reason: "still_open", hours: null, startField };
  const hours = (end - start) / 3600000;
  if (hours < 0) return { reason: "invalid_negative", hours: null, startField };
  return { reason: "ok", hours, startField };
}

function severityBadgeClass(sev) {
  if (sev === "Комплекс остановлен") return "badge-stopped";
  if (sev === "Комплекс в стопе") return "badge-instop";
  if (sev === "Функционал ограничен") return "badge-limited";
  if (sev === "Функционал не ограничен") return "badge-ok";
  return "badge-neutral";
}

const KIND_COLORS = { milk: "#5b8cff", software: "#22c55e", mechanics: "#f59e0b", other: "#a855f7" };

// F4 рабочий фонд часов/сутки — зеркало backend/analysis.py F4_GRAPH_HOURS,
// нужно на фронте только для нормировки цвета теплокарты.
const F4_GRAPH_HOURS = {
  "4.5": 24, "4.6": 24, "4.7": 15, "4.13": 15, "4.14": 15, "4.15": 15,
  "4.8": 16, "4.9": 9, "4.10": 9, "4.11": 9, "4.12": 9,
  "4.19": 9, "4.20": 9, "4.22": 15, "4.23": 15,
};

function heatColor(hours, maxHours) {
  if (!hours || hours <= 0) return "#1e2230";
  const t = Math.min(1, hours / Math.max(maxHours, 0.1));
  // green(#22c55e) -> amber(#f59e0b) -> red(#ef4444)
  if (t < 0.5) {
    const k = t / 0.5;
    return lerpColor("#2d5f3a", "#f59e0b", k);
  }
  const k = (t - 0.5) / 0.5;
  return lerpColor("#f59e0b", "#ef4444", k);
}
function lerpColor(a, b, t) {
  const pa = hexToRgb(a), pb = hexToRgb(b);
  const r = Math.round(pa.r + (pb.r - pa.r) * t);
  const g = Math.round(pa.g + (pb.g - pa.g) * t);
  const bch = Math.round(pa.b + (pb.b - pa.b) * t);
  return `rgb(${r},${g},${bch})`;
}
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// ------------------------------------------------------------- TopBar ----

function TopBar({ tab, setTab, onRefresh, refreshing, sessionOk, onOpenCookie }) {
  return html`
    <div class="topbar">
      <h1>Service Desk — Дашборд</h1>
      <div class="tabs">
        <button class=${"tab-btn" + (tab === "tickets" ? " active" : "")} onClick=${() => setTab("tickets")}>Заявки</button>
        <button class=${"tab-btn" + (tab === "problems" ? " active" : "")} onClick=${() => setTab("problems")}>Проблемы</button>
        <button class=${"tab-btn" + (tab === "charts" ? " active" : "")} onClick=${() => setTab("charts")}>Графики</button>
        <button class=${"tab-btn" + (tab === "montage" ? " active" : "")} onClick=${() => setTab("montage")}>Монтаж/ПНР</button>
        <button class=${"tab-btn" + (tab === "report" ? " active" : "")} onClick=${() => setTab("report")}>Отчёт F-4</button>
      </div>
      <div style=${{ marginLeft: "auto", display: "flex", gap: "8px", alignItems: "center" }}>
        ${!sessionOk && html`
          <button class="btn" style=${{ background: "var(--red)" }} onClick=${onOpenCookie}>
            ⚠ Сессия истекла — обновить
          </button>
        `}
        ${sessionOk && html`
          <button class="btn secondary" onClick=${onOpenCookie} title="Обновить cookie сессии Service Desk">
            🔑 Сессия
          </button>
        `}
        <button class="btn secondary" onClick=${onRefresh} disabled=${refreshing}>
          ${refreshing ? "Обновление…" : "Обновить данные"}
        </button>
      </div>
    </div>
  `;
}

// ------------------------------------------------------- Cookie Modal ----

function CookieModal({ onClose, onSaved }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(null);

  const pasteFromClipboard = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) setText(t);
    } catch {
      // permission denied / недоступно — пользователь просто вставит вручную (Ctrl+V)
    }
  };

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const r = await apiPostJson("/api/admin/cookie", { cookie: text.trim() });
      setOk(`Сохранено cookie: ${r.names} (${r.cookies_saved}). Сессия рабочая.`);
      onSaved();
      setTimeout(onClose, 1200);
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  return html`
    <div class="modal-backdrop" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="modal" style=${{ maxWidth: "560px" }}>
        <button class="modal-close" onClick=${onClose}>×</button>
        <h2>Обновить сессию Service Desk</h2>
        <p class="muted">
          Самый быстрый способ: открой sd.drinkx.tech в браузере, где уже залогинен и видишь заявки,
          нажми F12 → вкладка Console, вставь строку <code>copy(document.cookie)</code>, нажми Enter —
          cookie окажется в буфере обмена. Дальше жми «Вставить из буфера» ниже (или просто Ctrl+V в поле).
        </p>
        <p class="muted">
          Если консоль недоступна — то же самое можно взять из DevTools → Network → любой запрос
          к sd.drinkx.tech → Headers → Request Headers → строка «cookie:».
        </p>
        <textarea
          rows="4"
          placeholder="sd_session=...; другие_куки=..."
          value=${text}
          onInput=${(e) => setText(e.target.value)}
          style=${{ width: "100%" }}
        ></textarea>
        <div class="checkbox-row" style=${{ marginTop: "10px", gap: "10px" }}>
          <button class="btn secondary" onClick=${pasteFromClipboard} disabled=${busy}>Вставить из буфера</button>
          <button class="btn" onClick=${submit} disabled=${busy || !text.trim()}>${busy ? "Проверяю…" : "Сохранить"}</button>
        </div>
        ${err && html`<div class="error-banner" style=${{ marginTop: "10px" }}>${err}</div>`}
        ${ok && html`<div class="counter-card" style=${{ marginTop: "10px", borderColor: "var(--green)" }}>${ok}</div>`}
      </div>
    </div>
  `;
}

// --------------------------------------------------------- Ticket Modal ----

const EDIT_FIELDS = [
  { key: "title", label: "Заголовок", type: "text" },
  { key: "workType", label: "Вид работ", type: "select", opts: "workTypes" },
  { key: "severity", label: "Влияние", type: "select", opts: "severities" },
  { key: "priority", label: "Приоритет", type: "select", opts: "priorities" },
  { key: "status", label: "Статус", type: "select", opts: "statuses" },
  { key: "node", label: "Узел", type: "select", opts: "nodes" },
  { key: "engineer", label: "Инженер", type: "select", opts: "engineers" },
  { key: "problemId", label: "Привязанная проблема", type: "problem" },
  { key: "incidentAt", label: "Время инцидента", type: "datetime" },
  { key: "workStartedAt", label: "Время начала работ (на объекте)", type: "datetime" },
  { key: "closedAt", label: "Время окончания инцидента", type: "datetime" },
  { key: "description", label: "Описание", type: "textarea", wide: true },
  { key: "l1Actions", label: "Действия L1", type: "textarea", wide: true },
  { key: "diagnosis", label: "Диагностика", type: "textarea", wide: true },
  { key: "failureReason", label: "Причина отказа", type: "select", opts: "failureReasons" },
  { key: "workDone", label: "Выполненные работы", type: "textarea", wide: true },
  { key: "materials", label: "Материалы", type: "textarea", wide: true },
  { key: "workResult", label: "Результат работ", type: "select", opts: "workResults" },
  { key: "actNumber", label: "Номер акта", type: "text" },
  { key: "paperActReceived", label: "Бумажный акт получен", type: "checkbox" },
  { key: "hasSignedActPhoto", label: "Фото подписанного акта приложено", type: "checkbox" },
  { key: "engineerComment", label: "Комментарий инженера", type: "textarea", wide: true },
];

function fmtSize(bytes) {
  if (bytes == null) return "";
  if (typeof bytes === "string") return bytes;
  if (bytes < 1024) return bytes + " Б";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " КБ";
  return (bytes / 1024 / 1024).toFixed(1) + " МБ";
}

function TicketModal({ ticketId, meta, onClose, onSaved, onTicketUpdated, onDeleted, ticketIds, onNavigate }) {
  const [ticket, setTicket] = useState(null);
  const [form, setForm] = useState({});
  const [closeOnSave, setCloseOnSave] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState(null);
  const [extraProblems, setExtraProblems] = useState([]);
  const [problemQuery, setProblemQuery] = useState("");
  const [problemOpen, setProblemOpen] = useState(false);
  const [creatingProblem, setCreatingProblem] = useState(false);
  const fileInputRef = React.useRef(null);

  const reload = useCallback(() => {
    return apiGet(`/api/tickets/${ticketId}`).then((t) => {
      applyTicketForm(t, setTicket, setForm);
      return t;
    });
  }, [ticketId]);

  useEffect(() => {
    let cancelled = false;
    setTicket(null);
    setErr(null);
    reload().catch((e) => { if (!cancelled) setErr(String(e)); });
    return () => { cancelled = true; };
  }, [ticketId]);

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const allProblems = useMemo(() => [...(meta.problems || []), ...extraProblems], [meta.problems, extraProblems]);
  const currentProblem = allProblems.find((p) => p.id === form.problemId);
  const filteredProblems = useMemo(() => {
    const q = problemQuery.trim().toLowerCase();
    if (!q) return allProblems.slice(0, 20);
    return allProblems.filter((p) => (p.title || "").toLowerCase().includes(q)).slice(0, 20);
  }, [allProblems, problemQuery]);

  const complexOptions = useMemo(() => {
    const set = new Set(meta.complexes || []);
    for (const c of (form.complexes || [])) set.add(c);
    for (const c of (ticket?.complexes || [])) set.add(c);
    return [...set].sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));
  }, [meta.complexes, form.complexes, ticket]);

  const toggleComplex = (serial) => {
    setForm((f) => {
      const cur = new Set(f.complexes || []);
      if (cur.has(serial)) cur.delete(serial);
      else cur.add(serial);
      return { ...f, complexes: [...cur].sort((a, b) => a.localeCompare(b, "ru", { numeric: true })) };
    });
  };

  const sameComplexes = (a, b) => {
    const aa = [...(a || [])].map(String).sort().join("\0");
    const bb = [...(b || [])].map(String).sort().join("\0");
    return aa === bb;
  };

  const pickProblem = (p) => {
    update("problemId", p ? p.id : "");
    setProblemQuery("");
    setProblemOpen(false);
  };
  const createProblemFromQuery = async () => {
    const title = problemQuery.trim();
    if (!title) return;
    setCreatingProblem(true);
    try {
      const created = await apiPostJson("/api/problems", { title });
      setExtraProblems((arr) => [...arr, { id: created.id, title: created.title }]);
      pickProblem({ id: created.id, title: created.title });
    } catch (e) {
      setErr(String(e));
    } finally {
      setCreatingProblem(false);
    }
  };

  const copyField = async (k) => {
    try { await navigator.clipboard.writeText(form[k] || ""); } catch (e) { /* игнор — не критично */ }
  };
  const onPasteDatetime = (k, e) => {
    const text = (e.clipboardData || window.clipboardData).getData("text");
    const norm = normalizePastedDatetime(text);
    if (norm) {
      e.preventDefault();
      update(k, norm);
    }
  };

  const getChangedFields = () => {
    if (!ticket) return {};
    const fields = {};
    for (const fd of EDIT_FIELDS) {
      const raw = form[fd.key];
      const orig = fd.type === "datetime" ? toLocalInput(ticket[fd.key])
        : fd.type === "checkbox" ? !!ticket[fd.key]
        : (ticket[fd.key] ?? "");
      if (raw !== orig) {
        fields[fd.key] = fd.type === "datetime" ? fromLocalInput(raw)
          : fd.type === "checkbox" ? !!raw
          : raw;
      }
    }
    if (!sameComplexes(form.complexes, ticket.complexes)) {
      fields.complexes = [...(form.complexes || [])];
    }
    return fields;
  };
  const isDirty = ticket && Object.keys(getChangedFields()).length > 0;

  const confirmDiscard = () => !isDirty || window.confirm("Есть несохранённые изменения. Закрыть без сохранения?");
  const handleClose = () => { if (confirmDiscard()) onClose(); };

  const navIdx = ticketIds ? ticketIds.indexOf(ticketId) : -1;
  const hasPrev = navIdx > 0;
  const hasNext = navIdx >= 0 && navIdx < ticketIds.length - 1;
  const goPrev = () => { if (hasPrev && confirmDiscard()) onNavigate(ticketIds[navIdx - 1]); };
  const goNext = () => { if (hasNext && confirmDiscard()) onNavigate(ticketIds[navIdx + 1]); };

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const fields = getChangedFields();
      if (Object.keys(fields).length === 0) {
        if (closeOnSave) onClose();
        return;
      }
      // Ответ PATCH уже содержит обновлённые поля — не делаем второй
      // GET /tickets/{id} (он тянет все фото заново и тормозит карточку).
      const updated = await apiPatch(`/api/tickets/${ticketId}`, { fields, event: "Изменено через дашборд" });
      const prevFiles = ticket?.files;
      const merged = {
        ...updated,
        files: (prevFiles && prevFiles.length) ? prevFiles : (updated.files || []),
      };
      applyTicketForm(merged, setTicket, setForm);
      if (onTicketUpdated) onTicketUpdated(merged);
      if (closeOnSave) onSaved(merged);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  const removeTicket = async () => {
    if (!ticket) return;
    const code = ticket.code || ticketId;
    if (!window.confirm(`Удалить заявку ${code} из Service Desk безвозвратно?\n\nЭто действие нельзя отменить.`)) return;
    setDeleting(true);
    setErr(null);
    try {
      await apiDelete(`/api/tickets/${ticketId}`);
      if (onDeleted) onDeleted(ticketId, ticket);
      else if (onSaved) onSaved(null);
      else onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setDeleting(false);
    }
  };

  const onPickFiles = async (fileList) => {
    if (!fileList || !fileList.length) return;
    setUploading(true);
    setErr(null);
    try {
      for (const file of fileList) {
        const fd = new FormData();
        fd.append("file", file);
        const r = await fetch(`/api/tickets/${ticketId}/files`, { method: "POST", body: fd });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      }
      await reload();
    } catch (e) {
      setErr(String(e));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const negBanner = ticket && ticket.negative_response;
  const durBanner = ticket && ticket.duration_reason === "invalid_negative";
  const downtimePreview = useMemo(() => computeDowntimePreview(form), [form.severity, form.priority, form.incidentAt, form.workStartedAt, form.closedAt]);

  return html`
    <div class="modal-backdrop">
      <div class="modal modal-wide">
        <button class="modal-close" onClick=${handleClose}>×</button>
        ${ticketIds && ticketIds.length > 1 && html`
          <div class="modal-nav">
            <button class="btn secondary" onClick=${goPrev} disabled=${!hasPrev}>‹ Пред.</button>
            <span class="muted">${navIdx + 1} из ${ticketIds.length}</span>
            <button class="btn secondary" onClick=${goNext} disabled=${!hasNext}>След. ›</button>
          </div>
        `}
        ${!ticket ? html`<div class="muted">Загрузка…</div>` : html`
          <h2>${ticket.code} — ${ticket.title || ""}</h2>
          <div class="muted">Клиент: ${ticket.client || "—"} · Объект: ${ticket.object || "—"}</div>
          ${(ticket.relatedTickets || []).length > 0 && html`
            <div class="muted" style=${{ marginTop: "4px" }}>Связанные заявки: ${(ticket.relatedTickets || []).join(", ")}</div>
          `}
          ${err && html`<div class="error-banner">${err}</div>`}
            ${negBanner && html`
            <div class="error-banner">⚠ Время начала работ (${fmtDt(ticket.workStartedAt)}) раньше времени инцидента (${fmtDt(ticket.incidentAt)}) на ${ticket.response_hours_negative} ч — проверьте даты.</div>
            `}
          ${ticket && hasNoProblem(ticket) && html`
            <div class="error-banner" style=${{ borderColor: "var(--accent)", background: "rgba(91,140,255,0.12)" }}>
              ⚠ Заявка не привязана к проблеме — выберите или создайте проблему в поле ниже.
            </div>
          `}
          ${durBanner && html`
            <div class="error-banner">⚠ Время начала работ позже времени окончания — длительность не считается, проверьте даты.</div>
          `}
          <div class="summary-card" style=${{ marginBottom: "12px" }}>
            <div class="muted" style=${{ marginBottom: "4px" }}>Время простоя в общий отчёт (по влиянию/приоритету, live):</div>
            ${downtimePreview.reason === "excluded_severity" && html`<div>Не входит в даунтайм при этом влиянии</div>`}
            ${downtimePreview.reason === "excluded_priority" && html`<div>Не входит в даунтайм — «Функционал не ограничен» считается только при приоритете Высокий/Срочный</div>`}
            ${downtimePreview.reason === "no_start" && html`<div class="muted">Не заполнено поле «${DOWNTIME_FIELD_LABELS[downtimePreview.startField]}» — часы не считаются</div>`}
            ${downtimePreview.reason === "still_open" && html`<div class="muted">Нет времени закрытия — часы не считаются</div>`}
            ${downtimePreview.reason === "invalid_negative" && html`<div style=${{ color: "var(--red)" }}>⚠ «${DOWNTIME_FIELD_LABELS[downtimePreview.startField]}» позже времени закрытия — проверьте даты</div>`}
            ${downtimePreview.reason === "ok" && html`
              <div><span class="pct-total">${downtimePreview.hours.toFixed(2)} ч</span>
                <span class="muted"> — от ${DOWNTIME_FIELD_LABELS[downtimePreview.startField]} до закрытия</span></div>
            `}
          </div>
          <div class="field-grid">
            <div class="full-width">
              <label>Комплексы</label>
              <div class="complexes-picker">
                ${complexOptions.map((serial) => {
                  const on = (form.complexes || []).includes(serial);
                  const name = (meta.complex_names && meta.complex_names[serial]) || "";
                  return html`
                    <label key=${serial} class=${"complex-chip" + (on ? " active" : "")}
                           title=${name || serial}>
                      <input type="checkbox" checked=${on}
                             onChange=${() => toggleComplex(serial)} />
                      <span>${serial}${name ? ` — ${name}` : ""}</span>
                    </label>
                  `;
                })}
                ${complexOptions.length === 0 && html`<div class="muted">Справочник комплексов пуст</div>`}
              </div>
              ${(form.complexes || []).length === 0 && html`
                <div class="muted" style=${{ marginTop: "4px" }}>Не выбран ни один комплекс — заявка выпадет из отчёта F-4</div>
              `}
            </div>
            ${EDIT_FIELDS.map((fd) => html`
              <div class=${fd.wide ? "full-width" : ""} key=${fd.key}>
                <label>${fd.label}</label>
                ${fd.type === "select" ? html`
                  <select value=${form[fd.key] || ""} onChange=${(e) => update(fd.key, e.target.value)}>
                    <option value="">—</option>
                    ${(meta[fd.opts] || []).map((o) => html`<option value=${o} key=${o}>${o}</option>`)}
                  </select>
                ` : fd.type === "problem" ? html`
                  <div style=${{ position: "relative" }}>
                    <div style=${{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                      <span style=${{ fontSize: "14px", fontWeight: 600 }}>
                        ${currentProblem ? (currentProblem.title || currentProblem.id) : "— Не привязана —"}
                      </span>
                      ${currentProblem && html`
                        <button type="button" class="btn secondary" style=${{ padding: "2px 8px", fontSize: "11px" }}
                                onClick=${() => pickProblem(null)}>Отвязать</button>
                      `}
                    </div>
                    <div style=${{ display: "flex", gap: "4px" }}>
                      <input type="text" style=${{ flex: 1 }} placeholder="Начните вводить название для поиска…"
                             value=${problemQuery}
                             onFocus=${() => setProblemOpen(true)}
                             onChange=${(e) => { setProblemQuery(e.target.value); setProblemOpen(true); }}
                             onKeyDown=${(e) => { if (e.key === "Escape") { setProblemOpen(false); e.target.blur(); } }} />
                      ${problemOpen && html`
                        <button type="button" class="btn secondary" title="Закрыть (Esc)" style=${{ padding: "6px 10px" }}
                                onClick=${() => setProblemOpen(false)}>×</button>
                      `}
                    </div>
                    ${problemOpen && html`
                      <div style=${{ position: "absolute", zIndex: 50, top: "100%", left: 0, right: 0, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "6px", maxHeight: "220px", overflowY: "auto", marginTop: "2px", boxShadow: "0 4px 16px rgba(0,0,0,0.4)" }}>
                        <div class="problem-item" onClick=${() => pickProblem(null)}>— Не привязана —</div>
                        ${filteredProblems.map((p) => html`<div key=${p.id} class="problem-item" onClick=${() => pickProblem(p)}>${p.title || p.id}</div>`)}
                        ${problemQuery.trim() && html`
                          <div class="problem-item" style=${{ color: "var(--accent)" }} onClick=${createProblemFromQuery}>
                            ${creatingProblem ? "Создание…" : `+ Создать проблему «${problemQuery.trim()}»`}
                          </div>
                        `}
                      </div>
                    `}
                  </div>
                ` : fd.type === "datetime" ? html`
                  <div style=${{ display: "flex", gap: "4px" }}>
                    <input type="datetime-local" style=${{ flex: 1 }} value=${form[fd.key] || ""}
                           onChange=${(e) => update(fd.key, e.target.value)}
                           onPaste=${(e) => onPasteDatetime(fd.key, e)} />
                    <button type="button" class="btn secondary" title="Скопировать значение"
                            style=${{ padding: "6px 8px" }} onClick=${() => copyField(fd.key)}>⧉</button>
                  </div>
                ` : fd.type === "checkbox" ? html`
                  <label style=${{ display: "flex", alignItems: "center", gap: "8px", marginTop: "6px", cursor: "pointer" }}>
                    <input type="checkbox" checked=${!!form[fd.key]}
                           onChange=${(e) => update(fd.key, e.target.checked)} />
                    <span class="muted">${form[fd.key] ? "да" : "нет"}</span>
                  </label>
                ` : fd.type === "textarea" ? html`
                  <textarea rows="3" value=${form[fd.key] || ""} onChange=${(e) => update(fd.key, e.target.value)}></textarea>
                ` : html`
                  <input type="text" value=${form[fd.key] || ""} onChange=${(e) => update(fd.key, e.target.value)} />
                `}
              </div>
            `)}
          </div>

          <div class="section-title" style=${{ marginTop: "20px" }}>Файлы (${(ticket.files || []).length})</div>
          <div style=${{ display: "flex", flexWrap: "wrap", gap: "10px", marginBottom: "10px" }}>
            ${(ticket.files || []).length === 0 && html`<div class="muted">Вложений нет</div>`}
            ${(ticket.files || []).map((f, i) => html`
              <div key=${i} style=${{ width: "110px" }}>
                ${(f.type || "").startsWith("image/") && f.dataUrl ? html`
                  <img src=${f.dataUrl} onClick=${() => setLightboxSrc(f.dataUrl)}
                       style=${{ width: "110px", height: "80px", objectFit: "cover", borderRadius: "6px", border: "1px solid var(--border)", cursor: "zoom-in" }} />
                ` : html`
                  <a href=${f.dataUrl} download=${f.name || "file"} style=${{ display: "flex", alignItems: "center", justifyContent: "center", width: "110px", height: "80px", background: "var(--surface-2)", borderRadius: "6px", border: "1px solid var(--border)", color: "var(--text-dim)", fontSize: "11px", textAlign: "center", padding: "4px" }}>
                    ${f.name || "файл"}
                  </a>
                `}
                <div class="muted" style=${{ fontSize: "10px", marginTop: "2px", wordBreak: "break-all" }}>${f.name} · ${fmtSize(f.size)}</div>
              </div>
            `)}
          </div>
          ${lightboxSrc && html`
            <div class="lightbox-backdrop" onClick=${() => setLightboxSrc(null)}>
              <button class="lightbox-close" onClick=${() => setLightboxSrc(null)}>×</button>
              <img src=${lightboxSrc} onClick=${(e) => e.stopPropagation()} />
            </div>
          `}
          <div>
            <input ref=${fileInputRef} type="file" multiple onChange=${(e) => onPickFiles(e.target.files)} disabled=${uploading} />
            ${uploading && html`<span class="muted"> загрузка…</span>`}
          </div>

          <div style=${{ marginTop: "16px", display: "flex", gap: "12px", justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap" }}>
            <button class="btn danger" onClick=${removeTicket} disabled=${saving || deleting || uploading}
                    title="Удалить заявку в Service Desk">
              ${deleting ? "Удаление…" : "Удалить из SD"}
            </button>
            <span style=${{ flex: 1 }}></span>
            <label style=${{ margin: 0, display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
              <input type="checkbox" checked=${closeOnSave} onChange=${(e) => setCloseOnSave(e.target.checked)} />
              <span class="muted">Закрывать после сохранения</span>
            </label>
            <button class="btn secondary" onClick=${handleClose} disabled=${saving || deleting}>Отмена</button>
            <button class="btn" onClick=${save} disabled=${saving || deleting}>${saving ? "Сохранение…" : "Сохранить"}</button>
          </div>
        `}
      </div>
    </div>
  `;
}

// ------------------------------------------------------------ TicketsTab ----

function periodRange(preset) {
  if (preset === "7d") return { start: todayISO(-6), end: todayISO() };
  if (preset === "30d") return { start: todayISO(-29), end: todayISO() };
  if (preset === "today") return { start: todayISO(), end: todayISO() };
  return null;
}

function cmpVal(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/** Заявка без привязанной проблемы — пустой/отсутствующий problemId. */
function hasNoProblem(t) {
  return !t?.problemId;
}

/** Причины ручной проверки: даты, длинная работа, нет проблемы. */
function needsReview(t, threshold) {
  return hasNoProblem(t)
    || t.negative_response
    || t.duration_reason === "invalid_negative"
    || (t.duration_hours != null && t.duration_hours >= threshold);
}

/** Ответ PATCH/GET карточки → строка списка (без повторного /api/tickets). */
function ticketToListRow(t, prev) {
  const files = t.files || [];
  const filesCount = files.length || prev?.files_count || 0;
  return {
    ...(prev || {}),
    id: t.id,
    code: t.code,
    title: t.title,
    client: t.client,
    object: t.object,
    complexes: t.complexes,
    node: t.node,
    status: t.status,
    severity: t.severity,
    priority: t.priority,
    engineer: t.engineer,
    workType: t.workType,
    workResult: t.workResult,
    createdAt: t.createdAt,
    incidentAt: t.incidentAt,
    workStartedAt: t.workStartedAt,
    closedAt: t.closedAt,
    duration_hours: t.duration_hours,
    duration_reason: t.duration_reason,
    negative_response: t.negative_response,
    response_hours_negative: t.response_hours_negative,
    downtime_hours: t.downtime_hours,
    downtime_reason: t.downtime_reason,
    downtime_start_field: t.downtime_start_field,
    problemId: t.problemId,
    files_count: filesCount,
  };
}

function applyTicketForm(t, setTicket, setForm) {
  setTicket(t);
  const f = {};
  for (const fd of EDIT_FIELDS) {
    if (fd.type === "datetime") f[fd.key] = toLocalInput(t[fd.key]);
    else if (fd.type === "checkbox") f[fd.key] = !!t[fd.key];
    else f[fd.key] = t[fd.key] ?? "";
  }
  f.complexes = [...(t.complexes || [])];
  setForm(f);
}

function SortTh({ label, sortKey, current, dir, onSort }) {
  const active = current === sortKey;
  return html`
    <th style=${{ cursor: "pointer", userSelect: "none" }} onClick=${() => onSort(sortKey)}>
      ${label}${active ? (dir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  `;
}

function TicketsTab({ meta, refreshTick }) {
  const [preset, setPreset] = useState("30d");
  const [start, setStart] = useState(todayISO(-29));
  const [end, setEnd] = useState(todayISO());
  const [dateField, setDateField] = useState("workStartedAt");
  const [complexFilter, setComplexFilter] = useState("");
  const [severityFilter, setSeverityFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [nodeFilter, setNodeFilter] = useState("");
  const [engineerFilter, setEngineerFilter] = useState("");
  const [workTypeFilter, setWorkTypeFilter] = useState("");
  const [onlyWarnings, setOnlyWarnings] = useState(false);
  const [onlyInvalidDuration, setOnlyInvalidDuration] = useState(false);
  const [threshold, setThreshold] = useState(4);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [openTicket, setOpenTicket] = useState(null);
  const [sortKey, setSortKey] = useState("incidentAt");
  const [sortDir, setSortDir] = useState("desc");

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    const params = new URLSearchParams();
    if (start) params.set("start", start);
    if (end) params.set("end", end);
    if (dateField) params.set("date_field", dateField);
    if (complexFilter) params.set("complex", complexFilter);
    apiGet(`/api/tickets?${params.toString()}`)
      .then((d) => setRows(d.tickets))
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [start, end, dateField, complexFilter]);

  useEffect(() => { load(); }, [load, refreshTick]);

  const applyPreset = (p) => {
    setPreset(p);
    const r = periodRange(p);
    if (r) { setStart(r.start); setEnd(r.end); }
  };

  const onSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  };

  const visibleRows = useMemo(() => {
    let out = rows;
    if (severityFilter) out = out.filter((t) => t.severity === severityFilter);
    if (statusFilter) out = out.filter((t) => t.status === statusFilter);
    if (nodeFilter) out = out.filter((t) => t.node === nodeFilter);
    if (engineerFilter) out = out.filter((t) => t.engineer === engineerFilter);
    if (workTypeFilter) out = out.filter((t) => t.workType === workTypeFilter);
    if (onlyInvalidDuration) out = out.filter((t) => t.duration_reason === "invalid_negative");
    if (onlyWarnings) out = out.filter((t) => needsReview(t, threshold));
    out = [...out].sort((a, b) => cmpVal(a[sortKey], b[sortKey]) * (sortDir === "asc" ? 1 : -1));
    return out;
  }, [rows, severityFilter, statusFilter, nodeFilter, engineerFilter, workTypeFilter, onlyWarnings, onlyInvalidDuration, threshold, sortKey, sortDir]);

  return html`
    <div>
      <div class="pill-row">
        ${["today", "7d", "30d", "custom"].map((p) => html`
          <div key=${p} class=${"pill" + (preset === p ? " active" : "")} onClick=${() => applyPreset(p)}>
            ${{ today: "Сегодня", "7d": "7 дней", "30d": "30 дней", custom: "Свой период" }[p]}
          </div>
        `)}
        <input type="date" value=${start} onChange=${(e) => { setStart(e.target.value); setPreset("custom"); }} />
        <span class="muted">—</span>
        <input type="date" value=${end} onChange=${(e) => { setEnd(e.target.value); setPreset("custom"); }} />
        <span class="muted">период по:</span>
        <select value=${dateField} onChange=${(e) => setDateField(e.target.value)}>
          <option value="workStartedAt">Начало работ</option>
          <option value="incidentAt">Регистрация инцидента</option>
          <option value="closedAt">Закрытие</option>
        </select>
        <select value=${complexFilter} onChange=${(e) => setComplexFilter(e.target.value)}>
          <option value="">Все комплексы</option>
          ${(meta.complexes || []).map((c) => html`<option value=${c} key=${c}>${c}</option>`)}
        </select>
        <button class="btn secondary" onClick=${load}>Применить</button>
      </div>
      <div class="pill-row">
        <select value=${severityFilter} onChange=${(e) => setSeverityFilter(e.target.value)}>
          <option value="">Все влияния</option>
          ${(meta.severities || []).map((o) => html`<option value=${o} key=${o}>${o}</option>`)}
        </select>
        <select value=${statusFilter} onChange=${(e) => setStatusFilter(e.target.value)}>
          <option value="">Все статусы</option>
          ${(meta.statuses || []).map((o) => html`<option value=${o} key=${o}>${o}</option>`)}
        </select>
        <select value=${nodeFilter} onChange=${(e) => setNodeFilter(e.target.value)}>
          <option value="">Все узлы</option>
          ${(meta.nodes || []).map((o) => html`<option value=${o} key=${o}>${o}</option>`)}
        </select>
        <select value=${engineerFilter} onChange=${(e) => setEngineerFilter(e.target.value)}>
          <option value="">Все инженеры</option>
          ${(meta.engineers || []).map((o) => html`<option value=${o} key=${o}>${o}</option>`)}
        </select>
        <select value=${workTypeFilter} onChange=${(e) => setWorkTypeFilter(e.target.value)}>
          <option value="">Все виды работ</option>
          ${(meta.workTypes || []).map((o) => html`<option value=${o} key=${o}>${o}</option>`)}
        </select>
        <label style=${{ margin: 0, display: "flex", alignItems: "center", gap: "6px" }}>
          <span class="muted">Порог длительности, ч:</span>
          <input type="number" style=${{ width: "60px" }} value=${threshold} onChange=${(e) => setThreshold(Number(e.target.value) || 0)} />
        </label>
        <div class=${"pill" + (onlyWarnings ? " active" : "")} onClick=${() => setOnlyWarnings((v) => !v)}>Только требующие проверки</div>
        <div class=${"pill" + (onlyInvalidDuration ? " active" : "")} onClick=${() => setOnlyInvalidDuration((v) => !v)}>⚠ Некорректное время работы</div>
      </div>
      ${err && html`<div class="error-banner">${err}</div>`}
      ${loading ? html`<div class="muted">Загрузка…</div>` : html`
        <div class="muted" style=${{ marginBottom: "8px" }}>Показано: ${visibleRows.length} из ${rows.length} · клик по заголовку колонки — сортировка</div>
        <table>
          <thead>
            <tr>
              <${SortTh} label="Код" sortKey="code" current=${sortKey} dir=${sortDir} onSort=${onSort} />
              <th>Комплексы</th><th>Клиент/объект</th>
              <${SortTh} label="Влияние" sortKey="severity" current=${sortKey} dir=${sortDir} onSort=${onSort} />
              <${SortTh} label="Узел" sortKey="node" current=${sortKey} dir=${sortDir} onSort=${onSort} />
              <${SortTh} label="Вид работ" sortKey="workType" current=${sortKey} dir=${sortDir} onSort=${onSort} />
              <${SortTh} label="Инцидент" sortKey="incidentAt" current=${sortKey} dir=${sortDir} onSort=${onSort} />
              <${SortTh} label="Начало работ" sortKey="workStartedAt" current=${sortKey} dir=${sortDir} onSort=${onSort} />
              <${SortTh} label="Окончание" sortKey="closedAt" current=${sortKey} dir=${sortDir} onSort=${onSort} />
              <${SortTh} label="Длительность, ч" sortKey="duration_hours" current=${sortKey} dir=${sortDir} onSort=${onSort} />
              <${SortTh} label="Даунтайм, ч" sortKey="downtime_hours" current=${sortKey} dir=${sortDir} onSort=${onSort} />
              <${SortTh} label="Статус" sortKey="status" current=${sortKey} dir=${sortDir} onSort=${onSort} />
            </tr>
          </thead>
          <tbody>
            ${visibleRows.map((t) => {
              const noProblem = hasNoProblem(t);
              const rowClass = "row-clickable"
                + (t.negative_response ? " row-warn-dates" : "")
                + (noProblem ? " row-warn-noproblem" : "");
              return html`
              <tr key=${t.id} class=${rowClass} onClick=${() => setOpenTicket(t.id)}>
                <td>
                  ${t.code}
                  ${noProblem && html`<div class="row-hint-noproblem">⚠ нет проблемы</div>`}
                </td>
                <td>${(t.complexes || []).join(", ")}</td>
                <td>${t.client || ""}${t.object ? " / " + t.object : ""}</td>
                <td><span class=${"badge " + severityBadgeClass(t.severity)}>${t.severity || "—"}</span></td>
                <td>${t.node || "—"}</td>
                <td>${t.workType || "—"}</td>
                <td>${fmtDt(t.incidentAt)}</td>
                <td>
                  ${fmtDt(t.workStartedAt)}
                  ${t.negative_response && html`<div class="row-hint-dates">⚠ раньше инцидента на ${t.response_hours_negative} ч</div>`}
                </td>
                <td>${fmtDt(t.closedAt)}</td>
                <td class=${t.duration_hours != null && t.duration_hours >= threshold ? "duration-long" : "duration-normal"}>
                  ${t.duration_hours != null ? t.duration_hours : (t.duration_reason === "still_open" ? "не закрыта" : t.duration_reason === "no_work_start" ? "нет даты работ" : t.duration_reason === "invalid_negative" ? "⚠ некорр. время" : "—")}
                </td>
                <td>
                  ${t.downtime_hours != null ? t.downtime_hours : (
                    t.downtime_reason === "excluded_severity" || t.downtime_reason === "excluded_priority" ? html`<span class="muted">не входит</span>` :
                    t.downtime_reason === "still_open" ? "не закрыта" :
                    t.downtime_reason === "no_start" ? "нет даты" :
                    t.downtime_reason === "invalid_negative" ? "⚠ некорр. время" : "—"
                  )}
                </td>
                <td>${t.status || "—"}</td>
              </tr>
            `;
            })}
          </tbody>
        </table>
      `}
      ${openTicket && html`<${TicketModal}
        ticketId=${openTicket}
        meta=${meta}
        ticketIds=${visibleRows.map((r) => r.id)}
        onNavigate=${(id) => setOpenTicket(id)}
        onClose=${() => setOpenTicket(null)}
        onTicketUpdated=${(t) => setRows((rs) => rs.map((r) => r.id === t.id ? ticketToListRow(t, r) : r))}
        onDeleted=${(id) => {
          setOpenTicket(null);
          setRows((rs) => rs.filter((r) => r.id !== id));
        }}
        onSaved=${(t) => {
          setOpenTicket(null);
          if (t) setRows((rs) => rs.map((r) => r.id === t.id ? ticketToListRow(t, r) : r));
        }}
      />`}
    </div>
  `;
}

// ----------------------------------------------------------- ProblemsTab ----

const PROBLEM_SORT_OPTIONS = [
  { key: "last_activity", label: "По активности" },
  { key: "first_seen", label: "По дате добавления" },
  { key: "title", label: "По названию" },
  { key: "ticket_count", label: "По числу заявок" },
  { key: "open_count", label: "По открытым" },
];

function buildMergedDescription(target, source) {
  const parts = [];
  const td = (target.description || "").trim();
  const sd = (source.description || "").trim();
  if (td) parts.push(td);
  const marker = `--- (объединено из «${source.title || source.id}») ---`;
  if (sd && sd !== td) {
    parts.push(marker);
    parts.push(sd);
  } else if (!td && source.title) {
    parts.push(marker);
    if (sd) parts.push(sd);
  }
  return parts.join("\n\n");
}

function mergeStatusIcon(st) {
  if (st === "ok") return html`<span class="merge-status ok">OK</span>`;
  if (st === "fail") return html`<span class="merge-status fail">Ошибка</span>`;
  if (st === "running") return html`<span class="merge-status running">…</span>`;
  if (st === "skip") return html`<span class="merge-status skip">пропуск</span>`;
  return html`<span class="merge-status pending">ожидание</span>`;
}

function MergeProblemsModal({ problems, initialSourceId, onClose, onDone }) {
  const [sourceId, setSourceId] = useState(initialSourceId || "");
  const [targetId, setTargetId] = useState("");
  const [mergedDesc, setMergedDesc] = useState("");
  const [tickets, setTickets] = useState([]);
  const [ticketStatus, setTicketStatus] = useState({}); // id -> {status, error?}
  const [descStatus, setDescStatus] = useState("pending");
  const [deleteStatus, setDeleteStatus] = useState("pending");
  const [deleteError, setDeleteError] = useState(null);
  const [phase, setPhase] = useState("setup"); // setup | running | done
  const [loadErr, setLoadErr] = useState(null);
  const [loadingTickets, setLoadingTickets] = useState(false);
  const cancelRef = React.useRef(false);

  const source = problems.find((p) => p.id === sourceId);
  const target = problems.find((p) => p.id === targetId);
  const canPrepare = sourceId && targetId && sourceId !== targetId;

  useEffect(() => {
    if (!canPrepare || phase !== "setup") return;
    setMergedDesc(buildMergedDescription(target, source));
    setLoadingTickets(true);
    setLoadErr(null);
    apiGet(`/api/problems/${sourceId}`)
      .then((d) => {
        const list = d.tickets || [];
        setTickets(list);
        const st = {};
        for (const t of list) st[t.id] = { status: "pending" };
        setTicketStatus(st);
      })
      .catch((e) => setLoadErr(String(e)))
      .finally(() => setLoadingTickets(false));
  }, [sourceId, targetId, canPrepare, phase]);

  const doneCount = useMemo(() => {
    let n = 0;
    if (descStatus === "ok" || descStatus === "fail" || descStatus === "skip") n += 1;
    for (const t of tickets) {
      const s = ticketStatus[t.id]?.status;
      if (s === "ok" || s === "fail" || s === "skip") n += 1;
    }
    if (deleteStatus === "ok" || deleteStatus === "fail" || deleteStatus === "skip") n += 1;
    return n;
  }, [descStatus, deleteStatus, tickets, ticketStatus]);

  const totalSteps = 1 + tickets.length + 1; // desc + tickets + delete
  const pct = totalSteps ? Math.round((doneCount / totalSteps) * 100) : 0;
  const okTickets = tickets.filter((t) => ticketStatus[t.id]?.status === "ok").length;
  const failTickets = tickets.filter((t) => ticketStatus[t.id]?.status === "fail").length;

  const runMerge = async () => {
    if (!canPrepare || phase === "running") return;
    if (!window.confirm(
      `Объединить «${source.title}» → «${target.title}»?\n`
      + `Заявок к переносу: ${tickets.length}.\n`
      + `Исходная проблема будет удалена, если все переносы пройдут успешно.`
    )) return;

    cancelRef.current = false;
    setPhase("running");
    setDescStatus("pending");
    setDeleteStatus("pending");
    setDeleteError(null);
    const st0 = {};
    for (const t of tickets) st0[t.id] = { status: "pending" };
    setTicketStatus(st0);

    // 1) описание целевой
    setDescStatus("running");
    try {
      await apiPatch(`/api/problems/${targetId}`, { description: mergedDesc });
      setDescStatus("ok");
    } catch (e) {
      setDescStatus("fail");
      setPhase("done");
      setDeleteStatus("skip");
      setTicketStatus((prev) => {
        const next = { ...prev };
        for (const t of tickets) next[t.id] = { status: "skip" };
        return next;
      });
      setLoadErr("Не удалось обновить описание целевой проблемы: " + e);
      return;
    }

    // 2) перепривязка заявок по одной
    let fails = 0;
    for (const t of tickets) {
      if (cancelRef.current) {
        setTicketStatus((prev) => {
          const next = { ...prev };
          for (const tt of tickets) {
            if ((next[tt.id]?.status || "pending") === "pending") next[tt.id] = { status: "skip" };
          }
          return next;
        });
        break;
      }
      setTicketStatus((prev) => ({ ...prev, [t.id]: { status: "running" } }));
      try {
        await apiPatch(`/api/tickets/${t.id}`, {
          fields: { problemId: targetId },
          event: `Объединение проблем → ${target.title || targetId}`,
        });
        setTicketStatus((prev) => ({ ...prev, [t.id]: { status: "ok" } }));
      } catch (e) {
        fails += 1;
        setTicketStatus((prev) => ({ ...prev, [t.id]: { status: "fail", error: String(e) } }));
      }
    }

    // 3) удаление исходной — только если все заявки перенесены
    if (fails === 0 && !cancelRef.current) {
      setDeleteStatus("running");
      try {
        await apiDelete(`/api/problems/${sourceId}`);
        setDeleteStatus("ok");
      } catch (e) {
        setDeleteStatus("fail");
        setDeleteError(String(e));
      }
    } else {
      setDeleteStatus("skip");
      if (fails > 0) {
        setDeleteError(`Исходная проблема не удалена: не перенесено ${fails} заявок.`);
      }
    }
    setPhase("done");
  };

  const problemOptions = [...problems].sort((a, b) =>
    (a.title || "").localeCompare(b.title || "", "ru", { sensitivity: "base" })
  );

  return html`
    <div class="modal-backdrop">
      <div class="modal modal-wide merge-modal">
        <button class="modal-close" onClick=${() => { if (phase !== "running") onClose(); }} disabled=${phase === "running"}>×</button>
        <h2>Объединение проблем</h2>
        <p class="muted" style=${{ marginTop: 0 }}>
          Заявки с исходной проблемы получат <code>problemId</code> целевой.
          Описания склеятся. Исходная проблема удалится после успешных переносов.
        </p>

        <div class="merge-pick-grid">
          <div>
            <label>Исходная (будет удалена)</label>
            <select disabled=${phase !== "setup"} value=${sourceId}
                    onChange=${(e) => setSourceId(e.target.value)}>
              <option value="">— выберите —</option>
              ${problemOptions.map((p) => html`
                <option key=${p.id} value=${p.id} disabled=${p.id === targetId}>
                  ${p.title || p.id} (${p.ticket_count} заявок)
                </option>
              `)}
            </select>
          </div>
          <div class="merge-arrow">→</div>
          <div>
            <label>Целевая (останется)</label>
            <select disabled=${phase !== "setup"} value=${targetId}
                    onChange=${(e) => setTargetId(e.target.value)}>
              <option value="">— выберите —</option>
              ${problemOptions.map((p) => html`
                <option key=${p.id} value=${p.id} disabled=${p.id === sourceId}>
                  ${p.title || p.id} (${p.ticket_count} заявок)
                </option>
              `)}
            </select>
          </div>
        </div>

        ${loadErr && html`<div class="error-banner">${loadErr}</div>`}
        ${loadingTickets && html`<div class="muted">Загрузка заявок исходной проблемы…</div>`}

        ${canPrepare && !loadingTickets && html`
          <div class="section-title">Описание после объединения (можно править)</div>
          <textarea rows="6" class="merge-desc" disabled=${phase !== "setup"}
                    value=${mergedDesc} onChange=${(e) => setMergedDesc(e.target.value)}></textarea>

          <div class="section-title">Заявки для смены problemId (${tickets.length})</div>
          ${tickets.length === 0
            ? html`<div class="muted">У исходной проблемы нет привязанных заявок — будет обновлено только описание и удаление.</div>`
            : html`
              <div class="merge-ticket-list">
                <table>
                  <thead>
                    <tr>
                      <th style=${{ width: "90px" }}>Статус</th>
                      <th>Код</th>
                      <th>Заголовок</th>
                      <th>Статус заявки</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${tickets.map((t) => html`
                      <tr key=${t.id} class=${"merge-row-" + (ticketStatus[t.id]?.status || "pending")}>
                        <td>${mergeStatusIcon(ticketStatus[t.id]?.status || "pending")}</td>
                        <td>${t.code}</td>
                        <td>${t.title || "—"}</td>
                        <td>
                          ${t.status || "—"}
                          ${ticketStatus[t.id]?.error && html`
                            <div class="merge-err">${ticketStatus[t.id].error}</div>
                          `}
                        </td>
                      </tr>
                    `)}
                  </tbody>
                </table>
              </div>
            `}

          ${(phase === "running" || phase === "done") && html`
            <div class="merge-progress-block">
              <div class="merge-progress-meta">
                <span>Прогресс: ${doneCount} / ${totalSteps} шагов (${pct}%)</span>
                <span class="muted">описание: ${descStatus}${tickets.length ? ` · заявки OK ${okTickets} / ошибка ${failTickets}` : ""} · удаление: ${deleteStatus}</span>
              </div>
              <div class="merge-progress-bar"><div style=${{ width: pct + "%" }}></div></div>
              <div class="merge-steps">
                <div class="merge-step">${mergeStatusIcon(descStatus)} Обновить описание целевой проблемы</div>
                <div class="merge-step">${mergeStatusIcon(deleteStatus)} Удалить исходную проблему
                  ${deleteError && html`<div class="merge-err">${deleteError}</div>`}
                </div>
              </div>
            </div>
          `}
        `}

        <div style=${{ marginTop: "16px", display: "flex", gap: "10px", justifyContent: "flex-end" }}>
          ${phase === "setup" && html`
            <button class="btn secondary" onClick=${onClose}>Отмена</button>
            <button class="btn" disabled=${!canPrepare || loadingTickets || !!loadErr}
                    onClick=${runMerge}>Запустить объединение</button>
          `}
          ${phase === "running" && html`
            <button class="btn secondary" onClick=${() => { cancelRef.current = true; }}>Остановить после текущей</button>
          `}
          ${phase === "done" && html`
            <button class="btn" onClick=${() => onDone({ sourceId, targetId, okTickets, failTickets, deleteStatus })}>
              Готово
            </button>
          `}
        </div>
      </div>
    </div>
  `;
}

function ProblemsTab({ meta }) {
  const [problems, setProblems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [openTicket, setOpenTicket] = useState(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [pSortKey, setPSortKey] = useState("last_activity");
  const [pSortDir, setPSortDir] = useState("desc");
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [tSortKey, setTSortKey] = useState("createdAt");
  const [tSortDir, setTSortDir] = useState("desc");
  const [tSeverityFilter, setTSeverityFilter] = useState("");
  const [tStatusFilter, setTStatusFilter] = useState("");
  const [tOnlyInvalidDuration, setTOnlyInvalidDuration] = useState(false);

  const loadProblems = useCallback(() => {
    setLoading(true);
    apiGet("/api/problems").then((d) => {
      setProblems(d.problems);
      setSelected((cur) => {
        if (cur && d.problems.some((p) => p.id === cur)) return cur;
        return d.problems.length ? d.problems[0].id : null;
      });
    }).catch((e) => setErr(String(e))).finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadProblems(); }, [loadProblems]);

  const loadDetail = useCallback(() => {
    if (!selected) return;
    apiGet(`/api/problems/${selected}`).then(setDetail).catch((e) => setErr(String(e)));
  }, [selected]);

  useEffect(() => { setDetail(null); loadDetail(); }, [loadDetail]);

  const visibleProblems = useMemo(() => {
    let out = problems;
    if (onlyOpen) out = out.filter((p) => p.open_count > 0);
    out = [...out].sort((a, b) => cmpVal(a[pSortKey], b[pSortKey]) * (pSortDir === "asc" ? 1 : -1));
    return out;
  }, [problems, onlyOpen, pSortKey, pSortDir]);

  const visibleTickets = useMemo(() => {
    if (!detail) return [];
    let out = detail.tickets;
    if (tSeverityFilter) out = out.filter((t) => t.severity === tSeverityFilter);
    if (tStatusFilter) out = out.filter((t) => t.status === tStatusFilter);
    if (tOnlyInvalidDuration) out = out.filter((t) => t.duration_reason === "invalid_negative");
    out = [...out].sort((a, b) => cmpVal(a[tSortKey], b[tSortKey]) * (tSortDir === "asc" ? 1 : -1));
    return out;
  }, [detail, tSeverityFilter, tStatusFilter, tOnlyInvalidDuration, tSortKey, tSortDir]);

  const onTSort = (key) => {
    if (tSortKey === key) setTSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setTSortKey(key); setTSortDir("asc"); }
  };

  const onTicketSaved = () => {
    setOpenTicket(null);
    loadDetail();
    loadProblems();
  };

  const onMergeDone = (result) => {
    setMergeOpen(false);
    loadProblems();
    if (result?.targetId) setSelected(result.targetId);
    else loadDetail();
  };

  return html`
    <div>
      <div class="pill-row" style=${{ marginBottom: "16px" }}>
        <button class="btn" onClick=${() => setMergeOpen(true)} disabled=${loading || problems.length < 2}>
          Объединить проблемы
        </button>
        <span class="muted">Перенос заявок + склейка описаний + удаление исходной</span>
      </div>
      ${err && html`<div class="error-banner">${err}</div>`}
      ${loading ? html`<div class="muted">Загрузка…</div>` : html`
        <div class="problems-layout">
          <div>
            <div class="pill-row">
              ${PROBLEM_SORT_OPTIONS.map((o) => html`
                <div key=${o.key} class=${"pill" + (pSortKey === o.key ? " active" : "")}
                     onClick=${() => { if (pSortKey === o.key) setPSortDir((d) => (d === "asc" ? "desc" : "asc")); else { setPSortKey(o.key); setPSortDir(o.key === "title" ? "asc" : "desc"); } }}>
                  ${o.label}${pSortKey === o.key ? (pSortDir === "asc" ? " ▲" : " ▼") : ""}
                </div>
              `)}
              <div class=${"pill" + (onlyOpen ? " active" : "")} onClick=${() => setOnlyOpen((v) => !v)}>Только с открытыми</div>
            </div>
            <div class="muted" style=${{ marginBottom: "8px" }}>${visibleProblems.length} из ${problems.length} проблем</div>
            ${visibleProblems.map((p) => html`
              <div key=${p.id} class=${"problem-item" + (selected === p.id ? " active" : "")} onClick=${() => setSelected(p.id)}>
                <div class="title">${p.title || "(без названия)"}</div>
                <div class="meta">Заявок: ${p.ticket_count} · открыто: ${p.open_count} · добавлена: ${p.first_seen ? fmtDt(p.first_seen) : "—"} · активность: ${p.last_activity ? fmtDt(p.last_activity) : "—"}</div>
              </div>
            `)}
          </div>
          <div>
            ${!detail ? html`<div class="muted">Выберите проблему слева</div>` : html`
              <h2 style=${{ marginTop: 0 }}>${detail.title || "(без названия)"}</h2>
              <div style=${{ whiteSpace: "pre-wrap", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "8px", padding: "12px", marginBottom: "16px" }}>
                ${detail.description || "Описание отсутствует"}
              </div>
              <div class="section-title">Привязанные заявки (${visibleTickets.length} из ${detail.tickets.length})</div>
              <div class="pill-row">
                <select value=${tSeverityFilter} onChange=${(e) => setTSeverityFilter(e.target.value)}>
                  <option value="">Все влияния</option>
                  ${(meta.severities || []).map((o) => html`<option value=${o} key=${o}>${o}</option>`)}
                </select>
                <select value=${tStatusFilter} onChange=${(e) => setTStatusFilter(e.target.value)}>
                  <option value="">Все статусы</option>
                  ${(meta.statuses || []).map((o) => html`<option value=${o} key=${o}>${o}</option>`)}
                </select>
                <div class=${"pill" + (tOnlyInvalidDuration ? " active" : "")} onClick=${() => setTOnlyInvalidDuration((v) => !v)}>⚠ Некорректное время работы</div>
              </div>
              <table>
                <thead>
                  <tr>
                    <${SortTh} label="Код" sortKey="code" current=${tSortKey} dir=${tSortDir} onSort=${onTSort} />
                    <th>Заголовок</th><th>Клиент/объект</th><th>Комплексы</th>
                    <${SortTh} label="Влияние" sortKey="severity" current=${tSortKey} dir=${tSortDir} onSort=${onTSort} />
                    <${SortTh} label="Создана" sortKey="createdAt" current=${tSortKey} dir=${tSortDir} onSort=${onTSort} />
                    <${SortTh} label="Статус" sortKey="status" current=${tSortKey} dir=${tSortDir} onSort=${onTSort} />
                    <${SortTh} label="Длит., ч" sortKey="duration_hours" current=${tSortKey} dir=${tSortDir} onSort=${onTSort} />
                  </tr>
                </thead>
                <tbody>
                  ${visibleTickets.map((t) => html`
                    <tr key=${t.id} class="row-clickable" onClick=${() => setOpenTicket(t.id)}>
                      <td>${t.code}</td><td>${t.title || ""}</td>
                      <td>${t.client || ""}${t.object ? " / " + t.object : ""}</td>
                      <td>${(t.complexes || []).join(", ")}</td>
                      <td><span class=${"badge " + severityBadgeClass(t.severity)}>${t.severity || "—"}</span></td>
                      <td>${fmtDt(t.createdAt)}</td><td>${t.status || "—"}</td>
                      <td>${t.duration_hours != null ? t.duration_hours : "—"}</td>
                    </tr>
                  `)}
                </tbody>
              </table>
            `}
          </div>
        </div>
      `}
      ${openTicket && html`<${TicketModal}
        ticketId=${openTicket}
        meta=${meta}
        ticketIds=${visibleTickets.map((t) => t.id)}
        onNavigate=${(id) => setOpenTicket(id)}
        onClose=${() => setOpenTicket(null)}
        onTicketUpdated=${() => { loadDetail(); loadProblems(); }}
        onDeleted=${() => { setOpenTicket(null); loadDetail(); loadProblems(); }}
        onSaved=${onTicketSaved}
      />`}
      ${mergeOpen && html`<${MergeProblemsModal}
        problems=${problems}
        initialSourceId=${selected}
        onClose=${() => setMergeOpen(false)}
        onDone=${onMergeDone}
      />`}
    </div>
  `;
}

// ------------------------------------------------------------- MontageTab ----

function MontageTab({ meta, refreshTick }) {
  const [preset, setPreset] = useState("30d");
  const [start, setStart] = useState(todayISO(-29));
  const [end, setEnd] = useState(todayISO());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [openTicket, setOpenTicket] = useState(null);
  const [ticketNavList, setTicketNavList] = useState([]);

  const applyPreset = (p) => {
    setPreset(p);
    if (p === "7d") { setStart(todayISO(-6)); setEnd(todayISO()); }
    else if (p === "30d") { setStart(todayISO(-29)); setEnd(todayISO()); }
    else if (p === "all" && data?.data_range) {
      setStart(data.data_range.start);
      setEnd(data.data_range.end);
    }
  };

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    apiGet(`/api/report/weekly?start=${start}&end=${end}`)
      .then((d) => setData(d))
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [start, end]);

  useEffect(() => { load(); }, [load, refreshTick]);

  useEffect(() => {
    if (preset !== "all" || !data?.data_range) return;
    const { start: s, end: e } = data.data_range;
    if (start !== s || end !== e) {
      setStart(s);
      setEnd(e);
    }
  }, [preset, data]);

  const rows = data?.montage_tickets || [];

  return html`
    <div class="montage-tab">
      <div class="pill-row">
        ${[["7d", "7 дней"], ["30d", "30 дней"], ["all", "Всё время"], ["custom", "Свой период"]].map(([p, l]) => html`
          <div key=${p} class=${"pill" + (preset === p ? " active" : "")}
               onClick=${() => {
                 if (p === "all") {
                   setPreset("all");
                   if (data?.data_range) {
                     setStart(data.data_range.start);
                     setEnd(data.data_range.end);
                   } else {
                     setStart("2024-01-01");
                     setEnd(todayISO());
                   }
                 } else if (p === "custom") setPreset("custom");
                 else applyPreset(p);
               }}>${l}</div>
        `)}
        <input type="date" value=${start} onChange=${(e) => { setStart(e.target.value); setPreset("custom"); }} />
        <span class="muted">—</span>
        <input type="date" value=${end} onChange=${(e) => { setEnd(e.target.value); setPreset("custom"); }} />
        <button class="btn secondary" onClick=${load} disabled=${loading}>${loading ? "Загрузка…" : "Применить"}</button>
      </div>

      <div class="charts-summary">
        <span>Заявки монтажа/ПНР в даунтайме: <strong>${rows.length}</strong></span>
        ${data && html`<span class="muted">всего даунтайм-заявок за период: ${data.downtime_ticket_count}</span>`}
        <span class="muted">отбор: правила простоя отчёта F-4 + ключевые слова в тексте (монтаж, ПНР, …)</span>
      </div>

      ${err && html`<div class="error-banner">${err}</div>`}

      ${loading && !data && html`<div class="muted">Загрузка…</div>`}

      ${data && html`
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Код</th>
                <th>Комплексы</th>
                <th>Заголовок</th>
                <th>Вид работ</th>
                <th>Влияние</th>
                <th>Простой, ч</th>
                <th>Начало работ</th>
                <th>Создана</th>
              </tr>
            </thead>
            <tbody>
              ${rows.length === 0 && html`
                <tr><td colspan="8" class="muted">Нет заявок монтажа/ПНР с даунтаймом в периоде</td></tr>
              `}
              ${rows.map((t) => html`
                <tr key=${t.id} class="row-clickable"
                    onClick=${() => {
                      setTicketNavList(rows.map((x) => x.id));
                      setOpenTicket(t.id);
                    }}>
                  <td class="charts-drill-code">${t.code}</td>
                  <td>${(t.complexes || []).join(", ") || "—"}</td>
                  <td style=${{ whiteSpace: "normal", maxWidth: "280px" }}>${t.title || "—"}</td>
                  <td>${t.workType || "—"}</td>
                  <td>${t.severity || "—"}</td>
                  <td>${t.downtime_hours != null ? t.downtime_hours : "—"}</td>
                  <td>${fmtDt(t.workStartedAt)}</td>
                  <td>${fmtDt(t.createdAt)}</td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
      `}

      ${openTicket && html`<${TicketModal}
        ticketId=${openTicket}
        meta=${meta}
        ticketIds=${ticketNavList}
        onNavigate=${(id) => setOpenTicket(id)}
        onClose=${() => setOpenTicket(null)}
        onDeleted=${() => { setOpenTicket(null); load(); }}
        onSaved=${() => { setOpenTicket(null); load(); }}
      />`}
    </div>
  `;
}

// -------------------------------------------------------- WeeklyChartsBlock ----

function formatWeekAxisLabel(week) {
  if (!week?.start || !week?.end) return week?.label || "—";
  const short = (iso) => {
    const parts = String(iso).split("-");
    if (parts.length < 3) return iso;
    return `${parts[2]}.${parts[1]}`;
  };
  return `${short(week.start)}–${short(week.end)}`;
}

function formatWeekPanelTitle(week) {
  if (!week?.start || !week?.end) return week?.label || "—";
  return `${formatDayLabel(week.start)} — ${formatDayLabel(week.end)}`;
}

function WeeklyChartsBlock({ start, end, refreshTick, active, meta }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [selectedCx, setSelectedCx] = useState(""); // "" = all multi-line
  const [weekPanel, setWeekPanel] = useState(null); // { weekIndex, week }
  const [openTicket, setOpenTicket] = useState(null);
  const [ticketNavList, setTicketNavList] = useState([]);
  const [excludedIds, setExcludedIds] = useState(() => new Set());
  const [excludedMeta, setExcludedMeta] = useState({});
  const [panelSort, setPanelSort] = useState("hours_desc"); // title_asc|title_desc|hours_asc|hours_desc|code
  const [panelFilter, setPanelFilter] = useState("");
  const [panelCxFilter, setPanelCxFilter] = useState(""); // "" = all
  const [excludedOpen, setExcludedOpen] = useState(false);
  const [hideSwUpdates, setHideSwUpdates] = useState(false);

  const fleetCanvasRef = useRef(null);
  const fleetChartRef = useRef(null);
  const cxCanvasRef = useRef(null);
  const cxChartRef = useRef(null);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    apiGet(`/api/report/weekly?start=${start}&end=${end}`)
      .then(setData)
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [start, end]);

  useEffect(() => { load(); }, [load, refreshTick]);

  const weeks = data?.weeks || [];
  const weekLabels = useMemo(() => weeks.map(formatWeekAxisLabel), [weeks]);
  const weekIds = useMemo(() => weeks.map((w) => w.id), [weeks]);
  const nActive = data?.fleet?.n_active || [];
  const fundHours = data?.fleet?.fund_hours || [];

  const cxColorIndex = useMemo(() => {
    const map = {};
    (data?.complexes || []).forEach((c, i) => { map[c.complex] = i; });
    return map;
  }, [data]);

  const isOutOfCalc = useCallback((t) => {
    if (!t) return true;
    if (excludedIds.has(t.id)) return true;
    if (hideSwUpdates && t.is_sw_update) return true;
    return false;
  }, [excludedIds, hideSwUpdates]);

  const swTicketCount = useMemo(() => {
    if (!data?.week_tickets) return 0;
    const seen = new Set();
    for (const list of Object.values(data.week_tickets)) {
      for (const t of list || []) {
        if (t.is_sw_update) seen.add(t.id);
      }
    }
    return seen.size;
  }, [data]);

  const openWeekAt = useCallback((weekIndex) => {
    if (!data?.weeks?.[weekIndex]) return;
    setWeekPanel({ weekIndex, week: data.weeks[weekIndex] });
    setPanelFilter("");
    setPanelCxFilter("");
  }, [data]);

  const excludeTicket = (t) => {
    setExcludedIds((s) => new Set([...s, t.id]));
    setExcludedMeta((m) => ({
      ...m,
      [t.id]: {
        id: t.id,
        code: t.code,
        title: t.title,
        complexes: t.complexes || [],
        downtime_hours: t.week_hours ?? t.downtime_hours,
      },
    }));
    setExcludedOpen(true);
  };

  const restoreTicket = (id) => {
    setExcludedIds((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    setExcludedMeta((m) => {
      const n = { ...m };
      delete n[id];
      return n;
    });
  };

  // Recalculate series after excludes (using clipped week_hours from API)
  const computed = useMemo(() => {
    if (!data) return null;
    const n = weeks.length;
    const cxList = data.complexes || [];
    const hoursByCx = {};
    for (const c of cxList) hoursByCx[c.complex] = Array(n).fill(0);
    const hoursTotal = Array(n).fill(0);

    for (let i = 0; i < n; i++) {
      const wid = weekIds[i];
      const tickets = (data.week_tickets && data.week_tickets[wid]) || [];
      for (const t of tickets) {
        if (excludedIds.has(t.id)) continue;
        if (hideSwUpdates && t.is_sw_update) continue;
        const hbc = t.hours_by_complex || {};
        let added = 0;
        for (const [cx, hrs] of Object.entries(hbc)) {
          if (!hoursByCx[cx]) hoursByCx[cx] = Array(n).fill(0);
          hoursByCx[cx][i] += hrs || 0;
          added += hrs || 0;
        }
        if (!Object.keys(hbc).length) {
          // fallback: full week_hours / downtime
          const wh = t.week_hours ?? t.downtime_hours ?? 0;
          hoursTotal[i] += wh;
        } else {
          hoursTotal[i] += added;
        }
      }
    }

    const hoursPerActive = hoursTotal.map((h, i) => {
      const na = nActive[i] || 0;
      return na ? Math.round((h / na) * 1000) / 1000 : 0;
    });
    const hoursTotalR = hoursTotal.map((h) => Math.round(h * 100) / 100);
    const complexes = cxList.map((c) => ({
      ...c,
      hours: (hoursByCx[c.complex] || Array(n).fill(0)).map((h) => Math.round(h * 100) / 100),
    }));
    return { hoursTotal: hoursTotalR, hoursPerActive, complexes };
  }, [data, weeks, weekIds, nActive, excludedIds, hideSwUpdates]);

  // Fleet chart
  useEffect(() => {
    if (!active || !fleetCanvasRef.current || !data || !computed) return;
    if (fleetChartRef.current) {
      fleetChartRef.current.destroy();
      fleetChartRef.current = null;
    }
    const chart = new Chart(fleetCanvasRef.current, {
      type: "bar",
      data: {
        labels: weekLabels,
        datasets: [{
          label: "Простой / действующий комплекс, ч",
          data: computed.hoursPerActive,
          backgroundColor: "hsla(210, 72%, 58%, 0.75)",
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { color: "#e6e8ee" } },
          title: {
            display: true,
            text: "Суммарный простой в расчёте на действующий комплекс (без монтажа/ПНР)",
            color: "#9aa1b2",
            font: { size: 13 },
          },
          tooltip: {
            enabled: true,
            position: "cursorRight",
            xAlign: "left",
            yAlign: "center",
            caretPadding: 14,
            padding: 10,
            callbacks: {
              title(items) {
                const i = items[0]?.dataIndex;
                if (i == null || !weeks[i]) return "";
                return formatWeekPanelTitle(weeks[i]);
              },
              afterBody(items) {
                const i = items[0]?.dataIndex;
                if (i == null) return [];
                return [
                  `Сумма простоя: ${computed.hoursTotal[i] ?? 0} ч`,
                  `Действующих комплексов: ${nActive[i] ?? 0}`,
                  `Фонд недели: ${fundHours[i] ?? 0} ч`,
                  "Клик — срез заявок за неделю",
                ];
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { color: "#9aa1b2", maxRotation: 50, minRotation: 30, autoSkip: true, maxTicksLimit: 16 },
            grid: { color: "#2a2f3d" },
          },
          y: {
            beginAtZero: true,
            ticks: { color: "#9aa1b2" },
            grid: { color: "#2a2f3d" },
            title: { display: true, text: "Ч / комплекс", color: "#9aa1b2" },
          },
        },
        onClick: (_evt, elements) => {
          if (!elements.length) return;
          openWeekAt(elements[0].index);
        },
      },
    });
    fleetChartRef.current = chart;
    return () => {
      chart.destroy();
      fleetChartRef.current = null;
    };
  }, [data, active, weekLabels, weeks, computed, nActive, fundHours, openWeekAt]);

  // Per-complex chart
  useEffect(() => {
    if (!active || !cxCanvasRef.current || !data || !computed) return;
    if (cxChartRef.current) {
      cxChartRef.current.destroy();
      cxChartRef.current = null;
    }
    const list = computed.complexes || [];
    const filtered = selectedCx
      ? list.filter((c) => c.complex === selectedCx)
      : list;
    const datasets = filtered.map((c, i) => {
      const idx = list.findIndex((x) => x.complex === c.complex);
      return {
        label: c.complex,
        data: c.hours || [],
        borderColor: complexColor(idx >= 0 ? idx : i, 1),
        backgroundColor: complexColor(idx >= 0 ? idx : i, 0.15),
        fill: false,
        tension: 0.2,
        borderWidth: 2,
        pointRadius: weekLabels.length > 40 ? 0 : 3,
      };
    });
    const chart = new Chart(cxCanvasRef.current, {
      type: "line",
      data: { labels: weekLabels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { color: "#e6e8ee", boxWidth: 12 } },
          title: {
            display: true,
            text: selectedCx
              ? `Простой ${selectedCx} по неделям, ч (обрезка по графику работы)`
              : "Простой по комплексам, ч / неделя",
            color: "#9aa1b2",
            font: { size: 13 },
          },
          tooltip: {
            enabled: true,
            position: "cursorRight",
            xAlign: "left",
            yAlign: "center",
            caretPadding: 14,
            padding: 8,
            filter(item) {
              const v = item.parsed?.y;
              return v != null && v > 0;
            },
            itemSort(a, b) {
              return (b.parsed?.y || 0) - (a.parsed?.y || 0);
            },
            callbacks: {
              title(items) {
                const i = items[0]?.dataIndex;
                if (i == null || !weeks[i]) return "";
                return formatWeekPanelTitle(weeks[i]);
              },
              afterBody() {
                return ["Клик — срез заявок за неделю"];
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { color: "#9aa1b2", maxRotation: 50, minRotation: 30, autoSkip: true, maxTicksLimit: 16 },
            grid: { color: "#2a2f3d" },
          },
          y: {
            beginAtZero: true,
            ticks: { color: "#9aa1b2" },
            grid: { color: "#2a2f3d" },
            title: { display: true, text: "Часы", color: "#9aa1b2" },
          },
        },
        onClick: (_evt, elements) => {
          if (!elements.length) return;
          openWeekAt(elements[0].index);
        },
      },
    });
    cxChartRef.current = chart;
    return () => {
      chart.destroy();
      cxChartRef.current = null;
    };
  }, [data, active, weekLabels, weeks, selectedCx, computed, openWeekAt]);

  const panelTicketsRaw = useMemo(() => {
    if (!weekPanel || !data) return [];
    const wid = weekPanel.week.id;
    return (data.week_tickets && data.week_tickets[wid]) || [];
  }, [weekPanel, data]);

  const panelCxOptions = useMemo(() => {
    const set = new Set();
    for (const t of panelTicketsRaw) {
      for (const cx of (t.complexes || [])) set.add(cx);
    }
    return [...set].sort((a, b) => {
      try { return a.split(".").map(Number).join(".").localeCompare(b.split(".").map(Number).join("."), undefined, { numeric: true }); }
      catch { return a.localeCompare(b); }
    });
  }, [panelTicketsRaw]);

  const panelGroups = useMemo(() => {
    const q = panelFilter.trim().toLowerCase();
    let list = panelTicketsRaw.filter((t) => {
      if (panelCxFilter && !(t.complexes || []).includes(panelCxFilter)) return false;
      if (!q) return true;
      const blob = `${t.code || ""} ${t.title || ""} ${(t.complexes || []).join(" ")}`.toLowerCase();
      return blob.includes(q);
    });
    const hoursOf = (t) => t.week_hours ?? t.downtime_hours ?? 0;
    list = [...list].sort((a, b) => {
      if (panelSort === "title_asc") return (a.title || "").localeCompare(b.title || "", "ru");
      if (panelSort === "title_desc") return (b.title || "").localeCompare(a.title || "", "ru");
      if (panelSort === "hours_asc") return hoursOf(a) - hoursOf(b);
      if (panelSort === "hours_desc") return hoursOf(b) - hoursOf(a);
      return String(a.code || "").localeCompare(String(b.code || ""), "ru");
    });

    const byCx = new Map();
    for (const t of list) {
      const cxs = (t.complexes || []).length ? t.complexes : ["—"];
      for (const cx of cxs) {
        if (panelCxFilter && cx !== panelCxFilter) continue;
        if (!byCx.has(cx)) byCx.set(cx, []);
        // avoid duplicating same ticket under same complex
        if (!byCx.get(cx).some((x) => x.id === t.id)) byCx.get(cx).push(t);
      }
    }
    const groups = [...byCx.entries()].map(([cx, tickets]) => ({
      cx,
      tickets,
      activeCount: tickets.filter((t) => !isOutOfCalc(t)).length,
      hours: tickets.reduce((s, t) => {
        if (isOutOfCalc(t)) return s;
        const hbc = t.hours_by_complex || {};
        if (hbc[cx] != null) return s + hbc[cx];
        return s + (t.week_hours ?? t.downtime_hours ?? 0);
      }, 0),
    }));
    groups.sort((a, b) => b.hours - a.hours || a.cx.localeCompare(b.cx, undefined, { numeric: true }));
    return groups;
  }, [panelTicketsRaw, panelFilter, panelCxFilter, panelSort, isOutOfCalc]);

  const panelActiveCount = useMemo(
    () => panelTicketsRaw.filter((t) => !isOutOfCalc(t)).length,
    [panelTicketsRaw, isOutOfCalc]
  );

  const panelSwCount = useMemo(
    () => panelTicketsRaw.filter((t) => t.is_sw_update).length,
    [panelTicketsRaw]
  );

  const excludedList = useMemo(() => {
    return [...excludedIds].map((id) => excludedMeta[id] || { id, code: id }).filter(Boolean);
  }, [excludedIds, excludedMeta]);

  const openTicketFromPanel = (tickets, id) => {
    setTicketNavList(tickets.map((x) => x.id));
    setOpenTicket(id);
  };

  return html`
    <div class="weekly-charts">
      ${err && html`<div class="error-banner">${err}</div>`}
      ${loading && !data && html`<div class="muted">Загрузка недельных данных…</div>`}
      ${data && computed && html`
        <div class="charts-summary">
          <span>Недель: <strong>${weeks.length}</strong></span>
          <span>Комплексов: <strong>${computed.complexes.length}</strong></span>
          <span class="muted">монтаж/ПНР исключён: ${data.excluded_montage_count}</span>
          <span class="muted">даунтайм-заявок: ${data.downtime_ticket_count}</span>
          <button type="button"
                  class=${"pill" + (hideSwUpdates ? " active" : "")}
                  title="Исключить из недельного расчёта все заявки с флагом обновления ПО"
                  onClick=${() => setHideSwUpdates((v) => !v)}>
            ${hideSwUpdates
              ? `Вернуть обновления ПО (${swTicketCount})`
              : `Без обновлений ПО (${swTicketCount})`}
          </button>
          ${excludedIds.size > 0 && html`
            <button type="button" class="linkish"
                    onClick=${() => setExcludedOpen(true)}>исключено вручную: ${excludedIds.size}</button>
          `}
          <span class="muted">Y флота = сумма / N · клик по неделе — срез заявок</span>
        </div>

        <div class="charts-canvas-wrap">
          <canvas ref=${fleetCanvasRef}></canvas>
        </div>

        <div class="charts-filter-block" style=${{ marginTop: "14px" }}>
          <div class="charts-filter-head">
            <strong>По комплексам</strong>
            <select class="charts-view-select" value=${selectedCx}
                    onChange=${(e) => setSelectedCx(e.target.value)}>
              <option value="">Все комплексы</option>
              ${computed.complexes.map((c) => html`
                <option key=${c.complex} value=${c.complex}>
                  ${c.complex}${c.install_at ? ` (с ${formatDayLabel(c.install_at.slice(0, 10))})` : ""}
                </option>
              `)}
            </select>
          </div>
          <div class="charts-canvas-wrap" style=${{ height: "360px" }}>
            <canvas ref=${cxCanvasRef}></canvas>
          </div>
        </div>

        ${weekPanel && html`
          <div class="charts-day-panel weekly-week-panel">
            <div class="charts-drill-head">
              <strong>${formatWeekPanelTitle(weekPanel.week)}</strong>
              <span class="muted">${panelActiveCount} из ${panelTicketsRaw.length} заявок · ${panelGroups.length} комплексов</span>
              ${panelSwCount > 0 && html`
                <button type="button" class=${"pill" + (hideSwUpdates ? " active" : "")}
                        style=${{ padding: "2px 8px", fontSize: "11px" }}
                        onClick=${() => setHideSwUpdates((v) => !v)}>
                  ${hideSwUpdates ? `ПО: вернуть (${panelSwCount})` : `ПО: убрать (${panelSwCount})`}
                </button>
              `}
              <button class="btn secondary" style=${{ padding: "2px 8px", marginLeft: "auto" }}
                      onClick=${() => setWeekPanel(null)}>Закрыть</button>
            </div>

            <div class="weekly-panel-controls">
              <input type="search" class="weekly-panel-search" placeholder="Фильтр: код, название, комплекс…"
                     value=${panelFilter} onInput=${(e) => setPanelFilter(e.target.value)} />
              <select class="charts-view-select" value=${panelCxFilter}
                      onChange=${(e) => setPanelCxFilter(e.target.value)}>
                <option value="">Все комплексы</option>
                ${panelCxOptions.map((cx) => html`<option key=${cx} value=${cx}>${cx}</option>`)}
              </select>
              <select class="charts-view-select" value=${panelSort}
                      onChange=${(e) => setPanelSort(e.target.value)}>
                <option value="hours_desc">Сорт.: простой ↓</option>
                <option value="hours_asc">Сорт.: простой ↑</option>
                <option value="title_asc">Сорт.: название А→Я</option>
                <option value="title_desc">Сорт.: название Я→А</option>
                <option value="code">Сорт.: код</option>
              </select>
            </div>

            <div class="charts-drill-list weekly-panel-groups">
              ${panelGroups.length === 0
                ? html`<div class="muted">Нет заявок по фильтру</div>`
                : panelGroups.map((g) => {
                  const cidx = cxColorIndex[g.cx] ?? 0;
                  const lineColor = complexColor(cidx, 1);
                  const tintBg = complexColor(cidx, 0.28);
                  const headBg = complexColor(cidx, 0.42);
                  return html`
                  <div key=${g.cx} class="weekly-cx-group"
                       style=${{ "--cx-line": lineColor, background: tintBg, borderLeftColor: lineColor }}>
                    <div class="weekly-cx-group-head" style=${{ background: headBg }}>
                      <span class="weekly-cx-swatch" style=${{ background: lineColor }}></span>
                      <strong>${g.cx}</strong>
                      <span class="muted">${g.activeCount}/${g.tickets.length} в расчёте · ${g.hours.toFixed(2)} ч</span>
                    </div>
                    ${g.tickets.map((p) => {
                      const manualEx = excludedIds.has(p.id);
                      const swEx = hideSwUpdates && p.is_sw_update;
                      const isEx = manualEx || swEx;
                      const hrs = (p.hours_by_complex && p.hours_by_complex[g.cx] != null)
                        ? p.hours_by_complex[g.cx]
                        : (p.week_hours ?? p.downtime_hours);
                      return html`
                        <div key=${p.id + "-" + g.cx}
                             class=${"charts-drill-item charts-drill-item-actions" + (isEx ? " excluded" : "")}>
                          <button type="button" class="linkish charts-drill-code"
                                  onClick=${() => openTicketFromPanel(
                                    panelTicketsRaw.filter((x) => !isOutOfCalc(x) || x.id === p.id),
                                    p.id
                                  )}>${p.code}</button>
                          <button type="button" class="linkish charts-drill-title"
                                  onClick=${() => openTicketFromPanel(
                                    panelTicketsRaw.filter((x) => !isOutOfCalc(x) || x.id === p.id),
                                    p.id
                                  )}>${p.title || "—"}</button>
                          <span class="muted">простой ${hrs != null ? hrs : "—"} ч${p.is_sw_update ? " · ПО" : ""}</span>
                          ${manualEx
                            ? html`<button class="btn secondary" style=${{ padding: "2px 8px", fontSize: "11px" }}
                                           onClick=${() => restoreTicket(p.id)}>Вернуть</button>`
                            : swEx
                              ? html`<span class="muted" style=${{ fontSize: "11px" }}>пресет ПО</span>`
                              : html`<button class="btn secondary" style=${{ padding: "2px 8px", fontSize: "11px" }}
                                           onClick=${() => excludeTicket(p)}>Исключить</button>`}
                        </div>
                      `;
                    })}
                  </div>
                `;
                })}
            </div>
          </div>
        `}

        <div class="charts-filter-block charts-excluded-panel" style=${{ marginTop: "12px" }}>
          <div class="charts-filter-head">
            <strong>Исключённые из недельного расчёта (${excludedList.length})</strong>
            <button class="btn secondary" style=${{ padding: "2px 8px", fontSize: "11px" }}
                    onClick=${() => setExcludedOpen((v) => !v)}>
              ${excludedOpen ? "Свернуть" : "Развернуть"}
            </button>
            ${excludedList.length > 0 && html`
              <button class="btn secondary" style=${{ padding: "2px 8px", fontSize: "11px" }}
                      onClick=${() => { setExcludedIds(new Set()); setExcludedMeta({}); }}>
                Вернуть все
              </button>
            `}
          </div>
          ${excludedOpen && html`
            <div class="charts-excluded-list">
              ${excludedList.length === 0
                ? html`<div class="muted">Нет исключённых — исключите заявку из среза недели</div>`
                : excludedList.map((p) => html`
                  <div key=${p.id} class="charts-excluded-row">
                    <button type="button" class="linkish charts-drill-code"
                            onClick=${() => { setTicketNavList(excludedList.map((x) => x.id)); setOpenTicket(p.id); }}>${p.code}</button>
                    <span class="muted">${(p.complexes || []).join(", ") || "—"}</span>
                    <span class="charts-excluded-title">${p.title || "—"}</span>
                    <button class="btn secondary" style=${{ padding: "2px 8px", fontSize: "11px", marginLeft: "auto" }}
                            onClick=${() => restoreTicket(p.id)}>Вернуть в расчёт</button>
                  </div>
                `)}
            </div>
          `}
        </div>
      `}

      ${openTicket && html`<${TicketModal}
        ticketId=${openTicket}
        meta=${meta}
        ticketIds=${ticketNavList}
        onNavigate=${(id) => setOpenTicket(id)}
        onClose=${() => setOpenTicket(null)}
        onDeleted=${() => { setOpenTicket(null); load(); }}
        onSaved=${() => { setOpenTicket(null); load(); }}
      />`}
    </div>
  `;
}

// -------------------------------------------------------------- ChartsTab ----

const CHART_TYPES = [
  { key: "lines", label: "Линии по дням" },
  { key: "area", label: "Stacked area" },
  { key: "stream", label: "Сглаженный stack" },
  { key: "weeks", label: "Недели" },
  { key: "bars", label: "Столбцы по комплексам" },
  { key: "dual", label: "Простой vs на объекте" },
];

const COMPLEX_HUES = [210, 145, 25, 280, 0, 180, 320, 60, 100, 240, 30, 200, 350, 80, 160, 250];
const CHARTS_VIEWS_KEY = "sd_dashboard_charts_views_v2";
const CHARTS_LS_KEY_LEGACY = "sd_dashboard_charts_settings_v1";

function complexColor(index, alpha = 1) {
  const h = COMPLEX_HUES[index % COMPLEX_HUES.length];
  return `hsla(${h}, 72%, 58%, ${alpha})`;
}

function toggleInSet(set, key) {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function setAllKeys(keys, on) {
  return on ? new Set(keys) : new Set();
}

function newViewId() {
  return `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function emptyViewsLib() {
  return { views: [], activeId: null };
}

function migrateLegacyView() {
  try {
    const raw = localStorage.getItem(CHARTS_LS_KEY_LEGACY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj) return null;
    localStorage.removeItem(CHARTS_LS_KEY_LEGACY);
    return {
      id: newViewId(),
      name: "Сохранённый вид",
      savedAt: obj.savedAt || Date.now(),
      preset: obj.preset || "7d",
      start: obj.start,
      end: obj.end,
      metricDowntime: obj.metricDowntime !== false,
      metricOnsite: !!obj.metricOnsite,
      chartType: obj.chartType || "stream",
      enabledCx: obj.enabledCx || [],
      enabledProblems: obj.enabledProblems || [],
      enabledNodes: obj.enabledNodes || [],
      excludedTickets: obj.excludedTickets || [],
      excludedMeta: obj.excludedMeta || {},
    };
  } catch (e) {
    return null;
  }
}

function loadViewsLibrary() {
  try {
    const raw = localStorage.getItem(CHARTS_VIEWS_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && Array.isArray(obj.views)) return obj;
    }
  } catch (e) { /* ignore */ }
  const legacy = migrateLegacyView();
  if (legacy) {
    const lib = { views: [legacy], activeId: legacy.id };
    persistViewsLibrary(lib);
    return lib;
  }
  return emptyViewsLib();
}

function persistViewsLibrary(lib) {
  localStorage.setItem(CHARTS_VIEWS_KEY, JSON.stringify(lib));
}

function snapshotChartsView(state) {
  return {
    preset: state.preset,
    start: state.start,
    end: state.end,
    metricDowntime: state.metricDowntime,
    metricOnsite: state.metricOnsite,
    chartType: state.chartType,
    enabledCx: [...state.enabledCx],
    enabledProblems: [...state.enabledProblems],
    enabledNodes: [...state.enabledNodes],
    excludedTickets: [...state.excludedTickets],
    excludedMeta: { ...state.excludedMeta },
  };
}

function ticketMetaFromPoint(p) {
  return {
    id: p.id,
    code: p.code,
    title: p.title || "",
    complexes: p.complexes || [],
    day: p.day,
    downtime_hours: p.downtime_hours || 0,
    onsite_hours: p.onsite_hours || 0,
  };
}

/** Линейный тренд по дневным суммам: рост / снижение / стабильно. */
function computeHoursTrend(days, dailyTotals) {
  const pairs = [];
  for (let i = 0; i < days.length; i++) {
    const v = dailyTotals[i] || 0;
    pairs.push({ i, v });
  }
  if (pairs.length < 3) return null;
  const n = pairs.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const p of pairs) {
    sumX += p.i;
    sumY += p.v;
    sumXY += p.i * p.v;
    sumXX += p.i * p.i;
  }
  const den = n * sumXX - sumX * sumX;
  if (!den) return null;
  const slope = (n * sumXY - sumX * sumY) / den; // ч / день индекса
  const mean = sumY / n;
  const half = Math.floor(n / 2) || 1;
  let first = 0;
  let second = 0;
  for (let i = 0; i < half; i++) first += pairs[i].v;
  for (let i = n - half; i < n; i++) second += pairs[i].v;
  first /= half;
  second /= half;
  const delta = second - first;
  const pct = first > 0.05 ? (delta / first) * 100 : (delta === 0 ? 0 : (delta > 0 ? 100 : -100));
  const absSlope = Math.abs(slope);
  let direction = "flat";
  if (absSlope >= 0.05 || Math.abs(pct) >= 8) {
    direction = slope > 0 ? "up" : "down";
  }
  return {
    direction,
    slope: Math.round(slope * 100) / 100,
    pct: Math.round(pct),
    delta: Math.round(delta * 100) / 100,
    mean: Math.round(mean * 100) / 100,
  };
}

function formatTrend(trend, metricLabel) {
  if (!trend) return null;
  if (trend.direction === "flat") {
    return `Тенденция ${metricLabel}: стабильно (~${trend.mean} ч/день)`;
  }
  const arrow = trend.direction === "up" ? "↑ рост" : "↓ снижение";
  const sign = trend.pct > 0 ? "+" : "";
  return `Тенденция ${metricLabel}: ${arrow} ${sign}${trend.pct}% (вторая пол. периода vs первая), ${trend.slope > 0 ? "+" : ""}${trend.slope} ч/день`;
}

/** Свой зум по оси X (категории/дни) — без chartjs-plugin-zoom. */
function getCategoryXRange(chart) {
  const n = (chart.data.labels || []).length;
  if (n <= 0) return null;
  const scale = chart.scales.x;
  let min = scale?.min;
  let max = scale?.max;
  if (min == null || Number.isNaN(min)) min = 0;
  if (max == null || Number.isNaN(max)) max = n - 1;
  min = Math.max(0, Math.min(n - 1, Math.floor(min)));
  max = Math.max(0, Math.min(n - 1, Math.ceil(max)));
  if (max < min) max = min;
  return { min, max, n };
}

function applyCategoryXRange(chart, min, max) {
  const n = (chart.data.labels || []).length;
  if (n <= 0) return;
  let a = Math.max(0, Math.min(n - 1, Math.floor(min)));
  let b = Math.max(0, Math.min(n - 1, Math.ceil(max)));
  if (b - a < 1) b = Math.min(n - 1, a + 1);
  if (!chart.options.scales) chart.options.scales = {};
  if (!chart.options.scales.x) chart.options.scales.x = {};
  chart.options.scales.x.min = a;
  chart.options.scales.x.max = b;
  chart.update("none");
}

function resetCategoryXRange(chart) {
  if (!chart?.options?.scales?.x) return;
  delete chart.options.scales.x.min;
  delete chart.options.scales.x.max;
  chart.update("none");
}

function zoomCategoryXAtEvent(chart, event, zoomIn) {
  const range = getCategoryXRange(chart);
  if (!range) return;
  const { min, max, n } = range;
  const span = max - min;
  if (span < 1 && zoomIn) return;
  const factor = zoomIn ? 0.78 : 1.28;
  let newSpan = Math.max(1, Math.min(n - 1, span * factor));
  if (!zoomIn && newSpan >= n - 1) {
    resetCategoryXRange(chart);
    return;
  }
  const scale = chart.scales.x;
  let focus = 0.5;
  if (scale && scale.width > 0) {
    const rect = chart.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    focus = Math.max(0, Math.min(1, (px - scale.left) / scale.width));
  }
  const center = min + span * focus;
  let newMin = center - newSpan * focus;
  let newMax = newMin + newSpan;
  if (newMin < 0) { newMax -= newMin; newMin = 0; }
  if (newMax > n - 1) { newMin -= (newMax - (n - 1)); newMax = n - 1; }
  applyCategoryXRange(chart, newMin, newMax);
}

if (typeof Chart !== "undefined" && Chart.Tooltip && Chart.Tooltip.positioners) {
  Chart.Tooltip.positioners.cursorRight = function cursorRight(_items, eventPosition) {
    return {
      x: eventPosition.x + 36,
      y: eventPosition.y,
    };
  };
}

/** Вертикальные линии по дням + активный маркер дня под курсором. */
const chartsDayGuidePlugin = {
  id: "chartsDayGuide",
  afterDatasetsDraw(chart) {
    const opts = chart.options?.plugins?.chartsDayGuide;
    if (!opts || opts.enabled === false) return;
    const xScale = chart.scales.x;
    const yScale = chart.scales.y;
    if (!xScale || !yScale) return;
    const labels = chart.data.labels || [];
    const n = labels.length;
    if (!n) return;
    const range = getCategoryXRange(chart);
    if (!range) return;
    const { ctx } = chart;
    const hover = chart.$hoverIndex;

    ctx.save();
    for (let i = range.min; i <= range.max; i++) {
      const x = xScale.getPixelForValue(i);
      if (x < xScale.left - 1 || x > xScale.right + 1) continue;
      ctx.beginPath();
      ctx.strokeStyle = i === hover ? "rgba(120, 180, 255, 0.95)" : "rgba(154, 161, 178, 0.22)";
      ctx.lineWidth = i === hover ? 1.5 : 1;
      if (i === hover) ctx.setLineDash([]);
      else ctx.setLineDash([3, 3]);
      ctx.moveTo(x, yScale.top);
      ctx.lineTo(x, yScale.bottom);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    if (hover != null && hover >= 0 && hover < n) {
      const x = xScale.getPixelForValue(hover);
      for (let di = 0; di < chart.data.datasets.length; di++) {
        const meta = chart.getDatasetMeta(di);
        if (meta.hidden || !meta.data || !meta.data[hover]) continue;
        const pt = meta.data[hover];
        if (pt.skip || pt.y == null) continue;
        const color = chart.data.datasets[di].borderColor
          || chart.data.datasets[di].backgroundColor
          || "#7eb6ff";
        ctx.beginPath();
        ctx.fillStyle = typeof color === "string" ? color : "#7eb6ff";
        ctx.strokeStyle = "#0f1218";
        ctx.lineWidth = 2;
        ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  },
};

if (typeof Chart !== "undefined" && Chart.register) {
  try { Chart.register(chartsDayGuidePlugin); } catch (_) { /* already registered */ }
}

function buildDayStats(points, days, metricDowntime, metricOnsite) {
  const map = {};
  for (const day of days) {
    map[day] = { day, tickets: 0, downtime: 0, onsite: 0, byCx: {} };
  }
  const idsByDay = {};
  for (const p of points) {
    const st = map[p.day];
    if (!st) continue;
    if (!idsByDay[p.day]) idsByDay[p.day] = new Set();
    idsByDay[p.day].add(p.id);
    st.downtime += p.downtime_hours || 0;
    st.onsite += p.onsite_hours || 0;
    for (const cx of (p.complexes || [])) {
      if (!st.byCx[cx]) st.byCx[cx] = { downtime: 0, onsite: 0, tickets: 0 };
      st.byCx[cx].downtime += p.downtime_hours || 0;
      st.byCx[cx].onsite += p.onsite_hours || 0;
      st.byCx[cx].tickets += 1;
    }
  }
  for (const day of days) {
    const st = map[day];
    st.tickets = idsByDay[day] ? idsByDay[day].size : 0;
    st.downtime = Math.round(st.downtime * 100) / 100;
    st.onsite = Math.round(st.onsite * 100) / 100;
    st.total = Math.round(((metricDowntime ? st.downtime : 0) + (metricOnsite ? st.onsite : 0)) * 100) / 100;
    st.topCx = Object.entries(st.byCx)
      .map(([cx, v]) => ({
        cx,
        hours: Math.round(((metricDowntime ? v.downtime : 0) + (metricOnsite ? v.onsite : 0)) * 100) / 100,
        tickets: v.tickets,
      }))
      .sort((a, b) => b.hours - a.hours)
      .slice(0, 5);
  }
  return map;
}

function formatDayLabel(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

/** Фильтры графиков на уровне модуля — не сбрасываются при смене вкладки в сессии. */
const chartsSession = {
  inited: false,
  preset: "7d",
  start: null,
  end: null,
  metricDowntime: true,
  metricOnsite: false,
  chartType: "stream",
  enabledCx: null,
  enabledProblems: null,
  enabledNodes: null,
  excludedTickets: null,
  excludedMeta: null,
  activeViewId: null,
  knownCx: null,
  knownProb: null,
  knownNodes: null,
};

function ChartsTab({ meta, refreshTick, active }) {
  const [viewsLib, setViewsLib] = useState(() => loadViewsLibrary());
  const activeView = useMemo(
    () => (viewsLib.views || []).find((v) => v.id === viewsLib.activeId) || null,
    [viewsLib]
  );
  const bootView = chartsSession.inited ? null : (activeView || null);

  const [preset, setPreset] = useState(
    chartsSession.inited ? chartsSession.preset : (bootView?.preset || "7d")
  );
  const [start, setStart] = useState(
    chartsSession.start || bootView?.start || todayISO(-6)
  );
  const [end, setEnd] = useState(
    chartsSession.end || bootView?.end || todayISO()
  );
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [saveMsg, setSaveMsg] = useState(null);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState("");

  const [metricDowntime, setMetricDowntime] = useState(
    chartsSession.inited ? chartsSession.metricDowntime : (bootView ? bootView.metricDowntime !== false : true)
  );
  const [metricOnsite, setMetricOnsite] = useState(
    chartsSession.inited ? chartsSession.metricOnsite : !!bootView?.metricOnsite
  );
  const [chartType, setChartType] = useState(
    chartsSession.inited ? chartsSession.chartType : (bootView?.chartType || "stream")
  );

  const [enabledCx, setEnabledCx] = useState(() => new Set(
    chartsSession.inited
      ? (chartsSession.enabledCx || [])
      : (bootView?.enabledCx || [])
  ));
  const [enabledProblems, setEnabledProblems] = useState(() => new Set(
    chartsSession.inited
      ? (chartsSession.enabledProblems || [])
      : (bootView?.enabledProblems || [])
  ));
  const [enabledNodes, setEnabledNodes] = useState(() => new Set(
    chartsSession.inited
      ? (chartsSession.enabledNodes || [])
      : (bootView?.enabledNodes || [])
  ));
  const [excludedTickets, setExcludedTickets] = useState(() => new Set(
    chartsSession.inited
      ? (chartsSession.excludedTickets || [])
      : (bootView?.excludedTickets || [])
  ));
  const [excludedMeta, setExcludedMeta] = useState(() => (
    chartsSession.inited
      ? { ...(chartsSession.excludedMeta || {}) }
      : { ...(bootView?.excludedMeta || {}) }
  ));
  const [activeViewId, setActiveViewId] = useState(
    chartsSession.inited ? chartsSession.activeViewId : (viewsLib.activeId || null)
  );
  const [filtersReady, setFiltersReady] = useState(
    !!(chartsSession.inited || (bootView && (bootView.enabledCx || []).length))
  );

  const [dayPanel, setDayPanel] = useState(null);
  const [openTicket, setOpenTicket] = useState(null);
  const [ticketNavList, setTicketNavList] = useState([]);
  const [hoverTip, setHoverTip] = useState(null); // { day, left, top, stats }
  const [excludedOpen, setExcludedOpen] = useState(true);
  const [weeklyNonce, setWeeklyNonce] = useState(0);
  const canvasRef = useRef(null);
  const canvasWrapRef = useRef(null);
  const chartRef = useRef(null);
  const knownCxRef = useRef(chartsSession.knownCx);
  const knownProbRef = useRef(chartsSession.knownProb);
  const knownNodesRef = useRef(chartsSession.knownNodes);
  const excludedTicketsRef = useRef(excludedTickets);
  excludedTicketsRef.current = excludedTickets;
  const panRef = useRef(null);
  const suppressClickRef = useRef(false);
  const dprRef = useRef(typeof window !== "undefined" ? window.devicePixelRatio : 1);
  const dayStatsRef = useRef({});
  const hoverIndexRef = useRef(null);

  useEffect(() => {
    chartsSession.inited = true;
    chartsSession.preset = preset;
    chartsSession.start = start;
    chartsSession.end = end;
    chartsSession.metricDowntime = metricDowntime;
    chartsSession.metricOnsite = metricOnsite;
    chartsSession.chartType = chartType;
    chartsSession.enabledCx = enabledCx;
    chartsSession.enabledProblems = enabledProblems;
    chartsSession.enabledNodes = enabledNodes;
    chartsSession.excludedTickets = excludedTickets;
    chartsSession.excludedMeta = excludedMeta;
    chartsSession.activeViewId = activeViewId;
  }, [preset, start, end, metricDowntime, metricOnsite, chartType, enabledCx, enabledProblems, enabledNodes, excludedTickets, excludedMeta, activeViewId]);

  const applyPreset = (p) => {
    setPreset(p);
    if (p === "7d") { setStart(todayISO(-6)); setEnd(todayISO()); }
    else if (p === "30d") { setStart(todayISO(-29)); setEnd(todayISO()); }
    else if (p === "all" && data?.data_range) {
      setStart(data.data_range.start);
      setEnd(data.data_range.end);
    }
  };

  const applyView = (view) => {
    if (!view) return;
    setActiveViewId(view.id);
    setPreset(view.preset || "custom");
    if (view.start) setStart(view.start);
    if (view.end) setEnd(view.end);
    setMetricDowntime(view.metricDowntime !== false);
    setMetricOnsite(!!view.metricOnsite);
    setChartType(view.chartType || "stream");
    setEnabledCx(new Set(view.enabledCx || []));
    setEnabledProblems(new Set(view.enabledProblems || []));
    setEnabledNodes(new Set(view.enabledNodes || []));
    setExcludedTickets(new Set(view.excludedTickets || []));
    setExcludedMeta({ ...(view.excludedMeta || {}) });
    setFiltersReady(true);
    knownCxRef.current = new Set(view.enabledCx || []);
    knownProbRef.current = new Set(view.enabledProblems || []);
    knownNodesRef.current = new Set(view.enabledNodes || []);
    chartsSession.knownCx = knownCxRef.current;
    chartsSession.knownProb = knownProbRef.current;
    chartsSession.knownNodes = knownNodesRef.current;
    setViewsLib((lib) => {
      const next = { ...lib, activeId: view.id };
      persistViewsLibrary(next);
      return next;
    });
  };

  const currentSnapshot = () => snapshotChartsView({
    preset, start, end, metricDowntime, metricOnsite, chartType,
    enabledCx, enabledProblems, enabledNodes, excludedTickets, excludedMeta,
  });

  const onSaveView = () => {
    if (!activeViewId) {
      setSaveAsName("");
      setSaveAsOpen(true);
      return;
    }
    setViewsLib((lib) => {
      const views = (lib.views || []).map((v) => (
        v.id === activeViewId
          ? { ...v, ...currentSnapshot(), savedAt: Date.now() }
          : v
      ));
      const next = { views, activeId: activeViewId };
      persistViewsLibrary(next);
      return next;
    });
    setSaveMsg("Вид обновлён");
    setTimeout(() => setSaveMsg(null), 2500);
  };

  const onSaveAsConfirm = () => {
    const name = (saveAsName || "").trim();
    if (!name) return;
    const id = newViewId();
    const view = { id, name, savedAt: Date.now(), ...currentSnapshot() };
    setViewsLib((lib) => {
      const next = { views: [...(lib.views || []), view], activeId: id };
      persistViewsLibrary(next);
      return next;
    });
    setActiveViewId(id);
    setSaveAsOpen(false);
    setSaveAsName("");
    setSaveMsg(`Сохранено: ${name}`);
    setTimeout(() => setSaveMsg(null), 2500);
  };

  const onDeleteView = () => {
    if (!activeViewId) return;
    const name = activeView?.name || "";
    if (!confirm(`Удалить вид «${name}»?`)) return;
    setViewsLib((lib) => {
      const views = (lib.views || []).filter((v) => v.id !== activeViewId);
      const next = { views, activeId: null };
      persistViewsLibrary(next);
      return next;
    });
    setActiveViewId(null);
    setSaveMsg("Вид удалён");
    setTimeout(() => setSaveMsg(null), 2500);
  };

  const excludeTicket = (p) => {
    setExcludedTickets((s) => new Set([...s, p.id]));
    setExcludedMeta((m) => ({ ...m, [p.id]: ticketMetaFromPoint(p) }));
    setExcludedOpen(true);
  };

  const restoreTicket = (id) => {
    setExcludedTickets((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    setExcludedMeta((m) => {
      const n = { ...m };
      delete n[id];
      return n;
    });
  };

  const openTicketModal = (points, id) => {
    setTicketNavList((points || []).map((x) => x.id));
    setOpenTicket(id);
  };

  const syncSet = (prev, allKeys, knownRef) => {
    const known = knownRef.current;
    if (!known) {
      knownRef.current = new Set(allKeys);
      if (prev.size === 0) return new Set(allKeys);
      const next = new Set([...prev].filter((k) => allKeys.includes(k)));
      for (const k of allKeys) if (!prev.has(k)) next.add(k);
      return next.size ? next : new Set(allKeys);
    }
    const next = new Set([...prev].filter((k) => allKeys.includes(k)));
    for (const k of allKeys) {
      if (!known.has(k)) next.add(k);
    }
    knownRef.current = new Set(allKeys);
    return next.size ? next : new Set(allKeys);
  };

  const load = useCallback(() => {
    if (chartType === "weeks") {
      setLoading(false);
      setErr(null);
      return;
    }
    setLoading(true);
    setErr(null);
    apiGet(`/api/report/charts?start=${start}&end=${end}`)
      .then((d) => {
        setData(d);
        const cxKeys = d.complexes || [];
        const probKeys = (d.problems || []).map((p) => p.id);
        const nodeKeys = (d.nodes || []).map((n) => n.name);
        setEnabledCx((prev) => {
          const n = syncSet(prev, cxKeys, knownCxRef);
          chartsSession.knownCx = knownCxRef.current;
          return n;
        });
        setEnabledProblems((prev) => {
          const n = syncSet(prev, probKeys, knownProbRef);
          chartsSession.knownProb = knownProbRef.current;
          return n;
        });
        setEnabledNodes((prev) => {
          const n = syncSet(prev, nodeKeys, knownNodesRef);
          chartsSession.knownNodes = knownNodesRef.current;
          return n;
        });
        const exSet = excludedTicketsRef.current;
        setExcludedMeta((m) => {
          const next = { ...m };
          for (const p of (d.points || [])) {
            if (exSet.has(p.id) || next[p.id]) {
              next[p.id] = { ...(next[p.id] || {}), ...ticketMetaFromPoint(p) };
            }
          }
          return next;
        });
        setFiltersReady(true);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [start, end, chartType]);

  useEffect(() => { load(); }, [load, refreshTick]);

  useEffect(() => {
    if (preset !== "all" || !data?.data_range) return;
    const { start: s, end: e } = data.data_range;
    if (start !== s || end !== e) {
      setStart(s);
      setEnd(e);
    }
  }, [preset, data]);

  const filteredPoints = useMemo(() => {
    if (!data) return [];
    return (data.points || []).filter((p) => {
      if (excludedTickets.has(p.id)) return false;
      if (!(p.complexes || []).some((cx) => enabledCx.has(cx))) return false;
      const pid = p.problemId || "";
      if (!enabledProblems.has(pid)) return false;
      const node = p.node || "";
      if (node && !enabledNodes.has(node)) return false;
      return true;
    });
  }, [data, enabledCx, enabledProblems, enabledNodes, excludedTickets]);

  const activeComplexes = useMemo(
    () => (data?.complexes || []).filter((cx) => enabledCx.has(cx)),
    [data, enabledCx]
  );

  const cxIndex = useMemo(() => {
    const m = {};
    (data?.complexes || []).forEach((cx, i) => { m[cx] = i; });
    return m;
  }, [data]);

  const summary = useMemo(() => {
    let downtime = 0;
    let onsite = 0;
    const ids = new Set();
    for (const p of filteredPoints) {
      ids.add(p.id);
      if (metricDowntime) downtime += p.downtime_hours || 0;
      if (metricOnsite) onsite += p.onsite_hours || 0;
    }
    return {
      tickets: ids.size,
      downtime: Math.round(downtime * 100) / 100,
      onsite: Math.round(onsite * 100) / 100,
      excluded: excludedTickets.size,
    };
  }, [filteredPoints, metricDowntime, metricOnsite, excludedTickets]);

  const trendInfo = useMemo(() => {
    if (!data || chartType === "bars" || chartType === "dual") return null;
    const days = data.days || [];
    if (days.length < 3) return null;
    const useKey = metricOnsite && !metricDowntime ? "onsite_hours" : "downtime_hours";
    const metricLabel = useKey === "onsite_hours" ? "на объекте" : "простоя";
    const byDay = {};
    for (const day of days) byDay[day] = 0;
    for (const p of filteredPoints) {
      if (!Object.prototype.hasOwnProperty.call(byDay, p.day)) continue;
      byDay[p.day] += p[useKey] || 0;
    }
    const totals = days.map((d) => byDay[d] || 0);
    return formatTrend(computeHoursTrend(days, totals), metricLabel);
  }, [data, filteredPoints, metricDowntime, metricOnsite, chartType]);

  const excludedList = useMemo(() => {
    const byId = {};
    for (const p of (data?.points || [])) {
      if (excludedTickets.has(p.id)) byId[p.id] = ticketMetaFromPoint(p);
    }
    for (const id of excludedTickets) {
      if (!byId[id] && excludedMeta[id]) byId[id] = excludedMeta[id];
      else if (!byId[id]) byId[id] = { id, code: id, title: "", complexes: [] };
    }
    return Object.values(byId).sort((a, b) => String(a.code).localeCompare(String(b.code), "ru"));
  }, [data, excludedTickets, excludedMeta]);

  const dayStats = useMemo(() => {
    if (!data) return {};
    return buildDayStats(filteredPoints, data.days || [], metricDowntime, metricOnsite);
  }, [data, filteredPoints, metricDowntime, metricOnsite]);
  dayStatsRef.current = dayStats;

  const openDayPanel = useCallback((day) => {
    if (!data || !day) return;
    const pts = (data.points || []).filter((p) => {
      if (p.day !== day) return false;
      const pid = p.problemId || "";
      if (!enabledProblems.has(pid)) return false;
      const node = p.node || "";
      if (node && !enabledNodes.has(node)) return false;
      return true;
    });
    setDayPanel({ day, points: pts });
  }, [data, enabledProblems, enabledNodes]);

  const chartPayload = useMemo(() => {
    if (!data || !filtersReady) return null;
    const days = data.days || [];
    const tooltipOpts = {
      enabled: true,
      position: "cursorRight",
      xAlign: "left",
      yAlign: "center",
      caretPadding: 12,
      padding: 10,
      displayColors: true,
    };

    if (chartType === "dual") {
      const labels = activeComplexes;
      const down = [];
      const onsiteArr = [];
      for (const cx of labels) {
        let dSum = 0;
        let oSum = 0;
        for (const p of filteredPoints) {
          if (!(p.complexes || []).includes(cx)) continue;
          dSum += p.downtime_hours || 0;
          oSum += p.onsite_hours || 0;
        }
        down.push(Math.round(dSum * 100) / 100);
        onsiteArr.push(Math.round(oSum * 100) / 100);
      }
      return {
        type: "bar",
        data: {
          labels,
          datasets: [
            { label: "Простой, ч", data: down, backgroundColor: "hsla(0, 72%, 58%, 0.75)", borderRadius: 4 },
            { label: "На объекте, ч", data: onsiteArr, backgroundColor: "hsla(210, 72%, 58%, 0.75)", borderRadius: 4 },
          ],
        },
        options: {
          indexAxis: "y",
          plugins: {
            legend: { labels: { color: "#e6e8ee" } },
            tooltip: tooltipOpts,
          },
          scales: {
            x: { ticks: { color: "#9aa1b2" }, grid: { color: "#2a2f3d" }, title: { display: true, text: "Часы", color: "#9aa1b2" } },
            y: { ticks: { color: "#9aa1b2" }, grid: { color: "#2a2f3d" } },
          },
        },
      };
    }

    if (chartType === "bars") {
      const label = metricDowntime && !metricOnsite ? "Простой, ч"
        : !metricDowntime && metricOnsite ? "На объекте, ч"
        : "Простой + на объекте, ч";
      const labels = activeComplexes;
      const values = labels.map((cx) => {
        let s = 0;
        for (const p of filteredPoints) {
          if (!(p.complexes || []).includes(cx)) continue;
          if (metricDowntime) s += p.downtime_hours || 0;
          if (metricOnsite) s += p.onsite_hours || 0;
        }
        return Math.round(s * 100) / 100;
      });
      return {
        type: "bar",
        data: {
          labels,
          datasets: [{
            label,
            data: values,
            backgroundColor: labels.map((_, i) => complexColor(cxIndex[labels[i]] ?? i, 0.8)),
            borderRadius: 4,
          }],
        },
        options: {
          indexAxis: "y",
          plugins: {
            legend: { display: false },
            tooltip: tooltipOpts,
          },
          scales: {
            x: { ticks: { color: "#9aa1b2" }, grid: { color: "#2a2f3d" }, title: { display: true, text: "Часы", color: "#9aa1b2" } },
            y: { ticks: { color: "#9aa1b2" }, grid: { color: "#2a2f3d" } },
          },
        },
      };
    }

    const stacked = chartType === "area" || chartType === "stream";
    const smooth = chartType === "stream";
    const useKey = metricOnsite && !metricDowntime ? "onsite_hours" : "downtime_hours";
    const metricLabel = useKey === "onsite_hours" ? "На объекте" : "Простой";
    const datasets = activeComplexes.map((cx) => {
      const byDay = {};
      for (const day of days) byDay[day] = 0;
      for (const p of filteredPoints) {
        if (!(p.complexes || []).includes(cx)) continue;
        if (!Object.prototype.hasOwnProperty.call(byDay, p.day)) continue;
        byDay[p.day] += p[useKey] || 0;
      }
      const idx = cxIndex[cx] ?? 0;
      return {
        label: cx,
        data: days.map((day) => Math.round((byDay[day] || 0) * 100) / 100),
        borderColor: smooth ? complexColor(idx, 0.95) : complexColor(idx, 1),
        backgroundColor: complexColor(idx, smooth ? 0.72 : stacked ? 0.45 : 0.15),
        fill: stacked,
        tension: smooth ? 0.45 : stacked ? 0.2 : 0.25,
        borderWidth: smooth ? 1.5 : 2,
        pointRadius: 0,
        pointHoverRadius: 0,
        pointHitRadius: 18,
      };
    });
    return {
      type: "line",
      data: { labels: days, datasets },
      options: {
        interaction: { mode: "index", intersect: false, axis: "x" },
        hover: { mode: "index", intersect: false, axis: "x" },
        plugins: {
          legend: { labels: { color: "#e6e8ee", boxWidth: 12 } },
          title: {
            display: true,
            text: smooth ? `${metricLabel} — сглаженный stack, ч / день` : `${metricLabel}, ч / день`,
            color: "#9aa1b2",
            font: { size: 13 },
          },
          tooltip: { enabled: false },
          chartsDayGuide: { enabled: true },
        },
        scales: {
          x: {
            stacked,
            ticks: { color: "#9aa1b2", maxRotation: 45, autoSkip: true, maxTicksLimit: 14 },
            grid: { display: false },
          },
          y: {
            stacked,
            beginAtZero: true,
            ticks: { color: "#9aa1b2" },
            grid: { color: "#2a2f3d" },
            title: { display: true, text: "Часы", color: "#9aa1b2" },
          },
        },
      },
    };
  }, [data, filtersReady, chartType, activeComplexes, filteredPoints, metricDowntime, metricOnsite, cxIndex]);

  useEffect(() => {
    if (!active || !canvasRef.current || !chartPayload) return;
    if (chartRef.current) {
      chartRef.current.destroy();
      chartRef.current = null;
    }
    const canZoomAxis = chartType === "lines" || chartType === "area" || chartType === "stream";
    const onClick = (evt, elements, chart) => {
      if (!data) return;
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      let index = elements.length ? elements[0].index : null;
      if (index == null && chart) {
        const pts = chart.getElementsAtEventForMode(evt, "index", { intersect: false }, true);
        if (pts.length) index = pts[0].index;
      }
      if (index == null) return;
      const label = chartPayload.data.labels[index];
      if (chartType === "lines" || chartType === "area" || chartType === "stream") {
        openDayPanel(label);
      } else if (chartType === "bars" || chartType === "dual") {
        const matched = (data.points || []).filter((p) => {
          if (!(p.complexes || []).includes(label)) return false;
          const pid = p.problemId || "";
          if (!enabledProblems.has(pid)) return false;
          const node = p.node || "";
          if (node && !enabledNodes.has(node)) return false;
          return true;
        });
        setDayPanel({ day: null, complex: label, points: matched });
      }
    };
    const chart = new Chart(canvasRef.current, {
      type: chartPayload.type,
      data: chartPayload.data,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        resizeDelay: 0,
        ...chartPayload.options,
        onClick,
      },
    });
    chartRef.current = chart;

    const wrap = canvasWrapRef.current;
    const canvas = canvasRef.current;

    const onWheel = (e) => {
      if (!canZoomAxis || !chartRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      zoomCategoryXAtEvent(chartRef.current, e, e.deltaY < 0);
    };

    const onPointerDown = (e) => {
      if (!canZoomAxis || e.button !== 0 || !chartRef.current) return;
      const range = getCategoryXRange(chartRef.current);
      if (!range) return;
      suppressClickRef.current = false;
      panRef.current = {
        x: e.clientX,
        min: range.min,
        max: range.max,
        moved: false,
      };
      canvas.style.cursor = "grabbing";
      try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    };

    const setHoverFromEvent = (e) => {
      const ch = chartRef.current;
      if (!ch || !canZoomAxis || !wrap) return;
      const xScale = ch.scales.x;
      if (!xScale) return;
      const rect = ch.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      if (px < xScale.left || px > xScale.right) {
        if (hoverIndexRef.current != null) {
          hoverIndexRef.current = null;
          ch.$hoverIndex = null;
          ch.draw();
          setHoverTip(null);
        }
        return;
      }
      let idx = xScale.getValueForPixel(px);
      if (idx == null || Number.isNaN(idx)) return;
      idx = Math.round(idx);
      const labels = ch.data.labels || [];
      if (idx < 0 || idx >= labels.length) return;
      const day = labels[idx];
      const wrapRect = wrap.getBoundingClientRect();
      let left = e.clientX - wrapRect.left + 18;
      let top = e.clientY - wrapRect.top + 14;
      const tipW = 220;
      const tipH = 160;
      if (left + tipW > wrapRect.width - 8) left = Math.max(8, e.clientX - wrapRect.left - tipW - 12);
      if (top + tipH > wrapRect.height - 8) top = Math.max(8, e.clientY - wrapRect.top - tipH - 8);
      const stats = dayStatsRef.current[day] || { day, tickets: 0, downtime: 0, onsite: 0, total: 0, topCx: [] };
      if (hoverIndexRef.current !== idx) {
        hoverIndexRef.current = idx;
        ch.$hoverIndex = idx;
        ch.draw();
      }
      setHoverTip({ day, stats, left, top });
    };

    const clearHover = () => {
      const ch = chartRef.current;
      if (hoverIndexRef.current != null && ch) {
        hoverIndexRef.current = null;
        ch.$hoverIndex = null;
        ch.draw();
      }
      setHoverTip(null);
    };

    const onPointerMove = (e) => {
      const pan = panRef.current;
      const ch = chartRef.current;
      if (pan && ch) {
        const dx = e.clientX - pan.x;
        if (Math.abs(dx) > 3) pan.moved = true;
        if (pan.moved) {
          const scale = ch.scales.x;
          if (scale && scale.width) {
            const span = Math.max(1, pan.max - pan.min);
            const shift = -(dx / scale.width) * span;
            applyCategoryXRange(ch, pan.min + shift, pan.max + shift);
          }
        }
      }
      if (canZoomAxis) setHoverFromEvent(e);
    };
    const onPointerUp = (e) => {
      const pan = panRef.current;
      if (pan?.moved) suppressClickRef.current = true;
      panRef.current = null;
      canvas.style.cursor = canZoomAxis ? "crosshair" : "";
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      if (canZoomAxis) setHoverFromEvent(e);
    };
    const onPointerLeave = () => {
      if (panRef.current) return;
      clearHover();
    };

    const fixResize = () => {
      const ch = chartRef.current;
      if (!ch) return;
      const dpr = window.devicePixelRatio || 1;
      if (Math.abs(dpr - dprRef.current) > 0.01) {
        dprRef.current = dpr;
        ch.options.devicePixelRatio = dpr;
      }
      ch.resize();
    };

    if (wrap) wrap.addEventListener("wheel", onWheel, { passive: false });
    if (canvas) {
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerUp);
      canvas.addEventListener("pointerleave", onPointerLeave);
      if (canZoomAxis) canvas.style.cursor = "crosshair";
    }
    window.addEventListener("resize", fixResize);
    window.visualViewport?.addEventListener("resize", fixResize);
    window.visualViewport?.addEventListener("scroll", fixResize);

    // первичная подгонка после layout
    requestAnimationFrame(fixResize);

    return () => {
      clearHover();
      if (wrap) wrap.removeEventListener("wheel", onWheel);
      if (canvas) {
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointercancel", onPointerUp);
        canvas.removeEventListener("pointerleave", onPointerLeave);
        canvas.style.cursor = "";
      }
      window.removeEventListener("resize", fixResize);
      window.visualViewport?.removeEventListener("resize", fixResize);
      window.visualViewport?.removeEventListener("scroll", fixResize);
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, [chartPayload, active, chartType, data, openDayPanel, enabledProblems, enabledNodes]);

  const resetZoom = () => {
    if (chartRef.current) resetCategoryXRange(chartRef.current);
  };

  const dualDisabled = !(metricDowntime && metricOnsite);
  const canZoom = chartType === "lines" || chartType === "area" || chartType === "stream";

  const dayComplexes = useMemo(() => {
    if (!dayPanel) return [];
    const map = {};
    for (const p of dayPanel.points) {
      if (excludedTickets.has(p.id)) continue;
      for (const cx of (p.complexes || [])) {
        if (!map[cx]) map[cx] = { cx, tickets: 0, downtime: 0, onsite: 0 };
        map[cx].tickets += 1;
        map[cx].downtime += p.downtime_hours || 0;
        map[cx].onsite += p.onsite_hours || 0;
      }
    }
    return Object.values(map).sort((a, b) => a.cx.localeCompare(b.cx, "ru", { numeric: true }));
  }, [dayPanel, excludedTickets]);

  const activeViewName = activeView?.name || "";

  return html`
    <div class="charts-tab">
      <div class="pill-row">
        ${[["7d", "7 дней"], ["30d", "30 дней"], ["all", "Всё время"], ["custom", "Свой период"]].map(([p, l]) => html`
          <div key=${p} class=${"pill" + (preset === p ? " active" : "")}
               onClick=${() => {
                 if (p === "all") {
                   setPreset("all");
                   if (data?.data_range) {
                     setStart(data.data_range.start);
                     setEnd(data.data_range.end);
                   } else {
                     apiGet(`/api/report/weekly?start=2024-01-01&end=${todayISO()}`)
                       .then((d) => {
                         if (d?.data_range) {
                           setStart(d.data_range.start);
                           setEnd(d.data_range.end);
                         } else {
                           setStart("2024-01-01");
                           setEnd(todayISO());
                         }
                       })
                       .catch(() => {
                         setStart("2024-01-01");
                         setEnd(todayISO());
                       });
                   }
                 } else if (p === "custom") setPreset("custom");
                 else applyPreset(p);
               }}>${l}</div>
        `)}
        <input type="date" value=${start} onChange=${(e) => { setStart(e.target.value); setPreset("custom"); }} />
        <span class="muted">—</span>
        <input type="date" value=${end} onChange=${(e) => { setEnd(e.target.value); setPreset("custom"); }} />
        <button class="btn secondary" onClick=${() => {
          if (chartType === "weeks") setWeeklyNonce((n) => n + 1);
          else load();
        }} disabled=${loading}>${loading ? "Загрузка…" : "Применить"}</button>
      </div>

      <div class="pill-row charts-views-row">
        <span class="muted">Вид:</span>
        <select class="charts-view-select"
                value=${activeViewId || ""}
                onChange=${(e) => {
                  const id = e.target.value;
                  if (!id) {
                    setActiveViewId(null);
                    setViewsLib((lib) => {
                      const next = { ...lib, activeId: null };
                      persistViewsLibrary(next);
                      return next;
                    });
                    return;
                  }
                  const view = (viewsLib.views || []).find((v) => v.id === id);
                  if (view) applyView(view);
                }}>
          <option value="">— текущий (не сохранён) —</option>
          ${(viewsLib.views || []).map((v) => html`
            <option key=${v.id} value=${v.id}>${v.name}</option>
          `)}
        </select>
        <button class="btn secondary" onClick=${onSaveView}
                title=${activeViewId ? `Обновить «${activeViewName}»` : "Сначала сохраните как…"}>
          Сохранить
        </button>
        <button class="btn secondary" onClick=${() => { setSaveAsName(activeViewName || ""); setSaveAsOpen(true); }}>
          Сохранить как…
        </button>
        <button class="btn secondary" onClick=${onDeleteView} disabled=${!activeViewId}>Удалить вид</button>
        ${saveMsg && html`<span style=${{ color: "var(--green)", fontSize: "12px" }}>${saveMsg}</span>`}
      </div>

      ${saveAsOpen && html`
        <div class="charts-save-as">
          <input type="text" placeholder="Имя вида" value=${saveAsName}
                 onInput=${(e) => setSaveAsName(e.target.value)}
                 onKeyDown=${(e) => { if (e.key === "Enter") onSaveAsConfirm(); }}
                 autofocus=${true} />
          <button class="btn" onClick=${onSaveAsConfirm} disabled=${!(saveAsName || "").trim()}>Сохранить</button>
          <button class="btn secondary" onClick=${() => setSaveAsOpen(false)}>Отмена</button>
        </div>
      `}

      <div class="pill-row">
        ${chartType !== "weeks" && html`
          <label class="charts-metric">
            <input type="checkbox" checked=${metricDowntime}
                   onChange=${(e) => {
                     const on = e.target.checked;
                     if (!on && !metricOnsite) return;
                     setMetricDowntime(on);
                   }} />
            Простой
          </label>
          <label class="charts-metric">
            <input type="checkbox" checked=${metricOnsite}
                   onChange=${(e) => {
                     const on = e.target.checked;
                     if (!on && !metricDowntime) return;
                     setMetricOnsite(on);
                   }} />
            На объекте
          </label>
          <span class="muted">|</span>
        `}
        ${CHART_TYPES.map((ct) => html`
          <div key=${ct.key}
               class=${"pill" + (chartType === ct.key ? " active" : "") + (ct.key === "dual" && dualDisabled ? " disabled" : "")}
               title=${ct.key === "dual" && dualDisabled ? "Включите обе метрики" : ""}
               onClick=${() => {
                 if (ct.key === "dual" && dualDisabled) return;
                 setChartType(ct.key);
               }}>${ct.label}</div>
        `)}
        ${canZoom && html`
          <span class="muted">|</span>
          <button class="btn secondary" style=${{ padding: "2px 8px", fontSize: "11px" }}
                  onClick=${resetZoom} title="Колесо мыши — зум, перетаскивание — панорама">
            Сбросить зум
          </button>
        `}
      </div>

      ${err && html`<div class="error-banner">${err}</div>`}

      ${chartType === "weeks" ? html`
        <${WeeklyChartsBlock}
          start=${start}
          end=${end}
          refreshTick=${refreshTick + weeklyNonce}
          active=${active}
          meta=${meta}
        />
      ` : data && html`
        <div class="charts-filters">
          <div class="charts-filter-block">
            <div class="charts-filter-head">
              <strong>Комплексы</strong>
              <button class="btn secondary" style=${{ padding: "2px 8px", fontSize: "11px" }}
                      onClick=${() => setEnabledCx(setAllKeys(data.complexes, true))}>Все</button>
              <button class="btn secondary" style=${{ padding: "2px 8px", fontSize: "11px" }}
                      onClick=${() => setEnabledCx(new Set())}>Сбросить</button>
            </div>
            <div class="pill-row">
              ${(data.complexes || []).map((cx) => html`
                <div key=${cx} class=${"pill" + (enabledCx.has(cx) ? " active" : "")}
                     onClick=${() => setEnabledCx((s) => toggleInSet(s, cx))}
                     title=${(meta.complex_names && meta.complex_names[cx]) || cx}>
                  ${cx}${(data.complex_counts && data.complex_counts[cx]) ? ` (${data.complex_counts[cx]})` : ""}
                </div>
              `)}
            </div>
          </div>
          <div class="charts-filter-block">
            <div class="charts-filter-head">
              <strong>Проблемы</strong>
              <button class="btn secondary" style=${{ padding: "2px 8px", fontSize: "11px" }}
                      onClick=${() => setEnabledProblems(setAllKeys((data.problems || []).map((p) => p.id), true))}>Все</button>
              <button class="btn secondary" style=${{ padding: "2px 8px", fontSize: "11px" }}
                      onClick=${() => setEnabledProblems(new Set())}>Сбросить</button>
            </div>
            <div class="pill-row charts-filter-scroll">
              ${(data.problems || []).map((p) => html`
                <div key=${p.id || "__none__"} class=${"pill" + (enabledProblems.has(p.id) ? " active" : "")}
                     onClick=${() => setEnabledProblems((s) => toggleInSet(s, p.id))}
                     title=${p.title}>
                  ${(p.title || "—").slice(0, 40)}${(p.title || "").length > 40 ? "…" : ""} (${p.count})
                </div>
              `)}
            </div>
          </div>
          <div class="charts-filter-block">
            <div class="charts-filter-head">
              <strong>Узлы</strong>
              <button class="btn secondary" style=${{ padding: "2px 8px", fontSize: "11px" }}
                      onClick=${() => setEnabledNodes(setAllKeys((data.nodes || []).map((n) => n.name), true))}>Все</button>
              <button class="btn secondary" style=${{ padding: "2px 8px", fontSize: "11px" }}
                      onClick=${() => setEnabledNodes(new Set())}>Сбросить</button>
            </div>
            <div class="pill-row charts-filter-scroll">
              ${(data.nodes || []).map((n) => html`
                <div key=${n.name} class=${"pill" + (enabledNodes.has(n.name) ? " active" : "")}
                     onClick=${() => setEnabledNodes((s) => toggleInSet(s, n.name))}>
                  ${n.name} (${n.count})
                </div>
              `)}
            </div>
          </div>
        </div>

        <div class="charts-summary">
          <span>Заявок в расчёте: <strong>${summary.tickets}</strong></span>
          ${metricDowntime && html`<span>Простой: <strong>${summary.downtime} ч</strong></span>`}
          ${metricOnsite && html`<span>На объекте: <strong>${summary.onsite} ч</strong></span>`}
          ${summary.excluded > 0 && html`
            <button type="button" class="linkish charts-excluded-jump"
                    onClick=${() => { setExcludedOpen(true); document.querySelector(".charts-excluded-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }}>
              исключено: ${summary.excluded} — к списку
            </button>
          `}
          ${data.skipped_no_day > 0 && html`<span class="muted">без даты работ: ${data.skipped_no_day}</span>`}
          ${trendInfo && html`
            <span class=${"charts-trend" + (
              trendInfo.includes("рост") ? " up" : trendInfo.includes("снижение") ? " down" : ""
            )}>${trendInfo}</span>
          `}
          <span class="muted">${canZoom ? "колесо — зум · клик по дню — панель" : "клик — панель заявок"}</span>
        </div>

        <div class="charts-canvas-wrap" ref=${canvasWrapRef}>
          <canvas ref=${canvasRef}></canvas>
          ${hoverTip && html`
            <div class="charts-day-tip" style=${{ left: `${hoverTip.left}px`, top: `${hoverTip.top}px` }}>
              <div class="charts-day-tip-date">${formatDayLabel(hoverTip.day)}</div>
              <div class="charts-day-tip-row">
                <span>Заявок</span><strong>${hoverTip.stats.tickets}</strong>
              </div>
              ${metricDowntime && html`
                <div class="charts-day-tip-row">
                  <span>Простой</span><strong>${hoverTip.stats.downtime} ч</strong>
                </div>
              `}
              ${metricOnsite && html`
                <div class="charts-day-tip-row">
                  <span>На объекте</span><strong>${hoverTip.stats.onsite} ч</strong>
                </div>
              `}
              ${(hoverTip.stats.topCx || []).length > 0 && html`
                <div class="charts-day-tip-cx">
                  ${(hoverTip.stats.topCx || []).map((row) => html`
                    <div key=${row.cx} class="charts-day-tip-row">
                      <span>${row.cx}</span><strong>${row.hours} ч</strong>
                    </div>
                  `)}
                </div>
              `}
              <div class="charts-day-tip-hint">клик — список заявок</div>
            </div>
          `}
        </div>

        <div class="charts-filter-block charts-excluded-panel">
          <div class="charts-filter-head">
            <strong>Исключённые из расчёта (${excludedList.length})</strong>
            <button class="btn secondary" style=${{ padding: "2px 8px", fontSize: "11px" }}
                    onClick=${() => setExcludedOpen((v) => !v)}>
              ${excludedOpen ? "Свернуть" : "Развернуть"}
            </button>
            ${excludedList.length > 0 && html`
              <button class="btn secondary" style=${{ padding: "2px 8px", fontSize: "11px" }}
                      onClick=${() => { setExcludedTickets(new Set()); setExcludedMeta({}); }}>
                Вернуть все
              </button>
            `}
          </div>
          ${excludedOpen && html`
            <div class="charts-excluded-list charts-excluded-list-lg">
              ${excludedList.length === 0
                ? html`<div class="muted">Нет исключённых заявок — их можно исключить из панели дня</div>`
                : excludedList.map((p) => html`
                  <div key=${p.id} class="charts-excluded-row">
                    <button type="button" class="linkish charts-drill-code"
                            onClick=${() => openTicketModal(excludedList, p.id)}>${p.code}</button>
                    <span class="muted">${(p.complexes || []).join(", ") || "—"}</span>
                    <span class="charts-excluded-title">${p.title || "—"}</span>
                    ${p.day && html`<span class="muted">${formatDayLabel(p.day)}</span>`}
                    <button class="btn secondary" style=${{ padding: "2px 8px", fontSize: "11px", marginLeft: "auto" }}
                            onClick=${() => restoreTicket(p.id)}>Вернуть в расчёт</button>
                  </div>
                `)}
            </div>
          `}
        </div>

        ${dayPanel && html`
          <div class="charts-day-panel">
            <div class="charts-drill-head">
              <strong>${dayPanel.day ? `День ${dayPanel.day}` : `Комплекс ${dayPanel.complex}`}</strong>
              <span class="muted">${dayPanel.points.length} заявок · ${dayComplexes.length} комплексов</span>
              <button class="btn secondary" style=${{ padding: "2px 8px", marginLeft: "auto" }}
                      onClick=${() => setDayPanel(null)}>Закрыть</button>
            </div>

            ${dayPanel.day && html`
              <div class="section-title" style=${{ marginTop: "8px" }}>Комплексы в этот день</div>
              <div class="charts-day-complexes">
                ${dayComplexes.map((row) => html`
                  <div key=${row.cx} class="charts-day-cx-row">
                    <span class=${"pill" + (enabledCx.has(row.cx) ? " active" : "")}
                          onClick=${() => setEnabledCx((s) => toggleInSet(s, row.cx))}>${row.cx}</span>
                    <span class="muted">${row.tickets} заявок · простой ${row.downtime.toFixed(1)} ч · на объекте ${row.onsite.toFixed(1)} ч</span>
                    <button class="btn secondary" style=${{ padding: "2px 8px", fontSize: "11px", marginLeft: "auto" }}
                            onClick=${() => setEnabledCx((s) => { const n = new Set(s); n.delete(row.cx); return n; })}>
                      Исключить комплекс
                    </button>
                  </div>
                `)}
                ${dayComplexes.length === 0 && html`<div class="muted">Нет комплексов</div>`}
              </div>
            `}

            <div class="section-title">Заявки</div>
            <div class="charts-drill-list">
              ${dayPanel.points.length === 0
                ? html`<div class="muted">Нет заявок</div>`
                : dayPanel.points.map((p) => {
                  const isEx = excludedTickets.has(p.id);
                  return html`
                    <div key=${p.id} class=${"charts-drill-item charts-drill-item-actions" + (isEx ? " excluded" : "")}>
                      <button type="button" class="linkish charts-drill-code"
                              onClick=${() => openTicketModal(dayPanel.points, p.id)}>${p.code}</button>
                      <span class="muted">${(p.complexes || []).join(", ")}</span>
                      <button type="button" class="linkish charts-drill-title"
                              onClick=${() => openTicketModal(dayPanel.points, p.id)}>${p.title || "—"}</button>
                      <span class="muted">простой ${p.downtime_hours} ч · на объекте ${p.onsite_hours} ч</span>
                      ${isEx
                        ? html`<button class="btn secondary" style=${{ padding: "2px 8px", fontSize: "11px" }}
                                       onClick=${() => restoreTicket(p.id)}>Вернуть</button>`
                        : html`<button class="btn secondary" style=${{ padding: "2px 8px", fontSize: "11px" }}
                                       onClick=${() => excludeTicket(p)}>Исключить</button>`}
                    </div>
                  `;
                })}
            </div>
          </div>
        `}
      `}
      ${loading && !data && html`<div class="muted">Загрузка данных…</div>`}

      ${openTicket && html`<${TicketModal}
        ticketId=${openTicket}
        meta=${meta}
        ticketIds=${ticketNavList}
        onNavigate=${(id) => setOpenTicket(id)}
        onClose=${() => setOpenTicket(null)}
        onDeleted=${() => { setOpenTicket(null); load(); }}
        onSaved=${() => { setOpenTicket(null); load(); }}
      />`}
    </div>
  `;
}

// -------------------------------------------------------------- ReportTab ----

const LAYERS = [
  { key: "all_tickets", label: "Все заявки" },
  { key: "total", label: "Весь даунтайм" },
  { key: "milk", label: "Молочка" },
  { key: "software", label: "Софт" },
  { key: "mechanics", label: "Механика" },
  { key: "other", label: "Прочее" },
  { key: "remote", label: "Удалённо" },
  { key: "sw_update", label: "Обновление ПО" },
];

function HeatmapLegend({ layer }) {
  const isCount = layer === "all_tickets";
  const isSwUpdate = layer === "sw_update";
  const unitLabel = isCount ? "заявок в этот день" : "часов простоя за этот день (по методике влияние+приоритет)";
  const stops = [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1];
  return html`
    <div style=${{ display: "flex", alignItems: "center", gap: "12px", marginTop: "10px", flexWrap: "wrap" }}>
      <span class="muted">Легенда:</span>
      ${isSwUpdate ? html`
        <span style=${{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style=${{ width: "16px", height: "16px", borderRadius: "4px", background: "#a855f7", display: "inline-block" }}></span>
          <span class="muted">было обновление ПО в этот день</span>
        </span>
        <span style=${{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style=${{ width: "16px", height: "16px", borderRadius: "4px", background: "#1e2230", border: "1px solid var(--border)", display: "inline-block" }}></span>
          <span class="muted">не было</span>
        </span>
      ` : html`
        <span style=${{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span class="muted">мало</span>
          <span style=${{ display: "flex" }}>
            ${stops.map((s) => html`<span key=${s} style=${{ width: "20px", height: "16px", background: heatColor(s, 1) }}></span>`)}
          </span>
          <span class="muted">много</span>
        </span>
        <span class="muted">— цвет ячейки относительно суточной нормы комплекса${isCount ? " (условно 6 заявок = максимум шкалы)" : " (график работы комплекса — 8/15/16/24 ч/сутки в зависимости от комплекса)"}</span>
        <span class="muted">· число в ячейке = ${unitLabel}</span>
        <span style=${{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style=${{ width: "16px", height: "16px", borderRadius: "4px", background: "#2a3550", display: "inline-block" }}></span>
          <span class="muted">были заявки, но 0 в этом слое (приглушённое число — сколько их)</span>
        </span>
      `}
      <span style=${{ display: "flex", alignItems: "center", gap: "6px" }}>
        <span style=${{ width: "16px", height: "16px", borderRadius: "4px", border: "2px solid var(--violet)", display: "inline-block" }}></span>
        <span class="muted">фиолетовая рамка — было обновление ПО в этот день (на любом слое)</span>
      </span>
    </div>
  `;
}

function complexLabel(cx, meta) {
  const name = meta && meta.complex_names && meta.complex_names[cx];
  return name ? `${cx} — ${name}` : cx;
}

function ReportTab({ meta, refreshTick }) {
  const [start, setStart] = useState(todayISO(-29));
  const [end, setEnd] = useState(todayISO());
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [layer, setLayer] = useState("total");
  const [selectedDay, setSelectedDay] = useState(null);
  const [selectedComplex, setSelectedComplex] = useState(null);
  const [kindFilter, setKindFilter] = useState("");
  const [impactFilter, setImpactFilter] = useState("");
  const [dayOnlyInvalidDuration, setDayOnlyInvalidDuration] = useState(false);
  const [daySortKey, setDaySortKey] = useState("duration_hours");
  const [daySortDir, setDaySortDir] = useState("desc");
  const [drillTickets, setDrillTickets] = useState(null); // {title, ids}
  const [openTicket, setOpenTicket] = useState(null);
  const [ticketNavList, setTicketNavList] = useState([]);
  const [complexFilter, setComplexFilter] = useState(null); // null = все комплексы, иначе Set(cx) — какие считать

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    apiGet(`/api/report/f4?start=${start}&end=${end}`)
      .then((d) => { setReport(d); setSelectedDay(null); setSelectedComplex(null); setDrillTickets(null); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [start, end]);

  // refreshTick — глобальный "Обновить данные" (TopBar) или успешное обновление
  // cookie сессии; раньше ReportTab на него не реагировал вообще (плитки/теплокарта
  // оставались со старыми данными до ручного повторного "Построить" — жалоба
  // пользователя "плитка не обновляется автоматически"). Сброс selectedDay/
  // selectedComplex/drillTickets внутри load() тут ожидаем: явный "обновить"
  // разумно откатывает к верхнему уровню отчёта, как и смена периода.
  useEffect(() => { load(); }, [load, refreshTick]);

  // Какие комплексы вообще учитывать в отчёте (фильтр "по каким комплексам считать
  // даунтайм") — null означает "все", иначе Set выбранных cx. Влияет на теплокарту,
  // сводку по комплексам, флот в целом и список заявок дня (когда день выбран без
  // конкретного комплекса — агрегация идёт только по видимым комплексам).
  const visibleComplexes = useMemo(() => {
    if (!report) return [];
    const all = report.heatmap.complexes;
    return complexFilter ? all.filter((cx) => complexFilter.has(cx)) : all;
  }, [report, complexFilter]);

  const toggleComplex = (cx) => {
    setComplexFilter((cur) => {
      const all = report ? report.heatmap.complexes : [];
      const base = cur ? new Set(cur) : new Set(all);
      if (base.has(cx)) base.delete(cx); else base.add(cx);
      // если выбрали все обратно — считаем это "без фильтра" (null)
      return base.size === all.length ? null : base;
    });
  };

  const dayTickets = useMemo(() => {
    if (!report) return [];
    let ids;
    if (selectedComplex && selectedDay) {
      ids = report.heatmap.cells[selectedComplex]?.[selectedDay]?.ticket_ids || [];
    } else if (selectedDay) {
      ids = new Set();
      for (const cx of visibleComplexes) {
        for (const tid of (report.heatmap.cells[cx]?.[selectedDay]?.ticket_ids || [])) ids.add(tid);
      }
      ids = [...ids];
    } else {
      return [];
    }
    let ts = ids.map((id) => report.tickets[id]).filter(Boolean);
    if (kindFilter) ts = ts.filter((t) => t.kind === kindFilter);
    if (impactFilter) ts = ts.filter((t) => t.severity === impactFilter);
    if (dayOnlyInvalidDuration) ts = ts.filter((t) => t.duration_reason === "invalid_negative");
    ts = [...ts].sort((a, b) => cmpVal(a[daySortKey], b[daySortKey]) * (daySortDir === "asc" ? 1 : -1));
    return ts;
  }, [report, selectedDay, selectedComplex, visibleComplexes, kindFilter, impactFilter, dayOnlyInvalidDuration, daySortKey, daySortDir]);

  const fleetTotals = useMemo(() => {
    if (!report) return null;
    const visible = new Set(visibleComplexes);
    const sums = { total: 0, milk: 0, software: 0, mechanics: 0, other: 0 };
    let fund = 0;
    for (const c of report.complexes_summary) {
      if (!c.fund_hours || !visible.has(c.complex)) continue;
      fund += c.fund_hours;
      for (const k of ["milk", "software", "mechanics", "other"]) sums[k] += c.kind_hours[k] || 0;
      // total — кросс-видовой merge с бэкенда (c.total_hours), НЕ сумма kind —
      // может быть меньше суммы по видам, если несколько видов простаивали одновременно.
      sums.total += c.total_hours || 0;
    }
    const pct = {};
    for (const k of Object.keys(sums)) pct[k] = fund ? Math.round((sums[k] / fund) * 10000) / 100 : 0;
    return { sums, pct, fund };
  }, [report, visibleComplexes]);

  // Группировка карточек по клиенту/сети (Day2Day с Day2Day, Пятёрочка с Пятёрочкой и т.д.),
  // вместо сортировки по % простоя — так проще ориентироваться по объектам одной сети.
  const sortedComplexesSummary = useMemo(() => {
    if (!report) return [];
    const visible = new Set(visibleComplexes);
    const clientKey = (cx) => {
      const label = (meta && meta.complex_names && meta.complex_names[cx]) || "";
      return (label.split(" / ")[0] || label || cx).toLowerCase();
    };
    const numKey = (cx) => {
      const parts = cx.split(".");
      return parts.length > 1 ? parseInt(parts[1], 10) || 0 : 0;
    };
    return report.complexes_summary
      .filter((c) => visible.has(c.complex))
      .sort((a, b) => {
        const ck = clientKey(a.complex).localeCompare(clientKey(b.complex), "ru");
        if (ck !== 0) return ck;
        return numKey(a.complex) - numKey(b.complex);
      });
  }, [report, meta, visibleComplexes]);

  const openDrill = (title, ids) => setDrillTickets({ title, ids });

  if (loading && !report) return html`<div class="muted">Загрузка отчёта…</div>`;

  return html`
    <div>
      <div class="pill-row">
        <span class="muted">Период:</span>
        <input type="date" value=${start} onChange=${(e) => setStart(e.target.value)} />
        <span class="muted">—</span>
        <input type="date" value=${end} onChange=${(e) => setEnd(e.target.value)} />
        <button class="btn secondary" onClick=${load}>Построить</button>
        ${["7d", "30d"].map((p) => html`
          <div key=${p} class="pill" onClick=${() => { const r = periodRange(p); setStart(r.start); setEnd(r.end); }}>${p === "7d" ? "Посл. 7 дней" : "Посл. 30 дней"}</div>
        `)}
      </div>
      ${err && html`<div class="error-banner">${err}</div>`}
      ${!report ? null : html`
        <div class="counters">
          <div class="counter-card"><div class="num">${report.counters.total_f4_tickets}</div><div class="lbl">Всего заявок F-4</div></div>
          <div class="counter-card"><div class="num">${report.counters.stopped}</div><div class="lbl">Остановлен</div></div>
          <div class="counter-card"><div class="num">${report.counters.limited}</div><div class="lbl">Ограничен</div></div>
          <div class="counter-card"><div class="num">${report.counters.in_stop}</div><div class="lbl">В стопе</div></div>
          <div class="counter-card"><div class="num">${report.counters.not_limited}</div><div class="lbl">Не ограничен</div></div>
          <div class="counter-card"><div class="num">${report.counters.remote}</div><div class="lbl">Удалённо</div></div>
          <div class="counter-card"><div class="num">${report.counters.acts}</div><div class="lbl">Актов</div></div>
          <div class="counter-card"><div class="num">${report.counters.no_work_date}</div><div class="lbl">Без даты работ</div></div>
          <div class="counter-card"><div class="num">${report.counters.invalid_duration}</div><div class="lbl">Некорр. время</div></div>
          <div class="counter-card"><div class="num">${report.counters.negative_response}</div><div class="lbl">Начало раньше инцидента</div></div>
        </div>

        <div class="section-title">Теплокарта простоя (дн × комплекс)</div>
        <div class="pill-row">
          ${LAYERS.map((l) => html`
            <div key=${l.key} class=${"pill" + (layer === l.key ? " active" : "")} onClick=${() => setLayer(l.key)}>${l.label}</div>
          `)}
        </div>
        <div class="pill-row">
          <span class="muted">Учитывать комплексы:</span>
          <div class=${"pill" + (!complexFilter ? " active" : "")} onClick=${() => setComplexFilter(null)}>Все</div>
          ${report.heatmap.complexes.map((cx) => html`
            <div key=${cx} class=${"pill" + (!complexFilter || complexFilter.has(cx) ? " active" : "")} onClick=${() => toggleComplex(cx)} title=${complexLabel(cx, meta)}>${cx}</div>
          `)}
        </div>
        <div class="heatmap-wrap">
          <table class="heatmap">
            <thead>
              <tr>
                <th class="complex-name">Комплекс</th>
                ${report.heatmap.days.map((d) => html`
                  <th key=${d} class="day-head" onClick=${() => { setSelectedDay(d); setSelectedComplex(null); }} title=${d}>${fmtDateShort(d)}</th>
                `)}
              </tr>
            </thead>
            <tbody>
              ${visibleComplexes.map((cx) => {
                const cSummary = report.complexes_summary.find((s) => s.complex === cx);
                return html`
                <tr key=${cx}>
                  <td class="complex-name" style=${{ cursor: "pointer" }}
                      title=${`${complexLabel(cx, meta)} — клик: все заявки за период`}
                      onClick=${() => openDrill(`${complexLabel(cx, meta)} · все заявки за период`, (cSummary && cSummary.all_ticket_ids) || [])}>
                    ${complexLabel(cx, meta)}
                  </td>
                  ${report.heatmap.days.map((d) => {
                    const cell = report.heatmap.cells[cx][d];
                    const isCount = layer === "all_tickets";
                    let value = isCount ? (cell.ticket_ids || []).length
                      : layer === "total" ? cell.hours
                      : layer === "remote" ? cell.remote_hours
                      : layer === "sw_update" ? (cell.has_sw_update ? 1 : 0)
                      : (cell.kind_hours[layer] || 0);
                    const maxH = isCount ? 6 : (F4_GRAPH_HOURS[cx] || 16);
                    const hasActivity = (cell.ticket_ids || []).length > 0;
                    const bg = layer === "sw_update" ? (cell.has_sw_update ? "#a855f7" : "#1e2230")
                      : (value <= 0 && hasActivity) ? "#2a3550"
                      : heatColor(value, maxH);
                    const unit = isCount ? "заявок" : "ч";
                    const ticketCount = (cell.ticket_ids || []).length;
                    const tooltip = [
                      `${cx} · ${d}`,
                      `${ticketCount} ${ticketCount === 1 ? "заявка" : "заявок"}`,
                      `всего простой: ${cell.hours.toFixed(2)} ч`,
                      `молочка ${cell.kind_hours.milk}ч · софт ${cell.kind_hours.software}ч · механика ${cell.kind_hours.mechanics}ч · прочее ${cell.kind_hours.other}ч`,
                      `удалённо ${cell.remote_hours}ч`,
                      cell.has_sw_update ? "есть обновление ПО" : null,
                    ].filter(Boolean).join(" · ");
                    const cellText = value > 0
                      ? (isCount || layer === "sw_update" ? String(Math.round(value)) : value.toFixed(2))
                      : (hasActivity ? html`<span style=${{ opacity: 0.55 }}>${ticketCount}</span>` : "");
                    return html`
                      <td key=${d} class="day-cell">
                        <div class=${"heat-cell" + (cell.has_sw_update && layer !== "sw_update" ? " sw-update" : "")}
                             style=${{ background: bg }}
                             title=${tooltip}
                             onClick=${() => { setSelectedDay(d); setSelectedComplex(cx); }}>
                          ${cellText}
                        </div>
                      </td>
                    `;
                  })}
                </tr>
              `;
              })}
            </tbody>
          </table>
        </div>
        <${HeatmapLegend} layer=${layer} />
        <div class="muted" style=${{ marginTop: "6px" }}>Клик по дате — все комплексы за день, клик по ячейке — конкретный комплекс.</div>

        ${selectedDay && html`
          <div class="section-title">Заявки за ${fmtDateShort(selectedDay)}${selectedComplex ? ` · ${selectedComplex}` : " · все комплексы"}</div>
          <div class="pill-row">
            <div class=${"pill" + (!kindFilter ? " active" : "")} onClick=${() => setKindFilter("")}>Все виды</div>
            ${Object.entries(report.kind_labels).map(([k, l]) => html`
              <div key=${k} class=${"pill" + (kindFilter === k ? " active" : "")} onClick=${() => setKindFilter(k)}>${l}</div>
            `)}
            <div class=${"pill" + (!impactFilter ? " active" : "")} onClick=${() => setImpactFilter("")}>Любое влияние</div>
            ${["Комплекс остановлен", "Функционал ограничен", "Комплекс в стопе", "Функционал не ограничен"].map((s) => html`
              <div key=${s} class=${"pill" + (impactFilter === s ? " active" : "")} onClick=${() => setImpactFilter(s)}>${s}</div>
            `)}
            <div class=${"pill" + (dayOnlyInvalidDuration ? " active" : "")} onClick=${() => setDayOnlyInvalidDuration((v) => !v)}>⚠ Некорректное время работы</div>
            ${selectedComplex && html`<div class="pill" onClick=${() => setSelectedComplex(null)}>Сбросить комплекс</div>`}
          </div>
          <div class="pill-row">
            <span class="muted">Сортировка:</span>
            ${[["duration_hours", "по длительности"], ["downtime_hours", "по даунтайму"], ["code", "по коду"], ["workStartedAt", "по началу работ"]].map(([k, l]) => html`
              <div key=${k} class=${"pill" + (daySortKey === k ? " active" : "")}
                   onClick=${() => { if (daySortKey === k) setDaySortDir((d) => (d === "asc" ? "desc" : "asc")); else { setDaySortKey(k); setDaySortDir("desc"); } }}>
                ${l}${daySortKey === k ? (daySortDir === "asc" ? " ▲" : " ▼") : ""}
              </div>
            `)}
          </div>
          ${dayTickets.length === 0 ? html`<div class="muted">Нет заявок под фильтр</div>` : dayTickets.map((t) => html`
            <div key=${t.id} class="ticket-card" onClick=${() => { setOpenTicket(t.id); setTicketNavList(dayTickets.map((x) => x.id)); }}>
              <div class="top-row">
                <span>${t.code} · ${(t.complexes || []).join(", ")}</span>
                <span>длит. ${t.duration_hours != null ? t.duration_hours + " ч" : t.duration_reason} · даунтайм ${t.downtime_hours != null ? t.downtime_hours + " ч" : "—"}</span>
              </div>
              <div class="ttl">${t.title || ""}</div>
              <div class="muted">
                <span class=${"badge " + severityBadgeClass(t.severity)}>${t.severity}</span>
                ${` ${report.kind_labels[t.kind]} · ${t.onsite ? "на объекте" : "удалённо"}${t.is_sw_update ? " · обновление ПО" : ""} · ${fmtDt(t.workStartedAt)} → ${fmtDt(t.closedAt)}`}
              </div>
              ${t.negative_response && html`<div style=${{ color: "var(--amber)", fontSize: "12px", marginTop: "4px" }}>⚠ начало работ раньше инцидента на ${t.response_hours_negative} ч</div>`}
              ${t.duration_reason === "invalid_negative" && html`<div style=${{ color: "var(--amber)", fontSize: "12px", marginTop: "4px" }}>⚠ начало работ позже окончания — длительность не учтена</div>`}
              ${t.description && html`<div class="muted" style=${{ marginTop: "4px" }}>Описание: ${t.description}</div>`}
              ${t.diagnosis && html`<div class="muted">Диагностика: ${t.diagnosis}</div>`}
              ${t.workDone && html`<div class="muted">Работы: ${t.workDone}</div>`}
              <div class="muted">Исполнитель: ${t.engineer || "—"}</div>
            </div>
          `)}
        `}

        <div class="section-title">Сводка по комплексам</div>
        <div class="summary-grid">
          ${sortedComplexesSummary.map((c) => html`
            <div key=${c.complex} class="summary-card">
              <h3>${complexLabel(c.complex, meta)}</h3>
              <div class="pct-total">${c.total_pct != null ? c.total_pct + "%" : "—"}</div>
              <div class="muted" style=${{ marginBottom: "4px" }}>${c.total_hours} ч из ${c.fund_hours ? c.fund_hours + " ч фонда" : "?"}</div>
              <div class="kind-cell" onClick=${() => openDrill(`${c.complex} · все заявки за период`, c.all_ticket_ids || [])}>
                <span class="muted">Заявок всего</span><span class="muted">${c.ticket_count ?? "—"}</span>
              </div>
              <div class="kind-cell" onClick=${() => openDrill(`${c.complex} · попало в даунтайм`, c.total_ticket_ids || [])}>
                <span class="muted">— в даунтайм</span><span class="muted">${c.downtime_ticket_count ?? "—"}</span>
              </div>
              <div class="kind-cell">
                <span class="muted">— не вошло</span><span class="muted">${c.excluded_ticket_count ?? "—"}</span>
              </div>
              ${["milk", "software", "mechanics", "other"].map((k) => html`
                <div key=${k} class="kind-cell" onClick=${() => openDrill(`${c.complex} · ${report.kind_labels[k]}`, c.kind_ticket_ids[k])}>
                  <span>${report.kind_labels[k]}</span>
                  <span>${c.kind_hours[k]} ч ${c.kind_pct[k] != null ? `(${c.kind_pct[k]}%)` : ""}</span>
                </div>
              `)}
              <div class="kind-cell" onClick=${() => openDrill(`${c.complex} · Удалённо`, [])}>
                <span>Удалённо</span><span>${c.remote_hours} ч</span>
              </div>
              ${c.sw_update_days.length > 0 && html`
                <div class="muted" style=${{ marginTop: "6px" }}>Обновление ПО: ${c.sw_update_days.map(fmtDateShort).join(", ")}</div>
              `}
            </div>
          `)}
        </div>

        ${fleetTotals && html`
          <div class="section-title">Флот F-4 в целом</div>
          <div class="bars">
            ${["total", "milk", "software", "mechanics", "other"].map((k) => html`
              <div key=${k} class="bar-row">
                <span>${k === "total" ? "Общий даунтайм" : report.kind_labels[k]}</span>
                <div class="bar-track"><div class="bar-fill" style=${{ width: Math.min(100, fleetTotals.pct[k]) + "%", background: k === "total" ? "var(--accent)" : KIND_COLORS[k] }}></div></div>
                <span>${fleetTotals.pct[k]}%</span>
              </div>
            `)}
          </div>
          <div class="muted">Молочка + софт + механика + прочее = ${(fleetTotals.pct.milk + fleetTotals.pct.software + fleetTotals.pct.mechanics + fleetTotals.pct.other).toFixed(2)}% — сумма по видам может быть БОЛЬШЕ общего простоя (${fleetTotals.pct.total}%), если несколько видов простаивали одновременно: общий % считается объединением по времени (без задвоения), разбивка по видам — каждый вид отдельно.</div>
        `}

        <div class="section-title">Отчёт за период ${fmtDateShort(report.period.start)} — ${fmtDateShort(report.period.end)}</div>
        ${sortedComplexesSummary.map((c) => html`
          <div key=${c.complex} style=${{ marginBottom: "20px" }}>
            <h3 style=${{ marginBottom: "4px" }}>${complexLabel(c.complex, meta)}</h3>
            <p class="muted" style=${{ margin: "0 0 8px" }}>
              Простой ${c.total_pct != null ? c.total_pct + "%" : "н/д"} времени фонда (${c.total_hours} из ${c.fund_hours || "?"} ч).
              Молочка ${c.kind_pct.milk ?? "—"}%, софт ${c.kind_pct.software ?? "—"}%, механика ${c.kind_pct.mechanics ?? "—"}%, прочее ${c.kind_pct.other ?? "—"}%.
              Удалённо закрыто ${c.remote_hours} ч.
              ${c.sw_update_days.length ? `Обновление ПО: ${c.sw_update_days.map(fmtDateShort).join(", ")}.` : ""}
            </p>
            <table>
              <thead><tr><th>%</th><th>Часы</th><th>Молочка</th><th>Софт</th><th>Механика</th><th>Прочее</th><th>Удалённо, ч</th></tr></thead>
              <tbody>
                <tr>
                  <td>${c.total_pct ?? "—"}</td><td>${c.total_hours}</td>
                  <td>${c.kind_hours.milk} (${c.kind_pct.milk ?? "—"}%)</td>
                  <td>${c.kind_hours.software} (${c.kind_pct.software ?? "—"}%)</td>
                  <td>${c.kind_hours.mechanics} (${c.kind_pct.mechanics ?? "—"}%)</td>
                  <td>${c.kind_hours.other} (${c.kind_pct.other ?? "—"}%)</td>
                  <td>${c.remote_hours}</td>
                </tr>
              </tbody>
            </table>
          </div>
        `)}

        ${report.sw_update_tickets.length > 0 && html`
          <div class="section-title">Обновления ПО в периоде (${report.sw_update_tickets.length})</div>
          ${report.sw_update_tickets.map((t) => html`
            <div key=${t.code} class="muted">${t.code} · ${(t.complexes || []).join(", ")} · ${fmtDt(t.workStartedAt)} · ${t.onsite ? "на объекте" : "удалённо"} — ${t.title || ""}</div>
          `)}
        `}
        ${report.still_open_tickets.length > 0 && html`
          <div class="section-title">Ещё не закрыты (${report.still_open_tickets.length})</div>
          <div class="muted">${report.still_open_tickets.join(", ")}</div>
        `}
        ${report.no_work_date_tickets.length > 0 && html`
          <div class="section-title">Без даты начала работ (${report.no_work_date_tickets.length})</div>
          <div class="muted">${report.no_work_date_tickets.join(", ")}</div>
        `}
        ${report.invalid_duration_tickets.length > 0 && html`
          <div class="section-title">Некорректное время (начало работ позже окончания) — ${report.invalid_duration_tickets.length}</div>
          <div class="muted">Часы простоя не учтены в расчёте, требуется правка в заявке: ${report.invalid_duration_tickets.join(", ")}</div>
        `}
        ${report.negative_response_tickets.length > 0 && html`
          <div class="section-title">Начало работ раньше инцидента — ${report.negative_response_tickets.length}</div>
          <div class="muted">
            ${report.negative_response_tickets.map((t) => html`<div key=${t.code}>${t.code} · ${(t.complexes || []).join(", ")} · инцидент ${fmtDt(t.incidentAt)} → начало работ ${fmtDt(t.workStartedAt)} (на ${t.hours_negative} ч раньше)</div>`)}
          </div>
        `}
      `}
      ${drillTickets && html`
        <div class="modal-backdrop" onClick=${(e) => { if (e.target === e.currentTarget) setDrillTickets(null); }}>
          <div class="modal">
            <button class="modal-close" onClick=${() => setDrillTickets(null)}>×</button>
            <h2>${drillTickets.title}</h2>
            ${drillTickets.ids.length === 0 ? html`<div class="muted">Нет заявок с ненулевым интервалом (либо метрика эвристическая и не привязана к конкретным заявкам)</div>` :
              drillTickets.ids.map((id) => {
                const t = report.tickets[id];
                if (!t) return null;
                return html`
                  <div key=${id} class="ticket-card" onClick=${() => { setOpenTicket(id); setTicketNavList(drillTickets.ids); setDrillTickets(null); }}>
                    <div class="top-row"><span>${t.code}</span><span>${t.duration_hours} ч</span></div>
                    <div class="ttl">${t.title || ""}</div>
                    <div class="muted">${fmtDt(t.workStartedAt)} → ${fmtDt(t.closedAt)}</div>
                  </div>
                `;
              })}
          </div>
        </div>
      `}
      ${openTicket && html`<${TicketModal}
        ticketId=${openTicket}
        meta=${meta}
        ticketIds=${ticketNavList}
        onNavigate=${(id) => setOpenTicket(id)}
        onClose=${() => setOpenTicket(null)}
        onDeleted=${() => { setOpenTicket(null); load(); }}
        onSaved=${() => { setOpenTicket(null); load(); }}
      />`}
    </div>
  `;
}

// ------------------------------------------------------------------ App ----

function App() {
  const [tab, setTab] = useState("tickets");
  const [meta, setMeta] = useState({});
  const [refreshing, setRefreshing] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [sessionOk, setSessionOk] = useState(true);
  const [cookieModalOpen, setCookieModalOpen] = useState(false);

  useEffect(() => { apiGet("/api/meta").then(setMeta).catch(() => {}); }, [refreshTick]);

  // Периодическая проверка сессии Service Desk (401/протухшая кука) — не по
  // каждому 401 из отдельных вкладок (их несколько и они бьются в разное
  // время из-за always-mounted вкладок), а централизованно через /api/health,
  // который отдаёт ok=false с текстом ошибки, если refresh_cache() упал.
  const checkHealth = useCallback(() => {
    apiGet("/api/health")
      .then((h) => setSessionOk(h.ok !== false))
      .catch(() => {}); // сеть недоступна и т.п. — не путать с протухшей сессией, баннер не трогаем
  }, []);
  useEffect(() => {
    checkHealth();
    const id = setInterval(checkHealth, 60000);
    return () => clearInterval(id);
  }, [checkHealth, refreshTick]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await apiPost("/api/refresh");
      setRefreshTick((x) => x + 1);
    } catch (e) {
      alert("Ошибка обновления: " + e);
    } finally {
      setRefreshing(false);
    }
  };

  return html`
    <div>
      <${TopBar} tab=${tab} setTab=${setTab} onRefresh=${onRefresh} refreshing=${refreshing}
                 sessionOk=${sessionOk} onOpenCookie=${() => setCookieModalOpen(true)} />
      <div class="content">
        <div style=${{ display: tab === "tickets" ? "block" : "none" }}>
          <${TicketsTab} meta=${meta} refreshTick=${refreshTick} />
        </div>
        <div style=${{ display: tab === "problems" ? "block" : "none" }}>
          <${ProblemsTab} meta=${meta} />
        </div>
        <div style=${{ display: tab === "charts" ? "block" : "none" }}>
          <${ChartsTab} meta=${meta} refreshTick=${refreshTick} active=${tab === "charts"} />
        </div>
        <div style=${{ display: tab === "montage" ? "block" : "none" }}>
          <${MontageTab} meta=${meta} refreshTick=${refreshTick} />
        </div>
        <div style=${{ display: tab === "report" ? "block" : "none" }}>
          <${ReportTab} meta=${meta} refreshTick=${refreshTick} />
        </div>
      </div>
      ${cookieModalOpen && html`
        <${CookieModal}
          onClose=${() => setCookieModalOpen(false)}
          onSaved=${() => { setSessionOk(true); setRefreshTick((x) => x + 1); }}
        />
      `}
    </div>
  `;
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(html`<${App} />`);
