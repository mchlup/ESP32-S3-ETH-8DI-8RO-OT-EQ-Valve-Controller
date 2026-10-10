(function thermaV5() {
  "use strict";

  /*
   * THERMA 5.0 - actual page-level UI reconstruction.
   * The existing input/button IDs, handlers, data model, commands and API
   * are kept intact. Their original DOM nodes are MOVED, never cloned.
   */
  const doc = document;
  const byId = id => doc.getElementById(id);
  const make = (tag, klass, markup) => {
    const n = doc.createElement(tag);
    if (klass) n.className = klass;
    if (markup !== undefined) n.innerHTML = markup;
    return n;
  };
  const put = (parent, ...nodes) => nodes.forEach(n => { if (n) parent.appendChild(n); });
  const cls = (root, selector) => root?.querySelector(selector) || null;
  const svgIcon = (name) => ({
    heating:"♨", hot:"↗", cool:"↙", water:"◉", mix:"◇", tank:"▥",
    live:"●", io:"▦", ot:"⌁", info:"◈", chart:"⌁", flag:"◌"
  }[name] || "◌");

  function heading(kicker,title,subtitle,append) {
    const h = make("header", "v5-section-header");
    const copy = make("div","v5-header-copy",
      '<span class="v5-overline">'+kicker+'</span><h2>'+title+'</h2><p>'+subtitle+'</p>');
    put(h,copy,append); return h;
  }
  function card(title, subtitle, extraClass) {
    const root = make("article","v5-card "+(extraClass||""));
    put(root,make("div","v5-card-head",
      '<div class="v5-card-heading"><h3>'+title+'</h3>'+(subtitle?'<p>'+subtitle+'</p>':'')+'</div>'));
    return root;
  }
  function cardBody(root) {
    const b=make("div","v5-card-body");root.appendChild(b);return b;
  }
  function note(title,text,klass) {
    return make("div","v5-notice "+(klass||""),
      '<span class="v5-notice-mark" aria-hidden="true">✦</span><div><strong>'+title+'</strong><p>'+text+'</p></div>');
  }
  function tabs(view, options, target) {
    const shell=make("div","v5-tab-shell");
    const nav=make("div","v5-tabs");nav.setAttribute("role","tablist");nav.setAttribute("aria-label","Zobrazení stránky");
    const bodies=make("div","v5-tab-bodies");
    const result={};
    const list=[];
    for(const [i,opt] of options.entries()){
      const id="v5-"+view+"-"+opt[0];
      const b=make("button","v5-tab"+(i===0?" is-active":""),opt[1]);
      b.type="button";b.setAttribute("role","tab");
      b.id=id+"-tab";b.setAttribute("aria-controls",id);b.setAttribute("aria-selected",String(i===0));
      const pane=make("div","v5-tab-panel");
      pane.id=id;pane.setAttribute("role","tabpanel");pane.setAttribute("aria-labelledby",b.id);
      pane.hidden=i!==0;pane.dataset.v5Pane=opt[0];
      nav.appendChild(b);bodies.appendChild(pane);result[opt[0]]=pane;list.push([b,pane]);
      b.addEventListener("click",()=>{
        for(const [btn,p] of list){const active=btn===b;p.hidden=!active;btn.classList.toggle("is-active",active);btn.setAttribute("aria-selected",String(active));}
        if(view==="heating" || view==="mixing" || view==="accu") {
          setTimeout(()=>window.redrawEquithermViews?.(),0);
          setTimeout(()=>window.renderMixCalibrationInfo?.(),0);
        }
        if(view==="overview") setTimeout(()=>window.redrawEquithermViews?.(),0);
        drawTrend();
      });
    }
    put(shell,nav,bodies);put(target,shell);return result;
  }
  function reveal(title, subtitle, ...elements){
    const box=make("details","v5-advanced");
    const s=make("summary","v5-advanced-title",
      '<strong>'+title+'</strong><span>'+subtitle+'</span><b aria-hidden="true">⌄</b>');
    const content=make("div","v5-advanced-body");
    put(content,...elements);put(box,s,content);
    box.addEventListener("toggle",()=>{if(box.open)setTimeout(()=>window.redrawEquithermViews?.(),25)});
    return box;
  }
  function metricsMarkup(prefix) {
    return '<div class="v5-metric-grid">'+
      '<div class="v5-metric"><span>Venkovní teplota</span><strong id="'+prefix+'-outside">—</strong><small>Aktuální venkovní zdroj</small></div>'+
      '<div class="v5-metric"><span>Voda z kotle</span><strong id="'+prefix+'-boiler">—</strong><small>Měřená teplota CH</small></div>'+
      '<div class="v5-metric"><span>Požadavek kotli</span><strong id="'+prefix+'-target">—</strong><small>OpenTherm · ID 1</small></div>'+
      '<div class="v5-metric"><span>Výstup směšovače</span><strong id="'+prefix+'-mixed">—</strong><small>Port AB</small></div>'+
      '<div class="v5-metric"><span>AKU · nahoře</span><strong id="'+prefix+'-tank">—</strong><small>Teplotní rezerva nádrže</small></div>'+
      '<div class="v5-metric"><span>TUV</span><strong id="'+prefix+'-dhw">—</strong><small>Teplota zásobníku</small></div>'+
    '</div>';
  }
  function flowMarkup() {
    return '<div class="v5-flow-map" aria-label="Živý tok tepla od kotle a akumulační nádrže do směšovacího ventilu a topného okruhu">'+
      '<div class="v5-flow-main">'+
        '<div class="v5-flow-unit" data-v5-node="boiler"><div class="v5-flow-symbol v5-fire">♨</div><span>KOTEL</span><strong id="v5-map-boiler">—</strong><small id="v5-map-flame">Stav: neznámý</small></div>'+
        '<div class="v5-flow-connector" data-v5-link="boiler"><span>TOPNÁ VODA</span><i></i></div>'+
        '<div class="v5-flow-unit v5-flow-mixer" data-v5-node="mix"><div class="v5-flow-symbol">◇</div><span>SMĚŠOVACÍ VENTIL</span><strong id="v5-map-mix">—</strong><small id="v5-map-position">Poloha: —</small></div>'+
        '<div class="v5-flow-connector" data-v5-link="heat"><span>VÝSTUP AB</span><i></i></div>'+
        '<div class="v5-flow-unit" data-v5-node="circuit"><div class="v5-flow-symbol">≋</div><span>TOPNÝ OKRUH</span><strong id="v5-map-circuit">—</strong><small id="v5-map-mode">Režim: —</small></div>'+
      '</div>'+
      '<div class="v5-flow-secondary">'+
        '<div class="v5-flow-mini" data-v5-node="tank"><span class="v5-secondary-icon">▥</span><div><span>AKUMULAČNÍ NÁDRŽ</span><strong id="v5-map-tank">—</strong></div><small>Teplo pro směšování ↗</small></div>'+
        '<div class="v5-flow-mini" data-v5-node="dhw"><span class="v5-secondary-icon">◉</span><div><span>TEPLÁ UŽITKOVÁ VODA</span><strong id="v5-map-dhw">—</strong></div><small id="v5-map-dhw-state">Ohřev: —</small></div>'+
      '</div>'+
     '</div>';
  }
  function trendMarkup() {
    return '<div class="v5-trend-head"><div><h3>Průběh topné vody</h3><p>Skutečná teplota kotle versus požadavek OpenTherm · posledních 120 vzorků</p></div>'+
      '<div class="v5-trend-legend"><span><i class="v5-legend-actual"></i>Výstup kotle</span><span><i class="v5-legend-target"></i>Požadavek OT</span></div></div>'+
      '<div class="v5-trend-shell"><canvas id="v5-trend" height="210" aria-label="Graf historie kotle a požadované teploty"></canvas>'+
      '<div class="v5-trend-placeholder" id="v5-trend-placeholder">Čekám na první naměřené hodnoty…</div></div>';
  }
  function overview() {
    const section=byId("view-overview");if(!section)return;
    const originals=Array.from(section.children);
    const original=cls(section,":scope > .card");
    section.replaceChildren();
    const top=make("div","v5-page-title-row v5-overview-head");
    put(top,heading("PŘEHLED / AKTUÁLNÍ STAV","Přehled vytápění",
      "Aktuální údaje z kotle, směšovacího ventilu a cirkulace."));
    top.appendChild(make("div","v5-primary-actions",
      '<button class="btn" type="button" data-open-view="heating">Nastavení topení ↗</button>'+
      '<button class="btn" type="button" data-open-view="mixing">Směšovací ventil ↗</button>'));
    section.appendChild(top);

    const status=make("div","v5-overview-status",
      '<div><span>Režim topení</span><strong id="v5-overview-mode">—</strong></div>'+
      '<div><span>Vstup IN1</span><strong id="v5-overview-in1">—</strong></div>'+
      '<div><span>OpenTherm</span><strong id="v5-overview-ot">—</strong></div>'+
      '<div><span>Cirkulace</span><strong id="v5-overview-circ">—</strong></div>');
    section.appendChild(status);

    const metrics=make("section","v5-metrics-wrap v5-overview-metrics",metricsMarkup("v5-ov"));
    section.appendChild(metrics);

    const row=make("div","v5-overview-primary");
    const mixing=card("Směšovací ventil","Teplota a skutečný stav portů A, B a AB","v5-overview-mixer");
    cardBody(mixing).innerHTML=
      '<div class="v5-mixer-visual" aria-label="A přívod + B vratná větev = smíchaná voda AB">'+
       '<div class="v5-mixer-inlets">'+
        '<div class="v5-port hot"><span>A · teplý přívod</span><strong id="v5-ov-mix-a">—</strong></div>'+
        '<div class="v5-port cold"><span>B · vratná větev</span><strong id="v5-ov-mix-b">—</strong></div>'+
       '</div>'+
       '<div class="v5-mixer-join"><span>↘</span><strong>◇</strong><span>↙</span></div>'+
       '<div class="v5-mixer-out"><div><span>AB · výstup do topení</span><strong id="v5-ov-mix-ab">—</strong></div><div><span>Cíl regulace</span><strong id="v5-ov-mix-goal">—</strong></div></div>'+
      '</div>'+
      '<div class="v5-position-info"><span>Odhad polohy ventilu</span><strong id="v5-ov-mix-pos">—</strong></div>'+
      '<div class="v5-position-bar" role="meter" aria-label="Odhad otevření ventilu" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="v5-ov-mix-meter"><i id="v5-ov-mix-fill"></i></div>'+
      '<div class="v5-position-captions"><span>B · 0 %</span><span>A · 100 %</span></div>'+
      '<div class="v5-mixer-foot"><span id="v5-ov-mix-dir">Směr: —</span><button class="btn" type="button" data-open-view="mixing">Otevřít regulaci ↗</button></div>';

    const circulation=card("Cirkulační čerpadlo TUV","Stav čerpadla podle relé a požadavků regulace","v5-overview-circ");
    cardBody(circulation).innerHTML=
      '<div class="v5-circ-current" data-running="unknown" id="v5-circ-widget">'+
       '<div class="v5-circ-pump-icon" aria-hidden="true"><span>⟳</span></div>'+
       '<div class="v5-circ-copy"><span>AKTUÁLNÍ STAV</span><strong id="v5-circ-state">Čekám na zařízení</strong><small id="v5-circ-relay">Relé cirkulace: —</small></div>'+
      '</div>'+
      '<div class="v5-circ-facts">'+
        '<div><span>Požadavek cirkulace</span><strong id="v5-circ-request">—</strong></div>'+
        '<div><span>Zdroj požadavku</span><strong id="v5-circ-source">—</strong></div>'+
        '<div><span>Pulzní fáze</span><strong id="v5-circ-pulse">—</strong></div>'+
        '<div><span>Teplota TUV</span><strong id="v5-circ-temp">—</strong></div>'+
      '</div>'+
      '<div class="v5-circ-buttons"><button class="btn" type="button" data-open-view="dhw" data-v5-open-tab="circCfg">Nastavení cirkulace ↗</button>'+
       '<button class="btn" type="button" data-open-view="dhw" data-v5-open-tab="circPlan">Plán cirkulace ↗</button></div>';
    put(row,mixing,circulation);section.appendChild(row);
    const trend=card("Trend teploty kotle","Naměřená teplota vůči požadavku OpenTherm.","v5-overview-trend");
    cardBody(trend).innerHTML=trendMarkup();
    section.appendChild(reveal("Graf vývoje topné vody","Naměřená teplota a požadavek kotli, historie posledních 120 vzorků",trend));
    if(original)section.appendChild(reveal("Rozšířený technický přehled",
      "Detailní grafy, hodnoty čidel, AKU, TUV a všechny původní provozní údaje",original));
    for(const n of originals)if(n!==original&&!n.classList.contains("page-hero"))section.appendChild(n);
  }

  function heating() {
    const section=byId("view-heating");if(!section)return;
    const originals=Array.from(section.children);
    const main=originals.find(x=>x.classList?.contains("card"));
    const planner=originals.filter(x=>x.classList?.contains("card"))[1];
    if(!main)return;
    const header=cls(main,":scope > .card-head");
    const body=cls(main,":scope > .card-body");
    const curves=cls(main,".heat-curves");
    const mode=byId("hEqModeCfg")?.closest(".heat-group");
    const boiler=byId("hBoilerAssistDeltaC")?.closest(".heat-group");
    const relays=byId("hNightRelay")?.closest(".heat-group");
    const chart=cls(main,".chartbox");
    section.replaceChildren();
    put(section,heading("VYTÁPĚNÍ / EKVITERM","Topení",
      "Provozní režim, křivky s okamžitým náhledem, OpenTherm a časový program."));
    const p=tabs("heating",[
      ["live","◉ Provoz"],["curve","⌁ Ekvitermní křivky"],
      ["boiler","♨ Kotel a relé"],["plan","◷ Týdenní plán"],["extra","⋯ Další"]
    ],section);

    const live=make("div","v5-live-stack");
    live.innerHTML='<div class="v5-feature-hero v5-heat-feature"><div><span>POŽADAVEK KOTLI PŘES OT</span><strong id="v5-h-target">—</strong><small id="v5-h-mode">Režim: —</small></div>'+
      '<div class="v5-feature-side"><span>Skutečná voda</span><strong id="v5-h-actual">—</strong><span>Výstup AB</span><strong id="v5-h-ab">—</strong></div></div>';
    const mini=make("div","v5-inline-flow");
    mini.innerHTML='<span>Kotel <strong id="v5-heat-boiler">—</strong></span><b>→</b>'+
      '<span>Směšovač <strong id="v5-heat-valve">—</strong></span><b>→</b>'+
      '<span>Okruh <strong id="v5-heat-room">—</strong></span>';
    put(live,mini);put(p.live,live);
    // Place the former "Konfigurace topení" action bar and mode switches
    // on the Provoz workspace, not above every tab.
    if(header){header.classList.add("v5-action-head");put(p.live,header);}
    if(mode)put(p.live,mode);

    const curveLayout=make("div","v5-heating-curve-workspace");
    if(curves)curveLayout.appendChild(curves);
    if(chart){
      const right=make("div","v5-curve-live-preview");
      put(right,make("header","v5-curve-preview-head",
        '<strong>Náhled ekvitermních křivek</strong><span id="v5-curve-preview-state">Graf z aktuálního nastavení</span>'),chart);
      curveLayout.appendChild(right);
    }
    put(p.curve,curveLayout);
    put(p.curve,note("Graf reaguje ihned",
      "Změna sklonu, posunu nebo minimální/maximální teploty se okamžitě projeví v křivkách. Do kotle se nastavení odešle až po uložení."));
    if(boiler||relays){const row=make("div","v5-two-panels");put(row,boiler,relays);put(p.boiler,row);}
    put(p.boiler,note("Vstup IN1",
      "Aktivní IN1 znamená útlum. V komfortním režimu se používá nastavený offset požadavku kotli (OpenTherm ID 1)."));
    if(planner)put(p.plan,planner);
    if(body)put(p.extra,body);
    for(const n of originals)if(n!==main&&n!==planner)section.appendChild(n);
  }

  function mixing() {
    const section=byId("view-mixing");if(!section)return;
    const original=Array.from(section.children);
    const head=cls(section,".mix-page-head");
    const stat=cls(section,".mix-status-panel:not(.mix-status-panel-overview)");
    const schema=cls(section,".mix-schematic-panel");
    const config=cls(section,".mix-configuration-panel");
    const calibrate=cls(section,".mix-calibration-panel");
    section.replaceChildren();
    put(section,heading("SMĚŠOVÁNÍ / 3CESTNÝ VENTIL","Směšovací okruh","A – teplý přívod · B – vratná větev · AB – výsledná teplota."));
    if(head){head.classList.add("v5-action-head");section.appendChild(head);}
    const p=tabs("mixing",[
      ["live","◉ Provoz"],["cfg","⚙ Regulace"],["cal","◇ Kalibrace"]
    ],section);
    const grid=make("div","v5-mixing-stage");
    const hero=make("div","v5-feature-hero v5-mixing-hero",
      '<div><span>TEPLOTA VÝSTUPU AB</span><strong id="v5-mix-ab">—</strong><small id="v5-mix-error">Odchylka od cíle: —</small></div>'+
      '<div class="v5-feature-side"><span>Cílová teplota</span><strong id="v5-mix-goal">—</strong><span>Odhad polohy</span><strong id="v5-mix-pct">—</strong></div>');
    put(p.live,hero);
    put(grid,stat,schema);put(p.live,grid);
    if(config)put(p.cfg,config);
    if(calibrate)put(p.cal,calibrate);
    for(const n of original)if(n!==head && n!==stat && n!==schema && n!==config && n!==calibrate && !n.classList?.contains("mix-dashboard-grid"))put(p.cfg,n);
  }

  function dhw() {
    const section=byId("view-dhw");if(!section)return;
    const original=Array.from(section.children);
    const main=original.find(x=>x.classList?.contains("card"));
    const planner=original.filter(x=>x.classList?.contains("card"))[1];
    if(!main)return;
    const head=cls(main,":scope > .card-head");
    const body=cls(main,":scope > .card-body");
    const first=byId("dhw2Target")?.closest(".row");
    section.replaceChildren();
    put(section,heading("TEPLÁ UŽITKOVÁ VODA / TUV","Ohřev a cirkulace","Stav zásobníku, okamžité příkazy, teploty a týdenní plán."));
    if(head){head.classList.add("v5-action-head");section.appendChild(head);}
    const p=tabs("dhw",[
      ["live","◉ Provoz"],["cfg","⚙ Nastavení"],["plan","◷ Plánovače"]
    ],section);
    const hero=make("div","v5-dhw-dashboard",
      '<div class="v5-dhw-vessel"><span class="v5-dhw-vessel-cap"></span><span class="v5-dhw-water" id="v5-dhw-water"></span><span class="v5-dhw-vessel-copy"><small>ZÁSOBNÍK TUV</small><strong id="v5-dhw-temp">—</strong></span></div>'+
      '<div class="v5-dhw-stats"><div><span>Cílová teplota</span><strong id="v5-dhw-goal">—</strong></div><div><span>Probíhá ohřev</span><strong id="v5-dhw-active">—</strong></div><div><span>Cirkulační čerpadlo</span><strong id="v5-dhw-pump">—</strong></div><p>Průběžné hodnoty z regulátoru. Ruční ovládání je propojené s existujícími příkazy backendu.</p></div>');
    put(p.live,hero,first);
    if(body)put(p.cfg,body);
    if(planner)put(p.plan,planner);
    for(const n of original)if(n!==main&&n!==planner)put(p.cfg,n);
  }

  function accu() {
    const section=byId("view-accu");if(!section)return;
    const old=Array.from(section.children);
    section.replaceChildren();
    put(section,heading("AKUMULACE / ZDROJ TEPLA","Akumulační nádrž","Teplotní vrstvy zásobníku a disponibilní teplo pro topný okruh."));
    const widget=card("Teplotní profil nádrže","Zobrazení vychází z teplotních čidel připojených k zařízení.","v5-tank-primary");
    const content=cardBody(widget);
    content.innerHTML='<div class="v5-tank-layout"><div class="v5-tank-cylinder" aria-label="Teplotní profil akumulační nádrže">'+
      '<div class="v5-tank-segment top" id="v5-tank-top"><span>HORNÍ ZÓNA</span><strong id="v5-tank-t">—</strong></div>'+
      '<div class="v5-tank-segment middle" id="v5-tank-mid"><span>STŘEDNÍ ZÓNA</span><strong id="v5-tank-m">—</strong></div>'+
      '<div class="v5-tank-segment bottom" id="v5-tank-bottom"><span>SPODNÍ ZÓNA</span><strong id="v5-tank-b">—</strong></div></div>'+
      '<div class="v5-tank-stat"><span>ROZDÍL HORNÍ / SPODNÍ TEPLOTY</span><strong id="v5-tank-delta">—</strong><small id="v5-tank-detail">Čekám na údaje čidel.</small>'+
      '<button type="button" class="btn" data-open-view="mixing">Směšovací ventil ↗</button></div></div>';
    section.appendChild(widget);
    if(old.length)put(section,reveal("Technologické zobrazení a původní měřidla","Grafické zobrazení nádrže, ventilu a dalších provozních informací",...old));
  }

  function opentherm() {
    const section=byId("view-opentherm");if(!section)return;
    const old=Array.from(section.children);
    const main=old.find(x=>x.classList?.contains("card"));
    if(!main)return;
    const head=cls(main,":scope > .card-head");
    const body=cls(main,":scope > .card-body");
    const table=cls(body,":scope > .table");
    const ds=Array.from(body?.children||[]).filter(n=>n.tagName==="DETAILS");
    const alert=ds.find(n=>n.querySelector("#pressAlarmEnable"));
    const config=ds.find(n=>n.querySelector("#otEnable"));
    section.replaceChildren();
    put(section,heading("KOTEL / OPEN THERM","OpenTherm","Teploty, modulace výkonu, stabilita komunikace a výměna Data-ID."));
    if(head){head.classList.add("v5-action-head");section.appendChild(head);}
    const p=tabs("opentherm",[
      ["live","◉ Provoz"],["cfg","⚙ Konfigurace"],["diag","⌁ Data-ID a diagnostika"]
    ],section);
    put(p.live,make("div","v5-ot-overview",
      '<div class="v5-ot-feature"><span>KOTEL · SKUTEČNÁ TEPLOTA</span><strong id="v5-ot-now">—</strong><small id="v5-ot-state">Čekám na kotel…</small></div>'+
      '<div class="v5-ot-feature"><span>POŽADOVANÁ TEPLOTA</span><strong id="v5-ot-req">—</strong><small>OpenTherm · Data-ID 1</small></div>'+
      '<div class="v5-ot-feature"><span>AKTUÁLNÍ MODULACE</span><strong id="v5-ot-mod">—</strong><div class="v5-progress"><i id="v5-ot-progress"></i></div></div>'));
    if(table){const wrap=card("Telemetrie kotle","Přímé měřené hodnoty z Data-ID","v5-ot-reading");put(cardBody(wrap),table);put(p.live,wrap);}
    if(alert)put(p.cfg,alert);
    if(config)put(p.cfg,config);
    for(const d of ds)if(d!==alert&&d!==config)put(p.diag,d);
    if(body)put(p.diag,reveal("Podrobnosti rozhraní","Další servisní údaje a nápověda",body));
    for(const n of old)if(n!==main)put(p.diag,n);
  }

  function thermometers() {
    const section=byId("view-thermometers");if(!section)return;
    const old=Array.from(section.children);
    const main=old.find(x=>x.classList?.contains("card"));
    if(!main)return;
    const head=cls(main,":scope > .card-head");
    const body=cls(main,":scope > .card-body");
    const details=Array.from(body?.children||[]).filter(e=>e.tagName==="DETAILS");
    section.replaceChildren();
    put(section,heading("MĚŘENÍ / SENZORY","Teploměry a čidla","Přiřazení DS18B20, diagnostika připojení a BLE meteorologie."));
    if(head){head.classList.add("v5-action-head");section.appendChild(head);}
    const p=tabs("thermometers",[["sensors","◉ DS18B20"],["ports","◇ Směšovací porty"],["ble","◌ BLE a další"]],section);
    for(const d of details){
      if(d.querySelector("#thMapTbl")||d.querySelector("#thDsTbl"))put(p.sensors,d);
      else if(d.querySelector("#mixTempSourceA"))put(p.ports,d);
      else put(p.ble,d);
    }
    if(body)put(p.ble,body);
    for(const n of old)if(n!==main)put(p.ble,n);
  }

  function io() {
    const section=byId("view-io");if(!section)return;
    const old=Array.from(section.children);
    section.replaceChildren();
    put(section,heading("VSTUPY A VÝSTUPY / GPIO","I/O panel","Okamžité zobrazení aktivních vstupů a stavů relé."));
    const board=card("Digitální vstupy","Vstup IN1 přepíná komfort / útlum, IN2 a IN3 řídí příslušné požadavky.","v5-io-panel");
    cardBody(board).innerHTML='<div class="v5-digital-grid">'+
      '<div class="v5-digital"><span>IN1 <small>Vytápění</small></span><strong id="v5-in1">—</strong></div>'+
      '<div class="v5-digital"><span>IN2 <small>TUV</small></span><strong id="v5-in2">—</strong></div>'+
      '<div class="v5-digital"><span>IN3 <small>Cirkulace</small></span><strong id="v5-in3">—</strong></div>'+
      '</div>';
    section.appendChild(board);
    const rel=card("Výstupní relé R1–R8","Stav je pouze informativní; ruční zásahy provádějte níže přes stávající servisní ovládání.","v5-io-panel");
    const wrap=cardBody(rel);const chips=make("div","v5-relay-grid");
    for(let n=1;n<=8;n++){
      chips.innerHTML+='<div class="v5-relay"><span>R'+n+'</span><strong id="v5-r'+n+'">—</strong></div>';
    }
    wrap.appendChild(chips);section.appendChild(rel);
    if(old.length)put(section,reveal("Tabulky a ovládání relé","Úplné ovládání vstupů, servisních příkazů a bezpečné zastavení",...old));
  }

  function diagnostics() {
    const section=byId("view-diag");if(!section)return;
    const old=Array.from(section.children);
    const main=old.find(x=>x.classList?.contains("card"));
    if(!main)return;
    const head=cls(main,":scope > .card-head");
    const body=cls(main,":scope > .card-body");
    const details=Array.from(body?.children||[]).filter(x=>x.tagName==="DETAILS");
    section.replaceChildren();
    put(section,heading("SPRÁVA / SERVIS","Diagnostika a systém","Přehled stavu připojení, MQTT, nastavení času, aktualizace a logy."));
    if(head){head.classList.add("v5-action-head");section.appendChild(head);}
    const health=make("div","v5-diagnostics-overview",
      '<div><span>HEAP · VOLNÁ PAMĚŤ</span><strong id="v5-heap-free">—</strong></div>'+
      '<div><span>VOLNÁ PSRAM</span><strong id="v5-psram-free">—</strong></div>'+
      '<div><span>PROVOZ ZAŘÍZENÍ</span><strong id="v5-uptime">—</strong></div>');
    section.appendChild(health);
    const p=tabs("diag",[
      ["system","⚙ Systém"],["network","◌ MQTT a síť"],["logs","≡ Logy"],["service","▦ Servis"]
    ],section);
    for(const d of details){
      const text=(d.querySelector("summary")?.textContent||"").toLowerCase();
      if(d.querySelector("#mqttHost")||text.includes("mqtt"))put(p.network,d);
      else if(d.querySelector("#timeEnable")||text.includes("ntp")||text.includes("síť"))put(p.network,d);
      else if(d.querySelector("#eventsOut")||d.querySelector("#historyOut")||d.querySelector("#log"))put(p.logs,d);
      else if(d.querySelector("#serviceRelay")||text.includes("servis"))put(p.service,d);
      else put(p.system,d);
    }
    if(body)put(p.system,body);
    for(const n of old)if(n!==main)put(p.system,n);
  }

  let initialized=false;
  const buffer={time:[],actual:[],target:[],max:120,lastSample:0,paintQueued:false};
  function finite(...v) {
    for(const x of v) { if(x===null||x===undefined||x==="")continue;
      const y=Number(x);if(Number.isFinite(y))return y; }
    return NaN;
  }
  const temp = (n,digits=1) => Number.isFinite(n)?n.toFixed(digits)+" °C":"—";
  const pct = n => Number.isFinite(n)?Math.round(n)+" %":"—";
  function text(id,value) {
    const e=byId(id);if(e){const s=String(value);if(e.textContent!==s)e.textContent=s;}
  }
  function flag(selector,active) {
    const n=doc.querySelector(selector);
    if(n)n.dataset.active=active===null?"unknown":(active?"yes":"no");
  }
  function modeValue(s) {
    const x=String(s?.eqFast?.me||s?.eqStatus?.mode?.eff||"").toLowerCase();
    return x==="day"?"Komfort":x==="night"?"Útlum":x==="auto"?"Automatický":"—";
  }
  function drawTrend() {
    const canvas=byId("v5-trend");if(!canvas||canvas.offsetWidth<10)return;
    const ctx=canvas.getContext("2d");if(!ctx)return;
    const ratio=Math.min(2,window.devicePixelRatio||1);
    const rect=canvas.getBoundingClientRect();
    const width=Math.max(300,rect.width),height=208;
    if(canvas.width!==Math.round(width*ratio)||canvas.height!==Math.round(height*ratio)){
      canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);
    }
    ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,width,height);
    const rootDark=doc.documentElement.dataset.theme==="dark";
    const faint=rootDark?"rgba(184,208,225,.12)":"rgba(33,57,74,.10)";
    const ink=rootDark?"#89a5bf":"#73889a";
    const valid=[...buffer.actual,...buffer.target].filter(Number.isFinite);
    const placeholder=byId("v5-trend-placeholder");
    if(placeholder)placeholder.hidden=valid.length>0;
    if(!valid.length)return;
    let min=Math.floor((Math.min(...valid)-4)/5)*5,max=Math.ceil((Math.max(...valid)+4)/5)*5;
    if(max-min<10){max=min+10;}
    const lx=45,rx=width-12,top=12,bottom=height-25,span=Math.max(1,buffer.max-1);
    ctx.lineWidth=1;ctx.font="10px system-ui,sans-serif";ctx.textBaseline="middle";ctx.fillStyle=ink;ctx.textAlign="right";
    for(let i=0;i<=4;i++){
      const v=min+(max-min)*i/4;const y=bottom-(bottom-top)*i/4;
      ctx.beginPath();ctx.strokeStyle=faint;ctx.moveTo(lx,y);ctx.lineTo(rx,y);ctx.stroke();
      ctx.fillText(Math.round(v)+"°",lx-8,y);
    }
    const line=(series,color,dash=[])=>{
      ctx.beginPath();ctx.lineWidth=2.5;ctx.lineJoin="round";ctx.lineCap="round";ctx.strokeStyle=color;
      ctx.setLineDash(dash);let started=false;
      for(let i=0;i<series.length;i++){
        const value=series[i],x=rx-((series.length-1-i)/span)*(rx-lx);
        if(!Number.isFinite(value)){started=false;continue;}
        const y=bottom-((value-min)/(max-min))*(bottom-top);
        if(!started)ctx.moveTo(x,y);else ctx.lineTo(x,y);started=true;
      }
      ctx.stroke();ctx.setLineDash([]);
    };
    line(buffer.actual,rootDark?"#4dbbac":"#159b87");
    line(buffer.target,rootDark?"#8aafff":"#386fe5",[5,4]);
    ctx.fillStyle=ink;ctx.textAlign="left";ctx.fillText("Před 120 s",lx,bottom+14);
    ctx.textAlign="right";ctx.fillText("Nyní",rx,bottom+14);
  }
  function scheduleTrend() {
    if(buffer.paintQueued)return;
    buffer.paintQueued=true;
    requestAnimationFrame(()=>{buffer.paintQueued=false;drawTrend();});
  }

  function onFast(s) {
    if(!initialized||!s)return;
    const temps=s.fast?.temps||{};
    const sample=s.last||{};
    const eq=s.eqFast||{};
    const mix=s.mixStatus||{};
    const dhw=s.dhwFast||{};
    const outside=finite(temps.outside,temps.outsideC,temps.outsideTempC,s.ot?.outsideTempC,sample.out);
    const actual=finite(temps.flow,s.ot?.chTemp,sample.ch);
    const req=finite(s.ot?.reqWaterTempC,s.ot?.chSet,eq?.bc);
    const ab=finite(mix.abC,eq?.mix?.mf,temps.afterMixC,temps.flowReturnC,s.accu?.after);
    const mixGoal=finite(mix.targetC,eq?.mix?.tf);
    const tank=finite(s.accu?.top,temps.tank_top,eq?.mix?.tk);
    const middle=finite(s.accu?.mid,temps.tank_mid);
    const bottom=finite(s.accu?.bot,temps.tank_bottom);
    const hotWater=finite(temps.dhw_tank,temps.dhw,s.ot?.dhwTemp,sample.dhw);
    const pos=finite(mix.positionPct,eq?.mix?.pct,s.accu?.valve);
    const mode=modeValue(s);
    const in1=Array.isArray(s.io?.inputs)?s.io.inputs[0]:null;
    const heatActive=s.ot?.chActive===true||s.ot?.flameOn===true;
    const dhwActive=dhw.ha===true||s.dhwStatus?.heatActive===true||s.ot?.dhwActive===true;
    const link=s.ot?.linkOk===true;
    if(byId("v5-map-boiler")){
      text("v5-map-boiler",temp(actual));text("v5-map-mix",temp(ab));text("v5-map-circuit",temp(mixGoal));
      text("v5-map-tank",temp(tank));text("v5-map-dhw",temp(hotWater));
      text("v5-map-mode","Režim: "+mode);text("v5-map-position","Poloha: "+pct(pos));
      text("v5-map-flame",s.ot?.flameOn===true?"Hořák v provozu":s.ot?.flameOn===false?"Hořák vypnut":"Hořák: —");
      text("v5-map-dhw-state","Ohřev: "+(dhwActive?"aktivní":"neaktivní"));
      flag('[data-v5-link="boiler"]',heatActive);
      flag('[data-v5-link="heat"]',heatActive&&Number.isFinite(ab));
      flag('[data-v5-node="dhw"]',dhwActive);
      flag('[data-v5-node="tank"]',Number.isFinite(tank));
      flag('[data-v5-node="boiler"]',s.ot?.flameOn===true);
      flag('[data-v5-node="mix"]',mix.moving===true);
    }
    for(const prefix of ["v5-ov"]) {
      text(prefix+"-outside",temp(outside));text(prefix+"-boiler",temp(actual));
      text(prefix+"-target",temp(req));text(prefix+"-mixed",temp(ab));
      text(prefix+"-tank",temp(tank));text(prefix+"-dhw",temp(hotWater));
    }
    text("v5-live-mode",mode);text("v5-live-in1",in1===true?"Aktivní (útlum)":in1===false?"Neaktivní":"—");
    text("v5-live-dhw",dhwActive?"Ohřev aktivní":"Neaktivní");
    text("v5-live-ot",link?"Online":"Nedostupná");
    text("v5-live-mix",pct(pos));
    text("v5-h-target",temp(req));text("v5-h-mode","Aktuální režim: "+mode);
    text("v5-h-actual",temp(actual));text("v5-h-ab",temp(ab));
    text("v5-heat-boiler",temp(actual));text("v5-heat-valve",pct(pos));text("v5-heat-room",temp(ab));
    text("v5-mix-ab",temp(ab));text("v5-mix-goal",temp(mixGoal));text("v5-mix-pct",pct(pos));
    text("v5-mix-error","Odchylka od cíle: "+(Number.isFinite(ab)&&Number.isFinite(mixGoal)?(ab-mixGoal).toFixed(1)+" °C":"—"));
    text("v5-dhw-temp",temp(hotWater));text("v5-dhw-goal",temp(finite(s.dhwStatus?.targetTempC,s.dev?.dhwCfgRaw?.heat?.targetTempC)));
    text("v5-dhw-active",dhwActive?"ANO":"NE");
    text("v5-dhw-pump",dhw.ca===true?"Běží":dhw.ca===false?"Stojí":"—");
    const water=byId("v5-dhw-water");
    if(water && Number.isFinite(hotWater))water.style.height=Math.min(97,Math.max(7,(hotWater-5)/75*100))+"%";
    text("v5-tank-t",temp(tank));text("v5-tank-m",temp(middle));text("v5-tank-b",temp(bottom));
    text("v5-tank-delta",Number.isFinite(tank)&&Number.isFinite(bottom)?(tank-bottom).toFixed(1)+" °C":"—");
    text("v5-tank-detail",Number.isFinite(tank)&&Number.isFinite(bottom)?"Rozdíl horní a spodní teplotní vrstvy.":"Čekám na platné hodnoty všech teplotních čidel.");
    for(const [n,v] of [["top",tank],["mid",middle],["bottom",bottom]]){
      const e=byId("v5-tank-"+n);
      if(e)e.style.setProperty("--level",Number.isFinite(v)?Math.max(0,Math.min(1,(v-15)/65)).toFixed(2):"0");
    }
    text("v5-ot-now",temp(actual));text("v5-ot-req",temp(req));text("v5-ot-mod",pct(finite(s.ot?.modulationPct)));
    text("v5-ot-state",link?(s.ot?.flameOn?"Hořák v provozu":"OpenTherm připojen"):"OpenTherm: nepřipojeno");
    const prog=byId("v5-ot-progress");if(prog)prog.style.width=Math.max(0,Math.min(100,finite(s.ot?.modulationPct)||0))+"%";
    for(let i=0;i<3;i++){
      const val=s.io?.inputs?.[i];text("v5-in"+(i+1),val===true?"AKTIVNÍ":val===false?"NEAKTIVNÍ":"—");
      const e=byId("v5-in"+(i+1))?.closest(".v5-digital");if(e)e.dataset.active=val===true?"yes":"no";
    }
    for(let i=0;i<8;i++){
      const val=s.io?.relays?.[i];text("v5-r"+(i+1),val===true?"SEPNUTO":val===false?"VYPNUTO":"—");
      const e=byId("v5-r"+(i+1))?.closest(".v5-relay");if(e)e.dataset.active=val===true?"yes":"no";
    }
    const free=finite(s.diag?.heap?.free),psram=finite(s.diag?.heap?.psramFree);
    text("v5-heap-free",Number.isFinite(free)?Math.round(free/1024)+" kB":"—");
    text("v5-psram-free",Number.isFinite(psram)?(psram/1048576).toFixed(1)+" MB":"—");
    const up=finite(s.system?.uptimeSec);
    text("v5-uptime",Number.isFinite(up)?Math.floor(up/3600)+" h "+Math.floor((up%3600)/60)+" min":"—");
    const now=Date.now();
    if(now-buffer.lastSample>=850){
      buffer.lastSample=now;
      buffer.actual.push(actual);buffer.target.push(req);buffer.time.push(now);
      for(const series of [buffer.actual,buffer.target,buffer.time]) if(series.length>buffer.max)series.splice(0,series.length-buffer.max);
      if(!doc.hidden && (byId("view-overview")?.classList.contains("active")||byId("view-heating")?.classList.contains("active")))scheduleTrend();
    }
  }

  function onView(view,s){
    if(s)onFast(s);
    if(view==="overview"||view==="heating")setTimeout(drawTrend,30);
  }
  function init() {
    if(initialized)return;
    const tasks=[overview,heating,mixing,dhw,accu,opentherm,thermometers,io,diagnostics];
    for(const work of tasks){
      const name=work.name==="diagnostics"?"diag":work.name;
      const view=byId("view-"+name);
      const saved=view?.innerHTML;
      try{work();}catch(e){
        console.error("THERMA 5: page layout failed",name,e);
        if(view&&saved!==undefined)view.innerHTML=saved;
      }
    }
    // Existing button listeners are attached later by app.js boot() to these
    // freshly moved ORIGINAL nodes, preserving their identifiers.
    initialized=true;
    doc.documentElement.classList.add("therma-v5");
    window.addEventListener("resize",()=>{if(!doc.hidden)scheduleTrend();},{passive:true});
    doc.addEventListener("visibilitychange",()=>{if(!doc.hidden)scheduleTrend();});
  }
  window.ThermaV5={init,onFast,onView,drawTrend};
  if(doc.readyState==="loading")doc.addEventListener("DOMContentLoaded",init,{once:true});
  else init();
})();
