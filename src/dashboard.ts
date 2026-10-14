import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { TLSSocket } from "node:tls";
import { createClient } from "@supabase/supabase-js";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const url = required("SUPABASE_URL");
const userId = required("MEMORYVAULT_USER_ID");
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
if (!publishableKey) throw new Error("SUPABASE_PUBLISHABLE_KEY is required for the dashboard");
const port = Number(process.env.PORT ?? process.env.MEMORYVAULT_DASHBOARD_PORT ?? "8787");
const host = process.env.MEMORYVAULT_DASHBOARD_HOST ?? "127.0.0.1";
const publicUrl = process.env.MEMORYVAULT_PUBLIC_URL;
if (publicUrl && !/^https:\/\//u.test(publicUrl) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/?$/u.test(publicUrl)) {
  throw new Error("MEMORYVAULT_PUBLIC_URL must use HTTPS outside localhost");
}
const publicClient = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
const acceptScript = `if(location.hash.includes("access_token=")){const p=new URLSearchParams(location.hash.slice(1));const token=p.get("access_token");history.replaceState(null,"",location.pathname);if(token)fetch("/auth/accept",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({access_token:token})}).then(r=>location.assign(r.ok?"/":"/?auth=failed"))}`;
const scriptHash = createHash("sha256").update(acceptScript).digest("base64");

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/gu, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] ?? char);
}

function cookies(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries((request.headers.cookie ?? "").split(";").map(part => part.trim().split("=").map(decodeURIComponent)).filter(parts => parts.length === 2) as [string, string][]);
}

function clientFor(token: string) {
  return createClient(url, publishableKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

async function form(request: IncomingMessage): Promise<URLSearchParams> {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 10000) throw new Error("form too large");
  }
  return new URLSearchParams(raw);
}

