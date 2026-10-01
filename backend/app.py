"""
Дашборд Service Desk — локальный веб-сервер (FastAPI).

Три вкладки на фронте:
  1. Заявки — все заявки за период, редактирование любых полей.
  2. Проблемы — список по новизне, детали + привязанные заявки.
  3. Отчёт — даунтайм флота F-4 (теплокарта, сводка, bar chart).

Бэкенд — тонкая обвязка над connectors/servicedesk/client.py (тот же
cookie-based клиент, что и остальные скрипты). Данные кэшируются в памяти
(TTL ниже) — get_tickets() тянет весь список (с ~2026-09 без base64
вложений в списке, файлы подгружаются через get_ticket(id)); дашборд
не должен дёргать API на каждый клик.

Запуск: см. README.md рядом (или просто `python app.py` из этой папки).
"""

import json
import os
import sys
import time
import tempfile
import threading
from datetime import datetime, date, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel
from dotenv import load_dotenv

SERVICEDESK_DIR = str((Path(__file__).resolve().parent.parent.parent / "connectors" / "servicedesk"))
sys.path.insert(0, SERVICEDESK_DIR)

os.chdir(SERVICEDESK_DIR)  # чтобы load_dotenv() и STATE_PATH по умолчанию нашли .env/servicedesk_state.json
load_dotenv()

from client import ServiceDeskClient, ServiceDeskAuthError, ServiceDeskWriteError, ServiceDeskTicketNotFound  # noqa: E402

import analysis  # noqa: E402

BASE_URL = os.environ.get("SERVICEDESK_BASE_URL", "https://sd.drinkx.tech")
STATE_PATH = os.environ.get("SERVICEDESK_STATE_PATH", "./servicedesk_state.json")
CACHE_TTL_SECONDS = 120

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

app = FastAPI(title="Service Desk Dashboard")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

_client = None
_lock = threading.Lock()
_cache = {"tickets": None, "problems": None, "fetched_at": 0.0, "error": None}
# Полные заявки с files[].dataUrl — отдельно от списочного кэша.
# Открытие карточки кладёт сюда результат GET /tickets/{id}; следующий
# PATCH переиспользует его вместо второго тяжёлого GET к SD (часто
# именно он ощущался как "долго сохраняется").
DETAIL_CACHE_TTL_SECONDS = 180
_detail_cache: dict[str, tuple[float, dict]] = {}


def get_client() -> ServiceDeskClient:
    global _client
    if _client is None:
        _client = ServiceDeskClient(BASE_URL, STATE_PATH)
    return _client


def _get_ticket_full(c: ServiceDeskClient, ticket_id: str, *, force: bool = False) -> dict:
    """Полная заявка (с dataUrl). Свежий детальный кэш — без повторного GET."""
    if not force:
        with _lock:
            entry = _detail_cache.get(ticket_id)
            if entry and (time.time() - entry[0]) < DETAIL_CACHE_TTL_SECONDS:
                return dict(entry[1])
    t = c.get_ticket(ticket_id)
    with _lock:
        _detail_cache[ticket_id] = (time.time(), t)
    return dict(t)


def _store_ticket_full(t: dict) -> None:
    tid = t.get("id")
    if not tid:
        return
    with _lock:
        _detail_cache[tid] = (time.time(), t)


def _merge_files_from_base(updated: dict, base: dict) -> dict:
    """Ответ PUT иногда без dataUrl — не затираем уже известные вложения в кэше."""
    upd_files = updated.get("files") or []
    if any(isinstance(f, dict) and f.get("dataUrl") for f in upd_files):
        return updated
    base_files = base.get("files") or []
    if not base_files:
        return updated
    out = dict(updated)
    out["files"] = base_files
    return out


def refresh_cache(force: bool = False):
    with _lock:
        age = time.time() - _cache["fetched_at"]
        if not force and _cache["tickets"] is not None and age < CACHE_TTL_SECONDS:
            return _cache
        try:
            c = get_client()
            tickets = c.get_tickets()
            problems = c.get_problems()
            _cache["tickets"] = tickets
            _cache["problems"] = problems
            _cache["fetched_at"] = time.time()
            _cache["error"] = None
            if force:
                _detail_cache.clear()
        except (ServiceDeskAuthError, Exception) as e:  # noqa: BLE001
            _cache["error"] = str(e)
            if _cache["tickets"] is None:
                raise
        return _cache


