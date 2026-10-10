    // ============================================================
    // UI 2026
    // - embedded device web UI
    // - fetch from /api/...
    // - single-file, no external libraries
    // ============================================================

    const $ = (sel, root=document) => root.querySelector(sel);
    const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

    const state = {
      theme: localStorage.getItem("ui2026_theme") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"),
      source: "device", // fixed (device)
      apiBase: localStorage.getItem("ui2026_apiBase") || "",
      dev: {},
      system: { uptimeSec: null },
      fast: {},
      eqFast: {},
      mixStatus: null,
      mixConfig: null,
      dhwFast: {},
      bleFast: {},
      mqtt: { loaded:false, načítání:false, status:null, config:null },
      ws: { sock:null, připojeno:false, retryTimer:null, reconnectMs:2000, manualClose:false, failCount:0, disabledUntilMs:0 },
      last: null,
      history: {
        out: [],
        ch: [],
        dhw: [],
        pr: [],
      },
      io: {
        relays: [false,false,false,false,false,false,false,false],
        inputs: [false,false,false],
      }
    ,
      accu: {
        top: NaN,
        mid: NaN,
        bot: NaN,
        valve: 0,     // %
        after: NaN,   // °C (temp after mixing valve)
        mode: "auto"
      },
      ot: {
        comm: false,
        linkOk: false,
        enabled: false,
        ready: false,
        fault: false,
        present: false,
        chSet: 45.0,
        chTemp: 44.2,
        dhwTemp: 49.3,
        outsideTempC: NaN,
        returnTempC: NaN,
        pressure: 1.58,
        modulationPct: NaN,
        maxCapacityKw: NaN,
        currentPowerKw: NaN,
        reqWaterTempC: NaN,
        reqDhwSetpointC: NaN,
        maxChSetpointC: NaN,
        maxChBoundMinC: NaN,
        maxChBoundMaxC: NaN,
        dhwSetpointC: NaN,
        dhwBoundMinC: NaN,
        dhwBoundMaxC: NaN,
        faultFlags: 0,
        oemFaultCode: 0,
        reason: "",
        lastCmd: "",
        statusRaw: 0,
        cfg: { enable: true, pollMs: 1000, failMode: "hold", log: false }
      },
      otMeta: {
        capacityFetchMs: 0,
        capacityFetching: false,
      },
      alerts: {
        pressure: {
          enabled: true,
          minBar: 0.8,
          maxBar: 2.8,
          hysteresisBar: 0.05,
          active: false,
          sensorValid: false,
          pressureBar: NaN,
          state: "init"
        }
      },
      circPulse: { enable: true, onMin: 5, vypnutoMin: 15 },
      net: {
        failCount: 0,
        lastErrorToastMs: 0,
        nextPollMs: 10000,
        extrasDueMs: 0,
        apiBaseFallbackUsed: false,
      },
      ui: {
        eqConfigDirty: false,
        mixConfigDirty: false,
        wizardStep: 0,
        wizardAutoOpenScheduled: false,
      },
      setupWizard: { schemaVersion:2, completedVersion:0, completed:false },
      diag: {
        heap: {},
        adminActions: []
      },
      render: {
        pendingSample: null,
        rafId: 0,
      },
      service: loadServiceStats()
    };

    // OpenTherm


    // ----- Minimal toast
    function toast(title, msg, icon="ℹ"){
      const host = $("#toast");
      const el = document.createElement("div");
      el.className = "t";
      el.innerHTML = `
        <div class="ic">${icon}</div>
        <div class="tx"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(msg || "")}</span></div>
        <button aria-label="Zavřít">✕</button>
      `;
      el.querySelector("button").addEventListener("click", () => el.remove());
      host.prepend(el);
      setTimeout(() => { if(el.isConnected) el.remove(); }, 5200);
    }

    function escapeHtml(s){
      return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    function numOrNaN(v){
      if(v === null || v === undefined) return NaN;
      if(typeof v === "boolean") return NaN;
      if(typeof v === "string" && !v.trim().length) return NaN;
      const n = Number(v);
      return Number.isFinite(n) ? n : NaN;
    }

    function firstFinite(){
      for(const v of arguments){
        const n = numOrNaN(v);
        if(Number.isFinite(n)) return n;
      }
      return NaN;
    }

    function loadServiceStats(){
      const blank = {
        current:{ mixKey:"", dhwKey:"" },
        counters:{},
        lastChangeMs:0,
      };
      try{
        const raw = localStorage.getItem("ui2026_service_stats");
        if(!raw) return blank;
        const parsed = JSON.parse(raw);
        const counters = (parsed && typeof parsed.counters === "object" && parsed.counters) ? parsed.counters : {};
        return {
          current:{
            mixKey: String(parsed?.current?.mixKey || ""),
            dhwKey: String(parsed?.current?.dhwKey || ""),
          },
          counters,
          lastChangeMs: Number(parsed?.lastChangeMs) || 0,
        };
      }catch(_e){
        return blank;
      }
    }

    function saveServiceStats(){
      try{
        localStorage.setItem("ui2026_service_stats", JSON.stringify(state.service || loadServiceStats()));
      }catch(_e){}
    }

    function hasOwn(obj, key){
      return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
    }

    function readMaybeNumber(obj, key, fallback=NaN){
      if(!hasOwn(obj, key)) return fallback;
      return numOrNaN(obj[key]);
    }

    function readMaybeString(obj, key, fallback=""){
      if(!hasOwn(obj, key)) return fallback;
      const v = obj[key];
      return (v === null || v === undefined) ? "" : String(v);
    }

    function readMaybeBool(obj, key, fallback=false){
      return hasOwn(obj, key) ? !!obj[key] : fallback;
    }

    function fmtNum(v, digits=1){
      const n = Number(v);
      return Number.isFinite(n) ? n.toFixed(digits) : "--";
    }

    function fmtBytes(v){
      const n = Number(v);
      if(!Number.isFinite(n) || n < 0) return "--";
      if(n < 1024) return `${Math.round(n)} B`;
      if(n < 1024*1024) return `${(n/1024).toFixed(n >= 10*1024 ? 0 : 1)} kB`;
      return `${(n/(1024*1024)).toFixed(n >= 10*1024*1024 ? 0 : 1)} MB`;
    }

    async function parseApiReply(r, path){
      const txt = await r.text();
      let body = null;
      if(txt){
        try{ body = JSON.parse(txt); }catch{}
      }
      if(!r.ok){
        const msg = body?.msg || body?.error || body?.message || txt || `HTTP ${r.status} for ${path}`;
        const retryAfterMs = Number(body?.retryAfterMs);
        if(r.status === 429){
          const extra = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? ` Zkus to znovu za ${Math.ceil(retryAfterMs/1000)} s.` : " Zkus to znovu za chvíli.";
          throw new Error(`HTTP 429 for ${path}: ${msg}.${extra}`);
        }
        throw new Error(`HTTP ${r.status} for ${path}: ${msg}`);
      }
      if(body !== null) return body;
      return txt ? { raw: txt } : {};
    }

    function setTextNum(id, v, digits=1){
      const el = $(id);
      if(!el) return;
      el.textContent = fmtNum(v, digits);
    }

    function setApiHealth(kind, text){
      setBadge("#bApi", kind || "", text || "API: --");
      setText("#apiState", text || "API: --");
      thermaSetConnection(kind, text);
    }

    function debounce(fn, wait=120){
      let t = null;
      return function(){
        const ctx = this;
        const args = arguments;
        clearTimeout(t);
        t = setTimeout(() => fn.apply(ctx, args), wait);
      };
    }

    function setBusy(btn, busy, busyText="Pracuji…"){
      if(!btn) return;
      if(busy){
        if(btn.dataset.busy === "1") return;
        btn.dataset.busy = "1";
        btn.dataset.label = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = escapeHtml(busyText);
      }else{
        btn.disabled = false;
        if(btn.dataset.label) btn.innerHTML = btn.dataset.label;
        delete btn.dataset.label;
        delete btn.dataset.busy;
      }
    }

    async function withButtonBusy(btn, busyText, task){
      if(!btn) return await task();
      if(btn.dataset.busy === "1") return;
      setBusy(btn, true, busyText);
      try{
        return await task();
      }finally{
        setBusy(btn, false);
      }
    }

    function bindImmediateButton(btn, busyText, task){
      if(!btn) return;
      let suppressNextClick = false;
      let suppressTimer = null;
      const run = () => {
        void withButtonBusy(btn, busyText, task).catch((e) => {
          const message = String(e?.message || e || "Neznámá chyba");
          log(`mix action failed: ${message}`);
          toast("Směšovací ventil", `Akce nebyla potvrzena: ${message}`, "⚠️");
        });
      };

      btn.addEventListener("pointerdown", (ev) => {
        if(typeof ev.button === "number" && ev.button !== 0) return;
        suppressNextClick = true;
        clearTimeout(suppressTimer);
        suppressTimer = setTimeout(() => { suppressNextClick = false; }, 1200);
        ev.preventDefault();
        run();
      });

      // Keyboard activation still arrives as click without pointerdown.
      btn.addEventListener("click", (ev) => {
        if(suppressNextClick){
          suppressNextClick = false;
          clearTimeout(suppressTimer);
          ev.preventDefault();
          return;
        }
        run();
      });
    }

    function isEditableTarget(el){
      if(!el || !(el instanceof Element)) return false;
      return !!el.closest('input, textarea, select, [contenteditable="true"]');
    }

    const redrawEquithermViewsDebounced = debounce(() => redrawEquithermViews(), 90);

    // ----- Theme
    function applyTheme(){
      document.documentElement.setAttribute("data-theme", state.theme);
      $("#btnTheme").innerHTML = state.theme === "light" ? "☾" : "☀";
      localStorage.setItem("ui2026_theme", state.theme);
    }

    // ----- Navigation
    const titles = {
      overview: ["Přehled", "Kompaktní status + rychlé akce"],
      heating:  ["Topení", "Ekviterm • křivky komfort / útlum • limity • plán"],
      dhw:      ["TUV", "Ohřev teplé užitkové vody • cirkulace • plánovače"],
      accu:     ["Akumulační nádrž", "Teploty nádrže • stav akumulace"],
      mixing:  ["Trojcestný směšovací ventil", "Konfigurace • ruční ovládání • kalibrace"],
      opentherm:["OpenTherm", "Komunikace • hodnoty kotle"],
      thermometers:["Teploměry", "Mapování zdrojů teplot na role"],
      io:       ["I/O", "Relé • vstupy • rychlé přepínače"],
      diag:     ["Diagnostika", "API • MQTT/HA • logy • export"],
    };

    function getUiSample(){
      const last = state.last || {};
      const now = Date.now();
      const temps = (state.fast && typeof state.fast.temps === "object") ? state.fast.temps : {};
      const out = firstFinite(roleValueFromFast("outside", temps), state?.ot?.outsideTempC, state?.bleFast?.t, last?.out);
      const ch = firstFinite(roleValueFromFast("flow", temps), state?.ot?.chTemp, last?.ch);
      const dhw = firstFinite(roleValueFromFast("dhw_tank", temps), state?.ot?.dhwTemp, last?.dhw);
      const pr = firstFinite(state?.ot?.pressure, last?.pr);
      const mixSupply = firstFinite(state?.mixStatus?.aC, state?.eqFast?.mix?.ma, ch, last?.mixSupply);
      const mixReturn = firstFinite(state?.mixStatus?.bC, state?.eqFast?.mix?.mb, temps.returnDallasC, temps.return, temps.returnTempC, state?.ot?.returnTempC, last?.mixReturn);
      const afterMix = firstFinite(state?.mixStatus?.abC, state?.eqFast?.mix?.mf, getAfterMixTempFromTemps(temps), last?.mixAfter, state?.accu?.after, ch);
      return {
        now,
        out: Number.isFinite(out) ? out : 0,
        ch: Number.isFinite(ch) ? ch : 0,
        dhw: Number.isFinite(dhw) ? dhw : 0,
        pr: Number.isFinite(pr) ? pr : 0,
        in1: !!state?.io?.inputs?.[0],
        in2: !!state?.io?.inputs?.[1],
        in3: !!state?.io?.inputs?.[2],
        accTop: firstFinite(roleValueFromFast("tank_top", temps), last?.accTop, state?.accu?.top),
        accMid: firstFinite(roleValueFromFast("tank_mid", temps), last?.accMid, state?.accu?.mid),
        accBot: firstFinite(roleValueFromFast("tank_bottom", temps), last?.accBot, state?.accu?.bot),
        mixValve: firstFinite(state?.mixStatus?.positionPct, state?.eqFast?.mix?.pct, last?.mixValve, state?.accu?.valve),
        mixSupply,
        mixAfter: afterMix,
        mixTarget: firstFinite(state?.mixStatus?.targetC, state?.eqFast?.mix?.tf, state?.eqFast?.tf, document.getElementById("hTarget")?.value, document.getElementById("eqSet")?.value, last?.mixTarget, 45),
        mixReturn,
        eqTarget: firstFinite(state?.eqFast?.tb, state?.eqFast?.tf, last?.eqTarget),
      };
    }

    function waitForFirstFastSnapshot(timeoutMs=1200){
      if(state.fast || state.last) return Promise.resolve(true);
      return new Promise((resolve) => {
        let done = false;
        const finish = (ok) => {
          if(done) return;
          done = true;
          clearTimeout(timer);
          document.removeEventListener("ui:first-fast", onFast);
          resolve(!!ok);
        };
        const onFast = () => finish(true);
        const timer = setTimeout(() => finish(!!(state.fast || state.last)), Math.max(150, Number(timeoutMs) || 1200));
        document.addEventListener("ui:first-fast", onFast, { once:true });
      });
    }

    function queueRenderSample(sample){
      state.render = state.render || { pendingSample:null, rafId:0 };
      state.render.pendingSample = sample || getUiSample();
      if(state.render.rafId) return;
      const flush = () => {
        const pending = state.render?.pendingSample || getUiSample();
        state.render.pendingSample = null;
        state.render.rafId = 0;
        renderSample(pending);
      };
      if(typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"){
        state.render.rafId = window.requestAnimationFrame(flush);
      }else{
        flush();
      }
    }

    function redrawEquithermViews(){
      queueRenderSample(getUiSample());
    }
    // Expose only a safe re-render trigger to the separate layout module.
    // No additional polling and no changes to the backend are introduced.
    window.thermaRedrawEquitherm = redrawEquithermViews;


    // Floating save dock: tracked by the section that was actually edited.
    // Telemetry changes never trigger it, only user input / committed planner edits.
    const pendingSaveDef = {
      eq:       { view:"heating", label:"Topení", button:"#hApply" },
      heatPlan: { view:"heating", label:"Plán topení", button:'[data-pl-save="heatingDay"]' },
      mixing:   { view:"mixing", label:"Směšovací ventil", button:"#hMixSave" },
      dhw:      { view:"dhw", label:"Nastavení TUV", button:"#dhwSaveCfg" },
      dhwPlan:  { view:"dhw", label:"Plány TUV", button:'[data-pl-save="dhwHeat"]' },
      ot:       { view:"opentherm", label:"OpenTherm", button:"#otCfgApply" },
      pressure: { view:"opentherm", label:"Alarm tlaku", button:"#pressAlarmApply" },
      dallas:   { view:"thermometers", label:"Teploměry", button:"#thSave" },
      ble:      { view:"thermometers", label:"BLE", button:"#bleSave" },
      mqtt:     { view:"diag", label:"MQTT", button:"#mqttSave" },
      time:     { view:"diag", label:"Čas a NTP", button:"#timeSave" },
      api:      { view:"diag", label:"API adresa", button:"#apiSave" },
    };
    const pendingSaveDirty = new Set();
    function isPendingSaveDirty(key){ return pendingSaveDirty.has(key); }
    function updatePendingSaveBar(){
      const dock = document.getElementById("pendingSaveBar");
      const actions = document.getElementById("pendingSaveActions");
      if(!dock || !actions) return;
      const view = getActiveView();
      const keys = Object.keys(pendingSaveDef).filter(k =>
        pendingSaveDirty.has(k) && pendingSaveDef[k].view === view);
      dock.hidden = keys.length === 0;
      if(!keys.length){ actions.replaceChildren(); return; }
      const summary = document.getElementById("pendingSaveSummary");
      if(summary) summary.textContent = keys.length === 1
        ? pendingSaveDef[keys[0]].label + " – změny čekají na uložení"
        : keys.length + " samostatné části konfigurace čekají na uložení";
      actions.replaceChildren();
      for(const key of keys){
        const def = pendingSaveDef[key];
        const action = document.createElement("button");
        action.type = "button";
        action.className = "btn primary";
        action.textContent = keys.length === 1 ? "Uložit změny" : "Uložit: " + def.label;
        action.title = "Uložit " + def.label + " do zařízení";
        action.addEventListener("click", () => {
          const source = document.querySelector(def.button);
          if(!source || source.disabled) return;
          source.click(); // Reuse validated page-specific save handler.
        });
        actions.appendChild(action);
      }
    }
    function markPendingSaveDirty(key){
      if(!pendingSaveDef[key]) return;
      pendingSaveDirty.add(key);
      updatePendingSaveBar();
    }
    function clearPendingSaveDirty(key){
      pendingSaveDirty.delete(key);
      updatePendingSaveBar();
    }
    function saveGroupForUserEdit(target){
      if(!target || !target.matches || !target.matches("input,select,textarea")) return null;
      if(target.disabled || target.readOnly || target.type === "file" || target.closest("#setupWizard")) return null;
      const view = target.closest(".section")?.id?.replace(/^view-/, "");
      const id = target.id || "";
      if(view === "heating" || view === "mixing") return null; // Existing precise dirty tracking.
      if(view === "dhw"){
        if(id === "dhwCirc" || id === "dhwValve") return null; // Live immediate switches.
        if(id.startsWith("dhw")) return "dhw";
        if(["circPulseEnable","circPulseOn","circPulseOff"].includes(id)) return "dhwPlan";
      }
      if(view === "opentherm"){
        if(["otEnable","otPoll","otFailMode","otLog"].includes(id)) return "ot";
        if(id.startsWith("pressAlarm")) return "pressure";
      }
      if(view === "thermometers"){
        if(["bleEnable","bleNamePrefix","bleScanIntervalMs"].includes(id)) return "ble";
        if(id === "dallasEnable" || id.startsWith("mixTempSource") || target.closest("#thMapTbl")) return "dallas";
      }
      if(view === "diag"){
        if(["mqttEnable","mqttHost","mqttPort","mqttUser","mqttPassword","mqttClearPassword",
             "mqttClientId","mqttBaseTopic","mqttPublishIntervalMs","mqttHaEnable",
             "mqttHaDiscovery","mqttDiscoveryPrefix","mqttNodeId"].includes(id)) return "mqtt";
        if(["timeEnable","timeTz","timeNtp1","timeNtp2","timeNtp3"].includes(id)) return "time";
        if(id === "apiBase") return "api";
      }
      return null;
    }
    function installPendingSaveTracking(){
      const mark = ev => {
        const group = saveGroupForUserEdit(ev.target);
        if(group) markPendingSaveDirty(group);
      };
      document.addEventListener("input", mark, true);
      document.addEventListener("change", mark, true);
      updatePendingSaveBar();
    }

    function setView(view){
      const currentView = getActiveView();
      const changing = currentView !== view;
      $$(".section").forEach(s => s.classList.remove("active"));
      $(`#view-${view}`).classList.add("active");

      const [t, st] = titles[view] || ["", ""];
      $("#tbTitle").textContent = t;
      $("#tbSubtitle").textContent = st;

      // desktop nav
      $$("#sideNav a").forEach(a => a.setAttribute("aria-current", a.dataset.view === view ? "page" : "false"));
      // mobile nav
      $$("#bottomNav button").forEach(b => b.setAttribute("aria-current", b.dataset.view === view ? "page" : "false"));
      // topbar actions (only on overview)
      const oa = document.getElementById("tbOverviewActions");
      if(oa) oa.style.display = (view === "overview") ? "flex" : "none";

      if(location.hash !== `#${view}`) location.hash = view;

      updatePendingSaveBar();
      try{ window.ThermaV5?.onView(view, state); }catch(_e){}
      thermaCloseMenus();
      const moreBtn=document.getElementById("btnMobileMore");
      if(moreBtn)moreBtn.setAttribute("aria-current",["accu","opentherm","thermometers","io","diag"].includes(view)?"page":"false");
      if(changing && window.scrollY>0)window.scrollTo({top:0,behavior:"instant"});
      if(changing) log(`view -> ${view}`);
      if(view === "opentherm") { void otScanRefresh(); void otProfileRefresh(); }
      if(view === "diag") { void mqttLoad({ silent:true }); }
      if(view === "thermometers" && !state.th?.loaded && !state.th?.načítání) { void thermoLoad({ silent:true }); }
      if(changing || view === "overview" || view === "heating" || view === "mixing") {
        queueRenderSample(getUiSample());
      }

    }

    // ----- Source selector
    // ----- Device mode (fixed)
function setSource(){
  state.source = "device";
  const el = document.getElementById("apiState");
  if(el) el.textContent = "API: zařízení";
}

function pageOriginBase(){
  return (/^https?:$/i.test(window.location.protocol || "")) ? window.location.origin : "";
}

function normalizedApiBase(){
  return String(state.apiBase || "").trim();
}

function syncApiBaseUi(){
  const baseEl = document.getElementById("apiBase");
  const baseLbl = document.getElementById("apiBaseLabel");
  const value = normalizedApiBase();
  if(baseEl && document.activeElement !== baseEl) baseEl.value = value;
  if(baseLbl) baseLbl.textContent = value || "/";
}

function maybeAdoptPageOriginBase(reason="runtime", silent=false){
  const pageBase = pageOriginBase();
  const current = normalizedApiBase();
  if(!pageBase || !current) return false;
  let currentOrigin = "";
  try{ currentOrigin = new URL(current, window.location.href).origin; }catch{ return false; }
  if(!currentOrigin || currentOrigin === pageBase) return false;
  state.apiBase = "";
  try{ localStorage.setItem("ui2026_apiBase", ""); }catch{}
  syncApiBaseUi();
  if(state.net) state.net.apiBaseFallbackUsed = true;
  log(`apiBase fallback -> same origin (${reason})`);
  if(!silent) toast("API", "Používám stejné origin zařízení místo uložené IP adresy.", "🔁");
  return true;
}


function computeOfflinePollMs(){
  const base = document.hidden ? 30000 : 10000;
  const backvypnuto = Number(state?.net?.nextPollMs ?? 10000);
  return Math.max(base, backvypnuto);
}

const mixWsPending = new Map();
let mixWsSeq = 0;

function settlePendingMixWsCommands(reason="socket_closed"){
  for(const [id, pending] of mixWsPending.entries()){
    clearTimeout(pending.timer);
    // The command may already have reached the controller. Resolve as pending
    // rather than issuing an HTTP fallback that could duplicate the action.
    pending.resolve({ ok:true, pending:true, id, reason });
  }
  mixWsPending.clear();
}

function sendMixCommandWs(action, pulseMs=0){
  const ws = ensureWsState();
  if(!ws.připojeno || !ws.sock || ws.sock.readyState !== WebSocket.OPEN){
    return Promise.reject(new Error("ws_unavailable"));
  }

  const id = ++mixWsSeq;
  const payload = { type:"mix_cmd", id, action:String(action || "") };
  if(Number(pulseMs) > 0) payload.pulseMs = Math.round(Number(pulseMs));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      mixWsPending.delete(id);
      // Never repeat a possibly applied actuator command over HTTP merely
      // because its acknowledgement was lost.
      resolve({ ok:true, pending:true, id, reason:"ack_timeout" });
    }, 1400);
    mixWsPending.set(id, { resolve, reject, timer });
    try{
      ws.sock.send(JSON.stringify(payload));
    }catch(e){
      clearTimeout(timer);
      mixWsPending.delete(id);
      reject(e);
    }
  });
}

function ensureWsState(){
  state.ws = state.ws || {};
  if(!Object.prototype.hasOwnProperty.call(state.ws, "sock")) state.ws.sock = null;
  if(typeof state.ws.připojeno !== "boolean") state.ws.připojeno = false;
  if(!Object.prototype.hasOwnProperty.call(state.ws, "retryTimer")) state.ws.retryTimer = null;
  if(!Number.isFinite(Number(state.ws.reconnectMs))) state.ws.reconnectMs = 2000;
  if(typeof state.ws.manualClose !== "boolean") state.ws.manualClose = false;
  if(!Number.isFinite(Number(state.ws.failCount))) state.ws.failCount = 0;
  if(!Number.isFinite(Number(state.ws.disabledUntilMs))) state.ws.disabledUntilMs = 0;
  if(!Number.isFinite(Number(state.ws.lastMessageMs))) state.ws.lastMessageMs = 0;
  if(!Number.isFinite(Number(state.ws.lastSeq))) state.ws.lastSeq = 0;
  if(!Object.prototype.hasOwnProperty.call(state.ws, "watchdogTimer")) state.ws.watchdogTimer = null;
  return state.ws;
}

function wsReconnectPaused(){
  const ws = ensureWsState();
  return Number(ws.disabledUntilMs || 0) > Date.now();
}

function wsPauseReconnect(ms=300000, reason=""){
  const ws = ensureWsState();
  ws.disabledUntilMs = Date.now() + Math.max(10000, Number(ms) || 300000);
  if(ws.retryTimer){
    clearTimeout(ws.retryTimer);
    ws.retryTimer = null;
  }
  startFallbackPolling(computeOfflinePollMs());
  setApiHealth("warn", "API: polling (WS pauza)");
  if(reason) log(`ws paused: ${reason}`);
}

function updateRefreshCadence(){
  if(state.ws?.připojeno){
    stopFallbackPolling();
    return;
  }
  startFallbackPolling(computeOfflinePollMs());
}

function wsIsAlive(){
  const sock = state.ws?.sock;
  if(!sock) return false;
  return sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING;
}

function stopWsWatchdog(){
  const ws = ensureWsState();
  if(ws.watchdogTimer){
    clearInterval(ws.watchdogTimer);
    ws.watchdogTimer = null;
  }
}

function startWsWatchdog(){
  const ws = ensureWsState();
  stopWsWatchdog();
  ws.watchdogTimer = setInterval(() => {
    const live = ensureWsState();
    if(!live.připojeno || !live.sock || document.hidden) return;
    const age = Date.now() - Number(live.lastMessageMs || 0);
    if(age > 12000){
      log(`ws watchdog: bez dat ${Math.round(age/1000)} s`);
      setApiHealth("warn", "API: WS bez dat, obnovuji…");
      try{ live.sock.close(4000, "stale"); }catch(_e){}
    }
  }, 4000);
}

function requestWsFullSync(reason="client") {
  const ws = ensureWsState();
  if(!ws.sock || ws.sock.readyState !== WebSocket.OPEN) return false;
  try{
    ws.sock.send(JSON.stringify({ type:"sync", reason, lastSeq:Number(ws.lastSeq || 0) }));
    return true;
  }catch(_e){
    return false;
  }
}

function handleVisibilityChange(){
  updateRefreshCadence();
  if(document.hidden) return;
  if(!wsIsAlive()) connectWs();
  else requestWsFullSync("visibility");
  if(!refreshing) void refresh(false);
}


    // ----- Logging
    function log(msg){
      const ts = new Date().toLocaleTimeString("cs-CZ");
      const pre = $("#log");
      pre.textContent = `[${ts}] ${msg}\n` + pre.textContent;
    }

    // ----- Sparklines
    function drawSpark(canvas, arr){
      const ctx = canvas.getContext("2d");
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0,0,w,h);

      // background grid
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--border");
      ctx.lineWidth = 1;
      for(let i=1;i<4;i++){
        const y = (h/4)*i;
        ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke();
      }
      ctx.globalAlpha = 1;

      if(!arr.length) return;
      const min = Math.min(...arr), max = Math.max(...arr);
      const span = (max - min) || 1;

      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--fg0");
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 2;
      ctx.beginPath();
      arr.forEach((v,i) => {
        const x = (i/(arr.length-1 || 1)) * (w-6) + 3;
        const y = h - (((v-min)/span) * (h-10) + 5);
        if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      });
      ctx.stroke();

      // endpoint dot
      const last = arr[arr.length-1];
      const x = (w-6)+3;
      const y = h - (((last-min)/span) * (h-10) + 5);
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--brand");
      ctx.globalAlpha = 0.95;
      ctx.beginPath(); ctx.arc(x,y,3.2,0,Math.PI*2); ctx.fill();
      ctx.globalAlpha = 1;
    }

    
        // ----- Equitherm curves (chart)
    // UI mirrors both firmware curve models: legacy 2-point (shown as
    // slope + shift) and TECH i-3 4-point (-20/-10/0/+10 °C). Both are
    // evaluated first and then clamped to the configured Min/Max flow limits.
    const eq = {
      xMin: -20, xMax: 20, // outdoor range
      yPad: 2,
      fitY: false,
    };

    function eqCurveFromPoints(pts){
      const x1 = Number(pts?.outColdC), y1 = Number(pts?.flowColdC);
      const x2 = Number(pts?.outWarmC), y2 = Number(pts?.flowWarmC);
      if(!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)){
        return { slope: NaN, shift: NaN };
      }
      const dx = x2 - x1;
      const lineSlope = (Math.abs(dx) < 1e-6) ? 0 : (y2 - y1) / dx;
      const slope = -lineSlope;
      const yAt20 = y1 + lineSlope * (20 - x1);
      const shift = yAt20 - 20;
      return { slope, shift };
    }

    function normalizeEqCurve(curveLike, fallback = null){
      if(curveLike && Number.isFinite(Number(curveLike.slope)) && Number.isFinite(Number(curveLike.shift))){
        return {
          slope: Math.abs(Number(curveLike.slope)),
          shift: Number(curveLike.shift),
        };
      }
      const derived = eqCurveFromPoints(curveLike);
      if(Number.isFinite(derived.slope) && Number.isFinite(derived.shift)){
        return {
          slope: Math.abs(Number(derived.slope)),
          shift: Number(derived.shift),
        };
      }
      if(fallback && Number.isFinite(Number(fallback.slope)) && Number.isFinite(Number(fallback.shift))){
        return {
          slope: Math.abs(Number(fallback.slope)),
          shift: Number(fallback.shift),
        };
      }
      return { slope: NaN, shift: NaN };
    }

    function normalizeEqLimits(limitsLike, fallback = null){
      const minCandidate = Number(limitsLike?.minFlowC);
      const maxCandidate = Number(limitsLike?.maxFlowC);
      const fbMin = Number(fallback?.minFlowC);
      const fbMax = Number(fallback?.maxFlowC);
      const minFlowC = Number.isFinite(minCandidate) ? minCandidate : (Number.isFinite(fbMin) ? fbMin : 22);
      const maxFlowC = Number.isFinite(maxCandidate) ? maxCandidate : (Number.isFinite(fbMax) ? fbMax : 60);
      return {
        minFlowC: Math.min(minFlowC, maxFlowC),
        maxFlowC: Math.max(minFlowC, maxFlowC),
      };
    }

    function normalizeEq4PointCurve(pointsLike, fallback = null){
      const raw = Array.isArray(pointsLike) ? pointsLike : null;
      const values = raw ? raw.slice(0, 4).map(Number) : [];
      if(values.length === 4 && values.every(Number.isFinite)){
        return { kind: "tech_i3_4point", points4: values };
      }
      if(fallback?.kind === "tech_i3_4point" && Array.isArray(fallback.points4)){
        const fb = fallback.points4.slice(0, 4).map(Number);
        if(fb.length === 4 && fb.every(Number.isFinite)) return { kind: "tech_i3_4point", points4: fb };
      }
      return null;
    }

    function buildEqChartConfigFromSource(cfg, fallback = null){
      if(!cfg) return null;
      const limits = normalizeEqLimits(cfg?.limits || cfg, fallback);
      const curveMode = String(cfg?.mixing?.curveMode ?? cfg?.curveMode ?? fallback?.curveMode ?? "linear2").toLowerCase();
      const weather4 = cfg?.mixing?.weather4 || cfg?.weather4 || null;
      if(curveMode === "tech_i3_4point"){
        const dayCurve = normalizeEq4PointCurve(weather4?.day ?? cfg?.dayCurve?.points4, fallback?.dayCurve);
        const nightCurve = normalizeEq4PointCurve(weather4?.night ?? cfg?.nightCurve?.points4, fallback?.nightCurve);
        if(dayCurve && nightCurve){
          return {
            curveMode,
            dayCurve,
            nightCurve,
            minFlowC: limits.minFlowC,
            maxFlowC: limits.maxFlowC,
          };
        }
      }

      const dayCurve = normalizeEqCurve(cfg?.dayCurve || cfg?.day, fallback?.dayCurve);
      const nightCurve = normalizeEqCurve(cfg?.nightCurve || cfg?.night, fallback?.nightCurve);
      if(!Number.isFinite(dayCurve.slope) || !Number.isFinite(dayCurve.shift)
        || !Number.isFinite(nightCurve.slope) || !Number.isFinite(nightCurve.shift)){
        return null;
      }
      return {
        curveMode: "linear2",
        dayCurve,
        nightCurve,
        minFlowC: limits.minFlowC,
        maxFlowC: limits.maxFlowC,
      };
    }

    function eqPointsFromCurve(curve){
      const slope = Number(curve?.slope);
      const shift = Number(curve?.shift);
      const safeSlope = Number.isFinite(slope) ? slope : 0;
      const safeShift = Number.isFinite(shift) ? shift : 0;
      return {
        outColdC: -20,
        flowColdC: (20 - (-20)) * safeSlope + 20 + safeShift,
        outWarmC: 20,
        flowWarmC: 20 + safeShift,
      };
    }

    function eqRawFromCurve(Tout, curve){
      if(curve?.kind === "tech_i3_4point" && Array.isArray(curve.points4)){
        const p = curve.points4.slice(0, 4).map(Number);
        if(p.length !== 4 || !p.every(Number.isFinite) || !Number.isFinite(Number(Tout))) return NaN;
        // Must stay byte-for-byte equivalent in behavior to firmware techI3Curve4():
        // linear interpolation between -20/-10/0/+10 °C and linear extrapolation
        // outside the end points using the nearest segment.
        const x = [-20, -10, 0, 10];
        const tOut = Number(Tout);
        let lo = 0, hi = 1;
        if(tOut >= 0){ lo = 2; hi = 3; }
        else if(tOut >= -10){ lo = 1; hi = 2; }
        const f = (tOut - x[lo]) / (x[hi] - x[lo]);
        return p[lo] + (p[hi] - p[lo]) * f;
      }
      const slope = Number(curve?.slope);
      const shift = Number(curve?.shift);
      if(!Number.isFinite(slope) || !Number.isFinite(shift)) return NaN;
      return (20 - Tout) * slope + 20 + shift;
    }

    function eqChFromCurve(Tout, curve, minFlowC, maxFlowC){
      const raw = eqRawFromCurve(Tout, curve);
      if(!Number.isFinite(raw)) return NaN;
      return clamp(raw, minFlowC, maxFlowC);
    }

    function roundRect(ctx, x, y, w, h, r){
      const rr = Math.max(0, Math.min(Number(r)||0, (w||0)/2, (h||0)/2));
      if(ctx.roundRect){
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, rr);
        return;
      }
      ctx.beginPath();
      ctx.moveTo(x+rr, y);
      ctx.arcTo(x+w, y, x+w, y+h, rr);
      ctx.arcTo(x+w, y+h, x, y+h, rr);
      ctx.arcTo(x, y+h, x, y, rr);
      ctx.arcTo(x, y, x+w, y, rr);
      ctx.closePath();
    }


    function drawEquithermChart(canvas, opts){
      if(!canvas) return;
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const cssW = canvas.clientWidth || 900;
      const cssH = canvas.clientHeight || 260;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);

      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr,0,0,dpr,0,0);

      const w = cssW, h = cssH;
      ctx.clearRect(0,0,w,h);

      const styles = getComputedStyle(document.documentElement);
      const border = styles.getPropertyValue("--border").trim() || "rgba(255,255,255,.14)";
      const fg0 = styles.getPropertyValue("--fg0").trim() || "rgba(255,255,255,.92)";
      const fg2 = styles.getPropertyValue("--fg2").trim() || "rgba(255,255,255,.55)";
      const bg1 = styles.getPropertyValue("--bg1").trim() || "rgba(255,255,255,.06)";
      const brand = styles.getPropertyValue("--brand").trim() || "#8b5cf6";
      const info = styles.getPropertyValue("--info").trim() || "#38bdf8";

      const padL = 46, padR = 12, padT = 10, padB = 34;
      const pw = w - padL - padR;
      const ph = h - padT - padB;

      const xMin = opts?.xMin ?? eq.xMin;
      const xMax = opts?.xMax ?? eq.xMax;

      const minFlowC = Number(opts.minFlowC);
      const maxFlowC = Number(opts.maxFlowC);
      const dayCurve = opts.dayCurve || null;
      const nightCurve = opts.nightCurve || null;

      let yMin = minFlowC, yMax = maxFlowC;
      if(eq.fitY || opts.fitY){
        const samples = [minFlowC, maxFlowC];
        for(let i=0;i<=40;i++){
          const x = xMin + (i/40)*(xMax-xMin);
          samples.push(eqRawFromCurve(x, dayCurve));
          samples.push(eqRawFromCurve(x, nightCurve));
        }
        const finite = samples.filter(Number.isFinite);
        yMin = (finite.length ? Math.min(...finite) : minFlowC) - eq.yPad;
        yMax = (finite.length ? Math.max(...finite) : maxFlowC) + eq.yPad;
      }else{
        yMin = minFlowC - eq.yPad;
        yMax = maxFlowC + eq.yPad;
      }
      const ySpan = (yMax - yMin) || 1;

      const xToPx = x => padL + ((x - xMin)/(xMax - xMin)) * pw;
      const yToPx = y => padT + (1 - (y - yMin)/ySpan) * ph;

      // background
      ctx.fillStyle = bg1;
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      roundRect(ctx, 0.5, 0.5, w-1, h-1, 14);
      ctx.fill();
      ctx.stroke();

      // grid
      ctx.save();
      ctx.strokeStyle = border;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      for(let x = Math.ceil(xMin/5)*5; x<=xMax; x+=5){
        const px = xToPx(x);
        ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT+ph); ctx.stroke();
      }
      for(let y = Math.ceil(yMin/5)*5; y<=yMax; y+=5){
        const py = yToPx(y);
        ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(padL+pw, py); ctx.stroke();
      }
      ctx.restore();

      // axes
      ctx.strokeStyle = border;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(padL, padT);
      ctx.lineTo(padL, padT+ph);
      ctx.lineTo(padL+pw, padT+ph);
      ctx.stroke();

      // ticks + labels
      ctx.fillStyle = fg2;
      ctx.font = "12px " + (styles.getPropertyValue("--mono").trim() || "ui-monospace");
      for(let x = Math.ceil(xMin/10)*10; x<=xMax; x+=10){
        const px = xToPx(x);
        ctx.fillText(`${x}`, px-6, padT+ph+18);
      }
      for(let y = Math.ceil(yMin/10)*10; y<=yMax; y+=10){
        const py = yToPx(y);
        ctx.fillText(`${y}`, 8, py+4);
      }
      ctx.fillStyle = fg2;
      ctx.font = "12px " + (styles.getPropertyValue("--sans").trim() || "system-ui");
      ctx.fillText("Venkovní teplota (°C)", padL + pw/2 - 70, h-8);
      ctx.save();
      ctx.translate(14, padT + ph/2 + 60);
      ctx.rotate(-Math.PI/2);
      ctx.fillText("Požadovaná teplota topné vody (°C)", 0, 0);
      ctx.restore();

      function strokeCurve(curve, color, alpha=0.85, mode="raw"){
        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        for(let i=0;i<=80;i++){
          const x = xMin + (i/80)*(xMax-xMin);
          const y = mode === "clamped"
            ? eqChFromCurve(x, curve, minFlowC, maxFlowC)
            : eqRawFromCurve(x, curve);
          const px = xToPx(x);
          const py = yToPx(y);
          if(i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
        }
        ctx.stroke();
        ctx.restore();
      }

      function strokeLimit(y, alpha=0.45){
        if(!Number.isFinite(y)) return;
        const py = yToPx(y);
        ctx.save();
        ctx.strokeStyle = border;
        ctx.globalAlpha = alpha;
        ctx.setLineDash([6,6]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, py);
        ctx.lineTo(padL + pw, py);
        ctx.stroke();
        ctx.restore();
      }

      strokeLimit(minFlowC, 0.35);
      strokeLimit(maxFlowC, 0.45);
      strokeCurve(dayCurve, fg0, 0.9, "raw");
      strokeCurve(nightCurve, info, 0.9, "raw");

      if(Number.isFinite(opts.outdoorNow)){
        const px = xToPx(opts.outdoorNow);
        ctx.save();
        ctx.strokeStyle = border;
        ctx.setLineDash([5,5]);
        ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT+ph); ctx.stroke();
        ctx.restore();
      }

      if(Number.isFinite(opts.pointX) && Number.isFinite(opts.pointY)){
        const px = xToPx(opts.pointX);
        const py = yToPx(opts.pointY);
        ctx.save();
        ctx.fillStyle = brand;
        ctx.globalAlpha = 0.18;
        ctx.beginPath(); ctx.arc(px, py, 10, 0, Math.PI*2); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(px, py, 4.2, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = fg0;
        ctx.font = "12px " + (styles.getPropertyValue("--mono").trim() || "ui-monospace");
        const label = `(${opts.pointX.toFixed(1)}°C, ${opts.pointY.toFixed(1)}°C)`;
        ctx.fillText(label, clamp(px+10, padL+6, padL+pw-120), clamp(py-10, padT+14, padT+ph-6));
        ctx.restore();
      }

      if(opts.swDay) opts.swDay.style.background = fg0;
      if(opts.swNight) opts.swNight.style.background = info;
      if(opts.swNow) opts.swNow.style.background = border;
    }

// ----- Schedules (multiple intervals per day)
    const daysCZ = ["Pondělí","Úterý","Středa","Čtvrtek","Pátek","Sobota","Neděle"];
const HEATING_MAX_INTERVALS_PER_DAY = 6;
const DHW_MAX_INTERVALS_PER_DAY = 8;

    function defaultSchedules(){
      return {
        heatingDay: [
          [{start:"06:00", end:"22:00"}],
          [{start:"06:00", end:"22:00"}],
          [{start:"06:00", end:"22:00"}],
          [{start:"06:00", end:"22:00"}],
          [{start:"06:00", end:"22:00"}],
          [{start:"08:00", end:"23:00"}],
          [{start:"08:00", end:"23:00"}],
        ],
        dhwHeat: [
          [{start:"05:30", end:"06:30"}],
          [{start:"05:30", end:"06:30"}],
          [{start:"05:30", end:"06:30"}],
          [{start:"05:30", end:"06:30"}],
          [{start:"05:30", end:"06:30"}],
          [{start:"07:00", end:"08:00"}],
          [{start:"07:00", end:"08:00"}],
        ],
        dhwCirc: [
          [{start:"06:00", end:"06:10"},{start:"18:00", end:"18:10"}],
          [{start:"06:00", end:"06:10"},{start:"18:00", end:"18:10"}],
          [{start:"06:00", end:"06:10"},{start:"18:00", end:"18:10"}],
          [{start:"06:00", end:"06:10"},{start:"18:00", end:"18:10"}],
          [{start:"06:00", end:"06:10"},{start:"18:00", end:"18:10"}],
          [{start:"08:00", end:"08:10"},{start:"20:00", end:"20:10"}],
          [{start:"08:00", end:"08:10"},{start:"20:00", end:"20:10"}],
        ],
      };
    }

    state.schedules = (() => {
      try{
        const raw = localStorage.getItem("ui2026_schedules");
        if(raw){
          const obj = JSON.parse(raw);
          if(obj && obj.heatingDay && obj.dhwHeat && obj.dhwCirc) return obj;
        }
      }catch{}
      return defaultSchedules();
    })()// Circulation pulse config (ON/OFF cycling during active schedule)
state.circPulse = (() => {
  try{
    const raw = localStorage.getItem("ui2026_circPulse");
    if(raw){
      const o = JSON.parse(raw);
      if(o && typeof o === "object"){
        return {
          enable: !!o.enable,
          onMin: Math.max(0, Number(o.onMin ?? 5)),
          vypnutoMin: Math.max(0, Number(o.vypnutoMin ?? 15)),
        };
      }
    }
  }catch{}
  return state.circPulse;
})();

function saveCircPulse(){
  localStorage.setItem("ui2026_circPulse", JSON.stringify(state.circPulse));
}

function circPulseIsOn(nowMs, intervalStartMin){
  if(!state.circPulse?.enable) return true;
  const on = Math.max(0, Number(state.circPulse.onMin ?? 0));
  const vypnuto = Math.max(0, Number(state.circPulse.vypnutoMin ?? 0));
  const cycle = on + vypnuto;
  if(cycle <= 0) return true;
  if(on <= 0) return false;
  const d = new Date(nowMs);
  const minsNow = d.getHours()*60 + d.getMinutes();
  let elapsed = minsNow - Number(intervalStartMin ?? minsNow);
  if(!Number.isFinite(elapsed)) elapsed = 0;
  if(elapsed < 0) elapsed += 1440;
  return (elapsed % cycle) < on;
};

    function saveSchedules(){
      localStorage.setItem("ui2026_schedules", JSON.stringify(state.schedules));
    }

    function timeToMin(hhmm){
      const m = /^(\d\d):(\d\d)$/.exec(hhmm || "");
      if(!m) return null;
      const hh = Number(m[1]), mm = Number(m[2]);
      if(hh<0||hh>23||mm<0||mm>59) return null;
      return hh*60+mm;
    }

    function isInIntervals(intervals, minutes){
      for(const it of (intervals||[])){
        const a = timeToMin(it.start), b = timeToMin(it.end);
        if(a===null || b===null) continue;
        if(a<=b){
          if(minutes>=a && minutes<b) return true;
        }else{
          if(minutes>=a || minutes<b) return true;
        }
      }
      return false;
    }

    function nowDayIndex(){
      const d = new Date();
      const js = d.getDay(); // 0=Sun
      return (js + 6) % 7;
    }

    function scheduleNow(){
      const d = new Date();
      const mins = d.getHours()*60 + d.getMinutes();
      const di = nowDayIndex();

      const dayActive = isInIntervals(state.schedules.heatingDay[di], mins);
      const dhwActive = isInIntervals(state.schedules.dhwHeat[di], mins);
      const circIntervals = state.schedules.dhwCirc[di] || [];
      const circPlanActive = isInIntervals(circIntervals, mins);
      let circIntervalStart = null;
      for(const it of circIntervals){
        const a = timeToMin(it.start), b = timeToMin(it.end);
        if(a===null || b===null) continue;
        if((a <= b && mins >= a && mins < b) || (a > b && (mins >= a || mins < b))){ circIntervalStart = a; break; }
      }
      const nowMs = d.getTime();
      const circInputActive = !!state.io.inputs?.[2];
      const circRequested = circPlanActive || circInputActive;
      const pulseAnchorStart = circPlanActive ? circIntervalStart : 0;
      const circPulseOn = circRequested ? (state.circPulse?.enable ? circPulseIsOn(nowMs, pulseAnchorStart) : true) : false;
      const circActive = circRequested && (state.circPulse?.enable ? circPulseOn : true);
      return { dayActive, dhwActive, circActive, circRequested, circInputActive, circPlanActive, circPulseOn, circIntervalStart, mins, di };
    }

    
    // Nest-like planner UI (multiple intervals/day)
    state.uiPlannerDay = state.uiPlannerDay || {};

    function summarizeIntervals(intervals){
      const arr = (intervals||[]).filter(it => it?.start && it?.end);
      if(!arr.length) return "bez intervalů";
      return arr.map(it => `${it.start}–${it.end}`).join(" • ");
    }

    function normIntervals(list){
      // Keep valid HH:MM, drop invalid
      const out = [];
      for(const it of (list||[])){
        const a = timeToMin(it.start);
        const b = timeToMin(it.end);
        if(a===null || b===null) continue;
        out.push({start: it.start, end: it.end});
      }
      return out;
    }

    function splitOvernight(it){
      const a = timeToMin(it.start), b = timeToMin(it.end);
      if(a===null || b===null) return [];
      if(a<=b) return [{a,b,label:`${it.start}–${it.end}`}];
      // overnight -> split
      return [
        {a, b: 1440, label:`${it.start}–24:00`},
        {a: 0, b, label:`00:00–${it.end}`},
      ];
    }

    function plannerTypeClass(key){
      if(key==="heatingDay") return "heat";
      if(key==="dhwHeat") return "dhw";
      if(key==="dhwCirc") return "circ";
      return "heat";
    }

    function plannerTitle(key){
      if(key==="heatingDay") return "Plán Komfort (mimo interval = Útlum)";
      if(key==="dhwHeat") return "Plán ohřevu TUV";
      if(key==="dhwCirc") return "Plán cirkulace TUV";
      return "Plán";
    }

    function plannerAllowsMultiple(key){
      return true;
    }

    function plannerAllowsOvernight(key){
      return key !== "heatingDay";
    }

    function plannerValidateInterval(key, start, end){
      const a = timeToMin(start), b = timeToMin(end);
      if(a===null || b===null) return { ok:false, msg:"Neplatný čas." };
      if(a===b) return { ok:false, msg:"Začátek a konec nesmí být stejné." };
      if(!plannerAllowsOvernight(key) && a > b) return { ok:false, msg:"Topení nepodporuje interval přes půlnoc." };
      return { ok:true };
    }

    function serializeDhwWeek(key, maxIntervals=DHW_MAX_INTERVALS_PER_DAY){
      return ["mon","tue","wed","thu","fri","sat","sun"].map((day, i) => {
        const arr = normIntervals(state.schedules?.[key]?.[i] || []);
        if(arr.length > maxIntervals) throw new Error(`${key} den ${i+1}: maximum je ${maxIntervals} intervalů.`);
        if(intervalsOverlap(arr)) throw new Error(`${key} den ${i+1}: intervaly se překrývají.`);
        return {
          day,
          intervals: arr.map(iv => ({ startMin: timeToMin(iv.start), endMin: timeToMin(iv.end) }))
            .filter(iv => Number.isFinite(iv.startMin) && Number.isFinite(iv.endMin) && iv.startMin !== iv.endMin)
        };
      });
    }


    function overviewPlanWhen(dateLike, nowLike=new Date()){
      const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
      const now = nowLike instanceof Date ? nowLike : new Date(nowLike);
      if(!Number.isFinite(d.getTime())) return "--";
      const time = d.toLocaleTimeString("cs-CZ", {hour:"2-digit", minute:"2-digit"});
      const d0 = new Date(d); d0.setHours(0,0,0,0);
      const n0 = new Date(now); n0.setHours(0,0,0,0);
      const dayDiff = Math.round((d0.getTime() - n0.getTime()) / 86400000);
      if(dayDiff === 0) return `dnes ${time}`;
      if(dayDiff === 1) return `zítra ${time}`;
      const day = daysCZ[(d.getDay()+6)%7] || d.toLocaleDateString("cs-CZ", {weekday:"short"});
      return `${day.toLowerCase()} ${time}`;
    }

    function findNextOverviewScheduleEvent(nowLike=new Date()){
      const now = nowLike instanceof Date ? new Date(nowLike) : new Date(nowLike);
      if(!Number.isFinite(now.getTime())) return null;
      const midnight = new Date(now); midnight.setHours(0,0,0,0);
      const today = (now.getDay()+6)%7;
      const defs = [
        { key:"heatingDay", start:"Topení → Komfort", end:"Topení → Útlum", kind:"heat" },
        { key:"dhwHeat", start:"Spuštění plánu TUV", end:"Konec plánu TUV", kind:"dhw" },
        { key:"dhwCirc", start:"Spuštění cirkulace", end:"Konec cirkulace", kind:"circ" },
      ];
      const events = [];
      for(let offset=-1; offset<=7; offset++){
        const di = (today + offset + 7) % 7;
        const baseMs = midnight.getTime() + offset * 86400000;
        for(const def of defs){
          const intervals = state.schedules?.[def.key]?.[di] || [];
          for(const it of intervals){
            const startMin = timeToMin(it?.start);
            const endMin = timeToMin(it?.end);
            if(startMin === null || endMin === null || startMin === endMin) continue;
            const startMs = baseMs + startMin * 60000;
            const endMs = baseMs + endMin * 60000 + (endMin <= startMin ? 86400000 : 0);
            if(startMs > now.getTime() + 1000) events.push({ at:new Date(startMs), label:def.start, kind:def.kind });
            if(endMs > now.getTime() + 1000) events.push({ at:new Date(endMs), label:def.end, kind:def.kind });
          }
        }
      }
      events.sort((a,b) => a.at - b.at);
      return events[0] || null;
    }

    function resolveOverviewCircState(){
      const dhwf = state.dhwFast || {};
      const status = state.dhwStatus || {};
      if(Object.prototype.hasOwnProperty.call(dhwf, "rr")){
        return { on:!!dhwf.rr, source:"stav relé z backendu" };
      }
      if(typeof status.circRelayOn === "boolean"){
        return { on:!!status.circRelayOn, source:"stav relé z backendu" };
      }
      if(Object.prototype.hasOwnProperty.call(dhwf, "ca")){
        return { on:!!dhwf.ca, source:"stav řízení cirkulace" };
      }
      if(typeof status.circActive === "boolean"){
        return { on:!!status.circActive, source:"stav řízení cirkulace" };
      }
      const relayNo = Math.max(1, Math.min(8, Number(state.dev?.dhwCfgRaw?.circ?.relay ?? document.getElementById("dhwCircRelay")?.value ?? 4) || 4));
      if(Array.isArray(state.io?.relays) && state.io.relays.length >= relayNo){
        return { on:!!state.io.relays[relayNo-1], source:`Relé${relayNo}` };
      }
      const fallback = scheduleNow();
      return { on:!!fallback.circActive, source:"odhad podle plánu" };
    }

    function setOverviewPlanChip(id, text, kind=""){
      const el = document.getElementById(id);
      if(!el) return;
      el.classList.remove("active","warn");
      if(kind) el.classList.add(kind);
      const tx = el.querySelector("span");
      if(tx) tx.textContent = text;
    }

    function renderOverviewPlanAndCirc(){
      const root = document.getElementById("view-overview");
      if(!root) return;
      const s = scheduleNow();
      const eqf = state.eqFast || {};
      const dhwf = state.dhwFast || {};
      const dhws = state.dhwStatus || {};

      const effMode = String(eqf.me || state.eqStatus?.mode?.eff || (s.dayActive ? "day" : "night")).toLowerCase();
      const heatComfort = effMode !== "night";
      const dhwScheduleActive = !!(dhwf.hs ?? dhws.heatScheduleActive ?? s.dhwActive);
      const dhwInputActive = !!(dhwf.hi ?? dhws.heatInputActive ?? state.io.inputs?.[1]);
      const dhwRequested = !!(dhwf.hr ?? dhws.heatRequested ?? (dhwScheduleActive || dhwInputActive));
      const circScheduleActive = !!(dhwf.cs ?? dhws.circScheduleActive ?? s.circPlanActive);
      const circInputActive = !!(dhwf.ci ?? dhws.circInputActive ?? s.circInputActive);
      const circ = resolveOverviewCircState();

      setText("#ovPlanNowTitle", `Topení: ${heatComfort ? "Komfort" : "Útlum"}`);
      const dhwNowText = dhwRequested ? (dhwScheduleActive ? "TUV plán aktivní" : (dhwInputActive ? "TUV přes IN2" : "TUV požadavek")) : "TUV bez požadavku";
      const circNowText = circ.on ? "cirkulace ON" : (circScheduleActive || circInputActive ? "cirkulace čeká / pulzuje" : "cirkulace OFF");
      setText("#ovPlanNowMeta", `${dhwNowText} • ${circNowText}`);

      const next = findNextOverviewScheduleEvent(new Date());
      setText("#ovPlanNextTitle", next ? next.label : "Bez další naplánované změny");
      setText("#ovPlanNextMeta", next ? overviewPlanWhen(next.at, new Date()) : "v následujících 7 dnech");

      setOverviewPlanChip("ovPlanHeat", `Topení: ${heatComfort ? "Komfort" : "Útlum"}`, heatComfort ? "active" : "warn");
      setOverviewPlanChip("ovPlanDhw", dhwRequested ? (dhwScheduleActive ? "TUV: plán ON" : "TUV: požadavek") : "TUV: OFF", dhwRequested ? "active" : "");
      setOverviewPlanChip("ovPlanCirc", `Cirk.: ${circ.on ? "ON" : "OFF"}`, circ.on ? "active" : ((circScheduleActive || circInputActive) ? "warn" : ""));

      const diagram = document.getElementById("ovCircDiagram");
      if(diagram) diagram.dataset.state = circ.on ? "on" : "off";
      setText("#ovCircState", circ.on ? "ON" : "OFF");
      const circSource = circScheduleActive ? "plán" : (circInputActive ? "IN3" : circ.source);
      setText("#ovCircSource", circSource || "stav výstupu");
      setBadge("#ovCircBadge", circ.on ? "good" : ((circScheduleActive || circInputActive) ? "warn" : ""), `cirkulace: ${circ.on ? "ON" : "OFF"}`);
    }

    function updatePlannerStateBadges(){
      try{
        renderOverviewPlanAndCirc();
        const s = scheduleNow();
        const dhwf = state.dhwFast || {};
        const eqf = state.eqFast || {};

        const heatDayActive = String(eqf.me || state.eqStatus?.mode?.eff || "day").toLowerCase() !== "night";
        const heatSource = eqf.i1 ? "IN1" : (eqf.su ? "plán" : (String(eqf.m || state.eqStatus?.mode?.req || "auto").toLowerCase() === "auto" ? "auto" : "ručně"));

        const dhwScheduleActive = !!(dhwf.hs ?? state.dhwStatus?.heatScheduleActive ?? s.dhwActive);
        const dhwInputActive = !!(dhwf.hi ?? state.dhwStatus?.heatInputActive ?? state.io.inputs?.[1]);
        const dhwRequested = !!(dhwf.hr ?? state.dhwStatus?.heatRequested ?? (dhwScheduleActive || dhwInputActive));

        const circRequested = !!(dhwf.cr ?? state.dhwStatus?.circRequested ?? s.circRequested);
        const circActive = !!(dhwf.ca ?? state.dhwStatus?.circActive ?? s.circActive);
        const circPlanActive = !!(dhwf.cs ?? state.dhwStatus?.circScheduleActive ?? s.circPlanActive);
        const circInputActive = !!(dhwf.ci ?? state.dhwStatus?.circInputActive ?? s.circInputActive);
        const circPulseOn = !!(dhwf.cp ?? state.dhwStatus?.circPulseOn ?? s.circPulseOn);
        const pulseEnabled = !!(state.dhwCfg?.circ?.pulseEnabled ?? state.circPulse?.enable);

        setBadge("#plStateHeat", heatDayActive ? "good" : "warn", "teď: " + (heatDayActive ? "KOMFORT" : "ÚTLUM") + ` • ${heatSource}`);
        const dhwTxt = dhwRequested
          ? (dhwScheduleActive ? "ohřev: aktivní plán" : (dhwInputActive ? "ohřev: aktivní vstup IN2" : "ohřev: požadavek aktivní"))
          : "ohřev: neaktivní";
        setBadge("#plStateDhw", dhwRequested ? "good" : "", dhwTxt);
        setBadge("#plStateCirc", circRequested ? "good" : "", "cirkulace: " + (circRequested ? "požadavek aktivní" : "bez požadavku"));
        setBadge("#dhwPlanNow", dhwScheduleActive ? "good" : (dhwInputActive ? "warn" : ""), dhwScheduleActive ? "ohřev: aktivní plán" : (dhwInputActive ? "ohřev: aktivní vstup IN2" : "ohřev: neaktivní"));
        setBadge("#circPlanNow", circPlanActive ? "good" : (circInputActive ? "warn" : ""), circPlanActive ? "cirkulace: aktivní plán" : (circInputActive ? "cirkulace: aktivní vstup IN3" : "cirkulace: neaktivní"));

        let pulseTxt = "cyklus: bez požadavku";
        let pulseCls = "";
        if(circRequested){
          if(pulseEnabled){
            pulseTxt = "cyklus: " + (circPulseOn ? "ON" : "OFF");
            pulseCls = circPulseOn ? "good" : "warn";
          }else{
            pulseTxt = "cyklus: kontinuálně";
            pulseCls = circActive ? "good" : "";
          }
        }
        setBadge("#circPulseNow", pulseCls, pulseTxt);
      }catch(e){
        console.warn("planner badge update failed", e);
      }
    }


    function intervalsOverlap(list){
      const parts = [];
      for(const it of (list||[])) parts.push(...splitOvernight(it));
      parts.sort((x,y)=>x.a-y.a || x.b-y.b);
      for(let i=1;i<parts.length;i++){ if(parts[i].a < parts[i-1].b) return true; }
      return false;
    }

    function renderPlanner(key){
      const host = document.getElementById("planner-" + key);
      if(!host) return;

      const typeCls = plannerTypeClass(key);
      const sched = state.schedules[key];

      const today = nowDayIndex();
      const selected = (state.uiPlannerDay[key] ?? today);
      state.uiPlannerDay[key] = selected;

      host.innerHTML = "";

      const wrap = document.createElement("div");
      wrap.className = "plannerN";

      // Left: day list
      const days = document.createElement("div");
      days.className = "pDays";
      for(let d=0; d<7; d++){
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "pDayBtn";
        btn.setAttribute("aria-selected", d===selected ? "true" : "false");
        const sum = summarizeIntervals(sched[d]);
        btn.innerHTML = `
          <span class="l">
            <strong>${escapeHtml(daysCZ[d])}</strong>
            <span>${escapeHtml(sum)}</span>
          </span>
          <span class="r">${(sched[d]||[]).length}×</span>
        `;
        btn.addEventListener("click", () => {
          state.uiPlannerDay[key] = d;
          renderPlanner(key);
        });
        days.appendChild(btn);
      }

      // Right: main timeline + editor
      const main = document.createElement("div");
      main.className = "pMain";

      const top = document.createElement("div");
      top.className = "pTop";
      top.innerHTML = `
        <div class="t">
          <strong>${escapeHtml(plannerTitle(key))} — ${escapeHtml(daysCZ[selected])}</strong>
          <span>Časová osa 0–24 h • klikni na blok pro úpravu</span>
        </div>
        <div class="a">
          <button class="btn" type="button" id="pAdd_${key}" ${(!plannerAllowsMultiple(key) && (sched[selected]||[]).length >= 1) ? "disabled" : ""}>＋ Přidat</button>
          <span class="pHint">${escapeHtml(key==="heatingDay" ? "až 6 intervalů/den, bez přesahu přes půlnoc" : "Intervaly → požadavek aktivní")}</span>
        </div>
      `;
      main.appendChild(top);

      // timeline
      const tl = document.createElement("div");
      tl.className = "pTimeline";
      const ticks = document.createElement("div");
      ticks.className = "pTicks";
      // 0, 6, 12, 18, 24
      [0,6,12,18,24].forEach(h => {
        const t = document.createElement("div");
        t.className = "pTick";
        t.style.left = `calc(${(h/24)*100}% )`;
        t.textContent = (h===24 ? "24" : String(h));
        ticks.appendChild(t);
      });
      const blocks = document.createElement("div");
      blocks.className = "pBlocks";
      tl.appendChild(ticks);
      tl.appendChild(blocks);
      main.appendChild(tl);

      const editor = document.createElement("div");
      editor.className = "pEditor";
      editor.style.display = "none";
      main.appendChild(editor);

      const list = document.createElement("div");
      list.className = "pList";
      main.appendChild(list);

      wrap.appendChild(days);
      wrap.appendChild(main);
      host.appendChild(wrap);

      function refreshDay(){
        // normalize
        sched[selected] = normIntervals(sched[selected]);
        saveSchedules();

        // blocks
        blocks.innerHTML = "";
        const dayInts = sched[selected] || [];
        dayInts.forEach((it, idx) => {
          const parts = splitOvernight(it);
          parts.forEach(p => {
            const left = (p.a/1440)*100;
            const width = ((p.b - p.a)/1440)*100;
            const b = document.createElement("div");
            b.className = `pBlock ${typeCls}`;
            b.style.left = `calc(${left}% + 0px)`;
            b.style.width = `calc(${width}% - 2px)`;
            b.innerHTML = `<span class="txt">${escapeHtml(p.label)}</span><span class="ic">✎</span>`;
            b.title = `${it.start}–${it.end}`;
            b.addEventListener("click", () => openEditor(idx));
            blocks.appendChild(b);
          });
        });

        // list
        list.innerHTML = "";
        dayInts.forEach((it, idx) => {
          const row = document.createElement("div");
          row.className = "pItem";
          row.innerHTML = `
            <div class="l">
              <strong>${escapeHtml(it.start)}–${escapeHtml(it.end)}</strong>
              <span>${escapeHtml(key==="heatingDay" ? "Komfort" : "Aktivní")}</span>
            </div>
            <div class="r">
              <button class="btn" type="button" data-edit="${idx}">Upravit</button>
              <button class="btn danger" type="button" data-del="${idx}">Smazat</button>
            </div>
          `;
          row.querySelector("[data-edit]").addEventListener("click", () => openEditor(idx));
          row.querySelector("[data-del]").addEventListener("click", () => {
            sched[selected].splice(idx,1);
            markPendingSaveDirty(key === "heatingDay" ? "heatPlan" : "dhwPlan");
            saveSchedules();
            updatePlannerStateBadges();
            refreshDay();
            toast("Plán", `${daysCZ[selected]}: interval smazán.`, "🗑");
          });
          list.appendChild(row);
        });

        // update day summaries on left
        Array.from(days.children).forEach((btn, d) => {
          btn.setAttribute("aria-selected", d===selected ? "true":"false");
          const sum = summarizeIntervals(sched[d]);
          btn.querySelector(".l span").textContent = sum;
          btn.querySelector(".r").textContent = `${(sched[d]||[]).length}×`;
        });

        updatePlannerStateBadges();
      }

      function openEditor(idx){
        const it = sched[selected][idx];
        editor.style.display = "grid";
        editor.innerHTML = `
          <div class="row">
            <strong>Upravit interval</strong>
            <span class="badge"><span class="b"></span>${escapeHtml(daysCZ[selected])}</span>
          </div>
          <div class="pRowMini">
            <div class="field">
              <label>Od</label>
              <input type="time" id="pStart_${key}" value="${escapeHtml(it.start)}">
            </div>
            <div class="field">
              <label>Do</label>
              <input type="time" id="pEnd_${key}" value="${escapeHtml(it.end)}">
            </div>
            <button class="btn" type="button" id="pSave_${key}">Uložit</button>
            <button class="btn" type="button" id="pClose_${key}">Zavřít</button>
            <button class="btn danger" type="button" id="pDelete_${key}">Smazat</button>
          </div>
          <div class="muted">${escapeHtml(plannerAllowsOvernight(key) ? "Pozn.: Interval přes půlnoc se automaticky rozkreslí na dvě části." : "Pozn.: U topení je povoleno až 6 intervalů/den bez přesahu přes půlnoc.")}</div>
        `;

        const sEl = document.getElementById(`pStart_${key}`);
        const eEl = document.getElementById(`pEnd_${key}`);

        document.getElementById(`pSave_${key}`).addEventListener("click", () => {
          const ns = sEl.value, ne = eEl.value;
          const chk = plannerValidateInterval(key, ns, ne);
          if(!chk.ok){
            toast("Plán", chk.msg, "⚠");
            return;
          }
          const next = [...sched[selected]];
          next[idx] = {start: ns, end: ne};
          if(key === "heatingDay" && next.length > HEATING_MAX_INTERVALS_PER_DAY){ toast("Plán topení", `Maximálně ${HEATING_MAX_INTERVALS_PER_DAY} intervalů za den.`, "⚠"); return; }
          if(intervalsOverlap(next)){ toast("Plán", "Intervaly se překrývají.", "⚠"); return; }
          sched[selected] = next;
          markPendingSaveDirty(key === "heatingDay" ? "heatPlan" : "dhwPlan");
          saveSchedules();
          refreshDay();
          toast("Plán", "Uloženo.", "✅");
          log(`planner edit: ${key} day=${selected} idx=${idx}`);
        });
        document.getElementById(`pClose_${key}`).addEventListener("click", () => {
          editor.style.display = "none";
        });
        document.getElementById(`pDelete_${key}`).addEventListener("click", () => {
          sched[selected].splice(idx,1);
          markPendingSaveDirty(key === "heatingDay" ? "heatPlan" : "dhwPlan");
          saveSchedules();
          editor.style.display = "none";
          refreshDay();
          toast("Plán", "Interval smazán.", "🗑");
        });
      }

      document.getElementById(`pAdd_${key}`).addEventListener("click", () => {
        sched[selected] = sched[selected] || [];
        if(!plannerAllowsMultiple(key) && sched[selected].length >= 1){
          toast("Plán topení", `Maximálně ${HEATING_MAX_INTERVALS_PER_DAY} intervalů za den.`, "⚠");
          return;
        }
        if(key === "heatingDay" && sched[selected].length >= HEATING_MAX_INTERVALS_PER_DAY){ toast("Plán topení", `Maximálně ${HEATING_MAX_INTERVALS_PER_DAY} intervalů za den.`, "⚠"); return; }
        const next = [...sched[selected], {start:"06:00", end:"07:00"}];
        if(intervalsOverlap(next)){ toast("Plán", "Nový interval se překrývá se stávajícím.", "⚠"); return; }
        sched[selected] = next;
        markPendingSaveDirty(key === "heatingDay" ? "heatPlan" : "dhwPlan");
        saveSchedules();
        refreshDay();
        toast("Plán", `${daysCZ[selected]}: přidán interval.`, "🗓");
        log(`planner add: ${key} day=${selected}`);
      });

      refreshDay();
    }


        // ----- Thermometers (DEVICE)
const dallasRoleMetaDefault = [
  { key:"dhw_tank",    name:"Zásobník TUV",    note:"náhradní režim při neplatné OT TUV" },
  { key:"mix_a",       name:"Směšovací ventil A",  note:"GPIO0 • teplá větev A" },
  { key:"mix_b",       name:"Směšovací ventil B",  note:"GPIO0 • studená / vratná větev B" },
  { key:"mix_ab",      name:"Směšovací ventil AB", note:"GPIO0 • smíšený výstup / regulační feedback" },
  { key:"tank_top",    name:"AKU nahoře",      note:"nádrž" },
  { key:"tank_mid",    name:"AKU uprostřed",   note:"nádrž" },
  { key:"tank_bottom", name:"AKU dole",        note:"nádrž" },
  { key:"return",      name:"Zpátečka",        note:"GPIO2 • ReturnTempC / Return.flow / Return" },
  { key:"dhw_return",  name:"Zpátečka TUV",    note:"okruh TUV" },
];

const mixTempSourceMetaAll = [
  { key:"none", label:"Nevybráno" },
  { key:"mix_a_dallas", label:"DS18B20 – směšovací ventil A (GPIO0)" },
  { key:"mix_b_dallas", label:"DS18B20 – směšovací ventil B (GPIO0)" },
  { key:"mix_ab_dallas", label:"DS18B20 – směšovací ventil AB (GPIO0)" },
  { key:"tank_top", label:"DS18B20 – AKU nahoře" },
  { key:"tank_mid", label:"DS18B20 – AKU uprostřed" },
  { key:"tank_bottom", label:"DS18B20 – AKU dole" },
  { key:"dhw_tank", label:"TUV zásobník – role (OpenTherm / DS18B20)" },
  { key:"dhw_return", label:"DS18B20 – zpátečka cirkulace TUV (GPIO1)" },
  { key:"outside", label:"Venkovní teplota – role (OpenTherm / BLE)" },
  { key:"return_dallas", label:"DS18B20 – role Zpátečka / Return.flow (GPIO2)" },
  { key:"opentherm_ch", label:"OpenTherm – výstup kotle / CH (ID25)" },
  { key:"opentherm_return", label:"OpenTherm – zpátečka kotle (ID28)" },
];
const mixTempSourceMetaDefault = {
  a: mixTempSourceMetaAll,
  b: mixTempSourceMetaAll,
  ab: mixTempSourceMetaAll,
  tank: mixTempSourceMetaAll,
};

state.th = {
  loaded:false, načítání:false, cfgLoaded:false, dallasEnabled:false,
  roles:{}, roleGpio:{}, roleMeta:[...dallasRoleMetaDefault], roleState:{}, ds:[],
  mixingValve:{ a:"mix_a_dallas", b:"mix_b_dallas", ab:"mix_ab_dallas", tank:"tank_top" },
  mixingSourceMeta:normalizeMixTempSourceMeta(null), mixingPortState:{},
  ble:null, bleCfg:{enabled:false,namePrefix:"ESP-Meteostanice",scanIntervalMs:10000}, lastError:""
};

function thBadge(kind, text){
  const b = document.getElementById("thCfgState");
  if(!b) return;
  b.classList.remove("good","warn","bad");
  if(kind) b.classList.add(kind);
  b.childNodes.forEach(n=>{ if(n.nodeType===3) n.remove(); });
  b.appendChild(document.createTextNode(" " + text));
}

function flattenDallas(dallasStatus){
  const out = { ds: [], roleGpio: {}, roleState: {}, mixingPortState: {} };
  const roles = (dallasStatus && typeof dallasStatus === "object" && dallasStatus.dallas && typeof dallasStatus.dallas.roles === "object")
    ? dallasStatus.dallas.roles
    : {};
  Object.keys(roles).forEach(k => {
    const role = roles?.[k] || {};
    const g = numOrNaN(role?.gpio);
    if(Number.isFinite(g)) out.roleGpio[k] = Number(g);
    out.roleState[k] = {
      currentC: numOrNaN(role?.currentC),
      currentSrc: readMaybeString(role, "currentSrc", ""),
      resolvedRom: readMaybeString(role, "resolvedRom", ""),
      resolvedGpio: Number.isFinite(numOrNaN(role?.resolvedGpio)) ? Number(role.resolvedGpio) : (Number.isFinite(g) ? Number(g) : NaN),
      ageMs: Number(role?.ageMs || 0),
    };
  });

  const mixPorts = Array.isArray(dallasStatus?.dallas?.mixingValve?.ports) ? dallasStatus.dallas.mixingValve.ports : [];
  for(const port of mixPorts){
    const key = String(port?.port || "").trim().toLowerCase();
    if(!key) continue;
    out.mixingPortState[key] = {
      source: String(port?.source || ""),
      currentC: numOrNaN(port?.currentC),
      currentSrc: String(port?.currentSrc || ""),
      ageMs: Number(port?.ageMs || 0),
      gpio: numOrNaN(port?.gpio),
      rom: String(port?.rom || ""),
    };
  }

  const buses = Array.isArray(dallasStatus?.dallas?.buses) ? dallasStatus.dallas.buses : [];
  for(const b of buses){
    const gpio = Number(b?.gpio);
    const devs = Array.isArray(b?.devs) ? b.devs : [];
    for(const d of devs){
      out.ds.push({ gpio, rom:String(d?.rom||""), c:(d?.c==null?null:Number(d.c)), ok:!!d?.ok });
    }
  }
  return out;
}

function normalizeDallasRoleMeta(availableRoles){
  if(!Array.isArray(availableRoles) || !availableRoles.length) return [...dallasRoleMetaDefault];
  const defaults = Object.fromEntries(dallasRoleMetaDefault.map(item => [item.key, item]));
  const out = [];
  for(const r of availableRoles){
    const key = String(r?.key || "").trim();
    if(!key) continue;
    const base = defaults[key] || {};
    const label = String(r?.label || base.name || key).trim() || key;
    const gpio = Number(r?.gpio);
    let note = String(base.note || "").trim();
    if(Number.isFinite(gpio) && !new RegExp(`\bGPIO${gpio}\b`, "i").test(note)){
      note = [note, `GPIO${gpio}`].filter(Boolean).join(" • ");
    }
    out.push({ key, name: label, note });
  }
  return out.length ? out : [...dallasRoleMetaDefault];
}

function normalizeMixSourceOptionList(list, fallback){
  if(!Array.isArray(list) || !list.length) return fallback.map(item => ({...item}));
  const out = [];
  const seen = new Set();
  for(const item of list){
    const key = String(item?.key || "").trim();
    if(!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label:String(item?.label || key).trim() || key });
  }
  return out.length ? out : fallback.map(item => ({...item}));
}

function normalizeMixTempSourceMeta(availableSources){
  const src = (availableSources && typeof availableSources === "object") ? availableSources : {};
  return {
    a: normalizeMixSourceOptionList(src.a, mixTempSourceMetaDefault.a),
    b: normalizeMixSourceOptionList(src.b, mixTempSourceMetaDefault.b),
    ab: normalizeMixSourceOptionList(src.ab, mixTempSourceMetaDefault.ab),
    tank: normalizeMixSourceOptionList(src.tank, mixTempSourceMetaDefault.tank),
  };
}

function normalizeMixingValveSources(raw){
  const src = (raw && typeof raw === "object") ? raw : {};
  return {
    a: String(src.a || src.sourceA || "mix_a_dallas").trim() || "mix_a_dallas",
    b: String(src.b || src.sourceB || "mix_b_dallas").trim() || "mix_b_dallas",
    ab: String(src.ab || src.sourceAB || "mix_ab_dallas").trim() || "mix_ab_dallas",
    tank: String(src.tank || src.sourceTank || "tank_top").trim() || "tank_top",
  };
}

function roleTempKey(role){
  return role === "dhw_tank" ? "dhw" : role;
}

function roleValueFromFast(role, temps = state.fast?.temps){
  if(!temps || typeof temps !== "object") return NaN;
  if(role === "return") return firstFinite(state.eqFast?.mb, temps.returnDallasC, temps.return, temps.returnTempC);
  if(role === "dhw_tank") return firstFinite(temps.dhw_tank, temps.dhw);
  return numOrNaN(temps[roleTempKey(role)]);
}

function roleSourceFromFast(role, temps = state.fast?.temps){
  if(!temps || typeof temps !== "object") return "";
  if(role === "return"){
    return readMaybeString(temps, "returnDallasSrc",
      readMaybeString(temps, "returnSrc",
        readMaybeString(temps, "returnTempSrc", "")));
  }
  if(role === "dhw_tank") return readMaybeString(temps, "dhw_tankSrc", readMaybeString(temps, "dhwSrc", ""));
  const key = roleTempKey(role);
  return readMaybeString(temps, key + "Src", "");
}

function roleResolvedRomFromFast(role, temps = state.fast?.temps){
  const roms = temps?.rom;
  if(!roms || typeof roms !== "object") return "";
  if(role === "dhw_tank") return String(roms.dhw_tank || roms.dhw || "");
  return String(roms[roleTempKey(role)] || "");
}

function mixPortFastValue(port){
  const mix = state.eqFast?.mix || {};
  const key = String(port || "").toLowerCase();
  if(key === "a") return firstFinite(state.mixStatus?.aC, numOrNaN(mix.ma));
  if(key === "b") return firstFinite(state.mixStatus?.bC, numOrNaN(mix.mb));
  if(key === "ab") return firstFinite(state.mixStatus?.abC, numOrNaN(mix.mf));
  if(key === "tank") return firstFinite(state.mixStatus?.tankC, numOrNaN(mix.tk));
  return NaN;
}

function formatMixPortLive(port){
  const key = String(port || "").toLowerCase();
  const fastValue = mixPortFastValue(key);
  const runtime = state.th?.mixingPortState?.[key] || {};
  const value = firstFinite(fastValue, runtime.currentC);
  const parts = [Number.isFinite(value) ? `${Number(value).toFixed(1)} °C` : "--"];
  if(runtime.currentSrc) parts.push(String(runtime.currentSrc));
  if(Number.isFinite(Number(runtime.gpio))) parts.push(`GPIO${Number(runtime.gpio)}`);
  if(runtime.rom) parts.push(String(runtime.rom));
  return parts.join(" • ");
}

function populateMixSourceSelect(id, port, selected, onChange){
  const el = document.getElementById(id);
  if(!el) return;
  const key = String(port || "").toLowerCase();
  const sourceMeta = state.th?.mixingSourceMeta && typeof state.th.mixingSourceMeta === "object"
    ? state.th.mixingSourceMeta : mixTempSourceMetaDefault;
  const meta = Array.isArray(sourceMeta[key]) && sourceMeta[key].length
    ? sourceMeta[key] : (mixTempSourceMetaDefault[key] || [{key:"none",label:"Nevybráno"}]);
  const current = String(selected ?? el.value ?? "none");
  const options = meta.map(item => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.label)}</option>`).join("");
  if(el.dataset.optionsSignature !== options){
    el.innerHTML = options;
    el.dataset.optionsSignature = options;
  }
  if(current && !meta.some(item => item.key === current)){
    const option = document.createElement("option");
    option.value = current;
    option.textContent = `${current} (uložený neznámý zdroj)`;
    el.appendChild(option);
  }
  el.value = current || "none";
  if(typeof onChange === "function") el.onchange = () => onChange(String(el.value || "none"));
}

function renderMixConfigSourceSelectors(){
  const cfg = normalizeMixingValveSources(state.th?.mixingValve);
  state.th.mixingValve = cfg;
  for(const [port,id] of [["a","hMixSourceA"],["b","hMixSourceB"],["ab","hMixSourceAB"],["tank","hMixSourceTank"]]){
    populateMixSourceSelect(id, port, cfg[port], value => { state.th.mixingValve[port] = value; });
  }
  for(const [port,id] of [["a","wizSourceA"],["b","wizSourceB"],["ab","wizSourceAB"],["tank","wizSourceTank"]]){
    const el = document.getElementById(id);
    const desired = el?.dataset?.wizardTouched === "1" ? el.value : cfg[port];
    populateMixSourceSelect(id, port, desired, value => { el.dataset.wizardTouched = "1"; el.value = value; });
  }
}

function renderMixTempSourceSelectors(){
  const cfg = normalizeMixingValveSources(state.th?.mixingValve);
  state.th.mixingValve = cfg;
  const sourceMeta = state.th?.mixingSourceMeta && typeof state.th.mixingSourceMeta === "object"
    ? state.th.mixingSourceMeta : mixTempSourceMetaDefault;
  for(const [port,id] of [["a","mixTempSourceA"],["b","mixTempSourceB"],["ab","mixTempSourceAB"]]){
    const el = document.getElementById(id);
    if(!el) continue;
    const meta = Array.isArray(sourceMeta[port]) && sourceMeta[port].length
      ? sourceMeta[port] : mixTempSourceMetaDefault[port];
    const options = meta.map(item => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.label)}</option>`).join("");
    if(el.dataset.optionsSignature !== options){
      el.innerHTML = options;
      el.dataset.optionsSignature = options;
    }
    if(!meta.some(item => item.key === cfg[port])){
      const option = document.createElement("option");
      option.value = cfg[port];
      option.textContent = `${cfg[port]} (uložený neznámý zdroj)`;
      el.appendChild(option);
    }
    // Never overwrite an in-progress selection while the user is editing.
    if(document.activeElement !== el && el.dataset.unsavedSource !== "1") el.value = cfg[port];
    el.onchange = () => {
      state.th.mixingValve[port] = String(el.value || "none");
      el.dataset.unsavedSource = "1";
      markPendingSaveDirty("dallas");
    };
  }
  setText("#mixTempLiveA", formatMixPortLive("a"));
  setText("#mixTempLiveB", formatMixPortLive("b"));
  setText("#mixTempLiveAB", formatMixPortLive("ab"));
  renderMixConfigSourceSelectors();
}

function getRoleUiState(role){
  const roleState = state.th?.roleState?.[role] || {};
  const currentC = firstFinite(roleValueFromFast(role), roleState.currentC);
  const currentSrc = roleSourceFromFast(role) || String(roleState.currentSrc || "");
  const resolvedRom = roleResolvedRomFromFast(role) || String(roleState.resolvedRom || "");
  const resolvedGpio = firstFinite(roleState.resolvedGpio, state.th?.roleGpio?.[role]);
  const ageMs = Number(roleState.ageMs || 0);
  return { currentC, currentSrc, resolvedRom, resolvedGpio, ageMs };
}

function formatRoleUiState(role){
  const s = getRoleUiState(role);
  const parts = [Number.isFinite(s.currentC) ? `${s.currentC.toFixed(1)} °C` : "--"];
  if(s.currentSrc) parts.push(s.currentSrc);
  if(s.resolvedRom) parts.push(s.resolvedRom);
  return parts.join(" • ");
}

function optRom(rom, label){
  const r = String(rom || "");
  const l = label || r;
  return `<option value="${escapeHtml(r)}">${escapeHtml(l)}</option>`;
}

function normalizeDallasRolesMap(rawRoles){
  const out = { outside:"", dhw_tank:"", mix_a:"", mix_b:"", mix_ab:"", tank_top:"", tank_mid:"", tank_bottom:"", return:"", dhw_return:"" };
  const src = (rawRoles && typeof rawRoles === "object") ? rawRoles : {};
  for(const key of Object.keys(out)){
    const raw = src[key];
    if(raw && typeof raw === "object"){
      const rom = String(raw.rom || raw.resolvedRom || "").trim();
      out[key] = rom;
    }else{
      out[key] = String(raw || "").trim();
    }
  }
  return out;
}

function renderThermometersDevice(){
  const tbl = document.getElementById("thMapTbl");
  if(!tbl) return;

  if(!state.th.loaded){
    thBadge(state.th.lastError ? "bad" : "warn", state.th.lastError ? "chyba" : "nenačteno");
    tbl.innerHTML = `<tr><td colspan="4" class="muted">${escapeHtml(state.th.lastError || 'Klikni na „Načíst“.')}</td></tr>`;
    return;
  }

  thBadge("good","OK");
  const en = document.getElementById("dallasEnable");
  if(en) en.checked = !!state.th.dallasEnabled;

  const dsList = Array.isArray(state.th.ds) ? state.th.ds : [];
  const dsCnt = document.getElementById("thDsCnt");
  if(dsCnt) dsCnt.textContent = `${dsList.length} ks`;

  // Full DOM rebuild is permitted only on explicit load/save. Do not refresh
  // this editor from live WebSocket or periodic /api/fast updates.
  if(isPendingSaveDirty("dallas") && !state.th?.forceEditorHydration) return;
  tbl.innerHTML = "";
  for(const meta of (state.th.roleMeta?.length ? state.th.roleMeta : dallasRoleMetaDefault)){
    const role = meta.key;
    const cur = String(state.th.roles?.[role] || "");
    const gpio = firstFinite(state.th.roleGpio?.[role], getRoleUiState(role).resolvedGpio);
    const tr = document.createElement("tr");

    const sel = document.createElement("select");
    const roleDevices = dsList
      .filter(x => !Number.isFinite(gpio) || Number(x.gpio) === Number(gpio))
      .sort((a,b) => String(a.rom).localeCompare(String(b.rom)));
    let html = `<option value="">(auto)</option>`;
    for(const dev of roleDevices){
      const t = (dev && dev.c!=null && Number.isFinite(dev.c)) ? `${dev.c.toFixed(1)}°C` : "--";
      const g = (dev && Number.isFinite(dev.gpio)) ? `GPIO${dev.gpio}` : "";
      html += optRom(dev.rom, `${dev.rom} • ${t} • ${g}`);
    }
    if(cur && !roleDevices.some(x => x.rom === cur)){
      const fallbackDev = dsList.find(x => x.rom === cur);
      const t = (fallbackDev && fallbackDev.c!=null && Number.isFinite(fallbackDev.c)) ? `${fallbackDev.c.toFixed(1)}°C` : "--";
      const g = (fallbackDev && Number.isFinite(fallbackDev.gpio)) ? `GPIO${fallbackDev.gpio}` : "jiný GPIO";
      html += optRom(cur, `${cur} • ${t} • ${g} • mimo roli`);
    }
    sel.innerHTML = html;
    sel.value = cur;

    const valTd = document.createElement("td");
    valTd.className = "mono";
    valTd.textContent = formatRoleUiState(role);

    sel.addEventListener("change", () => {
      markPendingSaveDirty("dallas");
      state.th.roles[role] = sel.value || "";
      valTd.textContent = formatRoleUiState(role);
    });

    tr.innerHTML = `
      <td><strong>${escapeHtml(meta.name)}</strong><div class="muted">${escapeHtml(meta.note||"")}</div></td>
      <td class="mono">${Number.isFinite(gpio) ? `GPIO${gpio}` : "--"}</td>
      <td></td><td></td>
    `;
    tr.children[2].appendChild(sel);
    tr.replaceChild(valTd, tr.children[3]);
    tbl.appendChild(tr);
  }

  renderMixTempSourceSelectors();

  const dsTb = document.getElementById("thDsTbl");
  if(dsTb){
    dsTb.innerHTML = dsList.map(d => {
      const t = (d.c!=null && Number.isFinite(d.c)) ? `${d.c.toFixed(1)} °C` : "--";
      const ok = d.ok ? '<span class="badge good"><span class="b"></span>OK</span>' : '<span class="badge bad"><span class="b"></span>ERR</span>';
      return `<tr><td class="mono">GPIO${escapeHtml(d.gpio)}</td><td class="mono">${escapeHtml(d.rom)}</td><td class="mono">${escapeHtml(t)}</td><td>${ok}</td></tr>`;
    }).join("");
  }

  const bleState = document.getElementById("thBleState");
  const bleTb = document.getElementById("thBleTbl");
  const b = state.th.ble;
  const bleCfg = state.th.bleCfg || {};
  const bleEnable = document.getElementById("bleEnable");
  const bleNamePrefix = document.getElementById("bleNamePrefix");
  const bleScanIntervalMs = document.getElementById("bleScanIntervalMs");
  if(bleEnable) bleEnable.checked = !!bleCfg.enabled;
  if(bleNamePrefix) bleNamePrefix.value = String(bleCfg.namePrefix || "ESP-Meteostanice");
  if(bleScanIntervalMs) bleScanIntervalMs.value = String(Number(bleCfg.scanIntervalMs || 10000));
  if(bleState){
    const en2 = !!b?.en;
    const v = !!b?.meteo?.v;
    bleState.textContent = (!en2) ? "vypnuto" : (v ? "ok" : "bez dat");
  }
  if(bleTb){
    const rows = [];
    rows.push(`<tr><td><strong>povoleno</strong></td><td class="mono">${b?.en ? "ano" : "ne"}</td></tr>`);
    rows.push(`<tr><td><strong>stav</strong></td><td class="mono">${!b?.en ? "vypnuto" : (b?.cn ? "připojeno" : (b?.sc ? "probíhá hledání" : "čeká"))}</td></tr>`);
    rows.push(`<tr><td><strong>zařízení</strong></td><td class="mono">${escapeHtml(String(b?.peer || "--"))}</td></tr>`);
    rows.push(`<tr><td><strong>poslední chyba</strong></td><td class="mono">${escapeHtml(String(b?.err || "--"))}</td></tr>`);
    const t2 = b?.meteo?.t;
    const h2 = b?.meteo?.h;
    const p2 = b?.meteo?.p;
    rows.push(`<tr><td><strong>teplota</strong></td><td class="mono">${(t2==null) ? "--" : Number(t2).toFixed(1) + " °C"}</td></tr>`);
    rows.push(`<tr><td><strong>vlhkost</strong></td><td class="mono">${(h2==null) ? "--" : Number(h2).toFixed(1) + " %"}</td></tr>`);
    rows.push(`<tr><td><strong>tlak</strong></td><td class="mono">${(p2==null) ? "--" : Number(p2).toFixed(1) + " hPa"}</td></tr>`);
    bleTb.innerHTML = rows.join("");
  }

  const otState = document.getElementById("thOtState");
  const otTb = document.getElementById("thOtTbl");
  if(otState) otState.textContent = state.ot?.comm ? "ok" : "err";
  if(otTb){
    otTb.innerHTML = [
      `<tr><td><strong>CH setpoint</strong></td><td class="mono">${fmtMaybeNumber(state.ot?.chSet, 1, " °C")}</td></tr>`,
      `<tr><td><strong>CH teplota (měřená)</strong></td><td class="mono">${fmtMaybeNumber(state.ot?.chTemp, 1, " °C")}</td></tr>`,
      `<tr><td><strong>TUV teplota</strong></td><td class="mono">${fmtMaybeNumber(state.ot?.dhwTemp, 1, " °C")}</td></tr>`,
      `<tr><td><strong>Tlak</strong></td><td class="mono">${fmtMaybeNumber(state.ot?.pressure, 2, " bar")}</td></tr>`,
    ].join("");
  }
}

async function thermoLoad(options={}){
  if(state.th.načítání) return;
  const silent = !!options.silent;
  const forceConfig = !!options.forceConfig;
  state.th.načítání = true;
  state.th.lastError = "";
  try{
    thBadge("warn","čtu…");
    let cfg = null;
    if(!forceConfig && state.th?.cfgLoaded){
      cfg = {
        enabled: !!state.th.dallasEnabled,
        roles: state.th.roles || {},
        availableRoles: state.th.roleMeta || [],
        mixingValve: {
          ...normalizeMixingValveSources(state.th.mixingValve),
          availableSources: state.th.mixingSourceMeta || normalizeMixTempSourceMeta(null)
        }
      };
    }else{
      cfg = await api.fetchConfigSection("dallas");
    }
    let ds = null;
    let ble = null;
    let bleCfg = null;
    try{ ds = await api.getJson("/api/dallas/status", 3500); }catch(_e){}
    try{ ble = await api.getJson("/api/ble/status", 2000); }catch(_e){}
    try{ bleCfg = await api.fetchConfigSection("ble"); }catch(_e){}
    const flat = flattenDallas(ds);

    state.th.loaded = true;
    state.th.cfgLoaded = true;
    state.th.dallasEnabled = !!cfg?.enabled;
    state.th.roles = normalizeDallasRolesMap(cfg?.roles);
    state.th.roleMeta = normalizeDallasRoleMeta(cfg?.availableRoles);
    state.th.roleGpio = flat.roleGpio || {};
    state.th.roleState = flat.roleState || {};
    state.th.mixingValve = normalizeMixingValveSources(cfg?.mixingValve || ds?.dallas?.mixingValve);
    state.th.mixingSourceMeta = normalizeMixTempSourceMeta(cfg?.mixingValve?.availableSources);
    state.th.mixingPortState = flat.mixingPortState || {};
    state.th.ds = Array.isArray(flat.ds) ? flat.ds : [];
    state.th.ble = ble;
    state.th.bleCfg = {
      enabled: !!(bleCfg?.enabled ?? ble?.en),
      namePrefix: String(bleCfg?.namePrefix ?? ble?.namePrefix ?? "ESP-Meteostanice"),
      scanIntervalMs: clamp(Number(bleCfg?.scanIntervalMs ?? ble?.scanIntervalMs ?? 10000), 2000, 60000)
    };

    renderThermometersDevice();
    setApiHealth(ds ? "good" : "warn", ds ? "API: zařízení" : "API: Dallas status chyba");
    if(ds){
      if(!silent) toast("Teploměry", "Načteno ze zařízení.", "✅");
    }else{
      if(!silent) toast("Teploměry", "Konfigurace načtena, ale Dallas status se nepodařilo přečíst.", "⚠");
      log("thermo dallas status warning: status unavailable");
    }
  }catch(e){
    state.th.loaded = false;
    state.th.lastError = e?.message || String(e);
    renderThermometersDevice();
    thBadge("bad","chyba");
    setApiHealth("bad", "API: chyba");
    if(!silent) toast("Chyba", state.th.lastError, "⚠");
    log("thermo load error: " + state.th.lastError);
  }finally{
    state.th.načítání = false;
  }
}

async function bleSave(){
  const btn = document.getElementById("bleSave");
  try{
    const payload = {
      enabled: !!document.getElementById("bleEnable")?.checked,
      namePrefix: String(document.getElementById("bleNamePrefix")?.value || "ESP-Meteostanice").trim(),
      scanIntervalMs: clamp(Number(document.getElementById("bleScanIntervalMs")?.value || 10000), 2000, 60000)
    };
    if(!payload.namePrefix) throw new Error("Prefix názvu BLE zařízení nesmí být prázdný.");
    if(btn) btn.disabled = true;
    await api.postConfigSection("ble", payload);
    clearPendingSaveDirty("ble");
    state.th.bleCfg = payload;
    try{ state.th.ble = await api.getJson("/api/ble/status", 2500); }catch(_e){}
    renderThermometersDevice();
    toast("BLE meteo", payload.enabled ? "BLE bylo zapnuto. Hledání proběhne podle nastaveného intervalu." : "BLE bylo vypnuto. Scan i spojení byly zastaveny.", payload.enabled ? "📡" : "⏹");
  }catch(e){
    toast("BLE meteo", e.message || String(e), "⚠");
    log("BLE save error: " + (e.message || e));
  }finally{
    if(btn) btn.disabled = false;
  }
}

async function thermoSave(){
  try{
    state.th.dallasEnabled = !!document.getElementById("dallasEnable")?.checked;
    thBadge("warn","odesílám…");
    state.th.mixingValve = normalizeMixingValveSources({
      a: document.getElementById("mixTempSourceA")?.value || state.th.mixingValve?.a,
      b: document.getElementById("mixTempSourceB")?.value || state.th.mixingValve?.b,
      ab: document.getElementById("mixTempSourceAB")?.value || state.th.mixingValve?.ab,
      tank: state.th.mixingValve?.tank || "tank_top",
    });
    await api.postConfigSection("dallas", {
      enabled: state.th.dallasEnabled,
      roles: normalizeDallasRolesMap(state.th.roles),
      mixingValve: state.th.mixingValve,
    });
    clearPendingSaveDirty("dallas");
    ["mixTempSourceA","mixTempSourceB","mixTempSourceAB"].forEach(id => {
      const control=document.getElementById(id);
      if(control) delete control.dataset.unsavedSource;
    });
    toast("Teploměry", "Uloženo do zařízení.", "✅");
    await thermoLoad();
  }catch(e){
    thBadge("bad","chyba");
    toast("Chyba", e.message || String(e), "⚠");
    log("thermo save error: " + (e.message || e));
  }
}
// ----- Shared UI helpers
    function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }

    function setTankFill(id, top, mid, bot){
      const el = $(id);
      if(!el) return;
      const vals = [top, mid, bot].map(numOrNaN).filter(Number.isFinite);
      if(!vals.length){
        el.style.transform = "scaleY(0)";
        return;
      }
      const avg = vals.reduce((a,b) => a + b, 0) / vals.length;
      // Map 10..80°C -> 0..1
      const k = clamp((avg - 10) / 70, 0, 1);
      el.style.transform = `scaleY(${k.toFixed(3)})`;
    }
    function rnd(n=1){ return (Math.random()-0.5)*n; }

    // ----- Device API mapping
    // NOTE: Without knowing your exact API schema, this is designed as an adapter.
    // Update endpoints/fields to match your firmware.
      const api = {
      async getJson(path, timeoutMs=6000){
        const base = normalizedApiBase();
        const url = base + path;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(new Error(`Timeout ${timeoutMs} ms: ${path}`)), timeoutMs);
        try{
          const r = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
          return await parseApiReply(r, path);
        }catch(e){
          if(e?.name === "AbortError") throw new Error(`Request timeout: ${path}`);
          throw e;
        }finally{
          clearTimeout(t);
        }
      },

      async postJson(path, obj, timeoutMs=12000){
        const base = normalizedApiBase();
        const url = base + path;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(new Error(`Timeout ${timeoutMs} ms: ${path}`)), timeoutMs);
        try{
          const r = await fetch(url, {
            method: "POST",
            signal: ctrl.signal,
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(obj ?? {})
          });
          return await parseApiReply(r, path);
        }catch(e){
          if(e?.name === "AbortError") throw new Error(`Request timeout: ${path}`);
          throw e;
        }finally{
          clearTimeout(t);
        }
      },

      async fetchStatusExtras(activeView){
        const out = {};
        const view = String(activeView || "").toLowerCase();
        const fetchAll = !view || !["heating","mixing","dhw","opentherm"].includes(view);
        const wantEq = fetchAll || view === "heating" || view === "mixing";
        const wantMix = fetchAll || view === "mixing";
        const wantOt = fetchAll || view === "heating" || view === "dhw" || view === "opentherm";
        const wantDhw = fetchAll || view === "dhw";

        if(wantEq){
          try{ out.equitherm = await api.getJson("/api/equitherm/status", 5000); }catch(_e){}
        }
        if(wantMix){
          try{ out.mixing = await api.getJson("/api/mixing/status", 5000); }catch(_e){}
        }
        if(wantOt){
          try{ out.opentherm = await api.getJson("/api/opentherm/status", 5000); }catch(_e){}
        }
        if(wantDhw){
          try{ out.dhw = await api.getJson("/api/dhw/status", 5000); }catch(_e){}
        }
        return out;
      },
      async fetchConfigSection(section){
        return await api.getJson(`/api/config/${encodeURIComponent(section)}`, 8000);
      },
      async fetchBootstrap(){
        return await api.getJson("/api/bootstrap", 5000);
      },
      async getSetupWizard(){
        return await api.getJson("/api/setup/wizard", 5000);
      },
      async saveSetupWizard(obj){
        return await api.postJson("/api/setup/wizard", obj ?? {}, 15000);
      },

      async postConfigSection(section, obj){
        return await api.postJson(`/api/config/${encodeURIComponent(section)}`, obj ?? {}, 10000);
      },
      async eqCmd(obj){
        return await api.postJson("/api/equitherm/cmd", obj ?? {}, 6000);
      },

      async mixCmdImmediate(action, payload={}){
        const act = String(action || "").toLowerCase();
        const pulseMs = Number(payload?.pulseMs || 0);
        try{
          return await sendMixCommandWs(act, pulseMs);
        }catch(e){
          // HTTP is a fallback only when the command was not sent at all.
          if(String(e?.message || e) !== "ws_unavailable") throw e;
          const body = { action:act };
          if(pulseMs > 0) body.pulseMs = pulseMs;
          return await api.postJson("/api/mixing/cmd", body, 6000);
        }
      },
      async mixCmd(obj){
        return await api.postJson("/api/mixing/cmd", obj ?? {}, 6000);
      },

      async otCmd(obj){
        return await api.postJson("/api/opentherm/cmd", obj ?? {}, 6000);
      },

      async dhwCmd(obj){
        return await api.postJson("/api/dhw/cmd", obj ?? {}, 6000);
      },

      async systemCmd(obj){
        return await api.postJson("/api/system/cmd", obj ?? {}, 8000);
      },

      async reboot(){
        return await api.postJson("/api/reboot", {}, 6000);
      }
    };

    function mqttSetBadge(kind, text){
      setBadge("#mqttState", kind, text);
    }

    function mqttApplyConfigToForm(cfgLike, statusLike=null){
      if(isPendingSaveDirty("mqtt")) return;
      const cfg = (cfgLike && cfgLike.mqtt) ? cfgLike.mqtt : (cfgLike || {});
      const status = (statusLike && statusLike.mqtt) ? statusLike.mqtt : (statusLike || {});
      const ha = cfg.homeAssistant || status.homeAssistant || {};
      const mqttEnable = document.getElementById("mqttEnable");
      const mqttHost = document.getElementById("mqttHost");
      const mqttPort = document.getElementById("mqttPort");
      const mqttUser = document.getElementById("mqttUser");
      const mqttPassword = document.getElementById("mqttPassword");
      const mqttClientId = document.getElementById("mqttClientId");
      const mqttBaseTopic = document.getElementById("mqttBaseTopic");
      const mqttPublish = document.getElementById("mqttPublishIntervalMs");
      const mqttHaEnable = document.getElementById("mqttHaEnable");
      const mqttHaDiscovery = document.getElementById("mqttHaDiscovery");
      const mqttDiscoveryPrefix = document.getElementById("mqttDiscoveryPrefix");
      const mqttNodeId = document.getElementById("mqttNodeId");
      const passwordSetLbl = document.getElementById("mqttPasswordSet");
      const clearPassword = document.getElementById("mqttClearPassword");

      if(mqttEnable) mqttEnable.checked = !!cfg.enabled;
      if(mqttHost) mqttHost.value = String(cfg.host || status.host || "");
      if(mqttPort) mqttPort.value = String(Number(cfg.port || status.port || 1883));
      if(mqttUser) mqttUser.value = String(cfg.username || status.username || "");
      if(mqttPassword && document.activeElement !== mqttPassword) mqttPassword.value = "";
      if(mqttClientId) mqttClientId.value = String(cfg.clientId || status.clientId || "esp32-controller");
      if(mqttBaseTopic) mqttBaseTopic.value = String(cfg.baseTopic || status.baseTopic || "esp32-controller");
      if(mqttPublish) mqttPublish.value = String(Number(cfg.publishIntervalMs || status.publishIntervalMs || 10000));
      if(mqttHaEnable) mqttHaEnable.checked = !!ha.enabled;
      if(mqttHaDiscovery) mqttHaDiscovery.checked = !!ha.discovery;
      if(mqttDiscoveryPrefix) mqttDiscoveryPrefix.value = String(ha.discoveryPrefix || "homeassistant");
      if(mqttNodeId) mqttNodeId.value = String(ha.nodeId || "esp32_controller");
      if(passwordSetLbl) passwordSetLbl.textContent = (cfg.passwordSet || status.passwordSet) ? "heslo uloženo" : "heslo není uloženo";
      if(clearPassword) clearPassword.checked = false;
    }

    function mqttRenderStatus(statusLike){
      const status = (statusLike && statusLike.mqtt) ? statusLike.mqtt : (statusLike || {});
      const preview = status.preview || {};
      const runtime = String(status.runtime || "jen konfigurace");
      const connected = !!status.connected;
      const enabled = !!status.enabled;
      const runtimeLbl = document.getElementById("mqttRuntimeText");
      const previewEl = document.getElementById("mqttPreview");
      if(runtimeLbl) runtimeLbl.textContent = `${runtime}${connected ? " • připojeno" : " • odpojeno"}`;
      setBadge("#haState", (!!status.homeAssistant?.enabled && !!status.homeAssistant?.discovery) ? "good" : "", `HA: ${status.homeAssistant?.enabled ? (status.homeAssistant?.discovery ? "discovery" : "povoleno") : "vypnuto"}`);
      mqttSetBadge(enabled ? (connected ? "good" : "warn") : "", `MQTT: ${enabled ? (connected ? "připojeno" : runtime) : "vypnuto"}`);
      if(previewEl){
        previewEl.textContent = JSON.stringify(preview, null, 2);
      }
    }

    async function mqttLoad(options={}){
      const silent = !!options.silent;
      state.mqtt = state.mqtt || { loaded:false, načítání:false, status:null, config:null };
      if(state.mqtt.načítání) return;
      state.mqtt.načítání = true;
      try{
        if(!silent) mqttSetBadge("warn", "MQTT: načítám…");
        const [cfgRes, statusRes] = await Promise.allSettled([
          api.fetchConfigSection("mqtt"),
          api.getJson("/api/mqtt/status", 4000),
        ]);
        if(cfgRes.status === "fulfilled"){
          state.mqtt.config = cfgRes.value?.mqtt || cfgRes.value || {};
          mqttApplyConfigToForm(cfgRes.value, statusRes.status === "fulfilled" ? statusRes.value : null);
        }
        if(statusRes.status === "fulfilled"){
          state.mqtt.status = statusRes.value?.mqtt || statusRes.value || {};
          if(cfgRes.status !== "fulfilled") mqttApplyConfigToForm(statusRes.value, statusRes.value);
          mqttRenderStatus(statusRes.value);
        } else if(cfgRes.status === "fulfilled"){
          mqttRenderStatus(state.mqtt.config || {});
        }
        state.mqtt.loaded = true;
        if(!silent) toast("MQTT", "Načteno.", "✅");
      }catch(e){
        mqttSetBadge("bad", "MQTT: chyba");
        if(!silent) toast("MQTT", e.message || String(e), "⚠");
        log("mqtt load error: " + (e.message || e));
      }finally{
        state.mqtt.načítání = false;
      }
    }

    async function mqttSave(){
      const payload = {
        mqtt: {
          enabled: !!document.getElementById("mqttEnable")?.checked,
          host: String(document.getElementById("mqttHost")?.value || "").trim(),
          port: clamp(Number(document.getElementById("mqttPort")?.value || 1883), 1, 65535),
          username: String(document.getElementById("mqttUser")?.value || "").trim(),
          clientId: String(document.getElementById("mqttClientId")?.value || "").trim(),
          baseTopic: String(document.getElementById("mqttBaseTopic")?.value || "").trim(),
          publishIntervalMs: clamp(Number(document.getElementById("mqttPublishIntervalMs")?.value || 10000), 1000, 600000),
          clearPassword: !!document.getElementById("mqttClearPassword")?.checked,
          homeAssistant: {
            enabled: !!document.getElementById("mqttHaEnable")?.checked,
            discovery: !!document.getElementById("mqttHaDiscovery")?.checked,
            discoveryPrefix: String(document.getElementById("mqttDiscoveryPrefix")?.value || "").trim(),
            nodeId: String(document.getElementById("mqttNodeId")?.value || "").trim(),
          }
        }
      };
      const pw = String(document.getElementById("mqttPassword")?.value || "");
      if(pw.trim().length) payload.mqtt.password = pw;
      mqttSetBadge("warn", "MQTT: ukládám…");
      await api.postConfigSection("mqtt", payload.mqtt);
      clearPendingSaveDirty("mqtt");
      state.mqtt.loaded = false;
      await mqttLoad({ silent:true });
      toast("MQTT", "Nastavení uloženo. MQTT runtime byl znovu načten.", "✅");
    }

    function getMixPulseMsFromForm(){
      return clamp(Number(document.getElementById("hMixPulseMs")?.value || 600), 50, 60000);
    }

    function mixLogicalRelay(direction){
      const reversed = String(document.getElementById("hMixOpeningDirection")?.value || state.dev?.mixCfgRaw?.openingDirection || "normal") === "reversed";
      const a = String(direction || "").toLowerCase() === "a";
      return a ? (reversed ? 2 : 1) : (reversed ? 1 : 2);
    }

    function updateMixDirectionUi(){
      const openRelay = mixLogicalRelay("a");
      const closeRelay = mixLogicalRelay("b");
      const pulseA = document.getElementById("hMixPulseA");
      const pulseB = document.getElementById("hMixPulseB");
      if(pulseA) pulseA.title = `A / Relé${openRelay}: teplá větev, zvyšuje teplotu AB, logická poloha 100 %`;
      if(pulseB) pulseB.title = `B / Relé${closeRelay}: vratná/chladnější větev, snižuje teplotu AB, logická poloha 0 %`;
    }

    async function mixManualPulse(direction){
      const pulseMs = getMixPulseMsFromForm();
      const dir = String(direction || "").toLowerCase();
      await api.mixCmdImmediate(dir === "a" ? "pulse_a" : "pulse_b", { pulseMs });
      state.dev = state.dev || {};
      state.dev.mixCfgLoaded = false;
      if(state.net) state.net.extrasDueMs = 0;
      await refresh(false);
      toast("Směšovací ventil", `Manuální puls ${dir === "a" ? `A / R${mixLogicalRelay("a")} (teplá větev, zvýšení AB)` : `B / R${mixLogicalRelay("b")} (vratná větev, snížení AB)`} (${pulseMs} ms).`, "🧪");
    }

    async function mixManualMoveToEnd(direction){
      const dir = String(direction || "").toLowerCase();
      await api.mixCmdImmediate(dir === "a" ? "end_a" : "end_b");
      state.dev = state.dev || {};
      state.dev.mixCfgLoaded = false;
      if(state.net) state.net.extrasDueMs = 0;
      await refresh(false);
      toast("Směšovací ventil", `Přejezd do krajní polohy ${dir === "a" ? "A / 100 % (teplá větev z AKU)" : "B / 0 % (vratná/chladnější větev)"}.`, "🎯");
    }

    async function mixManualStop(){
      await api.mixCmdImmediate("stop");
      if(state.net) state.net.extrasDueMs = 0;
      await refresh(false);
      toast("Směšovací ventil", "Pohyb ventilu zastaven.", "⛔");
    }

    async function mixCalibrationCommand(command){
      const actionMap = { a:"calibrate_a", b:"calibrate_b", calibrate_a:"calibrate_a", calibrate_b:"calibrate_b", invalidate:"invalidate", auto:"calibrate_b" };
      const action = actionMap[String(command || "").toLowerCase()];
      if(!action) throw new Error("Neznámý kalibrační povel.");
      await api.mixCmd({ action });
      if(state.net) state.net.extrasDueMs = 0;
      await refresh(false);
      const labels = { calibrate_a:"Spuštěna kalibrace do A / 100 %.", calibrate_b:"Spuštěna kalibrace do B / 0 %.", invalidate:"Odhad polohy byl zneplatněn." };
      toast("Kalibrace ventilu", labels[action] || "Kalibrace byla upravena.", "🎯");
    }

    function mixStateMeta(rawState){
      const s = String(rawState || "startup").toLowerCase();
      const map = {
        startup:["start regulátoru","warn"],
        disabled:["automatika vypnuta",""],
        parking:["přesun do bezpečné polohy","warn"],
        referencing_b:["referencování polohy B / 0 %","warn"],
        at_limit:["dosažen krajní bod ventilu","warn"],
        blocked_no_heat:["AKU nemá dostatek tepla","warn"],
        blocked_tank_sensor:["chybí teplota AKU","bad"],
        blocked_target:["není dostupný topný bod","warn"],
        blocked_external:["řízení blokováno vyšší prioritou","warn"],
        initial_approach:["rychlé přiblížení k cíli","good"],
        moving:["korekční pohyb ventilu","good"],
        settling:["čeká na tepelnou odezvu","warn"],
        tracking:["sledování cíle","good"],
        in_range:["cílová teplota v pásmu","good"],
        manual:["ruční pohyb","warn"],
        manual_hold:["blokace po ručním zásahu","warn"],
        dhw_override:["ventil převzala priorita TUV","warn"],
        floor_protection:["ochrana podlahy • zavírání do B","bad"],
        fault_ab_sensor:["porucha / chybí AB čidlo","bad"],
        fault_relay:["porucha ovládání R1/R2","bad"],
      };
      const hit = map[s];
      return { raw:s, label: hit ? hit[0] : s, kind: hit ? hit[1] : "", fault:/^fault_/.test(s), blocked:/^blocked_/.test(s) || s === "disabled" };
    }

    function mixCalibrationLabel(raw){
      const s = String(raw || "").toLowerCase();
      if(s === "a") return "poslední kalibrace A / 100 %";
      if(s === "b") return "poslední kalibrace B / 0 %";
      if(s === "trusted") return "poloha je referencovaná";
      if(s === "untrusted") return "poloha není referencovaná";
      return s || "--";
    }

    function dhwPhaseMeta(rawPhase){
      const s = String(rawPhase || "idle").toLowerCase();
      const map = {
        idle: ["klid", ""],
        switching_to_dhw: ["přepínání na TUV", "warn"],
        heating: ["ohřev TUV", "good"],
        switching_back_to_ch: ["návrat na CH", "warn"],
      };
      const hit = map[s];
      return { raw:s, label: hit ? hit[0] : s, kind: hit ? hit[1] : "" };
    }

    function dhwReasonMeta(rawReason){
      const s = String(rawReason || "").toLowerCase();
      const map = {
        disabled: ["funkce TUV je vypnutá", ""],
        idle: ["bez požadavku", ""],
        switching_to_dhw: ["čeká po přepnutí na TUV", "warn"],
        switching_back: ["dobíhá návrat na CH", "warn"],
        heating: ["probíhá ohřev", "good"],
        anti_legionella: ["probíhá anti-legionella ohřev", "warn"],
        target_reached: ["cílová teplota dosažena", "good"],
        request_blocked_no_valid_temp: ["požadavek blokován: chybí platná teplota zásobníku", "bad"],
        boiler_dhw_active_ot: ["kotel hlásí aktivní TUV přes OpenTherm", "warn"],
      };
      const hit = map[s];
      return { raw:s, label: hit ? hit[0] : (s || "--"), kind: hit ? hit[1] : "", fault: /blocked_no_valid_temp/.test(s) };
    }

    function serviceIssueMeta(domain, key){
      const raw = String(key || "").toLowerCase();
      const none = { domain, key:"", label:"bez aktivní servisní události", kind:"", recommendation:"Bez zásahu.", counterLabel:"Bez událostí" };
      if(!raw) return none;
      const map = {
        mix_fault_ab_sensor: { label:"Mix: neplatné regulační čidlo AB", kind:"bad", recommendation:"Zkontrolovat zvolený zdroj AB, kabeláž čidla a stáří měřené hodnoty.", counterLabel:"Výpadek čidla AB" },
        mix_fault_relay: { label:"Mix: chyba relé R1/R2", kind:"bad", recommendation:"Zkontrolovat I2C/reléovou část desky a blokování výstupů R1/R2.", counterLabel:"Chyba relé mixu" },
        mix_blocked_tank_sensor: { label:"Mix: neplatná teplota AKU", kind:"bad", recommendation:"Zkontrolovat zvolený zdroj teploty akumulační nádrže. Automatika bez platného AKU čidla nepracuje.", counterLabel:"Výpadek čidla AKU" },
        mix_blocked_no_heat: { label:"Mix: v AKU není dostatek tepla", kind:"warn", recommendation:"Běžná blokace, pokud je AKU chladnější než výsledný cíl plus nastavená rezerva.", counterLabel:"AKU bez tepelné rezervy" },
        mix_floor_protection: { label:"Mix: aktivní ochrana vysoké AB", kind:"bad", recommendation:"Ventil je nucen směrem B. Prověřit teplotu AB, maximální limit a hydrauliku okruhu.", counterLabel:"Ochrana vysoké AB" },
        dhw_request_blocked_no_valid_temp: { label:"TUV: chybí platná teplota zásobníku", kind:"bad", recommendation:"Zkontrolovat čidlo TUV, zdroj teploty a stáří hodnoty. Bez validní teploty je ohřev záměrně blokován.", counterLabel:"Blokace TUV bez teploty" },
        dhw_switching_to_dhw: { label:"TUV: probíhá přepnutí na ohřev", kind:"warn", recommendation:"Běžný přechodový stav. Zásah je potřeba jen pokud trvá neobvykle dlouho.", counterLabel:"Přechod na TUV" },
        dhw_switching_back_to_ch: { label:"TUV: návrat zpět na CH", kind:"warn", recommendation:"Běžný doběh po ohřevu. Zásah je potřeba jen pokud stav visí příliš dlouho.", counterLabel:"Návrat TUV na CH" },
        dhw_boiler_dhw_active_ot: { label:"TUV: kotel hlásí aktivní TUV přes OT", kind:"warn", recommendation:"Ověřit, zda kotel skutečně dokončuje TUV. Pokud stav neodpovídá realitě, prověřit interpretaci OT stavů.", counterLabel:"OT aktivní TUV" },
      };
      const meta = map[raw];
      return meta ? { domain, key:raw, ...meta } : { domain, key:raw, label: raw, kind:"warn", recommendation:"Prověřit detailní diagnostiku firmware a odpovídající akční členy/čidla.", counterLabel: raw };
    }

    function evaluateServiceIssues(){
      const mixState = String(state.mixStatus?.state || state.eqFast?.mix?.st || "idle").toLowerCase();
      const dhwReason = String(state.dhwStatus?.heatReason || "").toLowerCase();
      const dhwPhase = String(state.dhwStatus?.heatPhase || state.dhwFast?.hp || "idle").toLowerCase();

      let mixKey = "";
      const mixIssues = ["fault_ab_sensor","fault_relay","blocked_tank_sensor","blocked_no_heat","floor_protection"];
      if(mixIssues.includes(mixState)) mixKey = `mix_${mixState}`;

      let dhwKey = "";
      if(dhwReason === "request_blocked_no_valid_temp") dhwKey = `dhw_${dhwReason}`;
      else if(dhwReason === "boiler_dhw_active_ot") dhwKey = `dhw_${dhwReason}`;
      else if(["switching_to_dhw","switching_back_to_ch"].includes(dhwPhase)) dhwKey = `dhw_${dhwPhase}`;

      return { mixKey, dhwKey };
    }

    function observeServiceIssues(){
      state.service = state.service || loadServiceStats();
      const issues = evaluateServiceIssues();
      let changed = false;
      ["mixKey","dhwKey"].forEach((field) => {
        const nextKey = String(issues[field] || "");
        const prevKey = String(state.service.current?.[field] || "");
        if(nextKey && nextKey !== prevKey){
          state.service.counters[nextKey] = (Number(state.service.counters[nextKey]) || 0) + 1;
          state.service.lastChangeMs = Date.now();
          changed = true;
        }
        if(nextKey !== prevKey){
          state.service.current[field] = nextKey;
          changed = true;
        }
      });
      if(changed) saveServiceStats();
    }

    function serviceCounterValue(key){
      return Number(state.service?.counters?.[key]) || 0;
    }

    function renderServicePanel(){
      state.service = state.service || loadServiceStats();
      const issues = evaluateServiceIssues();
      const mixMeta = serviceIssueMeta("mix", issues.mixKey);
      const dhwMeta = serviceIssueMeta("dhw", issues.dhwKey);
      const overall = issues.mixKey ? mixMeta : (issues.dhwKey ? dhwMeta : serviceIssueMeta("all", ""));

      const mixBadgeText = issues.mixKey ? `servis mix: ${mixMeta.label}` : "servis mix: bez aktivní události";
      const dhwBadgeText = issues.dhwKey ? `servis TUV: ${dhwMeta.label}` : "servis TUV: bez aktivní události";
      setBadge("#mixServiceNow", mixMeta.kind, mixBadgeText);
      setBadge("#dhwServiceNow", dhwMeta.kind, dhwBadgeText);
      setBadge("#serviceOverviewBadge", overall.kind, issues.mixKey || issues.dhwKey ? `servis: ${overall.label}` : "servis: bez aktivní události");

      setText("#mixServiceAdvice", mixMeta.recommendation);
      setText("#dhwServiceAdvice", dhwMeta.recommendation);
      setText("#serviceLastChange", state.service.lastChangeMs ? new Date(state.service.lastChangeMs).toLocaleString("cs-CZ") : "--");

      const rows = [
        ["mix_fault_ab_sensor", serviceIssueMeta("mix", "mix_fault_ab_sensor")],
        ["mix_fault_relay", serviceIssueMeta("mix", "mix_fault_relay")],
        ["mix_blocked_tank_sensor", serviceIssueMeta("mix", "mix_blocked_tank_sensor")],
        ["mix_blocked_no_heat", serviceIssueMeta("mix", "mix_blocked_no_heat")],
        ["mix_floor_protection", serviceIssueMeta("mix", "mix_floor_protection")],
        ["dhw_request_blocked_no_valid_temp", serviceIssueMeta("dhw", "dhw_request_blocked_no_valid_temp")],
        ["dhw_switching_to_dhw", serviceIssueMeta("dhw", "dhw_switching_to_dhw")],
        ["dhw_switching_back_to_ch", serviceIssueMeta("dhw", "dhw_switching_back_to_ch")],
      ];
      const tbody = document.getElementById("serviceCounterTbl");
      if(tbody){
        tbody.innerHTML = "";
        rows.forEach(([key, meta]) => {
          const tr = document.createElement("tr");
          tr.innerHTML = `<td>${escapeHtml(meta.counterLabel)}</td><td>${serviceCounterValue(key)}</td><td>${escapeHtml(meta.recommendation)}</td>`;
          tbody.appendChild(tr);
        });
      }
    }

    function resetServiceCounters(){
      state.service = { current:{ mixKey:"", dhwKey:"" }, counters:{}, lastChangeMs:0 };
      saveServiceStats();
      renderServicePanel();
      toast("Servisní počitadla", "Počitadla fault stavů byla vynulována pouze v prohlížeči.", "🧹");
    }

    function drawMixCalibrationChart(canvas, pct, travelMs, directionKind){
      if(!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(360, Math.round(rect.width || 760));
      const cssH = Math.max(180, Math.round(rect.height || 300));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      const ctx = canvas.getContext("2d");
      if(!ctx) return;
      ctx.setTransform(dpr,0,0,dpr,0,0);
      ctx.clearRect(0,0,cssW,cssH);
      const styles = getComputedStyle(document.documentElement);
      const fg2 = styles.getPropertyValue("--fg2").trim() || "rgba(255,255,255,.55)";
      const border = styles.getPropertyValue("--border").trim() || "rgba(255,255,255,.14)";
      const info = styles.getPropertyValue("--info").trim() || "#38bdf8";
      const good = styles.getPropertyValue("--good").trim() || "#22c55e";
      const bad = styles.getPropertyValue("--bad").trim() || "#ef4444";
      const left = 42, right = 18, top = 18, bottom = 34;
      const w = cssW-left-right, h = cssH-top-bottom;
      ctx.font = "11px ui-sans-serif, system-ui";
      ctx.lineWidth = 1;
      ctx.strokeStyle = border;
      ctx.fillStyle = fg2;
      for(let i=0;i<=4;i++){
        const y = top + h * i/4;
        ctx.beginPath(); ctx.moveTo(left,y); ctx.lineTo(left+w,y); ctx.stroke();
        const val = 100 - i*25;
        ctx.fillText(`${val}%`, 4, y+4);
      }
      const seconds = Math.max(1, Number(travelMs || 6000)/1000);
      for(let i=0;i<=6;i++){
        const x = left + w*i/6;
        ctx.fillText(`${(seconds*i/6).toFixed(i===0?0:1)} s`, x-9, top+h+20);
      }
      const xFor = p => left + w*clamp(p,0,100)/100;
      const yFor = p => top + h*(1-clamp(p,0,100)/100);
      const gradient = ctx.createLinearGradient(left,0,left+w,0);
      gradient.addColorStop(0, info); gradient.addColorStop(1, good);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 3;
      ctx.beginPath();
      for(let i=0;i<=20;i++){
        const p = i*5;
        const eased = p < 10 ? p*.45 : (p > 90 ? 95 + (p-90)*.5 : p);
        const x = xFor(p), y = yFor(eased);
        if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.stroke();
      const curX = xFor(pct), curY = yFor(pct);
      ctx.setLineDash([5,4]); ctx.strokeStyle = fg2; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(curX,top); ctx.lineTo(curX,top+h); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = directionKind === "fault" ? bad : good;
      ctx.beginPath(); ctx.arc(curX,curY,6,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 2; ctx.stroke();
    }

    function renderMixingDashboard(values){
      const mix = state.mixStatus || state.eqFast?.mix || {};
      const pct = clamp(Number(firstFinite(mix.positionPct, mix.pct, values?.pct, 0)) || 0, 0, 100);
      const rawState = String(mix.state || mix.st || "startup");
      const meta = mixStateMeta(rawState);
      const dir = String(mix.direction || mix.dir || "stop").toLowerCase();
      const directionText = dir === "a" ? "POHYB → A / TEPLEJI" : dir === "b" ? "POHYB → B / CHLADNĚJI" : meta.label.toUpperCase();
      const directionKind = meta.fault ? "fault" : (meta.blocked ? "blocked" : (dir === "a" ? "open" : dir === "b" ? "close" : "idle"));
      const travelToAMs = Number(document.getElementById("hMixTravelToAMs")?.value || state.mixConfig?.travelToAMs || 6000);
      const travelToBMs = Number(document.getElementById("hMixTravelToBMs")?.value || state.mixConfig?.travelToBMs || 6000);
      const chartTravelMs = dir === "a" ? travelToAMs : (dir === "b" ? travelToBMs : Math.max(travelToAMs, travelToBMs));

      setText("#mixUiPosition", `${Math.round(pct)} %`);
      setText("#mixUiDirection", directionText);
      setText("#mixUiSchematicState", `odhad ${Math.round(pct)} %${(mix.positionTrusted ?? mix.pt) ? " • referencováno" : " • bez reference"}`);
      const directionEl = document.getElementById("mixUiDirection");
      if(directionEl) directionEl.dataset.kind = directionKind;
      const arc = document.getElementById("mixUiGaugeArc");
      if(arc) arc.style.strokeDasharray = `${pct} ${100-pct}`;
      const core = document.getElementById("mixUiValveCore");
      if(core) core.style.setProperty("--mix-rotation", `${-45 + pct*0.9}deg`);
      const knob = document.getElementById("mixUiPositionKnob");
      if(knob) knob.style.left = `${pct}%`;

      const supplyC = firstFinite(mix.aC, mix.ma, values?.supplyC);
      const returnC = firstFinite(mix.bC, mix.mb, values?.returnC);
      const outputC = firstFinite(mix.abC, mix.mf, values?.outputC);
      const targetC = firstFinite(mix.targetC, mix.tf, values?.targetC);
      [["mixUiSupplyTemp",supplyC],["mixUiSupplyTemp2",supplyC],["mixUiReturnTemp",returnC],["mixUiReturnTemp2",returnC],["mixUiOutputTemp",outputC],["mixUiOutputTemp2",outputC],["mixUiTargetTemp",targetC]]
        .forEach(([id,val]) => setText(`#${id}`, fmtNum(Number(val), 1)));

      const tankC = firstFinite(mix.tankC, mix.tk);
      const baseC = firstFinite(mix.baseTargetC, mix.bt);
      const errC = firstFinite(mix.errorC, mix.er);
      const ff = firstFinite(mix.feedForwardPct, mix.ff);
      const trend = firstFinite(mix.trendCPerMin, mix.tr);
      const nextMs = firstFinite(mix.nextDecisionInMs, mix.nd);
      setText("#mixUiTankTemp", Number.isFinite(tankC) ? `${fmtNum(tankC,1)} °C` : "--");
      setText("#mixUiBaseTarget", Number.isFinite(baseC) ? `${fmtNum(baseC,1)} °C` : "--");
      setText("#mixUiError", Number.isFinite(errC) ? `${errC >= 0 ? "+" : ""}${fmtNum(errC,1)} °C` : "--");
      setText("#mixUiFeedForward", Number.isFinite(ff) ? `${fmtNum(ff,1)} %` : "--");
      setText("#mixUiTrend", Number.isFinite(trend) ? `${trend >= 0 ? "+" : ""}${fmtNum(trend,2)} °C/min` : "--");
      setText("#mixUiHeatAvailable", (mix.heatAvailable ?? mix.ha) ? "ANO" : "NE");
      setText("#mixUiNextDecision", Number.isFinite(nextMs) ? `${Math.ceil(nextMs/1000)} s` : "--");
      setText("#mixUiPositionTrust", (mix.positionTrusted ?? mix.pt) ? "referencovaná" : "pouze odhad");
      const modelValid = mix.hydraulicModelValid ?? mix.hm;
      const modelReason = String(mix.hydraulicModelReason ?? mix.hmr ?? "");
      const reachable = mix.targetReachable ?? mix.rch;
      const reachReason = String(mix.targetReachabilityReason ?? mix.rchr ?? "");
      const modelLabel = modelValid === true ? "OK" : modelReason === "a_not_hotter" ? "A ≤ B" : modelReason === "insufficient_span" ? "malé ΔT" : "nedostupný";
      const reachableLabel = modelValid !== true ? "nelze určit" : reachable === true ? "ANO" : reachReason === "target_above_a" ? "NE • cíl > A" : reachReason === "target_below_b" ? "NE • cíl < B" : "NE";
      setText("#mixUiHydraulicModel", modelLabel);
      setText("#mixUiReachable", reachableLabel);

      setText("#mixCalTravelTime", `B→A ${(travelToAMs/1000).toLocaleString("cs-CZ", {maximumFractionDigits:1})} s • A→B ${(travelToBMs/1000).toLocaleString("cs-CZ", {maximumFractionDigits:1})} s`);
      setText("#mixCalState", mix.lastCalibrationEnd ? mixCalibrationLabel(mix.lastCalibrationEnd) : ((mix.positionTrusted ?? mix.pt) ? "poloha referencována" : "bez reference"));
      const calStatus = document.getElementById("mixCalStatus");
      const trusted = !!(mix.positionTrusted ?? mix.pt);
      if(calStatus){
        calStatus.classList.toggle("ok", trusted);
        calStatus.classList.toggle("warn", !trusted);
        const title = calStatus.querySelector("strong");
        const note = calStatus.querySelector("small");
        if(title) title.textContent = trusted ? "Odhad polohy je referencovaný" : "Poloha zatím není referencovaná";
        if(note) note.textContent = trusted ? "Časové procento vychází z posledního potvrzeného krajního bodu." : "Pro přesnější procenta proveďte kalibraci A nebo B.";
      }
      setText("#mixCalChartLabel", `${directionText.toLowerCase()} • ${Math.round(pct)} %`);
      drawMixCalibrationChart(document.getElementById("mixCalChart"), pct, chartTravelMs, dir === "a" ? "open" : dir === "b" ? "close" : "idle");
    }

    function renderOverviewMixStatus(values){
      const pct = clamp(Number(values?.pct) || 0, 0, 100);
      const mix = state.mixStatus || state.eqFast?.mix || {};
      const rawState = String(mix.state || mix.st || "startup");
      const meta = mixStateMeta(rawState);
      const dir = String(mix.direction || mix.dir || "stop").toLowerCase();
      const direction = { text: dir === "a" ? "→ A / tepleji" : dir === "b" ? "→ B / chladněji" : meta.label, kind: meta.fault ? "fault" : (meta.blocked ? "blocked" : (dir === "a" ? "open" : dir === "b" ? "close" : "idle")) };

      setText("#mixOvPosition", `${Math.round(pct)} %`);
      setText("#mixOvDirection", direction.text);
      const directionEl = document.getElementById("mixOvDirection");
      if(directionEl) directionEl.dataset.kind = direction.kind;

      const arc = document.getElementById("mixOvGaugeArc");
      if(arc) arc.style.strokeDasharray = `${pct} ${100-pct}`;

      const temps = [
        ["mixOvSupplyTemp", values?.supplyC],
        ["mixOvReturnTemp", values?.returnC],
        ["mixOvOutputTemp", values?.outputC],
        ["mixOvTargetTemp", values?.targetC],
      ];
      temps.forEach(([id,val]) => setText(`#${id}`, fmtNum(Number(val), 1)));
    }

    function renderMixBadge(){
      const mix = state.mixStatus || state.eqFast?.mix || {};
      const meta = mixStateMeta(mix.state || mix.st || "startup");
      const manual = !!(mix.movingManual ?? mix.man);
      const remainingMs = firstFinite(mix.pulseRemainingMs, mix.prm);
      let label = `mix: ${meta.label}`;
      if(manual) label += " • ruční zásah";
      if(Number.isFinite(remainingMs) && remainingMs > 0) label += ` • zbývá ${Math.ceil(remainingMs/1000)} s`;
      setBadge("#hMixState", meta.kind, label);
      const warn = document.getElementById("hMixWarn");
      if(warn){
        const modelValid = mix.hydraulicModelValid ?? mix.hm;
        const modelReason = String(mix.hydraulicModelReason ?? mix.hmr ?? "");
        const targetReachable = mix.targetReachable ?? mix.rch;
        const reachReason = String(mix.targetReachabilityReason ?? mix.rchr ?? "");
        if(meta.fault) setBadge("#hMixWarn", "bad", `varování: ${meta.label}`);
        else if(mix.floorProtectionActive ?? mix.fp) setBadge("#hMixWarn", "bad", "varování: ochrana podlahy");
        else if(meta.blocked && meta.raw !== "disabled") setBadge("#hMixWarn", "warn", `omezení: ${meta.label}`);
        else if(modelValid === false && modelReason && modelReason !== "missing_a_or_b") setBadge("#hMixWarn", "warn", `A/B model: ${modelReason === "a_not_hotter" ? "A není teplejší než B" : "malý rozdíl A-B"}`);
        else if(modelValid === true && targetReachable === false && reachReason && reachReason !== "model_invalid") setBadge("#hMixWarn", "warn", `dosažitelnost cíle: ${reachReason === "target_above_a" ? "cíl je nad A" : "cíl je pod B"}`);
        else setBadge("#hMixWarn", "", "varování: žádné");
      }
      const enabled = !!(mix.enabled ?? mix.en ?? state.mixConfig?.enabled);
      const toggle = document.getElementById("hMixToggleAuto");
      if(toggle){
        toggle.dataset.enabled = enabled ? "1" : "0";
        toggle.textContent = enabled ? "Vypnout automatiku" : "Zapnout automatiku";
      }
      renderMixCalibrationInfo();
    }

    function renderMixCalibrationInfo(){
      const el = document.getElementById("hMixDiag");
      if(!el) return;
      const mix = state.mixStatus || state.eqFast?.mix || {};
      const meta = mixStateMeta(mix.state || mix.st || "startup");
      const parts = [`stav: ${meta.label}`];
      const pct = firstFinite(mix.positionPct, mix.pct);
      const responseDelta = firstFinite(mix.lastResponseDeltaC);
      const learnedRise = firstFinite(mix.learnedRiseCPerPct);
      const learnedFall = firstFinite(mix.learnedFallCPerPct);
      const pulseStep = firstFinite(mix.pulseStepPct);
      const relayMask = firstFinite(mix.relayMask);
      if(Number.isFinite(pct)) parts.push(`odhad ${fmtNum(pct,1)} %${(mix.positionTrusted ?? mix.pt) ? " ✓" : ""}`);
      if(Number.isFinite(pulseStep)) parts.push(`krok ${fmtNum(pulseStep,1)} %`);
      if(mix.responsePending ?? mix.rsp) parts.push("čeká na odezvu AB");
      if(Number.isFinite(responseDelta)) parts.push(`odezva ${responseDelta >= 0 ? "+" : ""}${fmtNum(responseDelta,2)} °C`);
      if(Number.isFinite(learnedRise)) parts.push(`učení A ${fmtNum(learnedRise,3)} °C/%`);
      if(Number.isFinite(learnedFall)) parts.push(`učení B ${fmtNum(learnedFall,3)} °C/%`);
      if(Number.isFinite(relayMask)) parts.push(`R1/R2 mask 0x${(Number(relayMask)&3).toString(16).toUpperCase()}`);
      const modelValid = mix.hydraulicModelValid ?? mix.hm;
      const modelReason = String(mix.hydraulicModelReason ?? mix.hmr ?? "");
      const targetReachable = mix.targetReachable ?? mix.rch;
      const reachReason = String(mix.targetReachabilityReason ?? mix.rchr ?? "");
      if(modelValid === true) parts.push("A/B model OK");
      else if(modelReason) parts.push(`A/B model: ${modelReason}`);
      if(modelValid === true && targetReachable === false && reachReason) parts.push(`dosažitelnost: ${reachReason}`);
      if(mix.reason || mix.rs) parts.push(`důvod: ${String(mix.reason || mix.rs)}`);
      el.textContent = parts.join(" • ");
    }

    function getHeatingConfigFromRoot(cfg){
      if(!cfg || typeof cfg !== "object") return null;
      return cfg.equitherm || null;
    }

    function normalizeHeatingFlowLimits(limitsLike){
      const rawMin = Number(limitsLike?.minFlowC);
      const rawMax = Number(limitsLike?.maxFlowC);
      let minFlowC = Number.isFinite(rawMin) ? rawMin : 22;
      let maxFlowC = Number.isFinite(rawMax) ? rawMax : 60;
      // OpenTherm ID49 contains writable bounds for Max CH setpoint (ID57),
      // not legal bounds for the normal CH control setpoint TSet (ID1). Do not
      // silently overwrite the user's minimum heating-water temperature here.
      minFlowC = clamp(minFlowC, 10, 90);
      maxFlowC = clamp(maxFlowC, 10, 90);
      if(maxFlowC < minFlowC) [minFlowC, maxFlowC] = [maxFlowC, minFlowC];
      return { minFlowC, maxFlowC };
    }

    async function heatingReloadConfigFromDevice(){
      // Heavier config handlers are more reliable sequentially on the device web server.
      const eqCfg = await api.fetchConfigSection("equitherm");
      const otCfg = await api.fetchConfigSection("opentherm");
      if(eqCfg){
        state.dev = state.dev || {};
        state.dev.eqCfgLoaded = true;
        applyEqConfigToForm(eqCfg, { force:true });
        setEqConfigDirty(false);
      }
      if(otCfg){
        state.dev = state.dev || {};
        state.dev.otCfgLoaded = true;
        applyOtConfigToForm(otCfg);
      }
      await refresh(false);
    }

    function renderHeatingOtInfo(){
      const maxEl = document.getElementById("hOtMaxBounds");
      const dhwEl = document.getElementById("hOtDhwBounds");
      const reqEl = document.getElementById("hOtReqInfo");
      const chBoundLo = Number(state.ot?.maxChBoundMinC);
      const chBoundHi = Number(state.ot?.maxChBoundMaxC);
      const dhwBoundLo = Number(state.ot?.dhwBoundMinC);
      const dhwBoundHi = Number(state.ot?.dhwBoundMaxC);
      const chCurrent = Number(state.ot?.maxChSetpointC);
      const dhwCurrent = Number(state.ot?.dhwSetpointC);
      const boilerMaxInput = document.getElementById("hBoilerMax");
      const minFlowInput = document.getElementById("hMin");
      const maxFlowInput = document.getElementById("hMax");

      if(maxEl){
        if(Number.isFinite(chBoundLo) || Number.isFinite(chBoundHi) || Number.isFinite(chCurrent)){
          const boundsTxt = (Number.isFinite(chBoundLo) || Number.isFinite(chBoundHi))
            ? `${fmtNum(chBoundLo, 1)}–${fmtNum(chBoundHi, 1)} °C`
            : "--";
          let txt = `OT Max CH (ID57): ${boundsTxt}`;
          if(Number.isFinite(chCurrent)) txt += ` • aktuálně ${fmtNum(chCurrent, 1)} °C`;
          maxEl.textContent = txt;
        }else{
          maxEl.textContent = "OT Max CH (ID57): --";
        }
      }

      if(dhwEl){
        if(Number.isFinite(dhwBoundLo) || Number.isFinite(dhwBoundHi) || Number.isFinite(dhwCurrent)){
          const boundsTxt = (Number.isFinite(dhwBoundLo) || Number.isFinite(dhwBoundHi))
            ? `${fmtNum(dhwBoundLo, 1)}–${fmtNum(dhwBoundHi, 1)} °C`
            : "--";
          let txt = `OT TUV (ID56): ${boundsTxt}`;
          if(Number.isFinite(dhwCurrent)) txt += ` • aktuálně ${fmtNum(dhwCurrent, 1)} °C`;
          dhwEl.textContent = txt;
        }else{
          dhwEl.textContent = "OT TUV (ID56): --";
        }
      }

      if(reqEl){
        const reqParts = [];
        const reqCh = firstFinite(state.ot?.reqWaterTempC, state.ot?.chSet);
        const reqDhw = firstFinite(state.ot?.reqDhwSetpointC, state.ot?.dhwSetpointC);
        if(Number.isFinite(reqCh)) reqParts.push(`CH ${fmtNum(reqCh, 1)} °C`);
        if(Number.isFinite(reqDhw)) reqParts.push(`TUV ${fmtNum(reqDhw, 1)} °C`);
        if(Number.isFinite(Number(state.ot?.modulationPct))) reqParts.push(`mod ${fmtNum(state.ot.modulationPct, 0)} %`);
        if(state.ot?.reason) reqParts.push(`stav ${state.ot.reason}`);
        reqEl.textContent = reqParts.length ? `OT požadavky: ${reqParts.join(" • ")}` : "OT požadavky: --";
      }

      if(boilerMaxInput){
        if(Number.isFinite(chBoundLo)) boilerMaxInput.min = String(chBoundLo);
        else boilerMaxInput.removeAttribute("min");
        if(Number.isFinite(chBoundHi)) boilerMaxInput.max = String(chBoundHi);
        else boilerMaxInput.removeAttribute("max");
        const titleParts = [];
        if(Number.isFinite(chBoundLo) || Number.isFinite(chBoundHi)) titleParts.push(`Povolený rozsah kotle: ${fmtNum(chBoundLo, 1)} až ${fmtNum(chBoundHi, 1)} °C`);
        if(Number.isFinite(chCurrent)) titleParts.push(`Aktuální ID57: ${fmtNum(chCurrent, 1)} °C`);
        boilerMaxInput.title = titleParts.join(" • ");
      }

      [minFlowInput, maxFlowInput].forEach((inputEl) => {
        if(!inputEl) return;
        inputEl.min = "10";
        inputEl.max = "90";
        const titleParts = ["Limit ekvitermního TSet (OpenTherm ID1)"];
        if(Number.isFinite(chBoundLo) || Number.isFinite(chBoundHi)) titleParts.push(`ID49 ${fmtNum(chBoundLo, 1)}–${fmtNum(chBoundHi, 1)} °C platí pouze pro Max CH (ID57)`);
        if(Number.isFinite(chCurrent)) titleParts.push(`Aktuální Max CH kotle: ${fmtNum(chCurrent, 1)} °C`);
        inputEl.title = titleParts.join(" • ");
      });
    }

    function buildWsUrl(){
      try{
        const base = normalizedApiBase();
        const u = new URL(base || window.location.href, window.location.href);
        u.protocol = (u.protocol === "https:") ? "wss:" : "ws:";
        // Firmware uses WebSocketsServer on dedicated port 81, not HTTP path /ws.
        u.port = "81";
        u.pathname = "/";
        u.search = "";
        u.hash = "";
        return u.toString();
      }catch(e){
        log("ws base parse error: " + (e.message || e));
      }
      const proto = (window.location.protocol === "https:") ? "wss:" : "ws:";
      const host = window.location.hostname || window.location.host;
      return `${proto}//${host}:81/`;
    }

    function stopFallbackPolling(){
      if(timer){
        clearInterval(timer);
        timer = null;
      }
    }

    function startFallbackPolling(intervalMs=10000){
      const safeMs = Math.max(3000, Number(intervalMs) || 10000);
      stopFallbackPolling();
      timer = setInterval(() => refresh(false), safeMs);
    }

    function closeWs(){
      const ws = ensureWsState();
      stopWsWatchdog();
      if(ws.retryTimer){
        clearTimeout(ws.retryTimer);
      }
      const sock = ws.sock;
      if(sock){
        try{
          ws.manualClose = true;
          sock.onopen = null;
          sock.onmessage = null;
          sock.onerror = null;
          sock.onclose = null;
          if(sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING){
            sock.close();
          }
        }catch(e){}
      }
      state.ws = {
        sock:null,
        připojeno:false,
        retryTimer:null,
        reconnectMs:Number(ws.reconnectMs || 2000),
        manualClose:false,
        failCount:Number(ws.failCount || 0),
        disabledUntilMs:Number(ws.disabledUntilMs || 0),
        lastMessageMs:0,
        lastSeq:0,
        watchdogTimer:null,
      };
    }

    function scheduleWsReconnect(){
      const ws = ensureWsState();
      if(ws.manualClose) return;
      if(wsReconnectPaused()) return;
      if(ws.retryTimer) return;
      const delay = Math.max(1000, Math.min(15000, Number(ws.reconnectMs || 2000)));
      ws.retryTimer = setTimeout(() => {
        ws.retryTimer = null;
        connectWs();
      }, delay);
      ws.reconnectMs = Math.min(delay * 2, 15000);
    }

    function connectWs(){
      const ws = ensureWsState();
      const existing = ws.sock;
      if(existing){
        if(existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING) return;
        if(existing.readyState === WebSocket.CLOSING) return;
      }
      if(wsReconnectPaused()){
        setApiHealth("warn", "API: polling (WS pauza)");
        updateRefreshCadence();
        return;
      }
      ws.manualClose = false;
      let sock = null;
      try{
        sock = new WebSocket(buildWsUrl());
      }catch(e){
        log("ws open error: " + (e.message || e));
        setApiHealth("warn", "API: WS chyba");
        startFallbackPolling(computeOfflinePollMs());
        ws.failCount = Math.min(10, Number(ws.failCount || 0) + 1);
        if(ws.failCount >= 6) wsPauseReconnect(30000, "too_many_open_failures");
        else scheduleWsReconnect();
        return;
      }

      ws.sock = sock;
      ws.připojeno = false;
      setApiHealth("warn", "API: WS připojuji…");

      sock.onopen = () => {
        const live = ensureWsState();
        live.připojeno = true;
        live.reconnectMs = 2000;
        live.failCount = 0;
        live.disabledUntilMs = 0;
        live.lastMessageMs = Date.now();
        live.lastSeq = 0;
        startWsWatchdog();
        updateRefreshCadence();
        setApiHealth("good", "API: WebSocket");
        requestWsFullSync("open");
        log("ws připojeno");
      };

      sock.onmessage = (ev) => {
        try{
          const msg = JSON.parse(ev.data);
          const live = ensureWsState();
          live.lastMessageMs = Date.now();

          if(msg?.type === "mix_ack"){
            const id = Number(msg?.id || 0);
            const pending = mixWsPending.get(id);
            if(pending){
              clearTimeout(pending.timer);
              mixWsPending.delete(id);
              if(msg?.ok && msg?.relayAppliedNow){
                pending.resolve(msg);
              }else{
                pending.reject(new Error(String(msg?.err || "relay_not_verified")));
              }
            }
            if(Number.isFinite(Number(msg?.relayMask))){
              state.eqFast = state.eqFast || {};
              state.eqFast.mix = state.eqFast.mix || {};
              state.eqFast.mix.relayMask = Number(msg.relayMask);
              state.eqFast.mix.relayApplyOk = !!msg.relayAppliedNow;
            }
            return;
          }

          const seq = Number(msg?.seq || 0);
          if(seq > 0){
            if(msg?.type === "fast_patch" && live.lastSeq > 0 && seq !== live.lastSeq + 1){
              log(`ws seq gap: ${live.lastSeq} -> ${seq}`);
              requestWsFullSync("seq_gap");
              return;
            }
            live.lastSeq = seq;
          }
          const fast = normalizeFastMessage(msg);
          if(!fast || typeof fast !== "object") return;
          applyFastSnapshot(fast);
          setApiHealth("good", "API: WebSocket");
        }catch(e){
          log("ws message error: " + (e.message || e));
        }
      };

      sock.onerror = () => {
        setApiHealth("warn", "API: WS chyba");
        if(maybeAdoptPageOriginBase("ws", true)){
          try{ sock.close(); }catch(e){}
        }
      };

      sock.onclose = () => {
        const live = ensureWsState();
        const manual = !!live.manualClose;
        live.připojeno = false;
        live.sock = null;
        settlePendingMixWsCommands("socket_closed");
        stopWsWatchdog();
        if(manual) return;
        live.failCount = Math.min(10, Number(live.failCount || 0) + 1);
        setApiHealth("warn", "API: polling");
        log(`ws odpojeno (${live.failCount})`);
        startFallbackPolling(computeOfflinePollMs());
        if(live.failCount >= 6) wsPauseReconnect(30000, "too_many_failures");
        else scheduleWsReconnect();
      };
    }

  // ----- OpenTherm advanced tools (scan + Data-ID RW)
state.otAdv = state.otAdv || { scan: null, profile: null, last: null, loading:false, lastRefreshMs:0 };

function otSetBadge(id, kind, text){
  const el = document.getElementById(id);
  if(!el) return;
  el.classList.remove("good","warn","bad");
  if(kind) el.classList.add(kind);
  el.childNodes.forEach(n => { if(n.nodeType===3) n.remove(); });
  el.appendChild(document.createTextNode(" " + text));
}

function otFmtVal(it){
  if(!it) return "--";
  if(it.f88 != null && isFinite(Number(it.f88))) return Number(it.f88).toFixed(2) + (it.unit ? " " + it.unit : "");
  if(it.s16 != null && isFinite(Number(it.s16))) return String(it.s16) + (it.unit ? " " + it.unit : "");
  if(it.upper != null || it.lower != null) return `${it.upper ?? "--"}/${it.lower ?? "--"}${it.unit ? " " + it.unit : ""}`;
  if(it.val != null) return "raw=" + it.val;
  return "--";
}

function otFmtRW(it){
  // very light hint based on meta info
  const id = Number(it?.id);
  if(!Number.isFinite(id)) return "--";
  // heuristics: common read-only IDs are most of them; keep simple
  // If scan has rwMask (ID6) we could decode, but that's beyond scope here.
  return (id === 1 || id === 56 || id === 57) ? "R/W" : "R";
}

function otProfileSupportedSet(profileJson){
  const p = profileJson?.profile || profileJson?.scan || {};
  const items = Array.isArray(p?.items) ? p.items : [];
  const ids = Array.isArray(p?.supportedIds) ? p.supportedIds : [];
  const set = new Set(ids.map(Number));
  items.forEach(it => { if(it && (it.supported !== false)) set.add(Number(it.id)); });
  return set;
}

function otApplyProfileVisibility(profileJson){
  const p = profileJson?.profile || profileJson?.scan || {};
  const hasProfile = !!(p?.hasProfile ?? profileJson?.exists) && (Array.isArray(p?.items) || Array.isArray(p?.supportedIds));
  otSetBadge("otProfileBadge", hasProfile ? "good" : "", hasProfile ? `profil: ${Number(p?.supportedCount ?? 0)} ID` : "profil: není");
  const supported = otProfileSupportedSet(profileJson);
  document.querySelectorAll("[data-ot-id]").forEach(el => {
    const id = Number(el.getAttribute("data-ot-id"));
    if(!hasProfile || !Number.isFinite(id)){
      el.hidden = false;
      return;
    }
    el.hidden = !(supported.has(id) || id === 0 || id === 3);
  });
}

async function otProfileRefresh(){
  try{
    const j = await api.getJson("/api/opentherm/scan/profile");
    state.otAdv.profile = j;
    otApplyProfileVisibility(j);
  }catch(e){
    state.otAdv.profile = { ok:false, exists:false };
    otApplyProfileVisibility(state.otAdv.profile);
    log("otProfileRefresh error: " + (e.message || e));
  }
}

function otRenderScan(scanJson){
  const badge = document.getElementById("otScanBadge");
  const tbl = document.getElementById("otScanTbl");
  if(!tbl) return;

  const scan = scanJson?.scan || {};
  const active = !!scan.active;
  const done = !!scan.done;
  const cur = Number(scan.curId ?? 0);
  const end = Number(scan.endId ?? 127);
  const sup = Number(scan.supportedCount ?? 0);
  const stateTxt = active ? `běží (${cur}/${end})` : (done ? `hotovo (supported: ${sup})` : "neaktivní");
  otSetBadge("otScanBadge", active ? "warn" : (done ? "good" : ""), "scan: " + stateTxt);

  const showAll = !!document.getElementById("otScanShowAll")?.checked;
  const items = Array.isArray(scan.items) ? scan.items : [];
  const view = showAll ? items : items.filter(x => !!x.supported);

  if(!view.length){
    tbl.innerHTML = `<tr><td colspan="7" class="muted">Žádná data. Klikni „Start“ nebo „Načíst stav“.</td></tr>`;
    return;
  }

  tbl.innerHTML = view.map(it => {
    const sup2 = it.supported ? '<span class="badge good"><span class="b"></span>ANO</span>' : '<span class="badge"><span class="b"></span>NE</span>';
    const rs = escapeHtml(String(it.rs ?? "--"));
    const typ = it.isTemp ? "temp" : (it.unit ? "val" : "--");
    return `<tr>
      <td class="mono">${escapeHtml(it.id)}</td>
      <td><strong>${escapeHtml(it.name || ("ID"+it.id))}</strong><div class="muted">${escapeHtml(it.desc || "")}</div></td>
      <td class="mono">${escapeHtml(otFmtRW(it))}</td>
      <td class="mono">${escapeHtml(typ)}</td>
      <td class="mono">${escapeHtml(otFmtVal(it))}</td>
      <td class="mono">${rs}</td>
      <td>${sup2}</td>
    </tr>`;
  }).join("");
}

async function otScanRefresh(force=false){
  const now = Date.now();
  if(state.otAdv?.loading) return;
  if(!force && (now - Number(state.otAdv?.lastRefreshMs || 0)) < 4000) return;
  state.otAdv.loading = true;
  try{
    const showAll = !!document.getElementById("otScanShowAll")?.checked;
    const j = await api.getJson("/api/opentherm/scan/status" + (showAll ? "?all=1" : ""), 3500);
    state.otAdv.scan = j;
    state.otAdv.lastRefreshMs = Date.now();
    otRenderScan(j);
    if(j?.scan?.profileSaved || j?.scan?.done) await otProfileRefresh();
  }catch(e){
    otSetBadge("otScanBadge", "bad", "scan: chyba");
    toast("OpenTherm scan", e.message || String(e), "⚠");
    log("otScanRefresh error: " + (e.message || e));
  }finally{
    state.otAdv.loading = false;
  }
}

async function otScanStart(){
  try{
    const includeAll = !!document.getElementById("otScanIncludeAll")?.checked;
    const delayMs = clamp(Number(document.getElementById("otScanDelay")?.value ?? 60), 10, 500);
    await api.postJson("/api/opentherm/scan/start", { includeAll, delayMs });
    toast("OpenTherm scan", "Start.", "✅");
    await otScanRefresh();
  }catch(e){
    toast("OpenTherm scan", e.message || String(e), "⚠");
    log("otScanStart error: " + (e.message || e));
  }
}

async function otScanStop(){
  try{
    await api.postJson("/api/opentherm/scan/stop", {});
    toast("OpenTherm scan", "Stop.", "🛑");
    await otScanRefresh();
  }catch(e){
    toast("OpenTherm scan", e.message || String(e), "⚠");
    log("otScanStop error: " + (e.message || e));
  }
}

function otRwOut(obj){
  const pre = document.getElementById("otRwOut");
  if(pre) pre.textContent = JSON.stringify(obj ?? {}, null, 2);
}

function parseIntAny(s){
  const t = String(s ?? "").trim();
  if(!t) return NaN;
  if(/^0x/i.test(t)) return parseInt(t, 16);
  return parseInt(t, 10);
}

async function otRwRead(){
  try{
    const id = clamp(Number(document.getElementById("otRwId")?.value ?? 0), 0, 127);
    const reqValue = clamp(Number(document.getElementById("otRwReq")?.value ?? 0), 0, 65535);
    otSetBadge("otRwBadge", "warn", "RW: čtu…");
    const j = await api.postJson("/api/opentherm/dataid/read", { id, reqValue });
    otRwOut(j);
    otSetBadge("otRwBadge", (j?.ok ? "good" : "bad"), "RW: čtení " + (j?.ok ? "OK" : "ERR"));
  }catch(e){
    otSetBadge("otRwBadge", "bad", "RW: chyba");
    toast("OpenTherm read", e.message || String(e), "⚠");
    log("otRwRead error: " + (e.message || e));
  }
}

async function otRwWrite(){
  try{
    const id = clamp(Number(document.getElementById("otRwId")?.value ?? 0), 0, 127);
    const fmt = document.getElementById("otRwFmt")?.value || "f88";
    const valRaw = String(document.getElementById("otRwVal")?.value ?? "").trim();
    const payload = { id };
    if(fmt === "f88"){
      const v = Number(valRaw);
      if(!Number.isFinite(v)) throw new Error("Neplatná hodnota (float).");
      payload.valueF88 = v;
    }else if(fmt === "raw"){
      const v = parseIntAny(valRaw);
      if(!Number.isFinite(v)) throw new Error("Neplatná hodnota (raw).");
      payload.valueRaw = clamp(v, 0, 65535);
    }else{
      // hb/lb: accept "HB,LB" or "HB LB"
      const parts = valRaw.split(/[\s,;]+/).filter(Boolean);
      if(parts.length < 2) throw new Error("Zadej HB a LB (např. 0x3C 0x00).");
      const hb = clamp(parseIntAny(parts[0]), 0, 255);
      const lb = clamp(parseIntAny(parts[1]), 0, 255);
      payload.hb = hb; payload.lb = lb;
    }

    otSetBadge("otRwBadge", "warn", "RW: zapisuji…");
    const j = await api.postJson("/api/opentherm/dataid/write", payload);
    otRwOut(j);
    otSetBadge("otRwBadge", (j?.ok ? "good" : "bad"), "RW: zápis " + (j?.ok ? "OK" : "ERR"));
    // refresh fast snapshot soon
    refresh(false);
  }catch(e){
    otSetBadge("otRwBadge", "bad", "RW: chyba");
    toast("OpenTherm write", e.message || String(e), "⚠");
    log("otRwWrite error: " + (e.message || e));
  }
}



    // ----- Rendering
    function fmtTs(ts){ return new Date(ts).toLocaleTimeString("cs-CZ"); }
    function fmtMaybeNumber(v, digits=1, suffix=""){
      const n = Number(v);
      return Number.isFinite(n) ? n.toFixed(digits) + suffix : "--";
    }

    function mergeFastSnapshot(base, patch){
      const out = Object.assign({}, base || {});
      if(!patch || typeof patch !== "object") return out;
      for(const [k, v] of Object.entries(patch)){
        if(v && typeof v === "object" && !Array.isArray(v)){
          out[k] = Object.assign({}, (out[k] && typeof out[k] === "object") ? out[k] : {}, v);
        }else{
          out[k] = v;
        }
      }
      return out;
    }

    function normalizeFastMessage(msg){
      if(!msg || typeof msg !== "object") return null;
      if(msg.fast && typeof msg.fast === "object") return msg.fast;
      if(msg.type === "fast_full" && msg.data && typeof msg.data === "object") return msg.data;
      if(msg.type === "fast_patch" && msg.changed && typeof msg.changed === "object"){
        state.fast = mergeFastSnapshot(state.fast, msg.changed);
        return state.fast;
      }
      if(msg.ot || msg.eq || msg.dhw || msg.temps || msg.rel || msg.in) return msg;
      if(msg.data && typeof msg.data === "object") return msg.data;
      return null;
    }

    function syncOtDerived(){
      if(Number.isFinite(Number(state.ot.maxCapacityKw)) && Number.isFinite(Number(state.ot.modulationPct))){
        state.ot.currentPowerKw = Number(state.ot.maxCapacityKw) * Number(state.ot.modulationPct) / 100;
      }else if(!Number.isFinite(Number(state.ot.currentPowerKw))){
        state.ot.currentPowerKw = NaN;
      }
      if(!Number.isFinite(Number(state.ot.reqWaterTempC))){
        const eqReq = firstFinite(state.eqFast?.tb, state.eqFast?.tf);
        if(Number.isFinite(eqReq)) state.ot.reqWaterTempC = eqReq;
      }
    }

    function otMergeFieldLines(fields){
      const order = [
        ["chEnable", "CH enable"],
        ["dhwEnable", "TUV enable"],
        ["chSetpointC", "CH setpoint"],
        ["dhwSetpointC", "TUV setpoint"],
        ["maxModulationPct", "Max modulace"],
      ];
      const out = [];
      for(const [key, label] of order){
        const f = fields?.[key] || {};
        if(!f.set) continue;
        let v = f.value;
        if(v === null || v === undefined) v = "null";
        else if(typeof v === "boolean") v = v ? "true" : "false";
        else if(typeof v === "number") v = Number.isFinite(v) ? String(Number(v)) : "NaN";
        else v = String(v);
        out.push(`${label}: ${v}`);
      }
      return out.length ? out.join("\n") : "(žádné přepsání)";
    }

    function otEffectiveLines(eff){
      if(!eff || typeof eff !== "object") return "--";
      const out = [
        `Zdroj: ${String(eff.activeSource || "--")}`,
        `CH enable: ${eff.chEnable ? "true" : "false"}`,
        `TUV enable: ${eff.dhwEnable ? "true" : "false"}`,
      ];
      if(eff.chSetpointC != null) out.push(`CH setpoint: ${Number(eff.chSetpointC)} °C`);
      if(eff.dhwSetpointC != null) out.push(`TUV setpoint: ${Number(eff.dhwSetpointC)} °C`);
      if(eff.maxModulationPct != null) out.push(`Max modulace: ${Number(eff.maxModulationPct)} %`);
      return out.join("\n");
    }

    function renderOtMerge(merge){
      state.ot = state.ot || {};
      state.ot.merge = merge || null;
      const manual = merge?.manual || null;
      const eq = merge?.equitherm || null;
      const dhw = merge?.dhw || null;
      const eff = merge?.effective || null;

      setText("#otMergeManualState", manual ? (manual.active ? "active" : "neaktivní") : "--");
      setText("#otMergeEqState", eq ? (eq.active ? "active" : "neaktivní") : "--");
      setText("#otMergeDhwState", dhw ? (dhw.active ? "active" : "neaktivní") : "--");
      setText("#otMergeEffectiveState", eff ? String((eff.activeSource === "dhw" ? "tuv" : eff.activeSource === "equitherm" ? "ekviterm" : eff.activeSource) || "--") : "--");
      setText("#otMergeManualOut", manual ? otMergeFieldLines(manual.fields) : "--");
      setText("#otMergeEqOut", eq ? otMergeFieldLines(eq.fields) : "--");
      setText("#otMergeDhwOut", dhw ? otMergeFieldLines(dhw.fields) : "--");
      setText("#otMergeEffectiveOut", eff ? otEffectiveLines(eff) : "--");

      let active = "--";
      let cls = "";
      if(eff?.activeSource){
        active = String(eff.activeSource);
        cls = active === "dhw" ? "warn" : (active === "equitherm" || active === "manual") ? "good" : "";
      }
      setBadge("#otMergeBadge", cls, `merge: ${active === "dhw" ? "tuv" : active === "equitherm" ? "ekviterm" : active}`);
    }

    function applyOtStatus(status){
      if(!status || typeof status !== "object") return;
      state.ot.present = readMaybeBool(status, "present", state.ot.present);
      const enabledFromStatus = readMaybeBool(status, "enabled", state.ot.enabled);
      state.ot.enabled = enabledFromStatus || !!state.ot.cfg?.enabled || !!state.ot.cfg?.enable;
      state.ot.ready = readMaybeBool(status, "ready", state.ot.ready);
      state.ot.linkOk = readMaybeBool(status, "linkOk", Number(status.lastUpdateMs || 0) > 0 || state.ot.linkOk);
      state.ot.fault = readMaybeBool(status, "fault", state.ot.fault);
      // Boiler fault is application data, not a communication failure.
      state.ot.comm = !!state.ot.present && !!state.ot.ready && !!state.ot.linkOk;
      state.ot.chSet = readMaybeNumber(status, "reqChSetpointC", state.ot.chSet);
      state.ot.reqWaterTempC = hasOwn(status, "reqChSetpointC")
        ? numOrNaN(status.reqChSetpointC)
        : state.ot.reqWaterTempC;
      if(!Number.isFinite(state.ot.reqWaterTempC)) state.ot.reqWaterTempC = firstFinite(state.eqFast?.tb, state.eqFast?.tf, state.ot.reqWaterTempC);
      state.ot.chTemp = readMaybeNumber(status, "boilerTempC", state.ot.chTemp);
      state.ot.returnTempC = readMaybeNumber(status, "returnTempC", state.ot.returnTempC);
      state.ot.dhwTemp = readMaybeNumber(status, "dhwTempC", state.ot.dhwTemp);
      state.ot.outsideTempC = readMaybeNumber(status, "outsideTempC", state.ot.outsideTempC);
      state.ot.pressure = readMaybeNumber(status, "pressureBar", state.ot.pressure);
      state.ot.modulationPct = readMaybeNumber(status, "modulationPct", state.ot.modulationPct);
      state.ot.maxChSetpointC = readMaybeNumber(status, "maxChSetpointC", state.ot.maxChSetpointC);
      state.ot.maxChBoundMinC = readMaybeNumber(status, "maxChBoundMinC", state.ot.maxChBoundMinC);
      state.ot.maxChBoundMaxC = readMaybeNumber(status, "maxChBoundMaxC", state.ot.maxChBoundMaxC);
      state.ot.dhwSetpointC = readMaybeNumber(status, "dhwSetpointC", state.ot.dhwSetpointC);
      state.ot.dhwBoundMinC = readMaybeNumber(status, "dhwBoundMinC", state.ot.dhwBoundMinC);
      state.ot.dhwBoundMaxC = readMaybeNumber(status, "dhwBoundMaxC", state.ot.dhwBoundMaxC);
      state.ot.reqDhwSetpointC = readMaybeNumber(status, "reqDhwSetpointC", state.ot.reqDhwSetpointC);
      if(hasOwn(status, "faultFlags")) state.ot.faultFlags = Number(status.faultFlags) || 0;
      if(hasOwn(status, "oemFaultCode")) state.ot.oemFaultCode = Number(status.oemFaultCode) || 0;
      state.ot.reason = readMaybeString(status, "reason", state.ot.reason);
      state.ot.lastCmd = readMaybeString(status, "lastCmd", state.ot.lastCmd);
      state.ot.statusRaw = Number(status.statusRaw || state.ot.statusRaw || 0);
      state.ot.dhwActive = readMaybeBool(status, "dhwActive", !!state.ot.dhwActive);
      state.ot.flameOn = readMaybeBool(status, "flameOn", !!state.ot.flameOn);
      state.ot.chActive = readMaybeBool(status, "chActive", !!state.ot.chActive);
      renderOtMerge(status.merge || null);
      syncOtDerived();
      renderHeatingOtInfo();
    }

    function setText(id, v){
      const el = $(id);
      if(!el) return;
      const next = String(v ?? "");
      if(el.textContent !== next) el.textContent = next;
    }
    function setBadge(id, kind, text){
      const el = $(id);
      if(!el) return;
      const nextKind = String(kind || "");
      const nextText = String(text ?? "");
      if(el.dataset.badgeKind === nextKind && el.dataset.badgeText === nextText) return;
      el.dataset.badgeKind = nextKind;
      el.dataset.badgeText = nextText;
      el.classList.remove("good","warn","bad");
      if(nextKind) el.classList.add(nextKind);
      let textNode = Array.from(el.childNodes).find(n => n.nodeType === Node.TEXT_NODE);
      if(!textNode){
        textNode = document.createTextNode("");
        el.appendChild(textNode);
      }
      textNode.textContent = " " + nextText;
    }


    // ----- Firmware adapter helpers (this repo)
    function setInputNumber(id, v, digits=1){
      const el = document.getElementById(id);
      if(!el) return;
      const n = Number(v);
      if(!Number.isFinite(n)) return;
      const next = n.toFixed(digits);
      if(el.value !== next && document.activeElement !== el) el.value = next;
    }
    function setInputBool(id, v){
      const el = document.getElementById(id);
      if(!el) return;
      const next = !!v;
      if(el.checked !== next) el.checked = next;
    }

    function collectMixingConfigFromForm(){
      const n = (id, fallback) => { const v = Number(document.getElementById(id)?.value); return Number.isFinite(v) ? v : fallback; };
      return {
        enabled: !!document.getElementById("hMixEnabled")?.checked,
        disabledAction: String(document.getElementById("hMixDisabledAction")?.value || "hold"),
        noHeatAction: String(document.getElementById("hMixNoHeatAction")?.value || "b"),
        openingDirection: String(document.getElementById("hMixOpeningDirection")?.value || "normal"),
        sourceA: String(document.getElementById("hMixSourceA")?.value || state.th?.mixingValve?.a || "mix_a_dallas"),
        sourceB: String(document.getElementById("hMixSourceB")?.value || state.th?.mixingValve?.b || "mix_b_dallas"),
        sourceAB: String(document.getElementById("hMixSourceAB")?.value || state.th?.mixingValve?.ab || "mix_ab_dallas"),
        sourceTank: String(document.getElementById("hMixSourceTank")?.value || state.th?.mixingValve?.tank || "tank_top"),
        tempMaxAgeMs: n("hMixTempMaxAgeMs", 600000),
        targetOffsetC: n("hMixTargetOffsetC", 0),
        deadbandC: n("hMixDeadband", 0.5),
        tankMinDeltaC: n("hMixTankMinDelta", 2),
        tankHysteresisC: n("hMixTankHysteresis", 1),
        controlPeriodMs: n("hMixControlPeriodMs", 15000),
        settleMinMs: n("hMixSettleMinMs", 5000),
        responseTimeoutMs: n("hMixResponseTimeoutMs", 30000),
        settleTrendCPerMin: n("hMixSettleTrend", 0.25),
        feedForwardEnabled: !!document.getElementById("hMixFeedForwardEnabled")?.checked,
        minMixSpanC: n("hMixMinMixSpan", 2),
        minStepPct: n("hMixMinStepPct", 1),
        maxStepPct: n("hMixMaxStepPct", 15),
        initialMaxStepPct: n("hMixInitialMaxStepPct", 25),
        proportionalPctPerC: n("hMixProportionalPctPerC", 4),
        learnResponse: !!document.getElementById("hMixLearnResponse")?.checked,
        inRangeAction: String(document.getElementById("hMixInRangeAction")?.value || "hold"),
        oppositeTrendAction: String(document.getElementById("hMixOppositeTrendAction")?.value || "wait_then_reverse"),
        travelToAMs: n("hMixTravelToAMs", 6000),
        travelToBMs: n("hMixTravelToBMs", 6000),
        calibrationSeatMs: n("hMixCalibrationSeatMs", 1500),
        manualPulseMs: n("hMixPulseMs", 600),
        manualHoldMs: n("hMixManualHoldMs", 30000),
        floorProtectionEnabled: !!document.getElementById("hMixFloorProtectionEnabled")?.checked,
        floorMaxC: n("hMixFloorProtectionMaxC", 45),
        floorReleaseHysteresisC: n("hMixFloorReleaseHysteresisC", 2),
        curve: {
          mode: String(document.getElementById("hMixCurveMode")?.value || "linear2"),
          day2: { outColdC:n("hMixDay2OutCold",-15), flowColdC:n("hMixDay2FlowCold",45), outWarmC:n("hMixDay2OutWarm",15), flowWarmC:n("hMixDay2FlowWarm",25) },
          night2: { outColdC:n("hMixNight2OutCold",-15), flowColdC:n("hMixNight2FlowCold",40), outWarmC:n("hMixNight2OutWarm",15), flowWarmC:n("hMixNight2FlowWarm",22) },
          day4: [n("hMixDayM20",45), n("hMixDayM10",40), n("hMixDay0",34), n("hMixDayP10",28)],
          night4: [n("hMixNightM20",40), n("hMixNightM10",36), n("hMixNight0",31), n("hMixNightP10",26)],
          minFlowC: n("hMixCurveMinFlow",22),
          maxFlowC: n("hMixCurveMaxFlow",60),
        },
      };
    }

    function copyWizardToMainForm(){
      const copy = (dstId, srcId, checked=false) => {
        const dst=document.getElementById(dstId), src=document.getElementById(srcId);
        if(!dst || !src) return;
        if(checked) dst.checked=!!src.checked; else dst.value=src.value;
      };
      copy("hMixEnabled","wizMixEnabled",true);
      copy("hMixDisabledAction","wizDisabledAction");
      copy("hMixNoHeatAction","wizNoHeatAction");
      copy("hMixOpeningDirection","wizOpeningDirection");
      copy("hMixSourceA","wizSourceA"); copy("hMixSourceB","wizSourceB"); copy("hMixSourceAB","wizSourceAB"); copy("hMixSourceTank","wizSourceTank");
      copy("hMixDeadband","wizDeadband"); copy("hMixTargetOffsetC","wizTargetOffset");
      copy("hMixTankMinDelta","wizTankMinDelta"); copy("hMixTankHysteresis","wizTankHysteresis");
      copy("hMixFeedForwardEnabled","wizFeedForward",true); copy("hMixLearnResponse","wizLearnResponse",true);
      copy("hMixMinStepPct","wizMinStep"); copy("hMixMaxStepPct","wizMaxStep"); copy("hMixInitialMaxStepPct","wizInitialMaxStep"); copy("hMixProportionalPctPerC","wizProportional");
      copy("hMixCurveMode","wizCurveMode"); copy("hMixCurveMinFlow","wizCurveMinFlow"); copy("hMixCurveMaxFlow","wizCurveMaxFlow");
      copy("hMixFloorProtectionEnabled","wizFloorProtection",true); copy("hMixFloorProtectionMaxC","wizFloorMax"); copy("hMixFloorReleaseHysteresisC","wizFloorReleaseHyst");
      const secToMs = (srcId,dstId,fallbackSec) => {
        const dst=document.getElementById(dstId); if(!dst) return;
        const sec=clamp(Number(document.getElementById(srcId)?.value || fallbackSec),0.05,900);
        dst.value=String(Math.round(sec*1000));
      };
      secToMs("wizTravelToASec","hMixTravelToAMs",6);
      secToMs("wizTravelToBSec","hMixTravelToBMs",6);
      secToMs("wizControlPeriodSec","hMixControlPeriodMs",15);
      secToMs("wizSettleMinSec","hMixSettleMinMs",5);
      secToMs("wizResponseTimeoutSec","hMixResponseTimeoutMs",30);
      state.th = state.th || {};
      state.th.mixingValve = normalizeMixingValveSources({
        a:document.getElementById("wizSourceA")?.value,
        b:document.getElementById("wizSourceB")?.value,
        ab:document.getElementById("wizSourceAB")?.value,
        tank:document.getElementById("wizSourceTank")?.value,
      });
      updateMixDirectionUi();
      syncMixCurveUi();
      setMixConfigDirty(true);
    }

    function syncWizardFromCurrentConfig(){
      renderMixConfigSourceSelectors();
      const mx = collectMixingConfigFromForm();
      const put = (id,v,checked=false) => { const el=document.getElementById(id); if(!el) return; if(checked) el.checked=!!v; else el.value=String(v ?? ""); };
      put("wizMixEnabled", mx.enabled, true);
      put("wizDisabledAction",mx.disabledAction); put("wizNoHeatAction",mx.noHeatAction); put("wizOpeningDirection",mx.openingDirection);
      put("wizSourceA",mx.sourceA); put("wizSourceB",mx.sourceB); put("wizSourceAB",mx.sourceAB); put("wizSourceTank",mx.sourceTank);
      ["wizSourceA","wizSourceB","wizSourceAB","wizSourceTank"].forEach(id => { const el=document.getElementById(id); if(el) el.dataset.wizardTouched="0"; });
      put("wizTravelToASec",Number(mx.travelToAMs || 6000)/1000); put("wizTravelToBSec",Number(mx.travelToBMs || 6000)/1000);
      put("wizControlPeriodSec",Number(mx.controlPeriodMs || 15000)/1000); put("wizSettleMinSec",Number(mx.settleMinMs || 5000)/1000); put("wizResponseTimeoutSec",Number(mx.responseTimeoutMs || 30000)/1000);
      put("wizDeadband",mx.deadbandC); put("wizTargetOffset",mx.targetOffsetC);
      put("wizTankMinDelta",mx.tankMinDeltaC); put("wizTankHysteresis",mx.tankHysteresisC);
      put("wizFeedForward",mx.feedForwardEnabled,true); put("wizLearnResponse",mx.learnResponse,true);
      put("wizMinStep",mx.minStepPct); put("wizMaxStep",mx.maxStepPct); put("wizInitialMaxStep",mx.initialMaxStepPct); put("wizProportional",mx.proportionalPctPerC);
      put("wizCurveMode",mx.curve?.mode || "linear2"); put("wizCurveMinFlow",mx.curve?.minFlowC ?? 22); put("wizCurveMaxFlow",mx.curve?.maxFlowC ?? 40);
      put("wizFloorProtection",mx.floorProtectionEnabled,true); put("wizFloorMax",mx.floorMaxC); put("wizFloorReleaseHyst",mx.floorReleaseHysteresisC);
      renderMixConfigSourceSelectors();
      syncWizardProfileUi();
    }

    function syncWizardProfileUi(){
      const floorEnabled=!!document.getElementById("wizFloorProtection")?.checked;
      ["wizFloorMax","wizFloorReleaseHyst"].forEach(id => { const el=document.getElementById(id); if(el) el.disabled=!floorEnabled; });
    }

    function setupWizardSummaryHtml(){
      copyWizardToMainForm();
      const mx=collectMixingConfigFromForm();
      const relayA=mixLogicalRelay("a"), relayB=mixLogicalRelay("b");
      const actionName={hold:"držet polohu",a:"A / 100 %",b:"B / 0 %"};
      const curveName=String(mx.curve?.mode || "linear2") === "tech_i3_4point" ? "4-bodová" : "2-bodová";
      const warnings=[];
      if(mx.enabled && (!mx.sourceAB || mx.sourceAB === "none")) warnings.push("Automatika je povolena, ale není vybráno hlavní regulační čidlo AB.");
      if(mx.enabled && (!mx.sourceTank || mx.sourceTank === "none")) warnings.push("Automatika je povolena, ale není vybráno čidlo akumulační nádrže.");
      if(mx.feedForwardEnabled && ((!mx.sourceA || mx.sourceA === "none") || (!mx.sourceB || mx.sourceB === "none"))) warnings.push("Feed-forward potřebuje platné zdroje A i B; bez nich regulátor přejde na čistou AB zpětnou vazbu.");
      if(!mx.enabled) warnings.push("Automatické řízení zůstane po dokončení vypnuté, dokud jej výslovně nezapnete.");
      const trusted=state.mixStatus?.positionTrusted ?? state.eqFast?.mix?.pt;
      return `<dl><div><dt>Automatika</dt><dd>${mx.enabled ? "POVOLENA" : "VYPNUTA"}</dd></div><div><dt>Relé A / B</dt><dd>R${relayA} / R${relayB}</dd></div><div><dt>Při vypnutí / bez tepla</dt><dd>${escapeHtml(actionName[mx.disabledAction] || mx.disabledAction)} / ${escapeHtml(actionName[mx.noHeatAction] || mx.noHeatAction)}</dd></div><div><dt>Zdroje A / B / AB / AKU</dt><dd>${escapeHtml(mx.sourceA)} / ${escapeHtml(mx.sourceB)} / ${escapeHtml(mx.sourceAB)} / ${escapeHtml(mx.sourceTank)}</dd></div><div><dt>Časy servopohonu</dt><dd>B→A ${(Number(mx.travelToAMs)/1000).toFixed(1)} s • A→B ${(Number(mx.travelToBMs)/1000).toFixed(1)} s</dd></div><div><dt>Regulační smyčka</dt><dd>perioda ${(mx.controlPeriodMs/1000).toFixed(1)} s • čekání ${(mx.settleMinMs/1000).toFixed(1)}–${(mx.responseTimeoutMs/1000).toFixed(1)} s • mrtvá zóna ±${Number(mx.deadbandC).toFixed(1)} °C</dd></div><div><dt>AKU povolení</dt><dd>cíl + ${Number(mx.tankMinDeltaC).toFixed(1)} °C • hystereze ${Number(mx.tankHysteresisC).toFixed(1)} °C</dd></div><div><dt>Kroky</dt><dd>${Number(mx.minStepPct).toFixed(1)}–${Number(mx.maxStepPct).toFixed(1)} % • úvodně max ${Number(mx.initialMaxStepPct).toFixed(1)} %</dd></div><div><dt>Ekvitermní cíl</dt><dd>${curveName} • limit ${Number(mx.curve?.minFlowC).toFixed(1)}–${Number(mx.curve?.maxFlowC).toFixed(1)} °C • offset ${Number(mx.targetOffsetC).toFixed(1)} °C</dd></div><div><dt>Kalibrovaná poloha</dt><dd>${trusted ? "ano" : "ne / pouze časový odhad"}</dd></div></dl>${warnings.length ? `<div class="wiz-summary-warnings">${warnings.map(x=>`<p>⚠ ${escapeHtml(x)}</p>`).join("")}</div>` : ""}`;
    }

    function setupWizardRenderStep(){
      const overlay=document.getElementById("setupWizardOverlay"); if(!overlay) return;
      const step=clamp(Number(state.ui?.wizardStep || 0),0,6); state.ui.wizardStep=step;
      document.querySelectorAll("[data-wiz-page]").forEach(el => { el.hidden=Number(el.dataset.wizPage)!==step; });
      document.querySelectorAll("[data-wiz-step]").forEach(el => { const n=Number(el.dataset.wizStep); el.classList.toggle("active",n===step); el.classList.toggle("done",n<step); });
      const sub=document.getElementById("setupWizardSubtitle"); if(sub) sub.textContent=`Krok ${step+1} z 7`;
      const progress=document.getElementById("setupWizardProgress"); if(progress) progress.style.width=`${((step+1)/7)*100}%`;
      const prev=document.getElementById("setupWizardPrev"), next=document.getElementById("setupWizardNext"), finish=document.getElementById("setupWizardFinish");
      if(prev) prev.disabled=step===0; if(next) next.hidden=step===6; if(finish) finish.hidden=step!==6;
      if(step===5) renderWizardCalibrationState();
      if(step===6){ const host=document.getElementById("setupWizardSummary"); if(host) host.innerHTML=setupWizardSummaryHtml(); }
      syncWizardProfileUi();
    }

    function setupWizardOpen(options={}){
      const overlay=document.getElementById("setupWizardOverlay"); if(!overlay) return;
      syncWizardFromCurrentConfig();
      state.ui.wizardStep=0;
      overlay.hidden=false;
      document.body.classList.add("wizard-open");
      const status=document.getElementById("setupWizardStatus"); if(status) status.textContent=options.auto ? "První nastavení nového regulátoru ještě není dokončeno." : "Změny ještě nejsou uložené.";
      setupWizardRenderStep();
    }

    function setupWizardClose(dismiss=true){
      const overlay=document.getElementById("setupWizardOverlay"); if(!overlay) return;
      overlay.hidden=true; document.body.classList.remove("wizard-open");
      if(dismiss) overlay.dataset.dismissed="1";
    }

    function setupWizardPayload(){
      copyWizardToMainForm();
      return { mixing:collectMixingConfigFromForm(), complete:false };
    }

    async function wizardApplyDraft(){
      const status=document.getElementById("setupWizardStatus");
      if(status) status.textContent="Aplikuji nastavení pro servisní test…";
      const payload=setupWizardPayload();
      const res=await api.saveSetupWizard(payload);
      state.dev = state.dev || {};
      state.dev.mixCfgLoaded=false;
      setMixConfigDirty(false);
      if(state.net) state.net.extrasDueMs=0;
      if(status) status.textContent="Nastavení bylo aplikováno do zařízení; průvodce ještě není označen jako dokončený.";
      return res;
    }

    function renderWizardCalibrationState(){
      const el=document.getElementById("wizCalibrationState"); if(!el) return;
      const mix=state.mixStatus || state.eqFast?.mix || {};
      const pos=firstFinite(mix.positionPct,mix.pct);
      const trusted=!!(mix.positionTrusted ?? mix.pt);
      const moving=!!(mix.moving ?? mix.mv);
      const end=String(mix.lastCalibrationEnd || "").toUpperCase();
      const stateLabel=mixStateMeta(mix.state || mix.st || "startup").label;
      el.textContent=`Stav: ${stateLabel}${moving ? " • pohyb" : ""}${Number.isFinite(pos) ? ` • poloha ~${pos.toFixed(1)} %` : ""}${trusted ? " • reference platná" : " • reference neověřena"}${end ? ` • poslední kalibrace ${end}` : ""}`;
    }

    async function setupWizardFinish(){
      const btn=document.getElementById("setupWizardFinish");
      return withButtonBusy(btn,"Ukládám…",async()=>{
        copyWizardToMainForm();
        const res=await api.saveSetupWizard({mixing:collectMixingConfigFromForm(),complete:true});
        state.setupWizard={...(state.setupWizard||{}),completed:true,completedVersion:Number(res?.completedVersion || 2),schemaVersion:2};
        setMixConfigDirty(false);
        if(state.net) state.net.extrasDueMs=0;
        await loadMixingConfigFromDevice();
        await heatingReloadConfigFromDevice();
        setupWizardClose(false);
        toast("Průvodce nastavením","Konfigurace nového regulátoru byla uložena.","✅");
      });
    }

    function syncMixUiVisibility(){
      syncMixCurveUi();
      updateMixDirectionUi();
    }

    function getEqChartConfig(){
      // The heating editor is authoritative for its own immediate preview.
      // Reading values from the mixing-valve form here previously made the
      // visible comfort/night curve ignore the slope and offset being edited.
      if(getActiveView() === "heating" && document.getElementById("hDaySlope")){
        const number = (id, fallback) => {
          const n = Number.parseFloat(document.getElementById(id)?.value ?? "");
          return Number.isFinite(n) ? n : fallback;
        };
        const minFlowC=number("hMin",22),maxFlowC=number("hMax",60);
        return {
          curveMode:"linear2",
          dayCurve:{slope:number("hDaySlope",1),shift:number("hDayShift",0)},
          nightCurve:{slope:number("hNightSlope",.7),shift:number("hNightShift",-5)},
          minFlowC:Math.min(minFlowC,maxFlowC),
          maxFlowC:Math.max(minFlowC,maxFlowC)
        };
      }
      const defaults = {
        curveMode: "linear2",
        dayCurve: { slope: 1.0, shift: 0 },
        nightCurve: { slope: 0.7, shift: -5 },
        minFlowC: 22,
        maxFlowC: 60,
      };
      const deviceCfg = buildEqChartConfigFromSource(state.dev?.eqCfgRaw || state.dev?.eqCfg || null, defaults);
      const mode=String(document.getElementById("hMixCurveMode")?.value || deviceCfg?.curveMode || "linear2").toLowerCase();
      const n=(id,fallback)=>{ const v=Number(document.getElementById(id)?.value); return Number.isFinite(v)?v:fallback; };
      const minFlowC=n("hMixCurveMinFlow",n("hMin",deviceCfg?.minFlowC ?? 22));
      const maxFlowC=n("hMixCurveMaxFlow",n("hMax",deviceCfg?.maxFlowC ?? 60));
      let formSource={ curveMode:mode, limits:{minFlowC,maxFlowC} };
      if(mode === "tech_i3_4point"){
        formSource.weather4={
          day:[n("hMixDayM20",45),n("hMixDayM10",40),n("hMixDay0",34),n("hMixDayP10",28)],
          night:[n("hMixNightM20",40),n("hMixNightM10",36),n("hMixNight0",31),n("hMixNightP10",26)],
        };
      }else{
        formSource.day={outColdC:n("hMixDay2OutCold",-20),flowColdC:n("hMixDay2FlowCold",45),outWarmC:n("hMixDay2OutWarm",20),flowWarmC:n("hMixDay2FlowWarm",21)};
        formSource.night={outColdC:n("hMixNight2OutCold",-20),flowColdC:n("hMixNight2FlowCold",43),outWarmC:n("hMixNight2OutWarm",20),flowWarmC:n("hMixNight2FlowWarm",15)};
      }
      return buildEqChartConfigFromSource(formSource, deviceCfg || defaults) || deviceCfg || defaults;
    }

    function eqConfigInputIds(){
      return [
        "hDaySlope","hDayShift","hNightSlope","hNightShift","hMin","hMax",
        "hWrite57","hBoilerMax","hEqModeCfg","hUseIn1NightOverride",
        "hSummerModeEnabled","hSummerOffAboveC","hSummerOnBelowC","hDriveNightRelay","hNightRelay",
        "hNightRelayOnWhenNight","hBoilerAssistEnabled","hBoilerAssistDeltaC","hBoilerAssistForceChEnable"
      ];
    }

    function setEqConfigDirty(v){
      state.ui = state.ui || {};
      state.ui.eqConfigDirty = !!v;
      if(v) markPendingSaveDirty("eq");
      else clearPendingSaveDirty("eq");
    }

    function mixConfigInputIds(){
      return [
        "hMixEnabled","hMixDisabledAction","hMixNoHeatAction","hMixOpeningDirection",
        "hMixSourceA","hMixSourceB","hMixSourceAB","hMixSourceTank","hMixTempMaxAgeMs",
        "hMixCurveMode","hMixCurveMinFlow","hMixCurveMaxFlow",
        "hMixDay2OutCold","hMixDay2FlowCold","hMixDay2OutWarm","hMixDay2FlowWarm",
        "hMixNight2OutCold","hMixNight2FlowCold","hMixNight2OutWarm","hMixNight2FlowWarm",
        "hMixDayM20","hMixDayM10","hMixDay0","hMixDayP10","hMixNightM20","hMixNightM10","hMixNight0","hMixNightP10",
        "hMixTargetOffsetC","hMixDeadband","hMixTankMinDelta","hMixTankHysteresis","hMixInRangeAction","hMixOppositeTrendAction",
        "hMixFeedForwardEnabled","hMixLearnResponse","hMixMinMixSpan","hMixMinStepPct","hMixMaxStepPct","hMixInitialMaxStepPct","hMixProportionalPctPerC",
        "hMixControlPeriodMs","hMixSettleMinMs","hMixResponseTimeoutMs","hMixSettleTrend",
        "hMixTravelToAMs","hMixTravelToBMs","hMixCalibrationSeatMs","hMixPulseMs","hMixManualHoldMs",
        "hMixFloorProtectionEnabled","hMixFloorProtectionMaxC","hMixFloorReleaseHysteresisC"
      ];
    }

    function setMixConfigDirty(v){
      state.ui = state.ui || {};
      state.ui.mixConfigDirty = !!v;
      if(v) markPendingSaveDirty("mixing");
      else clearPendingSaveDirty("mixing");
    }

    function applyEqConfigToForm(cfg, options={}){
      if(!cfg) return;
      const force = !!options.force;
      if(state.ui?.eqConfigDirty && !force) return;
      state.dev = state.dev || {};
      state.dev.eqCfgRaw = cfg;
      setInputBool("hEqEnabled", cfg?.enabled);
      state.dev.eqUsesOpenTherm = !!(cfg?.output?.useOpenTherm ?? state.dev.eqUsesOpenTherm ?? true);
      state.dev.eqCfg = buildEqChartConfigFromSource(cfg, {
        dayCurve: { slope: 1.0, shift: 0 },
        nightCurve: { slope: 0.7, shift: -5 },
        minFlowC: 22,
        maxFlowC: 60,
      }) || state.dev.eqCfg || null;
      // curve params (slope + shift), derived from firmware point config or read directly
      const dayCurve = normalizeEqCurve(cfg?.day, state.dev.eqCfg?.dayCurve);
      const nightCurve = normalizeEqCurve(cfg?.night, state.dev.eqCfg?.nightCurve);
      const limits = normalizeEqLimits(cfg?.limits, state.dev.eqCfg);
      setInputNumber("hDaySlope", dayCurve.slope, 2);
      setInputNumber("hDayShift", dayCurve.shift, 1);
      setInputNumber("hNightSlope", nightCurve.slope, 2);
      setInputNumber("hNightShift", nightCurve.shift, 1);

      // limits (flow temp clamp)
      const displayLimits = normalizeHeatingFlowLimits(limits);
      setInputNumber("hMin", displayLimits.minFlowC, 1);
      setInputNumber("hMax", displayLimits.maxFlowC, 1);

      // boiler max CH (ID57)
      setInputBool("hWrite57", cfg?.output?.applyBoilerMaxCh);
      setInputNumber("hBoilerMax", cfg?.output?.boilerMaxChC, 1);
      setInputBool("hDriveNightRelay", cfg?.output?.driveNightRelay);
      if(document.getElementById("hNightRelay") && Number.isFinite(Number(cfg?.output?.nightRelay))) document.getElementById("hNightRelay").value = String(Number(cfg.output.nightRelay));
      setInputBool("hNightRelayOnWhenNight", cfg?.output?.nightRelayOnWhenNight);
      setInputBool("hBoilerAssistEnabled", cfg?.boilerAssist?.enabled);
      setInputNumber("hBoilerAssistDeltaC", cfg?.boilerAssist?.deltaC ?? 5, 1);
      setInputBool("hBoilerAssistForceChEnable", cfg?.boilerAssist?.forceChEnable);

      if(document.getElementById("eqMode") && cfg?.mode) document.getElementById("eqMode").value = String(cfg.mode);
      if(document.getElementById("hEqModeCfg") && cfg?.mode) document.getElementById("hEqModeCfg").value = String(cfg.mode);
      setInputBool("hUseIn1NightOverride", cfg?.useIn1NightOverride);
      setInputBool("hSummerModeEnabled", cfg?.summerModeEnabled);
      setInputNumber("hSummerOffAboveC", cfg?.summerOffAboveC, 1);
      setInputNumber("hSummerOnBelowC", cfg?.summerOnBelowC, 1);
      renderEquithermEnableControls();
      if(cfg?.schedule?.week){
        state.schedules.heatingDay = Array.from({length:7}, () => []);
        for(const day of (cfg.schedule.week || [])){
          const di = ["mon","tue","wed","thu","fri","sat","sun"].indexOf(String(day?.day || "").toLowerCase());
          if(di < 0) continue;

          const out = [];
          if(Array.isArray(day?.intervals)){
            for(const iv of day.intervals){
              const s = Number(iv?.startMin);
              const e = Number(iv?.endMin);
              if(Number.isFinite(s) && Number.isFinite(e) && s !== e){
                out.push({ start: minsToTime(s), end: minsToTime(e) });
              }
              if(out.length >= HEATING_MAX_INTERVALS_PER_DAY) break;
            }
          }

          if(!out.length){
            const s = Number(day?.dayStartMin);
            const e = Number(day?.nightStartMin);
            if(Number.isFinite(s) && Number.isFinite(e) && s !== e){
              out.push({ start: minsToTime(s), end: minsToTime(e) });
            }
          }

          state.schedules.heatingDay[di] = out;
        }
        saveSchedules();
      }
      redrawEquithermViews();
      renderHeatingOtInfo();
    }

    function syncMixCurveUi(){
      const mode = String(document.getElementById("hMixCurveMode")?.value || "linear2");
      const two = document.getElementById("hMixCurve2Block");
      const four = document.getElementById("hMixCurve4Block");
      if(two) two.hidden = mode === "tech_i3_4point";
      if(four) four.hidden = mode !== "tech_i3_4point";
    }

    function applyMixingConfigToForm(cfg, options={}){
      if(!cfg || typeof cfg !== "object") return;
      const force=!!options.force;
      if(state.ui?.mixConfigDirty && !force) return;
      state.dev = state.dev || {};
      state.dev.mixCfgLoaded = true;
      state.dev.mixCfgRaw = cfg;
      state.mixConfig = cfg;
      state.th = state.th || {};
      state.th.mixingValve = normalizeMixingValveSources({
        a:cfg.sourceA ?? state.th.mixingValve?.a,
        b:cfg.sourceB ?? state.th.mixingValve?.b,
        ab:cfg.sourceAB ?? state.th.mixingValve?.ab,
        tank:cfg.sourceTank ?? state.th.mixingValve?.tank,
      });
      renderMixConfigSourceSelectors();
      setInputBool("hMixEnabled", cfg.enabled);
      const values = {
        hMixDisabledAction:cfg.disabledAction, hMixNoHeatAction:cfg.noHeatAction, hMixOpeningDirection:cfg.openingDirection,
        hMixSourceA:cfg.sourceA, hMixSourceB:cfg.sourceB, hMixSourceAB:cfg.sourceAB, hMixSourceTank:cfg.sourceTank,
        hMixInRangeAction:cfg.inRangeAction, hMixOppositeTrendAction:cfg.oppositeTrendAction,
      };
      for(const [id,value] of Object.entries(values)){ const el=document.getElementById(id); if(el && value != null) el.value=String(value); }
      const nums = {
        hMixTempMaxAgeMs:cfg.tempMaxAgeMs, hMixTargetOffsetC:cfg.targetOffsetC, hMixDeadband:cfg.deadbandC,
        hMixTankMinDelta:cfg.tankMinDeltaC, hMixTankHysteresis:cfg.tankHysteresisC, hMixControlPeriodMs:cfg.controlPeriodMs,
        hMixSettleMinMs:cfg.settleMinMs, hMixResponseTimeoutMs:cfg.responseTimeoutMs, hMixSettleTrend:cfg.settleTrendCPerMin,
        hMixMinMixSpan:cfg.minMixSpanC, hMixMinStepPct:cfg.minStepPct, hMixMaxStepPct:cfg.maxStepPct,
        hMixInitialMaxStepPct:cfg.initialMaxStepPct, hMixProportionalPctPerC:cfg.proportionalPctPerC,
        hMixTravelToAMs:cfg.travelToAMs, hMixTravelToBMs:cfg.travelToBMs, hMixCalibrationSeatMs:cfg.calibrationSeatMs,
        hMixPulseMs:cfg.manualPulseMs, hMixManualHoldMs:cfg.manualHoldMs, hMixFloorProtectionMaxC:cfg.floorMaxC,
        hMixFloorReleaseHysteresisC:cfg.floorReleaseHysteresisC,
      };
      for(const [id,value] of Object.entries(nums)) setInputNumber(id,value, (id.includes("Ms") ? 0 : 2));
      setInputBool("hMixFeedForwardEnabled", cfg.feedForwardEnabled ?? true);
      setInputBool("hMixLearnResponse", cfg.learnResponse ?? true);
      setInputBool("hMixFloorProtectionEnabled", cfg.floorProtectionEnabled ?? true);

      const curve = cfg.curve || {};
      const curveMode = String(curve.mode || "linear2");
      const cm = document.getElementById("hMixCurveMode"); if(cm) cm.value = curveMode;
      const d2=curve.day2||{}, n2=curve.night2||{};
      [["hMixDay2OutCold",d2.outColdC],["hMixDay2FlowCold",d2.flowColdC],["hMixDay2OutWarm",d2.outWarmC],["hMixDay2FlowWarm",d2.flowWarmC],
       ["hMixNight2OutCold",n2.outColdC],["hMixNight2FlowCold",n2.flowColdC],["hMixNight2OutWarm",n2.outWarmC],["hMixNight2FlowWarm",n2.flowWarmC],
       ["hMixCurveMinFlow",curve.minFlowC],["hMixCurveMaxFlow",curve.maxFlowC]]
        .forEach(([id,v])=>setInputNumber(id,v,1));
      const day4=Array.isArray(curve.day4)?curve.day4:[], night4=Array.isArray(curve.night4)?curve.night4:[];
      [["hMixDayM20",day4[0]],["hMixDayM10",day4[1]],["hMixDay0",day4[2]],["hMixDayP10",day4[3]],
       ["hMixNightM20",night4[0]],["hMixNightM10",night4[1]],["hMixNight0",night4[2]],["hMixNightP10",night4[3]]]
        .forEach(([id,v])=>setInputNumber(id,v,1));
      syncMixCurveUi();
      updateMixDirectionUi();
      if(cfg.runtime && !state.mixStatus) applyMixingStatus(cfg.runtime);
      renderMixBadge();
    }

    async function loadMixingConfigFromDevice(){
      const cfg = await api.fetchConfigSection("mixing");
      if(cfg){ applyMixingConfigToForm(cfg, {force:true}); setMixConfigDirty(false); }
      return cfg;
    }

    function applyOtConfigToForm(cfg){
      if(!cfg || isPendingSaveDirty("ot")) return;
      state.ot.cfg = state.ot.cfg || {};
      state.ot.cfg.enabled = !!cfg.enabled;
      state.ot.cfg.enable = state.ot.cfg.enabled;
      state.ot.enabled = !!cfg.enabled || !!state.ot.present;
      state.ot.cfg.pollMs = Number(cfg.pollMs ?? 2000);
      state.ot.cfg.mode = String(cfg.mode ?? "control");
      state.ot.cfg.boilerControl = String(cfg.boilerControl ?? state.ot.cfg.boilerControl ?? (state.ot.cfg.mode === "control" ? "opentherm" : "relay"));
      state.ot.cfg.allowRawWrite = !!cfg.allowRawWrite;
      state.ot.cfg.assumedMaxBoilerKw = Number(cfg.assumedMaxBoilerKw ?? state.ot.cfg.assumedMaxBoilerKw ?? 9);
      state.ot.cfg.rxPin = Number(cfg.rxPin ?? state.ot.cfg.rxPin ?? 48);
      state.ot.cfg.txPin = Number(cfg.txPin ?? state.ot.cfg.txPin ?? 47);
      state.ot.cfg.invertRx = !!cfg.invertRx;
      state.ot.cfg.invertTx = !!cfg.invertTx;
      state.ot.cfg.autoDetectLogic = cfg.autoDetectLogic === true;
      state.ot.cfg.transportProfile = String(cfg.transportProfile || "legacy-3.3.14");
      setText("#otLogicPolarity", `Transport ${state.ot.cfg.transportProfile} • RX GPIO${state.ot.cfg.rxPin} • TX GPIO${state.ot.cfg.txPin} • pevná polarita`);

      const en = document.getElementById("otEnable");
      if(en) en.checked = !!cfg.enabled;
      const poll = document.getElementById("otPoll");
      if(poll) poll.value = String(Number(cfg.pollMs ?? 2000));
      const mode = document.getElementById("otFailMode");
      if(mode) mode.value = String(cfg.mode ?? "control");
      const raw = document.getElementById("otLog");
      if(raw) raw.checked = !!cfg.allowRawWrite;
    }

function applyAlertsConfigToForm(cfg){
  if(isPendingSaveDirty("pressure")) return;
  const src = cfg?.alerts?.pressure || cfg?.pressure || {};
  state.alerts = state.alerts || {};
  state.alerts.pressure = Object.assign({}, state.alerts.pressure || {}, {
    enabled: ("enabled" in src) ? !!src.enabled : !!state.alerts?.pressure?.enabled,
    minBar: Number(src.minBar ?? state.alerts?.pressure?.minBar ?? 0.8),
    maxBar: Number(src.maxBar ?? state.alerts?.pressure?.maxBar ?? 2.8),
    hysteresisBar: Number(src.hysteresisBar ?? state.alerts?.pressure?.hysteresisBar ?? 0.05),
    active: ("active" in src) ? !!src.active : !!state.alerts?.pressure?.active,
    sensorValid: ("sensorValid" in src) ? !!src.sensorValid : !!state.alerts?.pressure?.sensorValid,
    pressureBar: numOrNaN(src.pressureBar ?? state.alerts?.pressure?.pressureBar),
    state: String(src.state ?? state.alerts?.pressure?.state ?? "init"),
  });

  const en = document.getElementById("pressAlarmEnable");
  const minEl = document.getElementById("pressAlarmMin");
  const maxEl = document.getElementById("pressAlarmMax");
  const hysEl = document.getElementById("pressAlarmHys");
  if(en) en.checked = !!state.alerts.pressure.enabled;
  if(minEl && Number.isFinite(state.alerts.pressure.minBar)) minEl.value = Number(state.alerts.pressure.minBar).toFixed(2);
  if(maxEl && Number.isFinite(state.alerts.pressure.maxBar)) maxEl.value = Number(state.alerts.pressure.maxBar).toFixed(2);
  if(hysEl && Number.isFinite(state.alerts.pressure.hysteresisBar)) hysEl.value = Number(state.alerts.pressure.hysteresisBar).toFixed(2);
}

function applyTimeConfigToForm(cfg){
  if(isPendingSaveDirty("time")) return;
  const src = cfg?.time || cfg || {};
  const ntp = Array.isArray(src.ntp) ? src.ntp : [];
  const en = document.getElementById("timeEnable");
  const tz = document.getElementById("timeTz");
  const n1 = document.getElementById("timeNtp1");
  const n2 = document.getElementById("timeNtp2");
  const n3 = document.getElementById("timeNtp3");
  const st = document.getElementById("timeStatusText");
  if(en) en.checked = !!src.enabled;
  if(tz) tz.value = String(src.tz || "");
  if(n1) n1.value = String(ntp[0] || "");
  if(n2) n2.value = String(ntp[1] || "");
  if(n3) n3.value = String(ntp[2] || "");
  if(st) st.textContent = src.valid ? `${src.iso || "čas platný"} • ${src.src || "SNTP"}` : `čas neplatný${src.src ? ` • ${src.src}` : ""}`;
  setBadge("#timeCfgBadge", src.valid ? "good" : (src.enabled ? "warn" : ""), `čas: ${src.valid ? "platný" : (src.enabled ? "čeká" : "vypnuto")}`);
}

async function timeLoad(options={}){
  const silent = !!options.silent;
  try{
    const cfg = await api.fetchConfigSection("time");
    applyTimeConfigToForm(cfg);
    if(!silent) toast("Čas", "Načteno.", "✅");
  }catch(e){
    setBadge("#timeCfgBadge", "bad", "čas: chyba");
    if(!silent) toast("Čas", e.message || String(e), "⚠");
    log("time load error: " + (e.message || e));
  }
}

async function timeSave(){
  const payload = {
    enabled: !!document.getElementById("timeEnable")?.checked,
    tz: String(document.getElementById("timeTz")?.value || "").trim(),
    ntp: [
      String(document.getElementById("timeNtp1")?.value || "").trim(),
      String(document.getElementById("timeNtp2")?.value || "").trim(),
      String(document.getElementById("timeNtp3")?.value || "").trim(),
    ].filter(Boolean)
  };
  await api.postConfigSection("time", payload);
  clearPendingSaveDirty("time");
  await timeLoad({ silent:true });
  await refresh(false);
  toast("Čas", "Nastavení uloženo.", "✅");
}

async function eventsLoad(options={}){
  const silent = !!options.silent;
  try{
    const j = await api.getJson("/api/events", 5000);
    const out = document.getElementById("eventsOut");
    const items = j?.events || j?.items || j || [];
    if(out) out.textContent = JSON.stringify(items, null, 2);
    setBadge("#eventsBadge", Array.isArray(items) && items.length ? "good" : "", `events: ${Array.isArray(items) ? items.length : 0}`);
    if(!silent) toast("Event log", "Načteno.", "✅");
  }catch(e){
    setBadge("#eventsBadge", "bad", "events: chyba");
    if(!silent) toast("Event log", e.message || String(e), "⚠");
    log("events load error: " + (e.message || e));
  }
}

async function historyLoad(options={}){
  const silent = !!options.silent;
  try{
    const j = await api.getJson("/api/history", 5000);
    const out = document.getElementById("historyOut");
    const items = j?.history || j?.items || j || [];
    if(out) out.textContent = JSON.stringify(items, null, 2);
    const count = Array.isArray(items) ? items.length : (Array.isArray(j?.samples) ? j.samples.length : 0);
    setBadge("#historyBadge", count ? "good" : "", `history: ${count}`);
    if(!silent) toast("Historie", "Načteno.", "✅");
  }catch(e){
    setBadge("#historyBadge", "bad", "history: chyba");
    if(!silent) toast("Historie", e.message || String(e), "⚠");
    log("history load error: " + (e.message || e));
  }
}

async function serviceIoCall(payload){
  await api.postJson("/api/service/io", payload, 5000);
  setBadge("#serviceIoBadge", "good", "service: odesláno");
}

    function minsToTime(v){
      const n = Math.max(0, Math.min(1439, Number(v || 0)));
      const hh = String(Math.floor(n / 60)).padStart(2, "0");
      const mm = String(n % 60).padStart(2, "0");
      return `${hh}:${mm}`;
    }

    function scheduleWeekToUi(week){
      const out = Array.from({length:7}, () => []);
      for(const day of (week || [])){
        const name = String(day?.day || "").toLowerCase();
        const di = ["mon","tue","wed","thu","fri","sat","sun"].indexOf(name);
        if(di < 0) continue;
        const arr = [];
        for(const iv of (day?.intervals || [])){
          const s = Number(iv?.startMin);
          const e = Number(iv?.endMin);
          if(!Number.isFinite(s) || !Number.isFinite(e) || s === e) continue;
          arr.push({ start: minsToTime(s), end: minsToTime(e) });
        }
        out[di] = arr;
      }
      return out;
    }

    function applyDhwConfigToForm(cfg){
      if(!cfg) return;
      if(isPendingSaveDirty("dhw") || isPendingSaveDirty("dhwPlan")) return;
      state.dev = state.dev || {};
      state.dev.dhwCfgRaw = cfg;
      const heat = cfg.heat || {};
      const circ = cfg.circ || {};
      if(document.getElementById("dhwEnable")) document.getElementById("dhwEnable").checked = !!cfg.enabled;
      if(document.getElementById("dhwDisableEqDuringHeat")) document.getElementById("dhwDisableEqDuringHeat").checked = true;
      if(document.getElementById("dhwMixValveAction")) document.getElementById("dhwMixValveAction").value = String(heat.mixValveAction || "close");
      if(document.getElementById("dhw2Target") && heat.targetTempC != null) document.getElementById("dhw2Target").value = String(Number(heat.targetTempC));
      if(document.getElementById("dhwRequestMode") && heat.requestMode) document.getElementById("dhwRequestMode").value = String(heat.requestMode);
      if(document.getElementById("dhwHysteresis") && heat.hysteresisC != null) document.getElementById("dhwHysteresis").value = String(Number(heat.hysteresisC));
      if(document.getElementById("dhwHeatUseInput")) document.getElementById("dhwHeatUseInput").checked = !!(heat.useInput ?? true);
      if(document.getElementById("dhwHeatUseSchedule")) document.getElementById("dhwHeatUseSchedule").checked = !!(heat.useSchedule ?? true);
      if(document.getElementById("dhwRelayRequest")) document.getElementById("dhwRelayRequest").checked = !!(heat.relayRequest ?? true);
      if(document.getElementById("dhwDriveValveRelay")) document.getElementById("dhwDriveValveRelay").checked = !!(heat.driveValveRelay ?? true);
      if(document.getElementById("dhwValveRelay") && heat.valveRelay != null) document.getElementById("dhwValveRelay").value = String(Number(heat.valveRelay));
      if(document.getElementById("dhwBoilerRelay") && heat.boilerRelay != null) document.getElementById("dhwBoilerRelay").value = String(Number(heat.boilerRelay));
      if(document.getElementById("dhwValveLeadMs") && heat.valveLeadMs != null) document.getElementById("dhwValveLeadMs").value = String(Number(heat.valveLeadMs));
      if(document.getElementById("dhwValveSwitchBackMs") && heat.valveSwitchBackMs != null) document.getElementById("dhwValveSwitchBackMs").value = String(Number(heat.valveSwitchBackMs));
      if(document.getElementById("dhwBoilerOffHoldMs") && heat.boilerOffHoldMs != null) document.getElementById("dhwBoilerOffHoldMs").value = String(Number(heat.boilerOffHoldMs));
      if(heat.schedule?.week) state.schedules.dhwHeat = scheduleWeekToUi(heat.schedule.week);
      if(circ.schedule?.week) state.schedules.dhwCirc = scheduleWeekToUi(circ.schedule.week);
      if(document.getElementById("dhwCircUseInput")) document.getElementById("dhwCircUseInput").checked = !!(circ.useInput ?? true);
      if(document.getElementById("dhwCircUseSchedule")) document.getElementById("dhwCircUseSchedule").checked = !!(circ.useSchedule ?? true);
      if(document.getElementById("dhwCircRelay") && circ.relay != null) document.getElementById("dhwCircRelay").value = String(Number(circ.relay));
      if(circ.pulseEnabled != null) state.circPulse.enable = !!circ.pulseEnabled;
      if(circ.pulseOnMin != null) state.circPulse.onMin = Number(circ.pulseOnMin);
      if(circ.pulseOffMin != null) state.circPulse.vypnutoMin = Number(circ.pulseOffMin);
      const al = cfg.antiLegionella || {};
      if(document.getElementById("dhwAntiLegEnabled")) document.getElementById("dhwAntiLegEnabled").checked = !!al.enabled;
      if(document.getElementById("dhwAntiLegWeekday") && al.weekday != null) document.getElementById("dhwAntiLegWeekday").value = String(Number(al.weekday));
      if(document.getElementById("dhwAntiLegStart") && al.startMin != null) document.getElementById("dhwAntiLegStart").value = minsToTime(al.startMin);
      if(document.getElementById("dhwAntiLegTarget") && al.targetTempC != null) document.getElementById("dhwAntiLegTarget").value = String(Number(al.targetTempC));
      if(document.getElementById("dhwAntiLegHold") && al.holdMin != null) document.getElementById("dhwAntiLegHold").value = String(Number(al.holdMin));
      setBadge("#dhwAntiLegBadge", al.enabled ? "good" : "", `AL: ${al.enabled ? "povoleno" : "vypnuto"}`);
      saveSchedules();
      saveCircPulse();
      ["dhwHeat","dhwCirc","heatingDay"].forEach(k => renderPlanner(k));
      const elPulse = document.getElementById("circPulseEnable");
      const elOn = document.getElementById("circPulseOn");
      const elOff = document.getElementById("circPulseOff");
      if(elPulse) elPulse.checked = !!state.circPulse.enable;
      if(elOn) elOn.value = String(Math.max(0, Number(state.circPulse.onMin ?? 5)));
      if(elOff) elOff.value = String(Math.max(0, Number(state.circPulse.vypnutoMin ?? 15)));
      updatePlannerStateBadges();
    }

    function applyEqStatus(status){
      if(!status || typeof status !== "object") return;
      state.eqStatus = status;
      state.eqFast = state.eqFast || {};
      const mode = status.mode || {};
      const time = status.time || {};
      const targets = status.targets || {};
      if(mode.requested != null || mode.req != null) state.eqFast.m = String(mode.requested ?? mode.req);
      if(mode.effective != null || mode.eff != null) state.eqFast.me = String(mode.effective ?? mode.eff);
      if(mode.scheduleUsed != null) state.eqFast.su = !!mode.scheduleUsed;
      if(mode.in1ForcingNight != null) state.eqFast.i1 = !!mode.in1ForcingNight;
      if(time.valid != null) state.eqFast.tv = !!time.valid;
      if(status.enabled != null) state.eqFast.en = !!status.enabled;
      if(status.active != null) state.eqFast.ac = !!status.active;
      if(status.reason != null) state.eqFast.rs = String(status.reason || "");
      const base = firstFinite(targets.baseFlowC, status.out?.targetBaseFlowC);
      const flow = firstFinite(targets.flowC, status.out?.targetFlowC);
      if(Number.isFinite(base)) state.eqFast.tb = base;
      if(Number.isFinite(flow)) state.eqFast.tf = flow;
      renderEquithermEnableControls();
    }

    function applyMixingStatus(status){
      if(!status || typeof status !== "object") return;
      state.mixStatus = status;
      state.eqFast = state.eqFast || {};
      state.eqFast.mix = state.eqFast.mix || {};
      const m = state.eqFast.mix;
      if(status.enabled != null) m.en=!!status.enabled;
      if(status.automaticAllowed != null) m.ac=!!status.automaticAllowed;
      if(status.heatAvailable != null) m.ha=!!status.heatAvailable;
      if(status.state != null) m.st=String(status.state);
      if(status.reason != null) m.rs=String(status.reason || "");
      if(status.direction != null) m.dir=String(status.direction || "stop");
      const mapNum = [["aC","ma"],["bC","mb"],["abC","mf"],["tankC","tk"],["baseTargetC","bt"],["targetC","tf"],["errorC","er"],["feedForwardPct","ff"],["positionPct","pct"],["trendCPerMin","tr"],["nextDecisionInMs","nd"]];
      for(const [src,dst] of mapNum) if(Number.isFinite(Number(status[src]))) m[dst]=Number(status[src]);
      if(status.positionTrusted != null) m.pt=!!status.positionTrusted;
      if(status.moving != null) m.mv=!!status.moving;
      if(status.movingManual != null) m.man=!!status.movingManual;
      if(status.pulseRemainingMs != null) m.prm=Number(status.pulseRemainingMs)||0;
      if(status.pulseElapsedMs != null) m.elp=Number(status.pulseElapsedMs)||0;
      if(status.responsePending != null) m.rsp=!!status.responsePending;
      if(status.floorProtectionActive != null) m.fp=!!status.floorProtectionActive;
      if(Number.isFinite(Number(m.pct))) state.accu.valve=Number(m.pct);
      if(Number.isFinite(Number(m.mf))) state.accu.after=Number(m.mf);
      renderMixBadge();
      renderMixCalibrationInfo();
    }

    function applyDhwStatus(status){
      if(!status || typeof status !== "object") return;
      state.dhwStatus = status;
      state.dhwFast = state.dhwFast || {};
      if(status.enabled != null) state.dhwFast.en = !!status.enabled;
      if(status.heatRequested != null) state.dhwFast.hr = !!status.heatRequested;
      if(status.heatActive != null) state.dhwFast.ha = !!status.heatActive;
      if(status.heatScheduleActive != null) state.dhwFast.hs = !!status.heatScheduleActive;
      if(status.heatInputActive != null) state.dhwFast.hi = !!status.heatInputActive;
      if(status.circRequested != null) state.dhwFast.cr = !!status.circRequested;
      if(status.circActive != null) state.dhwFast.ca = !!status.circActive;
      if(status.circScheduleActive != null) state.dhwFast.cs = !!status.circScheduleActive;
      if(status.circInputActive != null) state.dhwFast.ci = !!status.circInputActive;
      if(status.circPulseOn != null) state.dhwFast.cp = !!status.circPulseOn;
      if(status.boilerDhwMode != null) state.dhwFast.bm = !!status.boilerDhwMode;
      if(status.requestMode != null) state.dhwFast.rm = String(status.requestMode);
      if(status.heatPhase != null) state.dhwFast.hp = String(status.heatPhase);
      if(status.heatReason != null) state.dhwFast.hrs = String(status.heatReason);
      if(status.heatSequenceActive != null) state.dhwFast.hsq = !!status.heatSequenceActive;
      if(status.antiLegionellaDone != null) state.dhwFast.ald = !!status.antiLegionellaDone;
      if(status.tankTempC != null) state.dhwFast.tt = Number(status.tankTempC);
      if(status.targetTempC != null) state.dhwFast.tg = Number(status.targetTempC);
      if(status.valveRelayOn != null) state.dhwFast.vr = !!status.valveRelayOn;
      if(status.boilerRelayOn != null) state.dhwFast.br = !!status.boilerRelayOn;
      if(status.circRelayOn != null) state.dhwFast.rr = !!status.circRelayOn;
      if(status.otDhwEnable != null) state.dhwFast.ode = !!status.otDhwEnable;
      if(status.timeValid != null) state.dhwFast.tv = !!status.timeValid;
    }

    async function refreshOtCapacity(force=false){
      const now = Date.now();
      const activeView = getActiveView();
      const otViewActive = activeView === "opentherm" || activeView === "heating";
      if(!state.ot?.enabled || !state.ot?.ready) return state.ot.maxCapacityKw;
      if(!force && !otViewActive) return state.ot.maxCapacityKw;
      if(state.otMeta?.capacityFetching) return state.ot.maxCapacityKw;

      // Firmware now polls ID15 in the low-rate OT round-robin and exposes it in
      // /api/fast as ot.cp. Prefer that cached value; a direct bus request is only
      // a fallback and must not turn an unsupported optional ID into a UI error.
      if(Number.isFinite(Number(state.ot.maxCapacityKw)) && Number(state.ot.maxCapacityKw) > 0){
        return state.ot.maxCapacityKw;
      }

      const failAge = now - Number(state.otMeta?.capacityFailMs || 0);
      if(!force && failAge < 5 * 60 * 1000) return state.ot.maxCapacityKw;
      state.otMeta.capacityFetching = true;
      try{
        const j = await api.postJson("/api/opentherm/dataid/read", { id: 15, reqValue: 0 }, 3000);
        const kw = Number(j?.maxCapacityKw ?? j?.val?.maxCapacityKw);
        if(j?.ok && Number.isFinite(kw) && kw > 0){
          state.ot.maxCapacityKw = kw;
          state.otMeta.capacityFetchMs = now;
          state.otMeta.capacityFailMs = 0;
        }else{
          // ID15 is optional on some boilers. Use configured/known nominal
          // capacity instead of logging a false communication failure.
          const fallback = Number(state.ot?.cfg?.assumedMaxBoilerKw ?? state.ot.maxCapacityKw ?? 9);
          if(Number.isFinite(fallback) && fallback > 0) state.ot.maxCapacityKw = fallback;
          state.otMeta.capacityFailMs = now;
        }
      }catch(_e){
        const fallback = Number(state.ot?.cfg?.assumedMaxBoilerKw ?? state.ot.maxCapacityKw ?? 9);
        if(Number.isFinite(fallback) && fallback > 0) state.ot.maxCapacityKw = fallback;
        state.otMeta.capacityFailMs = now;
      }finally{
        state.otMeta.capacityFetching = false;
      }
      const mod = Number(state.ot.modulationPct);
      const kw = Number(state.ot.maxCapacityKw);
      state.ot.currentPowerKw = Number.isFinite(mod) && Number.isFinite(kw) ? (kw * mod / 100) : NaN;
      return state.ot.maxCapacityKw;
    }

    function applyFastSnapshot(fast){
      if(!fast || typeof fast !== "object") return;
      const firstFast = !(state.fast || state.last);
      state.fast = mergeFastSnapshot(state.fast, fast);
      thermaSetConnection("good", state.ws?.připojeno ? "WebSocket • živá data" : "API • aktuální data");
      applyFastToState(state.fast);
      try{ window.ThermaV5?.onFast(state); }catch(_e){}
      state.net = state.net || {};
      state.net.lastFastOkMs = Date.now();
      const sample = getUiSample();
      queueRenderSample(sample);
      if(firstFast){
        try{ document.dispatchEvent(new CustomEvent("ui:first-fast")); }catch(_e){}
      }
      // Sensor editors are persistent DOM controls. Replacing their rows on
      // every live frame destroys an open native select and unsaved choices.
      // Update only text-only live status from this fast snapshot.
      if(state.th?.loaded && getActiveView() === "thermometers"){
        for(const [port,id] of [["a","mixTempLiveA"],["b","mixTempLiveB"],["ab","mixTempLiveAB"]]){
          setText("#"+id, formatMixPortLive(port));
        }
      }
    }

    function getAfterMixTempFromTemps(temps){
      if(!temps || typeof temps !== "object") return NaN;
      return numOrNaN(firstFinite(
        temps.afterMixC,
        temps.flowReturnC,
        temps.returnFlowC,
        temps["return.flow"],
        temps.returnTempC,
        temps.return
      ));
    }

    function applyFastToState(fast){
      if(!fast) return;

      // Fast root/system snapshot
      state.dev = state.dev || {};
      if(fast.ip != null) state.dev.ip = String(fast.ip);
      const uptimeSec = firstFinite(fast?.system?.uptimeSec, fast?.sys?.uptimeSec, Number.isFinite(Number(fast?.ms)) ? Number(fast.ms) / 1000 : NaN);
      if(Number.isFinite(uptimeSec)){
        state.system = state.system || {};
        state.system.uptimeSec = Math.max(0, Math.floor(uptimeSec));
      }
      if(fast.rel && typeof fast.rel === "object" && hasOwn(fast.rel, "mask")){
        const mask = Number(fast.rel.mask) & 0xFF;
        state.dev.relMask = mask;
        state.io.relays = Array.from({length:8}, (_,k) => ((mask >> k) & 1) === 1);
      }
      if(fast.in && typeof fast.in === "object" && hasOwn(fast.in, "actMask")){
        const actMask = Number(fast.in.actMask) & 0xFF;
        state.io.inputs = Array.from({length:3}, (_,k) => ((actMask >> k) & 1) === 1);
      }
      if(fast.temps && typeof fast.temps === "object"){
        const temps = fast.temps;
        if(hasOwn(temps, "tank_top")) state.accu.top = readMaybeNumber(temps, "tank_top", state.accu.top);
        if(hasOwn(temps, "tank_mid")) state.accu.mid = readMaybeNumber(temps, "tank_mid", state.accu.mid);
        if(hasOwn(temps, "tank_bottom")) state.accu.bot = readMaybeNumber(temps, "tank_bottom", state.accu.bot);
        const hasReturnAlias = ["afterMixC", "flowReturnC", "returnFlowC", "return.flow", "returnTempC", "return"].some(k => hasOwn(temps, k));
        if(hasReturnAlias) state.accu.after = getAfterMixTempFromTemps(temps);
      }
      if(fast.heap && typeof fast.heap === "object"){
        state.diag = state.diag || { heap:{}, adminActions:[] };
        state.diag.heap = {
          free: readMaybeNumber(fast.heap, "free", state.diag.heap?.free),
          minFree: readMaybeNumber(fast.heap, "minFree", state.diag.heap?.minFree),
          maxAlloc: readMaybeNumber(fast.heap, "maxAlloc", state.diag.heap?.maxAlloc),
          psramFree: readMaybeNumber(fast.heap, "psramFree", state.diag.heap?.psramFree),
        };
      }
      if(Array.isArray(fast.adminActions)){
        state.diag = state.diag || { heap:{}, adminActions:[] };
        state.diag.adminActions = fast.adminActions.slice(0, 12);
      }

      // OpenTherm (compact snapshot)
      const ot = (fast.ot && typeof fast.ot === "object") ? fast.ot : {};
      state.ot.enabled = readMaybeBool(ot, "en", state.ot.enabled);
      if(hasOwn(ot, "bc")){
        state.ot.cfg = state.ot.cfg || {};
        state.ot.cfg.boilerControl = readMaybeString(ot, "bc", state.ot.cfg.boilerControl || "");
      }
      state.ot.ready = readMaybeBool(ot, "rd", state.ot.ready);
      state.ot.linkOk = readMaybeBool(ot, "lk", state.ot.linkOk);
      state.ot.fault = readMaybeBool(ot, "fl", state.ot.fault);
      state.ot.present = state.ot.enabled;
      state.ot.comm = state.ot.enabled && state.ot.ready && state.ot.linkOk;
      state.ot.chSet = readMaybeNumber(ot, "cs", state.ot.chSet);
      state.ot.chTemp = readMaybeNumber(ot, "bt", state.ot.chTemp);
      state.ot.returnTempC = readMaybeNumber(ot, "rt", state.ot.returnTempC);
      state.ot.dhwTemp = readMaybeNumber(ot, "dt", state.ot.dhwTemp);
      state.ot.outsideTempC = readMaybeNumber(ot, "ot", state.ot.outsideTempC);
      state.ot.pressure = readMaybeNumber(ot, "pr", state.ot.pressure);
      state.ot.modulationPct = readMaybeNumber(ot, "mt", state.ot.modulationPct);
      state.ot.maxCapacityKw = readMaybeNumber(ot, "cp", state.ot.maxCapacityKw);
      state.ot.reqWaterTempC = hasOwn(ot, "cs") ? numOrNaN(ot.cs) : state.ot.reqWaterTempC;
      if(!Number.isFinite(state.ot.reqWaterTempC)) state.ot.reqWaterTempC = firstFinite(state.eqFast?.tb, state.eqFast?.tf, state.ot.reqWaterTempC);
      state.ot.maxChSetpointC = readMaybeNumber(ot, "mx", state.ot.maxChSetpointC);
      state.ot.maxChBoundMinC = readMaybeNumber(ot, "mxl", state.ot.maxChBoundMinC);
      state.ot.maxChBoundMaxC = readMaybeNumber(ot, "mxu", state.ot.maxChBoundMaxC);
      state.ot.dhwSetpointC = readMaybeNumber(ot, "dw", state.ot.dhwSetpointC);
      state.ot.dhwBoundMinC = readMaybeNumber(ot, "dwl", state.ot.dhwBoundMinC);
      state.ot.dhwBoundMaxC = readMaybeNumber(ot, "dwu", state.ot.dhwBoundMaxC);
      state.ot.reqDhwSetpointC = readMaybeNumber(ot, "ds", state.ot.reqDhwSetpointC);
      if(hasOwn(ot, "ff")) state.ot.faultFlags = Number(ot.ff) || 0;
      if(hasOwn(ot, "oc")) state.ot.oemFaultCode = Number(ot.oc) || 0;
      state.ot.reason = readMaybeString(ot, "rs", state.ot.reason);
      state.ot.lastCmd = readMaybeString(ot, "cmd", state.ot.lastCmd);
      if(hasOwn(ot, "sr")) state.ot.statusRaw = Number(ot.sr) || 0;
      if(hasOwn(ot, "da")) state.ot.dhwActive = !!ot.da;
      if(hasOwn(ot, "fo")) state.ot.flameOn = !!ot.fo;
      if(hasOwn(ot, "ca")) state.ot.chActive = !!ot.ca;
      syncOtDerived();
      renderHeatingOtInfo();

      // BLE compact
      state.bleFast = (fast.ble && typeof fast.ble === "object") ? fast.ble : (state.bleFast || {});

      // Equitherm compact
      state.eqFast = (fast.eq && typeof fast.eq === "object") ? fast.eq : (state.eqFast || {});
      renderEquithermEnableControls();
      if(state.eqFast?.mix && typeof state.eqFast.mix === "object" && hasOwn(state.eqFast.mix, "pct")){
        state.accu.valve = numOrNaN(state.eqFast.mix.pct);
      }
      state.accu.after = numOrNaN(firstFinite(
        state.eqFast?.mix?.mf,
        state.eqFast?.mixFeedbackC,
        getAfterMixTempFromTemps(fast.temps),
        state.eqFast?.fc,
        state.accu.after
      ));

      // DHW compact
      state.dhwFast = (fast.dhw && typeof fast.dhw === "object") ? fast.dhw : (state.dhwFast || {});
      if(state.dhwStatus && typeof state.dhwStatus === "object"){
        if(!Object.prototype.hasOwnProperty.call(state.dhwFast, "hp") && state.dhwStatus.heatPhase != null) state.dhwFast.hp = String(state.dhwStatus.heatPhase);
        if(!Object.prototype.hasOwnProperty.call(state.dhwFast, "hsq") && state.dhwStatus.heatSequenceActive != null) state.dhwFast.hsq = !!state.dhwStatus.heatSequenceActive;
        if(!Object.prototype.hasOwnProperty.call(state.dhwFast, "ald") && state.dhwStatus.antiLegionellaDone != null) state.dhwFast.ald = !!state.dhwStatus.antiLegionellaDone;
      }

      // Alerts compact
      if(fast.alerts && typeof fast.alerts === "object"){
        applyAlertsConfigToForm({ pressure: {
          enabled: ("en" in fast.alerts) ? !!fast.alerts.en : state.alerts?.pressure?.enabled,
          sensorValid: ("sv" in fast.alerts) ? !!fast.alerts.sv : state.alerts?.pressure?.sensorValid,
          pressureBar: ("p" in fast.alerts) ? fast.alerts.p : state.alerts?.pressure?.pressureBar,
          active: ("act" in fast.alerts) ? !!fast.alerts.act : state.alerts?.pressure?.active,
          state: ("st" in fast.alerts) ? fast.alerts.st : state.alerts?.pressure?.state,
        }});
      }
    }

    function renderIO(){
      const relayNames = [
        "Směšovací ventil - směr A (otevření)",
        "Směšovací ventil - směr B (zavření)",
        "Ventil 3c TUV/CH",
        "Cirkulace TUV",
        "Požadavek kotli TUV",
        "Den/Noc křivka na kotli",
        "Omezení výkonu kotle",
        "Stykač topné tyče AKU",
      ];

      const tbody = $("#relayTbl");
      tbody.innerHTML = "";
      for(let i=0;i<8;i++){
        const on = !!state.io.relays[i];
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="mono">R${i+1}</td>
          <td><strong>${escapeHtml(relayNames[i])}</strong><div class="muted" style="margin-top:4px">stav výstupu; ruční test je dostupný pouze v servisní diagnostice</div></td>
          <td>${on ? '<span class="badge good"><span class="b"></span>ON</span>' : '<span class="badge"><span class="b"></span>OFF</span>'}</td>
          <td><button class="btn" type="button" disabled title="Provozní I/O je řízeno backendem">Diagnostika</button></td>
        `;
        tbody.appendChild(tr);
      }

      const inNames = [
        "Den/Noc křivka (aktivní = noc)",
        "Požadavek TUV (aktivní)",
        "Požadavek cirkulace (aktivní)",
      ];
      const inTb = $("#inTbl");
      inTb.innerHTML = "";
      for(let i=0;i<3;i++){
        const on = !!state.io.inputs[i];
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="mono">IN${i+1}</td>
          <td><strong>${escapeHtml(inNames[i])}</strong></td>
          <td>${on ? '<span class="badge good"><span class="b"></span>1</span>' : '<span class="badge"><span class="b"></span>0</span>'}</td>
        `;
        inTb.appendChild(tr);
      }

      // dhw table binds
      const dhwf = state.dhwFast || {};
      setText("#dhwReq", (dhwf.hr ?? state.io.inputs[1]) ? "aktivní" : "neaktivní");
      setText("#circReq", (dhwf.cr ?? state.io.inputs[2]) ? "aktivní" : "neaktivní");
      setText("#rValve", (dhwf.vr ?? state.io.relays[2]) ? "ON" : "OFF");
      setText("#rCirc", (dhwf.rr ?? state.io.relays[3]) ? "ON" : "OFF");
      setText("#rBoiler", (dhwf.br ?? state.io.relays[4]) ? "ON" : ((dhwf.ode) ? "OT" : "OFF"));
      const dhwPhaseMetaNow = dhwPhaseMeta(dhwf.hp || state.dhwStatus?.heatPhase || "idle");
      const dhwReasonMetaNow = dhwReasonMeta(state.dhwStatus?.heatReason || "");
      setText("#dhwHeatPhase", `${dhwPhaseMetaNow.label} (${dhwPhaseMetaNow.raw})`);
      const mixValveActionRaw = String(state.dhwStatus?.mixValveAction || dhwf.mva || state.dev?.dhwCfgRaw?.heat?.mixValveAction || "close").toLowerCase();
      const mixValveActionLabel = mixValveActionRaw === "open" ? "Otevřít (100 % / A)" : "Zavřít (0 % / B)";
      const mixValveReady = !!(state.dhwStatus?.mixValveReady ?? dhwf.mvr);
      const mixValvePositioning = !!(state.dhwStatus?.mixValvePositioning ?? dhwf.mvp);
      const mixValveStateSuffix = mixValvePositioning ? " • polohuji" : (mixValveReady ? " • připraven" : "");
      setText("#dhwMixValveState", `${mixValveActionLabel}${mixValveStateSuffix}`);
      setText("#dhwHeatSeq", (dhwf.hsq ?? state.dhwStatus?.heatSequenceActive) ? "ANO" : "NE");
      setText("#dhwAntiLegDone", (dhwf.ald ?? state.dhwStatus?.antiLegionellaDone) ? "ANO" : "NE");
      setText("#dhwHeatReason", dhwReasonMetaNow.raw ? `${dhwReasonMetaNow.label} (${dhwReasonMetaNow.raw})` : "--");
    }


    function getEquithermEnabledState(){
      if(state.eqFast && Object.prototype.hasOwnProperty.call(state.eqFast, "en")) return !!state.eqFast.en;
      if(state.eqStatus && typeof state.eqStatus.enabled === "boolean") return !!state.eqStatus.enabled;
      if(state.dev?.eqCfgRaw && typeof state.dev.eqCfgRaw.enabled === "boolean") return !!state.dev.eqCfgRaw.enabled;
      return null;
    }

    function renderEquithermEnableControls(){
      const enabled = getEquithermEnabledState();
      const activeRaw = state.eqFast?.ac ?? state.eqStatus?.active;
      const active = activeRaw == null ? null : !!activeRaw;
      const reason = String(state.eqFast?.rs ?? state.eqStatus?.reason ?? "");

      const checkbox = document.getElementById("hEqEnabled");
      if(checkbox && checkbox.dataset.busy !== "1" && enabled != null) checkbox.checked = enabled;

      let cls = "";
      let label = "stav: --";
      let heatingLabel = "eq: --";
      if(enabled === false){
        label = "vypnuto";
        heatingLabel = "eq: vypnuto";
      }else if(enabled === true && active === true){
        cls = "good";
        label = "aktivní";
        heatingLabel = "eq: aktivní";
      }else if(enabled === true){
        cls = "warn";
        label = "zapnuto";
        heatingLabel = "eq: zapnuto";
      }
      setBadge("#bEq", cls, label);
      setBadge("#hEqState", cls, heatingLabel);

      const btn = document.getElementById("btnEqEnableToggle");
      if(btn){
        const willDisable = enabled === true;
        btn.textContent = willDisable ? "Vypnout ekviterm" : "Zapnout ekviterm";
        btn.setAttribute("aria-pressed", willDisable ? "true" : "false");
        if(reason) btn.title = `Stav regulace: ${reason}`;
        else btn.removeAttribute("title");
      }
      const badge = document.getElementById("hEqState");
      if(badge){
        if(reason) badge.title = `Důvod: ${reason}`;
        else badge.removeAttribute("title");
      }
    }

    async function setEquithermEnabledFromUi(enabled, sourceEl=null){
      const requested = !!enabled;
      const checkbox = document.getElementById("hEqEnabled");
      const previous = getEquithermEnabledState();
      if(checkbox){
        checkbox.dataset.busy = "1";
        checkbox.disabled = true;
        checkbox.checked = requested;
      }
      if(sourceEl && "disabled" in sourceEl) sourceEl.disabled = true;
      try{
        await api.eqCmd({ enabled: requested });
        state.eqFast = state.eqFast || {};
        state.eqFast.en = requested;
        if(!requested) state.eqFast.ac = false;
        state.dev = state.dev || {};
        if(state.dev.eqCfgRaw && typeof state.dev.eqCfgRaw === "object") state.dev.eqCfgRaw.enabled = requested;
        renderEquithermEnableControls();
        toast("Ekviterm", requested ? "Ekvitermní topení zapnuto." : "Ekvitermní topení vypnuto.", requested ? "♨" : "⏸");
        log(`equitherm enabled -> ${requested}`);

        // Potvrď stav přímo z řídicího modulu; není závislé na intervalu běžného refresh.
        try{
          const j = await api.getJson("/api/equitherm/status", 5000);
          if(j?.config){
            state.dev.eqCfgLoaded = true;
            applyEqConfigToForm(j.config, { force:true });
          }
          if(j?.status) applyEqStatus(j.status);
        }catch(_e){}
      }catch(e){
        if(checkbox && previous != null) checkbox.checked = !!previous;
        renderEquithermEnableControls();
        toast("Chyba", e.message || String(e), "⚠");
        log("equitherm enable error: " + (e.message || e));
        throw e;
      }finally{
        if(checkbox){
          checkbox.disabled = false;
          delete checkbox.dataset.busy;
        }
        if(sourceEl && "disabled" in sourceEl) sourceEl.disabled = false;
        renderEquithermEnableControls();
      }
    }

    function heatingModeLabel(mode){
      const m = String(mode || "").toLowerCase();
      if(m === "day") return "komfort";
      if(m === "night") return "útlum";
      if(m === "auto") return "auto";
      return m || "--";
    }

    function heatingModePairLabel(modeEff){
      return String(modeEff || "").toLowerCase() === "night" ? "komfort/útlum: útlum" : "komfort/útlum: komfort";
    }

    function heatingModeSourceLabel(source, timeValid){
      switch(source){
        case "manual-day": return "ručně komfort";
        case "manual-night": return "ručně útlum";
        case "in1": return "IN1";
        case "schedule": return "plán";
        default: return timeValid === false ? "náhradní režim bez času" : "náhradní režim";
      }
    }

    function getEquithermAuditState(){
      const fast = state.eqFast || {};
      const modeReq = String(fast.m || fast.mode || document.getElementById("eqMode")?.value || "auto").toLowerCase();
      const modeEff = String(fast.me || "").toLowerCase();
      const scheduleUsed = !!(fast.su ?? fast.scheduleUsed);
      const in1ForcingNight = !!(fast.i1 ?? fast.in1ForcingNight);
      const timeValid = (fast.tv ?? fast.timeValid);
      const normalizedTimeValid = (timeValid == null) ? null : !!timeValid;
      let source = "fallback";
      if(modeReq === "day") source = "manual-day";
      else if(modeReq === "night") source = "manual-night";
      else if(in1ForcingNight) source = "in1";
      else if(scheduleUsed) source = "schedule";
      return { modeReq, modeEff, scheduleUsed, in1ForcingNight, timeValid: normalizedTimeValid, source };
    }

    function describeEquithermAudit(audit){
      const modeLabel = heatingModePairLabel(audit.modeEff);
      const src = heatingModeSourceLabel(audit.source, audit.timeValid);
      return `${modeLabel} • zdroj: ${src}`;
    }

    function isBoilerDhwModeActive(){
      if(state.dhwStatus && typeof state.dhwStatus.boilerDhwMode === "boolean") return !!state.dhwStatus.boilerDhwMode;
      if(state.dhwFast && Object.prototype.hasOwnProperty.call(state.dhwFast, "bm")) return !!state.dhwFast.bm;
      if(state.ot && typeof state.ot.dhwActive === "boolean") return !!(state.ot.enabled && state.ot.ready && state.ot.dhwActive);
      const sr = Number(state.ot?.statusRaw || 0);
      return !!(sr & (1 << 2));
    }

    function renderDhwBoilerMode(){
      const active = isBoilerDhwModeActive();
      setText("#dhwBoilerMode", active ? "ANO" : "NE");
      setBadge("#bDhwOtMode", active ? "warn" : "", `TUV přes OT: ${active ? "ano" : "ne"}`);
    }

    function evaluateHealth(){
      const critical = [];
      const warnings = [];
      const relMask = Number(state.dev?.relMask ?? state.fast?.rel?.mask ?? 0) & 0xFF;
      if((relMask & 0x03) === 0x03) critical.push("R1+R2");
      if(state.alerts?.pressure?.active) critical.push("tlak");
      if(state.ot?.enabled && state.ot?.fault) critical.push("OpenTherm");
      if(state.fast?.rel?.ok === false) warnings.push("relé/I2C");
      if(state.ot?.enabled && !state.ot?.comm && !state.ot?.fault) warnings.push("OpenTherm komunikace");
      const lastFastOkMs = Number(state.net?.lastFastOkMs);
      if(Number.isFinite(lastFastOkMs) && Date.now() - lastFastOkMs > 60000) warnings.push("stará data");
      const mixState = String(state.mixStatus?.state || state.eqFast?.mix?.st || "").toLowerCase();
      if(/^fault_/.test(mixState) || /^blocked_/.test(mixState)) warnings.push("směšovací ventil");

      if(critical.length) return { level:"bad", label:"PORUCHA", details:critical.join(", ") };
      if(warnings.length) return { level:"warn", label:"POZOR", details:warnings.join(", ") };
      return { level:"good", label:"OK", details:"" };
    }

    function renderOverviewBadges(){
      const audit = getEquithermAuditState();
      const dn = heatingModeLabel(audit.modeEff || "day");

      setText("#pillUptime", "uptime: " + uptimeString());
      $("#bSchedule").childNodes.forEach(n=>{ if(n.nodeType===3) n.remove(); });
      $("#bSchedule").appendChild(document.createTextNode(" " + describeEquithermAudit(audit)));

      // NET pill
      const ip = state.dev?.ip || $("#dIp")?.textContent || "--";
      $("#pillNet").textContent = "LAN: " + ip;

      // BLE pill
      const b = state.bleFast || {};
      if(!b.en) $("#pillBle").textContent = "BLE: vypnuto";
      else if(b.cn) $("#pillBle").textContent = "BLE: ok";
      else if(b.sc) $("#pillBle").textContent = "BLE: scan";
      else $("#pillBle").textContent = "BLE: neaktivní";

      // OT pill
      if(!state.ot.enabled) $("#pillOT").textContent = "OT: vypnuto";
      else if(state.ot.fault && state.ot.comm) $("#pillOT").textContent = "OT: fault kotle";
      else if(state.ot.comm) $("#pillOT").textContent = "OT: ok";
      else if(state.ot.ready) $("#pillOT").textContent = "OT: bez odpovědi";
      else $("#pillOT").textContent = "OT: inicializace";

      // function summaries
      const eqBoilerTarget = Number.isFinite(Number(state.eqFast?.tb)) ? Number(state.eqFast.tb) : Number($("#eqSet")?.value || 0);
      const eqValveTarget = Number.isFinite(Number(state.eqFast?.tf)) ? Number(state.eqFast.tf) : eqBoilerTarget;
      const targetParts = [`OT cíl: ${Number.isFinite(eqBoilerTarget) ? eqBoilerTarget.toFixed(1) : "--"} °C`];
      if(Number.isFinite(eqValveTarget) && (!Number.isFinite(eqBoilerTarget) || Math.abs(eqValveTarget - eqBoilerTarget) >= 0.05)){
        targetParts.push(`ventil: ${eqValveTarget.toFixed(1)} °C`);
      }
      setText("#sumEq", `Křivka: ${dn} • ${targetParts.join(" • ")} • ${describeEquithermAudit(audit).replace(/^komfort\/útlum: [^•]+ • /i,"")}`);
      const dhwf = state.dhwFast || {};
      const dhwReq = !!(dhwf.hr ?? state.io.inputs[1]);
      const boilerDhwMode = isBoilerDhwModeActive();
      const dhwActive = !!(dhwf.ha ?? boilerDhwMode ?? state.io.relays[4]);
      const circReq = !!(dhwf.cr ?? state.io.inputs[2]);
      const circOn = !!(dhwf.rr ?? state.io.relays[3]);
      const circPulseOn = !!(dhwf.cp ?? false);
      const requestMode = String(dhwf.rm || document.getElementById("dhwRequestMode")?.value || "relay");
      const dhwPhaseMetaSum = dhwPhaseMeta(dhwf.hp || state.dhwStatus?.heatPhase || "idle");
      const dhwReasonMetaSum = dhwReasonMeta(state.dhwStatus?.heatReason || "");
      setText("#sumDhw", `Požadavek: ${dhwReq ? "ano" : "ne"} • ohřev: ${dhwActive ? "běží" : "neaktivní"} • fáze: ${dhwPhaseMetaSum.label} • důvod: ${dhwReasonMetaSum.label} • režim: ${requestMode === "opentherm" ? "OT" : "relé"}`);
      setText("#sumCirc", `Požadavek: ${circReq ? "ano" : "ne"} • relé: ${circOn ? "ON" : "OFF"}${state.circPulse.enable ? ` • pulz: ${circPulseOn ? "ON" : "OFF"}` : ""}`);

      // overall badge
      const health = evaluateHealth();
      setBadge("#bOverall", health.level, health.label);
      const overall = $("#bOverall");
      if(overall) overall.title = health.details ? `Důvod: ${health.details}` : "Bez aktivních varování";
    }

    function pushHistory(key, value){
      const arr = state.history[key];
      const n = Number(value);
      if(!Number.isFinite(n)) return;
      arr.push(n);
      while(arr.length > 30) arr.shift();
    }

    function getActiveView(){
      const active = document.querySelector('.section.active');
      if(!active || !active.id) return 'overview';
      return String(active.id).replace(/^view-/, '') || 'overview';
    }

    function renderSample(sample){
      sample = Object.assign({}, sample || {});
      sample.out = numOrNaN(sample.out);
      sample.ch = numOrNaN(sample.ch);
      sample.dhw = numOrNaN(sample.dhw);
      sample.pr = numOrNaN(sample.pr);
      sample.accTop = numOrNaN(sample.accTop);
      sample.accMid = numOrNaN(sample.accMid);
      sample.accBot = numOrNaN(sample.accBot);
      sample.mixValve = numOrNaN(sample.mixValve);
      sample.mixAfter = numOrNaN(sample.mixAfter);
      sample.mixTarget = numOrNaN(sample.mixTarget);
      sample.mixReturn = numOrNaN(sample.mixReturn);
      sample.eqTarget = numOrNaN(sample.eqTarget);
      state.last = sample;
      observeServiceIssues();

      // tiles
      setTextNum("#kpiOut", sample.out, 1);
      setTextNum("#kpiCH",  sample.ch, 1);
      setTextNum("#kpiDHW", sample.dhw, 1);
      setTextNum("#kpiPr",  sample.pr, 2);

      const ts = fmtTs(sample.now);
      setText("#kpiOutTs", ts);
      setText("#kpiChTs", ts);
      setText("#kpiDhwTs", ts);
      setText("#kpiPrTs", ts);
      setText("#kpiPowerTs", ts);
      setText("#kpiReqWaterTs", ts);

      const modPct = Number(state.ot?.modulationPct);
      const maxKw = Number(state.ot?.maxCapacityKw);
      const currentKw = (Number.isFinite(Number(state.ot?.currentPowerKw))
        ? Number(state.ot.currentPowerKw)
        : (Number.isFinite(modPct) && Number.isFinite(maxKw) ? (maxKw * modPct / 100) : NaN));
      const reqWaterC = Number.isFinite(Number(state.ot?.reqWaterTempC))
        ? Number(state.ot.reqWaterTempC)
        : (Number.isFinite(Number(state.eqFast?.tb)) ? Number(state.eqFast.tb) : (Number.isFinite(Number(state.eqFast?.tf)) ? Number(state.eqFast.tf) : Number(state.ot?.chSet)));
      setText("#kpiPower", Number.isFinite(currentKw) ? currentKw.toFixed(1) : "--");
      setText("#kpiPowerMeta", Number.isFinite(modPct) ? `${modPct.toFixed(0)} %` : "-- %");
      setText("#kpiReqWater", Number.isFinite(reqWaterC) ? reqWaterC.toFixed(1) : "--");
      setText("#kpiReqWaterMeta", Number.isFinite(Number(state.ot?.chSet)) ? `OT req ${Number(state.ot.chSet).toFixed(1)} °C` : "--");

      setText("#ovUpdated", "Aktualizace: " + new Date(sample.now).toLocaleString("cs-CZ"));

      // diag
      setText("#dTime", new Date(sample.now).toLocaleString("cs-CZ"));
      setText("#dUp",  uptimeString());
      setText("#pillUptime", "uptime: " + uptimeString());
      const heap = state?.diag?.heap || {};
      const buildParts = ["UI 2026"];
      if(Number.isFinite(Number(heap.free))) buildParts.push(`heap ${fmtBytes(heap.free)}`);
      if(Number.isFinite(Number(heap.minFree))) buildParts.push(`min ${fmtBytes(heap.minFree)}`);
      if(Number.isFinite(Number(heap.maxAlloc))) buildParts.push(`max ${fmtBytes(heap.maxAlloc)}`);
      setText("#dBuild", buildParts.join(" • "));

      // history for sparklines
      pushHistory("out", sample.out);
      pushHistory("ch", sample.ch);
      pushHistory("dhw", sample.dhw);
      pushHistory("pr", sample.pr);

      const activeView = getActiveView();
      const overviewVisible = activeView === "overview";
      const heatingVisible = activeView === "heating";
      const mixingVisible = activeView === "mixing";
      const accuVisible = activeView === "accu";

      if(overviewVisible){
        drawSpark($("#sparkOut"), state.history.out);
        drawSpark($("#sparkCH"),  state.history.ch);
        drawSpark($("#sparkDHW"), state.history.dhw);
        drawSpark($("#sparkPr"),  state.history.pr);
      }


      // Equitherm charts (overview + heating)
      const { dayCurve, nightCurve, minFlowC, maxFlowC } = getEqChartConfig();

      const pointX = sample.out;

      function getEqEffectiveCurve(){
        const modeEff = String(state?.eqFast?.me || "").toLowerCase();
        if(modeEff === "night") return nightCurve;
        if(modeEff === "day") return dayCurve;

        const uiMode = String($("#eqMode")?.value || "auto").toLowerCase();
        if(uiMode === "night") return nightCurve;
        if(uiMode === "day") return dayCurve;

        return sample.in1 ? nightCurve : dayCurve;
      }

      const activeCurve = getEqEffectiveCurve();
      const calcTarget = eqChFromCurve(pointX, activeCurve, minFlowC, maxFlowC);
      const tgt = Number.isFinite(sample?.eqTarget)
        ? Number(sample.eqTarget)
        : (Number.isFinite(calcTarget) ? calcTarget : Number($("#hTarget")?.value ?? $("#eqSet")?.value ?? 45));
      const pointY = clamp(tgt, minFlowC, maxFlowC);

      // Current heating point is authoritative from firmware. Both fields are
      // informational; manual edits would otherwise create a second, different
      // calculation path beside the controller's selected curve/mode/limits.
      const eqSetEl = $("#eqSet");
      const hTargetEl = $("#hTarget");
      [eqSetEl, hTargetEl].forEach((el) => {
        if(!el) return;
        if(Number.isFinite(sample?.eqTarget)) el.value = Number(sample.eqTarget).toFixed(1);
        el.disabled = true;
      });


      if(overviewVisible){
        drawEquithermChart($("#eqChartOverview"), {
          dayCurve, nightCurve, minFlowC, maxFlowC,
          pointX, pointY,
          outdoorNow: sample.out,
          swDay: $("#swDay"), swNight: $("#swNight"), swNow: $("#swNow"),
          fitY: true,
        });
      }
      if(heatingVisible && $("#eqChartHeating")?.getBoundingClientRect().width > 24){
        drawEquithermChart($("#eqChartHeating"), {
          dayCurve, nightCurve, minFlowC, maxFlowC,
          pointX, pointY,
          outdoorNow: sample.out,
          swDay: $("#swDay2"), swNight: $("#swNight2"), swNow: $("#swNow2"),
          fitY: true,
        });
      }

// Accumulator tank + mixing valve
      setText("#accTop", fmtNum(sample.accTop, 1));
      setText("#accMid", fmtNum(sample.accMid, 1));
      setText("#accBot", fmtNum(sample.accBot, 1));

      // Tank widget (overview)
      const aTop = firstFinite(sample.accTop, state.accu.top);
      const aMid = firstFinite(sample.accMid, state.accu.mid);
      const aBot = firstFinite(sample.accBot, state.accu.bot);
      const mixPct = Number.isFinite(sample.mixValve) ? sample.mixValve : (state.accu.valve ?? 0);
      const vTgt = Number.isFinite(sample.mixTarget) ? sample.mixTarget : Number($("#hTarget")?.value ?? $("#eqSet")?.value ?? 45);
      const vAfter = Number.isFinite(sample.mixAfter) ? sample.mixAfter : (state.accu.after ?? sample.ch);
      const vRet = Number.isFinite(sample.mixReturn) ? sample.mixReturn : (sample.ch - 8);
      const autoAllowed = state.mixStatus?.automaticAllowed ?? state.eqFast?.mix?.ac;
      const heatAvailable = state.mixStatus?.heatAvailable ?? state.eqFast?.mix?.ha;
      const helping = autoAllowed != null || heatAvailable != null
        ? (!!autoAllowed && !!heatAvailable)
        : ((Number(sample.accMid ?? state.accu.mid) >= clamp(vTgt, 0, 99)) && (mixPct > 0.5));
      if([aTop,aMid,aBot].some(v => Number.isFinite(v))) setTankFill("#tankFill", aTop, aMid, aBot);
      const assist = $("#accAssist");
      if(assist){ assist.textContent = helping ? "ANO" : "NE"; }

      const mixDashboardValues = {
        pct: clamp(Number(mixPct) || 0, 0, 100),
        supplyC: Number.isFinite(sample.mixSupply) ? sample.mixSupply : sample.ch,
        returnC: vRet,
        outputC: vAfter,
        targetC: vTgt,
      };
      if(overviewVisible) renderOverviewMixStatus(mixDashboardValues);
      if(mixingVisible) renderMixingDashboard(mixDashboardValues);

      updatePlannerStateBadges();

      if(activeView === "io" || activeView === "dhw") renderIO();
      renderOverviewBadges();
      renderDhwBoilerMode();
      if(mixingVisible){
        renderMixBadge();
        renderServicePanel();
      }

      // modes
      const eqAudit = getEquithermAuditState();
      const dn = heatingModeLabel(eqAudit.modeEff || "day");
      $("#bMode").childNodes.forEach(n=>{ if(n.nodeType===3) n.remove(); });
      $("#bMode").appendChild(document.createTextNode(" Režim: " + heatingModeLabel(eqAudit.modeReq || "auto")));
      $("#bSchedule").childNodes.forEach(n=>{ if(n.nodeType===3) n.remove(); });
      $("#bSchedule").appendChild(document.createTextNode(" " + describeEquithermAudit(eqAudit)));

      const eqSourceLabel = heatingModeSourceLabel(eqAudit.source, eqAudit.timeValid);
      setBadge("#eqAuditSource", eqAudit.source.startsWith("manual") ? "good" : (eqAudit.source === "fallback" ? "warn" : ""), "zdroj: " + eqSourceLabel);
      setBadge("#eqAuditInput", eqAudit.in1ForcingNight ? "warn" : null, "IN1: " + (eqAudit.in1ForcingNight ? "nutí útlum" : ((state.io.inputs[0]) ? "aktivní" : "neaktivní")));
      setBadge("#eqAuditSchedule", eqAudit.scheduleUsed ? "good" : null, "plán: " + (eqAudit.scheduleUsed ? "použit" : "nepoužit"));
      setBadge("#eqAuditTime", eqAudit.timeValid === false ? "warn" : (eqAudit.timeValid ? "good" : null), "čas: " + (eqAudit.timeValid === false ? "neplatný" : (eqAudit.timeValid ? "platný" : "neznámý")));

      // DHW state badge
      const dhwf2 = state.dhwFast || {};
      const dhwCircEl = document.getElementById("dhwCirc");
      if(dhwCircEl && document.activeElement !== dhwCircEl) dhwCircEl.checked = !!(dhwf2.rr ?? dhwf2.ca ?? false);
      const boilerDhwMode2 = isBoilerDhwModeActive();
      const dhwActive = !!(dhwf2.ha ?? boilerDhwMode2 ?? (state.io.inputs[1] || state.io.relays[2] || state.io.relays[4]));
      const dhwMode = String(dhwf2.rm || document.getElementById("dhwRequestMode")?.value || "relay");
      const dhwPhaseMetaBadge = dhwPhaseMeta(dhwf2.hp || state.dhwStatus?.heatPhase || "idle");
      const dhwReasonMetaBadge = dhwReasonMeta(state.dhwStatus?.heatReason || "");
      const dhwSeq = !!(dhwf2.hsq ?? state.dhwStatus?.heatSequenceActive);
      const dhwStateTxt = dhwActive ? `běží (${dhwMode === "opentherm" ? "OT" : "relé"})` : (dhwSeq ? "přechod sekvence" : "neaktivní");
      const dhwBadgeKind = dhwReasonMetaBadge.fault ? "bad" : ((dhwActive || boilerDhwMode2 || dhwSeq) ? (dhwPhaseMetaBadge.kind || "warn") : "");
      setBadge("#dhwState", dhwBadgeKind, "stav: " + dhwStateTxt + ` • fáze: ${dhwPhaseMetaBadge.label} • důvod: ${dhwReasonMetaBadge.label}` + ` • kotel TUV přes OT: ${boilerDhwMode2 ? "ANO" : "NE"}`);
      const dhwWarn = $("#dhwWarn");
      if(dhwWarn){
        if(dhwReasonMetaBadge.fault) setBadge("#dhwWarn", "bad", `varování: ${dhwReasonMetaBadge.label}`);
        else if(dhwPhaseMetaBadge.kind === "warn" || boilerDhwMode2) setBadge("#dhwWarn", "warn", `upozornění: ${dhwPhaseMetaBadge.label}` + (boilerDhwMode2 ? " • kotel TUV aktivní přes OT" : ""));
        else setBadge("#dhwWarn", "", "varování: žádné");
      }


      // OpenTherm pill + page
      const otPillText = !state.ot.enabled ? "OT: vypnuto" : (state.ot.fault && state.ot.comm) ? "OT: fault kotle" : state.ot.comm ? "OT: ok" : state.ot.ready ? "OT: bez odpovědi" : "OT: inicializace";
      setText("#pillOT", otPillText);
      if($("#pillOT")){
        const p = $("#pillOT").closest(".pill");
        if(p){
          p.classList.toggle("good", !!state.ot.comm && !state.ot.fault);
          p.classList.toggle("bad", !!state.ot.enabled && (!state.ot.comm || !!state.ot.fault));
        }
      }
      setText("#otComm", !state.ot.enabled ? "VYPNUTO" : state.ot.comm ? (state.ot.fault ? "OK • FAULT KOTLE" : "OK") : state.ot.ready ? "BEZ ODPOVĚDI" : "INIT");
      setText("#otChSet", fmtMaybeNumber(state.ot.chSet, 1));
      setText("#otChTemp", fmtMaybeNumber(state.ot.chTemp, 1));
      setText("#otDhwTemp", fmtMaybeNumber(state.ot.dhwTemp, 1));
      setText("#otPress", fmtMaybeNumber(state.ot.pressure, 2));
      setText("#otOutside", fmtMaybeNumber(state.ot.outsideTempC, 1));
      setText("#otReturn", fmtMaybeNumber(state.ot.returnTempC, 1));
      setText("#otMod", fmtMaybeNumber(state.ot.modulationPct, 1));
      setText("#otPower", fmtMaybeNumber(state.ot.currentPowerKw, 2));
      setText("#otMaxPower", fmtMaybeNumber(state.ot.maxCapacityKw, 1));
      setText("#otMaxCh", fmtMaybeNumber(state.ot.maxChSetpointC, 1));
      setText("#otDhwSet", fmtMaybeNumber(state.ot.dhwSetpointC, 1));
      setText("#otReqDhw", fmtMaybeNumber(state.ot.reqDhwSetpointC, 1));
      setText("#otReason", state.ot.reason || "--");
      setText("#otFaultFlags", Number(state.ot.faultFlags || 0).toString());
      setText("#otOemFault", Number(state.ot.oemFaultCode || 0).toString());
      setText("#otCfgState", (state.ot.cfg?.enabled ?? state.ot.cfg?.enable) ? "povoleno" : "vypnuto");
      if($("#otEnable")){
        $("#otEnable").checked = !!(state.ot.cfg?.enabled ?? state.ot.cfg?.enable);
        $("#otPoll").value = Number(state.ot.cfg?.pollMs ?? 1000);
        $("#otFailMode").value = state.ot.cfg?.mode ?? state.ot.cfg?.failMode ?? "control";
        $("#otLog").checked = !!(state.ot.cfg?.allowRawWrite ?? state.ot.cfg?.log);
      }
      const otModeTxt = String(state.ot.cfg?.mode || "control");
      setBadge("#otBadge", state.ot.comm && !state.ot.fault ? "good" : "bad", state.ot.comm ? `stav: ${state.ot.fault ? "FAULT KOTLE (link OK)" : "OK"} • ${otModeTxt}` : `stav: ${state.ot.enabled ? "bez odpovědi" : "vypnuto"} • ${otModeTxt}`);

      const pAlert = state.alerts?.pressure || {};
      let pText = "alarm: vypnuto";
      let pKind = "";
      if(pAlert.enabled){
        if(!pAlert.sensorValid) { pText = "alarm: bez dat tlaku"; pKind = "warn"; }
        else if(pAlert.active) { pText = `alarm: ${pAlert.state === "high" ? "MAX" : "MIN"} • ${fmtMaybeNumber(pAlert.pressureBar, 2)} bar`; pKind = "bad"; }
        else { pText = `alarm: OK • ${fmtMaybeNumber(pAlert.pressureBar, 2)} bar`; pKind = "good"; }
      }
      setBadge("#pressAlarmBadge", pKind, pText);
      applyAlertsConfigToForm({ pressure: pAlert });

      // Accu dedicated page
      if(accuVisible){
        const aTopA = Number.isFinite(sample.accTop) ? sample.accTop : state.accu.top;
        const aMidA = Number.isFinite(sample.accMid) ? sample.accMid : state.accu.mid;
        const aBotA = Number.isFinite(sample.accBot) ? sample.accBot : state.accu.bot;
        setText("#accTopA", fmtNum(aTopA, 1));
        setText("#accMidA", fmtNum(aMidA, 1));
        setText("#accBotA", fmtNum(aBotA, 1));
        setText("#mixPctLblA", Math.round(mixPct) + " %");
        const mbA = $("#mixBarA"); if(mbA){ const pctA = clamp(mixPct,0,100); mbA.style.width = pctA + "%"; mbA.parentElement?.setAttribute("aria-valuenow", String(Math.round(pctA))); }
        setText("#mixAfterA", fmtNum(vAfter, 1));
        setText("#mixTargetA", fmtNum(clamp(vTgt,0,99), 1));
        setText("#mixReturnA", fmtNum(clamp(vRet,0,99), 1));
        if([aTopA,aMidA,aBotA].some(v => Number.isFinite(v))) setTankFill("#tankFillA", aTopA, aMidA, aBotA);
        setBadge("#accuHelpBadge", helping ? "good" : "", helping ? "pomoc: ANO" : "pomoc: NE");
      }
      // update sidebar device label
      const ip = state.dev?.ip || $("#dIp")?.textContent || (state.apiBase ? state.apiBase : "(origin)");
      $("#sbDevice").textContent = ip + " • device";
    }

    function formatDurationSec(value){
      const s = Math.max(0, Math.floor(Number(value)));
      if(!Number.isFinite(s)) return "--";
      const d = Math.floor(s/86400);
      const h = Math.floor((s%86400)/3600);
      const m = Math.floor((s%3600)/60);
      const ss = s%60;
      return `${d}d ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
    }

    function uptimeString(){
      const uptimeSec = Number(state.system?.uptimeSec);
      return Number.isFinite(uptimeSec) ? formatDurationSec(uptimeSec) : "--";
    }

    
    function updateUploadProgress(prefix, receivedBytes, expectedBytes, message, active){
      const bar = document.getElementById(prefix + "Bar");
      const text = document.getElementById(prefix + "Text");
      const pct = (expectedBytes > 0) ? Math.max(0, Math.min(100, Math.round((receivedBytes * 100) / expectedBytes))) : 0;
      if(bar) bar.style.width = pct + "%";
      if(text) text.textContent = `${prefix === "otaFw" ? "Firmware" : "Filesystem"}: ${message || (active ? "upnačítání" : "neaktivní")} • ${receivedBytes||0}/${expectedBytes||0} B (${pct}%)`;
      const live = document.getElementById("otaLiveState");
      if(live){
        live.classList.remove("good","warn","bad");
        if(active) live.classList.add("warn");
        else if(message === "uploaded") live.classList.add("good");
        else if(message && message !== "neaktivní") live.classList.add("bad");
        live.childNodes.forEach(n=>{ if(n.nodeType===3) n.remove(); });
        live.appendChild(document.createTextNode(` OTA: ${active ? "upload" : (message || "neaktivní")}`));
      }
    }


    function getHeatingOtUsageSummary(){
      const eqUsesOt = !!(state.dev?.eqCfgRaw?.output?.useOpenTherm ?? state.dev?.eqUsesOpenTherm ?? true);
      const dhwMode = String(document.getElementById("dhwRequestMode")?.value || state.dev?.dhwCfgRaw?.heat?.requestMode || "relay").toLowerCase();
      return {
        eqUsesOt,
        dhwUsesOt: dhwMode === "opentherm"
      };
    }

    function ensureOtConfigCompatible(enabled, mode){
      const usage = getHeatingOtUsageSummary();
      const wantsReadOnly = String(mode || "control") === "readOnly";
      if((usage.eqUsesOt || usage.dhwUsesOt) && (!enabled || wantsReadOnly)) {
        const en = document.getElementById("otEnable");
        const md = document.getElementById("otFailMode");
        if(en) en.checked = true;
        if(md) md.value = "control";
        return { enabled:true, mode:"control", adjusted:true };
      }
      return { enabled:!!enabled, mode:String(mode || "control"), adjusted:false };
    }

    function ensureWritableOtForDhw(requestMode){
      if(String(requestMode || "relay") !== "opentherm") return;
      const otMode = String(state.ot?.cfg?.mode || "control");
      const boilerControl = String(state.dev?.fast?.ot?.bc || state.ot?.cfg?.boilerControl || "");
      if(otMode === "readOnly" || boilerControl === "relay") throw new Error("OpenTherm je v režimu jen pro čtení. Pro TUV přepněte OT do control, nebo použijte režim relay.");
    }

    async function dhwStartFromUi(targetTempC, requestMode){
      ensureWritableOtForDhw(requestMode);
      await api.postConfigSection("dhw", { heat: { requestMode, targetTempC, otEnableDhw: requestMode === "opentherm", otDhwSetpointC: targetTempC } });
      state.dev = state.dev || {};
      state.dev.dhwCfgLoaded = false;
      state.dev.dhwCfgRaw = Object.assign({}, state.dev.dhwCfgRaw || {}, { heat: Object.assign({}, state.dev?.dhwCfgRaw?.heat || {}, { requestMode, targetTempC, otEnableDhw: requestMode === "opentherm", otDhwSetpointC: targetTempC }) });
      await api.dhwCmd({ command: "start", durationSec: 900, targetC: targetTempC });
    }

    async function dhwStopFromUi(){
      await api.dhwCmd({ command: "stop" });
    }

    async function dhwBoostFromUi(targetTempC, requestMode, boostMin=15){
      ensureWritableOtForDhw(requestMode);
      await api.postConfigSection("dhw", { heat: { requestMode, targetTempC, otEnableDhw: requestMode === "opentherm", otDhwSetpointC: targetTempC } });
      state.dev = state.dev || {};
      state.dev.dhwCfgLoaded = false;
      state.dev.dhwCfgRaw = Object.assign({}, state.dev.dhwCfgRaw || {}, { heat: Object.assign({}, state.dev?.dhwCfgRaw?.heat || {}, { requestMode, targetTempC, otEnableDhw: requestMode === "opentherm", otDhwSetpointC: targetTempC }) });
      await api.dhwCmd({ command: "boost", durationSec: Math.max(1, Number(boostMin) || 15) * 60, targetC: targetTempC });
    }

    async function dhwCircSetFromUi(on){
      await api.dhwCmd(on ? { command: "circulation", active: true, durationSec: 300 } : { command: "circulation", active: false });
    }

    async function dhwReloadConfigFromDevice(){
      const cfg = await api.fetchConfigSection("dhw");
      if(cfg){
        clearPendingSaveDirty("dhw");
        clearPendingSaveDirty("dhwPlan");
        state.dhwCfg = cfg;
        state.dev = state.dev || {};
        state.dev.dhwCfgRaw = cfg;
        state.dev.dhwCfgLoaded = true;
        applyDhwConfigToForm(cfg);
      }
      await refresh(false);
    }

    async function dhwSaveConfigFromUi(){
      const heatCfg = state.dev?.dhwCfgRaw?.heat || state.dhwCfg?.heat || {};
      const circCfg = state.dev?.dhwCfgRaw?.circ || state.dhwCfg?.circ || {};
      const antiCfg = state.dev?.dhwCfgRaw?.antiLegionella || state.dhwCfg?.antiLegionella || {};
      const requestMode = String(document.getElementById("dhwRequestMode")?.value || heatCfg.requestMode || "relay");
      const targetTempC = Number(document.getElementById("dhw2Target")?.value || 50);
      const antiStart = timeToMin(String(document.getElementById("dhwAntiLegStart")?.value || minsToTime(Number(antiCfg.startMin ?? 120))));
      const payload = { dhw: {
        enabled: !!document.getElementById("dhwEnable")?.checked,
        // DHW priority always blocks equitherm until the selected mixing-valve
        // end position is reached and the full DHW sequence has finished.
        disableEquithermDuringHeat: true,
        heat: {
          useInput: !!document.getElementById("dhwHeatUseInput")?.checked,
          useSchedule: !!document.getElementById("dhwHeatUseSchedule")?.checked,
          scheduleEnabled: !!(heatCfg.scheduleEnabled ?? true),
          targetTempC,
          hysteresisC: Number(document.getElementById("dhwHysteresis")?.value || heatCfg.hysteresisC || 2),
          requestMode,
          otEnableDhw: requestMode === "opentherm",
          otDhwSetpointC: targetTempC,
          relayRequest: !!document.getElementById("dhwRelayRequest")?.checked,
          driveValveRelay: !!document.getElementById("dhwDriveValveRelay")?.checked,
          mixValveAction: String(document.getElementById("dhwMixValveAction")?.value || heatCfg.mixValveAction || "close"),
          valveRelay: Number(document.getElementById("dhwValveRelay")?.value || heatCfg.valveRelay || 3),
          boilerRelay: Number(document.getElementById("dhwBoilerRelay")?.value || heatCfg.boilerRelay || 5),
          valveLeadMs: Math.max(0, Number(document.getElementById("dhwValveLeadMs")?.value || heatCfg.valveLeadMs || 3000)),
          valveSwitchBackMs: Math.max(0, Number(document.getElementById("dhwValveSwitchBackMs")?.value || heatCfg.valveSwitchBackMs || 1500)),
          boilerOffHoldMs: Math.max(0, Number(document.getElementById("dhwBoilerOffHoldMs")?.value || heatCfg.boilerOffHoldMs || 2000)),
          schedule: { week: serializeDhwWeek("dhwHeat") }
        },
        circ: {
          useInput: !!document.getElementById("dhwCircUseInput")?.checked,
          useSchedule: !!document.getElementById("dhwCircUseSchedule")?.checked,
          scheduleEnabled: !!(circCfg.scheduleEnabled ?? true),
          pulseEnabled: !!state.circPulse.enable,
          pulseOnMin: Math.max(0, Number(state.circPulse.onMin ?? 5)),
          pulseOffMin: Math.max(0, Number(state.circPulse.vypnutoMin ?? 15)),
          relay: Number(document.getElementById("dhwCircRelay")?.value || circCfg.relay || 4),
          schedule: { week: serializeDhwWeek("dhwCirc") }
        },
        antiLegionella: {
          enabled: !!document.getElementById("dhwAntiLegEnabled")?.checked,
          weekday: Number(document.getElementById("dhwAntiLegWeekday")?.value || antiCfg.weekday || 0),
          startMin: Number.isFinite(antiStart) ? antiStart : Number(antiCfg.startMin || 120),
          targetTempC: Number(document.getElementById("dhwAntiLegTarget")?.value || antiCfg.targetTempC || 60),
          holdMin: Number(document.getElementById("dhwAntiLegHold")?.value || antiCfg.holdMin || 30),
        }
      }};
      await api.postConfigSection("dhw", payload.dhw);
      clearPendingSaveDirty("dhw");
      clearPendingSaveDirty("dhwPlan");
      state.dev = state.dev || {};
      state.dev.dhwCfgRaw = payload.dhw;
      state.dhwCfg = payload.dhw;
      applyDhwConfigToForm(payload.dhw);
      await refresh(false);
    }

    async function safeStopSystem(){
      const resp = await api.systemCmd({ command: "safeStop" });
      const mask = Number(resp?.rel?.mask ?? resp?.fast?.rel?.mask ?? state.dev?.relMask ?? 0) & 0xFF;
      state.dev = state.dev || {};
      state.dev.relMask = mask;
      state.io.relays = Array.from({length:8}, (_,k) => ((mask >> k) & 1) === 1);
      return resp;
    }

    function uploadWithProgress(url, fileInputId, prefix){
      return new Promise((resolve, reject) => {
        const inp = document.getElementById(fileInputId);
        const file = inp?.files?.[0];
        if(!file){ reject(new Error("Vyber soubor.")); return; }
        const xhr = new XMLHttpRequest();
        const fd = new FormData();
        fd.append("file", file);
        xhr.open("POST", normalizedApiBase() + url, true);
        xhr.upload.onprogress = (e) => updateUploadProgress(prefix, e.loaded || 0, e.total || file.size || 0, "upnačítání", true);
        xhr.onerror = () => reject(new Error("Network error"));
        xhr.onabort = () => reject(new Error("Upload aborted"));
        xhr.onload = () => {
          let j = {};
          try{ j = JSON.parse(xhr.responseText || "{}"); }catch{}
          if(xhr.status >= 200 && xhr.status < 300){
            updateUploadProgress(prefix, Number(j.receivedBytes || file.size || 0), Number(j.partitionBytes || file.size || 0), j.msg || "uploaded", false);
            resolve(j);
          }else{
            reject(new Error(j.msg || j.err || xhr.responseText || `HTTP ${xhr.status}`));
          }
        };
        updateUploadProgress(prefix, 0, file.size || 0, "starting", true);
        xhr.send(fd);
      });
    }

    // Legacy WebSocket/polling code removed. Current runtime uses connectWs() + applyFastSnapshot().

function applyBootstrapPayload(payload){
  if(!payload || typeof payload !== "object") return false;
  let applied = false;
  if(payload.fast && typeof payload.fast === "object") {
    applyFastSnapshot(payload.fast);
    applied = true;
  }
  state.dev = state.dev || {};
  if(payload.equitherm){
    state.dev.eqCfgLoaded = true;
    applyEqConfigToForm(payload.equitherm, { force:true });
    applied = true;
  }
  if(payload.mixing){
    state.dev.mixCfgLoaded = true;
    applyMixingConfigToForm(payload.mixing, { force:true });
    applied = true;
  }
  if(payload.opentherm){
    state.dev.otCfgLoaded = true;
    applyOtConfigToForm(payload.opentherm);
    applied = true;
  }
  if(payload.dhw){
    state.dev.dhwCfgLoaded = true;
    state.dhwCfg = payload.dhw;
    applyDhwConfigToForm(payload.dhw);
    applied = true;
  }
  if(payload.alerts){
    state.dev.alertsCfgLoaded = true;
    applyAlertsConfigToForm(payload.alerts);
    applied = true;
  }
  if(payload.time){
    state.dev.timeCfgLoaded = true;
    applyTimeConfigToForm(payload.time);
    applied = true;
  }
  if(payload.setupWizard){
    state.setupWizard = {...(state.setupWizard || {}), ...payload.setupWizard};
    applied = true;
  }
  if(payload.dallas){
    state.th = state.th || {};
    state.th.cfgLoaded = true;
    state.th.dallasEnabled = !!payload.dallas?.enabled;
    state.th.roles = normalizeDallasRolesMap(payload.dallas?.roles);
    state.th.roleMeta = normalizeDallasRoleMeta(payload.dallas?.availableRoles);
    state.th.mixingValve = normalizeMixingValveSources({ ...(state.th.mixingValve || {}), ...(payload.dallas?.mixingValve || {}) });
    state.th.mixingSourceMeta = normalizeMixTempSourceMeta(payload.dallas?.mixingValve?.availableSources);
    renderMixTempSourceSelectors();
    applied = true;
  }
  if(state.setupWizard && !state.setupWizard.completed && !state.ui.wizardAutoOpenScheduled){
    state.ui.wizardAutoOpenScheduled = true;
    setTimeout(() => {
      const overlay=document.getElementById("setupWizardOverlay");
      if(overlay && overlay.dataset.dismissed !== "1" && !state.setupWizard.completed) setupWizardOpen({auto:true});
    }, 700);
  }
  return applied;
}

// ----- Refresh
let timer = null;
let refreshing = false;
ensureWsState();

async function refresh(forceToast=false){
  if(refreshing) return;
  refreshing = true;
  try{
    setApiHealth("warn", state.ws?.připojeno ? "API: WS sync…" : "API: čtu…");

	    const shouldFetchFast = forceToast || !state.ws?.připojeno || !state.fast;
	    if(shouldFetchFast){
	      const fast = await api.getJson("/api/fast", 4000);
	      applyFastSnapshot(fast);
	    }

    if(state.net){
      state.net.failCount = 0;
      state.net.nextPollMs = document.hidden ? 30000 : 10000;
    }
    setApiHealth("good", state.ws?.připojeno ? "API: WebSocket" : "API: zařízení");

    const nowMs = Date.now();
    const activeView = getActiveView();
    const extrasRelevant = forceToast || activeView === "heating" || activeView === "mixing" || activeView === "dhw" || activeView === "opentherm";
    const extrasDue = extrasRelevant && (forceToast || !state.net || nowMs >= Number(state.net.extrasDueMs || 0));
    if(extrasDue){
      const data = await api.fetchStatusExtras(activeView);

      let needRender = false;
      if(data?.equitherm?.config){
        state.dev = state.dev || {};
        state.dev.eqCfgLoaded = true;
        applyEqConfigToForm(data.equitherm.config);
      }
      if(data?.equitherm?.status){
        applyEqStatus(data.equitherm.status);
        needRender = true;
      }
      if(data?.mixing?.config){
        state.dev = state.dev || {};
        state.dev.mixCfgLoaded = true;
        applyMixingConfigToForm(data.mixing.config);
      }
      if(data?.mixing?.status){
        applyMixingStatus(data.mixing.status);
        needRender = true;
      }
      if(data?.opentherm?.status){
        applyOtStatus(data.opentherm.status);
        needRender = true;
      }
      if(data?.opentherm?.config){
        state.dev = state.dev || {};
        state.dev.otCfgLoaded = true;
        applyOtConfigToForm(data.opentherm.config);
      }
      if(data?.dhw?.status){
        applyDhwStatus(data.dhw.status);
        needRender = true;
      }
      if(data?.dhw?.config){
        state.dev = state.dev || {};
        state.dev.dhwCfgLoaded = true;
        state.dhwCfg = data.dhw.config;
        applyDhwConfigToForm(data.dhw.config);
      }
      if(needRender && state.last) queueRenderSample(getUiSample());
      if(state.net) state.net.extrasDueMs = nowMs + (state.ws?.připojeno ? 30000 : 45000);
    }

    void refreshOtCapacity(false);

    setApiHealth("good", state.ws?.připojeno ? "API: WebSocket" : "API: zařízení");
    if(forceToast) toast("Aktualizováno", state.ws?.připojeno ? "Zařízení odpovědělo, WebSocket aktivní." : "Zařízení odpovědělo.", "🔌");
  }catch(e){
    const msg = e?.message || String(e);
    if(msg && /\/api\/(fast|config)\b/.test(msg) && maybeAdoptPageOriginBase("refresh", true)){
      log("refresh fallback retry -> same origin");
      refreshing = false;
      return await refresh(forceToast);
    }
    setApiHealth("bad", state.ws?.připojeno ? "API: WS chyba" : "API: chyba");
    if(state.net){
      state.net.failCount = Math.min(8, Number(state.net.failCount || 0) + 1);
      const backvypnutoMs = Math.min(120000, 10000 * Math.pow(2, Math.max(0, state.net.failCount - 1)));
      state.net.nextPollMs = Math.max(document.hidden ? 30000 : 10000, backvypnutoMs);
    }
    updateRefreshCadence();
    const nowMs = Date.now();
    const shouldToast = !!forceToast || !state.net || (nowMs - Number(state.net.lastErrorToastMs || 0) >= 60000);
    if(shouldToast){
      if(state.net) state.net.lastErrorToastMs = nowMs;
      toast("Chyba", msg, "⚠");
    }
    log("refresh error: " + msg);
  }finally{
    refreshing = false;
  }
}

    async function pushHeatingPlannerToDevice(){
      const week = [];
      let any = false;
      for(let i=0;i<7;i++){
        const arr = normIntervals(state.schedules?.heatingDay?.[i] || []);
        if(arr.length > HEATING_MAX_INTERVALS_PER_DAY) throw new Error(`Den ${i+1}: maximum je ${HEATING_MAX_INTERVALS_PER_DAY} intervalů.`);
        if(intervalsOverlap(arr)) throw new Error(`Den ${i+1}: intervaly se překrývají.`);
        const intervals = [];
        for(const iv of arr){
          const s = timeToMin(iv.start);
          const e = timeToMin(iv.end);
          if(Number.isFinite(s) && Number.isFinite(e) && s >= 0 && e >= 0 && s !== e){
            intervals.push({ startMin: s, endMin: e, start: iv.start, end: iv.end });
            any = true;
          }
        }
        const o = { day: ["mon","tue","wed","thu","fri","sat","sun"][i], intervals };
        if(intervals.length){
          o.dayStartMin = intervals[0].startMin;
          o.nightStartMin = intervals[0].endMin;
        }
        week.push(o);
      }
      if(!any) throw new Error("Plán topení je prázdný nebo neplatný.");
      await api.postConfigSection("equitherm", {
        schedule: {
          enabled: true,
          week,
        }
      });
      clearPendingSaveDirty("heatPlan");
      state.dev = state.dev || {};
      state.dev.eqCfgLoaded = false;
    }

    async function pushDhwPlannerToDevice(){
      const heatCfg = state.dev?.dhwCfgRaw?.heat || {};
      const circCfg = state.dev?.dhwCfgRaw?.circ || {};
      await api.postConfigSection("dhw", {
        heat: {
          useSchedule: true,
          scheduleEnabled: !!(heatCfg.scheduleEnabled ?? true),
          schedule: { week: serializeDhwWeek("dhwHeat") }
        },
        circ: {
          useSchedule: true,
          scheduleEnabled: !!(circCfg.scheduleEnabled ?? true),
          pulseEnabled: !!state.circPulse.enable,
          pulseOnMin: Math.max(0, Number(state.circPulse.onMin ?? 5)),
          pulseOffMin: Math.max(0, Number(state.circPulse.vypnutoMin ?? 15)),
          schedule: { week: serializeDhwWeek("dhwCirc") }
        }
      });
      clearPendingSaveDirty("dhwPlan");
    }

    async function syncAllPlannersToDevice(){
      await pushHeatingPlannerToDevice();
      await pushDhwPlannerToDevice();
      await refresh(false);
    }

    async function diagExportConfig(){
      const cfg = await api.getJson("/api/config", 12000);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const blob = new Blob([JSON.stringify(cfg, null, 2)], { type:"application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `esp32-config-${stamp}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1500);
      return cfg;
    }

    async function diagImportConfigFile(file){
      if(!file) throw new Error("Vyber JSON soubor s konfigurací.");
      const txt = await file.text();
      let payload = null;
      try{
        payload = JSON.parse(txt);
      }catch(_e){
        throw new Error("Soubor není validní JSON.");
      }
      const resp = await api.postJson("/api/config/import", payload, 20000);
      state.dev = state.dev || {};
      state.dev.eqCfgLoaded = false;
      state.dev.mixCfgLoaded = false;
      state.dev.dhwCfgLoaded = false;
      state.dev.otCfgLoaded = false;
      state.th.loaded = false;
      state.th.cfgLoaded = false;
      await heatingReloadConfigFromDevice().catch(() => null);
      await loadMixingConfigFromDevice().catch(() => null);
      await dhwReloadConfigFromDevice().catch(() => null);
      await mqttLoad({ silent:true }).catch(() => null);
      await timeLoad({ silent:true }).catch(() => null);
      await thermoLoad({ silent:true, forceConfig:true }).catch(() => null);
      await refresh(false);
      return resp;
    }

    // ----- Actions
    function wire(){
      // theme
      $("#btnTheme").addEventListener("click", () => {
        state.theme = state.theme === "light" ? "dark" : "light";
        applyTheme();
    renderHeatingOtInfo();
    renderMixCalibrationInfo();
        toast("Téma", state.theme === "light" ? "Světlý režim." : "Tmavý režim.", "🌓");
        // redraw sparklines for contrast
        ["sparkOut","sparkCH","sparkDHW","sparkPr"].forEach(id => {
          const key = id === "sparkOut" ? "out" : id === "sparkCH" ? "ch" : id === "sparkDHW" ? "dhw" : "pr";
          drawSpark($("#"+id), state.history[key]);
        });
        if(state.last) renderSample(state.last);
      });

      // refresh buttons
      $("#btnRefresh").addEventListener("click", () => withButtonBusy($("#btnRefresh"), "Obnovuji…", () => refresh(true)));
      $("#btnForceRefresh").addEventListener("click", () => withButtonBusy($("#btnForceRefresh"), "Aktualizuji…", () => refresh(true)));
      $("#btnQuickReboot")?.addEventListener("click", () => withButtonBusy($("#btnQuickReboot"), "Restartuji…", async () => {
        const ok = window.confirm("Opravdu restartovat zařízení?");
        if(!ok) return;
        await api.reboot();
        toast("Zařízení", "Restart odeslán.", "↻");
      }));

      // nav desktop + mobile
      $$("#sideNav a").forEach(a => a.addEventListener("click", (e) => {
        e.preventDefault();
        setView(a.dataset.view);
      }));
      $$("#bottomNav button").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
      $$('[data-open-view]').forEach(b => b.addEventListener("click", () => setView(b.dataset.openView)));
      document.getElementById("hMixOpeningDirection")?.addEventListener("change", syncMixUiVisibility);
      document.getElementById("hMixCurveMode")?.addEventListener("change", syncMixCurveUi);
      document.getElementById("btnSetupWizard")?.addEventListener("click", () => setupWizardOpen({auto:false}));
      document.getElementById("setupWizardClose")?.addEventListener("click", () => setupWizardClose(true));
      document.getElementById("setupWizardLater")?.addEventListener("click", () => setupWizardClose(true));
      document.getElementById("setupWizardPrev")?.addEventListener("click", () => { state.ui.wizardStep=Math.max(0,Number(state.ui.wizardStep||0)-1); setupWizardRenderStep(); });
      document.getElementById("setupWizardNext")?.addEventListener("click", () => { state.ui.wizardStep=Math.min(6,Number(state.ui.wizardStep||0)+1); setupWizardRenderStep(); });
      document.querySelectorAll("[data-wiz-step]").forEach(btn => btn.addEventListener("click", () => { state.ui.wizardStep=clamp(Number(btn.dataset.wizStep||0),0,6); setupWizardRenderStep(); }));
      document.getElementById("wizFloorProtection")?.addEventListener("change", syncWizardProfileUi);
      document.getElementById("setupWizardFinish")?.addEventListener("click", setupWizardFinish);
      const overlay=document.getElementById("setupWizardOverlay"); if(overlay) overlay.addEventListener("click", e => { if(e.target===overlay) setupWizardClose(true); });
      syncMixUiVisibility();

      // quick action
      $("#btnQuick").addEventListener("click", async () => {
        const quickBtn = $("#btnQuick");
        return withButtonBusy(quickBtn, "Provádím…", async () => {
          try{
            const active = !!state.dhwFast?.ha || !!state.io.relays[4];
            if(active){
              await dhwStopFromUi();
              toast("Rychlá akce", "Zastavuji TUV.", "⛔");
              log("quick -> dhw stop");
            }else{
              await dhwBoostFromUi(Number($("#dhw2Target")?.value || $("#dhwTarget")?.value || 50), String(document.getElementById("dhwRequestMode")?.value || "relay"), 15);
              toast("Rychlá akce", "Boost TUV 15 min.", "⚡");
              log("quick -> dhw boost 15 min");
            }
            await refresh(false);
          }catch(e){
            toast("Chyba", e.message || String(e), "⚠");
            log("quick action error: " + (e.message || e));
          }
        });
      });

      // overview function buttons
      $$("[data-act]").forEach(btn => btn.addEventListener("click", async () => {
        const act = btn.dataset.act;
        try{
          if(act === "eqEnableToggle"){
            await setEquithermEnabledFromUi(getEquithermEnabledState() !== true, btn);
            return;
          }
          if(act === "eqToggle"){
            const cur = String($("#eqMode")?.value || state.eqFast?.me || "auto");
            const next = (cur === "auto") ? ((state.eqFast?.me || "day") === "day" ? "night" : "day") : (cur === "day" ? "night" : "day");
            await api.eqCmd({ mode: next });
            if($("#eqMode")) $("#eqMode").value = next;
            toast("Ekviterm", `Mode -> ${next}`, "♨");
            log(`eqToggle -> ${next}`);
            await refresh(false);
            return;
          }
          if(act === "circToggle"){
            await dhwCircSetFromUi(!(state.dhwFast?.ca ?? state.io.relays[3]));
            toast("Cirkulace", "Přepnuto (zařízení).", "🔁");
            log("circToggle -> dhw circ");
            await refresh(false);
            return;
          }
          if(act === "dhwBoost"){
            await dhwBoostFromUi(Number($("#dhw2Target")?.value || $("#dhwTarget")?.value || 50), String(document.getElementById("dhwRequestMode")?.value || "relay"), 15);
            toast("TUV", "Boost 15 min (zařízení).", "⚡");
            log("dhwBoost -> /api/dhw/cmd command=boost durationSec=900");
            await refresh(false);
            return;
          }
        }catch(e){
          toast("Chyba", e.message || String(e), "⚠");
          log("quick action error: " + (e.message || e));
          return;
        }
      }));

      // Přímé zapnutí/vypnutí ekvitermní regulace. Stav se ukládá ihned,
      // ostatní parametry topení se nadále ukládají tlačítkem „Uložit změny“.
      document.getElementById("hEqEnabled")?.addEventListener("change", async (ev) => {
        const el = ev.currentTarget;
        try{
          await setEquithermEnabledFromUi(!!el.checked, el);
        }catch(_e){}
      });

      // Apply buttons
      $("#btnEqApply")?.addEventListener("click", async () => {
        try{
          const mode = $("#eqMode")?.value || "auto";
          const enabledState = getEquithermEnabledState();
          const enabled = enabledState == null ? !!document.getElementById("hEqEnabled")?.checked : enabledState;
          await api.eqCmd({ enabled, mode });
          toast("Ekviterm", "Uloženo do zařízení.", "✅");
          log(`eq cmd -> /api/equitherm/cmd enabled=${enabled} mode=${mode}`);
          await refresh(false);
        }catch(e){
          toast("Chyba", e.message || String(e), "⚠");
          log("eq apply error: " + (e.message || e));
        }
      });

      $("#btnDhwApply")?.addEventListener("click", async () => {
        try{
          await dhwStartFromUi(Number($("#dhw2Target")?.value || $("#dhwTarget")?.value || 50), String(document.getElementById("dhwRequestMode")?.value || "relay"));
          toast("TUV", "Ohřev spuštěn (zařízení).", "🚿");
          log("dhw start -> /api/dhw/cmd command=start");
          await refresh(false);
        }catch(e){
          toast("Chyba", e.message || String(e), "⚠");
          log("dhw start error: " + (e.message || e));
        }
      });
      $("#btnDhwStop")?.addEventListener("click", async () => {
        try{
          await dhwStopFromUi();
          toast("TUV", "Zastaveno.", "⛔");
          log("dhw stop -> /api/dhw/cmd command=stop");
          await refresh(false);
        }catch(e){
          toast("Chyba", e.message || String(e), "⚠");
          log("dhw stop error: " + (e.message || e));
        }
      });

      $("#btnCircOn")?.addEventListener("click", async () => {
        try{
          await dhwCircSetFromUi(true);
          toast("Cirkulace", "Zapnuto.", "✅");
          log("circ on -> /api/dhw/cmd command=circulation");
          await refresh(false);
        }catch(e){
          toast("Chyba", e.message || String(e), "⚠");
          log("circ on error: " + (e.message || e));
        }
      });
      $("#btnCircOff")?.addEventListener("click", async () => {
        try{
          await dhwCircSetFromUi(false);
          toast("Cirkulace", "Vypnuto.", "⭕");
          log("circ vypnuto -> /api/dhw/cmd command=circulation active=false");
          await refresh(false);
        }catch(e){
          toast("Chyba", e.message || String(e), "⚠");
          log("circ vypnuto error: " + (e.message || e));
        }
      });

      document.getElementById("dhwCirc")?.addEventListener("change", async (ev) => {
        const el = ev.currentTarget;
        const desired = !!el.checked;
        try{
          await dhwCircSetFromUi(desired);
          toast("Cirkulace", desired ? "Zapnuto." : "Vypnuto.", desired ? "✅" : "⭕");
          log(`circ -> /api/dhw/cmd command=circulation active=${desired}`);
          await refresh(false);
        }catch(e){
          el.checked = !desired;
          toast("Chyba", e.message || String(e), "⚠");
          log("circ change error: " + (e.message || e));
        }
      });

      $("#btnAllOff").addEventListener("click", async () => {
        try{
          const res = await safeStopSystem();
          toast("Bezpečné zastavení", res?.state === "safe" ? "Zařízení přešlo do bezpečného stavu." : "Sekvence proběhla jen částečně.", "⛔");
          await refresh(false);
        }catch(e){
          toast("Chyba", e.message || String(e), "⚠");
          log("safeStop error: " + (e.message || e));
        }
      });


      // live update equitherm chart when heating inputs change
      ["hDaySlope","hDayShift","hNightSlope","hNightShift","hMin","hMax","hBoilerMax","hTarget","eqSet","hMixCurveMode","hMixDay2OutCold","hMixDay2FlowCold","hMixDay2OutWarm","hMixDay2FlowWarm","hMixNight2OutCold","hMixNight2FlowCold","hMixNight2OutWarm","hMixNight2FlowWarm","hMixDayM20","hMixDayM10","hMixDay0","hMixDayP10","hMixNightM20","hMixNightM10","hMixNight0","hMixNightP10","hMixCurveMinFlow","hMixCurveMaxFlow","hEqModeCfg","hUseIn1NightOverride","hSummerModeEnabled","hSummerOffAboveC","hSummerOnBelowC","hDriveNightRelay","hNightRelay","hNightRelayOnWhenNight","hBoilerAssistEnabled","hBoilerAssistDeltaC","hBoilerAssistForceChEnable"].forEach(id => {
        const el = document.getElementById(id);
        if(!el) return;
        el.addEventListener("input", redrawEquithermViewsDebounced);
        el.addEventListener("change", redrawEquithermViewsDebounced);
      });
      eqConfigInputIds().forEach(id => {
        const el = document.getElementById(id);
        if(!el) return;
        const markDirty = () => setEqConfigDirty(true);
        el.addEventListener("input", markDirty);
        el.addEventListener("change", markDirty);
      });
      mixConfigInputIds().forEach(id => {
        const el = document.getElementById(id);
        if(!el) return;
        const markDirty = () => setMixConfigDirty(true);
        el.addEventListener("input", markDirty);
        el.addEventListener("change", markDirty);
      });

      // Planner render + save buttons
      ["heatingDay","dhwHeat","dhwCirc"].forEach(k => renderPlanner(k));
      // Circulation pulse controls (DHW circulation)
const elPulse = document.getElementById("circPulseEnable");
const elOn = document.getElementById("circPulseOn");
const elOff = document.getElementById("circPulseOff");
if(elPulse && elOn && elOff){
  elPulse.checked = !!state.circPulse.enable;
  elOn.value = String(Math.max(0, Number(state.circPulse.onMin ?? 5)));
  elOff.value = String(Math.max(0, Number(state.circPulse.vypnutoMin ?? 15)));

  const applyPulse = debounce(() => {
    state.circPulse.enable = !!elPulse.checked;
    state.circPulse.onMin = Math.max(0, Number(elOn.value || 0));
    state.circPulse.vypnutoMin = Math.max(0, Number(elOff.value || 0));
    saveCircPulse();
    updatePlannerStateBadges();
    toast("Cirkulace TUV", state.circPulse.enable ? `Pulzní režim: ${state.circPulse.onMin} min ON / ${state.circPulse.vypnutoMin} min OFF` : "Pulzní režim vypnut (běží kontinuálně v rámci plánu).", "🟠");
    log(`circ pulse: enable=${state.circPulse.enable} on=${state.circPulse.onMin} vypnuto=${state.circPulse.vypnutoMin}`);
  }, 180);
  ["change","input"].forEach(ev => { elPulse.addEventListener(ev, applyPulse); elOn.addEventListener(ev, applyPulse); elOff.addEventListener(ev, applyPulse); });
}

updatePlannerStateBadges();
      setInterval(updatePlannerStateBadges, 10000);

      document.querySelectorAll("[data-pl-save]").forEach(btn => btn.addEventListener("click", async () => {
        saveSchedules();
        toast("Plán", "Uloženo.", "✅");
        log(`planner saved (${btn.dataset.plSave})`);

        if(btn.dataset.plSave === "heatingDay"){
          try{
            await pushHeatingPlannerToDevice();
            toast("Ekviterm plán", "Odesláno do zařízení.", "✅");
            log("schedule -> /api/config/equitherm");
            await refresh(false);
          }catch(e){
            toast("Chyba", e.message || String(e), "⚠");
            log("schedule error: " + (e.message || e));
          }
        }

        if(btn.dataset.plSave === "dhwHeat"){
          try{
            await pushDhwPlannerToDevice();
            toast("TUV plán", "Odesláno do zařízení.", "✅");
            log("schedule -> /api/config/dhw");
            await refresh(false);
          }catch(e){
            toast("Chyba", e.message || String(e), "⚠");
            log("dhw schedule error: " + (e.message || e));
          }
        }

        if(state.last) renderSample(state.last);
      }));

      $("#plExport")?.addEventListener("click", () => {
        const blob = new Blob([JSON.stringify(state.schedules,null,2)], {type:"application/json"});
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "ui2026_schedules.json";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        toast("Plán", "Export stažen.", "⬇");
      });

      $("#plImport")?.addEventListener("click", async () => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "application/json";
        inp.addEventListener("change", async () => {
          const f = inp.files?.[0];
          if(!f) return;
          try{
            const txt = await f.text();
            const obj = JSON.parse(txt);
            if(!obj?.heatingDay || !obj?.dhwHeat || !obj?.dhwCirc) throw new Error("Neplatný formát.");
            state.schedules = obj;
            saveSchedules();
            ["heatingDay","dhwHeat","dhwCirc"].forEach(k => renderPlanner(k));
            updatePlannerStateBadges();
            if(state.source === "device"){
              await syncAllPlannersToDevice();
              toast("Plán", "Import hotový a odeslaný do zařízení.", "✅");
              log("planner import ok + device sync");
            }else{
              toast("Plán", "Import hotový.", "✅");
              log("planner import ok");
            }
            if(state.last) renderSample(state.last);
          }catch(e){
            toast("Import selhal", e.message || String(e), "⚠");
            log("planner import error: " + (e.message || e));
          }
        });
        inp.click();
      });


      // DHW planner export/import buttons (reuse same logic)
      $("#plExport2")?.addEventListener("click", () => $("#plExport")?.click());
      $("#plImport2")?.addEventListener("click", () => $("#plImport")?.click());


      $("#otPing")?.addEventListener("click", () => refresh(true));
      $("#otMergeRefresh")?.addEventListener("click", () => refresh(true));

      // Accu refresh
      $("#accuRefresh")?.addEventListener("click", () => refresh(true));

      // OpenTherm advanced
      $("#otScanRefresh")?.addEventListener("click", otScanRefresh);
      $("#otScanStart")?.addEventListener("click", otScanStart);
      $("#otScanStop")?.addEventListener("click", otScanStop);
      $("#otScanShowAll")?.addEventListener("change", () => otRenderScan(state.otAdv.scan || {}));
      if(getActiveView() === "opentherm") void otProfileRefresh();

      $("#otRwRead")?.addEventListener("click", otRwRead);
      $("#otRwWrite")?.addEventListener("click", otRwWrite);
      $("#otRwCopy")?.addEventListener("click", async () => {
        const t = document.getElementById("otRwOut")?.textContent || "";
        try{ await navigator.clipboard.writeText(t); toast("OpenTherm", "Zkopírováno.", "📋"); }catch{ toast("OpenTherm", "Clipboard nelze.", "⚠"); }
      });


      $("#hFit")?.addEventListener("click", () => {
        eq.fitY = !eq.fitY;
        toast("Graf", eq.fitY ? "Auto Y rozsah: zapnuto" : "Auto Y rozsah: vypnuto", "📈");
        if(state.last) renderSample(state.last);
      });
      // Heating view apply
      $("#hApply").addEventListener("click", async () => withButtonBusy($("#hApply"), "Ukládám…", async () => {
        try{
          const dayCurve = {
            slope: Number($("#hDaySlope")?.value),
            shift: Number($("#hDayShift")?.value),
          };
          const nightCurve = {
            slope: Number($("#hNightSlope")?.value),
            shift: Number($("#hNightShift")?.value),
          };
          const day = eqPointsFromCurve(dayCurve);
          const night = eqPointsFromCurve(nightCurve);
          const rawLimits = {
            minFlowC: Number($("#hMin")?.value),
            maxFlowC: Number($("#hMax")?.value),
          };
          const limits = normalizeHeatingFlowLimits(rawLimits);
          const minEl = $("#hMin");
          const maxEl = $("#hMax");
          if(minEl && Number.isFinite(limits.minFlowC) && Math.abs(limits.minFlowC - Number(rawLimits.minFlowC)) > 0.01) minEl.value = String(limits.minFlowC);
          if(maxEl && Number.isFinite(limits.maxFlowC) && Math.abs(limits.maxFlowC - Number(rawLimits.maxFlowC)) > 0.01) maxEl.value = String(limits.maxFlowC);
          const rawBoilerMaxChC = Number($("#hBoilerMax")?.value);
          let boilerMaxChC = rawBoilerMaxChC;
          const otBoundLo = Number(state.ot?.maxChBoundMinC);
          const otBoundHi = Number(state.ot?.maxChBoundMaxC);
          if(Number.isFinite(boilerMaxChC)){
            if(Number.isFinite(otBoundLo)) boilerMaxChC = Math.max(boilerMaxChC, otBoundLo);
            if(Number.isFinite(otBoundHi)) boilerMaxChC = Math.min(boilerMaxChC, otBoundHi);
            const boilerMaxEl = $("#hBoilerMax");
            if(boilerMaxEl && Math.abs(boilerMaxChC - rawBoilerMaxChC) > 0.01) boilerMaxEl.value = String(boilerMaxChC);
          }
          const output = {
            applyBoilerMaxCh: !!$("#hWrite57")?.checked,
            boilerMaxChC,
            driveNightRelay: !!$("#hDriveNightRelay")?.checked,
            nightRelay: Number($("#hNightRelay")?.value || 6),
            nightRelayOnWhenNight: !!$("#hNightRelayOnWhenNight")?.checked,
          };
          const deltaC = Number.parseFloat($("#hBoilerAssistDeltaC")?.value ?? "");
          if(!Number.isFinite(deltaC) || deltaC < 0 || deltaC > 20)
            throw new Error("Navýšení teploty kotle musí být v rozsahu 0–20 °C.");
          const boilerAssist = {
            enabled: !!$("#hBoilerAssistEnabled")?.checked,
            deltaC,
            forceChEnable: !!$("#hBoilerAssistForceChEnable")?.checked,
          };
          const mode = String($("#hEqModeCfg")?.value || $("#eqMode")?.value || "auto");
          if(document.getElementById("eqMode")) document.getElementById("eqMode").value = mode;

          await api.postConfigSection("equitherm", {
            enabled: !!document.getElementById("hEqEnabled")?.checked,
            mode,
            useIn1NightOverride: !!$("#hUseIn1NightOverride")?.checked,
            summerModeEnabled: !!$("#hSummerModeEnabled")?.checked,
            summerOffAboveC: Number($("#hSummerOffAboveC")?.value || 18),
            summerOnBelowC: Number($("#hSummerOnBelowC")?.value || 16),
            day, night,
            limits: {
              ...limits,
              // Keep the OpenTherm CH safety clamp aligned with the single
              // Min/Max Flow pair shown on the heating page.
              minChSetpointC: limits.minFlowC,
              maxChSetpointC: limits.maxFlowC,
            },
            output, boilerAssist
          });
          setEqConfigDirty(false);
          toast("Topení", "Nastavení uloženo do zařízení.", "✅");
          log("heating apply -> /api/config/equitherm");
          // allow refresh to hydrate updated values
          state.dev = state.dev || {};
          state.dev.eqCfgLoaded = false;
          await refresh(false);
          redrawEquithermViews();
        }catch(e){
          toast("Chyba", e.message || String(e), "⚠");
          log("heating apply error: " + (e.message || e));
        }
      }));

      document.getElementById("hReloadConfig")?.addEventListener("click", () => withButtonBusy(document.getElementById("hReloadConfig"), "Načítám…", async () => {
        try{
          await heatingReloadConfigFromDevice();
          toast("Topení", "Konfigurace načtena ze zařízení.", "✅");
          log("heating reload config");
        }catch(e){
          toast("Chyba", e.message || String(e), "⚠");
          log("heating reload config error: " + (e.message || e));
        }
      }));

      const mixSaveBtn = document.getElementById("hMixSave");
      if(mixSaveBtn){
        mixSaveBtn.addEventListener("click", () => withButtonBusy(mixSaveBtn, "Ukládám…", async () => {
          const cfg = collectMixingConfigFromForm();
          await api.postConfigSection("mixing", cfg);
          setMixConfigDirty(false);
          state.dev.mixCfgLoaded = false;
          if(state.net) state.net.extrasDueMs = 0;
          await loadMixingConfigFromDevice();
          await refresh(false);
          toast("Směšovací ventil", "Nová konfigurace byla uložena.", "✅");
        }));
      }
      const mixReloadBtn = document.getElementById("hMixReload");
      if(mixReloadBtn){
        mixReloadBtn.addEventListener("click", () => withButtonBusy(mixReloadBtn, "Načítám…", async () => {
          await loadMixingConfigFromDevice();
          if(state.net) state.net.extrasDueMs = 0;
          await refresh(false);
          toast("Směšovací ventil", "Konfigurace byla načtena ze zařízení.", "✅");
        }));
      }
      const mixToggle = document.getElementById("hMixToggleAuto");
      if(mixToggle){
        mixToggle.addEventListener("click", () => withButtonBusy(mixToggle, "Přepínám…", async () => {
          const current = !!(state.mixStatus?.enabled ?? state.eqFast?.mix?.en ?? state.mixConfig?.enabled);
          await api.mixCmd({ enabled:!current });
          const en=document.getElementById("hMixEnabled"); if(en) en.checked=!current;
          if(state.net) state.net.extrasDueMs=0;
          await refresh(false);
        }));
      }

      bindImmediateButton(document.getElementById("hMixPulseA"), "Pulzuji A…", () => mixManualPulse("a"));
      bindImmediateButton(document.getElementById("hMixPulseB"), "Pulzuji B…", () => mixManualPulse("b"));
      bindImmediateButton(document.getElementById("hMixEndA"), "Přejíždím A…", () => mixManualMoveToEnd("a"));
      bindImmediateButton(document.getElementById("hMixEndB"), "Přejíždím B…", () => mixManualMoveToEnd("b"));
      bindImmediateButton(document.getElementById("hMixStop"), "Zastavuji…", () => mixManualStop());
      const calA=document.getElementById("hMixCalibrateA");
      if(calA) calA.addEventListener("click",()=>withButtonBusy(calA,"Kalibruji A…",()=>mixCalibrationCommand("calibrate_a")));
      const calB=document.getElementById("hMixCalibrateB");
      if(calB) calB.addEventListener("click",()=>withButtonBusy(calB,"Kalibruji B…",()=>mixCalibrationCommand("calibrate_b")));
      const mixInvalidateBtn = document.getElementById("hMixInvalidate");
      if(mixInvalidateBtn) mixInvalidateBtn.addEventListener("click", () => withButtonBusy(mixInvalidateBtn, "Zneplatňuji…", () => mixCalibrationCommand("invalidate")));
      const bindWizardTest = (id,busy,fn) => { const b=document.getElementById(id); if(b) b.addEventListener("click", () => withButtonBusy(b,busy,async()=>{ await wizardApplyDraft(); await fn(); renderWizardCalibrationState(); })); };
      bindWizardTest("wizPulseA","Testuji A…",()=>mixManualPulse("a"));
      bindWizardTest("wizPulseB","Testuji B…",()=>mixManualPulse("b"));
      const wizStopBtn=document.getElementById("wizStop");
      if(wizStopBtn) wizStopBtn.addEventListener("click", () => withButtonBusy(wizStopBtn,"Zastavuji…",async()=>{ await mixManualStop(); renderWizardCalibrationState(); }));
      bindWizardTest("wizCalB","Kalibruji B…",()=>mixCalibrationCommand("calibrate_b"));
      bindWizardTest("wizCalA","Kalibruji A…",()=>mixCalibrationCommand("calibrate_a"));
      document.getElementById("bleSave")?.addEventListener("click", bleSave);

// OpenTherm config actions
      const otBtn = $("#otCfgApply");
      if(otBtn){
        otBtn.addEventListener("click", async () => withButtonBusy(otBtn, "Ukládám…", async () => {
          try{
            state.ot.cfg = state.ot.cfg || {};
            let enabled = !!$("#otEnable")?.checked;
            const pollMs = clamp(Number($("#otPoll")?.value ?? 2000), 250, 60000);
            let mode = String($("#otFailMode")?.value || "control");
            const compat = ensureOtConfigCompatible(enabled, mode);
            enabled = compat.enabled; mode = compat.mode;
            if(compat.adjusted) toast("OpenTherm", "Režim control zůstal aktivní, protože OT používá topení nebo TUV.", "ℹ");
            const allowRawWrite = !!$("#otLog")?.checked;

            await api.postConfigSection("opentherm", {
              enabled,
              autoStart: enabled,
              pollMs,
              mode,
              boilerControl: mode === "control" ? "opentherm" : "relay",
              allowRawWrite
            });
            clearPendingSaveDirty("ot");
            toast("OpenTherm", "Nastavení uloženo do zařízení.", "✅");
            log(`ot cfg -> /api/config/opentherm enabled=${enabled} pollMs=${pollMs} mode=${mode} raw=${allowRawWrite}`);
            state.dev = state.dev || {};
            state.dev.otCfgLoaded = false;
            await refresh(false);
          }catch(e){
            toast("Chyba", e.message || String(e), "⚠");
            log("ot cfg error: " + (e.message || e));
          }
        }));
      }

      const pressBtn = $("#pressAlarmApply");
      if(pressBtn){
        pressBtn.addEventListener("click", async () => withButtonBusy(pressBtn, "Ukládám…", async () => {
          try{
            const enabled = !!$("#pressAlarmEnable")?.checked;
            const minBar = clamp(Number($("#pressAlarmMin")?.value ?? 0.8), 0.1, 6.0);
            const maxBar = clamp(Number($("#pressAlarmMax")?.value ?? 2.8), 0.1, 6.0);
            const hysteresisBar = clamp(Number($("#pressAlarmHys")?.value ?? 0.05), 0.01, 1.0);
            await api.postConfigSection("alerts", { pressure: { enabled, minBar, maxBar, hysteresisBar } });
            clearPendingSaveDirty("pressure");
            applyAlertsConfigToForm({ pressure: { enabled, minBar, maxBar, hysteresisBar }});
            toast("Alarm tlaku", "Nastavení uloženo do zařízení.", "✅");
            log(`pressure alarm -> /api/config/alerts enabled=${enabled} min=${minBar} max=${maxBar} hys=${hysteresisBar}`);
            await refresh(false);
          }catch(e){
            toast("Chyba", e.message || String(e), "⚠");
            log("pressure alarm error: " + (e.message || e));
          }
        }));
      }

      // DHW view actions
      $("#dhwStart").addEventListener("click", async () => withButtonBusy($("#dhwStart"), "Spouštím…", async () => {
        try{
          const requestMode = String(document.getElementById("dhwRequestMode")?.value || "relay");
          const targetTempC = Number(document.getElementById("dhw2Target")?.value || 50);
          await dhwStartFromUi(targetTempC, requestMode);
          toast("TUV", `Spuštěno (${requestMode === "opentherm" ? "OpenTherm" : "R5"}).`, "🚿");
          log(`dhwStart -> ${requestMode}`);
          await refresh(false);
        }catch(e){
          toast("Chyba", e.message || String(e), "⚠");
          log("dhwStart error: " + (e.message || e));
        }
      }));
      $("#dhwStop2").addEventListener("click", async () => withButtonBusy($("#dhwStop2"), "Zastavuji…", async () => {
        try{
          await dhwStopFromUi();
          toast("TUV", "Stop.", "⛔");
          log("dhwStop");
          await refresh(false);
        }catch(e){
          toast("Chyba", e.message || String(e), "⚠");
          log("dhwStop error: " + (e.message || e));
        }
      }));
      document.getElementById("dhwReloadCfg")?.addEventListener("click", () => withButtonBusy(document.getElementById("dhwReloadCfg"), "Načítám…", async () => {
        try{
          await dhwReloadConfigFromDevice();
          toast("TUV", "Konfigurace načtena ze zařízení.", "✅");
          log("dhw reload config");
        }catch(e){
          toast("Chyba", e.message || String(e), "⚠");
          log("dhw reload config error: " + (e.message || e));
        }
      }));
      document.getElementById("dhwSaveCfg")?.addEventListener("click", () => withButtonBusy(document.getElementById("dhwSaveCfg"), "Ukládám…", async () => {
        try{
          await dhwSaveConfigFromUi();
          toast("TUV", "Konfigurace uložena do zařízení.", "✅");
          log("dhw save config");
        }catch(e){
          toast("Chyba", e.message || String(e), "⚠");
          log("dhw save config error: " + (e.message || e));
        }
      }));
      $("#dhwBoost2").addEventListener("click", async () => withButtonBusy($("#dhwBoost2"), "Spouštím boost…", async () => {
        try{
          const requestMode = String(document.getElementById("dhwRequestMode")?.value || "relay");
          const targetTempC = Number(document.getElementById("dhw2Target")?.value || 50);
          await dhwBoostFromUi(targetTempC, requestMode, 15);
          toast("TUV", `Boost 15 min (${requestMode === "opentherm" ? "OpenTherm" : "R5"}).`, "⚡");
          log(`dhwBoost -> ${requestMode} 15 min`);
          await refresh(false);
          return;
        }catch(e){
          toast("Chyba", e.message || String(e), "⚠");
          log("dhwBoost error: " + (e.message || e));
          return;
        }
      }));

      // IO safe stop
      $("#ioAllOff")?.addEventListener("click", async () => {
        try{
          const res = await safeStopSystem();
          toast("Bezpečné zastavení", res?.state === "safe" ? "Zařízení přešlo do bezpečného stavu." : "Sekvence proběhla jen částečně.", "⛔");
          renderIO(); renderOverviewBadges();
        }catch(e){
          toast("Chyba", e.message || String(e), "⚠");
          log("io safeStop error: " + (e.message || e));
        }
      });

      // Copy diag
      $("#btnCopy")?.addEventListener("click", async () => {
        const s = [
          `device=${$("#dName")?.textContent || "ESP32"}`,
          `ip=${$("#dIp")?.textContent || state.dev?.ip || "--"}`,
          `uptime=${$("#dUp")?.textContent || uptimeString()}`,
          `source=device`,
          `apiBase=${state.apiBase || "(origin)"}`,
          `out=${$("#kpiOut").textContent}`,
          `ch=${$("#kpiCH").textContent}`,
          `dhw=${$("#kpiDHW").textContent}`,
          `pr=${$("#kpiPr").textContent}`,
          `heapFree=${fmtBytes(state?.diag?.heap?.free)}`,
          `heapMin=${fmtBytes(state?.diag?.heap?.minFree)}`,
          `heapMaxAlloc=${fmtBytes(state?.diag?.heap?.maxAlloc)}`,
        ].join("\n");
        try{
          await navigator.clipboard.writeText(s);
          toast("Zkopírováno", "Diagnostika je v schránce.", "📋");
        }catch{
          toast("Nelze kopírovat", "Prohlížeč nepovolil clipboard.", "⚠");
        }
      });

      // Diag view: API base save
      $("#apiSave").addEventListener("click", () => {
        state.apiBase = $("#apiBase").value.trim();
        localStorage.setItem("ui2026_apiBase", state.apiBase);
        clearPendingSaveDirty("api");
        syncApiBaseUi();
        toast("Uloženo", "Base URL nastaveno.", "✅");
        log(`apiBase set to: ${state.apiBase || "(origin)"}`);
      });

      const mqttRefreshBtn = document.getElementById("mqttRefresh");
      if(mqttRefreshBtn){
        mqttRefreshBtn.addEventListener("click", () => withButtonBusy(mqttRefreshBtn, "Načítám…", () => mqttLoad({ silent:false })));
      }
      const mqttSaveBtn = document.getElementById("mqttSave");
      if(mqttSaveBtn){
        mqttSaveBtn.addEventListener("click", () => withButtonBusy(mqttSaveBtn, "Ukládám…", () => mqttSave()));
      }
      document.getElementById("timeRefresh")?.addEventListener("click", () => withButtonBusy(document.getElementById("timeRefresh"), "Načítám…", () => timeLoad({ silent:false })));
      document.getElementById("timeSave")?.addEventListener("click", () => withButtonBusy(document.getElementById("timeSave"), "Ukládám…", () => timeSave()));
      document.getElementById("eventsRefresh")?.addEventListener("click", () => withButtonBusy(document.getElementById("eventsRefresh"), "Načítám…", () => eventsLoad({ silent:false })));
      document.getElementById("eventsClear")?.addEventListener("click", async () => withButtonBusy(document.getElementById("eventsClear"), "Mažu…", async () => { await api.postJson("/api/events/clear", {}); await eventsLoad({ silent:true }); toast("Event log", "Vymazáno.", "🧹"); }));
      document.getElementById("historyRefresh")?.addEventListener("click", () => withButtonBusy(document.getElementById("historyRefresh"), "Načítám…", () => historyLoad({ silent:false })));
      document.getElementById("historyClear")?.addEventListener("click", async () => withButtonBusy(document.getElementById("historyClear"), "Mažu…", async () => { await api.postJson("/api/history/clear", {}); await historyLoad({ silent:true }); toast("Historie", "Vymazána.", "🧹"); }));
      document.getElementById("serviceRelayOn")?.addEventListener("click", async () => withButtonBusy(document.getElementById("serviceRelayOn"), "Odesílám…", async () => { await serviceIoCall({ relay: Number(document.getElementById("serviceRelay")?.value || 3), on: true }); toast("Servis I/O", "Relé zapnuto.", "✅"); await refresh(false); }));
      document.getElementById("serviceRelayOff")?.addEventListener("click", async () => withButtonBusy(document.getElementById("serviceRelayOff"), "Odesílám…", async () => { await serviceIoCall({ relay: Number(document.getElementById("serviceRelay")?.value || 3), on: false }); toast("Servis I/O", "Relé vypnuto.", "⭕"); await refresh(false); }));
      document.getElementById("serviceRelayPulse")?.addEventListener("click", async () => withButtonBusy(document.getElementById("serviceRelayPulse"), "Puls…", async () => { await serviceIoCall({ pulseRelay: Number(document.getElementById("serviceRelay")?.value || 3), pulseMs: 500 }); toast("Servis I/O", "Puls odeslán.", "🧪"); await refresh(false); }));
      document.getElementById("serviceBuzzerStartup")?.addEventListener("click", async () => withButtonBusy(document.getElementById("serviceBuzzerStartup"), "Odesílám…", async () => { await serviceIoCall({ buzzer: "startup" }); toast("Servis I/O", "Buzzer startup.", "🔔"); }));
      document.getElementById("serviceBuzzerWarn")?.addEventListener("click", async () => withButtonBusy(document.getElementById("serviceBuzzerWarn"), "Odesílám…", async () => { await serviceIoCall({ buzzer: "warning" }); toast("Servis I/O", "Buzzer warning.", "🔔"); }));
      document.getElementById("serviceBuzzerOff")?.addEventListener("click", async () => withButtonBusy(document.getElementById("serviceBuzzerOff"), "Odesílám…", async () => { await serviceIoCall({ buzzer: "off" }); toast("Servis I/O", "Buzzer vypnut.", "🔕"); }));

      // Diag ping + export
      $("#diagPing").addEventListener("click", async () => withButtonBusy($("#diagPing"), "Ping…", async () => {
        try{
          setSource("device");
          await refresh(true);
        }catch{}
      }));
      const diagExportBtn = $("#diagExport");
      if(diagExportBtn){
        diagExportBtn.addEventListener("click", () => withButtonBusy(diagExportBtn, "Exportuji…", async () => {
          try{
            await diagExportConfig();
            toast("Konfigurace", "Stažen export konfigurace zařízení.", "⬇");
          }catch(e){
            toast("Chyba", e.message || String(e), "⚠");
            log("diag export error: " + (e.message || e));
          }
        }));
      }

      const diagImportBtn = $("#diagImport");
      const diagImportFile = document.getElementById("diagImportFile");
      if(diagImportBtn && diagImportFile){
        diagImportBtn.addEventListener("click", () => { diagImportFile.value = ""; diagImportFile.click(); });
        diagImportFile.addEventListener("change", () => {
          const file = diagImportFile.files && diagImportFile.files[0];
          if(!file) return;
          withButtonBusy(diagImportBtn, "Importuji…", async () => {
            try{
              const resp = await diagImportConfigFile(file);
              const imported = Number(resp?.importedSections ?? 0);
              toast("Konfigurace", `Import hotov (${imported} sekcí).`, "✅");
            }catch(e){
              toast("Chyba", e.message || String(e), "⚠");
              log("diag import error: " + (e.message || e));
            }
          });
        });
      }

      $("#logClear").addEventListener("click", () => { $("#log").textContent=""; toast("Log", "Smazáno.", "🧹"); });
      $("#otaFwUploadBtn")?.addEventListener("click", async () => { try{ await uploadWithProgress("/api/update/firmware", "otaFwFile", "otaFw"); }catch(e){ updateUploadProgress("otaFw", 0, 0, e.message || String(e), false); toast("OTA", e.message || String(e), "⚠"); } });
      $("#otaFsUploadBtn")?.addEventListener("click", async () => { try{ await uploadWithProgress("/api/update/filesystem", "otaFsFile", "otaFs"); }catch(e){ updateUploadProgress("otaFs", 0, 0, e.message || String(e), false); toast("OTA", e.message || String(e), "⚠"); } });

      // Keyboard shortcuts
      window.addEventListener("keydown", (e) => {
        if(e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return;
        if(e.key === "t" || e.key === "T"){ $("#btnTheme").click(); }
        if(e.key === "r" || e.key === "R"){ withButtonBusy($("#btnRefresh"), "Obnovuji…", () => refresh(true)); }
      });
    }

    window.addEventListener("error", e => {
  console.error("UI error:", e.message);
  log("ui error: " + (e.message || e.error || "unknown"));
});

// ----- Contextual bubble tooltips for every configurable control
const tooltipHelpById = {
  mqttEnable: "Zapne MQTT klienta. Po uložení se zařízení připojí k nastavenému brokeru a začne publikovat stav.",
  mqttHost: "IP adresa nebo DNS název MQTT brokeru, například Home Assistant Mosquitto broker.",
  mqttPort: "TCP port MQTT brokeru. Běžné nezabezpečené MQTT používá port 1883.",
  mqttUser: "Uživatelské jméno pro ověření vůči MQTT brokeru. Ponechte prázdné, pokud broker autentizaci nevyžaduje.",
  mqttPassword: "Heslo MQTT uživatele. Prázdné pole při uložení ponechá již uložené heslo beze změny.",
  mqttClearPassword: "Smaže dříve uložené MQTT heslo. Použijte pouze při záměrné změně na připojení bez hesla.",
  mqttClientId: "Jedinečný identifikátor MQTT klienta. Každé zařízení připojené ke stejnému brokeru musí mít odlišné Client ID.",
  mqttBaseTopic: "Kořen všech provozních MQTT témat zařízení, například esp32-controller/state a esp32-controller/cmd.",
  mqttPublishIntervalMs: "Perioda pravidelného publikování kompletního stavu. Kratší interval zvyšuje aktuálnost i provoz na síti.",
  mqttHaEnable: "Povolí části určené pro Home Assistant, včetně metadat zařízení a dostupnosti.",
  mqttHaDiscovery: "Publikuje retained MQTT discovery konfiguraci, aby Home Assistant vytvořil entity automaticky.",
  mqttDiscoveryPrefix: "Kořen discovery témat Home Assistantu. Výchozí hodnota je homeassistant.",
  mqttNodeId: "Stabilní a jedinečné ID zařízení použité v discovery tématech a unique_id entit. Po změně mohou v HA vzniknout nové entity.",
  hDaySlope: "Určuje citlivost denní ekvitermní křivky na venkovní teplotu. Vyšší sklon znamená teplejší topnou vodu při chladu.",
  hDayShift: "Posune celou denní ekvitermní křivku nahoru nebo dolů bez změny jejího sklonu.",
  hNightSlope: "Určuje citlivost noční ekvitermní křivky na venkovní teplotu.",
  hNightShift: "Posune noční křivku. Záporná hodnota obvykle vytváří noční útlum.",
  hMin: "Nejnižší dovolená požadovaná teplota topné vody vypočtená ekvitermem.",
  hMax: "Nejvyšší dovolená požadovaná teplota topné vody vypočtená ekvitermem.",
  hWrite57: "Povolí zápis maximální teploty topné vody do OpenTherm Data-ID 57, pokud jej kotel podporuje.",
  hBoilerMax: "Hodnota maximální teploty CH odesílaná kotli přes OpenTherm Data-ID 57.",
  hBoilerAssistDeltaC: "Navýšení požadované teploty kotle přes OpenTherm ID 1 oproti ekvitermní teplotě v režimu komfort. Nemění cílovou teplotu směšovacího ventilu a podléhá maximálním limitům kotle.",
  hMixEnabled: "Hlavní povolení nové automatiky směšovacího ventilu. Po prvním povolení bez známé polohy firmware nejprve vytvoří referenci přejezdem do B / 0 %.",
  hMixDisabledAction: "Určuje, co má ventil udělat při vypnuté automatice: zůstat v aktuální poloze, nebo zajet na kraj B / A.",
  hMixNoHeatAction: "Bez dostatečné tepelné rezervy v akumulační nádrži se automatická regulace zastaví a použije tuto bezpečnou polohu.",
  hMixOpeningDirection: "Mapování logického směru A/B na fyzická relé R1/R2. Změna směru zneplatní časový odhad polohy.",
  hMixSourceA: "Zdroj teploty teplé větve A přiváděné z akumulační nádrže.",
  hMixSourceB: "Zdroj teploty chladnější vratné větve B.",
  hMixSourceAB: "Primární regulační teplota za směšovacím ventilem. Podle AB probíhá uzavřená zpětnovazební regulace.",
  hMixSourceTank: "Teplota akumulační nádrže používaná pro povolení nebo blokování automatického směšování.",
  hMixTempMaxAgeMs: "Maximální stáří teplotního vzorku. Starší hodnota je považována za neplatnou.",
  hMixDeadband: "Pásmo ± kolem výsledného cíle, ve kterém ventil standardně stojí. Omezuje kmitání a zbytečné spínání relé.",
  hMixTargetOffsetC: "Korekce přičtená k topnému bodu vypočtenému ekvitermní křivkou před omezením minimem a maximem topné vody.",
  hMixPulseMs: "Délka pouze ručního servisního impulzu. Automatická regulace počítá délku pulzu z procentního kroku a času plného chodu servopohonu.",
  hMixFeedForwardEnabled: "Použije A/B jako orientační hydraulický model pro první přiblížení. Model se automaticky vyřadí, pokud A není dostatečně teplejší než B.",
  hMixLearnResponse: "Průběžně odhaduje, kolik °C změny AB připadá na 1 % pohybu směrem A a B. Naučená odezva se používá k adaptivní velikosti dalších kroků.",
  hMixMinMixSpan: "Minimální kladný rozdíl A-B, při kterém je jednoduchý směšovací model považován za použitelný pro feed-forward.",
  hMixInRangeAction: "V režimu Držet polohu je uvnitř mrtvé zóny ventil zcela bez pohybu. Jemné sledování může minimálními kroky dorovnávat střed pásma.",
  hMixOppositeTrendAction: "Určuje, zda při překročení cíle a pokračujícím trendu špatným směrem čekat na běžné ustálení, nebo po minimální době rychle zahájit opačnou korekci.",
  hMixResponseTimeoutMs: "Nejdelší doba pozorování tepelné odezvy po automatickém kroku. Poté smí regulátor znovu rozhodnout i bez úplného ustálení.",
  hMixSettleTrend: "Absolutní rychlost změny AB, pod kterou je po minimální době odezva považována za ustálenou.",
  otEnable: "Zapne komunikaci OpenTherm s kotlem.",
  otPoll: "Interval dotazování kotle přes OpenTherm. Příliš krátký interval může zvyšovat chybovost komunikace.",
  otFailMode: "Režim control zapisuje požadavky do kotle; readOnly pouze sleduje dostupné hodnoty.",
  otLog: "Povolí pokročilý ruční zápis OpenTherm Data-ID. Nesprávné hodnoty mohou změnit chování kotle.",
  dhw2Target: "Cílová teplota vody v zásobníku TUV, při které se ohřev ukončí podle hystereze.",
  circPulseEnable: "Během aktivního časového plánu střídá chod a pauzu cirkulačního čerpadla.",
  circPulseOn: "Počet minut, po které cirkulační čerpadlo v jednom cyklu běží.",
  circPulseOff: "Počet minut pauzy cirkulačního čerpadla v jednom cyklu.",
  dallasEnable: "Zapne čtení teploměrů DS18B20 na nakonfigurovaných GPIO.",
  bleEnable: "Zapne nebo úplně zastaví BLE meteo klienta. Při vypnutí se neprovádí periodické hledání ani připojování.",
  bleNamePrefix: "Prefix názvu BLE teploměru, podle kterého jej regulátor při hledání rozpozná.",
  bleScanIntervalMs: "Prodleva mezi jednotlivými krátkými hledáními BLE zařízení, pokud teploměr není připojen.",
  hMixTravelToAMs: "Skutečný čas plného pohybu z B do A (0 % → 100 %). Tento čas se používá při kalibraci, cíleném přejezdu a odhadu polohy při pohybu do A.",
  hMixTravelToBMs: "Skutečný čas plného pohybu z A do B (100 % → 0 %). Tento čas se používá při kalibraci, cíleném přejezdu a odhadu polohy při pohybu do B.",
  hMixCalibrationSeatMs: "Čas navíc po dosažení předpokládané krajní polohy, který zajistí mechanické dosednutí ventilu.",
  hMixControlPeriodMs: "Nejkratší běžná perioda mezi regulačními rozhodnutími. Po každém pulzu má přednost čekání na skutečnou tepelnou odezvu.",
  hMixSettleMinMs: "Minimální čas po pohybu, kdy regulátor pouze pozoruje změnu AB a nevydává další automatický puls.",
  hMixResponseTimeoutMs: "Maximální doba čekání na ustálení odezvy AB po regulačním pulzu.",
  hMixSettleTrend: "Absolutní rychlost změny AB, pod kterou lze teplotu po minimálním čekání považovat za ustálenou.",
  hMixTankMinDelta: "Minimální tepelná rezerva AKU nad výslednou cílovou teplotou, která povolí automatické míchání.",
  hMixTankHysteresis: "Hystereze podmínky dostupnosti tepla v AKU, aby se automatika často nepřepínala na hranici.",
  hMixMinStepPct: "Nejmenší automatický krok ventilu vyjádřený jako procento plného času servopohonu.",
  hMixMaxStepPct: "Největší krok při běžné zpětnovazební korekci podle chyby AB.",
  hMixInitialMaxStepPct: "Maximální první přibližovací krok odvozený z feed-forward odhadu A/B.",
  hMixProportionalPctPerC: "Výchozí převod teplotní odchylky na velikost kroku, dokud není k dispozici naučená odezva soustavy.",
  mixTempSourceA: "Teplý přívod A: výchozí je samostatné DS18B20 na společné sběrnici GPIO0; alternativně lze použít AKU uprostřed nebo OpenTherm CH (ID25).",
  mixTempSourceB: "Větev B: výchozí je samostatné DS18B20 na společné sběrnici GPIO0; alternativně lze použít DS18B20 zpátečky na GPIO2 nebo OpenTherm ID28.",
  mixTempSourceAB: "Smíšený výstup AB a regulační zpětná vazba: výchozí je samostatné DS18B20 na společné sběrnici GPIO0. Při neplatném zvoleném zdroji automatika ventil bezpečně zastaví.",
  timeEnable: "Zapne synchronizaci systémového času, který používají plánovače a časové funkce regulace."
};

function tooltipControlLabel(el){
  if(!el) return "";
  const id = el.id || "";
  const explicit = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
  const wrapping = el.closest("label");
  const source = explicit || wrapping;
  if(source){
    return String(source.innerText || source.textContent || "").replace(/\s+/g, " ").trim();
  }
  return String(el.getAttribute("aria-label") || el.placeholder || el.name || id).trim();
}

function genericTooltipText(el){
  const label = tooltipControlLabel(el) || "Tento parametr";
  const tag = el.tagName.toLowerCase();
  const type = String(el.type || "").toLowerCase();
  if(tag === "select") return `${label}: vyberte hodnotu, která určuje použitý režim nebo zdroj. Změna se projeví po uložení příslušné sekce.`;
  if(type === "checkbox") return `${label}: zapíná nebo vypíná tuto volbu. Změna se projeví po uložení příslušné sekce.`;
  if(type === "number" || type === "range") return `${label}: číselná hodnota ovlivňující chování regulace nebo časování. Dodržte uvedené minimum, maximum a jednotku.`;
  if(type === "time") return `${label}: čas použitý plánovačem. Intervaly mohou řídit automatické přepínání dané funkce.`;
  if(type === "file") return `${label}: vyberte soubor určený pro tuto operaci. Před spuštěním ověřte správný typ souboru.`;
  if(tag === "textarea" || type === "text" || type === "password") return `${label}: textová konfigurační hodnota. Změna se projeví po uložení příslušné sekce.`;
  return `${label}: konfigurační ovládací prvek. Změna se projeví po potvrzení nebo uložení.`;
}

function installConfigTooltips(root=document){
  const controls = root.querySelectorAll?.("input, select, textarea") || [];
  controls.forEach(el => {
    if(el.dataset.tooltipReady === "1" || el.type === "hidden") return;
    const text = tooltipHelpById[el.id] || el.dataset.tooltip || el.getAttribute("title") || genericTooltipText(el);
    if(!text) return;
    el.dataset.tooltip = text;
    el.dataset.tooltipReady = "1";
    el.setAttribute("aria-describedby", el.getAttribute("aria-describedby") || "uiConfigTooltip");
  });
}

function initConfigTooltips(){
  let bubble = document.getElementById("uiConfigTooltip");
  if(!bubble){
    bubble = document.createElement("div");
    bubble.id = "uiConfigTooltip";
    bubble.className = "config-tooltip";
    bubble.setAttribute("role", "tooltip");
    bubble.setAttribute("aria-hidden", "true");
    document.body.appendChild(bubble);
  }
  let active = null;
  const hide = () => {
    active = null;
    bubble.classList.remove("show");
    bubble.setAttribute("aria-hidden", "true");
  };
  const show = el => {
    const text = el?.dataset?.tooltip;
    if(!text) return;
    active = el;
    bubble.textContent = text;
    bubble.classList.add("show");
    bubble.setAttribute("aria-hidden", "false");
    const r = el.getBoundingClientRect();
    const margin = 10;
    const maxLeft = Math.max(margin, window.innerWidth - bubble.offsetWidth - margin);
    const left = Math.min(maxLeft, Math.max(margin, r.left + r.width / 2 - bubble.offsetWidth / 2));
    let top = r.top - bubble.offsetHeight - 10;
    if(top < margin) top = Math.min(window.innerHeight - bubble.offsetHeight - margin, r.bottom + 10);
    bubble.style.left = `${left}px`;
    bubble.style.top = `${Math.max(margin, top)}px`;
  };
  const targetFromEvent = e => e.target?.closest?.("[data-tooltip-ready='1']");
  document.addEventListener("pointerover", e => { const el = targetFromEvent(e); if(el) show(el); });
  document.addEventListener("pointerout", e => { const el = targetFromEvent(e); if(el && !el.contains(e.relatedTarget)) hide(); });
  document.addEventListener("focusin", e => { const el = targetFromEvent(e); if(el) show(el); });
  document.addEventListener("focusout", e => { if(targetFromEvent(e)) hide(); });
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", () => { if(active) show(active); });
  installConfigTooltips(document);
  new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
    if(node.nodeType !== 1) return;
    if(node.matches?.("input, select, textarea")) installConfigTooltips(node.parentElement || document);
    else installConfigTooltips(node);
  }))).observe(document.body, { childList:true, subtree:true });
}

// ----- Boot
    // ----- Boot

/* THERMA 4.0 application shell: frontend-only enhancement.
 * Device endpoints, WebSocket messages and all existing form handlers are reused.
 */
const THERMA_VIEWS = [
  {id:"overview",name:"Přehled",icon:"◫",desc:"Živé hodnoty a stav systému"},
  {id:"heating",name:"Topení",icon:"♨",desc:"Ekvitermní regulace a plán"},
  {id:"dhw",name:"TUV",icon:"◉",desc:"Ohřev a cirkulace"},
  {id:"accu",name:"Akumulační nádrž",icon:"▥",desc:"Teploty a energie"},
  {id:"mixing",name:"Směšovací ventil",icon:"◇",desc:"Ventil a kalibrace"},
  {id:"opentherm",name:"OpenTherm",icon:"⌁",desc:"Kotel a diagnostika OT"},
  {id:"thermometers",name:"Teploměry",icon:"◌",desc:"DS18B20 a BLE"},
  {id:"io",name:"Vstupy a výstupy",icon:"▦",desc:"Digitální vstupy a relé"},
  {id:"diag",name:"Diagnostika",icon:"⚙",desc:"Systém, MQTT, konfigurace"}
];
const thermaShell = {searchOpen:false,moreOpen:false};
function thermaSetConnection(kind,text){
  const container=document.getElementById("liveConnection");
  const label=document.getElementById("liveConnectionText");
  if(!container||!label) return;
  const type=kind==="good"?"online":(kind==="bad"?"offline":"connecting");
  if(container.dataset.state!==type) container.dataset.state=type;
  const next=type==="online"?"Připojeno":(type==="offline"?"Odpojeno":"Připojuji…");
  if(label.textContent!==next)label.textContent=next;
  container.title=String(text||next);
}
function thermaCloseMenus(){
  const side=document.getElementById("uiSidebar");
  const sideToggle=document.getElementById("btnSidebarToggle");
  side?.classList.remove("mobile-open");
  sideToggle?.setAttribute("aria-expanded","false");
  const more=document.getElementById("mobileMorePanel");
  if(more)more.hidden=true;
  document.getElementById("btnMobileMore")?.setAttribute("aria-expanded","false");
  thermaShell.moreOpen=false;
}
function thermaSearchOptions(query){
  const norm=String(query||"").trim().toLocaleLowerCase("cs-CZ");
  return THERMA_VIEWS.filter(x=>(x.name+" "+x.desc).toLocaleLowerCase("cs-CZ").includes(norm));
}
function thermaRenderSearch(query=""){
  const host=document.getElementById("quickSearchResults");
  if(!host)return;
  const items=thermaSearchOptions(query);
  host.replaceChildren();
  if(!items.length){
    const empty=document.createElement("div");
    empty.className="muted";
    empty.style.padding="20px";
    empty.textContent="Žádná odpovídající stránka.";
    host.appendChild(empty);return;
  }
  for(const [i,item] of items.entries()){
    const btn=document.createElement("button");
    btn.type="button";btn.dataset.targetView=item.id;
    if(i===0)btn.dataset.selected="1";
    const icon=document.createElement("span");icon.className="search-icon";icon.textContent=item.icon;
    const label=document.createElement("span");label.textContent=item.name;
    const desc=document.createElement("span");desc.className="search-desc";desc.textContent=item.desc;
    btn.append(icon,label,desc);
    btn.addEventListener("click",()=>{thermaCloseSearch();setView(item.id);});
    host.appendChild(btn);
  }
}
function thermaOpenSearch(){
  const overlay=document.getElementById("quickSearchOverlay");
  if(!overlay)return;
  thermaCloseMenus();
  overlay.hidden=false;thermaShell.searchOpen=true;
  const input=document.getElementById("quickSearchInput");
  if(input){input.value="";thermaRenderSearch();input.focus();}
}
function thermaCloseSearch(){
  const overlay=document.getElementById("quickSearchOverlay");
  if(overlay)overlay.hidden=true;
  thermaShell.searchOpen=false;
}
function thermaInitShell(){
  document.getElementById("btnSidebarToggle")?.addEventListener("click",()=>{
    const side=document.getElementById("uiSidebar");
    const opening=!side?.classList.contains("mobile-open");
    thermaCloseMenus();
    if(opening)side?.classList.add("mobile-open");
    document.getElementById("btnSidebarToggle")?.setAttribute("aria-expanded",String(opening));
  });
  document.getElementById("btnMobileMore")?.addEventListener("click",()=>{
    const panel=document.getElementById("mobileMorePanel");
    const opening=!!panel?.hidden;
    thermaCloseMenus();
    if(panel)panel.hidden=!opening;
    thermaShell.moreOpen=opening;
    document.getElementById("btnMobileMore")?.setAttribute("aria-expanded",String(opening));
  });
  document.getElementById("btnMobileMoreClose")?.addEventListener("click",thermaCloseMenus);
  document.querySelectorAll("[data-more-view]").forEach(btn=>btn.addEventListener("click",()=>{
    const id=btn.dataset.moreView;
    if(titles[id])setView(id);
  }));
  document.getElementById("btnCommandSearch")?.addEventListener("click",thermaOpenSearch);
  document.getElementById("quickSearchInput")?.addEventListener("input",e=>thermaRenderSearch(e.target.value));
  document.getElementById("quickSearchOverlay")?.addEventListener("click",e=>{
    if(e.target===e.currentTarget)thermaCloseSearch();
  });
  window.addEventListener("keydown",e=>{
    if(e.key==="Escape"){thermaCloseSearch();thermaCloseMenus();return;}
    if(thermaShell.searchOpen){
      if(e.key==="Enter"){
        e.preventDefault();
        document.querySelector("#quickSearchResults button[data-target-view]")?.click();
      }
      return;
    }
    if((e.key==="/"||((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k")) &&
       !isEditableTarget(e.target)){
      e.preventDefault();thermaOpenSearch();
    }
  },true);
  document.addEventListener("pointerdown",e=>{
    const sidebar=document.getElementById("uiSidebar");
    const toggle=document.getElementById("btnSidebarToggle");
    if(sidebar?.classList.contains("mobile-open")&&!sidebar.contains(e.target)&&!toggle?.contains(e.target)){
      thermaCloseMenus();
    }
  },{passive:true});
  window.addEventListener("resize",debounce(()=>{
    if(window.innerWidth>1100)thermaCloseMenus();
  },150),{passive:true});
  thermaSetConnection("warn","Načítám stav zařízení");
}

function boot(){
  applyTheme();

  maybeAdoptPageOriginBase("boot", true);
  syncApiBaseUi();

  setSource("device");

  setText("#dName", "ESP32");
  setText("#dIp", "--");
  setText("#dBuild", "UI 2026");
  if(!Number.isFinite(Number(state.ot.maxCapacityKw))) state.ot.maxCapacityKw = 9;

  try{ window.ThermaV5?.init(); }catch(e){ console.error("THERMA 5 init:",e); }
  wire();
  thermaInitShell();
  installPendingSaveTracking();
  initConfigTooltips();
  renderHeatingOtInfo();
  renderMixCalibrationInfo();
  renderDhwBoilerMode();
  renderMixConfigSourceSelectors();
  syncMixUiVisibility();

  window.addEventListener("hashchange", () => {
    const hv2 = (location.hash || "#overview").replace("#", "");
    if(titles[hv2] && getActiveView() !== hv2) setView(hv2);
  });
  document.addEventListener("visibilitychange", handleVisibilityChange);

  document.getElementById("thRefresh")?.addEventListener("click", () => withButtonBusy(document.getElementById("thRefresh"), "Načítám…", () => thermoLoad({ silent:false })));
  document.getElementById("thSave")?.addEventListener("click", () => withButtonBusy(document.getElementById("thSave"), "Ukládám…", () => thermoSave()));
  document.getElementById("dallasEnable")?.addEventListener("change", (e) => { state.th.dallasEnabled = !!e.target.checked; });

  renderThermometersDevice();
  $("#serviceCountersReset")?.addEventListener("click", resetServiceCounters);

  const hv = (location.hash || "#overview").replace("#","");
  if(titles[hv]) setView(hv);

  stopFallbackPolling();
  updateRefreshCadence();

  const bootLoad = async () => {
    let bootstrapped = false;
    connectWs();
    const bootstrapPromise = api.fetchBootstrap()
      .then((payload) => applyBootstrapPayload(payload))
      .catch(() => false);
    const wsReady = await waitForFirstFastSnapshot(350);
    if(!wsReady){
      try{
        bootstrapped = await bootstrapPromise;
      }catch(_e){}
    }
    if(!bootstrapped && !state.last){
      try{
        await refresh(false);
      }catch(_e){}
    }
    log(bootstrapped ? "boot ok (bootstrap)" : (state.last ? (wsReady ? "boot ok (ws-first)" : "boot ok (ws)") : "boot ok"));
  };
  void bootLoad();
}
boot();
