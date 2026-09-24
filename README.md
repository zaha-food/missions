# Zaha Missions — web app

The staff shift screen (`/app`) and the back office (`/admin`).

Deployed to GitHub Pages. **No SQL and no secrets live here** — the database
schema and setup files stay on the operator's machine, because they contain
PINs in plain text.

The Supabase key in `config.js` is the publishable key. It is designed to sit
in a web page: every table is protected by row-level security, an
unauthenticated visitor can read only the checklist, and no record can be
written without a valid staff PIN.
