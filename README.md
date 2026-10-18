# Send Me Deliveries (SMD)

Multi-user delivery app: real accounts, server-side auth, and jobs shared between senders and shippers.
Node + Express + SQLite-compatible database: Turso (libSQL) in production, a local file in development. The UI is your original design.

## Run it

    npm install
    npm start            # http://localhost:3000
    npm test             # 160 end-to-end checks against a throw-away database

Requires Node 22.13 or newer. `npm start` automatically reads a `.env` file in this folder if one exists (copy `.env.example` to `.env` and fill it in). Without Turso settings, data lives in the local file `smd.db` (set `DB_PATH` to move it); back that file up. In production use Turso (below): the data then lives outside your server and survives every deploy.

## Configuration (environment variables)

| Variable | Purpose |
|---|---|
| `NODE_ENV=production` | Secure cookies, HSTS, upgrade-insecure-requests. **Set this when deployed.** |
| `PORT` | Listen port (default 3000). |
| `TRUST_PROXY` | Set to `1` when behind one reverse proxy (nginx, Caddy, a PaaS) so rate limits see real client IPs. |
| `APP_SECRET` | Long random string; signs short-lived Google sign-up tokens. |
| `GOOGLE_CLIENT_ID` | Enables "Continue with Google" (OAuth Web client; add your site URL as an authorised origin). |
| `ADMIN_EMAIL` | **Required to review shippers.** Email(s) (comma-separated) of the admin account(s). Create the account in the app with that email and verify it; it then becomes an admin. Nobody can become admin from inside the app. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | **Required in production.** Sends verification codes, password-reset codes and approval emails. Port 587 (STARTTLS) by default; set `SMTP_SECURE=1` or port 465 for implicit TLS. Gmail: use an *app password*. |
| `MAIL_WEBHOOK_URL` | Alternative to SMTP: the server POSTs `{email, to, subject, text, kind, code}` here (`RESET_WEBHOOK_URL` still works). |
| `API_RATE_LIMIT`, `UPLOAD_RATE_LIMIT` | API requests per IP per minute (default 300) and ID-photo uploads per IP per minute (default 30). |

With no mail provider configured, codes are printed to the server console **in development only**. In production nobody can verify an email until SMTP or the webhook is set.
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | **Production database.** `libsql://your-db-your-org.turso.io` and a database token. When set, the app uses Turso and ignores `DB_PATH`. |
| `DB_PATH` | Local SQLite file (development and tests only; used when `TURSO_DATABASE_URL` is not set). |
| `AUTH_RATE_LIMIT` | Auth requests per IP per minute (default 20). |

Serve it over HTTPS (Caddy/nginx/your host). Cookies are `Secure` in production and will not work over plain HTTP.

## What the server enforces (nothing is trusted from the browser)

