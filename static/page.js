/* HumanSkill-4D project page. All queries, selections and intervals come from static/data.js, which
   build.py writes from the saved answer records; static/viewer.js renders the avatars' Gaussians. */
(() => {
  "use strict";
  const D = window.HS4D;
  const $ = (selector) => document.querySelector(selector);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const stages = [];
  const videos = [...document.querySelectorAll("video")];
  function pauseVideos(except) {
    for (const video of videos) if (video !== except) { video.userPaused = true; video.pause(); }
  }
  for (const video of videos) {
    video.userPaused = true;
    video.addEventListener("play", () => {
      video.userPaused = false;
      pauseVideos(video);
      for (const stage of stages) stage.update();
    });
    video.addEventListener("pause", () => { for (const stage of stages) stage.update(); });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pauseVideos();
    for (const stage of stages) stage.update();
  });

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
    if (video.getAttribute("src") !== src) { video.pause(); video.src = src; }
    if (video.wanted && !video.userPaused) video.play().catch(() => {});
  }

  function playWhileVisible(target, video) {
    whileVisible(target, () => {
      video.wanted = true;
      if (!document.hidden && !video.userPaused) video.play().catch(() => {});
    }, () => { video.wanted = false; video.userPaused = true; video.pause(); });
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
  // the Where colour keyed to its own luminance. Selection changes update once, on click.
  const buffers = new Map();
  const fetchBuffer = (file) => {
    if (!buffers.has(file)) buffers.set(file, fetch(file).then((r) => {
      if (!r.ok) throw new Error(`Avatar request failed (${r.status})`);
      return r.arrayBuffer();
    }).catch((error) => { buffers.delete(file); throw error; }));
    return buffers.get(file);
  };

  function mask(prompt, count) {
    if (!prompt.mask) {
      const bytes = Uint8Array.from(atob(prompt.bits), (ch) => ch.charCodeAt(0));
      if (bytes.length !== Math.ceil(count / 8)) throw new Error("Selection does not match the avatar");
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
    const stage = { viewer: null, item: null, shown: null, visible: false, wanted: true, loading: false, request: 0 };
    stages.push(stage);
    canvas.addEventListener("viewerinteraction", () => pauseVideos());
    stage.ensure = () => {
      if (!stage.viewer) stage.viewer = new GaussianViewer(canvas);
      return stage.viewer;
    };
    stage.update = () => {
      if (stage.viewer) stage.viewer.setActive(stage.visible && stage.wanted && !!stage.item && !stage.loading &&
        !document.hidden && videos.every((video) => video.paused));
    };
    stage.cancel = () => { stage.request++; stage.loading = false; stage.wanted = false; stage.update(); };
    stage.load = async (item, keepView = false) => {
      const viewer = stage.ensure();
      const request = ++stage.request;
      stage.item = item;
      stage.loading = true;
      stage.update();
      try {
        const buffer = await fetchBuffer(item.file);
        if (stage.request !== request) return false;
        if (buffer.byteLength !== item.count * 40) throw new Error("Avatar file is incomplete or has the wrong size");
        viewer.load(buffer, item.camera, keepView);
        stage.shown = null;
        item.painted = item.painted || {};
        stage.loading = false;
        stage.update();
        return true;
      } catch (error) {
        if (stage.request !== request) return false;
        stage.loading = false;
        stage.item = null;
        stage.update();
        throw error;
      }
    };
    stage.colours = (prompt) => {
      const item = stage.item, key = prompt ? prompt.id : "";
      return (item.painted[key] = item.painted[key] || paint(stage.viewer.base, prompt && mask(prompt, item.count)));
    };
    stage.show = (prompt) => {
      if (!stage.item || stage.loading) return;
      const target = stage.colours(prompt);
      if (stage.shown === target) return;
      stage.viewer.setColors(stage.shown = target);
    };
    return stage;
  }

  /* ------------------------------------------------------------ 3D explorer */
  const explorer = makeStage($("#viewer-canvas"));
  const ex = { index: 2, prompt: null, promptId: "sunscreen", original: false };
  const promptButtons = [], subjectButtons = [];
  whileVisible($("#viewer-viewport"), () => { explorer.visible = true; explorer.update(); }, () => { explorer.visible = false; explorer.update(); });

  D.viewer3d.forEach((item, i) => {
    const button = el("button", { class: "subject", type: "button", "aria-pressed": "false", title: item.title, "aria-label": item.title },
      el("span", { class: "subject-preview", "aria-hidden": "true",
        style: `background-image:url(${D.sprite});background-position:${(i % 3) * 50}% ${Math.floor(i / 3) * 50}%` }),
      el("span", { class: "subject-label", text: item.title.replace("ZJU-MoCap ", "") }));
    button.addEventListener("click", () => { if (i !== ex.index || !explorer.item) showAvatar(i); });
    subjectButtons.push(button);
    $("#viewer-subjects").append(button);
  });

  // Each group of queries has a layout from data.js: "row" sets short queries side by side, "list" one per
  // line, and "folded" puts the group under a "More queries" toggle that opens when it holds the selection.
  function listPrompts(item, selectedId) {
    const list = $("#viewer-prompts");
    list.replaceChildren();
    promptButtons.length = 0;
    const groups = new Map();
    for (const prompt of item.prompts) {
      if (!groups.has(prompt.group)) groups.set(prompt.group, []);
      groups.get(prompt.group).push(prompt);
    }
    for (const [group, prompts] of groups) {
      const buttons = prompts.map((prompt) => {
        const button = el("button", { class: "prompt", type: "button", "aria-pressed": "false", "data-prompt": prompt.id, text: prompt.query });
        button.prompt = prompt;
        button.addEventListener("click", () => choose(prompt));
        promptButtons.push(button);
        return button;
      });
      const layout = (D.promptGroups || {})[group] || "list";
      if (layout === "folded") {
        const more = el("details", { class: "more-queries" }, el("summary", { text: `More queries: ${group}` }), ...buttons);
        more.open = prompts.some((prompt) => prompt.id === selectedId);
        list.append(more);
      } else {
        list.append(el("p", { class: "prompt-group", text: group }),
          ...(layout === "row" ? [el("div", { class: "prompt-row" }, ...buttons)] : buttons));
      }
    }
  }

  function choose(prompt, requestedId = prompt?.id) {
    ex.prompt = prompt;
    ex.promptId = requestedId;
    setOriginal(false);
    for (const button of promptButtons) {
      button.setAttribute("aria-pressed", String(button.prompt === prompt));
    }
    $("#viewer-answer").replaceChildren(...(prompt ? [el("dl", {},
      el("dt", {}, el("span", { class: "swatch" }), "Selected"), el("dd", { text: prompt.categories.join(", ") }))] :
      [el("p", { text: "This query is not available for this avatar. Choose another example." })]));
    $("#viewer-original").disabled = !prompt;
    $("#viewer-share").disabled = !prompt;
  }

  function setOriginal(on) {
    $("#viewer-share-panel").hidden = true;
    ex.original = on;
    $("#viewer-original").setAttribute("aria-pressed", String(on));
    $("#viewer-original").textContent = on ? "Show the answer" : "Show original";
    if (explorer.viewer) explorer.show(on ? null : ex.prompt);
  }

  async function showAvatar(index, selection = null) {
    const item = D.viewer3d[index], keep = selection ? selection.promptId : ex.promptId;
    pauseVideos();
    explorer.wanted = true;
    ex.index = index;
    ex.promptId = keep;
    $("#viewer-share-panel").hidden = true;
    $("#viewer-title").textContent = item.title;
    subjectButtons.forEach((button, i) => button.setAttribute("aria-pressed", String(i === index)));
    $("#viewer-status").hidden = false;
    $("#viewer-status").textContent = `Loading ${item.title}…`;
    $("#viewer").setAttribute("aria-busy", "true");
    for (const button of [...promptButtons, $("#viewer-original"), $("#viewer-reset"), $("#viewer-share")]) button.disabled = true;
    try {
      if (!(await explorer.load(item))) return;
    } catch (error) {
      $("#viewer").setAttribute("aria-busy", "false");
      const retry = el("button", { type: "button", class: "small", text: "Try again" });
      retry.addEventListener("click", () => showAvatar(index, selection));
      $("#viewer-status").replaceChildren(`Could not load ${item.title}. ${error.message}`, retry);
      return;
    }
    $("#viewer-status").hidden = true;
    $("#viewer").setAttribute("aria-busy", "false");
    for (const id of ["#viewer-original", "#viewer-reset"]) $(id).disabled = false;
    listPrompts(item, keep);
    choose(item.prompts.find((p) => p.id === keep) || null, keep);
    if (selection?.original && ex.prompt) setOriginal(true);
  }

  $("#viewer-original").addEventListener("click", () => setOriginal(!ex.original));
  $("#viewer-reset").addEventListener("click", () => explorer.viewer && explorer.viewer.goHome());

  /* Sharing uses a fragment, so a project hosted under any GitHub Pages path needs no routing. */
  const sharePanel = $("#viewer-share-panel"), shareURL = $("#viewer-share-url");
  $("#viewer-share").addEventListener("click", async () => {
    const url = new URL(location.href);
    const params = new URLSearchParams({ avatar: D.viewer3d[ex.index].id, query: ex.promptId });
    if (ex.original) params.set("original", "1");
    url.hash = `where?${params}`;
    shareURL.value = url.href;
    sharePanel.hidden = false;
    const status = $("#viewer-share-status");
    status.textContent = "Copy this link to reopen this avatar and query.";
    try {
      await navigator.clipboard.writeText(url.href);
      if (shareURL.value === url.href) status.textContent = "Link copied. Ready to share.";
    } catch {
      // HTTP previews and denied clipboard access still expose a selectable link.
      if (!sharePanel.hidden && shareURL.value === url.href) {
        shareURL.focus({ preventScroll: true });
        shareURL.select();
      }
    }
  });
  shareURL.addEventListener("click", () => shareURL.select());
  $("#viewer-share-close").addEventListener("click", () => {
    sharePanel.hidden = true;
    $("#viewer-share").focus({ preventScroll: true });
  });

  function openSharedSelection() {
    if (!location.hash.startsWith("#where?")) return false;
    const params = new URLSearchParams(location.hash.slice(7));
    const index = D.viewer3d.findIndex((item) => item.id === params.get("avatar"));
    if (index < 0) {
      explorer.cancel();
      explorer.item = null;
      ex.index = -1;
      ex.prompt = null;
      ex.promptId = "sunscreen";
      setOriginal(false);
      sharePanel.hidden = true;
      $("#viewer").setAttribute("aria-busy", "false");
      $("#viewer-title").textContent = "Choose an avatar";
      $("#viewer-status").hidden = false;
      $("#viewer-status").textContent = "This shared avatar is not available. Choose an avatar below to explore.";
      $("#viewer-prompts").replaceChildren();
      promptButtons.length = 0;
      $("#viewer-answer").replaceChildren();
      for (const id of ["#viewer-original", "#viewer-reset", "#viewer-share"]) $(id).disabled = true;
      subjectButtons.forEach((button) => button.setAttribute("aria-pressed", "false"));
    } else {
      showAvatar(index, { promptId: params.get("query"), original: params.get("original") === "1" });
    }
    if (!$("#viewer-expanded").open) $("#where").scrollIntoView({ behavior: "instant", block: "start" });
    return true;
  }
  window.addEventListener("hashchange", openSharedSelection);
  if (!openSharedSelection()) showAvatar(ex.index);

  /* Move the existing canvas into a native modal: one renderer, with its view and selection intact. */
  const expanded = $("#viewer-expanded"), viewerElement = $("#viewer"), expandButton = $("#viewer-expand");
  let returnScroll = null;
  expandButton.hidden = typeof expanded.showModal !== "function";
  expandButton.addEventListener("click", () => {
    pauseVideos();
    returnScroll = { left: window.scrollX, top: window.scrollY, behavior: "instant" };
    document.body.classList.add("viewer-expanded-open");
    expanded.append(viewerElement);
    expanded.showModal();
  });
  expanded.addEventListener("close", () => {
    expanded.before(viewerElement);
    document.body.classList.remove("viewer-expanded-open");
    expandButton.focus({ preventScroll: true });
    window.scrollTo(returnScroll);
  });

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

  // As in the 3D explorer: the queries beside the stage, and below it the people (clips) that answered the
  // chosen query, in data order. A query opens on its first person, its representative.
  const byQuery = new Map();
  for (const clip of D.clips4d) {
    if (!byQuery.has(clip.query)) byQuery.set(clip.query, []);
    byQuery.get(clip.query).push(clip);
  }
  const queryButtons = [...byQuery.keys()].map((query) => {
    const button = el("button", { class: "prompt", type: "button", "aria-pressed": "false", text: query });
    button.query = query;
    button.addEventListener("click", () => showClip(byQuery.get(query)[0], true));
    $("#clip-queries").append(button);
    return button;
  });
  let peopleButtons = [];
  function listPeople(query) {
    peopleButtons = byQuery.get(query).map((clip) => {
      const button = el("button", { class: "subject", type: "button", "aria-pressed": "false", title: `${clip.person}, clip ${clip.clip}`,
        "aria-label": `${clip.person}, clip ${clip.clip}` },
        el("img", { class: "subject-preview", src: clip.thumb, alt: "", loading: "lazy" }),
        el("span", { class: "subject-label", text: clip.person.split(" ").pop() }));
      button.clip = clip;
      button.addEventListener("click", () => { if (clipState.clip !== clip) showClip(clip, true); });
      return button;
    });
    $("#clip-people").replaceChildren(...peopleButtons);
  }

  const seconds = (clip, sourceFrame) => (sourceFrame - clip.first) / clip.fps;
  const frameNow = (clip) => clip.first + Math.min(clip.end - clip.first - 1, Math.floor(clipVideo.currentTime * clip.fps + 1e-3));
  const place = (clip, frame) => `${(100 * (frame - clip.first + 0.5)) / (clip.end - clip.first)}%`;

  function showClip(clip, play = false) {
    leaveMoment(false);
    if (clipState.clip?.query !== clip.query) listPeople(clip.query);
    clipState.clip = clip;
    queryButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.query === clip.query)));
    peopleButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.clip === clip)));
    $("#clip-title").textContent = clip.person;
    const intervalCount = `${clip.intervals.length} interval${clip.intervals.length === 1 ? "" : "s"}`;
    $("#clip-answer").replaceChildren(el("dl", {},
      el("dt", {}, el("span", { class: "swatch" }), "Selected"), el("dd", { text: clip.moments[0].prompts[0].categories.join(", ") }),
      el("dt", {}, "When"), el("dd", { text: intervalCount })));
    clipVideo.poster = clip.poster;
    clipVideo.userPaused = !play;
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
    if (!rotateCue.hidden && clipState.clip) {
      const now = frameNow(clipState.clip);
      const nearest = clipState.clip.moments.reduce((a, b) => Math.abs(a.frame - now) <= Math.abs(b.frame - now) ? a : b);
      rotateCue.textContent = `Turn saved frame ${nearest.frame} in 3D`;
    }
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
    $("#moment-status").hidden = false;
    $("#moment-status").textContent = `Loading frame ${m.frame}…`;
    readout.textContent = `Loading frame ${m.frame}…`;
    $("#moment-nav").hidden = false;
    $("#clip-labels").classList.add("moment");
    rotateCue.hidden = true;
    playButton.textContent = "Play";
    moment.wanted = true;
    moment.update();
    $("#moment-prev").disabled = true;
    $("#moment-next").disabled = true;
    try {
      if (!(await moment.load(m, stepping))) return;
    } catch (error) {
      const retry = el("button", { type: "button", class: "small", text: "Try again" });
      retry.addEventListener("click", () => enterMoment(index));
      $("#moment-status").replaceChildren(`Could not load frame ${m.frame}. ${error.message}`, retry);
      readout.textContent = "Frame unavailable";
      return;
    }
    $("#moment-status").hidden = true;
    moment.show(m.prompts[0]);
    $("#moment-prev").disabled = index === 0;
    $("#moment-next").disabled = index === clip.moments.length - 1;
    playhead.style.left = place(clip, m.frame);
    readout.replaceChildren(`frame ${m.frame}`, el("span", { class: "live", text: " · selected" }));
  }

  function leaveMoment(resume) {
    if (clipState.momentIndex < 0) return;
    clipState.momentIndex = -1;
    moment.cancel();
    $("#moment-canvas").hidden = true;
    $("#moment-status").hidden = true;
    $("#moment-nav").hidden = true;
    $("#clip-labels").classList.remove("moment");
    if (resume) { clipVideo.userPaused = false; clipVideo.play().catch(() => {}); }
    updatePlayState();
  }
  $("#moment-prev").addEventListener("click", () => enterMoment(clipState.momentIndex - 1));
  $("#moment-next").addEventListener("click", () => enterMoment(clipState.momentIndex + 1));
  $("#moment-back").addEventListener("click", () => leaveMoment(true));

  // The playhead and readout follow the clip only while it shows and only when its frame changes.
  let shownFrame = null, followRequest = null;
  const videoFrames = typeof clipVideo.requestVideoFrameCallback === "function";
  function follow() {
    const clip = clipState.clip;
    if (!clip || !clipVideo.wanted || clipState.momentIndex >= 0 || clipVideo.readyState < 2) return;
    const current = frameNow(clip);
    if (shownFrame === `${clip.id}:${current}`) return;
    shownFrame = `${clip.id}:${current}`;
    const live = clip.intervals.some(([a, b]) => a <= current && current <= b);
    playhead.style.left = place(clip, current);
    readout.replaceChildren(`frame ${current}`, live ? el("span", { class: "live", text: " · selected" }) : "");
    timeline.setAttribute("aria-valuemin", String(clip.first));
    timeline.setAttribute("aria-valuemax", String(clip.end - 1));
    timeline.setAttribute("aria-valuenow", String(current));
  }
  function queueFollow() {
    if (followRequest !== null || clipVideo.paused || !clipVideo.wanted || document.hidden || clipState.momentIndex >= 0) return;
    const callback = () => { followRequest = null; follow(); queueFollow(); };
    followRequest = videoFrames ? clipVideo.requestVideoFrameCallback(callback) : requestAnimationFrame(callback);
  }
  clipVideo.addEventListener("play", queueFollow);
  clipVideo.addEventListener("pause", () => {
    if (followRequest !== null) {
      if (videoFrames) clipVideo.cancelVideoFrameCallback(followRequest); else cancelAnimationFrame(followRequest);
      followRequest = null;
    }
    follow();
  });
  for (const event of ["loadeddata", "seeked", "timeupdate"]) clipVideo.addEventListener(event, follow);

  function seekClip(time) {
    const clip = clipState.clip;
    const seek = () => {
      if (clipState.clip === clip) clipVideo.currentTime = Math.max(0, Math.min(time, (clip.end - clip.first - 1) / clip.fps));
    };
    if (clipVideo.readyState >= 1) seek();
    else {
      clipVideo.addEventListener("loadedmetadata", seek, { once: true });
      clipVideo.load();
    }
  }
  timeline.addEventListener("click", (event) => {
    const clip = clipState.clip, box = timeline.getBoundingClientRect();
    leaveMoment(false);
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    seekClip((fraction * (clip.end - clip.first)) / clip.fps);
  });
  timeline.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (step && clipState.momentIndex < 0) {
      event.preventDefault();
      seekClip(clipVideo.currentTime + step / 2);
    }
  });
  showClip(D.clips4d[0]);

  /* ------------------------------------------------------------ teaser */
  const hero = $("#hero");
  playWhileVisible($("#teaser"), hero);
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

  /* ------------------------------------------------------------ how it works */
  // A step dims the figure except its panels (data-box: left, top, width and height in % of the figure,
  // one box per panel). Hovering previews a step; clicking pins it, and clicking it again clears it.
  $("#pipeline").src = D.pipeline;
  const steps = [...document.querySelectorAll(".step")];
  const spotlightBox = $("#spotlight");
  let pinned = null;
  function svg(tag, attrs, ...children) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    node.append(...children);
    return node;
  }
  function spotlight(step) {
    steps.forEach((s) => s.setAttribute("aria-pressed", String(s === pinned)));
    spotlightBox.hidden = !step;
    if (!step) return spotlightBox.replaceChildren();
    const boxes = step.dataset.box.split(" ").map((box) => box.split(",").map(Number));
    const rect = ([x, y, width, height], attrs) => svg("rect", { x, y, width, height, rx: 0.6, ...attrs });
    const tone = getComputedStyle(step).getPropertyValue("--tone").trim();
    spotlightBox.replaceChildren(svg("svg", { viewBox: "0 0 100 100", preserveAspectRatio: "none", "aria-hidden": "true" },
      svg("mask", { id: "spotlight-holes" }, rect([0, 0, 100, 100], { rx: 0, fill: "white" }),
        ...boxes.map((box) => rect(box, { fill: "black" }))),
      rect([0, 0, 100, 100], { rx: 0, class: "dim", mask: "url(#spotlight-holes)" }),
      ...boxes.map((box) => rect(box, { class: "ring", style: `stroke:${tone}`, "vector-effect": "non-scaling-stroke" }))));
  }
  for (const step of steps) {
    step.addEventListener("pointerenter", () => spotlight(step));
    step.addEventListener("pointerleave", () => spotlight(pinned));
    step.addEventListener("click", () => {
      pinned = pinned === step ? null : step;
      spotlight(pinned);
      // The figure sits above the steps; bring it back when less than half of it shows.
      const card = $("#pipeline-card").getBoundingClientRect();
      const shown = Math.min(card.bottom, innerHeight) - Math.max(card.top, 0);
      if (pinned && shown < card.height / 2) $(".walk").scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    });
  }
})();