def _strip_files(t: dict) -> dict:
    """Убирает base64 dataUrl из files[] для списковых ответов — тяжёлые, не нужны в списке."""
    t = dict(t)
    t["files"] = [{k: v for k, v in f.items() if k != "dataUrl"} for f in t.get("files", [])]
    return t


def _update_cache_ticket(updated: dict) -> None:
    """Точечно подменяет одну заявку в кэше списка после PATCH/upload —
    БЕЗ полного refresh_cache(force=True). Полный refetch тянет весь список
    заявок со всеми фото (медленно, десятки секунд на 200+ заявках) — если
    делать это синхронно на каждое сохранение, дашборд ощущается "зависшим"
    при любой правке. Кэш и так протухнет сам через CACHE_TTL_SECONDS и
    подтянет актуальное состояние остальных заявок при следующем обращении
    к списку; здесь важно только не показывать устаревшую версию ИМЕННО
    этой заявки до следующего протухания."""
    with _lock:
        tickets = _cache.get("tickets")
        if tickets is None:
            return
        for i, t in enumerate(tickets):
            if t.get("id") == updated.get("id"):
                tickets[i] = updated
                return
        tickets.append(updated)


@app.on_event("startup")
def _startup():
    try:
        refresh_cache(force=True)
    except Exception as e:  # noqa: BLE001
        print(f"[startup] не удалось загрузить данные при старте: {e}")


@app.get("/api/health")
def health():
    # refresh_cache() пробрасывает исключение, если это САМЫЙ первый неудачный
    # фетч (tickets ещё None, кэшировать нечего) — например сразу после
    # рестарта сервера с протухшей кукой. /api/health должен ВСЕГДА отдавать
    # чистый JSON {ok:false, error:...}, а не 500, иначе фронтенд-баннер
    # "сессия истекла" не увидит эту самую первую поломку (см. CookieModal).
    try:
        cache = refresh_cache()
        error = cache["error"]
        tickets_count = len(cache["tickets"] or [])
        problems_count = len(cache["problems"] or [])
        fetched_at = cache["fetched_at"]
    except Exception as e:  # noqa: BLE001
        error = str(e)
        tickets_count = 0
        problems_count = 0
        fetched_at = 0.0
    return {
        "ok": error is None,
        "error": error,
        "tickets_count": tickets_count,
        "problems_count": problems_count,
        "fetched_at": fetched_at,
    }


@app.post("/api/refresh")
def refresh():
    cache = refresh_cache(force=True)
    return {"ok": cache["error"] is None, "error": cache["error"],
            "tickets_count": len(cache["tickets"] or []), "problems_count": len(cache["problems"] or [])}


class CookieUpdate(BaseModel):
    cookie: str


def _parse_cookie_header(raw: str) -> list[dict]:
    """Тот же парсер, что в import_cookie.py — продублирован здесь (а не
    импортирован), чтобы этот эндпоинт не зависел от интерактивного main()
    того модуля."""
    cookies = []
    for part in raw.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, value = part.split("=", 1)
        cookies.append({"name": name.strip(), "value": value.strip()})
    return cookies


@app.post("/api/admin/cookie")
def update_cookie(body: CookieUpdate):
    """Ручное обновление сессии Service Desk без похода в терминал —
    веб-эквивалент import_cookie.py. Пользователь вставляет строку cookie
    из DevTools (или через copy(document.cookie) в консоли на залогиненной
    вкладке sd.drinkx.tech), мы её парсим, пишем в STATE_PATH и пересоздаём
    клиента (cookies читаются один раз в ServiceDeskClient.__init__, так что
    простой перезаписи файла недостаточно — нужно сбросить _client)."""
    cookies = _parse_cookie_header(body.cookie)
    if not cookies:
        raise HTTPException(400, "Не нашёл ни одной пары name=value — проверь, что вставил именно значение cookie.")

    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump({"cookies": cookies}, f, ensure_ascii=False, indent=2)

    global _client
    with _lock:
        _client = None
        _cache["tickets"] = None
        _cache["problems"] = None
        _cache["fetched_at"] = 0.0
        _cache["error"] = None

    try:
        refresh_cache(force=True)
    except ServiceDeskAuthError as e:
        raise HTTPException(401, f"Cookie сохранён, но Service Desk всё равно вернул ошибку авторизации: {e}")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"Cookie сохранён, но не удалось связаться с Service Desk: {e}")

    names = ", ".join(c["name"] for c in cookies)
    return {"ok": True, "cookies_saved": len(cookies), "names": names}


