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
              line: m.lastText ? timeOf(m.lastAt) + " · " + m.lastText : "",
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
          pick && pick.kind === "task"
            ? h("p", { className: "idea-hint" }, "Task agents work alone; their work is in the session and the pull request. Open the session to see every step.")
            : shown.length
              ? shown.map((m, i) => h(Message, { key: m.t + "/" + i, m }))
              : h("p", { className: "idea-hint" }, data ? "No messages yet." : "")));
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
          h("div", { className: "idea-tabs", role: "tablist" }, tabButton("sessions", "Sessions"), tabButton("team", "Team")),
          h("span", { className: "idea-sub idea-grow" }, state.host || state.url || ""),
          tab === "sessions" && workers.length > 0
            ? h("select", { className: "idea-input idea-vm", value: vm, onChange: e => setVm(e.target.value), title: "Which VM to show" },
                h("option", { value: "" }, "idea-dsh · main"),
                workers.map(w => h("option", { key: w.name, value: w.name, disabled: !w.ready }, vmLabel(w, vms.workerSlots))))
            : null,
          tab === "sessions" ? h("button", { type: "button", className: "idea-btn", onClick: load }, "Reload") : null,
          state.dev ? null : h("button", { type: "button", className: "idea-btn", onClick: unpair }, "Disconnect")),
        h(TeamView, { visible: tab === "team", onOpen: openOn }),
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
