// idea: the DeepSeek Harness plugin for an idea machine (browser half).
//
// Adds an "idea" entry to the dsh sidebar. Before pairing it asks for the
// machine's address and setup code. After pairing it has two tabs:
// - Sessions: the machine's own dsh (its workspaces, sessions and
//   transcripts, as dsh draws them), on the main VM or a worker VM, framed
//   through this plugin's local proxy (lib/view-proxy.js).
// - Team: every agent (team members and task agents) with what it is doing,
//   and the messages the agents send each other (lib/team-view.js).
//
// Hand-written in the client-module format dsh serves (a factory registered
// with the page's module loader; React comes from dsh's shared module table),
// so the plugin installs without a build step.
window.__ModuleLoader__.load({
  id: "@popododo0720/dsh-idea",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const PANEL_ID = "idea";

    // Styled with dsh's own design tokens (--dsw-*: colors, fonts, radii),
    // so the panel follows the dsh theme, font and size settings. The
    // fallbacks only matter outside dsh.
    const CSS = `
.idea-root{--idea-text:var(--dsw-alias-label-primary,#0f1115);--idea-text-2:var(--dsw-alias-label-secondary,#61666b);--idea-text-3:var(--dsw-alias-label-tertiary,#81858c);--idea-bg:var(--dsw-alias-bg-base,#fff);--idea-surface:var(--dsw-alias-bg-layer-1,#fff);--idea-line:var(--dsw-alias-border-l2,#0000001a);--idea-line-soft:var(--dsw-alias-border-l1,#0000000a);--idea-hover:var(--dsw-alias-interactive-bg-hover,#2631480f);--idea-active:var(--dsw-specific-sidebar-nav-item-active,#ebeef2);--idea-ok:var(--dsw-alias-state-success-primary,#22c55e);--idea-warn:var(--dsw-alias-state-warn-primary,#f59e0b);--idea-bad:var(--dsw-alias-state-error-primary,#ec1313);--idea-idle:var(--dsw-alias-state-idle-primary,#d4d4d4);--idea-link:var(--dsw-alias-link,#4176e6);--idea-mono:var(--ds-font-family-code,ui-monospace,Menlo,monospace);--idea-r-sm:var(--dsw-radius-sm,8px);--idea-r-md:var(--dsw-radius-md,12px)}
.idea-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--idea-text);background:var(--idea-bg);font-family:var(--dsw-font-family,system-ui,sans-serif);font-size:var(--dsh-content-font-size,14px);line-height:1.5;color-scheme:light}
body[data-ds-dark-theme] .idea-root{color-scheme:dark}
.idea-bar{display:flex;align-items:center;gap:8px;height:48px;padding:0 12px 0 16px;border-bottom:1px solid var(--idea-line-soft);flex:none}
.idea-bar .idea-name{font-weight:600}
.idea-bar .idea-sub{color:var(--idea-text-3);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.idea-grow{flex:1;min-width:0}
.idea-frame{flex:1;min-height:0;border:0;width:100%;background:transparent}
.idea-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:var(--idea-r-sm);border:1px solid var(--idea-line);background:transparent;color:var(--idea-text);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.idea-btn:hover{background:var(--idea-hover)}
.idea-btn[disabled]{opacity:.5;cursor:default}
.idea-btn-danger{color:var(--idea-bad)}
.idea-btn-primary{height:36px;font-size:14px;font-weight:500;background:var(--dsw-alias-brand-primary,#0f1115);border-color:transparent}
.idea-btn-primary>span{color:var(--idea-bg)}
.idea-btn-primary:hover{background:var(--dsw-alias-brand-primary,#0f1115);opacity:.9}
.idea-center{max-width:420px;margin:56px auto;padding:0 20px}
.idea-stack>*+*{margin-top:16px}
.idea-field{display:flex;flex-direction:column;gap:6px}
.idea-label{font-weight:500;font-size:13px}
.idea-hint{font-size:13px;color:var(--idea-text-3);margin:0}
.idea-input{width:100%;box-sizing:border-box;border:1px solid var(--idea-line);border-radius:var(--idea-r-sm);background:transparent;color:var(--idea-text);padding:7px 10px;font:inherit;font-size:13px}
.idea-input:focus{outline:2px solid color-mix(in srgb,var(--idea-link) 45%,transparent);outline-offset:-1px}
.idea-input option{background:var(--idea-surface);color:var(--idea-text)}
.idea-input option:disabled{color:var(--idea-text-3)}
.idea-vm{width:auto;max-width:240px;height:30px;padding:0 8px}
.idea-alert{border:1px solid color-mix(in srgb,var(--idea-bad) 40%,transparent);color:var(--idea-bad);border-radius:var(--idea-r-sm);padding:10px 12px;font-size:13px}
.idea-tabs{display:flex;gap:2px;margin-left:4px}
.idea-tab{height:30px;padding:0 12px;border:0;border-radius:var(--idea-r-sm);background:transparent;color:var(--idea-text-2);font:inherit;font-size:13px;cursor:pointer}
.idea-tab:hover{background:var(--idea-hover)}
.idea-tab[aria-selected="true"]{background:var(--idea-active);color:var(--idea-text);font-weight:500}
.idea-hide{display:none!important}
.idea-team{display:flex;flex:1;min-height:0}
.idea-agents{width:300px;flex:none;overflow:auto;border-right:1px solid var(--idea-line-soft);padding:8px}
.idea-chat{flex:1;min-width:0;overflow:auto;padding:16px 20px}
@media (max-width:720px){.idea-team{flex-direction:column}.idea-agents{width:auto;max-height:45%;border-right:0;border-bottom:1px solid var(--idea-line-soft)}}
.idea-group{display:flex;align-items:center;gap:6px;min-height:28px;color:var(--idea-text-3);font-size:13px;margin:12px 8px 4px}
.idea-group:first-child{margin-top:4px}
.idea-card{display:block;width:100%;text-align:left;border:0;border-radius:var(--idea-r-md);background:transparent;color:var(--idea-text);font:inherit;padding:8px 10px;margin:0 0 2px;cursor:pointer}
.idea-card:hover{background:var(--idea-hover)}
.idea-card[aria-pressed="true"]{background:var(--idea-active)}
.idea-row{display:flex;align-items:center;gap:8px;min-width:0}
.idea-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--idea-idle)}
.idea-dot-working{background:var(--idea-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--idea-ok) 25%,transparent)}
.idea-dot-unknown{background:var(--idea-warn)}
.idea-dot-failed{background:var(--idea-bad)}
.idea-dot-stopped{background:transparent;border:1.5px solid var(--idea-idle);box-sizing:border-box}
.idea-who{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.idea-tag{font-family:var(--idea-mono);font-size:12px;color:var(--idea-text-3);white-space:nowrap}
.idea-line1{font-size:13px;color:var(--idea-text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;padding-left:16px}
.idea-head{display:flex;align-items:center;gap:8px;margin-bottom:16px;min-height:30px}
.idea-head strong{font-weight:600}
.idea-msg{margin:0 0 16px}
.idea-msg-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;font-size:13px;margin-bottom:6px;color:var(--idea-text-2)}
.idea-msg-head strong{color:var(--idea-text);font-weight:600}
.idea-msg-body{white-space:pre-wrap;word-break:break-word;margin:0;padding:10px 14px;border-radius:var(--idea-r-md);background:var(--idea-surface);border:1px solid var(--idea-line-soft);font:inherit;color:var(--idea-text)}
.idea-link{background:none;border:0;padding:0;color:var(--idea-link);font:inherit;font-size:13px;cursor:pointer}
.idea-link:hover{text-decoration:underline}
.idea-group .idea-link{color:var(--idea-text-2);font-weight:500}
.idea-board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:0 0 20px}
@media (max-width:900px){.idea-board{grid-template-columns:repeat(2,minmax(0,1fr))}}
.idea-col{min-width:0;border-radius:var(--idea-r-md);background:var(--idea-surface);border:1px solid var(--idea-line-soft);padding:8px}
.idea-col-head{display:flex;justify-content:space-between;font-size:13px;color:var(--idea-text-3);margin:0 2px 6px}
.idea-task{border-radius:var(--idea-r-sm);border:1px solid var(--idea-line-soft);background:var(--idea-bg);padding:6px 8px;margin-top:6px;font-size:13px}
.idea-task-mine{border-color:color-mix(in srgb,var(--idea-link) 55%,transparent)}
.idea-task-meta{font-size:12px;color:var(--idea-text-3);margin-top:2px}
.idea-pick-wrap{position:relative;display:inline-flex}
.idea-pick{display:inline-flex;align-items:center;gap:6px;height:30px;max-width:280px;padding:0 10px;border:0;border-radius:var(--idea-r-sm);background:transparent;color:var(--idea-text);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.idea-pick:hover,.idea-pick[aria-expanded="true"]{background:var(--idea-hover)}
.idea-pick>span{overflow:hidden;text-overflow:ellipsis}
.idea-pick-sub{color:var(--idea-text-3)}
.idea-menu{position:absolute;z-index:60;top:calc(100% + 6px);min-width:220px;max-width:360px;max-height:min(420px,70vh);overflow:auto;padding:6px;border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-menu-surface-fill,var(--idea-surface));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));border:1px solid var(--idea-line-soft);box-shadow:0 12px 32px rgba(0,0,0,.22);color:var(--idea-text);text-align:left}
.idea-menu-right{right:0}
.idea-menu-left{left:0}
.idea-menu-head{padding:6px 8px 2px;color:var(--idea-text-3);font-size:11px;line-height:16px;font-weight:500}
.idea-menu-head:first-child{padding-top:2px}
.idea-menu-item{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:6px 10px;border:0;border-radius:var(--idea-r-md);background:transparent;color:var(--idea-text);font:inherit;font-size:14px;text-align:left;cursor:pointer}
.idea-menu-item:hover{background:var(--idea-hover)}
.idea-menu-item[disabled]{opacity:.45;cursor:default;background:transparent}
.idea-menu-item>.idea-grow{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.idea-menu-detail{color:var(--idea-text-3);font-size:13px;white-space:nowrap}
.idea-menu-danger{color:var(--idea-bad)}
.idea-menu-search{width:100%;box-sizing:border-box;border:0;background:transparent;color:var(--idea-text);font:inherit;font-size:14px;padding:6px 10px 8px;outline:none}
.idea-menu-search::placeholder{color:var(--idea-text-3)}
.idea-git{display:flex;flex:1;min-height:0}
.idea-git-side{width:380px;flex:none;overflow:auto;border-right:1px solid var(--idea-line-soft);padding:4px 8px 16px}
.idea-git-main{flex:1;min-width:0;display:flex;flex-direction:column}
@media (max-width:820px){.idea-git{flex-direction:column}.idea-git-side{width:auto;max-height:50%;border-right:0;border-bottom:1px solid var(--idea-line-soft)}}
.idea-git-bar{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--idea-line-soft);flex:none;flex-wrap:wrap}
.idea-sec{margin-top:8px}
.idea-sec-head{display:flex;align-items:center;gap:6px;height:30px;padding:0 4px 0 6px;border-radius:var(--idea-r-sm);color:var(--idea-text-2);font-size:13px;font-weight:600;cursor:pointer;user-select:none}
.idea-sec-head:hover{background:var(--idea-hover)}
.idea-count{color:var(--idea-text-3);font-weight:400}
.idea-chev{width:12px;height:12px;flex:none;transition:transform .12s;color:var(--idea-text-3)}
.idea-chev-open{transform:rotate(90deg)}
.idea-sub-head{padding:6px 8px 2px;color:var(--idea-text-3);font-size:12px}
.idea-item{display:flex;align-items:center;gap:8px;min-height:30px;padding:2px 4px 2px 8px;border-radius:var(--idea-r-sm);cursor:pointer;font-size:13px;min-width:0}
.idea-item:hover{background:var(--idea-hover)}
.idea-item[aria-selected="true"]{background:var(--idea-active)}
.idea-item .idea-acts{display:none;gap:2px;flex:none}
.idea-item:hover .idea-acts,.idea-item[aria-selected="true"] .idea-acts,.idea-item .idea-acts:focus-within{display:inline-flex}
.idea-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.idea-dim{color:var(--idea-text-3)}
.idea-st{font-family:var(--idea-mono);font-size:12px;width:14px;text-align:center;flex:none;font-weight:600}
.idea-st-A,.idea-st-U{color:var(--idea-ok)}
.idea-st-M,.idea-st-R,.idea-st-C{color:var(--idea-warn)}
.idea-st-D{color:var(--idea-bad)}
.idea-mini{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--idea-text-2);cursor:pointer;font:inherit;font-size:15px;line-height:1}
.idea-mini:hover{background:var(--idea-active);color:var(--idea-text)}
.idea-commit-box{margin:6px 4px 4px;display:flex;flex-direction:column;gap:6px}
.idea-commit-box textarea{min-height:56px;resize:vertical;font-family:var(--dsw-font-family,system-ui,sans-serif)}
.idea-check{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--idea-text-2)}
.idea-refs{font-size:11px;color:var(--idea-link);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%}
.idea-diff-head{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--idea-line-soft);font-size:13px;color:var(--idea-text-2);flex:none;min-height:24px}
.idea-diff{flex:1;min-height:0;overflow:auto;margin:0;padding:8px 0;font-family:var(--idea-mono);font-size:var(--dsh-code-font-size,12px);line-height:1.6;white-space:pre;tab-size:4}
.idea-diff>div{padding:0 16px;min-width:max-content}
.idea-dl-add{background:color-mix(in srgb,var(--idea-ok) 14%,transparent)}
.idea-dl-del{background:color-mix(in srgb,var(--idea-bad) 14%,transparent)}
.idea-dl-hunk{color:var(--idea-link);background:color-mix(in srgb,var(--idea-link) 8%,transparent)}
.idea-dl-meta{color:var(--idea-text-3)}
.idea-toast{font-size:12px;color:var(--idea-text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%}
.idea-icon-btn{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--idea-text-3);cursor:pointer}
.idea-icon-btn:hover{background:var(--idea-hover);color:var(--idea-bad)}
`;
    function ensureStyle() {
      if (typeof document === "undefined" || document.querySelector("style[data-idea-css]")) return;
      const tag = document.createElement("style");
      tag.dataset.ideaCss = "1";
      tag.dataset.plugin = "@popododo0720/dsh-idea";
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    async function api(method, path, body) {
      const init = { method, credentials: "same-origin", headers: {} };
      if (body !== undefined) {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      const res = await fetch("/idea" + path, init);
      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch (_e) { data = { error: text.slice(0, 200) }; } }
      if (!res.ok) throw Object.assign(new Error((data && data.error) || "HTTP " + res.status), { status: res.status });
      return data;
    }

    function ErrorLine({ error }) {
      return error ? h("div", { className: "idea-alert", role: "alert" }, String(error.message || error)) : null;
    }

    function PairForm({ onPaired }) {
      const [url, setUrl] = useState("");
      const [code, setCode] = useState("");
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const submit = async (e) => {
        e.preventDefault();
        setBusy(true); setError(null);
        try { await api("POST", "/pair", { url, code }); onPaired(); }
        catch (err) { setError(err); setBusy(false); }
      };
      return h("div", { className: "idea-center" },
        h("form", { className: "idea-stack", onSubmit: submit },
          h("div", null,
            h("h1", { style: { fontSize: "18px", margin: "0 0 4px" } }, "Connect an idea machine"),
            h("p", { className: "idea-hint" }, "Enter the address and the setup code shown on the machine's console. Once per computer.")),
          h(ErrorLine, { error }),
          h("label", { className: "idea-field" }, h("span", { className: "idea-label" }, "Address"),
            h("input", { className: "idea-input", value: url, onChange: e => setUrl(e.target.value), placeholder: "https://192.168.0.20:30443", autoComplete: "off", spellCheck: false, required: true })),
          h("label", { className: "idea-field" }, h("span", { className: "idea-label" }, "Setup code"),
            h("input", { className: "idea-input", value: code, onChange: e => setCode(e.target.value), placeholder: "xxxx-xxxx-xxxx", autoComplete: "one-time-code", spellCheck: false, required: true })),
          h("button", { type: "submit", className: "idea-btn idea-btn-primary", disabled: busy, style: { width: "100%" } }, h("span", null, busy ? "Connecting…" : "Connect"))));
    }

    // The machine's VMs: the main dsh (planning) and the worker VMs (tasks).
    function useVms(enabled) {
      const [vms, setVms] = useState(null);
      useEffect(() => {
        if (!enabled) return undefined;
        let alive = true;
        const poll = async () => {
          try { const v = await api("GET", "/v1/vms"); if (alive) setVms(v); } catch { /* keep the last list */ }
        };
        poll();
        const t = setInterval(poll, 15000);
        return () => { alive = false; clearInterval(t); };
      }, [enabled]);
      return vms;
    }

    function vmLabel(w, slots) {
      const state = w.ready ? `${w.active}/${slots} tasks` : (w.phase || "starting").toLowerCase();
      return `${w.name} · ${state}`;
    }

    function timeOf(t) {
      if (!t) return "";
      const d = new Date(t);
      if (isNaN(d)) return "";
      // English, like the rest of dsh's interface.
      const today = new Date().toDateString() === d.toDateString();
      return today ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    }

    const TASK_DOT = { Working: "working", Failed: "failed" };

    function AgentCard({ pressed, onClick, dot, title, tag, line, sub }) {
      return h("button", { type: "button", className: "idea-card", "aria-pressed": pressed ? "true" : "false", onClick },
        h("div", { className: "idea-row" },
          h("span", { className: "idea-dot" + (dot ? " idea-dot-" + dot : ""), title: dot || "idle" }),
          h("span", { className: "idea-who idea-grow" }, title),
          tag ? h("span", { className: "idea-tag" }, tag) : null),
        sub ? h("div", { className: "idea-line1" }, sub) : null,
        line ? h("div", { className: "idea-line1" }, line) : null);
    }

    const COLUMNS = [["todo", "To do"], ["doing", "Doing"], ["blocked", "Blocked"], ["done", "Done"]];

    // A team's task board (kept by the lead, see plugins/team).
    function Board({ tasks, mine }) {
      if (!tasks || !tasks.length) return null;
      return h("div", { className: "idea-board" }, COLUMNS.map(([id, label]) => {
        const list = tasks.filter(t => t.status === id);
        return h("div", { key: id, className: "idea-col" },
          h("div", { className: "idea-col-head" }, h("span", null, label), h("span", null, String(list.length))),
          list.map(t => h("div", { key: t.id, className: "idea-task" + (mine && t.owner === mine ? " idea-task-mine" : ""), title: t.detail || "" },
            h("div", null, "#" + t.id + " " + t.title),
            h("div", { className: "idea-task-meta" },
              [t.owner || "unassigned", t.after && t.after.length ? "after #" + t.after.join(", #") : "", t.note || ""].filter(Boolean).join(" · ")))));
      }));
    }

    function Message({ m }) {
      const [open, setOpen] = useState(false);
      const long = m.text.length > 700;
      return h("div", { className: "idea-msg" },
        h("div", { className: "idea-msg-head" },
          h("strong", null, m.from), h("span", { className: "idea-tag" }, m.fromVm),
          h("span", { "aria-hidden": true }, "→"),
          h("strong", null, m.to), h("span", { className: "idea-tag" }, m.toVm || ""),
          h("span", { className: "idea-tag idea-grow" }, "team " + m.team),
          h("span", { className: "idea-tag" }, timeOf(m.t))),
        h("div", { className: "idea-msg-body" }, long && !open ? m.text.slice(0, 700) + "…" : m.text),
        long ? h("button", { type: "button", className: "idea-link", onClick: () => setOpen(!open) }, open ? "Show less" : "Show all") : null,
        m.clipped ? h("p", { className: "idea-hint" }, "Shortened here; the full text is in the session.") : null);
    }

    // Every agent and its messages. Polls while shown.
    function TeamView({ visible, onOpen }) {
      const [data, setData] = useState(null);
      const [tasks, setTasks] = useState([]);
      const [error, setError] = useState(null);
      const [pick, setPick] = useState(null); // {kind:"member", team, name, vm} | {kind:"task", name, vm}
      const chat = React.useRef(null);
      useEffect(() => {
        if (!visible) return undefined;
        let alive = true;
        let n = 0;
        const poll = async () => {
          try { const v = await api("GET", "/team"); if (alive) { setData(v); setError(null); } } catch (err) { if (alive) setError(err); }
          if (n++ % 3 === 0) {
            try { const s = await api("GET", "/v1/status"); if (alive) setTasks(s.tasks || []); } catch { /* keep the last list */ }
          }
        };
        poll();
        const t = setInterval(poll, 5000);
        return () => { alive = false; clearInterval(t); };
      }, [visible]);

      const teams = (data && data.teams) || [];
      const all = (data && data.messages) || [];
      const shown = pick && pick.kind === "member"
        ? all.filter(m => m.team === pick.team && (m.from === pick.name || m.to === pick.name || m.to === "all"))
        : pick && pick.kind === "team" ? all.filter(m => m.team === pick.team) : all;
      const activeTasks = tasks.filter(t => t.phase !== "Done" && t.phase !== "Merged").slice(0, 50);

      // Stay at the bottom while new messages come in, unless scrolled up.
      const atBottom = React.useRef(true);
      useEffect(() => {
        const el = chat.current;
        if (el && atBottom.current) el.scrollTop = el.scrollHeight;
      }, [shown.length, pick]);
      const onScroll = e => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; };

      const same = (a, b) => a && b && a.kind === b.kind && a.team === b.team && a.name === b.name;
      const [busy, setBusy] = useState(false);
      const refresh = async () => { try { setData(await api("GET", "/team")); } catch (err) { setError(err); } };
      const deleteTeam = async t => {
        const names = t.members.filter(m => m.name !== "lead" && m.status !== "stopped").map(m => m.name);
        if (!confirm("Delete team " + t.team + "?" + (names.length ? " " + names.join(", ") + " will stop." : "") + " Its messages are removed; the agents' sessions stay on their VMs.")) return;
        setBusy(true);
        try { await api("POST", "/team/delete", { team: t.team }); if (pick && pick.team === t.team) setPick(null); await refresh(); }
        catch (err) { setError(err); }
        setBusy(false);
      };
      const stopMember = async (team, name) => {
        if (!confirm("Stop " + name + "? Its current turn is cancelled and it takes no more messages. Its session stays.")) return;
        setBusy(true);
        try { await api("POST", "/team/stop", { team, name }); await refresh(); }
        catch (err) { setError(err); }
        setBusy(false);
      };
      const choose = p => setPick(same(pick, p) ? null : p);
      const pickedTeam = pick && teams.find(t => t.team === pick.team);
      const pickedMember = pick && pick.kind === "member" && pickedTeam && pickedTeam.members.find(m => m.name === pick.name);
      const pickedLabel = !pick ? "All messages"
        : pick.kind === "team" ? "Team " + pick.team
        : pick.kind === "member" ? pick.name + " · team " + pick.team : pick.name;

      return h("div", { className: "idea-team" + (visible ? "" : " idea-hide") },
        h("div", { className: "idea-agents" },
          error ? h(ErrorLine, { error }) : null,
          !data && !error ? h("p", { className: "idea-hint" }, "Loading…") : null,
          teams.map(t => h(React.Fragment, { key: t.team },
            h("div", { className: "idea-group" },
              h("button", { type: "button", className: "idea-link", onClick: () => choose({ kind: "team", team: t.team }) }, "Team " + t.team),
              t.last ? h("span", null, "· " + timeOf(t.last)) : null,
              h("button", { type: "button", className: "idea-icon-btn", title: "Delete team " + t.team, "aria-label": "Delete team " + t.team, onClick: () => deleteTeam(t) },
                h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
                  h("path", { d: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" })))),
            t.members.map(m => h(AgentCard, {
              key: m.name,
              pressed: same(pick, { kind: "member", team: t.team, name: m.name }),
              onClick: () => choose({ kind: "member", team: t.team, name: m.name, vm: m.vm }),
              dot: m.status === "working" ? "working" : m.status === "unknown" ? "unknown" : m.status === "stopped" ? "stopped" : "",
              title: m.name, tag: m.vm, sub: m.status === "stopped" ? "stopped" + (m.role ? " · " + m.role : "") : m.role,
              line: m.doing && m.doing.length ? "Doing " + m.doing.join(", ") : m.lastText ? timeOf(m.lastAt) + " · " + m.lastText : "",
            })))),
          data && data.older ? h("p", { className: "idea-hint" }, data.older + " older teams not shown.") : null,
          activeTasks.length ? h("div", { className: "idea-group" }, "Task agents") : null,
          activeTasks.map(t => h(AgentCard, {
            key: t.name,
            pressed: same(pick, { kind: "task", name: t.name }),
            onClick: () => choose({ kind: "task", name: t.name, vm: t.vm }),
            dot: TASK_DOT[t.phase] || "",
            title: t.project + "#" + t.issue + " " + t.title,
            tag: t.vm || "",
            sub: t.phase + (t.pullRequest ? " · PR #" + t.pullRequest : ""),
            line: t.message || "",
          })),
          data && !teams.length && !activeTasks.length
            ? h("p", { className: "idea-hint" }, "No agents yet. When the orchestrator starts a team (team_spawn) or a project gets issues, the agents show up here.")
            : null,
          data && data.errors && data.errors.length
            ? h("p", { className: "idea-hint" }, "Not answering: " + data.errors.map(e => e.vm).join(", "))
            : null),
        h("div", { className: "idea-chat", ref: chat, onScroll },
          h("div", { className: "idea-head" },
            h("strong", { className: "idea-grow" }, pickedLabel),
            pick && pick.kind === "member" && pick.name !== "lead" && pickedMember && pickedMember.status !== "stopped"
              ? h("button", { type: "button", className: "idea-btn idea-btn-danger", disabled: busy, onClick: () => stopMember(pick.team, pick.name) }, "Stop agent")
              : null,
            pick && pick.vm
              ? h("button", { type: "button", className: "idea-btn", onClick: () => onOpen(pick.vm) }, "Open session on " + pick.vm)
              : null,
            pick ? h("button", { type: "button", className: "idea-btn", onClick: () => setPick(null) }, "Show all") : null),
          pick && pickedTeam && pick.kind !== "task" ? h(Board, { tasks: pickedTeam.tasks, mine: pick.kind === "member" ? pick.name : "" }) : null,
          pick && pick.kind === "task"
            ? h("p", { className: "idea-hint" }, "Task agents work alone; their work is in the session and the pull request. Open the session to see every step.")
            : shown.length
              ? shown.map((m, i) => h(Message, { key: m.t + "/" + i, m }))
              : h("p", { className: "idea-hint" }, data ? "No messages yet." : "")));
    }

    // ---------------------------------------------------------------- menus

    function useOutside(open, onClose) {
      const ref = React.useRef(null);
      useEffect(() => {
        if (!open) return undefined;
        const down = e => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
        const key = e => { if (e.key === "Escape") onClose(); };
        document.addEventListener("mousedown", down, true);
        document.addEventListener("keydown", key, true);
        return () => { document.removeEventListener("mousedown", down, true); document.removeEventListener("keydown", key, true); };
      }, [open, onClose]);
      return ref;
    }

    const CheckIcon = () => h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
      h("path", { d: "M3.5 8.5l3 3 6-7", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }));
    const ChevronDown = () => h("svg", { width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, className: "idea-dim" },
      h("path", { d: "M4 6l4 4 4-4", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }));
    const ChevronRight = ({ open }) => h("svg", { viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, className: "idea-chev" + (open ? " idea-chev-open" : "") },
      h("path", { d: "M6 4l4 4-4 4", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }));

    // A menu in dsh's style (the model picker's look): groups with small
    // headings, a check on the chosen item, optional search.
    function Menu({ groups, onClose, search, align }) {
      const [q, setQ] = useState("");
      const match = it => !q || (it.label + " " + (it.detail || "")).toLowerCase().includes(q.toLowerCase());
      return h("div", { className: "idea-menu idea-menu-" + (align || "left"), role: "menu" },
        search ? h("input", { className: "idea-menu-search", placeholder: search, value: q, autoFocus: true, onChange: e => setQ(e.target.value) }) : null,
        groups.map((g, gi) => {
          const items = g.items.filter(match);
          if (!items.length) return null;
          return h(React.Fragment, { key: gi },
            g.label ? h("div", { className: "idea-menu-head" }, g.label) : null,
            items.map(it => h("button", {
              key: it.key || it.label, type: "button", role: "menuitem", className: "idea-menu-item" + (it.danger ? " idea-menu-danger" : ""),
              disabled: it.disabled, title: it.title || undefined,
              onClick: () => { onClose(); it.onSelect(); },
            }, h("span", { className: "idea-grow" }, it.label),
              it.detail ? h("span", { className: "idea-menu-detail" }, it.detail) : null,
              it.checked ? h(CheckIcon) : null)));
        }));
    }

    // A button that opens a Menu: the trigger shows the chosen item.
    function Picker({ label, sub, groups, search, align, title }) {
      const [open, setOpen] = useState(false);
      const close = useCallback(() => setOpen(false), []);
      const ref = useOutside(open, close);
      return h("div", { className: "idea-pick-wrap", ref },
        h("button", { type: "button", className: "idea-pick", "aria-expanded": open ? "true" : "false", title, onClick: () => setOpen(!open) },
          h("span", null, label), sub ? h("span", { className: "idea-pick-sub" }, sub) : null, h(ChevronDown)),
        open ? h(Menu, { groups, onClose: close, search, align }) : null);
    }

    // "⋯" on a row: its actions as a Menu.
    function MoreMenu({ items }) {
      const [open, setOpen] = useState(false);
      const close = useCallback(() => setOpen(false), []);
      const ref = useOutside(open, close);
      return h("span", { className: "idea-pick-wrap", ref, onClick: e => e.stopPropagation() },
        h("button", { type: "button", className: "idea-mini", title: "More actions", "aria-label": "More actions", onClick: () => setOpen(!open) }, "⋯"),
        open ? h(Menu, { groups: [{ items }], onClose: close, align: "right" }) : null);
    }

    // ------------------------------------------------------------------ git

    function DiffView({ text }) {
      const lines = String(text || "").split("\n");
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      return h("div", { className: "idea-diff" }, lines.slice(0, 20000).map((l, i) => {
        const c = l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ") ? "meta"
          : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk"
          : /^(commit |Author:|Date:|new file|deleted file|similarity|rename |Binary)/.test(l) ? "meta" : "";
        return h("div", { key: i, className: c ? "idea-dl-" + c : undefined }, l || " ");
      }));
    }

    function Section({ title, count, actions, children, open, onToggle }) {
      return h("div", { className: "idea-sec" },
        h("div", { className: "idea-sec-head", onClick: onToggle },
          h(ChevronRight, { open }), h("span", { className: "idea-grow" }, title, count !== undefined ? h("span", { className: "idea-count" }, "  " + count) : null),
          actions ? h("span", { style: { display: "inline-flex", gap: "2px" }, onClick: e => e.stopPropagation() }, actions) : null),
        open ? children : null);
    }

    function ago(t) {
      const d = new Date(t);
      if (isNaN(d)) return "";
      const s = (Date.now() - d.getTime()) / 1000;
      if (s < 60) return "now";
      if (s < 3600) return Math.floor(s / 60) + "m";
      if (s < 86400) return Math.floor(s / 3600) + "h";
      if (s < 86400 * 30) return Math.floor(s / 86400) + "d";
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }

    function splitPath(p) {
      const i = p.lastIndexOf("/");
      return i < 0 ? ["", p] : [p.slice(0, i + 1), p.slice(i + 1)];
    }

    function loadPref(key) { try { return localStorage.getItem("idea." + key) || ""; } catch { return ""; } }
    function savePref(key, v) { try { localStorage.setItem("idea." + key, v); } catch { /* private window */ } }

    const GONE = "This repository no longer exists.";

    // The machine's Forgejo repositories: branches, commits, pull requests
    // and their diffs, through the machine API (/api/v1/git/...).
    function ForgeView({ full, picker, onGone }) {
      const [branches, setBranches] = useState([]);
      const [pulls, setPulls] = useState([]);
      const [commits, setCommits] = useState([]);
      const [info, setInfo] = useState(null);
      const [logRef, setLogRef] = useState("");
      const [sel, setSel] = useState(null);
      const [diff, setDiff] = useState(null);
      const [error, setError] = useState(null);
      const [note, setNote] = useState("");
      const [busy, setBusy] = useState("");
      const [open, setOpen] = useState({ pulls: true, branches: true, commits: true });
      const toggle = k => setOpen(Object.assign({}, open, { [k]: !open[k] }));
      const base = "/v1/git/repos/" + full;

      useEffect(() => { setLogRef(""); setSel(null); setDiff(null); setInfo(null); setBranches([]); setPulls([]); setCommits([]); setError(null); }, [full]);

      const refresh = useCallback(async () => {
        let b, p, s;
        try {
          [b, p, s] = await Promise.all([
            api("GET", base + "/branches?limit=50"),
            api("GET", base + "/pulls?state=open&limit=50"),
            api("GET", "/v1/git/repos/search?limit=50&q=" + encodeURIComponent(full.split("/")[1])),
          ]);
        } catch (err) {
          // A 404 here is about the repository itself.
          if (err && err.status === 404) { setError(new Error(GONE)); if (onGone) onGone(); } else setError(err);
          return;
        }
        setBranches(Array.isArray(b) ? b : []);
        setPulls(Array.isArray(p) ? p : []);
        const me = s && Array.isArray(s.data) ? s.data.find(r => r.full_name === full) : null;
        setInfo(me || null);
        const ref = logRef || (me && me.default_branch) || "";
        try {
          const c = await api("GET", base + "/commits?limit=100&stat=false&verification=false&files=false" + (ref ? "&sha=" + encodeURIComponent(ref) : ""));
          setCommits(Array.isArray(c) ? c : []);
          setError(null);
        } catch (err) {
          // The picked branch was deleted (for example when its pull request
          // was merged): go back to the default branch.
          if (err && err.status === 404 && logRef) { setNote("Branch " + logRef + " is gone"); setLogRef(""); }
          else setError(err);
        }
      }, [base, full, logRef, onGone]);
      useEffect(() => {
        refresh();
        const t = setInterval(refresh, 20000);
        return () => clearInterval(t);
      }, [refresh]);

      const show = async (pick, path, title) => {
        setSel(pick);
        setDiff({ title, text: "", loading: true });
        try { const r = await api("GET", base + path); setDiff({ title, text: r.diff, clipped: r.clipped }); }
        catch (err) { setDiff({ title, text: "", error: String(err.message || err) }); }
      };
      const merge = async (pr, how) => {
        if (!confirm("Merge pull request #" + pr.number + " (" + how + ") into " + pr.base.ref + "?")) return;
        setBusy("merge"); setError(null);
        try {
          await api("POST", base + "/pulls/" + pr.number + "/merge", { Do: how, delete_branch_after_merge: true });
          setNote("Merged #" + pr.number);
          await refresh();
        } catch (err) { setError(err); }
        setBusy("");
      };

      const current = logRef || (info && info.default_branch) || "";
      const prRow = pr => {
        const key = "p:" + pr.number;
        return h("div", { key, className: "idea-item", "aria-selected": sel === key ? "true" : "false", title: pr.title + "\n" + pr.head.ref + " → " + pr.base.ref,
          onClick: () => show(key, "/pulls/" + pr.number + ".diff", "#" + pr.number + "  " + pr.title) },
          h("span", { className: "idea-tag", style: { flex: "none" } }, "#" + pr.number),
          h("span", { className: "idea-ellipsis idea-grow" }, pr.title, h("span", { className: "idea-dim" }, "  " + pr.head.ref + " → " + pr.base.ref)),
          pr.mergeable === false ? h("span", { className: "idea-st idea-st-D", title: "Conflicts" }, "!") : null,
          h("span", { className: "idea-dim", style: { fontSize: "12px", flex: "none" } }, ago(pr.updated_at)),
          h("span", { className: "idea-acts" }, h(MoreMenu, { items: [
            { label: "Merge", disabled: !!busy || pr.mergeable === false, onSelect: () => merge(pr, "merge") },
            { label: "Squash and merge", disabled: !!busy || pr.mergeable === false, onSelect: () => merge(pr, "squash") },
            { label: "Rebase and merge", disabled: !!busy || pr.mergeable === false, onSelect: () => merge(pr, "rebase") },
            { label: "Open in Forgejo", disabled: !pr.html_url, onSelect: () => window.open(pr.html_url, "_blank", "noopener") },
          ] })));
      };
      const branchRow = b => h("div", { key: b.name, className: "idea-item", "aria-selected": current === b.name ? "true" : "false",
        title: b.commit ? String(b.commit.message || "").split("\n")[0] : "", onClick: () => setLogRef(b.name) },
        h("span", { className: "idea-dot" + (info && info.default_branch === b.name ? " idea-dot-working" : "") }),
        h("span", { className: "idea-ellipsis idea-grow" }, b.name),
        b.protected ? h("span", { className: "idea-dim", style: { fontSize: "12px" } }, "protected") : null,
        b.commit && b.commit.timestamp ? h("span", { className: "idea-dim", style: { fontSize: "12px", flex: "none" } }, ago(b.commit.timestamp)) : null);
      const commitRow = c => {
        const key = "c:" + c.sha;
        const subject = String((c.commit && c.commit.message) || "").split("\n")[0];
        const who = c.commit && c.commit.author ? c.commit.author : {};
        return h("div", { key, className: "idea-item", "aria-selected": sel === key ? "true" : "false", title: subject + "\n" + (who.name || "") + " · " + (who.date || ""),
          onClick: () => show(key, "/git/commits/" + c.sha + ".diff", c.sha.slice(0, 7) + "  " + subject) },
          h("span", { className: "idea-tag", style: { flex: "none" } }, c.sha.slice(0, 7)),
          h("span", { className: "idea-ellipsis idea-grow" }, subject),
          h("span", { className: "idea-dim", style: { fontSize: "12px", flex: "none" } }, ago(who.date)),
          h("span", { className: "idea-acts" }, h(MoreMenu, { items: [
            { label: "Copy SHA", onSelect: () => { try { navigator.clipboard.writeText(c.sha); setNote("Copied " + c.sha.slice(0, 7)); } catch { /* no clipboard */ } } },
            { label: "Open in Forgejo", disabled: !c.html_url, onSelect: () => window.open(c.html_url, "_blank", "noopener") },
          ] })));
      };

      const bar = h("div", { className: "idea-git-bar" }, picker,
        branches.length ? h(Picker, {
          label: current || "branch", search: branches.length > 8 ? "Search branches..." : "",
          groups: [{ label: "Branches", items: branches.map(b => ({ key: b.name, label: b.name, checked: b.name === current, onSelect: () => setLogRef(b.name) })) }],
        }) : null,
        h("span", { className: "idea-toast idea-grow", title: note }, busy ? "Merging…" : note),
        info && info.html_url ? h("button", { type: "button", className: "idea-btn", onClick: () => window.open(info.html_url, "_blank", "noopener") }, "Open in Forgejo") : null,
        h("button", { type: "button", className: "idea-btn", onClick: refresh, title: "Refresh", "aria-label": "Refresh" }, "↻"));

      const side = h("div", { className: "idea-git-side" },
        error ? h("div", { style: { margin: "8px 4px" } }, h(ErrorLine, { error })) : null,
        h(Section, { title: "Pull requests", count: pulls.length, open: open.pulls, onToggle: () => toggle("pulls") },
          pulls.map(prRow),
          !pulls.length ? h("p", { className: "idea-hint", style: { margin: "4px 8px" } }, "No open pull requests.") : null),
        h(Section, { title: "Branches", count: branches.length, open: open.branches, onToggle: () => toggle("branches") }, branches.map(branchRow)),
        h(Section, { title: current ? "Commits · " + current : "Commits", count: commits.length, open: open.commits, onToggle: () => toggle("commits") },
          commits.map(commitRow),
          !commits.length ? h("p", { className: "idea-hint", style: { margin: "4px 8px" } }, "No commits yet.") : null));

      return h(React.Fragment, null, bar, h("div", { className: "idea-git" }, side, h(DiffPane, { diff })));
    }

    function DiffPane({ diff }) {
      return h("div", { className: "idea-git-main" },
        h("div", { className: "idea-diff-head" }, h("span", { className: "idea-ellipsis idea-grow" }, diff ? diff.title : "Pick something on the left to see its changes.")),
        diff ? (diff.error ? h("div", { style: { padding: "12px 16px" } }, h(ErrorLine, { error: diff.error }))
          : diff.loading ? h("p", { className: "idea-hint", style: { padding: "12px 16px" } }, "Loading…")
          : h(React.Fragment, null, h(DiffView, { text: diff.text || "(no changes)" }), diff.clipped ? h("p", { className: "idea-hint", style: { padding: "4px 16px" } }, "Cut at the size limit.") : null))
          : null);
    }

    // Git, mouse first (lazygit's panels): files, branches, commits and
    // stashes on the left, the diff of what is picked on the right.
    function GitView({ visible }) {
      const [repos, setRepos] = useState(null);
      const [machine, setMachine] = useState(null);
      const [repo, setRepo] = useState(loadPref("gitRepo"));
      const [st, setSt] = useState(null);
      const [commits, setCommits] = useState([]);
      const [logRef, setLogRef] = useState("");
      const [sel, setSel] = useState(null);
      const [diff, setDiff] = useState(null);
      const [msg, setMsg] = useState("");
      const [amend, setAmend] = useState(false);
      const [busy, setBusy] = useState("");
      const [error, setError] = useState(null);
      const [note, setNote] = useState("");
      const [open, setOpen] = useState({ files: true, branches: true, commits: true, stash: false, remotes: false });
      const toggle = k => setOpen(Object.assign({}, open, { [k]: !open[k] }));
      const isMachine = repo.startsWith("m:");
      const base = repo && !isMachine ? "/git/local/" + encodeURIComponent(repo) : "";

      const loadRepos = useCallback(async () => {
        try {
          const [r, m] = await Promise.all([
            api("GET", "/git/repos"),
            api("GET", "/v1/git/repos/search?limit=50&sort=updated").catch(() => null),
          ]);
          const local = r.local || [];
          const mach = m && Array.isArray(m.data) ? m.data.map(x => ({ id: "m:" + x.full_name, title: x.full_name, root: x.html_url || "" })) : [];
          setRepos(local); setMachine(mach);
          const all = local.concat(mach);
          if ((!repo || !all.some(x => x.id === repo)) && all[0]) setRepo(all[0].id);
        } catch (err) { setError(err); }
      }, [repo]);
      useEffect(() => { if (visible && !repos) loadRepos(); }, [visible, repos, loadRepos]);
      useEffect(() => { if (repo) savePref("gitRepo", repo); setSt(null); setCommits([]); setLogRef(""); setSel(null); setDiff(null); setError(null); }, [repo]);

      const refresh = useCallback(async () => {
        if (!base) return;
        try {
          const [s, l] = await Promise.all([api("GET", base + "/state"), api("GET", base + "/log" + (logRef ? "?ref=" + encodeURIComponent(logRef) : ""))]);
          setSt(s); setCommits(l.commits || []); setError(null);
        } catch (err) {
          if (err && err.status === 404) { setError(new Error(GONE)); setRepos(null); } else setError(err);
        }
      }, [base, logRef]);
      const onGone = useCallback(() => setRepos(null), []);
      useEffect(() => {
        if (!visible || !base) return undefined;
        refresh();
        const t = setInterval(refresh, 10000);
        return () => clearInterval(t);
      }, [visible, base, refresh]);

      const show = async (pick, q, title) => {
        setSel(pick);
        setDiff({ title, text: "", loading: true });
        try { const r = await api("POST", base + "/diff", q); setDiff({ title, text: r.diff, clipped: r.clipped }); }
        catch (err) { setDiff({ title, text: "", error: String(err.message || err) }); }
      };
      const act = async (op, extra, ask) => {
        if (ask && !confirm(ask)) return;
        setBusy(op); setError(null);
        try {
          const r = await api("POST", base + "/act", Object.assign({ op }, extra || {}));
          const last = String(r.output || "").split("\n").filter(Boolean).pop();
          setNote(last || "Done: " + op);
          if (op === "commit") { setMsg(""); setAmend(false); }
          await refresh();
        } catch (err) { setError(err); }
        setBusy("");
      };

      const files = (st && st.files) || [];
      const staged = files.filter(f => f.staged);
      const changes = files.filter(f => f.unstaged);
      const branches = (st && st.branches) || [];
      const local = branches.filter(b => !b.remote);
      const remote = branches.filter(b => b.remote);
      const head = st && st.head;
      const current = head ? head.branch : "";
      const isSel = (k) => sel === k;

      const fileRow = (f, isStaged) => {
        const key = (isStaged ? "s:" : "u:") + f.path;
        const [dir, name] = splitPath(f.path);
        const code = f.conflict ? "!" : isStaged ? f.x : (f.untracked ? "U" : f.y);
        return h("div", { key, className: "idea-item", "aria-selected": isSel(key) ? "true" : "false", title: f.path,
          onClick: () => show(key, { kind: "file", path: f.path, staged: isStaged, untracked: f.untracked }, f.path) },
          h("span", { className: "idea-st idea-st-" + (f.conflict ? "D" : code), title: f.conflict ? "Conflict" : undefined }, code === "." ? "" : code),
          h("span", { className: "idea-ellipsis idea-grow" }, name, dir ? h("span", { className: "idea-dim" }, "  " + dir) : null),
          h("span", { className: "idea-acts" },
            isStaged
              ? h("button", { type: "button", className: "idea-mini", title: "Unstage", "aria-label": "Unstage", onClick: e => { e.stopPropagation(); act("unstage", { paths: [f.path] }); } }, "−")
              : h("button", { type: "button", className: "idea-mini", title: "Stage", "aria-label": "Stage", onClick: e => { e.stopPropagation(); act("stage", { paths: [f.path] }); } }, "+"),
            isStaged ? null : h(MoreMenu, { items: [
              { label: "Discard changes", danger: true, onSelect: () => act("discard", { paths: [f.path], untracked: f.untracked }, "Discard the changes to " + f.path + "? This cannot be undone.") },
            ] })));
      };

      const branchRow = b => {
        const key = "b:" + b.name;
        return h("div", { key, className: "idea-item", "aria-selected": logRef === b.name ? "true" : "false", title: b.subject,
          onClick: () => setLogRef(logRef === b.name ? "" : b.name) },
          h("span", { className: "idea-dot" + (b.current ? " idea-dot-working" : ""), style: b.current ? null : { visibility: b.remote ? "hidden" : "visible" } }),
          h("span", { className: "idea-ellipsis idea-grow", style: b.current ? { fontWeight: 600 } : null }, b.name),
          b.track ? h("span", { className: "idea-dim", style: { fontSize: "12px" } }, b.track.replace(/[\[\]]/g, "")) : null,
          h("span", { className: "idea-acts" }, h(MoreMenu, { items: b.remote ? [
            { label: "Check out as a local branch", onSelect: () => act("checkout", { branch: b.name, remote: true }) },
            { label: "Merge into " + current, disabled: !current, onSelect: () => act("merge", { branch: b.name }, "Merge " + b.name + " into " + current + "?") },
          ] : [
            { label: "Check out", disabled: b.current, onSelect: () => act("checkout", { branch: b.name }) },
            { label: "New branch from here", onSelect: () => { const n = prompt("New branch name (from " + b.name + ")"); if (n) act("createBranch", { name: n.trim(), from: b.name }); } },
            { label: "Merge into " + current, disabled: b.current || !current, onSelect: () => act("merge", { branch: b.name }, "Merge " + b.name + " into " + current + "?") },
            { label: "Delete", danger: true, disabled: b.current, onSelect: () => act("deleteBranch", { branch: b.name }, "Delete branch " + b.name + "?") },
            { label: "Force delete", danger: true, disabled: b.current, onSelect: () => act("deleteBranch", { branch: b.name, force: true }, "Delete branch " + b.name + " even if it is not merged?") },
          ] })));
      };

      const commitRow = c => {
        const key = "c:" + c.sha;
        return h("div", { key, className: "idea-item", "aria-selected": isSel(key) ? "true" : "false", title: c.subject + "\n" + c.author + " · " + c.date,
          onClick: () => show(key, { kind: "commit", sha: c.sha }, c.short + "  " + c.subject) },
          h("span", { className: "idea-tag", style: { flex: "none" } }, c.short),
          h("span", { className: "idea-ellipsis idea-grow" }, c.subject),
          c.refs ? h("span", { className: "idea-refs" }, c.refs.replace(/HEAD -> /, "")) : null,
          h("span", { className: "idea-dim", style: { fontSize: "12px", flex: "none" } }, ago(c.date)),
          h("span", { className: "idea-acts" }, h(MoreMenu, { items: [
            { label: "Copy SHA", onSelect: () => { try { navigator.clipboard.writeText(c.sha); setNote("Copied " + c.short); } catch { /* no clipboard */ } } },
            { label: "New branch here", onSelect: () => { const n = prompt("New branch name (at " + c.short + ")"); if (n) act("createBranch", { name: n.trim(), from: c.sha }); } },
            { label: "Cherry-pick onto " + current, disabled: !current, onSelect: () => act("cherryPick", { sha: c.sha }, "Cherry-pick " + c.short + " onto " + current + "?") },
            { label: "Revert", onSelect: () => act("revert", { sha: c.sha }, "Make a commit that reverts " + c.short + "?") },
          ] })));
      };

      const stashRow = s => {
        const key = "s:" + s.ref;
        return h("div", { key, className: "idea-item", "aria-selected": isSel(key) ? "true" : "false",
          onClick: () => show(key, { kind: "stash", ref: s.ref }, s.ref + "  " + s.subject) },
          h("span", { className: "idea-tag", style: { flex: "none" } }, s.ref.replace("stash@", "")),
          h("span", { className: "idea-ellipsis idea-grow" }, s.subject),
          h("span", { className: "idea-dim", style: { fontSize: "12px", flex: "none" } }, ago(s.date)),
          h("span", { className: "idea-acts" }, h(MoreMenu, { items: [
            { label: "Apply", onSelect: () => act("stashApply", { ref: s.ref }) },
            { label: "Pop", onSelect: () => act("stashPop", { ref: s.ref }) },
            { label: "Drop", danger: true, onSelect: () => act("stashDrop", { ref: s.ref }, "Drop " + s.ref + "? This cannot be undone.") },
          ] })));
      };

      const allRepos = (repos || []).concat(machine || []);
      const repoItem = allRepos.find(r => r.id === repo);
      const repoPicker = h(Picker, {
        label: repoItem ? repoItem.title : (repos && !allRepos.length ? "No git repositories" : "Choose a repository"),
        title: repoItem ? repoItem.root : "", search: allRepos.length > 8 ? "Search repositories..." : "",
        groups: [{ label: "This computer", items: (repos || []).map(r => ({ key: r.id, label: r.title, title: r.root, checked: r.id === repo, onSelect: () => setRepo(r.id) })) },
                 { label: "Machine", items: (machine || []).map(r => ({ key: r.id, label: r.title, title: r.root, checked: r.id === repo, onSelect: () => setRepo(r.id) })) },
                 { label: "", items: [{ key: "reload", label: "Reload the list", onSelect: () => { setRepos(null); } }] }],
      });
      if (isMachine) {
        return h("div", { className: visible ? "idea-team" : "idea-hide", style: { flexDirection: "column" } },
          visible ? h(ForgeView, { full: repo.slice(2), picker: repoPicker, onGone }) : null);
      }
      const bar = h("div", { className: "idea-git-bar" },
        repoPicker,
        head ? h(Picker, {
          label: current || "(detached)", sub: head.upstream ? (head.ahead ? "↑" + head.ahead + " " : "") + (head.behind ? "↓" + head.behind : "") : "no upstream",
          search: local.length > 8 ? "Search branches..." : "",
          groups: [{ label: "Branches", items: local.map(b => ({ key: b.name, label: b.name, checked: b.current, onSelect: () => { if (!b.current) act("checkout", { branch: b.name }); } })) },
                   { label: "", items: [{ key: "new", label: "New branch…", onSelect: () => { const n = prompt("New branch name"); if (n) act("createBranch", { name: n.trim() }); } }] }],
        }) : null,
        h("span", { className: "idea-toast idea-grow", title: note }, busy ? "Running " + busy + "…" : note),
        h("button", { type: "button", className: "idea-btn", disabled: !!busy || !base, onClick: () => act("fetch") }, "Fetch"),
        h("button", { type: "button", className: "idea-btn", disabled: !!busy || !base, onClick: () => act("pull") }, "Pull"),
        h("button", { type: "button", className: "idea-btn", disabled: !!busy || !base, onClick: () => act("push") }, "Push"),
        h("button", { type: "button", className: "idea-btn", disabled: !base, onClick: refresh, title: "Refresh" }, "↻"),
        base ? h(MoreMenu, { items: [
          { label: "Abort the merge", disabled: !files.some(f => f.conflict), onSelect: () => act("mergeAbort", {}, "Abort the merge and go back to before it?") },
          { label: "Copy the folder path", onSelect: () => { try { navigator.clipboard.writeText(st ? st.root : ""); setNote("Copied the path"); } catch { /* no clipboard */ } } },
        ] }) : null);

      const side = h("div", { className: "idea-git-side" },
        error ? h("div", { style: { margin: "8px 4px" } }, h(ErrorLine, { error })) : null,
        repos && !allRepos.length ? h("p", { className: "idea-hint", style: { margin: "12px 8px" } }, "None of this dsh's workspaces is a git repository. Open a folder with a repository as a workspace and it shows up here.") : null,
        st ? h(React.Fragment, null,
          h(Section, { title: "Files", count: files.length, open: open.files, onToggle: () => toggle("files"),
            actions: [
              h("button", { key: "sa", type: "button", className: "idea-mini", title: "Stage all", "aria-label": "Stage all", disabled: !changes.length, onClick: () => act("stageAll") }, "+"),
              h("button", { key: "ua", type: "button", className: "idea-mini", title: "Unstage all", "aria-label": "Unstage all", disabled: !staged.length, onClick: () => act("unstageAll") }, "−"),
            ] },
            staged.length ? h("div", { className: "idea-sub-head" }, "Staged") : null,
            staged.map(f => fileRow(f, true)),
            changes.length ? h("div", { className: "idea-sub-head" }, "Changes") : null,
            changes.map(f => fileRow(f, false)),
            !files.length ? h("p", { className: "idea-hint", style: { margin: "4px 8px" } }, "Nothing to commit.") : null,
            st.more ? h("p", { className: "idea-hint", style: { margin: "4px 8px" } }, st.more + " more files not shown.") : null,
            h("div", { className: "idea-commit-box" },
              h("textarea", { className: "idea-input", placeholder: "Commit message", value: msg, onChange: e => setMsg(e.target.value) }),
              h("div", { className: "idea-row" },
                h("label", { className: "idea-check idea-grow" }, h("input", { type: "checkbox", checked: amend, onChange: e => setAmend(e.target.checked) }), "Amend last commit"),
                h("button", { type: "button", className: "idea-btn", disabled: !!busy || !msg.trim() || (!staged.length && !amend),
                  onClick: () => act("commit", { message: msg, amend }) }, staged.length ? "Commit " + staged.length : "Commit")))),
          h(Section, { title: "Branches", count: local.length, open: open.branches, onToggle: () => toggle("branches"),
            actions: [h("button", { key: "nb", type: "button", className: "idea-mini", title: "New branch", "aria-label": "New branch", onClick: () => { const n = prompt("New branch name"); if (n) act("createBranch", { name: n.trim() }); } }, "+")] },
            local.map(branchRow),
            remote.length ? h("div", { className: "idea-sub-head", style: { cursor: "pointer" }, onClick: () => toggle("remotes") }, (open.remotes ? "▾ " : "▸ ") + "Remote branches (" + remote.length + ")") : null,
            open.remotes ? remote.map(branchRow) : null),
          h(Section, { title: logRef ? "Commits · " + logRef : "Commits", count: commits.length, open: open.commits, onToggle: () => toggle("commits") },
            commits.map(commitRow),
            !commits.length ? h("p", { className: "idea-hint", style: { margin: "4px 8px" } }, "No commits yet.") : null),
          h(Section, { title: "Stash", count: st.stashes.length, open: open.stash, onToggle: () => toggle("stash"),
            actions: [h("button", { key: "st", type: "button", className: "idea-mini", title: "Stash all changes", "aria-label": "Stash all changes", disabled: !files.length, onClick: () => { const m = prompt("Stash message (optional)", ""); if (m !== null) act("stash", { message: m }); } }, "+")] },
            st.stashes.map(stashRow),
            !st.stashes.length ? h("p", { className: "idea-hint", style: { margin: "4px 8px" } }, "No stashes.") : null))
          : (repo && !error ? h("p", { className: "idea-hint", style: { margin: "12px 8px" } }, "Loading…") : null));

      return h("div", { className: visible ? "idea-team" : "idea-hide", style: { flexDirection: "column" } },
        bar, h("div", { className: "idea-git" }, side, h(DiffPane, { diff })));
    }

    function MachineView({ state, onUnpaired }) {
      const [src, setSrc] = useState(null);
      const [error, setError] = useState(null);
      const [vm, setVm] = useState("");
      const [tab, setTab] = useState("sessions");
      const vms = useVms(!state.dev);
      const load = useCallback(async () => {
        setError(null);
        setSrc(null);
        try { setSrc((await api("GET", "/view" + (vm ? "?vm=" + encodeURIComponent(vm) : ""))).src); } catch (err) { setError(err); }
      }, [vm]);
      useEffect(() => { load(); }, [load]);
      const workers = (vms && vms.workers) || [];
      const unpair = async () => {
        if (!confirm("Disconnect this computer from the idea machine? Connecting again needs the setup code.")) return;
        await api("POST", "/unpair", {});
        onUnpaired();
      };
      const openOn = name => { setVm(name === "idea-dsh" ? "" : name); setTab("sessions"); };
      const tabButton = (id, label) => h("button", { type: "button", role: "tab", className: "idea-tab", "aria-selected": tab === id ? "true" : "false", onClick: () => setTab(id) }, label);
      return h("div", { className: "idea-root" },
        h("div", { className: "idea-bar" },
          h("span", { className: "idea-name" }, "idea"),
          h("div", { className: "idea-tabs", role: "tablist" }, tabButton("sessions", "Sessions"), tabButton("team", "Team"), tabButton("git", "Git")),
          h("span", { className: "idea-sub idea-grow" }, state.host || state.url || ""),
          tab === "sessions" && workers.length > 0
            ? h(Picker, {
                label: vm || "idea-dsh", sub: vm ? "" : "main", align: "right", title: "Which VM to show",
                groups: [
                  { label: "Main", items: [{ key: "main", label: "idea-dsh", detail: "plans the work", checked: !vm, onSelect: () => setVm("") }] },
                  { label: "Worker VMs", items: workers.map(w => ({ key: w.name, label: w.name, detail: vmLabel(w, vms.workerSlots).replace(w.name + " · ", ""), disabled: !w.ready, checked: vm === w.name, onSelect: () => setVm(w.name) })) },
                ],
              })
            : null,
          tab === "sessions" ? h("button", { type: "button", className: "idea-btn", onClick: load }, "Reload") : null,
          state.dev ? null : h("button", { type: "button", className: "idea-btn", onClick: unpair }, "Disconnect")),
        h(TeamView, { visible: tab === "team", onOpen: openOn }),
        h(GitView, { visible: tab === "git" }),
        h("div", { className: tab === "sessions" ? "idea-team" : "idea-hide", style: { flexDirection: "column" } },
          error
            ? h("div", { className: "idea-center idea-stack" }, h(ErrorLine, { error }), h("button", { type: "button", className: "idea-btn", onClick: load }, "Try again"))
            : src
              ? h("iframe", { className: "idea-frame", src, title: "idea machine", allow: "clipboard-read; clipboard-write" })
              : h("div", { className: "idea-center" }, h("p", { className: "idea-hint" }, "Connecting to the machine…"))));
    }

    function IdeaPanel() {
      useEffect(ensureStyle, []);
      const [state, setState] = useState(null);
      const [error, setError] = useState(null);
      const refresh = useCallback(async () => {
        try { setState(await api("GET", "/state")); setError(null); } catch (err) { setError(err); }
      }, []);
      useEffect(() => { refresh(); }, [refresh]);
      if (!state) return h("div", { className: "idea-root" }, h("div", { className: "idea-center" }, error ? h(ErrorLine, { error }) : h("p", { className: "idea-hint" }, "Loading…")));
      if (!state.paired) return h("div", { className: "idea-root" }, h(PairForm, { onPaired: refresh }));
      return h(MachineView, { state, onUnpaired: refresh });
    }

    function IdeaIcon({ size }) {
      const s = size || 16;
      return h("svg", { width: s, height: s, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
        h("rect", { x: 2, y: 2, width: 12, height: 12, rx: 3, stroke: "currentColor", strokeWidth: 1.4 }),
        h("path", { d: "M8 7v4", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" }),
        h("circle", { cx: 8, cy: 4.9, r: 0.95, fill: "currentColor" }));
    }

    const inject = ["slots"];
    function apply(ctx) {
      ensureStyle();
      ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, IdeaPanel));
      ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 20, label: "idea" }, IdeaIcon));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
