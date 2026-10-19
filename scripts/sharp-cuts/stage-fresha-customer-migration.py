#!/usr/bin/env python3
"""Prepare an encrypted, idempotent Sharp Cuts Fresha staging batch.

The script never emits plaintext profile data. Data and fingerprint keys are
generated independently and stored in a current-user DPAPI envelope outside
the repository. The generated SQL payload contains ciphertext and keyed
fingerprints only.
"""

from __future__ import annotations

import argparse
import base64
import csv
import ctypes
from ctypes import wintypes
import hashlib
import hmac
import itertools
import json
import os
from pathlib import Path
import secrets
import unicodedata
import uuid

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def _blob(data: bytes):
    buffer = ctypes.create_string_buffer(data)
    return DATA_BLOB(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte))), buffer


def dpapi_protect(data: bytes) -> bytes:
    source, source_buffer = _blob(data)
    output = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(source), None, None, None, None, 0, ctypes.byref(output)
    ):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(output.pbData)


def normal(value: str | None) -> str:
    return " ".join(unicodedata.normalize("NFKC", value or "").strip().lower().split())


def phone(value: str | None) -> str:
    return "".join(ch for ch in (value or "") if ch.isdigit())


def fp(key: bytes, purpose: str, value: str) -> str | None:
    if not value:
        return None
    return hmac.new(key, f"{purpose}:{value}".encode(), hashlib.sha256).hexdigest()


def encrypt(key: bytes, value: object, aad: str) -> dict[str, str]:
    nonce = secrets.token_bytes(12)
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    ciphertext = AESGCM(key).encrypt(nonce, payload, aad.encode())
    return {
        "alg": "A256GCM",
        "nonce": base64.b64encode(nonce).decode(),
        "ciphertext": base64.b64encode(ciphertext).decode(),
        "aad": aad,
    }


def sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


