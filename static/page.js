/* HumanSkill-4D project page. All queries, selections and intervals come from static/data.js, which
   build.py writes from the saved answer records; static/viewer.js renders the avatars' Gaussians. */
(() => {
  "use strict";
  const D = window.HS4D;
  const $ = (selector) => document.querySelector(selector);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "style") node.setAttribute("style", value);
      else node.setAttribute(key, value);
    }
    for (const child of children) if (child != null) node.append(child);
    return node;
  }

  /* Run `on` while `target` is on screen and `off` when it leaves. */
  function whileVisible(target, on, off) {
    new IntersectionObserver(([entry]) => (entry.isIntersecting ? on() : off()), { threshold: 0.15 }).observe(target);
  }

  // With preload="none" a new source loads only once play() is called, so play first and seek on metadata.
  function setSource(video, src) {
    if (video.getAttribute("src") === src) return;
    video.src = src;
    if (video.wanted && !video.userPaused) video.play().catch(() => {});
  }

  function playWhileVisible(target, video) {
    whileVisible(target, () => {
      video.wanted = true;
      if (!video.userPaused) video.play().catch(() => {});
    }, () => { video.wanted = false; video.pause(); });
  }

  /* ------------------------------------------------------------ authors */
  // Hovering or tapping an affiliation selects its authors in that affiliation's colour.
  for (const button of document.querySelectorAll(".affiliation")) {
    const lit = `lit-${button.dataset.aff}`;
    const on = () => $("#authors").classList.add(lit), off = () => $("#authors").classList.remove(lit);
    button.addEventListener("pointerenter", on);
    button.addEventListener("pointerleave", off);
    button.addEventListener("focus", on);
    button.addEventListener("blur", off);
  }

  /* ------------------------------------------------------------ the opening query */
  // The query is typed, then its answer appears, as in the teaser.
  if (!reduced) {
    const text = $("#ask-text"), full = text.textContent, answer = $(".ask-answer");
    text.textContent = "";
    answer.classList.add("waiting");
    $(".ask-query").classList.add("typing");
    let i = 0;
    const type = () => {
      text.textContent = full.slice(0, ++i);
      if (i < full.length) setTimeout(type, 38);
      else setTimeout(() => { $(".ask-query").classList.remove("typing"); answer.classList.remove("waiting"); }, 250);
    };
    setTimeout(type, 400);
  }

  /* ------------------------------------------------------------ 3D stages */
  // A stage is one canvas with its Gaussian renderer. A query only recolours the rows it selected, with the
  // paper's overlay per Gaussian: the context fades toward white and loses colour, and the selection takes
  // the Where colour keyed to its own luminance. Switching cross-fades from the colours on screen.
  const buffers = new Map();
  const fetchBuffer = (file) => {
    if (!buffers.has(file)) buffers.set(file, fetch(file).then((r) => r.arrayBuffer()));
    return buffers.get(file);
  };

  function mask(prompt, count) {
    if (!prompt.mask) {
      const bytes = Uint8Array.from(atob(prompt.bits), (ch) => ch.charCodeAt(0));
      prompt.mask = new Uint8Array(count);
      for (let i = 0; i < count; i++) prompt.mask[i] = (bytes[i >> 3] >> (i & 7)) & 1;
    }
    return prompt.mask;
  }

  function paint(base, selected) {
    const out = base.slice();
    if (!selected) return out;
    const lum = (i) => (0.2126 * base[4 * i] + 0.7152 * base[4 * i + 1] + 0.0722 * base[4 * i + 2]) / 255;
    let sum = 0, n = 0;
    for (let i = 0; i < selected.length; i++) if (selected[i]) { sum += lum(i); n++; }
    const mean = n ? sum / n : 0;
    for (let i = 0; i < selected.length; i++) {
      if (selected[i]) {
        const k = 1 + 1.15 * (lum(i) - mean);
        out.set([216 * k, 27 * k, 96 * k].map((v) => Math.max(0, Math.min(255, v))), 4 * i);
      } else {
        const gray = 255 * lum(i);
        for (let c = 0; c < 3; c++) out[4 * i + c] = 0.94 * (0.6 * base[4 * i + c] + 0.4 * gray) + 0.06 * 255;
      }
    }
    return out;
  }

  function makeStage(canvas) {
    const stage = { viewer: null, item: null, shown: null, fade: 0, visible: false, wanted: true };
    stage.ensure = () => {
      if (!stage.viewer) stage.viewer = new GaussianViewer(canvas);
      return stage.viewer;
    };
    stage.update = () => { if (stage.viewer) stage.viewer.active = stage.visible && stage.wanted; };
    stage.load = async (item, keepView = false) => {
      const viewer = stage.ensure();
      stage.item = item;
      const buffer = await fetchBuffer(item.file);
      if (stage.item !== item) return false;  // a later choice replaced this one
      viewer.load(buffer, item.camera, keepView);
      stage.shown = null;  // a new avatar starts from its own colours, never cross-fades from another
      item.painted = item.painted || {};
      return true;
    };
    stage.colours = (prompt) => {
      const item = stage.item, key = prompt ? prompt.id : "";
      return (item.painted[key] = item.painted[key] || paint(stage.viewer.base, prompt && mask(prompt, item.count)));
    };
    stage.show = (prompt) => {
      const target = stage.colours(prompt), viewer = stage.viewer, from = stage.shown;
      cancelAnimationFrame(stage.fade);
      if (!from || from.length !== target.length || reduced) { viewer.setColors(stage.shown = target); return; }
      const start = performance.now(), mix = new Uint8Array(target.length);
      const step = (now) => {
        const t = Math.min(1, (now - start) / 220);
        for (let i = 0; i < mix.length; i++) mix[i] = from[i] + (target[i] - from[i]) * t;
        viewer.setColors(mix);
        stage.shown = t < 1 ? mix.slice() : target;
        if (t < 1) stage.fade = requestAnimationFrame(step);
      };
      stage.fade = requestAnimationFrame(step);
    };
    return stage;
  }

  /* ------------------------------------------------------------ 3D explorer */
  const explorer = makeStage($("#viewer-canvas"));
  const ex = { index: 2, prompt: null, original: false, touched: false };
  const promptButtons = [], subjectButtons = [];
  whileVisible($("#where"), () => { explorer.visible = true; explorer.update(); }, () => { explorer.visible = false; explorer.update(); });

  D.viewer3d.forEach((item, i) => {
    const button = el("button", { class: "subject", type: "button", "aria-pressed": "false", title: item.title },
      el("span", { class: "subject-preview", "aria-hidden": "true",
        style: `background-image:url(${D.sprite});background-position:${(i % 3) * 50}% ${Math.floor(i / 3) * 50}%` }),
      el("span", { class: "subject-label", text: item.title.replace("ZJU-MoCap ", "") }));
    button.addEventListener("click", () => { ex.touched = true; showAvatar(i); });
    subjectButtons.push(button);
    $("#viewer-subjects").append(button);
  });

  function listPrompts(item) {
    const list = $("#viewer-prompts");
    list.replaceChildren();
    promptButtons.length = 0;
    let group = null;
    for (const prompt of item.prompts) {
      if (prompt.group !== group) list.append(el("p", { class: "prompt-group", text: (group = prompt.group) }));
      const button = el("button", { class: "prompt", type: "button", "aria-pressed": "false", text: prompt.query });
      button.prompt = prompt;
      button.addEventListener("click", () => { ex.touched = true; choose(prompt); });
      // Hovering previews a query on the avatar; leaving the list returns to the chosen one.
      button.addEventListener("pointerenter", (event) => { if (event.pointerType === "mouse" && !ex.original) explorer.show(prompt); });
      promptButtons.push(button);
      list.append(button);
    }
    list.onpointerleave = () => { if (!ex.original) explorer.show(ex.prompt); };
  }

  function choose(prompt) {
    ex.prompt = prompt;
    setOriginal(false);
    explorer.show(prompt);
    for (const button of promptButtons) {
      button.setAttribute("aria-pressed", String(button.prompt === prompt));
      button.classList.toggle("hint", !ex.touched && button === promptButtons.find((b) => b.prompt !== prompt));
    }
    $("#viewer-answer").replaceChildren(...(prompt ? [el("dl", {},
      el("dt", {}, el("span", { class: "swatch" }), "Selected"), el("dd", { text: prompt.categories.join(", ") }))] : []));
  }

  function setOriginal(on) {
    ex.original = on;
    $("#viewer-original").setAttribute("aria-pressed", String(on));
    $("#viewer-original").textContent = on ? "Show the answer" : "Show original";
    if (explorer.viewer) explorer.show(on ? null : ex.prompt);
  }

  async function showAvatar(index) {
    const item = D.viewer3d[index], keep = ex.prompt && ex.prompt.id;
    ex.index = index;
    $("#viewer-title").textContent = item.title;
    subjectButtons.forEach((button, i) => button.setAttribute("aria-pressed", String(i === index)));
    $("#viewer-status").hidden = false;
    try {
      if (!(await explorer.load(item))) return;
    } catch (error) {
      $("#viewer-status").textContent = "This browser cannot show WebGL2, which the 3D viewer needs.";
      return;
    }
    $("#viewer-status").hidden = true;
    for (const id of ["#viewer-original", "#viewer-reset"]) $(id).disabled = false;
    listPrompts(item);
    choose(item.prompts.find((p) => p.id === keep) || item.prompts.find((p) => p.id === "sunscreen") || item.prompts[0]);
  }

  $("#viewer-original").addEventListener("click", () => setOriginal(!ex.original));
  $("#viewer-reset").addEventListener("click", () => explorer.viewer && explorer.viewer.goHome());
  showAvatar(ex.index);

  /* ------------------------------------------------------------ 4D explorer */
  const clipVideo = $("#clip");
  const timeline = $("#timeline");
  const playhead = $("#playhead");
  const readout = $("#frame-readout");
  const playButton = $("#clip-play");
  const rotateCue = $("#clip-rotate");
  const moment = makeStage($("#moment-canvas"));
  const clipState = { clip: null, momentIndex: -1 };
  playWhileVisible($("#when"), clipVideo);
  whileVisible($("#when"), () => { moment.visible = true; moment.update(); }, () => { moment.visible = false; moment.update(); });

  // Group the cases by query family; a family whose queries differ in one word shows "left / right".
  const families = new Map();
  for (const clip of D.clips4d) {
    const family = clip.id.split("_")[0];
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(clip);
  }
  function familyTitle(clips) {
    const words = clips.map((clip) => clip.query.split(" "));
    const differing = words[0].map((_, i) => [...new Set(words.map((w) => w[i]))]);
    if (words.some((w) => w.length !== words[0].length) || differing.filter((v) => v.length > 1).length > 1) return clips[0].query;
    return differing.map((variants) => variants.join(" / ")).join(" ");
  }
  const caseButtons = [];
  for (const clips of families.values()) {
    const row = el("div", { class: "case-row" });
    for (const clip of clips) {
      const button = el("button", { class: "case", type: "button", role: "tab", "aria-label": `${clip.clip}, ${clip.dataset}` },
        el("img", { src: clip.thumb, alt: "", loading: "lazy" }), el("span", { text: clip.clip }));
      button.clip = clip;
      button.addEventListener("click", () => showClip(clip));
      caseButtons.push(button);
      row.append(button);
    }
    $("#clip-cases").append(el("div", { class: "case-group" }, el("p", { text: familyTitle(clips) }), row));
  }

  const seconds = (clip, sourceFrame) => (sourceFrame - clip.first) / clip.fps;
  const frameNow = (clip) => clip.first + Math.min(clip.end - clip.first - 1, Math.floor(clipVideo.currentTime * clip.fps + 1e-3));
  const place = (clip, frame) => `${(100 * (frame - clip.first + 0.5)) / (clip.end - clip.first)}%`;

  function showClip(clip) {
    leaveMoment(false);
    clipState.clip = clip;
    caseButtons.forEach((button) => button.setAttribute("aria-selected", String(button.clip === clip)));
    $("#clip-query").textContent = clip.query;
    clipVideo.poster = clip.poster;
    clipVideo.userPaused = false;
    setSource(clipVideo, clip.video);
    timeline.querySelectorAll(".interval, .moment").forEach((node) => node.remove());
    const length = clip.end - clip.first;
    for (const [a, b] of clip.intervals) {
      timeline.insertBefore(el("div", { class: "interval",
        style: `left:${(100 * (a - clip.first)) / length}%;width:${(100 * (b + 1 - a)) / length}%` }), playhead);
    }
    clip.moments.forEach((m, i) => {
      const dot = el("button", { class: "moment", type: "button", style: `left:${place(clip, m.frame)}`,
        title: `Turn frame ${m.frame} in 3D`, "aria-label": `Turn frame ${m.frame} in 3D` });
      dot.addEventListener("click", (event) => { event.stopPropagation(); enterMoment(i); });
      timeline.append(dot);
    });
    updatePlayState();
  }

  function updatePlayState() {
    const paused = clipVideo.paused || clipVideo.userPaused;
    playButton.textContent = paused ? "Play" : "Pause";
    rotateCue.hidden = !paused || clipState.momentIndex >= 0;
  }
  for (const type of ["play", "pause"]) clipVideo.addEventListener(type, updatePlayState);

  function togglePlay() {
    if (clipState.momentIndex >= 0) return;
    clipVideo.userPaused = !clipVideo.paused;
    if (clipVideo.userPaused) clipVideo.pause(); else clipVideo.play().catch(() => {});
    updatePlayState();
  }
  playButton.addEventListener("click", () => (clipState.momentIndex >= 0 ? leaveMoment(true) : togglePlay()));
  clipVideo.addEventListener("click", togglePlay);
  rotateCue.addEventListener("click", () => {
    const clip = clipState.clip, now = frameNow(clip);
    const nearest = clip.moments.reduce((best, m, i) => (Math.abs(m.frame - now) < Math.abs(clip.moments[best].frame - now) ? i : best), 0);
    enterMoment(nearest);
  });

  // A predicted moment, turned in 3D in place of the clip; the arrows step through the clip's moments.
  async function enterMoment(index) {
    const clip = clipState.clip, m = clip.moments[index], stepping = clipState.momentIndex >= 0;
    clipState.momentIndex = index;
    clipVideo.userPaused = true;
    clipVideo.pause();
    clipVideo.currentTime = seconds(clip, m.frame);
    $("#moment-canvas").hidden = false;
    $("#moment-nav").hidden = false;
    $("#clip-labels").classList.add("moment");
    rotateCue.hidden = true;
    playButton.textContent = "Play";
    moment.wanted = true;
    moment.update();
    try {
      if (!(await moment.load(m, stepping))) return;
    } catch (error) {
      leaveMoment(false);
      return;
    }
    moment.show(m.prompts[0]);
    $("#moment-prev").disabled = index === 0;
    $("#moment-next").disabled = index === clip.moments.length - 1;
    playhead.style.left = place(clip, m.frame);
    readout.replaceChildren(`frame ${m.frame}`, el("span", { class: "live", text: " · selected" }));
  }

  function leaveMoment(resume) {
    if (clipState.momentIndex < 0) return;
    clipState.momentIndex = -1;
    moment.wanted = false;
    moment.update();
    $("#moment-canvas").hidden = true;
    $("#moment-nav").hidden = true;
    $("#clip-labels").classList.remove("moment");
    if (resume) { clipVideo.userPaused = false; clipVideo.play().catch(() => {}); }
    updatePlayState();
  }
  $("#moment-prev").addEventListener("click", () => enterMoment(clipState.momentIndex - 1));
  $("#moment-next").addEventListener("click", () => enterMoment(clipState.momentIndex + 1));
  $("#moment-back").addEventListener("click", () => leaveMoment(true));

  // The playhead and readout follow the clip only while it shows and only when its frame changes.
  let shownFrame = null;
  function follow() {
    requestAnimationFrame(follow);
    const clip = clipState.clip;
    if (!clip || !clipVideo.wanted || clipState.momentIndex >= 0 || clipVideo.readyState < 2) return;
    const current = frameNow(clip);
    if (shownFrame === `${clip.id}:${current}`) return;
    shownFrame = `${clip.id}:${current}`;
    const live = clip.intervals.some(([a, b]) => a <= current && current <= b);
    playhead.style.left = place(clip, current);
    readout.replaceChildren(`frame ${current}`, live ? el("span", { class: "live", text: " · selected" }) : "");
  }
  requestAnimationFrame(follow);

  timeline.addEventListener("click", (event) => {
    const clip = clipState.clip, box = timeline.getBoundingClientRect();
    leaveMoment(false);
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    clipVideo.currentTime = (fraction * (clip.end - clip.first)) / clip.fps;
  });
  timeline.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (step && clipState.momentIndex < 0) clipVideo.currentTime = Math.max(0, clipVideo.currentTime + step / 2);
  });
  showClip(D.clips4d[0]);

  /* ------------------------------------------------------------ teaser */
  const hero = $("#hero");
  $("#teaser-details").addEventListener("toggle", (event) => {
    if (event.target.open && !hero.getAttribute("src")) {
      hero.poster = D.hero.poster;
      hero.src = D.hero.full;
    }
    if (!event.target.open) hero.pause();
  });

  /* ------------------------------------------------------------ comparison */
  const comparison = $("#comparison");
  playWhileVisible($("#compare-methods"), comparison);
  const compareTabs = D.comparisons.map((item) => {
    const tab = el("button", { class: "chip", type: "button", role: "tab",
      text: `${item.task.startsWith("4D") ? "4D" : "3D"} · ${item.subtype}` });
    tab.addEventListener("click", () => showComparison(item, tab));
    $("#compare-tabs").append(tab);
    return tab;
  });
  function showComparison(item, tab) {
    compareTabs.forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    comparison.poster = item.poster;
    setSource(comparison, item.video);
    $("#comparison-caption").replaceChildren(el("b", { text: item.subtype }), ` · ${item.task} · `, el("q", { text: item.query }));
  }
  showComparison(D.comparisons[0], compareTabs[0]);

  /* ------------------------------------------------------------ method */
  $("#pipeline").src = D.pipeline;
})();