def _parse_date(s: str) -> date:
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise HTTPException(400, f"Неверный формат даты: {s!r}, ожидается YYYY-MM-DD")


@app.get("/api/tickets")
def list_tickets(start: str | None = None, end: str | None = None, date_field: str = "incidentAt",
                  complex: str | None = None):
    cache = refresh_cache()
    tickets = cache["tickets"] or []
    if start or end:
        c = get_client()
        tickets = c.get_tickets_in_range(start, end, date_field=date_field, tickets=tickets)
    if complex:
        def _matches_complex(t):
            needle = complex.strip()
            norm_needle = analysis.normalize_f4_complex(needle) or needle
            for c in (t.get("complexes") or []):
                if c == needle or c == norm_needle:
                    return True
                if analysis.normalize_f4_complex(c) == norm_needle:
                    return True
            return False
        tickets = [t for t in tickets if _matches_complex(t)]

    out = []
    for t in tickets:
        ws, end_dt, hours, reason = analysis.compute_duration(t)
        neg_response, neg_response_hours = analysis.is_negative_response(t)
        dt_start, dt_end, dt_hours, dt_reason, dt_start_field = analysis.compute_downtime(t)
        out.append({
            "id": t["id"], "code": t.get("code"), "title": t.get("title"),
            "client": t.get("client"), "object": t.get("object"), "complexes": t.get("complexes"),
            "node": t.get("node"), "status": t.get("status"), "severity": t.get("severity"),
            "priority": t.get("priority"), "engineer": t.get("engineer"),
            "workType": t.get("workType"), "workResult": t.get("workResult"),
            "createdAt": t.get("createdAt"), "incidentAt": t.get("incidentAt"),
            "workStartedAt": t.get("workStartedAt"), "closedAt": t.get("closedAt"),
            "duration_hours": round(hours, 2) if hours is not None else None,
            "duration_reason": reason,
            "negative_response": neg_response, "response_hours_negative": neg_response_hours,
            "downtime_hours": round(dt_hours, 2) if dt_hours is not None else None,
            "downtime_reason": dt_reason, "downtime_start_field": dt_start_field,
            "problemId": t.get("problemId"),
            "files_count": len(t.get("files") or []),
        })
    out.sort(key=lambda r: r.get("incidentAt") or "", reverse=True)
    return {"count": len(out), "tickets": out}


@app.get("/api/tickets/{ticket_id}")
def get_ticket(ticket_id: str):
    """Читает заявку НАПРЯМУЮ через GET /api/prototype/tickets/{id} (а не из
    списочного кэша) — это единственный способ получить полноразмерные
    files[].dataUrl. Повторные чтения в пределах DETAIL_CACHE_TTL_SECONDS
    берутся из детального кэша (открыл карточку → сохранил без второго GET)."""
    c = get_client()
    try:
        t = _get_ticket_full(c, ticket_id)
    except ServiceDeskAuthError as e:
        raise HTTPException(401, str(e))
    except Exception as e:  # noqa: BLE001 — 404/сеть/5xx, пробуем взять из кэша со срезанными файлами
        try:
            cache = refresh_cache()
        except Exception:  # noqa: BLE001 — кэш тоже пуст и сеть недоступна
            raise HTTPException(503, f"Не удалось связаться с Service Desk (sd.drinkx.tech) — проверьте сеть/VPN. {e}")
        t = None
        for tt in cache["tickets"] or []:
            if tt["id"] == ticket_id:
                t = _strip_files(tt)
                break
        if t is None:
            raise HTTPException(404, "Заявка не найдена (обнови кэш /api/refresh, если создана только что)")
    return _enrich_ticket(t)