class UnionFind:
    def __init__(self, items):
        self.parent = {item: item for item in items}

    def find(self, item):
        while self.parent[item] != item:
            self.parent[item] = self.parent[self.parent[item]]
            item = self.parent[item]
        return item

    def union(self, left, right):
        left, right = self.find(left), self.find(right)
        if left != right:
            self.parent[right] = left


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True, type=Path)
    parser.add_argument("--private-dir", required=True, type=Path)
    parser.add_argument("--live-count", required=True, type=int)
    parser.add_argument("--authoritative-live-only-id", action="append", default=[])
    args = parser.parse_args()

    raw = args.csv.read_bytes()
    snapshot_hash = hashlib.sha256(raw).hexdigest()
    with args.csv.open("r", encoding="utf-8-sig", newline="") as source:
        rows = list(csv.DictReader(source))
    if len(rows) > args.live_count:
        raise SystemExit("Export row count exceeds the authoritative live count.")
    gap_count = args.live_count - len(rows)
    if gap_count != 3:
        raise SystemExit(f"Expected a three-profile reconciliation gap, received {gap_count}.")
    if len(set(args.authoritative_live_only_id)) > gap_count:
        raise SystemExit("Too many authoritative live-only identifiers were supplied.")

    args.private_dir.mkdir(parents=True, exist_ok=True)
    keys_path = args.private_dir / "fresha-customer-staging-keys.dpapi"
    if keys_path.exists():
        raise SystemExit("A staging key envelope already exists; refusing to overwrite it.")
    data_key, fingerprint_key = secrets.token_bytes(32), secrets.token_bytes(32)
    key_record = json.dumps({
        "version": 1,
        "data_key": base64.b64encode(data_key).decode(),
        "fingerprint_key": base64.b64encode(fingerprint_key).decode(),
    }, separators=(",", ":")).encode()
    keys_path.write_bytes(dpapi_protect(key_record))

    batch_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"sharp-cuts:fresha:{snapshot_hash}"))
    records = []
    occurrence: dict[str, int] = {}
    for ordinal, row in enumerate(rows, start=1):
        canonical = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        content = hashlib.sha256(canonical.encode()).hexdigest()
        occurrence[content] = occurrence.get(content, 0) + 1
        migration_id = str(uuid.uuid5(uuid.UUID(batch_id), f"export:{content}:{occurrence[content]}"))
        name = normal(row.get("Client"))
        email = normal(row.get("Email"))
        mobile = phone(row.get("Mobile number"))
        source_ref = f"internal:fresha-export:{snapshot_hash}:{ordinal}"
        records.append({
            "record_id": str(uuid.uuid5(uuid.UUID(batch_id), migration_id)),
            "batch_id": batch_id,
            "migration_id": migration_id,
            "source_id_envelope": encrypt(data_key, {"source_ref": source_ref}, f"{batch_id}:{migration_id}:source"),
            "source_id_fingerprint": fp(fingerprint_key, "source", source_ref),
            "profile_envelope": encrypt(data_key, row, f"{batch_id}:{migration_id}:profile"),
            "name_fingerprint": fp(fingerprint_key, "name", name),
            "email_fingerprint": fp(fingerprint_key, "email", email),
            "phone_fingerprint": fp(fingerprint_key, "phone", mobile),
            "has_email": bool(email),
            "has_mobile": bool(mobile),
            "source_ordinal": ordinal,
            "reconciliation_status": "exported_source_id_unavailable",
        })

    known_ids = sorted(set(args.authoritative_live_only_id))
    for offset in range(gap_count):
        authoritative_id = known_ids[offset] if offset < len(known_ids) else None
        label = f"authoritative:{authoritative_id}" if authoritative_id else "unidentified:3"
        migration_id = str(uuid.uuid5(uuid.UUID(batch_id), f"live-gap:{label}"))
        source_ref = f"fresha:{authoritative_id}" if authoritative_id else f"internal:fresha-live-gap:{snapshot_hash}:3"
        records.append({
            "record_id": str(uuid.uuid5(uuid.UUID(batch_id), migration_id)),
            "batch_id": batch_id,
            "migration_id": migration_id,
            "source_id_envelope": encrypt(data_key, {"source_ref": source_ref}, f"{batch_id}:{migration_id}:source"),
            "source_id_fingerprint": fp(fingerprint_key, "source", source_ref),
            "profile_envelope": encrypt(data_key, {"profile_fields_unavailable": True}, f"{batch_id}:{migration_id}:profile"),
            "name_fingerprint": None,
            "email_fingerprint": None,
            "phone_fingerprint": None,
            "has_email": False,
            "has_mobile": False,
            "source_ordinal": None,
            "reconciliation_status": "live_only_authoritative_id_fields_unavailable" if authoritative_id else "live_only_unidentified_reconciliation_gap",
        })

    by_email: dict[str, list[str]] = {}
    by_phone: dict[str, list[str]] = {}
    by_name: dict[str, list[str]] = {}
    for record in records:
        for key_name, groups in (("email_fingerprint", by_email), ("phone_fingerprint", by_phone), ("name_fingerprint", by_name)):
            value = record[key_name]
            if value:
                groups.setdefault(value, []).append(record["migration_id"])

    pair_basis: dict[tuple[str, str], set[str]] = {}
    for basis, groups in (("email", by_email), ("phone", by_phone), ("name", by_name)):
        for members in groups.values():
            for left, right in itertools.combinations(sorted(members), 2):
                pair_basis.setdefault((left, right), set()).add(basis)

    union = UnionFind(record["migration_id"] for record in records)
    candidates = []
    for (left, right), bases in sorted(pair_basis.items()):
        confirmed = "email" in bases and "phone" in bases
        if confirmed:
            union.union(left, right)
        candidate_id = str(uuid.uuid5(uuid.UUID(batch_id), f"duplicate:{left}:{right}"))
        candidates.append({
            "candidate_id": candidate_id,
            "batch_id": batch_id,
            "left_migration_id": left,
            "right_migration_id": right,
            "match_basis": sorted(bases),
            "confidence": "confirmed" if confirmed else "ambiguous",
            "status": "pending_owner_review",
        })

    components = len({union.find(record["migration_id"]) for record in records})
    confirmed_candidates = sum(item["confidence"] == "confirmed" for item in candidates)
    ambiguous_candidates = len(candidates) - confirmed_candidates
    safe_summary = {
        "batch_id": batch_id,
        "source_snapshot_sha256": snapshot_hash,
        "export_rows": len(rows),
        "live_profiles": args.live_count,
        "import_records": len(records),
        "authoritative_live_only_ids": len(known_ids),
        "unidentified_reconciliation_gaps": gap_count - len(known_ids),
        "confirmed_duplicate_pairs": confirmed_candidates,
        "ambiguous_duplicate_pairs": ambiguous_candidates,
        "conservative_unique_customer_count": components,
        "email_present": sum(item["has_email"] for item in records),
        "mobile_present": sum(item["has_mobile"] for item in records),
        "keys": {"data": "windows_dpapi_current_user", "fingerprint": "windows_dpapi_current_user"},
        "raw_profile_data_in_sql_payload": False,
    }

    schema_sql = """
CREATE TABLE IF NOT EXISTS sc_customer_import_batches (
  id uuid PRIMARY KEY,
  source_system text NOT NULL CHECK (source_system = 'fresha'),
  source_snapshot_sha256 char(64) NOT NULL UNIQUE,
  export_record_count integer NOT NULL,
  live_record_count integer NOT NULL,
  imported_record_count integer NOT NULL,
  authoritative_id_count integer NOT NULL,
  reconciliation_gap_count integer NOT NULL,
  encryption_key_ref text NOT NULL,
  fingerprint_key_ref text NOT NULL,
  safe_summary jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('loading','loaded','failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sc_customer_staging_records (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES sc_customer_import_batches(id),
  migration_id uuid NOT NULL,
  source_id_envelope jsonb NOT NULL,
  source_id_fingerprint char(64) NOT NULL,
  profile_envelope jsonb NOT NULL,
  name_fingerprint char(64),
  email_fingerprint char(64),
  phone_fingerprint char(64),
  has_email boolean NOT NULL,
  has_mobile boolean NOT NULL,
  source_ordinal integer,
  reconciliation_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(batch_id, migration_id)
);
CREATE TABLE IF NOT EXISTS sc_customer_duplicate_candidates (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES sc_customer_import_batches(id),
  left_migration_id uuid NOT NULL,
  right_migration_id uuid NOT NULL,
  match_basis jsonb NOT NULL,
  confidence text NOT NULL CHECK (confidence IN ('confirmed','ambiguous')),
  status text NOT NULL CHECK (status IN ('pending_owner_review','confirmed','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(batch_id, left_migration_id, right_migration_id)
);
CREATE OR REPLACE VIEW sc_customer_staging_cleaned AS
SELECT r.batch_id, r.migration_id, r.has_email, r.has_mobile,
       r.reconciliation_status,
       EXISTS (
         SELECT 1 FROM sc_customer_duplicate_candidates d
         WHERE d.batch_id=r.batch_id
           AND (d.left_migration_id=r.migration_id OR d.right_migration_id=r.migration_id)
           AND d.status='pending_owner_review'
       ) AS requires_duplicate_review
FROM sc_customer_staging_records r;
""".strip()

    batch_sql = f"""
INSERT INTO sc_customer_import_batches
(id,source_system,source_snapshot_sha256,export_record_count,live_record_count,imported_record_count,authoritative_id_count,reconciliation_gap_count,encryption_key_ref,fingerprint_key_ref,safe_summary,status)
VALUES ({sql_quote(batch_id)}::uuid,'fresha',{sql_quote(snapshot_hash)},{len(rows)},{args.live_count},{len(records)},{len(known_ids)},{gap_count-len(known_ids)},'windows-dpapi:sharp-cuts-fresha-staging:data:v1','windows-dpapi:sharp-cuts-fresha-staging:fingerprint:v1',{sql_quote(json.dumps(safe_summary,separators=(',',':')))}::jsonb,'loading')
ON CONFLICT (source_snapshot_sha256) DO NOTHING;
""".strip()

    statements = [schema_sql, batch_sql]
    for start in range(0, len(records), 100):
        chunk = json.dumps(records[start:start+100], separators=(",", ":"))
        statements.append(f"""
INSERT INTO sc_customer_staging_records
(id,batch_id,migration_id,source_id_envelope,source_id_fingerprint,profile_envelope,name_fingerprint,email_fingerprint,phone_fingerprint,has_email,has_mobile,source_ordinal,reconciliation_status)
SELECT x.record_id::uuid,x.batch_id::uuid,x.migration_id::uuid,x.source_id_envelope,x.source_id_fingerprint,x.profile_envelope,x.name_fingerprint,x.email_fingerprint,x.phone_fingerprint,x.has_email,x.has_mobile,x.source_ordinal,x.reconciliation_status
FROM jsonb_to_recordset({sql_quote(chunk)}::jsonb) AS x(record_id text,batch_id text,migration_id text,source_id_envelope jsonb,source_id_fingerprint text,profile_envelope jsonb,name_fingerprint text,email_fingerprint text,phone_fingerprint text,has_email boolean,has_mobile boolean,source_ordinal integer,reconciliation_status text)
ON CONFLICT (batch_id,migration_id) DO NOTHING;
""".strip())
    for start in range(0, len(candidates), 200):
        chunk = json.dumps(candidates[start:start+200], separators=(",", ":"))
        statements.append(f"""
INSERT INTO sc_customer_duplicate_candidates
(id,batch_id,left_migration_id,right_migration_id,match_basis,confidence,status)
SELECT x.candidate_id::uuid,x.batch_id::uuid,x.left_migration_id::uuid,x.right_migration_id::uuid,x.match_basis,x.confidence,x.status
FROM jsonb_to_recordset({sql_quote(chunk)}::jsonb) AS x(candidate_id text,batch_id text,left_migration_id text,right_migration_id text,match_basis jsonb,confidence text,status text)
ON CONFLICT (batch_id,left_migration_id,right_migration_id) DO NOTHING;
""".strip())
    statements.append(f"""
UPDATE sc_customer_import_batches
SET status='loaded'
WHERE id={sql_quote(batch_id)}::uuid
  AND (SELECT count(*) FROM sc_customer_staging_records WHERE batch_id={sql_quote(batch_id)}::uuid)={len(records)};
""".strip())

    payload_path = args.private_dir / "fresha-customer-staging-sql.json"
    summary_path = args.private_dir / "fresha-customer-staging-summary.json"
    payload_path.write_text(json.dumps({"batch_id": batch_id, "statements": statements}, separators=(",", ":")), encoding="utf-8")
    summary_path.write_text(json.dumps(safe_summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "prepared", **safe_summary, "sql_statements": len(statements)}))


if __name__ == "__main__":
    main()
