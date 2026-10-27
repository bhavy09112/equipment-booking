# Transaction and API contract

Browser → same-origin FastAPI → one SQLite file on a single host. Each request gets its own connection; WAL permits readers while the one writer holds the write transaction. SQLite foreign keys are enabled per connection.

`POST /api/reservations` requires `X-Demo-Member: alex|sam`, `Idempotency-Key` (1–80 alphanumeric, `_` or `-`) and JSON `{equipment_id,start,end}`. Extra fields are rejected. Timezones are required and normalized to UTC before comparison. Dates are stored in a fixed-width microsecond ISO format; half-open overlap is `existing.start < requested.end AND existing.end > requested.start`. End must follow start and duration must be at most seven days. Historical dates are permitted.

Inside **one BEGIN IMMEDIATE transaction**:

1. Find an existing create request by `(demo member, key)`.
2. If found, compare normalized payload: mismatch returns 409; match returns 200 with the reservation’s **current** state.
3. Validate item and check active overlaps; return 404 or 409 as appropriate.
4. Insert reservation, key mapping and created audit event; commit, then return 201.

No successful request key is removed on cancellation. Retrying an original key returns the cancelled reservation and cannot resurrect it. A new booking needs a new key. A failed validation/conflict/busy request consumes no key. Keys are scoped to caller and create operation (the requests table is exclusively for creates). Cancellation uses the reservation ID as its natural operation identity and is idempotent without a header key.

`POST /api/reservations/{id}/cancel` checks member ownership inside its write transaction, changes state and appends the cancellation audit atomically. Repeated owner cancellation returns 200 without a second audit entry. Missing ID: 404; another member: 403. Demo identity enforcement lives on the server, but the selectable header is deliberately not secure authentication.

Writer contention waits at most the configured SQLite timeout (default 1000ms for each lock acquisition); exhaustion returns 503 and `Retry-After: 1`. Client can retry with the same key. End-to-end response time includes request scheduling; no one-second service SLA is claimed. An audit failure rolls back the reservation/key or cancellation. Unexpected storage faults are not disguised as success.

`GET /api/equipment`, `/api/reservations` and `/api/audit` expose synthetic data; audit returns the latest 100 events. All bookings are returned in v1. Frontend availability counts are active bookings, including historical intervals, not a claim that a tool is free at the current instant. Frontend displays dates in the browser timezone; API returns UTC. GET views may be briefly stale; only the atomic server mutation decides whether a booking succeeds.

Cross-origin mutations with an Origin header are rejected; no CORS is enabled. This is a local demo boundary, not authentication or internet-hardening. The UI retains a request key when a network/5xx outcome is uncertain and reuses it for the unchanged caller/payload. A new successful request clears that key. Cancellation retries are naturally safe by ID. Browser refresh cannot cause a duplicate form POST.

SQLite’s serialized writer model favors simple correctness on one host. Multiple processes on that host can use the same local database; distributed filesystems and multiple independent database copies are unsupported. No DB trigger protects overlap against arbitrary external SQL writers; the invariant holds through this API’s write path.