def _enrich_ticket(t: dict) -> dict:
    """Добавляет к сырому объекту заявки вычисляемые поля (длительность,
    флаги для ручной проверки) — те же, что видит вкладка "Заявки" в
    списке, но здесь на одной заявке. Ключи не пересекаются с полями самого
    Service Desk, так что просто домешиваем в тот же dict."""
    t = dict(t)
    ws, end_dt, hours, reason = analysis.compute_duration(t)
    neg_response, neg_response_hours = analysis.is_negative_response(t)
    dt_start, dt_end, dt_hours, dt_reason, dt_start_field = analysis.compute_downtime(t)
    t["duration_hours"] = round(hours, 2) if hours is not None else None
    t["duration_reason"] = reason
    t["negative_response"] = neg_response
    t["response_hours_negative"] = neg_response_hours
    t["downtime_hours"] = round(dt_hours, 2) if dt_hours is not None else None
    t["downtime_reason"] = dt_reason
    t["downtime_start_field"] = dt_start_field
    return t


class TicketPatch(BaseModel):
    fields: dict
    event: str | None = None


@app.patch("/api/tickets/{ticket_id}")
def patch_ticket(ticket_id: str, body: TicketPatch):
    c = get_client()
    try:
        # Детальный кэш после открытия карточки — без повторного GET к SD.
        # force только если кэша нет (_get_ticket_full сам сходит в сеть).
        base = _get_ticket_full(c, ticket_id)
        fields = dict(body.fields or {})
        # complexes — массив serial'ов; нормализуем к list[str]
        if "complexes" in fields:
            raw = fields["complexes"]
            if raw is None:
                fields["complexes"] = []
            elif isinstance(raw, str):
                fields["complexes"] = [raw] if raw.strip() else []
            elif isinstance(raw, list):
                fields["complexes"] = [str(x) for x in raw if x]
            else:
                raise HTTPException(400, "fields.complexes должен быть массивом строк")
        updated = c.update_ticket(
            ticket_id, fields,
            event=body.event or "Изменено через дашборд",
            diff=", ".join(f"{k}={v}" for k, v in fields.items()),
            actor="Дашборд (AI-агент)",
            base_ticket=base,
        )
        updated = _merge_files_from_base(updated, base)
        _store_ticket_full(updated)
    except ServiceDeskTicketNotFound as e:
        raise HTTPException(404, str(e))
    except ServiceDeskWriteError as e:
        raise HTTPException(400, str(e))
    except ServiceDeskAuthError as e:
        raise HTTPException(401, str(e))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — обычно ConnectionError от curl_cffi: sd.drinkx.tech недоступен
        raise HTTPException(503, f"Не удалось связаться с Service Desk (sd.drinkx.tech) — проверьте сеть/VPN. {e}")
    _update_cache_ticket(updated)
    return _enrich_ticket(_strip_files(updated))


@app.delete("/api/tickets/{ticket_id}")
def delete_ticket(ticket_id: str):
    """Удаляет заявку в Service Desk (безвозвратно). Нужна роль service_manager."""
    c = get_client()
    try:
        c.delete_ticket(ticket_id)
    except ServiceDeskTicketNotFound as e:
        raise HTTPException(404, str(e))
    except ServiceDeskWriteError as e:
        raise HTTPException(400, str(e))
    except ServiceDeskAuthError as e:
        raise HTTPException(401, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"Не удалось связаться с Service Desk (sd.drinkx.tech) — проверьте сеть/VPN. {e}")
    with _lock:
        tickets = _cache.get("tickets")
        if tickets is not None:
            _cache["tickets"] = [t for t in tickets if t.get("id") != ticket_id]
        _detail_cache.pop(ticket_id, None)
    return {"ok": True, "deleted": ticket_id}


