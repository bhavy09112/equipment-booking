import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from booking import create_app

BODY = {"equipment_id": 1, "start": "2030-01-01T10:00:00Z", "end": "2030-01-01T11:00:00Z"}


def headers(key="one", member="alex"):
    return {"X-Demo-Member": member, "Idempotency-Key": key}


@pytest.fixture
def api(tmp_path):
    path = tmp_path / "test.db"
    with TestClient(create_app(path)) as client:
        yield client, path


def test_race_independent_requests(api):
    client, path = api
    barrier = threading.Barrier(12)

    def request(i):
        barrier.wait()
        return client.post("/api/reservations", json=BODY, headers=headers(str(i))).status_code

    with ThreadPoolExecutor(max_workers=12) as pool:
        statuses = list(pool.map(request, range(12)))
    assert statuses.count(201) == 1
    assert statuses.count(409) == 11
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT count(*) FROM reservations WHERE status='active'").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM audit").fetchone()[0] == 1


def test_concurrent_identical_retry_is_one_operation(api):
    c, _ = api
    barrier = threading.Barrier(8)

    def request(_):
        barrier.wait()
        return c.post('/api/reservations', json=BODY, headers=headers())

    with ThreadPoolExecutor(max_workers=8) as pool:
        responses = list(pool.map(request, range(8)))
    assert sorted(r.status_code for r in responses) == [200] * 7 + [201]
    assert len({r.json()['id'] for r in responses}) == 1
    assert len(c.get('/api/audit').json()) == 1


def test_retry_normalization_cancel_no_resurrection(api):
    c, _ = api
    first = c.post('/api/reservations', json=BODY, headers=headers())
    assert first.status_code == 201
    equivalent = {**BODY, "start": "2030-01-01T15:30:00+05:30", "end": "2030-01-01T16:30:00+05:30"}
    replay = c.post('/api/reservations', json=equivalent, headers=headers())
    assert replay.status_code == 200 and replay.json() == first.json()
    assert c.post('/api/reservations', json={**BODY,"equipment_id":2}, headers=headers()).status_code == 409
    rid = first.json()['id']
    assert c.post(f'/api/reservations/{rid}/cancel', headers=headers(member='sam')).status_code == 403
    assert c.post(f'/api/reservations/{rid}/cancel', headers=headers()).json()['status'] == 'cancelled'
    assert c.post(f'/api/reservations/{rid}/cancel', headers=headers()).status_code == 200
    assert c.post('/api/reservations', json=BODY, headers=headers()).json()['status'] == 'cancelled'
    assert c.post('/api/reservations', json=BODY, headers=headers('new')).status_code == 201
    assert len(c.get('/api/audit').json()) == 3


def test_adjacent_and_caller_scoping(api):
    c, _ = api
    assert c.post('/api/reservations', json=BODY, headers=headers()).status_code == 201
    adjacent = {**BODY,'start':BODY['end'],'end':'2030-01-01T12:00:00Z'}
    assert c.post('/api/reservations', json=adjacent, headers=headers(member='sam')).status_code == 201
    overlap = {**BODY,'start':'2030-01-01T10:30:00Z'}
    assert c.post('/api/reservations', json=overlap, headers=headers('overlap')).status_code == 409
    assert c.post('/api/reservations', json={**BODY,'equipment_id':2}, headers=headers('other')).status_code == 201


@pytest.mark.parametrize('changes',[
    {'end':BODY['start']}, {'end':'2030-01-01T09:00:00Z'},
    {'start':'2030-01-01T10:00:00'}, {'end':'2030-01-09T11:00:00Z'},
    {'start':'not a date'}, {'equipment_id':0}, {'surprise':True},
])
def test_invalid_intervals(api,changes):
    c,_=api
    assert c.post('/api/reservations',json={**BODY,**changes},headers=headers()).status_code==422
    assert c.get('/api/reservations').json()==[]
    assert c.get('/api/audit').json()==[]


def test_bounded_contention_retry(api):
    c,path=api
    with sqlite3.connect(path) as lock:
        lock.execute('BEGIN IMMEDIATE')
        start=time.monotonic()
        r=c.post('/api/reservations',json=BODY,headers=headers())
        assert r.status_code==503 and r.headers['retry-after']=='1'
        assert .7 < time.monotonic()-start < 3
        lock.rollback()
    assert c.post('/api/reservations',json=BODY,headers=headers()).status_code==201


def test_audit_failure_rolls_back_entire_mutation(api):
    c,path=api
    with sqlite3.connect(path) as db:
        db.execute("CREATE TRIGGER fail_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'injected'); END")
    # Deliberate database fault must not leave a reservation/key without its audit record.
    with pytest.raises(sqlite3.IntegrityError):
        c.post('/api/reservations',json=BODY,headers=headers())
    assert c.get('/api/reservations').json()==[]
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT count(*) FROM requests').fetchone()[0]==0
        db.execute('DROP TRIGGER fail_audit')
    rid=c.post('/api/reservations',json=BODY,headers=headers()).json()['id']
    with sqlite3.connect(path) as db:
        db.execute("CREATE TRIGGER fail_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'injected'); END")
    with pytest.raises(sqlite3.IntegrityError):
        c.post(f'/api/reservations/{rid}/cancel',headers=headers())
    assert c.get('/api/reservations').json()[0]['status']=='active'


def test_restart_persistence(tmp_path):
    path=tmp_path/'restart.db'
    with TestClient(create_app(path)) as c:
        saved=c.post('/api/reservations',json=BODY,headers=headers()).json()
    with TestClient(create_app(path)) as c:
        assert c.get('/api/reservations').json()==[saved]
        assert c.post('/api/reservations',json=BODY,headers=headers()).status_code==200


def test_demo_boundary(api):
    c,_=api
    assert c.post('/api/reservations',json=BODY).status_code==422
    assert c.post('/api/reservations',json=BODY,headers=headers(member='unknown')).status_code==401
    assert c.post('/api/reservations',json=BODY,headers={**headers(),'Origin':'https://elsewhere.invalid'}).status_code==403
    assert c.post('/api/reservations',json=BODY,headers=headers('bad key')).status_code==422
    assert c.post('/api/reservations',json={**BODY,'equipment_id':999},headers=headers()).status_code==404
    assert c.post('/api/reservations/999/cancel',headers=headers()).status_code==404