- Passwords: scrypt (N=32768) with a per-user salt; minimum 8 characters; constant-time comparison; equalised timing for unknown emails.
- Sessions: random 256-bit token in an HttpOnly, SameSite=Strict cookie; only its SHA-256 is stored; revoked on logout and on password reset; 14-day expiry.
- Brute force: persistent lockout (5 failures → 60 s) plus per-IP rate limiting on all auth routes and a global API limit.
- Email verification: new accounts cannot log in until they enter a 6-digit code emailed to them (hashed at rest, 10-minute expiry, 5 tries, one email per minute, guess lockout). Logging in before verifying re-sends a code and shows the code screen. A sign-up that never verified cannot block or hijack the real owner of that email (it is replaced; a Google login for the same email wins).
- Shipper approval: shippers register with ID type, ID number, date of birth (18+) and address, then upload ID front/back (a passport needs only the photo page) and a selfie holding the ID. Status: `draft` -> `pending` -> `approved` | `rejected`. Until `approved`, every job route returns 403. Admins review in the app (Review tab), approve or reject with a reason, and the shipper is emailed. Rejected shippers fix and resubmit; admins can also revoke an approval later.
- ID data: one ID number can back only one account; photos are checked by file signature (JPEG/PNG, max 4 MB), stored privately in the database (never in a public folder, never cached) and served only to the owner and admins; name is locked once an ID is submitted.
- Shops and goods: the admin keeps a catalog of recommended shops per area (Shops tab), each with goods priced per unit (e.g. Sugar, 1 kg, KES 220). Recommended shops are listed first for senders. Goods prices are whole shillings; the server looks every price up in its own catalog, so a client cannot change them. An order stores a copy of the goods and prices at the time it was made, so later price edits or deleted shops never change old orders. Total = delivery fee + goods; anything a sender types in themselves is kept as text and is not priced.
- Password reset: single-use 8-character code, 15-minute expiry, 5 tries, one per minute, hashed at rest; identical reply whether or not the email exists; resetting revokes all sessions.
- Google sign-in: ID token verified server-side (RS256 signature against Google's keys, audience, issuer, expiry, verified email).
- CSRF: SameSite=Strict + JSON-only writes + Origin / Sec-Fetch-Site checks.
- Headers: strict CSP (no inline scripts, no framing), nosniff, HSTS (production), COOP, no `X-Powered-By`.
- Authorisation: role checks on every route; senders see only their own deliveries; shippers see only open jobs, then only jobs they accepted.
- Privacy: the public job board hides sender/recipient identity and the exact drop-off address/pin until a shipper accepts.
- Integrity: price always computed server-side; every field validated (types, lengths, areas, weights, service-area pins); accept / deliver / cancel are single atomic SQL updates, so two shippers cannot take the same job and a job cannot be cancelled after acceptance.
- All user text is rendered with `textContent` (no HTML injection).

## API

    GET  /api/config                     POST /api/auth/signup | login | logout | forgot | reset
    POST /api/auth/verify | resend       (email code; signup no longer logs in by itself)
    GET  /api/me   PATCH /api/me         POST /api/auth/google | google/complete
    PUT  /api/me/id-docs/:front|back|selfie   GET /api/me/id-docs/:kind   POST /api/me/verification   (shipper)
    GET  /api/admin/shippers?status=pending|approved|rejected   GET /api/admin/shippers/:id/docs/:kind
    POST /api/admin/shippers/:id/approve | reject {reason}      (admin)
    GET  /api/shops (sender)             POST /api/deliveries {shopId, items:[{id,q}], it, ...}
    GET  /api/deliveries (sender)        DELETE /api/deliveries/:id
    GET/POST /api/admin/shops   PATCH/DELETE /api/admin/shops/:id   POST /api/admin/shops/:id/items   PATCH/DELETE /api/admin/items/:id   (admin)
    GET  /api/jobs?area= (shipper)       POST /api/jobs/:id/accept | deliver     GET /api/jobs/mine

## Known limits / next steps

- No payment processing (cash/M-Pesa on delivery, as in the original).
- Single server + SQLite: ideal for one instance; move to Postgres if you need several.
- Existing accounts from before this update are grandfathered: their email counts as verified and existing shippers as approved (the admin can still reject them). New sign-ups go through the full checks.
- ID numbers and photos are stored unencrypted inside `smd.db`. Protect and back up that file like any sensitive data, and consider deleting ID photos after approval if you do not need to keep them.
- The admin panel covers shipper approval and the shop catalog only (no user search/suspension yet).
- The first start creates sample shops and goods (from `config.js` `SHOPS`) so the app is usable straight away; replace them in the Shops tab. They are only created once, so deleting them is permanent.
- Payment handling for goods is not decided yet: the app shows goods + delivery as a total, and the shipper pays the shop / collects money exactly as before.
- The login lockout is per email, so someone could briefly annoy a known address; this is the usual trade-off against distributed guessing.

## Service areas and map order

Areas are defined in `config.js`. `pos` is the distance in km from Mombasa: it sets the price **and** the order of stops on the
map, in the dropdowns and in the header (currently Mombasa, Likoni, Kombani, Tiwi, Ukunda, Diani). Routes on the map pass through every stop in between.
To reorder or add an area, change `pos` and the `x,y` map position, then restart the server.

## Database: Turso (free tier) for hosting on Render

Render's free disk is wiped on every deploy, so the database lives on Turso instead. The app creates all tables and the sample shops itself on first start.
1. Create a free account and a database at turso.tech (pick a region close to your Render region).
2. Copy the database URL (`libsql://...`) and create a database token (read and write).
3. In Render > Environment add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`, then save (Render redeploys).
Everything stays the same for local work: with no Turso variables, `npm start` and `npm test` use a local file. Every database call is asynchronous (`await q(sql).get/all/run`).
