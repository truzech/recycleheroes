# reset-data/

`fresh-start.json` is an empty full-state snapshot — the same shape the app's
own "Export JSON" produces, just with every array cleared out. Use it to wipe
a device back to a blank slate (new device, or before a live demo) without
touching browser DevTools:

1. Open the app → ⚙ Admin Panel → 🔍 Database → **Backup & Restore** tab.
2. **Import JSON** → choose `fresh-start.json` → click **Import JSON** again
   to confirm the overwrite prompt.
3. The page reloads with zero users, check-ins, events, visitors, or weight
   log entries. Theme resets to dark; MOTD is cleared.

This intentionally goes through the app's real import path (same integrity
check every other import gets), rather than being a separate tool — so
"resetting" can never leave the app in a state the app itself wouldn't
otherwise produce.