@app.post("/api/tickets/{ticket_id}/files")
async def upload_ticket_file(ticket_id: str, file: UploadFile = File(...)):
    """Прикрепляет файл (фото/акт/что угодно) к заявке — оборачивает
    client.upload_file(), который сам кладёт base64 в files[].dataUrl тем
    же PUT, что и любое другое изменение заявки (см. докстринг client.py —
    отдельного upload-эндпоинта у Service Desk нет)."""
    c = get_client()
    data = await file.read()
    suffix = Path(file.filename or "file").suffix
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(data)
        tmp_path = tmp.name
    try:
        # upload_file() сам подставляет p.name из пути — переименовываем
        # временный файл на исходное имя рядом, чтобы в заявке осталось
        # человекочитаемое имя, а не случайный tmp-хэш.
        real_path = Path(tmp_path).with_name(file.filename or Path(tmp_path).name)
        Path(tmp_path).replace(real_path)
        base = _get_ticket_full(c, ticket_id)
        updated = c.upload_file(ticket_id, str(real_path), actor="Дашборд (AI-агент)", base_ticket=base)
        updated = _merge_files_from_base(updated, base)
        _store_ticket_full(updated)
    except ServiceDeskTicketNotFound as e:
        raise HTTPException(404, str(e))
    except ServiceDeskWriteError as e:
        raise HTTPException(400, str(e))
    except ServiceDeskAuthError as e:
        raise HTTPException(401, str(e))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — обычно ConnectionError от curl_cffi: sd.drinkx.tech недоступен
        raise HTTPException(503, f"Не удалось связаться с Service Desk (sd.drinkx.tech) — проверьте сеть/VPN. {e}")
    finally:
        try:
            real_path.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass
    _update_cache_ticket(updated)
    return _enrich_ticket(_strip_files(updated))


class ProblemCreate(BaseModel):
    title: str
    description: str | None = None


@app.post("/api/problems")
def create_problem(body: ProblemCreate):
    """Создаёт новую проблему прямо из карточки заявки (когда нужной нет в
    списке привязки) — тонкая обёртка над client.create_problem(). Кладём
    в кэш точечно (как _update_cache_ticket), без полного refresh."""
    c = get_client()
    try:
        created = c.create_problem(title=body.title, description=body.description or "")
    except ServiceDeskAuthError as e:
        raise HTTPException(401, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"Не удалось связаться с Service Desk (sd.drinkx.tech) — проверьте сеть/VPN. {e}")
    with _lock:
        problems = _cache["problems"]
        if problems is None:
            problems = []
        problems.append(created)
        _cache["problems"] = problems
    return created


class ProblemPatch(BaseModel):
    title: str | None = None
    description: str | None = None


@app.patch("/api/problems/{problem_id}")
def patch_problem(problem_id: str, body: ProblemPatch):
    """Обновляет title/description проблемы (для merge и правок из UI)."""
    changes = {k: v for k, v in body.model_dump().items() if v is not None}
    if not changes:
        raise HTTPException(400, "Нет полей для обновления")
    c = get_client()
    try:
        cache = refresh_cache()
        base = next((p for p in (cache["problems"] or []) if p["id"] == problem_id), None)
        updated = c.update_problem(problem_id, changes, base_problem=base)
    except ServiceDeskAuthError as e:
        raise HTTPException(401, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"Не удалось связаться с Service Desk (sd.drinkx.tech) — проверьте сеть/VPN. {e}")
    with _lock:
        problems = _cache.get("problems") or []
        for i, p in enumerate(problems):
            if p.get("id") == problem_id:
                problems[i] = updated
                break
        else:
            problems.append(updated)
        _cache["problems"] = problems
    return updated


@app.delete("/api/problems/{problem_id}")
def delete_problem(problem_id: str):
    """Удаляет проблему. Заявки с этим problemId сами не отвязываются —
    перед удалением при merge их нужно перепривязать на целевую."""
    c = get_client()
    try:
        c.delete_problem(problem_id)
    except ServiceDeskAuthError as e:
        raise HTTPException(401, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"Не удалось связаться с Service Desk (sd.drinkx.tech) — проверьте сеть/VPN. {e}")
    with _lock:
        problems = _cache.get("problems")
        if problems is not None:
            _cache["problems"] = [p for p in problems if p.get("id") != problem_id]
    return {"ok": True, "deleted": problem_id}


@app.get("/api/problems")
def list_problems():
    cache = refresh_cache()
    tickets = cache["tickets"] or []
    problems = cache["problems"] or []
    out = []
    for p in problems:
        linked = [t for t in tickets if t.get("problemId") == p["id"]]
        dates = [t.get("createdAt") for t in linked if t.get("createdAt")]
        out.append({
            "id": p["id"], "title": p.get("title"), "description": p.get("description"),
            "ticket_count": len(linked),
            "open_count": sum(1 for t in linked if t.get("status") != "Закрыта"),
            "last_activity": max(dates) if dates else None,
            "first_seen": min(dates) if dates else None,
        })
    # новые сверху: по last_activity (нет тикетов - в конец), см. README про отсутствие
    # даты создания у самой сущности problem в API.
    out.sort(key=lambda r: r["last_activity"] or "", reverse=True)
    return {"count": len(out), "problems": out}


