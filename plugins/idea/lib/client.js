// idea: the DeepSeek Harness plugin for an idea machine (browser half).
//
// Adds an "idea" panel to the dsh sidebar: projects, their tasks, what the
// agents did, and the controls (new task, retry with an instruction, cancel,
// model keys, paired devices). All calls go to this plugin's host half under
// /idea/ (lib/index.js), which holds the pairing and talks to the machine.
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
    const { useState, useEffect, useCallback, useRef } = React;

    const PANEL_ID = "idea";

    // ------------------------------------------------------------- styles
    // Colors follow the surrounding dsh theme (currentColor mixes), so the
    // panel works in light and dark without knowing dsh's tokens.
    const CSS = `
.idea-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;line-height:1.5;color:inherit}
.idea-head{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--idea-line)}
.idea-head h1{font-size:15px;font-weight:600;margin:0;letter-spacing:-.01em}
.idea-head .idea-sub{opacity:.6;font-size:12px}
.idea-grow{flex:1;min-width:0}
.idea-body{display:flex;flex:1;min-height:0}
.idea-side{width:220px;flex:none;border-right:1px solid var(--idea-line);overflow:auto;padding:12px 8px}
.idea-main{flex:1;min-width:0;overflow:auto;padding:16px 20px 40px}
.idea-root{--idea-line:color-mix(in srgb,currentColor 12%,transparent);--idea-soft:color-mix(in srgb,currentColor 5%,transparent);--idea-hover:color-mix(in srgb,currentColor 8%,transparent);--idea-muted:color-mix(in srgb,currentColor 60%,transparent);--idea-ok:#1a7f37;--idea-bad:#cf222e;--idea-warn:#9a6700;--idea-run:#0969da}
@media (prefers-color-scheme: dark){.idea-root{--idea-ok:#3fb950;--idea-bad:#f85149;--idea-warn:#d29922;--idea-run:#4f8cff}}
.idea-sidelabel{font-size:11px;text-transform:uppercase;letter-spacing:.06em;opacity:.55;padding:8px 10px 4px}
.idea-nav{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:none;color:inherit;font:inherit;padding:6px 10px;border-radius:6px;cursor:pointer}
.idea-nav:hover{background:var(--idea-hover)}
.idea-nav[aria-current=true]{background:var(--idea-hover);font-weight:600}
.idea-nav .idea-count{margin-left:auto;font-size:11px;opacity:.6;font-variant-numeric:tabular-nums}
.idea-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:6px;border:1px solid var(--idea-line);background:transparent;color:inherit;font:inherit;font-weight:500;cursor:pointer;white-space:nowrap}
.idea-btn:hover{background:var(--idea-hover)}
.idea-btn[disabled]{opacity:.5;cursor:default}
.idea-btn-primary{background:currentColor;border-color:transparent}
.idea-btn-primary>span{color:Canvas;mix-blend-mode:normal}
.idea-btn-danger{color:var(--idea-bad)}
.idea-btn-sm{height:26px;padding:0 10px;font-size:12px}
.idea-stack>*+*{margin-top:16px}
.idea-stack-sm>*+*{margin-top:8px}
.idea-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.idea-field{display:flex;flex-direction:column;gap:6px}
.idea-label{font-weight:500;font-size:12px}
.idea-hint{font-size:12px;opacity:.6}
.idea-input,.idea-textarea{width:100%;box-sizing:border-box;border:1px solid var(--idea-line);border-radius:6px;background:transparent;color:inherit;font:inherit;padding:7px 10px}
.idea-textarea{min-height:96px;resize:vertical}
.idea-input:focus,.idea-textarea:focus{outline:2px solid color-mix(in srgb,var(--idea-run) 45%,transparent);outline-offset:0}
.idea-mono{font-family:ui-monospace,"Geist Mono",SFMono-Regular,Menlo,monospace;font-size:12px}
.idea-card{border:1px solid var(--idea-line);border-radius:8px}
.idea-card-head{padding:12px 16px;border-bottom:1px solid var(--idea-line);display:flex;align-items:center;gap:8px}
.idea-card-head h2{font-size:13px;font-weight:600;margin:0}
.idea-card-body{padding:16px}
.idea-table{width:100%;border-collapse:collapse}
.idea-table th{text-align:left;font-weight:500;font-size:12px;opacity:.6;padding:6px 10px;border-bottom:1px solid var(--idea-line)}
.idea-table td{padding:9px 10px;border-bottom:1px solid var(--idea-line);vertical-align:top}
.idea-table tbody tr{cursor:pointer}
.idea-table tbody tr:hover td{background:var(--idea-soft)}
.idea-num{font-variant-numeric:tabular-nums;opacity:.6;white-space:nowrap}
.idea-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;white-space:nowrap}
.idea-badge::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.5}
.idea-b-ok{color:var(--idea-ok)}.idea-b-ok::before{opacity:1}
.idea-b-bad{color:var(--idea-bad)}.idea-b-bad::before{opacity:1}
.idea-b-run{color:var(--idea-run)}.idea-b-run::before{opacity:1;animation:idea-pulse 1.6s ease-in-out infinite}
.idea-b-wait{color:var(--idea-warn)}.idea-b-wait::before{opacity:1}
@keyframes idea-pulse{50%{opacity:.25}}
.idea-alert{border:1px solid var(--idea-line);border-radius:6px;padding:10px 12px;background:var(--idea-soft)}
.idea-alert-bad{border-color:color-mix(in srgb,var(--idea-bad) 40%,transparent);color:var(--idea-bad)}
.idea-kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px}
.idea-kv dt{opacity:.6}.idea-kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.idea-steps{list-style:none;margin:0;padding:0}
.idea-steps li{display:flex;gap:12px;padding:6px 0}
.idea-steps .idea-when{opacity:.55;font-variant-numeric:tabular-nums;white-space:nowrap;width:64px;flex:none}
.idea-log{border:1px solid var(--idea-line);border-radius:6px;max-height:420px;overflow:auto;padding:8px 0;background:var(--idea-soft)}
.idea-log div{padding:1px 12px;white-space:pre-wrap;overflow-wrap:anywhere}
.idea-log .idea-k{opacity:.55;margin-right:8px}
.idea-empty{text-align:center;padding:48px 16px;opacity:.75}
.idea-empty h3{font-size:14px;margin:0 0 6px}
.idea-center{max-width:440px;margin:48px auto;padding:0 20px}
.idea-tabs{display:flex;gap:4px;border-bottom:1px solid var(--idea-line);margin-bottom:16px}
.idea-tab{border:0;background:none;color:inherit;font:inherit;padding:8px 10px;cursor:pointer;opacity:.6;border-bottom:2px solid transparent;margin-bottom:-1px}
.idea-tab[aria-selected=true]{opacity:1;border-bottom-color:currentColor;font-weight:500}
.idea-link{color:inherit;text-decoration:underline;text-decoration-color:var(--idea-line);text-underline-offset:3px}
@media (max-width:720px){.idea-body{flex-direction:column}.idea-side{width:auto;border-right:0;border-bottom:1px solid var(--idea-line)}}
`;
    function ensureStyle() {
      if (typeof document === "undefined" || document.querySelector("style[data-idea-css]")) return;
      const tag = document.createElement("style");
      tag.dataset.ideaCss = "1";
      tag.dataset.plugin = "@popododo0720/dsh-idea";
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ---------------------------------------------------------------- api
    async function api(method, path, body) {
      const init = { method, credentials: "same-origin", headers: {} };
      if (body !== undefined) {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      const res = await fetch("/idea" + path, init);
      let data = null;
      const text = await res.text();
      if (text) { try { data = JSON.parse(text); } catch (_e) { data = { error: text.slice(0, 200) }; } }
      if (!res.ok) {
        const err = new Error((data && data.error) || ("HTTP " + res.status));
        err.status = res.status;
        err.offline = !!(data && data.offline);
        throw err;
      }
      return data;
    }

    function usePoll(fn, ms, deps) {
      const [state, setState] = useState({ data: null, error: null, loading: true });
      const tick = useRef(0);
      const run = useCallback(async () => {
        const n = ++tick.current;
        try {
          const data = await fn();
          if (n === tick.current) setState({ data, error: null, loading: false });
        } catch (error) {
          if (n === tick.current) setState(s => ({ data: s.data, error, loading: false }));
        }
      }, deps);
      useEffect(() => {
        run();
        if (!ms) return undefined;
        const id = setInterval(run, ms);
        return () => clearInterval(id);
      }, [run, ms]);
      return [state, run];
    }

    // ------------------------------------------------------------ helpers
    const PHASE = {
      Pending: ["대기", "idea-b-wait"],
      WorkerStarting: ["작업 VM 시작", "idea-b-run"],
      Working: ["작업 중", "idea-b-run"],
      Gate: ["테스트 확인", "idea-b-run"],
      Done: ["머지됨", "idea-b-ok"],
      Failed: ["실패", "idea-b-bad"],
    };
    const ACTIVE = new Set(["Pending", "WorkerStarting", "Working", "Gate"]);
    function Badge({ phase }) {
      const [label, cls] = PHASE[phase] || [phase, ""];
      return h("span", { className: "idea-badge " + cls }, label);
    }
    function ago(iso) {
      if (!iso) return "";
      const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 60) return "방금";
      if (s < 3600) return Math.floor(s / 60) + "분 전";
      if (s < 86400) return Math.floor(s / 3600) + "시간 전";
      return Math.floor(s / 86400) + "일 전";
    }
    function clock(iso) {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    function Btn(props) {
      const { kind, size, children, ...rest } = props;
      const cls = "idea-btn" + (kind ? " idea-btn-" + kind : "") + (size ? " idea-btn-" + size : "");
      return h("button", { type: "button", className: cls, ...rest }, kind === "primary" ? h("span", null, children) : children);
    }
    function ErrorLine({ error }) {
      if (!error) return null;
      return h("div", { className: "idea-alert idea-alert-bad", role: "alert" }, String(error.message || error));
    }
    function Field({ label, hint, children }) {
      return h("label", { className: "idea-field" }, h("span", { className: "idea-label" }, label), children,
        hint ? h("span", { className: "idea-hint" }, hint) : null);
    }

    // One line of the main agent's event stream (dsh headless --json).
    function logLine(raw) {
      let ev;
      try { ev = JSON.parse(raw); } catch (_e) { return { k: "", t: raw }; }
      if (!ev || typeof ev !== "object") return { k: "", t: raw };
      const kind = ev.type || ev.kind || ev.event || "";
      const name = ev.name || ev.tool || (ev.call && ev.call.name) || "";
      let text = ev.text || ev.answer || ev.message || ev.content || "";
      if (typeof text !== "string") text = JSON.stringify(text);
      if (!text && ev.reason) text = typeof ev.reason === "string" ? ev.reason : (ev.reason.kind || JSON.stringify(ev.reason));
      if (!text && ev.arguments) text = typeof ev.arguments === "string" ? ev.arguments : JSON.stringify(ev.arguments);
      if (!text && ev.args) text = JSON.stringify(ev.args);
      if (text.length > 600) text = text.slice(0, 600) + " …";
      return { k: [kind, name].filter(Boolean).join(" "), t: text };
    }

    // ------------------------------------------------------------ pairing
    function PairForm({ onPaired }) {
      const [url, setUrl] = useState("");
      const [code, setCode] = useState("");
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const submit = async (e) => {
        e.preventDefault();
        setBusy(true); setError(null);
        try { onPaired(await api("POST", "/pair", { url, code })); }
        catch (err) { setError(err); }
        finally { setBusy(false); }
      };
      return h("div", { className: "idea-center" },
        h("form", { className: "idea-stack", onSubmit: submit },
          h("div", { className: "idea-stack-sm" },
            h("h1", { style: { fontSize: "18px", margin: 0 } }, "idea 기기 연결"),
            h("p", { className: "idea-hint", style: { margin: 0 } },
              "기기 콘솔에 나온 설정 페이지 주소와 설정 코드를 넣으세요. 이 PC에서 한 번만 하면 됩니다.")),
          h(ErrorLine, { error }),
          h(Field, { label: "주소", hint: "예: https://192.168.0.20:30443" },
            h("input", { className: "idea-input idea-mono", value: url, onChange: e => setUrl(e.target.value),
              placeholder: "https://<기기 주소>:30443", autoComplete: "off", spellCheck: false, required: true })),
          h(Field, { label: "설정 코드" },
            h("input", { className: "idea-input idea-mono", value: code, onChange: e => setCode(e.target.value),
              placeholder: "xxxx-xxxx-xxxx", autoComplete: "one-time-code", spellCheck: false, required: true })),
          h("button", { type: "submit", className: "idea-btn idea-btn-primary", disabled: busy, style: { width: "100%" } },
            h("span", null, busy ? "연결 중…" : "연결"))));
    }

    // ------------------------------------------------------------- tasks
    function NewTask({ project, onDone, onCancel }) {
      const [title, setTitle] = useState("");
      const [body, setBody] = useState("");
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const submit = async (e) => {
        e.preventDefault();
        setBusy(true); setError(null);
        try { const r = await api("POST", "/v1/tasks", { project, title, body }); onDone(r.task); }
        catch (err) { setError(err); setBusy(false); }
      };
      return h("form", { className: "idea-card", onSubmit: submit },
        h("div", { className: "idea-card-head" }, h("h2", null, "새 작업 · " + project)),
        h("div", { className: "idea-card-body idea-stack" },
          h(ErrorLine, { error }),
          h(Field, { label: "무엇을 할까요" },
            h("input", { className: "idea-input", value: title, onChange: e => setTitle(e.target.value), maxLength: 200, required: true, autoFocus: true })),
          h(Field, { label: "자세한 설명", hint: "저장소 이슈로 올라가고, 에이전트가 이 내용을 보고 작업합니다." },
            h("textarea", { className: "idea-textarea", value: body, onChange: e => setBody(e.target.value), maxLength: 20000 })),
          h("div", { className: "idea-row" },
            h("button", { type: "submit", className: "idea-btn idea-btn-primary", disabled: busy || !title.trim() }, h("span", null, busy ? "만드는 중…" : "작업 시작")),
            h(Btn, { onClick: onCancel }, "취소"))));
    }

    function TaskDetail({ name, onBack }) {
      const [state, refresh] = usePoll(() => api("GET", "/v1/tasks/" + name), 3000, [name]);
      const [note, setNote] = useState("");
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const logRef = useRef(null);
      const d = state.data;
      useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [d && d.log && d.log.length]);
      const act = async (path, body) => {
        setBusy(true); setError(null);
        try { await api("POST", "/v1/tasks/" + name + path, body); setNote(""); await refresh(); }
        catch (err) { setError(err); }
        finally { setBusy(false); }
      };
      if (!d) return h("div", null, h(Btn, { size: "sm", onClick: onBack }, "← 목록"), state.error ? h(ErrorLine, { error: state.error }) : h("p", { className: "idea-hint" }, "불러오는 중…"));
      const t = d.task || { name, phase: "", title: name };
      const lines = (d.log || []).map(logLine);
      return h("div", { className: "idea-stack" },
        h("div", { className: "idea-row" }, h(Btn, { size: "sm", onClick: onBack }, "← 목록")),
        h("div", { className: "idea-stack-sm" },
          h("div", { className: "idea-row" }, h(Badge, { phase: t.phase }), h("span", { className: "idea-num" }, "#" + t.issue + " · " + t.project)),
          h("h2", { style: { fontSize: "17px", margin: 0 } }, t.title),
          t.message ? h("p", { className: "idea-hint", style: { margin: 0 } }, t.message) : null),
        h(ErrorLine, { error: error || state.error }),
        h("dl", { className: "idea-kv" },
          h("dt", null, "이슈"), h("dd", null, h("a", { className: "idea-link", href: t.issueURL, target: "_blank", rel: "noreferrer" }, "#" + t.issue)),
          t.pullRequest ? h("dt", null, "PR") : null,
          t.pullRequest ? h("dd", null, h("a", { className: "idea-link", href: t.pullRequestURL, target: "_blank", rel: "noreferrer" }, "#" + t.pullRequest)) : null,
          h("dt", null, "시작"), h("dd", null, ago(t.created))),
        ACTIVE.has(t.phase) ? h("div", { className: "idea-row" },
          h(Btn, { kind: "danger", size: "sm", disabled: busy, onClick: () => { if (confirm("이 작업을 멈출까요? 작업 VM이 지워집니다.")) act("/cancel", undefined); } }, "작업 멈추기")) : null,
        t.phase === "Failed" ? h("div", { className: "idea-card" },
          h("div", { className: "idea-card-head" }, h("h2", null, "다시 시도")),
          h("div", { className: "idea-card-body idea-stack-sm" },
            h("textarea", { className: "idea-textarea", value: note, onChange: e => setNote(e.target.value),
              placeholder: "추가로 알려줄 것 (선택). 이슈에도 댓글로 남습니다." }),
            h(Btn, { kind: "primary", disabled: busy, onClick: () => act("/retry", { note }) }, busy ? "요청 중…" : "다시 시도"))) : null,
        h("div", { className: "idea-stack-sm" },
          h("h3", { style: { fontSize: "13px", margin: 0 } }, "진행"),
          h("ol", { className: "idea-steps" }, (d.events || []).map((e, i) =>
            h("li", { key: i }, h("span", { className: "idea-when" }, clock(e.at)), h(Badge, { phase: e.phase }), h("span", { className: "idea-grow" }, e.message))))),
        h("div", { className: "idea-stack-sm" },
          h("h3", { style: { fontSize: "13px", margin: 0 } }, "에이전트 기록"),
          lines.length === 0
            ? h("p", { className: "idea-hint" }, "아직 기록이 없습니다. 메인 에이전트가 시작하면 여기에 나옵니다.")
            : h("div", { className: "idea-log idea-mono", ref: logRef }, lines.map((l, i) =>
                h("div", { key: i }, l.k ? h("span", { className: "idea-k" }, l.k) : null, l.t)))));
    }

    function TaskList({ status, project, onOpen, onNew }) {
      const tasks = status.tasks.filter(t => t.project === project.name);
      return h("div", { className: "idea-stack" },
        h("div", { className: "idea-row" },
          h("div", { className: "idea-grow idea-stack-sm" },
            h("h2", { style: { fontSize: "16px", margin: 0 } }, project.name),
            project.description ? h("p", { className: "idea-hint", style: { margin: 0 } }, project.description) : null),
          h("a", { className: "idea-btn idea-btn-sm", href: project.url, target: "_blank", rel: "noreferrer", style: { textDecoration: "none" } }, "저장소"),
          h(Btn, { kind: "primary", size: "sm", onClick: onNew }, "새 작업")),
        !project.ready && project.message ? h("div", { className: "idea-alert idea-alert-bad" }, "저장소 준비 중 오류: " + project.message) : null,
        tasks.length === 0
          ? h("div", { className: "idea-empty" }, h("h3", null, "작업이 없습니다"), h("p", null, "새 작업을 만들거나 저장소에 이슈를 쓰면 에이전트가 시작합니다."))
          : h("table", { className: "idea-table" },
              h("thead", null, h("tr", null, h("th", null, "#"), h("th", null, "작업"), h("th", null, "상태"), h("th", null, "변경"))),
              h("tbody", null, tasks.map(t => h("tr", { key: t.name, onClick: () => onOpen(t.name) },
                h("td", { className: "idea-num" }, t.issue),
                h("td", null, h("div", null, t.title), t.message ? h("div", { className: "idea-hint" }, t.message) : null),
                h("td", null, h(Badge, { phase: t.phase })),
                h("td", { className: "idea-num" }, ago(t.since)))))));
    }

    function NewProject({ onDone, onCancel }) {
      const [name, setName] = useState("");
      const [description, setDescription] = useState("");
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const submit = async (e) => {
        e.preventDefault();
        setBusy(true); setError(null);
        try { const p = await api("POST", "/v1/projects", { name, description }); onDone(p.name); }
        catch (err) { setError(err); setBusy(false); }
      };
      return h("form", { className: "idea-card", onSubmit: submit },
        h("div", { className: "idea-card-head" }, h("h2", null, "새 프로젝트")),
        h("div", { className: "idea-card-body idea-stack" },
          h(ErrorLine, { error }),
          h(Field, { label: "이름", hint: "저장소 이름이 됩니다. 소문자, 숫자, - 만 (40자까지)." },
            h("input", { className: "idea-input idea-mono", value: name, onChange: e => setName(e.target.value.toLowerCase()),
              pattern: "[a-z0-9]([-a-z0-9]{0,38}[a-z0-9])?", required: true, autoFocus: true, spellCheck: false })),
          h(Field, { label: "설명 (선택)" },
            h("input", { className: "idea-input", value: description, onChange: e => setDescription(e.target.value), maxLength: 500 })),
          h("div", { className: "idea-row" },
            h("button", { type: "submit", className: "idea-btn idea-btn-primary", disabled: busy }, h("span", null, busy ? "만드는 중…" : "만들기")),
            h(Btn, { onClick: onCancel }, "취소"))));
    }

    // ----------------------------------------------------------- settings
    function Settings({ status, pairing, onUnpaired }) {
      const [deepseek, setDeepseek] = useState("");
      const [claude, setClaude] = useState("");
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState("");
      const [devices, refreshDevices] = usePoll(() => api("GET", "/v1/devices"), 0, []);
      const saveKeys = async (e) => {
        e.preventDefault();
        setBusy(true); setError(null); setNotice("");
        try { await api("PUT", "/v1/keys", { deepseek, claude }); setDeepseek(""); setClaude(""); setNotice("저장했습니다. 다음 작업부터 쓰입니다."); }
        catch (err) { setError(err); }
        finally { setBusy(false); }
      };
      const revoke = async (id) => {
        if (!confirm("이 기기의 연결을 끊을까요?")) return;
        try { await api("DELETE", "/v1/devices/" + id); refreshDevices(); } catch (err) { setError(err); }
      };
      const unpair = async () => {
        if (!confirm("이 PC의 연결을 끊을까요? 다시 쓰려면 설정 코드가 필요합니다.")) return;
        await api("POST", "/unpair", {});
        onUnpaired();
      };
      const keys = (status && status.keys) || {};
      return h("div", { className: "idea-stack", style: { maxWidth: "560px" } },
        h(ErrorLine, { error }),
        notice ? h("div", { className: "idea-alert" }, notice) : null,
        h("form", { className: "idea-card", onSubmit: saveKeys },
          h("div", { className: "idea-card-head" }, h("h2", null, "모델 키")),
          h("div", { className: "idea-card-body idea-stack" },
            h("div", { className: "idea-row" },
              h("span", { className: "idea-badge " + (keys.deepseek ? "idea-b-ok" : "idea-b-bad") }, keys.deepseek ? "DeepSeek 키 있음" : "DeepSeek 키 없음"),
              h("span", { className: "idea-badge " + (keys.claude ? "idea-b-ok" : "") }, keys.claude ? "Claude 토큰 있음" : "Claude 토큰 없음 (선택)")),
            h(Field, { label: "DeepSeek API 키", hint: "에이전트가 쓰는 모델입니다. 없으면 작업이 시작되지 않습니다." },
              h("input", { className: "idea-input idea-mono", type: "password", value: deepseek, onChange: e => setDeepseek(e.target.value), autoComplete: "off" })),
            h(Field, { label: "Claude Code 토큰 (선택)", hint: "`claude setup-token`으로 만든 토큰. 에이전트가 Claude Code에게 일을 맡길 수 있게 됩니다." },
              h("input", { className: "idea-input idea-mono", type: "password", value: claude, onChange: e => setClaude(e.target.value), autoComplete: "off" })),
            h("p", { className: "idea-hint", style: { margin: 0 } }, "비워 둔 칸은 지금 값을 그대로 둡니다. 키는 기기 안에만 저장됩니다."),
            h("div", null, h("button", { type: "submit", className: "idea-btn idea-btn-primary", disabled: busy || (!deepseek.trim() && !claude.trim()) }, h("span", null, "저장"))))),
        h("div", { className: "idea-card" },
          h("div", { className: "idea-card-head" }, h("h2", null, "연결된 기기")),
          h("div", { className: "idea-card-body idea-stack-sm" },
            (devices.data || []).map(dv => h("div", { key: dv.id, className: "idea-row" },
              h("span", { className: "idea-grow" }, dv.name, dv.this ? h("span", { className: "idea-hint" }, " · 이 PC") : null,
                h("div", { className: "idea-hint idea-mono" }, dv.id + " · " + ago(dv.created))),
              dv.this ? null : h(Btn, { size: "sm", kind: "danger", onClick: () => revoke(dv.id) }, "끊기"))))),
        h("div", { className: "idea-card" },
          h("div", { className: "idea-card-head" }, h("h2", null, "이 PC")),
          h("div", { className: "idea-card-body idea-stack-sm" },
            h("dl", { className: "idea-kv" },
              h("dt", null, "기기"), h("dd", { className: "idea-mono" }, pairing.url),
              h("dt", null, "이름"), h("dd", { className: "idea-mono" }, pairing.host || ""),
              h("dt", null, "인증서"), h("dd", { className: "idea-mono", style: { fontSize: "11px" } }, pairing.fingerprint)),
            h("div", null, h(Btn, { kind: "danger", size: "sm", onClick: unpair }, "연결 끊기")))));
    }

    // -------------------------------------------------------------- panel
    function Dashboard({ pairing, onUnpaired }) {
      const [status, refresh] = usePoll(() => api("GET", "/v1/status"), 5000, []);
      const [view, setView] = useState({ kind: "project", project: null });
      const s = status.data;
      useEffect(() => {
        if (s && view.kind === "project" && !view.project && s.projects.length) setView({ kind: "project", project: s.projects[0].name });
      }, [s, view]);
      if (status.error && status.error.status === 401) {
        return h("div", { className: "idea-center idea-stack" },
          h("div", { className: "idea-alert idea-alert-bad" }, "기기가 이 PC의 연결을 받지 않습니다. 연결이 끊긴 것 같습니다."),
          h(Btn, { onClick: async () => { await api("POST", "/unpair", {}); onUnpaired(); } }, "다시 연결하기"));
      }
      const project = s && s.projects.find(p => p.name === view.project);
      const counts = {};
      if (s) for (const t of s.tasks) if (ACTIVE.has(t.phase)) counts[t.project] = (counts[t.project] || 0) + 1;
      let main;
      if (!s) main = status.error ? h(ErrorLine, { error: status.error }) : h("p", { className: "idea-hint" }, "불러오는 중…");
      else if (view.kind === "settings") main = h(Settings, { status: s, pairing, onUnpaired });
      else if (view.kind === "new-project") main = h(NewProject, { onDone: (n) => { refresh(); setView({ kind: "project", project: n }); }, onCancel: () => setView({ kind: "project", project: view.project }) });
      else if (view.kind === "new-task") main = h(NewTask, { project: view.project, onDone: (task) => { refresh(); setView({ kind: "task", project: view.project, task }); }, onCancel: () => setView({ kind: "project", project: view.project }) });
      else if (view.kind === "task") main = h(TaskDetail, { name: view.task, onBack: () => { refresh(); setView({ kind: "project", project: view.project }); } });
      else if (project) main = h(TaskList, { status: s, project, onOpen: (task) => setView({ kind: "task", project: project.name, task }), onNew: () => setView({ kind: "new-task", project: project.name }) });
      else main = h("div", { className: "idea-empty" }, h("h3", null, "프로젝트가 없습니다"), h("p", null, "왼쪽에서 새 프로젝트를 만드세요."));
      return h("div", { className: "idea-root" },
        h("div", { className: "idea-head" },
          h("div", { className: "idea-grow" }, h("h1", null, "idea"), h("div", { className: "idea-sub idea-mono" }, s ? s.host : pairing.url)),
          s && !s.keys.deepseek ? h("span", { className: "idea-badge idea-b-bad" }, "모델 키 없음") : null,
          status.error && s ? h("span", { className: "idea-badge idea-b-wait" }, "연결 끊김") : null),
        h("div", { className: "idea-body" },
          h("nav", { className: "idea-side" },
            h("div", { className: "idea-sidelabel" }, "프로젝트"),
            (s ? s.projects : []).map(p => h("button", {
              key: p.name, type: "button", className: "idea-nav",
              "aria-current": view.project === p.name && view.kind !== "settings" && view.kind !== "new-project" ? "true" : "false",
              onClick: () => setView({ kind: "project", project: p.name }),
            }, p.name, counts[p.name] ? h("span", { className: "idea-count" }, counts[p.name]) : null)),
            h("button", { type: "button", className: "idea-nav", style: { opacity: 0.7 }, onClick: () => setView({ kind: "new-project", project: view.project }) }, "+ 새 프로젝트"),
            h("div", { className: "idea-sidelabel", style: { marginTop: "12px" } }, "기기"),
            h("button", { type: "button", className: "idea-nav", "aria-current": view.kind === "settings" ? "true" : "false", onClick: () => setView({ kind: "settings", project: view.project }) }, "설정")),
          h("section", { className: "idea-main" }, main)));
    }

    function IdeaPanel() {
      useEffect(ensureStyle, []);
      const [state, refresh] = usePoll(() => api("GET", "/state"), 0, []);
      if (!state.data) {
        return h("div", { className: "idea-root" }, h("div", { className: "idea-center" },
          state.error ? h(ErrorLine, { error: state.error }) : h("p", { className: "idea-hint" }, "불러오는 중…")));
      }
      if (!state.data.paired) return h("div", { className: "idea-root" }, h(PairForm, { onPaired: () => refresh() }));
      return h(Dashboard, { pairing: state.data, onUnpaired: () => refresh() });
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
      ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
        name: "sidebar.panellist", id: PANEL_ID, order: 20, label: "idea",
      }, IdeaIcon));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