function html(response: ServerResponse, content: string, status = 200) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": `default-src 'none'; script-src 'sha256-${scriptHash}'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` });
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MemoryVault · Review</title><style>
  :root{color-scheme:light;--ink:#14242a;--muted:#60737a;--line:#d9e2df;--paper:#f5f7f3;--white:#fff;--teal:#126a61;--teal-light:#e2f2ed;--amber:#8f5b10;--amber-light:#fff1d6;--red:#a23431;--red-light:#fae9e7}
  *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--teal)}.wrap{max-width:1280px;margin:auto;padding:0 28px 64px}.topbar{border-bottom:1px solid var(--line);background:var(--white)}.topbar .wrap{padding-top:17px;padding-bottom:17px;display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{font-size:16px;font-weight:800;letter-spacing:-.04em}.brand span{display:inline-block;background:var(--teal);color:#fff;border-radius:7px;padding:2px 7px;margin-right:8px;font-size:12px;letter-spacing:0}.topright{display:flex;align-items:center;gap:15px;color:var(--muted);font-size:13px}.hero{display:flex;justify-content:space-between;align-items:end;gap:20px;padding:38px 0 24px}.eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:11px;color:var(--teal);font-weight:800}h1{font-size:clamp(27px,4vw,42px);line-height:1.12;letter-spacing:-.055em;margin:6px 0 8px}h2{font-size:18px;letter-spacing:-.025em;margin:0}p{margin:6px 0}.muted,.meta{color:var(--muted)}.meta{font-size:12px}.status{display:inline-flex;align-items:center;gap:7px;background:var(--teal-light);color:var(--teal);border-radius:100px;padding:6px 11px;font-size:12px;font-weight:750;white-space:nowrap}.status:before{content:"";width:7px;height:7px;background:var(--teal);border-radius:100%}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:0 0 26px}.stat{background:var(--white);border:1px solid var(--line);border-radius:13px;padding:17px 20px}.stat strong{display:block;font-size:29px;letter-spacing:-.06em;line-height:1.1}.stat span{color:var(--muted);font-size:12px}.grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(285px,1fr);gap:18px;align-items:start}.panel{background:var(--white);border:1px solid var(--line);border-radius:14px;overflow:hidden;margin-bottom:18px}.panelhead{padding:18px 20px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:12px}.panelbody{padding:0 20px}.count{color:var(--muted);font-size:12px}.memory{padding:18px 0;border-bottom:1px solid var(--line)}.memory:last-child{border-bottom:0}.memorytop{display:flex;justify-content:space-between;gap:12px;align-items:start}.key{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:var(--teal)}.value{font-size:17px;font-weight:700;overflow-wrap:anywhere;margin:4px 0}.badge{display:inline-block;border-radius:6px;padding:3px 8px;font-size:11px;font-weight:750;background:var(--amber-light);color:var(--amber);white-space:nowrap}.badge.active{background:var(--teal-light);color:var(--teal)}.badge.blocked{background:var(--red-light);color:var(--red)}.source{font-size:12px;color:var(--muted);margin-top:9px}.evidence{background:#f5f7f6;border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:10px 0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:160px;overflow:auto}mark{background:#fce09c;border-radius:2px}details{font-size:12px;color:var(--muted);margin:10px 0}summary{cursor:pointer;font-weight:700;color:var(--teal)}pre{white-space:pre-wrap;overflow-wrap:anywhere}form{display:inline-block;margin:0}button{border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:7px;padding:8px 12px;font:inherit;font-size:12px;font-weight:750;cursor:pointer}button:hover{background:#edf3f0}button.primary{background:var(--teal);color:#fff;border-color:var(--teal)}button.primary:hover{background:#0c514a}.actions{display:flex;gap:7px;margin-top:12px}.empty{color:var(--muted);padding:25px 0;font-size:13px}.active-list .memory{padding:14px 0}.active-list .value{font-size:14px}.tablewrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:12px}th{text-align:left;color:var(--muted);font-size:11px;letter-spacing:.06em;text-transform:uppercase;font-weight:700}td,th{padding:11px 10px;border-bottom:1px solid var(--line);vertical-align:top}td{overflow-wrap:anywhere}tr:last-child td{border-bottom:0}.login{max-width:430px;margin:10vh auto;background:#fff;border:1px solid var(--line);border-radius:15px;padding:28px}.login label{display:block;margin:15px 0;font-size:12px;font-weight:750}.login input{display:block;width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;margin-top:5px;font:inherit}.note{border-left:3px solid var(--teal);padding-left:12px;color:var(--muted);font-size:12px;margin:13px 0 0}
  @media(max-width:850px){.grid{grid-template-columns:1fr}.hero{align-items:start}.stats{gap:8px}.stat{padding:13px}}@media(max-width:550px){.wrap{padding-left:16px;padding-right:16px}.topright{gap:6px}.topright .muted{display:none}.hero{display:block}.status{margin-top:9px}.stats{grid-template-columns:repeat(3,minmax(0,1fr))}.stat strong{font-size:22px}}
  </style><body>${content}<script>${acceptScript}</script></body></html>`);
}

function redirect(response: ServerResponse) {
  response.writeHead(303, { location: "/", "cache-control": "no-store" });
  response.end();
}

function setLoginCookies(request: IncomingMessage, response: ServerResponse, token: string) {
  const csrf = randomBytes(24).toString("hex");
  const secure = (publicUrl?.startsWith("https://") || request.socket instanceof TLSSocket && request.socket.encrypted) ? "; Secure" : "";
  response.setHeader("set-cookie", [
    `mv_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600${secure}`,
    `mv_csrf=${csrf}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600${secure}`,
  ]);
}

async function handler(request: IncomingMessage, response: ServerResponse) {
  const path = new URL(request.url ?? "/", `http://localhost:${port}`).pathname;
  const jar = cookies(request);
  const token = jar.mv_session;
  if (path === "/auth/accept" && request.method === "POST") {
    const data = await form(request);
    const accessToken = data.get("access_token") ?? "";
    const result = await publicClient.auth.getUser(accessToken);
    if (result.error || !result.data.user?.email_confirmed_at) { html(response, "<h1>Invalid sign-in link</h1>", 401); return; }
    setLoginCookies(request, response, accessToken);
    redirect(response);
    return;
  }
  if (path === "/login/link" && request.method === "POST") {
    if (!publicUrl) { html(response, "<h1>Email sign-in is not configured</h1>", 503); return; }
    const data = await form(request);
    const email = (data.get("email") ?? "").trim().toLowerCase();
    const result = await publicClient.auth.signInWithOtp({ email, options: { emailRedirectTo: publicUrl, shouldCreateUser: true } });
    if (result.error) { html(response, `<div class="login"><h1>Could not send link</h1><p>${escapeHtml(result.error.message)}</p><a href="/">Try again</a></div>`, 400); return; }
    html(response, `<div class="login"><h1>Check your email</h1><p>A sign-in link was sent to ${escapeHtml(email)}.</p><a href="/">Back to sign in</a></div>`);
    return;
  }
  if (path === "/login" && request.method === "POST") {
    const data = await form(request);
    const result = await publicClient.auth.signInWithPassword({ email: data.get("email") ?? "", password: data.get("password") ?? "" });
    if (result.error || !result.data.session) {
      html(response, "<h1>Sign in failed</h1><p>Check the account and password.</p><a href='/'>Try again</a>", 401);
      return;
    }
    setLoginCookies(request, response, result.data.session.access_token);
    redirect(response);
    return;
  }
  if (!token) {
    html(response, `<div class="login"><div class="brand"><span>MV</span>MemoryVault</div><div class="eyebrow" style="margin-top:27px">Private memory workspace</div><h1>Sign in to MemoryVault</h1><p class="muted">Review your memories or open memories shared with your email.</p>${publicUrl ? `<form method="post" action="/login/link"><label>Email <input name="email" type="email" autocomplete="username" required></label><button class="primary">Email me a sign-in link</button></form><hr><p class="meta">Owner password sign-in</p>` : ""}<form method="post" action="/login"><label>Email <input name="email" type="email" autocomplete="username" required></label><label>Password <input name="password" type="password" autocomplete="current-password" required></label><button>Sign in with password</button></form></div>`);
    return;
  }
  const db = clientFor(token);
  const user = await db.auth.getUser(token);
  if (user.error || !user.data.user) {
    response.setHeader("set-cookie", "mv_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    html(response, "<h1>Session expired</h1><a href='/'>Sign in</a>", 401);
    return;
  }
  const isOwner = user.data.user.id === userId;
  if (request.method === "POST") {
    const data = await form(request);
    if (!jar.mv_csrf || data.get("csrf") !== jar.mv_csrf) {
      html(response, "<h1>Invalid request token</h1>", 403);
      return;
    }
    if (path === "/logout") {
      response.setHeader("set-cookie", ["mv_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0", "mv_csrf=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"]);
      redirect(response);
      return;
    }
    if (!isOwner) { html(response, "<h1>Only the owner can change sharing</h1>", 403); return; }
    if (path === "/share/grant") {
      const email = (data.get("email") ?? "").trim().toLowerCase();
      const grant = await db.rpc("grant_memory_access", { p_email: email });
      if (grant.error) { html(response, `<h1>Could not share</h1><p>${escapeHtml(grant.error.message)}</p><a href="/">Back</a>`, 400); return; }
      if (publicUrl) {
        const invitation = await publicClient.auth.signInWithOtp({ email, options: { emailRedirectTo: publicUrl, shouldCreateUser: true } });
        if (invitation.error) { html(response, `<h1>Access granted, email failed</h1><p>${escapeHtml(invitation.error.message)}</p><p>They can sign in at ${escapeHtml(publicUrl)} using this email.</p><a href="/">Back</a>`, 502); return; }
      }
      redirect(response);
      return;
    }
    if (path === "/share/revoke") {
      const result = await db.rpc("revoke_memory_access", { p_email: data.get("email") ?? "" });
      if (result.error) throw result.error;
      redirect(response);
      return;
    }
    const sharing = /^\/memory\/([0-9a-f-]{36})\/(share|unshare)$/u.exec(path);
    if (sharing) {
      const result = await db.rpc("set_memory_shared", { p_id: sharing[1], p_shared: sharing[2] === "share" });
      if (result.error) throw result.error;
      redirect(response);
      return;
    }
    const match = /^\/memory\/([0-9a-f-]{36})\/(approve|reject|revoke)$/u.exec(path);
    if (match) {
      const result = await db.rpc(match[2] === "approve" ? "approve_memory" : match[2] === "revoke" ? "revoke_memory" : "reject_memory", { p_id: match[1] });
      if (result.error) throw result.error;
      redirect(response);
      return;
    }
    html(response, "<h1>Not found</h1>", 404);
    return;
  }
  const inspection = /^\/memory\/([0-9a-f-]{36})$/u.exec(path);
  if (inspection && isOwner) {
    const result = await db.rpc("inspect_memory", { p_id: inspection[1] });
    if (result.error) throw result.error;
    const data = result.data as { memories: { id: string; key: string; value: string; status: string; derived_from: string[] }[];
      events: { memory_id: string; session_id: string; event: string; ts: string; deciding_rule: string; action_id?: string }[];
      sources: { content: string; source_ref: string; content_sha256: string }[];
      actions: { id: string; session_id: string; sent_recipients: string[]; blocked_recipients: string[] }[] };
    const memory = data.memories.find(m => m.id === inspection[1]);
    if (!memory) { html(response, "<h1>Memory not found</h1>", 404); return; }
    const link = (id: string) => `<a href="/memory/${escapeHtml(id)}">${escapeHtml(id)}</a>`;
    const nodes = data.memories.map(m => `<article class="memory"><div class="key">${escapeHtml(m.key)} · ${escapeHtml(m.status)}</div><p>${escapeHtml(m.value)}</p>${link(m.id)}<p class="meta">Parents: ${m.derived_from.map(link).join(", ") || "None"}</p></article>`).join("");
    const timeline = data.events.map(e => `<tr><td>${escapeHtml(e.ts)}</td><td>${escapeHtml(e.event)}</td><td>${escapeHtml(e.session_id)}</td><td>${link(e.memory_id)}</td><td>${escapeHtml(e.deciding_rule)}${e.action_id ? `<p>Outbox: ${escapeHtml(e.action_id)}</p>` : ""}</td></tr>`).join("");
    html(response, `<main class="wrap"><div class="hero"><div><a href="/">← Memory review</a><h1>Memory lineage & usage</h1><p>${escapeHtml(memory.value)}</p></div></div>
      ${["active", "quarantined"].includes(memory.status) ? `<section class="panel"><div class="panelhead"><h2>Contain this memory</h2></div><div class="panelbody"><p>Revoke this memory and all derived descendants. Future recall and sharing exclude them. Past deliveries cannot be undone.</p><form method="post" action="/memory/${escapeHtml(memory.id)}/revoke"><input type="hidden" name="csrf" value="${escapeHtml(jar.mv_csrf)}"><button>Revoke memory and descendants</button></form></div></section>` : ""}
      <section class="panel"><div class="panelhead"><h2>Sources</h2></div><div class="panelbody">${data.sources.map(source => `<p>${escapeHtml(source.source_ref || "User message")} · SHA-256 ${escapeHtml(source.content_sha256)}</p><pre class="evidence">${escapeHtml(source.content)}</pre>`).join("") || "No recorded source"}</div></section>
      <section class="panel"><div class="panelhead"><h2>Ancestors and descendants</h2></div><div class="panelbody">${nodes}</div></section>
      <section class="panel"><div class="panelhead"><h2>Usage timeline</h2></div><div class="tablewrap"><table><thead><tr><th>Time</th><th>Event</th><th>Session</th><th>Memory</th><th>Rule / action</th></tr></thead><tbody>${timeline}</tbody></table></div></section>
      <section class="panel"><div class="panelhead"><h2>Affected actions</h2></div><div class="panelbody">${data.actions.map(action => `<article class="memory"><p>Outbox ${escapeHtml(action.id)} · Session ${escapeHtml(action.session_id)}</p><p>Allowed: ${escapeHtml(action.sent_recipients.join(", ")) || "None"}</p><p>Blocked: ${escapeHtml(action.blocked_recipients.join(", ")) || "None"}</p></article>`).join("") || "No actions recorded"}</div></section></main>`);
    return;
  }
  if (path !== "/") { html(response, "<h1>Not found</h1>", 404); return; }
  const shared = await db.rpc("list_shared_memories");
  if (shared.error) throw shared.error;
  const sharedRows = (shared.data ?? []).map((memory: { key: string; value: string; owner_email: string; created_at: string }) => `<article class="memory"><div class="key">${escapeHtml(memory.key.replaceAll("_", " "))}</div><div class="value">${escapeHtml(memory.value)}</div><div class="meta">Shared by ${escapeHtml(memory.owner_email)} · ${escapeHtml(memory.created_at)}</div></article>`).join("") || `<div class="empty">No memories have been shared with your email yet.</div>`;
  if (!isOwner) {
    html(response, `<header class="topbar"><div class="wrap"><div class="brand"><span>MV</span>MemoryVault</div><form method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(jar.mv_csrf)}"><button>Sign out</button></form></div></header><main class="wrap"><div class="hero"><div><div class="eyebrow">Shared with ${escapeHtml(user.data.user.email)}</div><h1>Shared memories</h1><p class="muted">Active memories their owner chose to share with you.</p></div></div><section class="panel"><div class="panelhead"><h2>Your shared view</h2></div><div class="panelbody">${sharedRows}</div></section></main>`);
    return;
  }
  const [memories, events, ledger, outbox, documents, grants] = await Promise.all([
    db.from("memories").select("id,key,value,origin,origin_ref,status,is_shared,session_id,created_at").order("created_at", { ascending: false }).limit(200),
    db.from("memory_events").select("memory_id,deciding_rule,steps,agent_claim,ts").order("ts", { ascending: false }).limit(100),
    db.from("ledger_events").select("id,source_ref,content").order("ts", { ascending: false }).limit(200),
    db.from("share_attempts").select("session_id,requested_recipients,sent_recipients,blocked_recipients,decision,deciding_rule,gates_enabled,ts").order("ts", { ascending: false }).limit(30),
    db.from("documents").select("id,title").order("created_at", { ascending: false }).limit(200),
    db.from("memory_shares").select("recipient_email,created_at").order("created_at", { ascending: false }).limit(100),
  ]);
  for (const result of [memories, events, ledger, outbox, documents, grants]) if (result.error) throw result.error;
  const eventByMemory = new Map<string, NonNullable<typeof events.data>[number]>();
  for (const event of events.data ?? []) if (event.memory_id && !eventByMemory.has(event.memory_id)) eventByMemory.set(event.memory_id, event);
  const ledgerById = new Map((ledger.data ?? []).map(event => [event.id, event]));
  const documentById = new Map((documents.data ?? []).map(document => [document.id, document.title]));
  const all = memories.data ?? [];
  const pending = all.filter(memory => memory.status === "quarantined");
  const active = all.filter(memory => memory.status === "active");
  const queue = pending.map(memory => {
    const trace = eventByMemory.get(memory.id);
    const source = ledgerById.get(memory.origin_ref);
    const sourceName = source?.source_ref?.startsWith("document:")
      ? documentById.get(source.source_ref.slice("document:".length)) ?? source.source_ref
      : source?.source_ref ?? "unknown";
    const span = source?.content.slice(0, 800) ?? "Source span unavailable in recent ledger";
    const escapedValue = escapeHtml(memory.value);
    const highlightedSpan = escapedValue ? escapeHtml(span).replaceAll(escapedValue, `<mark>${escapedValue}</mark>`) : escapeHtml(span);
    const actions = `<div class="actions">${["approve", "reject"].map(action => `<form method="post" action="/memory/${escapeHtml(memory.id)}/${action}"><input type="hidden" name="csrf" value="${escapeHtml(jar.mv_csrf)}"><button class="${action === "approve" ? "primary" : ""}">${action === "approve" ? "Approve memory" : "Reject"}</button></form>`).join("")}</div>`;
    return `<article class="memory"><a href="/memory/${escapeHtml(memory.id)}">Inspect lineage & usage</a><div class="memorytop"><div><div class="key">${escapeHtml(memory.key.replaceAll("_", " "))}</div><div class="value">${escapeHtml(memory.value)}</div></div><span class="badge">Needs review</span></div><p class="meta">${escapeHtml(memory.origin)} · Rule ${escapeHtml(trace?.deciding_rule ?? "unknown")} · ${escapeHtml(memory.created_at)}</p><div class="source">Source: ${escapeHtml(sourceName)}</div><div class="evidence">${highlightedSpan}</div><details><summary>View decision trace</summary><pre>${escapeHtml(JSON.stringify(trace?.steps ?? [], null, 2))}</pre><p>Agent claim (untrusted): ${escapeHtml(trace?.agent_claim ?? "none")}</p></details>${actions}</article>`;
  }).join("") || "<div class='empty'>Nothing is waiting for review.</div>";
  const activeList = active.map(memory => `<article class="memory"><a href="/memory/${escapeHtml(memory.id)}">Inspect lineage & usage</a><div class="memorytop"><div><div class="key">${escapeHtml(memory.key.replaceAll("_", " "))}</div><div class="value">${escapeHtml(memory.value)}</div><div class="meta">${escapeHtml(memory.origin)} · ${escapeHtml(memory.created_at)}</div></div><span class="badge active">${memory.is_shared ? "Shared" : "Private"}</span></div><div class="actions"><form method="post" action="/memory/${escapeHtml(memory.id)}/${memory.is_shared ? "unshare" : "share"}"><input type="hidden" name="csrf" value="${escapeHtml(jar.mv_csrf)}"><button>${memory.is_shared ? "Make private" : "Share this memory"}</button></form></div></article>`).join("") || "<div class='empty'>No active memories yet.</div>";
  const grantRows = (grants.data ?? []).map(grant => `<article class="memory"><div class="memorytop"><div><div class="value">${escapeHtml(grant.recipient_email)}</div><div class="meta">Can view every active memory marked Shared</div></div><form method="post" action="/share/revoke"><input type="hidden" name="csrf" value="${escapeHtml(jar.mv_csrf)}"><input type="hidden" name="email" value="${escapeHtml(grant.recipient_email)}"><button>Remove access</button></form></div></article>`).join("") || `<div class="empty">No one has access yet.</div>`;
  const rows = (outbox.data ?? []).map(item => `<tr><td>${escapeHtml(new Date(item.ts).toLocaleString())}</td><td>${escapeHtml(item.gates_enabled ? "Protected" : "Baseline")}</td><td>${escapeHtml(item.sent_recipients.join(", ") || "—")}</td><td>${item.blocked_recipients.length ? `<span class="badge blocked">${escapeHtml(item.blocked_recipients.join(", "))}</span>` : "—"}</td><td>${escapeHtml(item.deciding_rule ?? "—")}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">No simulated shares yet.</td></tr>`;
  const archive = all.filter(memory => !["active", "quarantined"].includes(memory.status)).map(memory => `<article class="memory"><a href="/memory/${escapeHtml(memory.id)}">${escapeHtml(memory.key)} · ${escapeHtml(memory.status)}</a><p>${escapeHtml(memory.value)}</p></article>`).join("");
  const blockedCount = (outbox.data ?? []).filter(item => item.blocked_recipients.length > 0 && item.gates_enabled).length;
  html(response, `<header class="topbar"><div class="wrap"><div class="brand"><span>MV</span>MemoryVault</div><div class="topright"><span class="muted">Review workspace</span><form method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(jar.mv_csrf)}"><button>Sign out</button></form></div></div></header><main class="wrap"><div class="hero"><div><div class="eyebrow">Trust & provenance</div><h1>Memory review</h1><p class="muted">Inspect what the agent wants to remember before it becomes trusted.</p></div><span class="status">Private workspace</span></div><div class="stats"><div class="stat"><strong>${pending.length}</strong><span>Awaiting review</span></div><div class="stat"><strong>${active.length}</strong><span>Active memories</span></div><div class="stat"><strong>${(grants.data ?? []).length}</strong><span>People with access</span></div></div><div class="grid"><section class="panel"><div class="panelhead"><h2>Quarantine queue</h2><span class="count">${pending.length} pending</span></div><div class="panelbody">${queue}</div></section><div><section class="panel"><div class="panelhead"><h2>Active memories</h2><span class="count">${active.length} active</span></div><div class="panelbody active-list">${activeList}</div></section><section class="panel"><div class="panelhead"><h2>Share with people</h2><span class="count">${(grants.data ?? []).length} invited</span></div><div class="panelbody"><p class="meta">Invite an email to view every memory you mark Shared. Access can be removed any time.</p><form method="post" action="/share/grant"><input type="hidden" name="csrf" value="${escapeHtml(jar.mv_csrf)}"><label>Email <input name="email" type="email" required placeholder="person@example.com"></label><button class="primary">Grant access</button></form>${publicUrl ? `<p class="meta">A sign-in link will be emailed.</p>` : `<p class="meta">Email delivery needs MEMORYVAULT_PUBLIC_URL and a public dashboard deployment.</p>`}${grantRows}</div></section></div></div><section class="panel"><div class="panelhead"><div><h2>Report sharing activity</h2><p class="meta">Simulated report delivery; no email is sent.</p></div><span class="count">${blockedCount} blocked</span></div><div class="tablewrap"><table><thead><tr><th>Time</th><th>Mode</th><th>Allowed recipients</th><th>Blocked recipients</th><th>Rule</th></tr></thead><tbody>${rows}</tbody></table></div></section><section class="panel"><div class="panelhead"><h2>Memory archive</h2></div><div class="panelbody">${archive || "No archived memories"}</div></section><p class="note">Sharing memories gives read-only access to selected memories. It does not authorize report recipients; only report recipient and cc memories affect that gate.</p></main>`);
}

createServer((request, response) => {
  handler(request, response).catch(error => {
    process.stderr.write(`Dashboard error: ${String(error)}\n`);
    html(response, "<h1>Request failed</h1><p>Check the server log.</p>", 500);
  });
}).listen(port, host, () => process.stderr.write(`MemoryVault dashboard listening on ${host}:${port}\n`));