@app.get("/api/problems/{problem_id}")
def get_problem(problem_id: str):
    cache = refresh_cache()
    problems = cache["problems"] or []
    problem = next((p for p in problems if p["id"] == problem_id), None)
    if not problem:
        raise HTTPException(404, "Проблема не найдена")
    tickets = cache["tickets"] or []
    linked = [t for t in tickets if t.get("problemId") == problem_id]
    linked_summary = []
    for t in linked:
        ws, end_dt, hours, reason = analysis.compute_duration(t)
        neg_response, neg_response_hours = analysis.is_negative_response(t)
        linked_summary.append({
            "id": t["id"], "code": t.get("code"), "title": t.get("title"),
            "status": t.get("status"), "severity": t.get("severity"),
            "createdAt": t.get("createdAt"), "client": t.get("client"), "object": t.get("object"),
            "complexes": t.get("complexes"), "duration_hours": round(hours, 2) if hours is not None else None,
            "duration_reason": reason,
            "negative_response": neg_response, "response_hours_negative": neg_response_hours,
        })
    linked_summary.sort(key=lambda r: r.get("createdAt") or "", reverse=True)
    return {**problem, "tickets": linked_summary}


@app.get("/api/report/f4")
def report_f4(start: str, end: str):
    start_d = _parse_date(start)
    end_d = _parse_date(end)
    if end_d < start_d:
        raise HTTPException(400, "end раньше start")
    cache = refresh_cache()
    tickets = cache["tickets"] or []
    return analysis.build_report(tickets, start_d, end_d)


@app.get("/api/report/charts")
def report_charts(start: str, end: str):
    """Точки для вкладки «Графики» (простой / время на объекте). Фильтры
    комплексов/проблем/узлов — на клиенте по points[]."""
    start_d = _parse_date(start)
    end_d = _parse_date(end)
    if end_d < start_d:
        raise HTTPException(400, "end раньше start")
    cache = refresh_cache()
    tickets = cache["tickets"] or []
    problems = cache["problems"] or []
    return analysis.build_charts_dataset(tickets, start_d, end_d, problems=problems)


@app.get("/api/report/weekly")
def report_weekly(start: str, end: str):
    """Недельный простой F-4 (обрезка по графику работы, без монтажа/ПНР)
    + список заявок монтажа/ПНР, прошедших фильтр даунтайма."""
    start_d = _parse_date(start)
    end_d = _parse_date(end)
    if end_d < start_d:
        raise HTTPException(400, "end раньше start")
    cache = refresh_cache()
    tickets = cache["tickets"] or []
    return analysis.build_weekly_downtime_dataset(tickets, start_d, end_d)


