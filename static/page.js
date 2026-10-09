/* HumanSkill-4D project page. All queries, selections and intervals come from static/data.js, which
   build.py writes from the saved answer records; static/viewer.js renders the avatars' Gaussians. */
(() => {
  "use strict";
  const D = window.HS4D;
  const $ = (selector) => document.querySelector(selector);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const stages = [];
  const videos = [...document.querySelectorAll("video")];
  const autoResumeVideos = new Set();
  // One video plays at a time. The teaser and the 4D clip are never on screen together, so they are paused
  // without counting as paused by the visitor, and each resumes when scrolled back into view.
  function pauseVideos(except) {
    for (const video of videos) if (video !== except) {
      if (!autoResumeVideos.has(video)) video.userPaused = true;
      video.pause();
    }
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
    if (document.hidden) {
      for (const video of videos) {
        if (!autoResumeVideos.has(video)) video.userPaused = true;
        video.pause();
      }
    } else {
      for (const video of autoResumeVideos) {
        if (video.wanted && !video.userPaused) video.play().catch(() => {});
      }
    }
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

  // Queries keep hyphenated words (try-on, video-call) on one line.
  const unbroken = (text) => text.replace(/-/g, "\u2011");

  /* Run `on` while `target` is on screen and `off` when it leaves. */
  function whileVisible(target, on, off) {
    new IntersectionObserver(([entry]) => (entry.isIntersecting && entry.intersectionRatio >= 0.15 ? on() : off()), { threshold: 0.15 }).observe(target);
  }

  // With preload="none" a new source loads only once play() is called, so play first and seek on metadata.
  function setSource(video, src) {
    if (video.getAttribute("src") !== src) { video.pause(); video.src = src; }
    if (video.wanted && !document.hidden && !video.userPaused) video.play().catch(() => {});
  }

  function playWhileVisible(target, video, autoResume = false) {
    if (autoResume) autoResumeVideos.add(video);
    whileVisible(target, () => {
      video.wanted = true;
      if (!document.hidden && !video.userPaused) video.play().catch(() => {});
    }, () => {
      video.wanted = false;
      if (!autoResume) video.userPaused = true;
      video.pause();
    });
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
    canvas.addEventListener("viewerinteraction", () => pauseVideos(canvas));
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
  const selectionCue = el("p", { class: "viewer-selection", "aria-hidden": "true" });
  $("#viewer .viewer-head").after(selectionCue);

  // After a mobile choice, keep the selected query and its avatar together in view. The same stage
  // lives in the expanded dialog, whose sticky heading has its own scroll margin.
  function revealResult(target, force = false) {
    if (!force && !window.matchMedia("(max-width: 860px)").matches) return;
    const box = target.getBoundingClientRect();
    const inset = target.closest("#viewer-expanded") ? 64 : 8;
    if (box.top < inset || box.bottom > innerHeight - 8) {
      target.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
    }
  }
  whileVisible($("#viewer-viewport"), () => { explorer.visible = true; explorer.update(); }, () => { explorer.visible = false; explorer.update(); });

  D.viewer3d.forEach((item, i) => {
    const button = el("button", { class: "subject", type: "button", "aria-pressed": "false", title: item.title, "aria-label": item.title },
      el("span", { class: "subject-preview", "aria-hidden": "true",
        style: `background-image:url(${D.sprite});background-position:${(i % 3) * 50}% ${Math.floor(i / 3) * 50}%` }),
      el("span", { class: "subject-label", text: item.title.replace("ZJU-MoCap ", "") }));
    button.addEventListener("click", () => {
      if (i !== ex.index || !explorer.item) showAvatar(i);
      revealResult($("#viewer .viewer-stage"));
    });
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
        const button = el("button", { class: "prompt", type: "button", "aria-pressed": "false", "data-prompt": prompt.id, text: unbroken(prompt.query) });
        button.prompt = prompt;
        button.addEventListener("click", () => {
          choose(prompt);
          revealResult($("#viewer .viewer-stage"));
        });
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
    selectionCue.replaceChildren(...(prompt ? [el("span", { class: "swatch" }), el("q", { text: unbroken(prompt.query) })] :
      ["Saved answer unavailable for this avatar. Choose another query."]));
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
    selectionCue.textContent = `Loading ${item.title}…`;
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
      selectionCue.textContent = "Choose an avatar below to explore.";
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
  const compareButton = $("#clip-compare");
  const clipStage = $("#clip-viewer .viewer-stage");
  const clipSelectionCue = el("p", { class: "viewer-selection", "aria-hidden": "true" });
  $("#clip-viewer .viewer-head").after(clipSelectionCue);
  const clipState = { clip: null, compareOriginal: false };
  function updateComparison() {
    for (const id of ["#clip-stage", "#clip-labels"]) $(id).classList.toggle("answer-view", !clipState.compareOriginal);
    compareButton.setAttribute("aria-pressed", String(clipState.compareOriginal));
    compareButton.textContent = clipState.compareOriginal ? "Focus on answer" : "Compare original";
  }
  compareButton.addEventListener("click", () => {
    clipState.compareOriginal = !clipState.compareOriginal;
    updateComparison();
  });
  updateComparison();
  playWhileVisible($("#clip-stage"), clipVideo, true);

  // Queries sit beside the stage, with the people answering that query below it, as in the 3D explorer.
  // The first saved answer is the representative; it plays when its stage is visible.
  const byQuery = new Map();
  for (const clip of D.clips4d) {
    if (!byQuery.has(clip.query)) byQuery.set(clip.query, []);
    byQuery.get(clip.query).push(clip);
  }
  $("#clip-query-count").textContent = `· ${byQuery.size} queries`;
  const queryButtons = [...byQuery.keys()].map((query) => {
    const button = el("button", { class: "prompt", type: "button", "aria-pressed": "false", text: unbroken(query) });
    button.query = query;
    button.addEventListener("click", () => {
      showClip(byQuery.get(query)[0]);
      revealResult(clipStage);
    });
    $("#clip-queries").append(button);
    return button;
  });
  let peopleButtons = [];
  function listPeople(query) {
    const clips = byQuery.get(query);
    peopleButtons = clips.map((clip) => {
      const button = el("button", { class: "subject", type: "button", "aria-pressed": "false",
        title: `${clip.person}, clip ${clip.clip}`, "aria-label": `${clip.person}, clip ${clip.clip}` },
        el("img", { class: "subject-preview", src: clip.thumb, alt: "", loading: "lazy" }),
        el("span", { class: "subject-label", text: clip.person.split(" ").pop() }));
      button.clip = clip;
      button.addEventListener("click", () => {
        if (clipState.clip !== clip) showClip(clip);
        revealResult(clipStage);
      });
      return button;
    });
    $("#clip-people").replaceChildren(...peopleButtons);
    $("#clip-people").closest(".subject-picker").hidden = clips.length < 2;
  }

  const seconds = (clip, sourceFrame) => (sourceFrame - clip.first) / clip.fps;
  const frameNow = (clip) => clip.first + Math.min(clip.end - clip.first - 1, Math.floor(clipVideo.currentTime * clip.fps + 1e-3));
  const place = (clip, frame) => `${(100 * (frame - clip.first + 0.5)) / (clip.end - clip.first)}%`;

  // Each clip's answer is rendered from three cameras around the person; a new view keeps the playing time.
  let viewButtons = [];
  function listViews(clip) {
    viewButtons = clip.views.map((view, index) => {
      const button = el("button", { type: "button", class: "small", "aria-pressed": "false", text: `View ${index + 1}`,
        title: `Camera ${view.camera}` });
      button.addEventListener("click", () => showView(index));
      return button;
    });
    $("#clip-views").replaceChildren(...viewButtons);
  }
  function showView(index) {
    const view = clipState.clip.views[index], time = clipVideo.currentTime;
    viewButtons.forEach((button, i) => button.setAttribute("aria-pressed", String(i === index)));
    if (clipVideo.getAttribute("src") === view.video) return;
    clipVideo.poster = view.poster;
    clipVideo.addEventListener("loadedmetadata", () => { clipVideo.currentTime = time; }, { once: true });
    setSource(clipVideo, view.video);
    if (clipVideo.userPaused || !clipVideo.wanted) clipVideo.load();
  }

  function showClip(clip) {
    pauseVideos();
    if (clipState.clip?.query !== clip.query) listPeople(clip.query);
    clipState.clip = clip;
    queryButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.query === clip.query)));
    peopleButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.clip === clip)));
    $("#clip-title").textContent = clip.person;
    clipSelectionCue.replaceChildren(el("span", { class: "swatch" }), el("q", { text: clip.query }));
    const intervalCount = `${clip.intervals.length} interval${clip.intervals.length === 1 ? "" : "s"}`;
    $("#clip-answer").replaceChildren(el("dl", {},
      el("dt", {}, el("span", { class: "swatch" }), "Selected"), el("dd", { text: clip.categories.join(", ") }),
      el("dt", {}, "When"), el("dd", { text: intervalCount })));
    listViews(clip);
    viewButtons[0].setAttribute("aria-pressed", "true");
    clipVideo.poster = clip.views[0].poster;
    clipVideo.userPaused = reduced;
    setSource(clipVideo, clip.views[0].video);
    readout.textContent = reduced ? "Press Play" : "";
    playhead.style.left = place(clip, clip.first);
    timeline.setAttribute("aria-valuemin", String(clip.first));
    timeline.setAttribute("aria-valuemax", String(clip.end - 1));
    timeline.setAttribute("aria-valuenow", String(clip.first));
    timeline.setAttribute("aria-valuetext", `Frame ${clip.first}`);
    timeline.querySelectorAll(".interval").forEach((node) => node.remove());
    const length = clip.end - clip.first;
    for (const [a, b] of clip.intervals) {
      timeline.insertBefore(el("div", { class: "interval",
        style: `left:${(100 * (a - clip.first)) / length}%;width:${(100 * (b + 1 - a)) / length}%` }), playhead);
    }
    updatePlayState();
  }

  function updatePlayState() {
    playButton.textContent = clipVideo.paused || clipVideo.userPaused ? "Play" : "Pause";
  }
  for (const type of ["play", "pause"]) clipVideo.addEventListener(type, updatePlayState);

  function togglePlay() {
    clipVideo.userPaused = !clipVideo.paused;
    if (clipVideo.userPaused) clipVideo.pause();
    else if (clipVideo.wanted && !document.hidden) clipVideo.play().catch(() => {});
    else revealResult(clipStage, true);
    updatePlayState();
  }
  playButton.addEventListener("click", togglePlay);
  clipVideo.addEventListener("click", togglePlay);

  // The playhead and readout follow the clip only while it shows and only when its frame changes.
  let shownFrame = null, followRequest = null;
  const videoFrames = typeof clipVideo.requestVideoFrameCallback === "function";
  function follow() {
    const clip = clipState.clip;
    if (!clip || !clipVideo.wanted || clipVideo.readyState < 2) return;
    const current = frameNow(clip);
    if (shownFrame === `${clip.id}:${current}`) return;
    shownFrame = `${clip.id}:${current}`;
    const live = clip.intervals.some(([a, b]) => a <= current && current <= b);
    playhead.style.left = place(clip, current);
    readout.replaceChildren(`frame ${current}`, live ? el("span", { class: "live", text: " · selected" }) : "");
    timeline.setAttribute("aria-valuenow", String(current));
    timeline.setAttribute("aria-valuetext", `Frame ${current}${live ? ", selected" : ""}`);
  }
  function queueFollow() {
    if (followRequest !== null || clipVideo.paused || !clipVideo.wanted || document.hidden) return;
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
  function seekFrame(frame) {
    clipVideo.userPaused = true;
    clipVideo.pause();
    seekClip(seconds(clipState.clip, frame));
  }
  let scrubPointer = null, scrubRAF = null, scrubX = 0;
  function scrub() {
    scrubRAF = null;
    const clip = clipState.clip, box = timeline.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (scrubX - box.left) / box.width));
    seekFrame(Math.min(clip.end - 1, clip.first + Math.floor(fraction * (clip.end - clip.first))));
  }
  timeline.addEventListener("pointerdown", (event) => {
    scrubPointer = event.pointerId;
    timeline.setPointerCapture(event.pointerId);
    scrubX = event.clientX;
    scrub();
  });
  timeline.addEventListener("pointermove", (event) => {
    if (event.pointerId !== scrubPointer) return;
    scrubX = event.clientX;
    if (scrubRAF === null) scrubRAF = requestAnimationFrame(scrub);
  });
  const endScrub = (event) => {
    if (event.pointerId !== scrubPointer) return;
    scrubPointer = null;
    if (scrubRAF !== null) { cancelAnimationFrame(scrubRAF); scrub(); }
  };
  timeline.addEventListener("pointerup", endScrub);
  timeline.addEventListener("pointercancel", endScrub);
  timeline.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (step || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const clip = clipState.clip;
      seekFrame(event.key === "Home" ? clip.first : event.key === "End" ? clip.end - 1 : frameNow(clip) + step);
    }
  });
  showClip(D.clips4d[0]);

  // The opening examples lead directly to the saved answer; the 4D clip plays when visible.
  for (const button of document.querySelectorAll(".hook-try")) {
    button.addEventListener("click", () => {
      if (button.dataset.subject) {
        const index = D.viewer3d.findIndex((item) => item.id === button.dataset.subject);
        if (index < 0) return;
        if (index === ex.index && explorer.item && !explorer.loading) {
          choose(explorer.item.prompts.find((prompt) => prompt.id === button.dataset.prompt) || null, button.dataset.prompt);
        } else {
          showAvatar(index, { promptId: button.dataset.prompt });
        }
        revealResult($("#viewer .viewer-stage"), true);
      } else {
        const clip = D.clips4d.find((item) => item.id === button.dataset.clip);
        if (!clip) return;
        showClip(clip);
        revealResult(clipStage, true);
      }
    });
  }

  /* ------------------------------------------------------------ teaser */
  // The teaser plays muted from the start, pauses offscreen and resumes on return unless the visitor paused it.
  const hero = $("#hero");
  hero.poster = D.hero.poster;
  hero.userPaused = reduced;
  playWhileVisible($("#teaser"), hero, true);
  hero.src = D.hero.full;

  /* ------------------------------------------------------------ comparison */
  const comparison = $("#comparison");
  playWhileVisible($("#compare-methods"), comparison);
  const compareTabs = D.comparisons.map((item) => {
    const tab = el("button", { class: "chip", type: "button", role: "tab", title: item.query,
      text: `${item.task.startsWith("4D") ? "4D" : "3D"} · ${item.subtype}` });
    tab.addEventListener("click", () => showComparison(item, tab));
    $("#compare-tabs").append(tab);
    return tab;
  });
  function showComparison(item, tab) {
    compareTabs.forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    comparison.poster = item.poster;
    setSource(comparison, item.video);
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
    spotlightBox.replaceChildren(svg("svg", { viewBox: "0 0 100 100", preserveAspectRatio: "none", "aria-hidden": "true" },
      svg("mask", { id: "spotlight-holes" }, rect([0, 0, 100, 100], { rx: 0, fill: "white" }),
        ...boxes.map((box) => rect(box, { fill: "black" }))),
      rect([0, 0, 100, 100], { rx: 0, class: "dim", mask: "url(#spotlight-holes)" }),
      ...boxes.map((box) => rect(box, { class: "ring", "vector-effect": "non-scaling-stroke" }))));
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
