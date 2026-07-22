# Remove rtk

Idempotent — safe to run even if some steps were never applied. Run Steps 1–3 once per agent group that had rtk wired (`ncl groups list`).

## 1. Remove the mount from the container config

Remove the rtk mount with the host-only `remove-mount` verb. It is idempotent — a no-op if the mount isn't present:

```bash
ncl groups config remove-mount --id <group-id> \
  --host ~/.local/share/nanoclaw/rtk-linux/rtk \
  --container rtk
```

`remove-mount` matches on the host **and** container path together, so also run this if the group was wired by an older version of this skill, which mounted the host-native binary at an absolute container path:

```bash
ncl groups config remove-mount --id <group-id> \
  --host ~/.local/bin/rtk \
  --container /usr/local/bin/rtk
```

Confirm nothing rtk-shaped is left:

```bash
ncl groups config get --id <group-id>
```

This verb is operator-only and runs host-side; it is rejected from inside a container.

## 2. Remove the PreToolUse hook from settings.json

Delete the rtk Bash hook entry (not comment it out). The match is a substring test so it catches both the current full-path command and the bare `rtk hook claude` written by older versions of this skill. This leaves any other `PreToolUse` entries intact and is safe to re-run:

```bash
SETTINGS="data/v2-sessions/<group-id>/.claude-shared/settings.json"

jq '.hooks.PreToolUse = ((.hooks.PreToolUse // [])
      | map(select((.hooks // []) | any((.command // "") | test("rtk hook claude")) | not)))' \
  "$SETTINGS" > /tmp/rtk-settings.json && mv /tmp/rtk-settings.json "$SETTINGS"
```

Verify:

```bash
jq '.hooks.PreToolUse' "$SETTINGS"
```

## 3. Restart the container

```bash
ncl groups restart --id <group-id>
```

## 4. Remove the host binary (optional)

Once no group mounts rtk anymore, remove the Linux binary this skill downloaded:

```bash
rm -rf ~/.local/share/nanoclaw/rtk-linux
```

If an older version of this skill was used, also remove the host-native copy it installed — but only if you don't use rtk in your own shell:

```bash
rm -f ~/.local/bin/rtk
```
