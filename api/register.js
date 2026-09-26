import crypto from "node:crypto";

/*
 * POST /api/register
 *
 * Writes one registration row to a Google Sheet using the Google Sheets API
 * with a service account. The credentials only ever exist on the server —
 * nothing sensitive is shipped to the browser.
 *
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL
 *   GOOGLE_PRIVATE_KEY          (newlines as \n)
 *   GOOGLE_SHEET_ID
 * Optional:
 *   GOOGLE_SHEET_RANGE          default "A:M"
 *   REGISTER_SECRET             optional shared token
 */

const SHEET_URL = "https://sheets.googleapis.com/v4/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const HEADERS = [
  "Registration ID",
  "Full Name",
  "Email",
  "Phone Number",
  "Location",
  "User Type",
  "Current Stage",
  "Feeling Behind Response",
  "Expected Outcome",
  "Registration Date",
  "Registration Time",
  "Source",
  "Status",
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ---------- tiny in-memory rate limit (per instance) ---------- */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const win = 60_000;
  const max = 8;
  const rec = (hits.get(ip) || []).filter((t) => now - t < win);
  rec.push(now);
  hits.set(ip, rec);
  if (hits.size > 5000) hits.clear();
  return rec.length > max;
}

/* ---------- helpers ---------- */
const digits = (s) => String(s || "").replace(/\D/g, "");
const normEmail = (s) => String(s || "").trim().toLowerCase();

/** Defuse spreadsheet formula injection and trim length. */
function clean(value, max = 500) {
  let v = String(value ?? "").replace(/\s+/g, " ").trim();
  if (/^[=+\-@]/.test(v)) v = `'${v}`;
  return v.slice(0, max);
}

function fail(status, error) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Exchange a signed service-account JWT for a short-lived access token. */
async function serviceAccountToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !rawKey) throw new Error("Google service account is not configured.");

  const key = rawKey.replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(key).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) throw new Error(json.error_description || "Could not reach Google.");
  return json.access_token;
}

/**
 * Refresh-token grant: writes as the Google account that authorised the CLI.
 * Tokens are cached in memory so a burst of registrations mints one token,
 * not one each.
 */
let cached = { token: null, exp: 0 };

async function refreshTokenGrant() {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  const refresh = process.env.GOOGLE_REFRESH_TOKEN;
  if (!id || !secret || !refresh) throw new Error("Google OAuth is not configured.");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description || json.error || "Could not refresh the Google token.");
  }
  cached = { token: json.access_token, exp: Date.now() + (json.expires_in || 3600) * 1000 };
  return json.access_token;
}

/** Prefer the refresh-token grant; fall back to a service account. */
async function accessToken() {
  if (process.env.GOOGLE_REFRESH_TOKEN) return refreshTokenGrant();
  return serviceAccountToken();
}

/** Read every existing email (C) and phone (D) so we can spot duplicates. */
async function existingPeople(token, sheetId, tab) {
  const readRange = `${tab}!C1:D5000`;
  const res = await fetch(`${SHEET_URL}/${sheetId}/values/${encodeURIComponent(readRange)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Could not read the sheet: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  const rows = json.values || [];
  const emails = new Set();
  const phones = new Set();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const email = normEmail(row[0]);
    const phone = digits(row[1]);
    if (email) emails.add(email);
    if (phone) phones.add(phone);
  }
  return { emails, phones };
}

async function ensureHeaders(token, sheetId, tab) {
  const readRange = `${tab}!A1:M1`;
  const res = await fetch(`${SHEET_URL}/${sheetId}/values/${encodeURIComponent(readRange)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const json = res.ok ? await res.json() : null;
  const first = (json && json.values && json.values[0]) || [];
  if (first.join("") === HEADERS.join("")) return;
  const put = await fetch(`${SHEET_URL}/${sheetId}/values/${encodeURIComponent(readRange)}?valueInputOption=RAW`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ range: readRange, majorDimension: "ROWS", values: [HEADERS] }),
  });
  if (!put.ok) throw new Error(`Could not create the header row: ${(await put.text()).slice(0, 200)}`);
}

async function appendRow(token, sheetId, range, row) {
  const res = await fetch(
    `${SHEET_URL}/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ range, majorDimension: "ROWS", values: [row] }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Could not save the registration: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/* ---------- handler ---------- */
export async function POST(request) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  if (rateLimited(ip)) return fail(429, "Too many attempts. Please wait a minute and try again.");

  const secret = process.env.REGISTER_SECRET;
  if (secret && request.headers.get("x-register-secret") !== secret) {
    return fail(403, "Not allowed.");
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid request.");
  }

  if (body && typeof body.website === "string" && body.website) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  const fullName = clean(body?.fullName, 120);
  const email = normEmail(body?.email);
  const phone = digits(body?.phone);
  const location = clean(body?.location, 120);
  const userType = clean(body?.userType, 80);
  const currentStage = clean(body?.currentStage, 500);
  const feelingBehind = clean(body?.feelingBehind, 80);
  const expectedOutcome = clean(body?.expectedOutcome, 500);
  const source = clean(body?.source || "Direct", 40);

  if (!fullName) return fail(400, "Please enter your full name.");
  if (!EMAIL_RE.test(email)) return fail(400, "Please enter a valid email address.");
  if (phone.length < 7) return fail(400, "Please enter a valid phone number.");
  if (!location) return fail(400, "Please enter your location.");

  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) return fail(500, "Registrations are not open yet. Please try again shortly.");

  /* GOOGLE_SHEET_RANGE may be "A:M" or "Sheet1!A:M". The tab name and the
     append range are separate things — "A:M" is columns, not a tab. */
  const configured = process.env.GOOGLE_SHEET_RANGE || "A:M";
  const tab = process.env.GOOGLE_SHEET_TAB || (configured.includes("!") ? configured.split("!")[0] : "Sheet1");
  const appendRange = configured.includes("!") ? configured.split("!").slice(1).join("!") : configured;
  const range = `${tab}!${appendRange}`;

  try {
    const token = await accessToken();
    await ensureHeaders(token, sheetId, tab);

    const { emails, phones } = await existingPeople(token, sheetId, tab);
    if (emails.has(email) || phones.has(phone)) {
      return new Response(JSON.stringify({ ok: true, duplicate: true }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    const now = new Date();
    const id = `AYRB-${now.getFullYear()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

    await appendRow(token, sheetId, range, [
      id,
      fullName,
      email,
      phone,
      location,
      userType,
      currentStage,
      feelingBehind,
      expectedOutcome,
      now.toISOString().slice(0, 10),
      now.toISOString().slice(11, 19),
      source,
      "Registered",
    ]);

    return new Response(JSON.stringify({ ok: true, duplicate: false, id }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (err) {
    console.error("register failed:", err.message);
    return fail(500, "We couldn't save your registration just now. Please try again.");
  }
}

export async function GET() {
  return new Response(JSON.stringify({ ok: true, service: "register" }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
