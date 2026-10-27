import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type Equipment = { id: number; name: string; description: string };
type Booking = {
  id: number;
  equipment_id: number;
  member: string;
  start: string;
  end: string;
  status: string;
};
type Audit = {
  id: number;
  reservation_id: number;
  member: string;
  action: string;
  at: string;
};
const showTime = (s: string) =>
  new Date(s).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
function App() {
  const [equipment, setEquipment] = useState<Equipment[]>([]),
    [bookings, setBookings] = useState<Booking[]>([]),
    [audit, setAudit] = useState<Audit[]>([]);
  const [member, setMember] = useState("alex"),
    [selected, setSelected] = useState(1),
    [start, setStart] = useState(""),
    [end, setEnd] = useState("");
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState<{ payload: string; key: string } | null>(null);
  async function refresh() {
    const responses = await Promise.all(
      ["/equipment", "/reservations", "/audit"].map((p) => fetch("/api" + p)),
    );
    if (responses.some((r) => !r.ok))
      throw new Error("Could not refresh. Please try again.");
    const [e, b, a] = await Promise.all(responses.map((r) => r.json()));
    setEquipment(e);
    setBookings(b);
    setAudit(a);
  }
  useEffect(() => {
    refresh().catch((e) => setMessage(e.message));
  }, []);
  async function reserve(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    const body = {
      equipment_id: selected,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    };
    const payload = JSON.stringify({ member, ...body });
    const key = retry?.payload === payload ? retry.key : crypto.randomUUID();
    setRetry({ payload, key });
    try {
      const r = await fetch("/api/reservations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Demo-Member": member,
          "Idempotency-Key": key,
        },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) {
        if (r.status < 500) setRetry(null);
        throw new Error(
          typeof data.detail === "string"
            ? data.detail
            : "Check your dates: end must follow start, up to seven days.",
        );
      }
      setRetry(null);
      setMessage(
        `Reservation #${data.id} ${data.status === "cancelled" ? "was already cancelled. Choose a new request." : "confirmed. Your equipment is reserved."}`,
      );
      await refresh();
    } catch (e) {
      setMessage(
        e instanceof Error
          ? e.message
          : "Connection lost. Submit again to safely retry.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function cancel(id: number) {
    setBusy(true);
    try {
      const r = await fetch(`/api/reservations/${id}/cancel`, {
        method: "POST",
        headers: { "X-Demo-Member": member },
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail);
      setMessage(`Reservation #${id} cancelled. The time is available again.`);
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Cancellation failed");
    } finally {
      setBusy(false);
    }
  }
  const active = bookings.filter((b) => b.status === "active");
  return (
    <>
      <header>
        <a href="/" className="brand">
          <span className="mark">F</span>fieldkit
          <span className="divider">/</span>
          <span className="product">Equipment desk</span>
        </a>
        <span className="pill">LOCAL DEMO</span>
      </header>
      <main>
        <div className="intro">
          <div>
            <p className="eyebrow">SHARED GEAR. CLEAR PLANS.</p>
            <h1>
              Make room for
              <br />
              your next experiment.
            </h1>
            <p className="subtitle">
              Reserve the tools you need. See what’s booked.
              <br />
              Keep the whole team moving.
            </p>
          </div>
          <aside className="demo">
            <span className="dot" />
            Synthetic workspace
            <label htmlFor="member">Demo access · switch member</label>
            <select
              id="member"
              value={member}
              onChange={(e) => {
                setMember(e.target.value);
                setRetry(null);
              }}
            >
              <option value="alex">Alex · demo member</option>
              <option value="sam">Sam · demo member</option>
            </select>
            <small>
              Shared demonstration identities. No real accounts or club data.
            </small>
          </aside>
        </div>
        <div className="section-title">
          <h2>The equipment shelf</h2>
          <span>{equipment.length} tools in your workspace</span>
        </div>
        <div className="shelf">
          {equipment.map((e, i) => (
            <button
              key={e.id}
              className={"equipment " + (selected === e.id ? "chosen" : "")}
              onClick={() => setSelected(e.id)}
              aria-pressed={selected === e.id}
            >
              <span className="number">
                0{i + 1}{" "}
                <span>{selected === e.id ? "SELECTED" : "SELECT TOOL"}</span>
              </span>
              <div className="tool-icon">{["⌘", "◉", "∿"][i]}</div>
              <h3>{e.name}</h3>
              <p>{e.description}</p>
              <div className="tool-footer">
                <span className="dot" />
                {active.filter((b) => b.equipment_id === e.id).length} upcoming
                / active bookings <span>↗</span>
              </div>
            </button>
          ))}
        </div>
        <div className="workspace">
          <section className="reserve">
            <p className="eyebrow">PLAN A SESSION</p>
            <h2>
              Book{" "}
              {equipment.find((e) => e.id === selected)?.name.toLowerCase() ||
                "equipment"}
            </h2>
            <p className="muted">
              Choose a start and end. Adjacent bookings are welcome.
            </p>
            <form onSubmit={reserve}>
              <label htmlFor="start">Start · your local time</label>
              <input
                required
                type="datetime-local"
                id="start"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
              <label htmlFor="end">End · your local time</label>
              <input
                required
                type="datetime-local"
                id="end"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
              <button className="primary" disabled={busy}>
                {busy ? "Saving…" : "Reserve equipment"} <span>→</span>
              </button>
            </form>
            <p className="fine">
              Times are stored in UTC. Maximum session: 7 days.
              <br />
              Refresh the board to see the latest team plans.
            </p>
            <div className="notice" role="status">
              {message || "Select a tool and time to get started."}
            </div>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => refresh().catch((e) => setMessage(e.message))}
            >
              ↻ Refresh availability
            </button>
          </section>
          <section className="schedule">
            <div className="section-title">
              <h2>Reservation board</h2>
              <span>{active.length} active</span>
            </div>
            {bookings.length === 0 ? (
              <div className="empty">
                <span>↗</span>
                <h3>A clear schedule</h3>
                <p>Your first reservation will appear here.</p>
              </div>
            ) : (
              <div className="booking-list">
                {bookings.map((b) => (
                  <article
                    className={
                      "booking " + (b.status === "cancelled" ? "cancelled" : "")
                    }
                    key={b.id}
                  >
                    <div>
                      <span className="booking-id">
                        #{String(b.id).padStart(3, "0")} · {b.member}
                      </span>
                      <h3>
                        {equipment.find((e) => e.id === b.equipment_id)?.name}
                      </h3>
                      <p>
                        {showTime(b.start)} → {showTime(b.end)}
                      </p>
                    </div>
                    <div className="booking-actions">
                      <span className={"state " + b.status}>{b.status}</span>
                      {b.status === "active" && b.member === member && (
                        <button disabled={busy} onClick={() => cancel(b.id)}>
                          Cancel booking
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
            <div className="activity">
              <h3>Workspace activity</h3>
              <p className="muted">
                A shared record of reservations and cancellations.
              </p>
              {audit.length === 0 ? (
                <p className="muted">No changes yet.</p>
              ) : (
                audit.slice(0, 6).map((a) => (
                  <p key={a.id}>
                    <span className="activity-dot" />
                    {a.member} {a.action} booking #{a.reservation_id}
                    <time>{showTime(a.at)}</time>
                  </p>
                ))
              )}
            </div>
          </section>
        </div>
        <footer>
          <span>FIELDKIT / EQUIPMENT BOOKING</span>
          <span>Synthetic data · Shared equipment · Demo access</span>
        </footer>
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
