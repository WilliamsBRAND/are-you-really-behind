# Are You Really Behind?

One-page event registration site. Static HTML/CSS/JS front end, plus a single
Vercel serverless function that writes registrations to a Google Sheet.

```
index.html          the whole page
styles.css          design system + all styles
app.js              form flow, validation, analytics, WhatsApp redirect
config.js           ← edit this: WhatsApp link, API endpoint
api/register.js     writes each registration to Google Sheets
assets/             event flyer, share image, favicon, speaker photos
```

## Images

All four supplied images are in `assets/`, normalised for the web. The untouched
originals are kept in `assets/_original/`.

| File | Size | Used for |
|---|---|---|
| `flyer.jpeg` | 864×1080 | the event flyer in the CTA section |
| `event-share.jpg` | 1200×630 | link preview on WhatsApp/LinkedIn/X (built from the flyer) |
| `oladotun.jpg` | 720×900 | host portrait |
| `opeyemi.jpg` | 1080×1350 | speaker portrait |
| `frank.jpg` | 1080×1350 | speaker portrait (recompressed, 810 KB → 258 KB) |

Portraits are cropped to 4:5 so the three cards line up. To re-crop one, edit
the `object-position` on `.person__frame img` in `styles.css` — `50% 20%` keeps
faces in frame.

## Still needs filling in

| What | Where |
|---|---|
| **Real domain** | `index.html` → `og:url`, `canonical`, `twitter:url` (currently `areyoureallybehind.com`) |
| **Google Sheet + service account** | env vars below — the form cannot save until these are set |

The WhatsApp group link is already set in `config.js`.

## Google Sheets setup (one time)

The sheet needs a header row. The function creates it automatically if missing,
with these 13 columns:

`Registration ID · Full Name · Email · Phone Number · Location · User Type ·
Current Stage · Feeling Behind Response · Expected Outcome · Registration Date ·
Registration Time · Source · Status`

1. Create a Google Sheet for registrations.
2. Authorise a Google account that can edit the sheet and export a refresh
   token with write access to Sheets.
3. Add the env vars to Vercel (below).

## Environment variables (Vercel project settings)

The function uses a Google **OAuth refresh-token** grant so it can write to a
sheet owned by a normal Google account. A service account is still supported as
a fallback, but it is not used in production.

```
GOOGLE_CLIENT_ID       = OAuth client id
GOOGLE_CLIENT_SECRET   = OAuth client secret
GOOGLE_REFRESH_TOKEN   = refresh token with Sheets write scope
GOOGLE_SHEET_ID        = the id from the sheet URL
GOOGLE_SHEET_TAB       = Sheet1            (optional, this is the default)
GOOGLE_SHEET_RANGE     = A:M               (optional, this is the default)
```

`GOOGLE_SHEET_TAB` and `GOOGLE_SHEET_RANGE` are separate on purpose: `A:M` means
the append columns, not a tab name. Passing `Sheet1!A:M` also works.

Service-account fallback (unused in production):

```
GOOGLE_SERVICE_ACCOUNT_EMAIL = ...service-account@....iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY           = "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Never commit credentials. `.gitignore` excludes `.env`, `.env.local` and
`.vercel/`; all secrets live in Vercel project settings only.

## Deploy

Deployed to **https://oladotun.vercel.app** via the Vercel CLI.

```bash
npm i -g vercel
vercel            # first time: link the project
vercel --prod     # publish
```

## How the registration flow behaves

- Three steps, with `1 of 3` progress. Going **Back never loses answers**.
- Validation runs per step. Failed validation shows inline errors and keeps
  everything already typed.
- The submit button shows `Completing registration...` and blocks repeat clicks.
- The row is written to the Sheet **before** any success screen appears, so a
  failed save keeps the person on the page with their answers intact.
- Duplicate detection matches on **email OR phone**. Existing registrants get
  "You're already registered." and are sent to WhatsApp — never blocked.
- The success screen auto-opens WhatsApp after ~3s, and the manual button stays
  available if that fails.

## Analytics

`app.js` emits these events to `window.dataLayer`, `window.gtag` (if present),
and a `site:track` DOM event:

`page_view · apply_click · form_started · step1_completed · step2_completed ·
registration_submitted · registration_successful · registration_failed ·
whatsapp_click · whatsapp_auto_redirect`

To see them locally, set `localStorage.setItem("ayrb_debug","1")` and open the
console. To connect a real analytics tool, add its snippet to `index.html` —
nothing else changes.

## Source tracking

UTM parameters (`utm_source`, `utm_medium`, `utm_campaign`, `ref`) are captured
on arrival, remembered in `localStorage`, and normalised into the `Source`
column: Instagram, WhatsApp, LinkedIn, X, Direct, or Other.

## Notes

- Speaker cards carry **Instagram only**. Oladotun's full set (Instagram,
  LinkedIn, YouTube, X) is in the footer, as icons.
- Opeyemi Adesina's card links to **@adesinaassets**, the Adesina Assets
  account. Swap it in `index.html` if you want a different personal handle.
- Text typed into the form is stripped of leading `=`, `+`, `-`, `@` before it
  reaches the sheet, so nothing can execute as a spreadsheet formula.
- After a successful registration the page sends people to WhatsApp in the
  **same tab** after 3 seconds. `window.open()` was blocked by popup blockers.
  The manual button still opens a new tab. To change this, edit the
  `redirectTimer` block near the bottom of `showSuccess()` in `app.js`.

## Checks

163 automated checks pass across three suites:

| Suite | Checks | Covers |
|---|---|---|
| `verify-oladotun.mjs` | 64 | every asset path, every id `app.js` touches, PRD content, validation, honeypot, rate limit, secret |
| `verify-sheets.mjs` | 33 | real JWT signing, exact Google API calls, all 13 columns, duplicate detection on email or phone, write failures |
| `verify-browser.mjs` | 66 | real Chrome: full form flow, back-preserves-answers, duplicate path, server-failure recovery, WhatsApp redirect, 4:5 image rendering, labels and alt text |

The Sheets suite stubs the Google API with a real RSA key, so the request
shapes are proven — but no row has been written to a real sheet yet. That needs
the live credentials below.

