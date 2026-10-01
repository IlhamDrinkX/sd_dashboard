"""
Движок анализа даунтайма комплексов флота F-4 (DrinkX Service Desk).

Методика — по спецификации пользователя (2026-08-11), см. README.md дашборда
за полное описание допущений. Кратко:

- Флот F-4 = комплексы с serial вида "4.<число>" (поле ticket.complexes[]) —
  канон через normalize_f4_complex: в SD serial часто с хвостом названия
  ("4.22 Яндекс Лавка", "4.23 Вектор") — без нормализации такие заявки
  выпадали из отчёта. Список точек — из живых данных (discover_f4_complexes).
  4.16/4.17 существуют физически как записи в SD, но это НЕ настоящие
  комплексы на объектах (служебные/ПО, "ЦИФД") — исключены из теплокарты/
  графика явным списком F4_EXCLUDE_FROM_HEATMAP, а не паттерном.
- День на теплокарте = дата workStartedAt ("время начала работ"), НЕ incidentAt/createdAt.
  Тикеты без workStartedAt в календарь не попадают — считаются отдельно
  (counter "без даты работ"). Часы в ячейке теплокарты (total / kind / remote)
  обрезаются по графику работы комплекса (F4_GRAPH_WINDOWS, MSK) — ночной
  простой вне окна объекта в ячейку не входит. Сводка % по комплексам по-прежнему
  считает wall-clock / фонд F4_GRAPH_HOURS без обрезки интервалов.
- Интервал простоя тикета для колонки "Длительность"/аномалий = [workStartedAt,
  closedAt] — см. compute_duration(). Это НЕ то же самое, что часы, идущие в
  сам отчёт F4 (% простоя по комплексам) — см. compute_downtime() и раздел
  "Методика влияние+приоритет" ниже, там своя, более сложная логика начала
  интервала и своё правило, что вообще считается даунтаймом.
- Kind (молочка/софт/механика/прочее) определяется по полю ticket.node —
  см. NODE_TO_KIND. Это НАДЁЖНЕЕ, чем текстовый поиск по описанию (как
  предполагалось в исходной методике для "сырого" Excel-экспорта) — у нас
  есть чистое категориальное поле от самого Service Desk.
- Merge пересекающихся интервалов — по каждому (комплекс, kind) ОТДЕЛЬНО
  (kind_hours/kind_pct — разбивка по типам, каждый тип мёржится сам с собой)
  И ОТДЕЛЬНО по комплексу целиком, без учёта kind (total_hours/total_pct —
  реальное время, когда комплекс был недоступен хоть по одной причине).
  **ИЗМЕНЕНО 2026-08-12** (было наоборот: total = сумма kind_hours, чтобы
  total% == milk%+software%+mechanics%+other% ТОЧНО — пользователь явно
  попросил заменить это на честный wall-clock кросс-видовой merge, когда
  выяснилось, что одновременный простой молочки И софта считался как 2
  разных часа простоя вместо реального 1 часа недоступности комплекса).
  Теперь **total_hours может быть МЕНЬШЕ суммы kind_hours** — это ожидаемо
  и означает, что были периоды, когда несколько видов простаивали
  одновременно (учтено один раз в total, но каждый вид всё равно виден
  отдельно в разбивке kind_hours для причинного анализа).
- "Удалённо" — если НЕТ признаков выезда (акт/фото акта/номер акта/текстовые
  маркеры "на объекте"/"по приезде"/"выезд"/...) и это не обновление ПО с
  явным приездом/актом/duration>=1ч.
- "Обновление ПО" — отдельный boolean-тег (не kind), если в тексте тикета
  встречаются маркеры обновления/прошивки.

Методика влияние+приоритет (добавлено 2026-08-12, уточнено в тот же день,
спецификация пользователя) — см. compute_downtime(), это ОТДЕЛЬНЫЙ расчёт от
compute_duration() выше: compute_duration() — чистая проверка качества данных
workStartedAt/closedAt (колонка "Длительность", аномалия "начало работ позже
закрытия"), а compute_downtime() — сколько часов простоя заявка реально
вносит в отчёт F4 (intervals_by_complex_kind, т.е. kind_hours/total_pct по
комплексам). Таблица:
  * severity ∈ {"Комплекс остановлен", "Комплекс в стопе", "Функционал
    ограничен"}: приоритет Высокий/Срочный -> начало = incidentAt, иначе
    начало = workStartedAt. Конец всегда closedAt.
  * severity == "Функционал не ограничен" — НЕ "всегда исключено", как было
    в первой версии методики. При приоритете Высокий/Срочный ВСЁ РАВНО
    считается даунтаймом, но начало = workStartedAt (не incidentAt — это
    отличается от правила для остальных severity выше, так задано явно).
    При любом другом приоритете — не даунтайм.
День на теплокарте (rule 2 выше) остался по workStartedAt — если приоритет
Высокий и workStartedAt пуст, такая заявка попадёт в total_pct/kind_hours
(через incidentAt), но НЕ появится на самой теплокарте (там нужен именно
workStartedAt для дня) — известное ограничение, не баг.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone, date, timedelta
from collections import defaultdict

# Комплекс считается частью флота F-4, если serial НАЧИНАЕТСЯ с "4.<число>"
# (см. normalize_f4_complex). В SD serial часто с хвостом-названием:
# "4.22 Яндекс Лавка", "4.23 Вектор", "4.19 АФК" — раньше матчился только
# точный "4.N", и такие заявки молча выпадали из отчёта (мало тикетов у
# 4.22/4.23). Нормализация сводит всё к каноническому "4.N".
F4_COMPLEX_RE = re.compile(r"^4\.\d+$")
F4_COMPLEX_PREFIX_RE = re.compile(r"^(4\.\d+)\b")

# Rule 1: 4.16/4.17 — реальные записи в SD, но не физические комплексы на
# объектах (служебные/ПО, "ЦИФД") — не выносить на теплокарту/график, если
# явно не попросили иначе. Это единственное оставшееся жёстко заданное
# исключение (белый список НЕ используется — паттерн ловит всё остальное).
F4_EXCLUDE_FROM_HEATMAP = {"4.16", "4.17"}


def normalize_f4_complex(c: str | None) -> str | None:
    """Канонический код флота F-4: '4.22 Яндекс Лавка' / '4.22' → '4.22'.
    None, если строка не про F-4."""
    if not c:
        return None
    m = F4_COMPLEX_PREFIX_RE.match(str(c).strip())
    return m.group(1) if m else None


def discover_f4_complexes(tickets: list[dict]) -> list[str]:
    """Все комплексы F-4 (код вида '4.N'), когда-либо встретившиеся хотя бы в
    одной заявке из переданного списка — сортировка числовая (не строковая,
    иначе "4.10" встанет перед "4.5"). Заменяет старый F4_COMPLEXES.
    Хвосты вроде '4.22 Яндекс Лавка' нормализуются к '4.22'."""
    found = set()
    for t in tickets:
        for c in (t.get("complexes") or []):
            norm = normalize_f4_complex(c)
            if norm:
                found.add(norm)
    return sorted(found, key=lambda c: [int(p) for p in c.split(".")])


def f4_heatmap_complexes(tickets: list[dict]) -> list[str]:
    """discover_f4_complexes() минус явно исключённые служебные записи (см.
    F4_EXCLUDE_FROM_HEATMAP) — тот набор, что реально идёт на теплокарту/
    в сводку по комплексам."""
    return [c for c in discover_f4_complexes(tickets) if c not in F4_EXCLUDE_FROM_HEATMAP]

# Rule 8: график работы объекта (московское время, UTC+3).
# F4_GRAPH_HOURS — фонд ч/сутки для % в сводке комплексов.
# F4_GRAPH_WINDOWS — фактическое окно [open, close) мск; на ТЕПЛОКАРТЕ часы
# простоя обрезаются по этому окну (с 2026-09-30). В сводке % по-прежнему
# wall-clock / фонд (без обрезки интервалов) — пока не попросили иначе.
#   4.5  (day2day)                          00:00-24:00 -> 24ч
#   4.6  (day2day)                          00:00-24:00 -> 24ч
#   4.7  (ВкусВилл, Старая Басманная 38)     08:00-23:00 -> 15ч
#   4.8  (Пятёрочка, Рижский проезд 8)       07:00-23:00 -> 16ч
#   4.9  (Сибур) — приравнено к 4.10/4.11/4.12
#                                            09:00-18:00 -> 9ч
#   4.10 (Сибур)                            09:00-18:00 -> 9ч
#   4.11 (Сибур)                            09:00-18:00 -> 9ч
#   4.12 (ВкусВилл)                         09:00-18:00 -> 9ч
#   4.13 (Пятёрочка, Бауманская)             08:00-23:00 -> 15ч
#   4.14 (ВкусВилл, Земляной Вал 38-40)      08:00-23:00 -> 15ч
#   4.15 (ВкусВилл, Амурская)                08:00-23:00 -> 15ч
MSK = timezone(timedelta(hours=3))

F4_GRAPH_HOURS = {
    "4.5": 24, "4.6": 24,
    "4.7": 15, "4.13": 15, "4.14": 15, "4.15": 15,
    "4.8": 16,
    "4.9": 9, "4.10": 9, "4.11": 9, "4.12": 9,
    # Новые точки без уточнённого окна — как ритейл 08–23 / Сибур 09–18.
    "4.22": 15, "4.23": 15,
    "4.19": 9, "4.20": 9,
}
F4_GRAPH_HOURS_DEFAULT = 15

# (час_открытия, час_закрытия) по Москве; close не включая. (0, 24) = круглосуточно.
F4_GRAPH_WINDOWS: dict[str, tuple[int, int]] = {
    "4.5": (0, 24), "4.6": (0, 24),
    "4.7": (8, 23), "4.13": (8, 23), "4.14": (8, 23), "4.15": (8, 23),
    "4.8": (7, 23),
    "4.9": (9, 18), "4.10": (9, 18), "4.11": (9, 18), "4.12": (9, 18),
    "4.22": (8, 23), "4.23": (8, 23),
    "4.19": (9, 18), "4.20": (9, 18),
}
F4_GRAPH_WINDOW_DEFAULT = (8, 23)


def graph_window_for(cx: str) -> tuple[int, int]:
    return F4_GRAPH_WINDOWS.get(cx, F4_GRAPH_WINDOW_DEFAULT)


def clip_interval_to_graph(
    start: datetime, end: datetime, cx: str
) -> list[tuple[datetime, datetime]]:
    """Обрезка [start, end) по графику работы комплекса (MSK).
    Возвращает список UTC-интервалов внутри рабочих окон."""
    if end <= start:
        return []
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)

    open_h, close_h = graph_window_for(cx)
    if open_h <= 0 and close_h >= 24:
        return [(start, end)]

    start_msk = start.astimezone(MSK)
    end_msk = end.astimezone(MSK)
    out: list[tuple[datetime, datetime]] = []
    day = start_msk.date()
    last = end_msk.date()
    while day <= last:
        win_start = datetime(day.year, day.month, day.day, open_h, 0, 0, tzinfo=MSK)
        if close_h >= 24:
            win_end = datetime(day.year, day.month, day.day, tzinfo=MSK) + timedelta(days=1)
        else:
            win_end = datetime(day.year, day.month, day.day, close_h, 0, 0, tzinfo=MSK)
        s = max(start_msk, win_start)
        e = min(end_msk, win_end)
        if e > s:
            out.append((s.astimezone(timezone.utc), e.astimezone(timezone.utc)))
        day += timedelta(days=1)
    return out


def _merged_hours_clipped_to_graph(
    ivals: list[tuple[datetime, datetime, list]], cx: str
) -> float:
    """Merge + обрезка по графику комплекса → сумма часов."""
    clipped: list[tuple[datetime, datetime, list]] = []
    for start, end, tids in ivals:
        for cs, ce in clip_interval_to_graph(start, end, cx):
            clipped.append((cs, ce, tids))
    if not clipped:
        return 0.0
    return sum(
        (e - s).total_seconds() / 3600
        for s, e, _ in _merge_intervals(clipped)
    )


def ticket_f4_complexes(ticket: dict) -> list[str]:
    """Уникальные канонические коды F-4 из ticket.complexes (с нормализацией
    хвостов '4.22 Яндекс Лавка' → '4.22')."""
    out = []
    seen = set()
    for c in (ticket.get("complexes") or []):
        norm = normalize_f4_complex(c)
        if norm and norm not in seen:
            seen.add(norm)
            out.append(norm)
    return out

# Severity, которые ВСЕГДА участвуют в даунтайме (независимо от приоритета) —
# см. compute_downtime() ниже: "Функционал не ограничен" туда осознанно НЕ входит,
# у него отдельное, приоритет-зависимое исключение прямо в compute_downtime().
DOWNTIME_SEVERITIES = {"Комплекс остановлен", "Функционал ограничен", "Комплекс в стопе"}

# Методика влияние+приоритет (2026-08-12): от чего считать НАЧАЛО простоя.
HIGH_PRIORITIES = {"Высокий", "Срочный"}

KIND_LABELS = {"milk": "Молочка", "software": "Софт/ПО", "mechanics": "Механика", "other": "Прочее"}
KIND_ORDER = ["milk", "software", "mechanics", "other"]

# Классификация по ticket.node — см. докстринг модуля почему так, а не по тексту.
NODE_TO_KIND = {
    "Молочная система": "milk",
    "Капучинатор кофейного концентрата": "milk",
    "Программное обеспечение": "software",
    "DrinkX Cloud / ERP": "software",
    "Роутер": "software",
    "Интернет-соединение": "software",
    "Планшет": "software",
    "Киоск / планшет заказа": "software",
    "Кофемашина": "mechanics",
    "Сиропная система": "mechanics",
    "Фасад": "mechanics",
    "Блок управления": "mechanics",
    "Модуль кипятка": "mechanics",
    "Холодильник": "mechanics",
    "Монитор": "other",
    "Система водоотведения": "other",
    "Система водоснабжения": "other",
    "Кран": "other",
    "Система электроснабжения": "other",
    "ККТ": "other",
    "Терминал": "other",
}

ONSITE_TEXT_MARKERS = [
    "на объекте", "по приезде", "акт подписан", "выезд", "приехал", "приехали",
    "на месте", "выезжал", "выезжали", "прибыли", "прибыл",
]
SW_UPDATE_MARKERS = ["обновлен", "обновление по", "обновили по", "прошивк", "апдейт", "update"]


def _parse_iso(v):
    if not v:
        return None
    try:
        v = v.replace("Z", "+00:00")
        dt = datetime.fromisoformat(v)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, AttributeError):
        return None


def _combined_text(t: dict) -> str:
    parts = [
        t.get("description") or "", t.get("diagnosis") or "", t.get("workDone") or "",
        t.get("l1Actions") or "", t.get("engineerComment") or "", t.get("failureReason") or "",
        t.get("title") or "",
    ]
    return " ".join(parts).lower()


def get_kind(ticket: dict) -> str:
    return NODE_TO_KIND.get(ticket.get("node"), "other")


def is_software_update(ticket: dict) -> bool:
    text = _combined_text(ticket)
    return any(m in text for m in SW_UPDATE_MARKERS)


def compute_duration(ticket: dict):
    """Возвращает (start_dt, end_dt, hours) или (None, None, None) + причину."""
    ws = _parse_iso(ticket.get("workStartedAt"))
    if ws is None:
        return None, None, None, "no_work_start"
    end = _parse_iso(ticket.get("closedAt"))
    if end is None:
        return ws, None, None, "still_open"
    hours = (end - ws).total_seconds() / 3600
    if hours < 0:
        return ws, end, None, "invalid_negative"
    return ws, end, hours, "ok"


def compute_downtime(ticket: dict):
    """Время простоя тикета для отчёта F4 по методике влияние+приоритет
    (спецификация пользователя, 2026-08-12, уточнено в тот же день):
      - severity ∈ DOWNTIME_SEVERITIES ("Комплекс остановлен"/"Комплекс в
        стопе"/"Функционал ограничен"): начало = incidentAt при приоритете
        Высокий/Срочный, иначе workStartedAt (Низкий/Средний/Фоновый/
        неизвестный). Конец всегда closedAt.
      - severity == "Функционал не ограничен" — ОСОБЫЙ случай, не то же
        самое что "всегда исключено", как считалось раньше: при приоритете
        Высокий/Срочный ВСЁ РАВНО входит в даунтайм, но начало = workStartedAt
        (НЕ incidentAt, в отличие от остальных severity выше — так задал
        пользователь явно). При любом другом приоритете — не даунтайм.
      - любая другая/пустая severity — не даунтайм (безопасный дефолт).
    Возвращает (start_dt, end_dt, hours, reason, start_field).
    reason: "excluded_severity" | "excluded_priority" | "no_start" |
            "still_open" | "invalid_negative" | "ok"
    ("excluded_severity" — severity вообще не участвует в даунтайме;
    "excluded_priority" — severity участвует, но не при этом приоритете,
    см. "Функционал не ограничен" выше).
    """
    sev = ticket.get("severity") or ""
    high_priority = (ticket.get("priority") or "") in HIGH_PRIORITIES

    if sev == "Функционал не ограничен":
        if not high_priority:
            return None, None, None, "excluded_priority", None
        start_field = "workStartedAt"
    elif sev in DOWNTIME_SEVERITIES:
        start_field = "incidentAt" if high_priority else "workStartedAt"
    else:
        return None, None, None, "excluded_severity", None

    start = _parse_iso(ticket.get(start_field))
    if start is None:
        return None, None, None, "no_start", start_field
    end = _parse_iso(ticket.get("closedAt"))
    if end is None:
        return start, None, None, "still_open", start_field
    hours = (end - start).total_seconds() / 3600
    if hours < 0:
        return start, end, None, "invalid_negative", start_field
    return start, end, hours, "ok", start_field


def is_negative_response(ticket: dict):
    """Проверка ДРУГОЙ пары времён, чем compute_duration(): incidentAt vs
    workStartedAt (а не workStartedAt vs closedAt). "Время на объекте" не
    может начаться раньше, чем был зарегистрирован сам инцидент — если
    workStartedAt < incidentAt, это отрицательный интервал реакции
    (инженер физически не мог начать работы над ещё не случившейся
    поломкой), явный сигнал для ручной проверки/опечатки в датах.
    Возвращает (bool, hours_negative|None)."""
    ws = _parse_iso(ticket.get("workStartedAt"))
    inc = _parse_iso(ticket.get("incidentAt"))
    if ws is None or inc is None:
        return False, None
    if ws < inc:
        return True, round((inc - ws).total_seconds() / 3600, 2)
    return False, None


def is_onsite(ticket: dict, hours) -> bool:
    if ticket.get("hasSignedActPhoto") or ticket.get("paperActReceived") or ticket.get("actNumber"):
        return True
    text = _combined_text(ticket)
    if any(m in text for m in ONSITE_TEXT_MARKERS):
        return True
    if is_software_update(ticket) and hours is not None and hours >= 1:
        return True
    return False


def _merge_intervals(intervals: list[tuple]) -> list[tuple]:
    """intervals: [(start_dt, end_dt, ticket_id), ...] одного (complex, kind).
    Возвращает список смерженных (start, end, [ticket_ids])."""
    if not intervals:
        return []
    intervals = sorted(intervals, key=lambda x: x[0])
    merged = [[intervals[0][0], intervals[0][1], [intervals[0][2]]]]
    for start, end, tid in intervals[1:]:
        last = merged[-1]
        if start <= last[1]:
            if end > last[1]:
                last[1] = end
            last[2].append(tid)
        else:
            merged.append([start, end, [tid]])
    return [(m[0], m[1], m[2]) for m in merged]


def build_report(tickets: list[dict], start_date: date, end_date: date) -> dict:
    """start_date/end_date включительно, календарные даты (без времени)."""
    days = []
    d = start_date
    while d <= end_date:
        days.append(d)
        d += timedelta(days=1)
    n_days = len(days)

    # Комплексы F-4 выводятся из ВСЕХ переданных заявок (весь кэш, не только
    # период отчёта) — так новый комплекс не пропадает из строк теплокарты/
    # сводки просто потому, что его единственная заявка попала мимо текущего
    # выбранного периода.
    heatmap_complexes = f4_heatmap_complexes(tickets)

    # тикеты этого отчёта: F-4, попадают в период по workStartedAt (для тех, у кого он есть),
    # либо без даты работ (считаются отдельно, не в календарь).
    f4_tickets = []
    for t in tickets:
        cxs = ticket_f4_complexes(t)
        if not cxs:
            continue
        f4_tickets.append(t)

    counters = {
        "total_f4_tickets": 0,
        "stopped": 0, "limited": 0, "in_stop": 0, "not_limited": 0,
        "remote": 0, "acts": 0, "no_work_date": 0, "still_open": 0, "invalid_duration": 0,
        "negative_response": 0,
    }
    sw_update_tickets = []
    no_work_date_tickets = []
    still_open_tickets = []
    invalid_duration_tickets = []
    negative_response_tickets = []

    # per (complex, kind) -> list of (start, end, ticket_id)
    intervals_by_complex_kind = defaultdict(list)
    # per complex (все виды вместе) -> list of (start, end, ticket_id), для кросс-видового merge
    intervals_by_complex = defaultdict(list)
    # ticket_id -> summary dict (для фронта, чтобы не тащить сырые тикеты)
    ticket_summaries = {}
    # (complex, day_iso) -> list of ticket_id (для списка заявок дня, per rule 2 — день по workStartedAt)
    day_complex_tickets = defaultdict(list)
    # complex -> set(ticket_id), ВСЕ заявки комплекса за период (в т.ч. без workStartedAt,
    # в т.ч. НЕ попавшие в даунтайм) — для клика по названию комплекса и счётчиков в сводке
    complex_all_tickets = defaultdict(set)

    period_start_dt = datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)
    period_end_dt = datetime(end_date.year, end_date.month, end_date.day, tzinfo=timezone.utc) + timedelta(days=1)

    for t in f4_tickets:
        ws, end, hours, reason = compute_duration(t)
        sev = t.get("severity")

        # день на календаре — по workStartedAt, входит ли этот день в выбранный период
        in_period = False
        day_key = None
        if ws is not None:
            day_key = ws.date()
            in_period = start_date <= day_key <= end_date
        else:
            # без даты работ — считаем в счётчик, если incidentAt/createdAt попадает в период
            # (иначе непонятно, к какому периоду вообще относить), но НЕ на календарь.
            fallback = _parse_iso(t.get("incidentAt")) or _parse_iso(t.get("createdAt"))
            if fallback and start_date <= fallback.date() <= end_date:
                in_period = True

        if not in_period:
            continue

        counters["total_f4_tickets"] += 1
        onsite = is_onsite(t, hours)
        sw_update = is_software_update(t)
        kind = get_kind(t)

        for cx in ticket_f4_complexes(t):
            complex_all_tickets[cx].add(t["id"])

        if sev == "Комплекс остановлен":
            counters["stopped"] += 1
        elif sev == "Функционал ограничен":
            counters["limited"] += 1
        elif sev == "Комплекс в стопе":
            counters["in_stop"] += 1
        elif sev == "Функционал не ограничен":
            counters["not_limited"] += 1

        if not onsite:
            counters["remote"] += 1
        if t.get("hasSignedActPhoto") or t.get("paperActReceived") or t.get("actNumber"):
            counters["acts"] += 1
        if reason == "no_work_start":
            counters["no_work_date"] += 1
            no_work_date_tickets.append(t.get("code"))
        if reason == "still_open":
            counters["still_open"] += 1
            still_open_tickets.append(t.get("code"))
        if reason == "invalid_negative":
            # workStartedAt позже closedAt — данные внесены некорректно (пример
            # из практики: SD-1166, замена капучинатора 28.07 — время начала
            # работ проставлено на следующий день). Часы простоя НЕ считаем
            # (заведомо мусорное значение), но показываем список отдельно,
            # чтобы можно было поправить заявку прямо из вкладки "Заявки".
            counters["invalid_duration"] += 1
            invalid_duration_tickets.append(t.get("code"))
        neg_response, neg_response_hours = is_negative_response(t)
        if neg_response:
            counters["negative_response"] += 1
            negative_response_tickets.append({
                "code": t.get("code"), "complexes": ticket_f4_complexes(t),
                "incidentAt": t.get("incidentAt"), "workStartedAt": t.get("workStartedAt"),
                "hours_negative": neg_response_hours,
            })
        if sw_update:
            sw_update_tickets.append({
                "code": t.get("code"), "complexes": ticket_f4_complexes(t),
                "title": t.get("title"), "workStartedAt": t.get("workStartedAt"),
                "onsite": onsite,
            })

        dt_start, dt_end, dt_hours, dt_reason, dt_start_field = compute_downtime(t)

        summary = {
            "id": t["id"], "code": t.get("code"), "title": t.get("title"),
            "client": t.get("client"), "object": t.get("object"),
            "complexes": ticket_f4_complexes(t), "node": t.get("node"), "kind": kind,
            "severity": sev, "priority": t.get("priority"), "status": t.get("status"), "engineer": t.get("engineer"),
            "incidentAt": t.get("incidentAt"), "workStartedAt": t.get("workStartedAt"),
            "closedAt": t.get("closedAt"), "duration_hours": round(hours, 2) if hours is not None else None,
            "duration_reason": reason, "onsite": onsite, "is_sw_update": sw_update,
            "negative_response": neg_response, "response_hours_negative": neg_response_hours,
            "downtime_hours": round(dt_hours, 2) if dt_hours is not None else None,
            "downtime_reason": dt_reason, "downtime_start_field": dt_start_field,
            "description": t.get("description"), "diagnosis": t.get("diagnosis"),
            "workDone": t.get("workDone"), "engineerComment": t.get("engineerComment"),
        }
        ticket_summaries[t["id"]] = summary

        if day_key is not None:
            for cx in ticket_f4_complexes(t):
                day_complex_tickets[(cx, day_key.isoformat())].append(t["id"])

        if dt_reason == "ok":
            for cx in ticket_f4_complexes(t):
                intervals_by_complex_kind[(cx, kind)].append((dt_start, dt_end, t["id"]))
                intervals_by_complex[cx].append((dt_start, dt_end, t["id"]))

    # merge per (complex, kind) — см. докстринг модуля. Это НЕ то же самое, что
    # общий простой комплекса (см. intervals_by_complex/complex_total_hours ниже,
    # добавлено 2026-08-12 по просьбе пользователя): kind_hours может суммарно
    # быть БОЛЬШЕ total_hours, если разные виды простаивали одновременно —
    # это осознанно (каждый вид считается как отдельная проблема), а total
    # считает реальное время, когда комплекс был недоступен хоть по одной причине.
    complex_kind_hours = defaultdict(float)  # (complex, kind) -> merged hours (весь период)
    complex_kind_ticket_ids = defaultdict(set)  # (complex, kind) -> set(ticket_id) вошедших в merge
    complex_total_hours = defaultdict(float)  # complex -> merged hours ПО ВСЕМ видам вместе (реальный wall-clock простой)
    complex_total_ticket_ids = defaultdict(set)  # complex -> set(ticket_id)
    heat_cells = defaultdict(lambda: defaultdict(float))  # complex -> day_iso -> hours (кросс-видовой merge, см. per_day_complex_intervals ниже)
    heat_cells_kind = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))  # complex -> day_iso -> kind -> hours (БЕЗ кросс-видового merge — разбивка по типам)
    remote_hours = defaultdict(float)  # complex -> remote hours (эвристика: часы тикетов без выезда, по своему интервалу, без кросс-тикетного merge)

    for (cx, kind), ivals in intervals_by_complex_kind.items():
        merged = _merge_intervals(ivals)
        for start, end, tids in merged:
            # обрезаем по границам периода (на случай если интервал вылезает за пределы)
            s = max(start, period_start_dt)
            e = min(end, period_end_dt)
            if e <= s:
                continue
            hrs = (e - s).total_seconds() / 3600
            complex_kind_hours[(cx, kind)] += hrs
            complex_kind_ticket_ids[(cx, kind)].update(tids)

    for cx, ivals in intervals_by_complex.items():
        merged = _merge_intervals(ivals)
        for start, end, tids in merged:
            s = max(start, period_start_dt)
            e = min(end, period_end_dt)
            if e <= s:
                continue
            complex_total_hours[cx] += (e - s).total_seconds() / 3600
            complex_total_ticket_ids[cx].update(tids)

    # heatmap: по дню workStartedAt каждого тикета (rule 2). heat_cells_kind — БЕЗ
    # кросс-видового merge (разбивка по типам, для карточек по видам). heat_cells
    # ("Весь даунтайм"/total-слой) — С кросс-видовым merge (см. выше про complex_total_hours),
    # чтобы не задваивать часы, когда молочка и софт простаивали одновременно.
    per_day_complex_kind_intervals = defaultdict(list)  # (complex, day_iso, kind) -> [(start,end,tid)]
    per_day_complex_intervals = defaultdict(list)  # (complex, day_iso) -> [(start,end,tid)], все виды вместе
    for t in f4_tickets:
        ws = _parse_iso(t.get("workStartedAt"))
        if ws is None:
            continue
        dt_start, dt_end, dt_hours, dt_reason, _ = compute_downtime(t)
        if dt_reason != "ok":
            continue
        day_key = ws.date()
        if not (start_date <= day_key <= end_date):
            continue
        kind = get_kind(t)
        for cx in ticket_f4_complexes(t):
            per_day_complex_kind_intervals[(cx, day_key.isoformat(), kind)].append((dt_start, dt_end, t["id"]))
            per_day_complex_intervals[(cx, day_key.isoformat())].append((dt_start, dt_end, t["id"]))

    for (cx, day_iso, kind), ivals in per_day_complex_kind_intervals.items():
        heat_cells_kind[cx][day_iso][kind] += _merged_hours_clipped_to_graph(ivals, cx)

    for (cx, day_iso), ivals in per_day_complex_intervals.items():
        heat_cells[cx][day_iso] = _merged_hours_clipped_to_graph(ivals, cx)

    # то же самое, но для слоя "удалённо" на теплокарте — независимая метрика
    # (тикет remote И имеет kind, поэтому remote-часы могут пересекаться с
    # kind-часами по определению by design — это два разных "среза" одних и
    # тех же простоев, не складываются друг с другом).
    per_day_complex_remote_intervals = defaultdict(list)
    for t in f4_tickets:
        ws, end, hours, reason = compute_duration(t)
        if ws is None:
            continue
        dt_start, dt_end, dt_hours, dt_reason, _ = compute_downtime(t)
        if dt_reason != "ok":
            continue
        day_key = ws.date()
        if not (start_date <= day_key <= end_date):
            continue
        if is_onsite(t, hours):
            continue
        for cx in ticket_f4_complexes(t):
            per_day_complex_remote_intervals[(cx, day_key.isoformat())].append((dt_start, dt_end, t["id"]))

    heat_cells_remote = defaultdict(lambda: defaultdict(float))
    for (cx, day_iso), ivals in per_day_complex_remote_intervals.items():
        heat_cells_remote[cx][day_iso] = _merged_hours_clipped_to_graph(ivals, cx)

    # remote hours per complex (не мёржим — просто сумма продолжительностей remote-тикетов
    # с downtime-severity; пересечения remote-тикетов внутри одного kind уже учтены в
    # complex_kind_hours, здесь отдельная эвристическая метрика "сколько часов простоя было
    # закрыто удалённо", может не совпадать один-в-один с суммой kind из-за независимого учёта)
    for t in f4_tickets:
        ws, end, hours, reason = compute_duration(t)
        dt_start, dt_end, dt_hours, dt_reason, _ = compute_downtime(t)
        if dt_reason != "ok" or hours is None:
            continue
        if not is_onsite(t, hours):
            for cx in ticket_f4_complexes(t):
                remote_hours[cx] += dt_hours

    # summary per complex
    complexes_summary = []
    for cx in heatmap_complexes:
        graph_h = F4_GRAPH_HOURS.get(cx, F4_GRAPH_HOURS_DEFAULT)
        fund_hours = graph_h * n_days if graph_h else None
        kind_hours = {k: round(complex_kind_hours.get((cx, k), 0.0), 2) for k in KIND_ORDER}
        # total_hours — кросс-видовой merge (complex_total_hours), НЕ sum(kind_hours) —
        # см. докстринг модуля: если разные виды простаивали одновременно, total МЕНЬШЕ
        # суммы kind_hours (реальное время недоступности комплекса, без задвоения).
        total_hours = round(complex_total_hours.get(cx, 0.0), 2)
        kind_pct = {}
        total_pct = None
        if fund_hours:
            kind_pct = {k: round(100 * kind_hours[k] / fund_hours, 2) for k in KIND_ORDER}
            total_pct = round(100 * total_hours / fund_hours, 2)
        # дни обновления ПО для этого комплекса — из heatmap-ячеек (has_sw_update)
        sw_days = sorted(
            day_iso for day_iso in [d.isoformat() for d in days]
            if any(ticket_summaries[tid].get("is_sw_update")
                   for tid in day_complex_tickets.get((cx, day_iso), []))
        )
        all_ids = complex_all_tickets.get(cx, set())
        downtime_ids = complex_total_ticket_ids.get(cx, set())
        complexes_summary.append({
            "complex": cx,
            "graph_hours_per_day": graph_h,
            "fund_hours": fund_hours,
            "kind_hours": kind_hours,
            "total_hours": total_hours,
            "kind_pct": kind_pct,
            "total_pct": total_pct,
            "remote_hours": round(remote_hours.get(cx, 0.0), 2),
            "kind_ticket_ids": {k: sorted(complex_kind_ticket_ids.get((cx, k), set())) for k in KIND_ORDER},
            "total_ticket_ids": sorted(downtime_ids),
            "all_ticket_ids": sorted(all_ids),
            # счётчики для карточки: всего/попало в даунтайм/не вошло (excluded_severity,
            # excluded_priority, no_start, still_open, invalid_negative — см. compute_downtime).
            # НЕ равно total_ticket_ids один-в-один: тикет может входить в даунтайм (reason=ok),
            # но не попасть в merged-набор, если его интервал целиком обрезался границами периода.
            "ticket_count": len(all_ids),
            "downtime_ticket_count": len(downtime_ids),
            "excluded_ticket_count": len(all_ids) - len(downtime_ids & all_ids),
            "sw_update_days": sw_days,
        })

    complexes_summary.sort(key=lambda r: (r["total_pct"] or 0), reverse=True)

    # heatmap payload
    heatmap = {
        "days": [d.isoformat() for d in days],
        "complexes": heatmap_complexes,
        "cells": {
            cx: {day_iso: {
                "hours": round(heat_cells[cx].get(day_iso, 0.0), 2),
                "kind_hours": {k: round(heat_cells_kind[cx].get(day_iso, {}).get(k, 0.0), 2) for k in KIND_ORDER},
                "remote_hours": round(heat_cells_remote[cx].get(day_iso, 0.0), 2),
                "ticket_ids": day_complex_tickets.get((cx, day_iso), []),
                "has_sw_update": any(ticket_summaries[tid].get("is_sw_update") for tid in day_complex_tickets.get((cx, day_iso), [])),
            } for day_iso in [d.isoformat() for d in days]}
            for cx in heatmap_complexes
        },
    }

    return {
        "period": {"start": start_date.isoformat(), "end": end_date.isoformat(), "days": n_days},
        "counters": counters,
        "complexes_summary": complexes_summary,
        "heatmap": heatmap,
        "sw_update_tickets": sw_update_tickets,
        "no_work_date_tickets": no_work_date_tickets,
        "still_open_tickets": still_open_tickets,
        "invalid_duration_tickets": invalid_duration_tickets,
        "negative_response_tickets": negative_response_tickets,
        "tickets": ticket_summaries,
        "kind_labels": KIND_LABELS,
    }


def charts_data_range(tickets: list[dict]) -> dict:
    """Минимальная/максимальная дата workStartedAt среди F-4 заявок (для пресета «всё время»)."""
    days = []
    for t in tickets:
        if not ticket_f4_complexes(t):
            continue
        ws = _parse_iso(t.get("workStartedAt"))
        if ws is not None:
            days.append(ws.astimezone(timezone.utc).date())
    if not days:
        today = date.today()
        return {"start": today.isoformat(), "end": today.isoformat()}
    return {"start": min(days).isoformat(), "end": max(days).isoformat()}


def build_charts_dataset(
    tickets: list[dict],
    start_date: date,
    end_date: date,
    *,
    problems: list[dict] | None = None,
) -> dict:
    """Точки для вкладки «Графики»: простой + время на объекте по дням/комплексам.

    Фильтры комплексов/проблем/узлов применяются на клиенте — сюда отдаём
    полный набор points за период + справочники счётчиков.
    """
    days = []
    d = start_date
    while d <= end_date:
        days.append(d)
        d += timedelta(days=1)
    day_isos = [x.isoformat() for x in days]

    problem_titles = {p["id"]: (p.get("title") or p["id"]) for p in (problems or []) if p.get("id")}

    points = []
    skipped_no_day = 0
    complex_counts: dict[str, int] = defaultdict(int)
    problem_counts: dict[str, int] = defaultdict(int)  # "" = без проблемы
    node_counts: dict[str, int] = defaultdict(int)

    for t in tickets:
        cxs = ticket_f4_complexes(t)
        if not cxs:
            continue

        ws, end_dt, dur_hours, dur_reason = compute_duration(t)
        dt_start, dt_end, dt_hours, dt_reason, _ = compute_downtime(t)
        onsite = is_onsite(t, dur_hours)

        downtime_h = round(dt_hours, 2) if (dt_reason == "ok" and dt_hours is not None) else 0.0
        onsite_h = round(dur_hours, 2) if (onsite and dur_reason == "ok" and dur_hours is not None) else 0.0

        if downtime_h <= 0 and onsite_h <= 0:
            # всё равно учитываем в фильтрах, если есть день — полезно для drill «нулевые»
            pass

        if ws is None:
            skipped_no_day += 1
            continue
        day_key = ws.astimezone(timezone.utc).date()
        if day_key < start_date or day_key > end_date:
            continue

        pid = t.get("problemId") or ""
        node = t.get("node") or ""
        for cx in cxs:
            complex_counts[cx] += 1
        problem_counts[pid] += 1
        if node:
            node_counts[node] += 1

        points.append({
            "id": t["id"],
            "code": t.get("code"),
            "day": day_key.isoformat(),
            "complexes": cxs,
            "problemId": pid,
            "node": node,
            "downtime_hours": downtime_h,
            "onsite_hours": onsite_h,
            "title": t.get("title") or "",
        })

    complexes = f4_heatmap_complexes(tickets)
    # дополняем комплексами, которые встретились только в периоде (на всякий)
    for cx in complex_counts:
        if cx not in complexes and cx not in F4_EXCLUDE_FROM_HEATMAP:
            complexes.append(cx)
    complexes = sorted(set(complexes), key=lambda c: [int(p) for p in c.split(".")])

    problems_out = []
    for pid, cnt in sorted(problem_counts.items(), key=lambda x: (-x[1], x[0])):
        if pid == "":
            problems_out.append({"id": "", "title": "Без проблемы", "count": cnt})
        else:
            problems_out.append({
                "id": pid,
                "title": problem_titles.get(pid, pid),
                "count": cnt,
            })

    nodes_out = [
        {"name": name, "count": cnt}
        for name, cnt in sorted(node_counts.items(), key=lambda x: (-x[1], x[0]))
    ]

    return {
        "period": {"start": start_date.isoformat(), "end": end_date.isoformat(), "days": len(days)},
        "data_range": charts_data_range(tickets),
        "days": day_isos,
        "complexes": complexes,
        "problems": problems_out,
        "nodes": nodes_out,
        "points": points,
        "skipped_no_day": skipped_no_day,
        "complex_counts": dict(complex_counts),
    }


# ---------------------------------------------------------------------------
# Недельный простой + монтаж/ПНР
# ---------------------------------------------------------------------------

MONTAGE_PNR_RE = re.compile(
    r"монтаж|демонтаж|пнр|пусконалад|пуско-налад|пуско\s+налад",
    re.IGNORECASE,
)


def is_montage_pnr(ticket: dict) -> bool:
    """Монтаж/ПНР по тексту заявки (отдельного workType в SD нет)."""
    blob = " ".join(
        str(ticket.get(k) or "")
        for k in ("title", "description", "workDone", "diagnosis")
    )
    return bool(MONTAGE_PNR_RE.search(blob))


def _iso_week_id(d: date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def _monday_of_iso_week(d: date) -> date:
    return d - timedelta(days=d.weekday())  # Mon=0


def _iter_iso_weeks(start_date: date, end_date: date) -> list[dict]:
    """Список ISO-недель, пересекающих [start_date, end_date]."""
    if end_date < start_date:
        return []
    cur = _monday_of_iso_weeks_start(start_date)
    weeks = []
    while cur <= end_date:
        week_end = cur + timedelta(days=6)
        y, w, _ = cur.isocalendar()
        weeks.append({
            "id": f"{y}-W{w:02d}",
            "start": cur.isoformat(),
            "end": week_end.isoformat(),
            "label": f"{y}-W{w:02d}",
        })
        cur += timedelta(days=7)
    return weeks


def _monday_of_iso_weeks_start(start_date: date) -> date:
    return _monday_of_iso_week(start_date)


def _split_interval_by_iso_week(
    start: datetime, end: datetime
) -> list[tuple[str, datetime, datetime]]:
    """Разбивает UTC-интервал на куски по ISO-неделям (по MSK-дате границ)."""
    if end <= start:
        return []
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)

    out: list[tuple[str, datetime, datetime]] = []
    cursor = start
    while cursor < end:
        day_msk = cursor.astimezone(MSK).date()
        week_mon = _monday_of_iso_week(day_msk)
        week_sun_end = datetime(
            week_mon.year, week_mon.month, week_mon.day, tzinfo=MSK
        ) + timedelta(days=7)
        week_end_utc = week_sun_end.astimezone(timezone.utc)
        piece_end = min(end, week_end_utc)
        if piece_end > cursor:
            out.append((_iso_week_id(day_msk), cursor, piece_end))
        cursor = piece_end
    return out


def _ticket_downtime_summary(t: dict, *, dt_hours, dt_reason, dt_start_field, onsite, sw_update, kind) -> dict:
    return {
        "id": t["id"],
        "code": t.get("code"),
        "title": t.get("title") or "",
        "client": t.get("client"),
        "object": t.get("object"),
        "complexes": ticket_f4_complexes(t),
        "node": t.get("node"),
        "kind": kind,
        "severity": t.get("severity"),
        "priority": t.get("priority"),
        "status": t.get("status"),
        "engineer": t.get("engineer"),
        "workType": t.get("workType"),
        "incidentAt": t.get("incidentAt"),
        "workStartedAt": t.get("workStartedAt"),
        "closedAt": t.get("closedAt"),
        "createdAt": t.get("createdAt"),
        "downtime_hours": round(dt_hours, 2) if dt_hours is not None else None,
        "downtime_reason": dt_reason,
        "downtime_start_field": dt_start_field,
        "onsite": onsite,
        "is_sw_update": sw_update,
        "is_montage_pnr": is_montage_pnr(t),
    }


def build_weekly_downtime_dataset(
    tickets: list[dict],
    start_date: date,
    end_date: date,
) -> dict:
    """Недельный простой F-4 с обрезкой по графику работы.

    - Комплекс действующий с даты первой заявки (min createdAt).
    - В часы флота не входят монтаж/ПНР (is_montage_pnr).
    - montage_tickets — даунтайм-заявки, отнесённые к монтажу/ПНР.
    """
    heatmap_cxs = f4_heatmap_complexes(tickets)

    # install_at = min createdAt по комплексу (все заявки, не только период)
    install_at: dict[str, datetime] = {}
    for t in tickets:
        cxs = ticket_f4_complexes(t)
        if not cxs:
            continue
        created = _parse_iso(t.get("createdAt"))
        if created is None:
            continue
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        for cx in cxs:
            if cx in F4_EXCLUDE_FROM_HEATMAP:
                continue
            prev = install_at.get(cx)
            if prev is None or created < prev:
                install_at[cx] = created

    # комплексы на оси: heatmap + те, у кого есть install
    complexes = sorted(
        set(heatmap_cxs) | {cx for cx in install_at if cx not in F4_EXCLUDE_FROM_HEATMAP},
        key=lambda c: [int(p) for p in c.split(".")],
    )

    weeks = _iter_iso_weeks(start_date, end_date)
    week_ids = [w["id"] for w in weeks]
    week_index = {wid: i for i, wid in enumerate(week_ids)}
    n_weeks = len(weeks)

    # n_active / fund per week
    n_active = [0] * n_weeks
    fund_hours = [0.0] * n_weeks
    for i, w in enumerate(weeks):
        w_start = date.fromisoformat(w["start"])
        w_end = date.fromisoformat(w["end"])
        for cx in complexes:
            inst = install_at.get(cx)
            if inst is None:
                continue
            inst_d = inst.astimezone(MSK).date()
            if inst_d > w_end:
                continue
            n_active[i] += 1
            # дни активности в неделе: от max(week_start, install) до week_end
            active_from = max(w_start, inst_d)
            active_to = min(w_end, end_date)
            if active_from > active_to:
                continue
            # пересечение с выбранным периодом отчёта
            period_from = max(active_from, start_date)
            period_to = min(w_end, end_date)
            if period_from > period_to:
                continue
            days_active = (period_to - period_from).days + 1
            gh = F4_GRAPH_HOURS.get(cx, F4_GRAPH_HOURS_DEFAULT)
            fund_hours[i] += gh * days_active

    hours_by_cx_week: dict[str, list[float]] = {
        cx: [0.0] * n_weeks for cx in complexes
    }
    # заявки по неделе (не монтаж) для drill
    week_ticket_map: dict[str, dict[str, dict]] = defaultdict(dict)  # week_id -> id -> summary
    montage_tickets: list[dict] = []
    montage_seen: set[str] = set()
    downtime_ticket_ids: set[str] = set()

    period_start_dt = datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)
    period_end_dt = datetime(end_date.year, end_date.month, end_date.day, tzinfo=timezone.utc) + timedelta(days=1)

    for t in tickets:
        cxs = [cx for cx in ticket_f4_complexes(t) if cx not in F4_EXCLUDE_FROM_HEATMAP]
        if not cxs:
            continue
        dt_start, dt_end, dt_hours, dt_reason, dt_start_field = compute_downtime(t)
        if dt_reason != "ok" or dt_start is None or dt_end is None:
            continue

        # пересечение с периодом
        s0 = max(dt_start if dt_start.tzinfo else dt_start.replace(tzinfo=timezone.utc), period_start_dt)
        e0 = min(dt_end if dt_end.tzinfo else dt_end.replace(tzinfo=timezone.utc), period_end_dt)
        if e0 <= s0:
            continue

        downtime_ticket_ids.add(t["id"])
        ws, end_dt, dur_hours, _ = compute_duration(t)
        onsite = is_onsite(t, dur_hours)
        sw_update = is_software_update(t)
        kind = get_kind(t)
        summary = _ticket_downtime_summary(
            t,
            dt_hours=dt_hours,
            dt_reason=dt_reason,
            dt_start_field=dt_start_field,
            onsite=onsite,
            sw_update=sw_update,
            kind=kind,
        )

        if is_montage_pnr(t):
            if t["id"] not in montage_seen:
                montage_seen.add(t["id"])
                montage_tickets.append(summary)
            continue

        # часы по комплексам с обрезкой по графику и разбивкой по неделям
        for cx in cxs:
            if cx not in hours_by_cx_week:
                hours_by_cx_week[cx] = [0.0] * n_weeks
                if cx not in complexes:
                    complexes.append(cx)
            clipped = clip_interval_to_graph(s0, e0, cx)
            for cs, ce in clipped:
                for wid, ps, pe in _split_interval_by_iso_week(cs, ce):
                    idx = week_index.get(wid)
                    if idx is None:
                        continue
                    # кусок должен пересекать выбранный период (уже обрезан)
                    hrs = (pe - ps).total_seconds() / 3600
                    if hrs <= 0:
                        continue
                    hours_by_cx_week[cx][idx] += hrs
                    entry = week_ticket_map[wid].get(t["id"])
                    if entry is None:
                        entry = {
                            **summary,
                            "week_hours": 0.0,
                            "hours_by_complex": {},
                        }
                        week_ticket_map[wid][t["id"]] = entry
                    entry["week_hours"] = round(entry["week_hours"] + hrs, 3)
                    hbc = entry["hours_by_complex"]
                    hbc[cx] = round(hbc.get(cx, 0.0) + hrs, 3)

    complexes = sorted(set(complexes), key=lambda c: [int(p) for p in c.split(".")])

    hours_total = [0.0] * n_weeks
    for cx in complexes:
        series = hours_by_cx_week.get(cx) or [0.0] * n_weeks
        for i in range(n_weeks):
            hours_total[i] += series[i]

    hours_per_active = []
    for i in range(n_weeks):
        n = n_active[i]
        hours_per_active.append(round(hours_total[i] / n, 3) if n else 0.0)

    hours_total = [round(h, 2) for h in hours_total]
    fund_hours = [round(h, 2) for h in fund_hours]

    complexes_out = []
    for cx in complexes:
        inst = install_at.get(cx)
        series = [round(h, 2) for h in (hours_by_cx_week.get(cx) or [0.0] * n_weeks)]
        complexes_out.append({
            "complex": cx,
            "install_at": inst.isoformat() if inst else None,
            "graph_hours": F4_GRAPH_HOURS.get(cx, F4_GRAPH_HOURS_DEFAULT),
            "hours": series,
        })

    montage_tickets.sort(key=lambda r: r.get("createdAt") or "", reverse=True)

    week_tickets = {
        wid: sorted(week_ticket_map[wid].values(), key=lambda r: r.get("code") or "")
        for wid in week_ids
        if wid in week_ticket_map
    }

    return {
        "period": {"start": start_date.isoformat(), "end": end_date.isoformat()},
        "weeks": weeks,
        "fleet": {
            "hours_total": hours_total,
            "hours_per_active": hours_per_active,
            "n_active": n_active,
            "fund_hours": fund_hours,
        },
        "complexes": complexes_out,
        "week_tickets": week_tickets,
        "montage_tickets": montage_tickets,
        "excluded_montage_count": len(montage_tickets),
        "downtime_ticket_count": len(downtime_ticket_ids),
        "data_range": charts_data_range(tickets),
    }