@app.get("/api/meta")
def meta():
    """Справочники для форм редактирования и фильтров на фронте: реально
    встречающиеся значения severity/priority/status/node (не гадаем по
    бандлу — берём с живых данных), плюс инженеры/клиенты/объекты/комплексы
    для дропдаунов. workTypes/failureReasons — из dictionary-groups SD
    (как в самом Service Desk); workResults — фиксированный enum UI."""
    cache = refresh_cache()
    tickets = cache["tickets"] or []
    c = get_client()

    def uniq(field):
        return sorted({t.get(field) for t in tickets if t.get(field)})

    try:
        employees = c.get_employees()
    except Exception:  # noqa: BLE001
        employees = []
    try:
        clients = c.get_clients()
    except Exception:  # noqa: BLE001
        clients = []
    try:
        objects = c.get_objects()
    except Exception:  # noqa: BLE001
        objects = []
    try:
        complexes = c.get_complexes()
    except Exception:  # noqa: BLE001
        complexes = []

    work_types: list[str] = []
    failure_reasons: list[str] = []
    try:
        for g in c.get_dictionary_groups() or []:
            names = sorted(
                (it.get("name") for it in (g.get("items") or []) if it.get("active") and it.get("name")),
                key=lambda s: s.casefold(),
            )
            if g.get("id") == "work-types":
                work_types = names
            elif g.get("id") == "failure-reasons":
                failure_reasons = names
    except Exception:  # noqa: BLE001
        pass
    # Фолбэк: если справочник недоступен — уникальные значения с живых заявок.
    if not work_types:
        work_types = uniq("workType")
    if not failure_reasons:
        failure_reasons = uniq("failureReason")

    # Серийный номер / канонический 4.N -> человекочитаемое название.
    # В SD serial часто "4.22 Яндекс Лавка" — кладём и полный ключ, и
    # нормализованный "4.22" (теплокарта/сводка работают с каноном).
    complex_names: dict[str, str] = {}
    for x in complexes:
        serial = x.get("serial")
        if not serial:
            continue
        label_parts = [p for p in (x.get("client"), x.get("object")) if p]
        label = " / ".join(label_parts)
        if not label:
            # если client/object пусты — используем хвост serial после кода
            norm = analysis.normalize_f4_complex(serial)
            if norm and serial.strip() != norm:
                label = serial.strip()[len(norm):].strip() or serial
            else:
                continue
        if serial not in complex_names or (not complex_names[serial] and label):
            complex_names[serial] = label
        norm = analysis.normalize_f4_complex(serial)
        if norm and (norm not in complex_names or len(label) >= len(complex_names.get(norm) or "")):
            complex_names[norm] = label

    # Результат работ — не dictionary-group, а фиксированный enum SPA.
    work_results = sorted({
        *(uniq("workResult")),
        "Проблема решена",
        "Требуется повторный выезд",
    })

    return {
        "severities": uniq("severity"),
        "priorities": uniq("priority"),
        "statuses": uniq("status"),
        "nodes": uniq("node"),
        "workTypes": work_types,
        "failureReasons": failure_reasons,
        "workResults": work_results,
        "engineers": sorted({e.get("fullName") for e in employees if e.get("fullName")}),
        "clients": sorted({x.get("brandName") for x in clients if x.get("brandName")}),
        "objects": sorted({o.get("name") for o in objects if o.get("name")}),
        "complexes": sorted({x.get("serial") for x in complexes if x.get("serial")}),
        "complex_names": complex_names,
        "problems": [{"id": p["id"], "title": p.get("title")} for p in (cache["problems"] or [])],
        "f4_complexes": analysis.discover_f4_complexes(tickets),
        "f4_heatmap_complexes": analysis.f4_heatmap_complexes(tickets),
        "kind_labels": analysis.KIND_LABELS,
    }


# --- фронтенд без кэша браузера ---
# StaticFiles ниже отдаёт файлы с обычными эвристическими заголовками
# кэша — при активной разработке браузер может показывать старую версию
# после правки файла даже при Cache-Control: no-cache (условный запрос
# может тихо получить 304 в некоторых браузерах/прокси). Надёжнее —
# versioned query string (?v=mtime): при каждой правке файла на диске его
# mtime меняется, значит меняется и URL, значит браузер ГАРАНТИРОВАННО не
# может отдать старый закэшированный ответ (это буквально другой URL).
# Явные роуты ниже, ПЕРЕД mount(), перехватывают "/", "/app.js",
# "/style.css" и index.html отдаём не статикой, а с подставленной версией.
def _mtime(path: Path) -> int:
    try:
        return int(path.stat().st_mtime)
    except OSError:
        return 0


@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
def index_html():
    html = (FRONTEND_DIR / "index.html").read_text(encoding="utf-8")
    html = html.replace('href="/style.css"', f'href="/style.css?v={_mtime(FRONTEND_DIR / "style.css")}"')
    html = html.replace('src="/app.js"', f'src="/app.js?v={_mtime(FRONTEND_DIR / "app.js")}"')
    return HTMLResponse(html, headers={"Cache-Control": "no-cache, must-revalidate"})


@app.get("/app.js")
def app_js():
    return FileResponse(FRONTEND_DIR / "app.js", media_type="application/javascript",
                         headers={"Cache-Control": "no-cache, must-revalidate"})


@app.get("/style.css")
def style_css():
    return FileResponse(FRONTEND_DIR / "style.css", media_type="text/css",
                         headers={"Cache-Control": "no-cache, must-revalidate"})


# --- статика фронтенда (в самом конце — чтобы не перехватывала /api/*) ---
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("DASHBOARD_PORT", "8765"))
    print(f"Дашборд: http://localhost:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port)
