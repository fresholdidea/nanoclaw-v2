#!/usr/bin/env python3
"""
One-time recovery for the 2026-07-17 "config moved to DB" migration data loss.

The backfill (src/backfill-container-configs.ts) skipped groups that already had
an (empty) container_configs row, so their real MCP config — which lived only in
groups/<folder>/container.json — never made it into the DB. materializeContainerJson
then clobbered the file from the empty DB on the next spawn.

This restores config for:
  - Time-bomb groups (config still survives in their on-disk files): news, wiki, home, cache-am
  - paid-media (already clobbered 2026-07-17 09:00; recovered by mirroring its peer
    executor `ads` for MCP servers + mounts, and using the python-bearing ag- image)

Idempotent. Reads source configs, writes to data/v2.db. Secrets are never printed.
"""
import json
import sqlite3
import sys
from datetime import datetime, timezone

DB = "data/v2.db"
NOW = datetime.now(timezone.utc).isoformat()

# folder -> source: read the group's own on-disk file verbatim
TIME_BOMB_FOLDERS = ["news", "wiki", "home", "cache-am"]

ADS_GID = "ag-1777521678769-obgxhn"
PAID_MEDIA_GID = "ag-1779772267402-paidme"
PAID_MEDIA_IMAGE = "nanoclaw-agent:ag-1777521678769-obgxhn"  # has python3 3.11.2 + google-ads venv


def redact_servers(mcp: dict) -> str:
    return ", ".join(f"{k}({v.get('type','stdio')})" for k, v in mcp.items()) or "(none)"


def main():
    con = sqlite3.connect(DB, timeout=10)
    con.execute("PRAGMA busy_timeout=10000")
    cur = con.cursor()

    # map folder -> agent_group_id
    folder_gid = {f: g for g, f in cur.execute("SELECT id, folder FROM agent_groups").fetchall()}

    updates = []  # (gid, label, mcp, mounts, apt, npm, image_tag, assistant_name)

    # --- Time-bomb groups: restore verbatim from their own files ---
    for folder in TIME_BOMB_FOLDERS:
        gid = folder_gid.get(folder)
        if not gid:
            print(f"SKIP {folder}: no agent_groups row")
            continue
        with open(f"groups/{folder}/container.json") as fh:
            c = json.load(fh)
        mcp = c.get("mcpServers", {})
        if not mcp:
            print(f"SKIP {folder}: file has no mcpServers (nothing to recover)")
            continue
        updates.append((
            gid, folder, mcp,
            c.get("additionalMounts", []),
            c.get("packages", {}).get("apt", []),
            c.get("packages", {}).get("npm", []),
            c.get("imageTag"),
            c.get("assistantName"),
        ))

    # --- paid-media: mirror ads' servers + mounts, with the python-bearing image ---
    ads = cur.execute(
        "SELECT mcp_servers, additional_mounts FROM container_configs WHERE agent_group_id=?",
        (ADS_GID,),
    ).fetchone()
    if ads:
        updates.append((
            PAID_MEDIA_GID, "paid-media (mirror of ads)",
            json.loads(ads[0]), json.loads(ads[1]),
            [], [], PAID_MEDIA_IMAGE, None,
        ))
    else:
        print("WARN: ads config row not found — cannot mirror paid-media")

    # --- Apply ---
    for gid, label, mcp, mounts, apt, npm, image_tag, assistant in updates:
        cur.execute(
            """UPDATE container_configs
               SET mcp_servers=?, additional_mounts=?, packages_apt=?, packages_npm=?,
                   image_tag=COALESCE(?, image_tag), assistant_name=COALESCE(?, assistant_name),
                   updated_at=?
               WHERE agent_group_id=?""",
            (json.dumps(mcp), json.dumps(mounts), json.dumps(apt), json.dumps(npm),
             image_tag, assistant, NOW, gid),
        )
        print(f"OK  {label:28s} [{gid}]  servers: {redact_servers(mcp)}  mounts:{len(mounts)}  image:{image_tag or '(unchanged)'}")

    con.commit()
    con.close()
    print(f"\nDone. {len(updates)} group(s) recovered at {NOW}")


if __name__ == "__main__":
    sys.exit(main())
