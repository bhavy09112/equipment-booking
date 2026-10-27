"""Single-host synthetic demo. Demo identity headers are not authentication."""
import json
import os
import re
import sqlite3
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

EQUIPMENT = [(1, "Survey drone", "Flight planning · bench use only"),
             (2, "Thermal camera", "Imaging · calibration kit included"),
             (3, "Signal analyzer", "Electronics · shared lab instrument")]


class Reservation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    equipment_id: int = Field(ge=1)
    start: datetime
    end: datetime

    @field_validator("start", "end")
    @classmethod
    def utc(cls, value):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Use a timezone offset or Z")
        return value.astimezone(timezone.utc)

    @model_validator(mode="after")
    def interval(self):
        if self.end <= self.start:
            raise ValueError("End must be after start")
        if (self.end - self.start).total_seconds() > 7 * 86400:
            raise ValueError("Maximum booking length is seven days")
        return self


def caller(x_demo_member: Annotated[str, Header()]):
    if x_demo_member not in ("alex", "sam"):
        raise HTTPException(401, "Choose a demo member: alex or sam")
    return x_demo_member


def create_app(db_path=None, static_dir=None, busy_ms=1000):
    database = str(db_path or os.environ.get("BOOKING_DB", "booking.db"))

    def connect():
        db = sqlite3.connect(database, timeout=busy_ms / 1000)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        return db

    @contextmanager
    def transaction():
        db = connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except sqlite3.OperationalError as exc:
            db.rollback()
            if "locked" in str(exc).lower() or "busy" in str(exc).lower():
                raise HTTPException(503, "Database busy; retry with the same request key",
                                    headers={"Retry-After": "1"}) from exc
            raise
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @asynccontextmanager
    async def lifespan(app):
        with connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS equipment(id INTEGER PRIMARY KEY, name TEXT, description TEXT);
                CREATE TABLE IF NOT EXISTS reservations(
                  id INTEGER PRIMARY KEY, equipment_id INTEGER NOT NULL REFERENCES equipment(id),
                  member TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
                  status TEXT NOT NULL CHECK(status IN ('active','cancelled')));
                CREATE INDEX IF NOT EXISTS availability ON reservations(equipment_id,status,start,end);
                CREATE TABLE IF NOT EXISTS requests(
                  member TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL,
                  reservation_id INTEGER NOT NULL REFERENCES reservations(id), PRIMARY KEY(member,key));
                CREATE TABLE IF NOT EXISTS audit(
                  id INTEGER PRIMARY KEY, reservation_id INTEGER NOT NULL REFERENCES reservations(id),
                  member TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL);
            """)
            db.executemany("INSERT OR IGNORE INTO equipment VALUES(?,?,?)", EQUIPMENT)
        db.close()
        yield

    app = FastAPI(title="Equipment Booking · synthetic demo", lifespan=lifespan)

    @app.middleware("http")
    async def local_origin(request: Request, call_next):
        # No cross-origin mutations. Demo access remains deliberately public on this host.
        origin = request.headers.get("origin")
        if request.method not in ("GET", "HEAD", "OPTIONS") and origin:
            if origin != str(request.base_url).rstrip("/"):
                return JSONResponse({"detail": "Cross-origin mutation rejected"}, status_code=403)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    def rows(query, args=()):
        db = connect()
        try:
            return [dict(r) for r in db.execute(query, args)]
        finally:
            db.close()

    @app.get("/api/equipment")
    def equipment():
        return rows("SELECT * FROM equipment ORDER BY id")

    @app.get("/api/reservations")
    def reservations():
        return rows("SELECT * FROM reservations ORDER BY start,id")

    @app.get("/api/audit")
    def audit():
        return rows("SELECT * FROM audit ORDER BY id DESC LIMIT 100")

    from fastapi import Depends

    @app.post("/api/reservations", status_code=201)
    def reserve(body: Reservation, response: JSONResponse,
                member: Annotated[str, Depends(caller)],
                idempotency_key: Annotated[str, Header()]):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", idempotency_key):
            raise HTTPException(422, "Request key must contain 1–80 letters, digits, _ or -")
        payload = json.dumps(body.model_dump(mode="json"), sort_keys=True)
        start, end = body.start.isoformat(timespec="microseconds"), body.end.isoformat(timespec="microseconds")
        with transaction() as db:
            prior = db.execute("SELECT * FROM requests WHERE member=? AND key=?", (member, idempotency_key)).fetchone()
            if prior:
                if prior["payload"] != payload:
                    raise HTTPException(409, "Request key already used for a different booking")
                response.status_code = 200
                return dict(db.execute("SELECT * FROM reservations WHERE id=?", (prior["reservation_id"],)).fetchone())
            if not db.execute("SELECT 1 FROM equipment WHERE id=?", (body.equipment_id,)).fetchone():
                raise HTTPException(404, "Equipment not found")
            overlap = db.execute("""SELECT 1 FROM reservations WHERE equipment_id=? AND status='active'
                AND start < ? AND end > ?""", (body.equipment_id, end, start)).fetchone()
            if overlap:
                raise HTTPException(409, "That equipment is already reserved during this interval")
            rid = db.execute("INSERT INTO reservations(equipment_id,member,start,end,status) VALUES(?,?,?,?,'active')",
                             (body.equipment_id, member, start, end)).lastrowid
            db.execute("INSERT INTO requests VALUES(?,?,?,?)", (member, idempotency_key, payload, rid))
            db.execute("INSERT INTO audit(reservation_id,member,action,at) VALUES(?,?,'created',?)",
                       (rid, member, datetime.now(timezone.utc).isoformat()))
            return dict(db.execute("SELECT * FROM reservations WHERE id=?", (rid,)).fetchone())

    @app.post("/api/reservations/{rid}/cancel")
    def cancel(rid: int, member: Annotated[str, Depends(caller)]):
        with transaction() as db:
            row = db.execute("SELECT * FROM reservations WHERE id=?", (rid,)).fetchone()
            if not row:
                raise HTTPException(404, "Reservation not found")
            if row["member"] != member:
                raise HTTPException(403, "Only the booking's demo member can cancel it")
            if row["status"] == "active":
                db.execute("UPDATE reservations SET status='cancelled' WHERE id=?", (rid,))
                db.execute("INSERT INTO audit(reservation_id,member,action,at) VALUES(?,?,'cancelled',?)",
                           (rid, member, datetime.now(timezone.utc).isoformat()))
            return dict(db.execute("SELECT * FROM reservations WHERE id=?", (rid,)).fetchone())

    static = Path(static_dir or Path(__file__).parent / "frontend" / "dist")
    if static.exists():
        app.mount("/", StaticFiles(directory=static, html=True), name="ui")
    return app


app = create_app()
