// idea: the DeepSeek Harness plugin for an idea machine (browser half).
//
// Adds an "idea" entry to the dsh sidebar. Before pairing it asks for the
// machine's address and setup code. After pairing it shows the machine's own
// dsh (its workspaces, sessions and transcripts, as dsh draws them), framed
// through this plugin's local proxy (lib/view-proxy.js).
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

    // Colors follow the surrounding dsh theme (currentColor mixes).
    const CSS = `
.idea-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;line-height:1.5;color:inherit;--idea-line:color-mix(in srgb,currentColor 12%,transparent);--idea-hover:color-mix(in srgb,currentColor 8%,transparent);--idea-bad:#cf222e}
@media (prefers-color-scheme: dark){.idea-root{--idea-bad:#f85149}}
.idea-bar{display:flex;align-items:center;gap:8px;height:36px;padding:0 12px;border-bottom:1px solid var(--idea-line);flex:none}
.idea-bar .idea-name{font-weight:600}
.idea-bar .idea-sub{opacity:.55;font-family:ui-monospace,"Geist Mono",Menlo,monospace;font-size:12px}
.idea-grow{flex:1;min-width:0}
.idea-frame{flex:1;min-height:0;border:0;width:100%;background:transparent}
.idea-btn{display:inline-flex;align-items:center;justify-content:center;height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--idea-line);background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.idea-btn:hover{background:var(--idea-hover)}
.idea-btn[disabled]{opacity:.5;cursor:default}
.idea-btn-primary{height:32px;font-size:13px;font-weight:500;background:currentColor;border-color:transparent}
.idea-btn-primary>span{color:Canvas}
.idea-center{max-width:420px;margin:56px auto;padding:0 20px}
.idea-stack>*+*{margin-top:16px}
.idea-field{display:flex;flex-direction:column;gap:6px}
.idea-label{font-weight:500;font-size:12px}
.idea-hint{font-size:12px;opacity:.6;margin:0}
.idea-input{width:100%;box-sizing:border-box;border:1px solid var(--idea-line);border-radius:6px;background:transparent;color:inherit;padding:7px 10px;font-family:ui-monospace,"Geist Mono",Menlo,monospace;font-size:12px}
.idea-input:focus{outline:2px solid color-mix(in srgb,#4f8cff 45%,transparent)}
.idea-alert{border:1px solid color-mix(in srgb,var(--idea-bad) 40%,transparent);color:var(--idea-bad);border-radius:6px;padding:10px 12px}
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

    function MachineView({ state, onUnpaired }) {
      const [src, setSrc] = useState(null);
      const [error, setError] = useState(null);
      const load = useCallback(async () => {
        setError(null);
        try { setSrc((await api("GET", "/view")).src); } catch (err) { setError(err); }
      }, []);
      useEffect(() => { load(); }, [load]);
      const unpair = async () => {
        if (!confirm("Disconnect this computer from the idea machine? Connecting again needs the setup code.")) return;
        await api("POST", "/unpair", {});
        onUnpaired();
      };
      return h("div", { className: "idea-root" },
        h("div", { className: "idea-bar" },
          h("span", { className: "idea-name" }, "idea"),
          h("span", { className: "idea-sub idea-grow" }, state.host || state.url || ""),
          h("button", { type: "button", className: "idea-btn", onClick: () => { setSrc(null); load(); } }, "Reload"),
          state.dev ? null : h("button", { type: "button", className: "idea-btn", onClick: unpair }, "Disconnect")),
        error
          ? h("div", { className: "idea-center idea-stack" }, h(ErrorLine, { error }), h("button", { type: "button", className: "idea-btn", onClick: load }, "Try again"))
          : src
            ? h("iframe", { className: "idea-frame", src, title: "idea machine", allow: "clipboard-read; clipboard-write" })
            : h("div", { className: "idea-center" }, h("p", { className: "idea-hint" }, "Connecting to the machine…")));
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
