/* HumanSkill-4D project page. Data: static/data.js; avatars: static/viewer.js. */
(() => {
  "use strict";
  const D = window.HS4D;
  const $ = (selector) => document.querySelector(selector);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const compact = window.matchMedia("(max-width: 860px), (pointer: coarse)");
  const stages = [];
  const videos = [...document.querySelectorAll("video")];
  const autoResumeVideos = new Set();
  // One video at a time; the most visible player gets autoplay.
  function pauseVideos(except) {
    for (const video of videos)
      if (video !== except) {
        if (!autoResumeVideos.has(video)) video.userPaused = true;
        video.pause();
      }
  }
  function resumeVisibleVideo() {
    if (document.hidden) return;
    let video = null,
      largest = 0;
    for (const candidate of autoResumeVideos)
      if (candidate.wanted && !candidate.userPaused) {
        const box = candidate.getBoundingClientRect();
        const area =
          Math.max(0, Math.min(box.bottom, innerHeight) - Math.max(box.top, 0)) *
          Math.max(0, Math.min(box.right, innerWidth) - Math.max(box.left, 0));
        if (area > largest) {
          video = candidate;
          largest = area;
        }
      }
    if (video?.paused) video.play().catch(noteBlocked);
  }
  let playbackRequest = null;
  function schedulePlayback() {
    if (playbackRequest !== null) return;
    playbackRequest = requestAnimationFrame(() => {
      playbackRequest = null;
      resumeVisibleVideo();
    });
  }
  document.addEventListener("scroll", schedulePlayback, { passive: true });
  window.addEventListener("resize", schedulePlayback);
  // Safari (Never Auto-Play, Low Power Mode) can refuse muted autoplay;
  // start playback on the first tap or key press instead.
  let autoplayBlocked = false;
  function noteBlocked(error) {
    if (error?.name === "NotAllowedError") autoplayBlocked = true;
  }
  function resumeBlocked(event) {
    if (!autoplayBlocked || event.target.closest?.("#overview-play, #clip-play, video")) return;
    autoplayBlocked = false;
    resumeVisibleVideo();
  }
  for (const type of ["pointerdown", "pointerup", "touchend", "keydown"])
    document.addEventListener(type, resumeBlocked, true);
  for (const video of videos) {
    video.userPaused = true;
    video.addEventListener("play", () => {
      video.userPaused = false;
      pauseVideos(video);
      for (const stage of stages) stage.update();
    });
    video.addEventListener("pause", () => {
      for (const stage of stages) stage.update();
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      for (const video of videos) {
        if (!autoResumeVideos.has(video)) video.userPaused = true;
        video.pause();
      }
    } else {
      resumeVisibleVideo();
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

  /* Run `on` while `target` is visible and `off` when it leaves. */
  function whileVisible(target, on, off, threshold = 0.15) {
    // A callback can carry several entries; the last one is current.
    new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        return entry.isIntersecting && entry.intersectionRatio >= threshold ? on() : off();
      },
      { threshold },
    ).observe(target);
  }

  // preload="none" loads only after play(), so play first and seek on metadata.
  function setPoster(video, src) {
    video.dataset.poster = src;
    if (video.wanted) video.poster = src;
  }

  function setSource(video, src) {
    if (video.getAttribute("src") !== src) {
      video.pause();
      video.src = src;
    }
    resumeVisibleVideo();
  }

  function playWhileVisible(target, video) {
    autoResumeVideos.add(video);
    whileVisible(
      target,
      () => {
        video.wanted = true;
        if (video.dataset.poster) video.poster = video.dataset.poster;
        resumeVisibleVideo();
      },
      () => {
        video.wanted = false;
        video.pause();
        resumeVisibleVideo();
      },
      0,
    );
  }

  /* Authors */
  // Hovering or tapping an affiliation highlights its authors.
  for (const button of document.querySelectorAll(".affiliation")) {
    const lit = `lit-${button.dataset.aff}`;
    const on = () => $("#authors").classList.add(lit),
      off = () => $("#authors").classList.remove(lit);
    button.addEventListener("pointerenter", on);
    button.addEventListener("pointerleave", off);
    button.addEventListener("focus", on);
    button.addEventListener("blur", off);
  }

  /* 3D stages */
  // A query recolours only its selected rows: context fades to white,
  // the selection takes the Where colour.
  const buffers = new Map();
  const fetchBuffer = (file) => {
    if (!buffers.has(file))
      buffers.set(
        file,
        fetch(file, { priority: "high" })
          .then((r) => {
            if (!r.ok) throw new Error(`Avatar request failed (${r.status})`);
            return r.arrayBuffer();
          })
          .catch((error) => {
            buffers.delete(file);
            throw error;
          }),
      );
    return buffers.get(file);
  };
  function loadSelections(item) {
    if (!item.selectionRequest)
      item.selectionRequest = fetch(item.selections, { priority: "high" })
        .then((response) => {
          if (!response.ok) throw new Error(`Selection request failed (${response.status})`);
          return response.json();
        })
        .then((bits) => {
          for (const prompt of item.prompts) {
            if (typeof bits[prompt.id] !== "string") throw new Error("Saved selection is missing");
            prompt.bits = bits[prompt.id];
          }
        })
        .catch((error) => {
          delete item.selectionRequest;
          throw error;
        });
    return item.selectionRequest;
  }

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
    let sum = 0,
      n = 0;
    for (let i = 0; i < selected.length; i++)
      if (selected[i]) {
        sum += lum(i);
        n++;
      }
    const mean = n ? sum / n : 0;
    for (let i = 0; i < selected.length; i++) {
      if (selected[i]) {
        const k = 1 + 1.15 * (lum(i) - mean);
        out.set(
          [216 * k, 27 * k, 96 * k].map((v) => Math.max(0, Math.min(255, v))),
          4 * i,
        );
      } else {
        const gray = 255 * lum(i);
        for (let c = 0; c < 3; c++) out[4 * i + c] = 0.94 * (0.6 * base[4 * i + c] + 0.4 * gray) + 0.06 * 255;
      }
    }
    return out;
  }

  function makeStage(canvas) {
    const stage = {
      viewer: null,
      item: null,
      shown: null,
      visible: false,
      loading: false,
      request: 0,
    };
    stages.push(stage);
    canvas.addEventListener("viewerinteraction", () => pauseVideos(canvas));
    stage.update = () => {
      if (stage.viewer)
        stage.viewer.setActive(
          stage.visible &&
            !!stage.item &&
            !stage.loading &&
            !document.hidden &&
            videos.every((video) => video.paused),
        );
    };
    stage.load = async (item) => {
      const request = ++stage.request;
      stage.item = item;
      stage.loading = true;
      stage.update();
      try {
        const [buffer] = await Promise.all([fetchBuffer(item.file), loadSelections(item)]);
        if (stage.request !== request) return false;
        if (buffer.byteLength !== item.count * 40)
          throw new Error("Avatar file is incomplete or has the wrong size");
        if (!stage.viewer) stage.viewer = new GaussianViewer(canvas);
        stage.viewer.load(buffer, item.camera);
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
      const item = stage.item,
        key = prompt ? prompt.id : "";
      return (item.painted[key] =
        item.painted[key] || paint(stage.viewer.base, prompt && mask(prompt, item.count)));
    };
    stage.show = (prompt) => {
      if (!stage.item || stage.loading) return;
      const target = stage.colours(prompt);
      if (stage.shown === target) return;
      stage.viewer.setColors((stage.shown = target));
    };
    return stage;
  }

  /* 3D explorer */
  const explorer = makeStage($("#viewer-canvas"));
  const ex = { index: 2, promptId: "sunscreen" };
  const promptButtons = [],
    subjectButtons = [];
  $("#subject-label").append(
    el("span", { class: "subject-hint", text: `Swipe to browse all ${D.viewer3d.length} avatars.` }),
  );
  const selectionCue = el("p", { class: "viewer-selection", "aria-hidden": "true" });
  $("#viewer .viewer-head").after(selectionCue);

  // On mobile, keep the chosen query and its avatar in view.
  function revealResult(target, force = false) {
    if (!force && !compact.matches) return;
    const box = target.getBoundingClientRect();
    if (box.top < 8 || box.bottom > innerHeight - 8) {
      target.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
    }
  }
  whileVisible(
    $("#viewer-viewport"),
    () => {
      explorer.visible = true;
      explorer.update();
    },
    () => {
      explorer.visible = false;
      explorer.update();
    },
  );

  D.viewer3d.forEach((item, i) => {
    const button = el(
      "button",
      {
        class: "subject",
        type: "button",
        "aria-pressed": "false",
        title: item.title,
        "aria-label": item.title,
      },
      el("span", {
        class: "subject-preview",
        "aria-hidden": "true",
        style: `background-image:url(${D.sprite});background-position:${(i % 3) * 50}% ${Math.floor(i / 3) * 50}%`,
      }),
      el("span", { class: "subject-label", text: item.title.replace("ZJU-MoCap ", "") }),
    );
    button.addEventListener("click", () => {
      if (i !== ex.index || !explorer.item) showAvatar(i);
      revealResult($("#viewer .viewer-stage"));
    });
    subjectButtons.push(button);
    $("#viewer-subjects").append(button);
  });

  // Group layout from data.js: "row" or "list".
  function listPrompts(item) {
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
        const button = el("button", {
          class: "prompt",
          type: "button",
          "aria-pressed": "false",
          "data-prompt": prompt.id,
          text: prompt.query,
        });
        button.prompt = prompt;
        button.addEventListener("click", () => {
          choose(prompt);
          revealResult($("#viewer .viewer-stage"));
        });
        promptButtons.push(button);
        return button;
      });
      const layout = (D.promptGroups || {})[group] || "list";
      list.append(
        el("p", { class: "prompt-group", text: group }),
        ...(layout === "row" ? [el("div", { class: "prompt-row" }, ...buttons)] : buttons),
      );
    }
  }

  function choose(prompt, requestedId = prompt?.id) {
    ex.promptId = requestedId;
    if (explorer.viewer) explorer.show(prompt);
    for (const button of promptButtons) {
      button.setAttribute("aria-pressed", String(button.prompt === prompt));
    }
    $("#viewer-message").textContent = prompt
      ? ""
      : "This query is not available for this avatar. Choose another example.";
    selectionCue.replaceChildren(
      ...(prompt
        ? [el("span", { class: "swatch" }), el("q", { text: prompt.query })]
        : ["Saved answer unavailable for this avatar. Choose another query."]),
    );
  }

  async function showAvatar(index, selection = null) {
    const item = D.viewer3d[index],
      keep = selection ? selection.promptId : ex.promptId;
    pauseVideos();
    ex.index = index;
    ex.promptId = keep;
    $("#viewer-title").textContent = item.title;
    subjectButtons.forEach((button, i) => button.setAttribute("aria-pressed", String(i === index)));
    $("#viewer-status").hidden = false;
    $("#viewer-status").replaceChildren(
      el("span", {
        class: "viewer-preview",
        "aria-hidden": "true",
        style: `background-image:url(${D.sprite});background-position:${(index % 3) * 50}% ${Math.floor(index / 3) * 50}%`,
      }),
      el("span", { text: `Loading ${item.title}…` }),
    );
    selectionCue.textContent = `Loading ${item.title}…`;
    $("#viewer").setAttribute("aria-busy", "true");
    for (const button of promptButtons) button.disabled = true;
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
    listPrompts(item);
    choose(item.prompts.find((p) => p.id === keep) || null, keep);
  }

  showAvatar(ex.index);

  /* 4D explorer */
  const clipVideo = $("#clip");
  const timeline = $("#timeline");
  const playhead = $("#playhead");
  const playButton = $("#clip-play");
  const clipStage = $("#clip-viewer .viewer-stage");
  const clipSelectionCue = el("p", { class: "viewer-selection", "aria-hidden": "true" });
  $("#clip-viewer .viewer-head").after(clipSelectionCue);
  const clipState = { clip: null, seekTime: 0 };
  const overviewVideo = $("#overview-video"),
    overviewStage = $("#overview-stage");
  const overviewPlay = $("#overview-play");
  let clipMode = "all",
    overviewSeek = 0;
  // Autoplay like the teaser, also under reduced motion.
  overviewVideo.userPaused = false;
  playWhileVisible(overviewStage, overviewVideo);
  function loadOverview() {
    const view = D.overview4d[compact.matches ? "compact" : "wide"];
    overviewStage.style.setProperty("--overview-columns", view.columns);
    overviewStage.style.setProperty("--overview-rows", view.rows);
    overviewStage.style.setProperty(
      "--overview-caption",
      `${((view.tile_height - view.tile_width) / view.tile_height) * 100}%`,
    );
    overviewStage.style.aspectRatio = `${view.columns * view.tile_width} / ${view.rows * view.tile_height}`;
    if (overviewVideo.getAttribute("src") === view.video) return;
    overviewSeek = overviewVideo.readyState >= 1 ? overviewVideo.currentTime : overviewSeek;
    const time = overviewSeek;
    setPoster(overviewVideo, view.poster);
    overviewVideo.addEventListener(
      "loadedmetadata",
      () => {
        if (overviewVideo.getAttribute("src") === view.video) overviewVideo.currentTime = time;
      },
      { once: true },
    );
    setSource(overviewVideo, view.video);
    if (overviewVideo.userPaused && overviewVideo.wanted) overviewVideo.load();
  }
  function setClipMode(mode) {
    if (clipMode === mode) return;
    clipMode = mode;
    pauseVideos();
    clipVideo.wanted = overviewVideo.wanted = false;
    $("#clip-viewer").hidden = mode !== "single";
    $("#clip-overview").hidden = mode !== "all";
    $("#clip-mode-all").setAttribute("aria-pressed", String(mode === "all"));
    $("#clip-mode-single").setAttribute("aria-pressed", String(mode === "single"));
    if (mode === "all") loadOverview();
    // Do not wait for the next observer callback.
    const video = mode === "all" ? overviewVideo : clipVideo;
    const box = (mode === "all" ? overviewStage : $("#clip-stage")).getBoundingClientRect();
    const visible =
      Math.max(0, Math.min(box.bottom, innerHeight) - Math.max(box.top, 0)) *
      Math.max(0, Math.min(box.right, innerWidth) - Math.max(box.left, 0));
    video.wanted = visible > 0;
    if (video.wanted && !video.userPaused && !document.hidden) video.play().catch(noteBlocked);
  }
  $("#clip-mode-all").addEventListener("click", () => setClipMode("all"));
  $("#clip-mode-single").addEventListener("click", () => setClipMode("single"));
  compact.addEventListener("change", () => {
    if (clipMode === "all") loadOverview();
  });
  function describeOverview(clip) {
    $("#overview-query-label").textContent = `Full query · ${clip.person}`;
    $("#overview-query").textContent = clip.query;
  }
  const overviewCards = D.overview4d.items.map((item) => {
    const clip = D.clips4d.find((candidate) => candidate.id === item.id);
    const button = el(
      "button",
      {
        type: "button",
        class: "overview-person",
        title: clip.query,
        "aria-label": `${clip.person}: ${clip.query} Open detailed result.`,
      },
      el("span", { class: "overview-person-name", text: clip.person }),
      el(
        "span",
        { class: "overview-caption" },
        el("span", { class: "overview-where", text: clip.categories.join(" + ") }),
        el("span", { class: "overview-when", text: item.condition }),
      ),
    );
    button.clip = clip;
    const describe = () => describeOverview(clip);
    button.addEventListener("pointerenter", describe);
    button.addEventListener("focus", describe);
    button.addEventListener("click", () => {
      showClip(clip);
      $("#clip-back").focus({ preventScroll: true });
      revealResult(clipStage, true);
    });
    return button;
  });
  $("#overview-people").replaceChildren(...overviewCards);
  describeOverview(overviewCards[0].clip);
  $("#clip-back").addEventListener("click", () => {
    setClipMode("all");
    overviewCards
      .find((button) => button.clip.person === clipState.clip.person)
      ?.focus({ preventScroll: true });
    revealResult($("#clip-overview"), true);
  });
  function setPlaybackState(button, paused, suffix = "") {
    button.classList.toggle("is-playing", !paused);
    button.querySelector(".play-label").textContent = `${paused ? "Play" : "Pause"}${suffix}`;
  }
  function updateOverviewPlay() {
    setPlaybackState(overviewPlay, overviewVideo.paused, " all");
  }
  for (const type of ["play", "pause"]) overviewVideo.addEventListener(type, updateOverviewPlay);
  overviewPlay.addEventListener("click", () => {
    overviewVideo.userPaused = !overviewVideo.paused;
    if (overviewVideo.userPaused) overviewVideo.pause();
    else if (!document.hidden) overviewVideo.play().catch(noteBlocked);
  });
  loadOverview();
  playWhileVisible($("#clip-stage"), clipVideo);

  // The first saved answer is shown first.
  const byQuery = new Map();
  for (const clip of D.clips4d) {
    if (!byQuery.has(clip.query)) byQuery.set(clip.query, []);
    byQuery.get(clip.query).push(clip);
  }
  const queryButtons = [...byQuery.keys()].map((query) => {
    const button = el("button", {
      class: "prompt",
      type: "button",
      "aria-pressed": "false",
      text: query,
    });
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
      const button = el(
        "button",
        {
          class: "subject",
          type: "button",
          "aria-pressed": "false",
          title: `${clip.person}, clip ${clip.clip}`,
          "aria-label": `${clip.person}, clip ${clip.clip}`,
        },
        el("img", { class: "subject-preview", src: clip.thumb, alt: "", loading: "lazy" }),
        el("span", { class: "subject-label", text: clip.person.split(" ").pop() }),
      );
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
  const frameNow = (clip) =>
    clip.first + Math.min(clip.end - clip.first - 1, Math.floor(clipVideo.currentTime * clip.fps + 1e-3));
  const place = (clip, frame) => `${(100 * (frame - clip.first + 0.5)) / (clip.end - clip.first)}%`;

  // Switching views keeps the current time.
  let viewButtons = [];
  function listViews(clip) {
    viewButtons = clip.views.map((view, index) => {
      const button = el("button", {
        type: "button",
        "aria-pressed": "false",
        text: view.label,
      });
      button.addEventListener("click", () => showView(index));
      return button;
    });
    $("#clip-views").replaceChildren(...viewButtons);
  }
  function showView(index) {
    const clip = clipState.clip,
      view = clip.views[index];
    const time = clipVideo.readyState < 1 ? clipState.seekTime : clipVideo.currentTime;
    viewButtons.forEach((button, i) => button.setAttribute("aria-pressed", String(i === index)));
    if (clipVideo.getAttribute("src") === view.video) return;
    setPoster(clipVideo, view.poster);
    clipState.seekTime = time;
    clipVideo.addEventListener(
      "loadedmetadata",
      () => {
        if (clipState.clip === clip && clipVideo.getAttribute("src") === view.video)
          clipVideo.currentTime = time;
      },
      { once: true },
    );
    setSource(clipVideo, view.video);
    if (clipVideo.userPaused || !clipVideo.wanted) clipVideo.load();
  }

  function showClip(clip, open = true) {
    pauseVideos();
    if (clipState.clip?.query !== clip.query) listPeople(clip.query);
    clipState.clip = clip;
    queryButtons.forEach((button) =>
      button.setAttribute("aria-pressed", String(button.query === clip.query)),
    );
    peopleButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.clip === clip)));
    $("#clip-title").textContent = clip.person;
    clipSelectionCue.replaceChildren(el("span", { class: "swatch" }), el("q", { text: clip.query }));
    listViews(clip);
    viewButtons[0].setAttribute("aria-pressed", "true");
    setPoster(clipVideo, clip.views[0].poster);
    clipVideo.userPaused = false;
    // Start just before the first match.
    const source = clip.views[0].video;
    const start = Math.max(0, seconds(clip, clip.intervals[0][0]) - 0.4);
    clipState.seekTime = start;
    const begin = () => {
      if (clipState.clip === clip && clipVideo.getAttribute("src") === source) clipVideo.currentTime = start;
    };
    if (clipVideo.getAttribute("src") !== source || clipVideo.readyState < 1) {
      clipVideo.addEventListener("loadedmetadata", begin, { once: true });
    } else begin();
    setSource(clipVideo, clip.views[0].video);
    playhead.style.left = place(clip, clip.first);
    timeline.setAttribute("aria-valuemin", String(clip.first));
    timeline.setAttribute("aria-valuemax", String(clip.end - 1));
    timeline.setAttribute("aria-valuenow", String(clip.first));
    timeline.setAttribute("aria-valuetext", `Frame ${clip.first}`);
    timeline.querySelectorAll(".interval").forEach((node) => node.remove());
    const length = clip.end - clip.first;
    for (const [a, b] of clip.intervals) {
      timeline.insertBefore(
        el("div", {
          class: "interval",
          style: `left:${(100 * (a - clip.first)) / length}%;width:${(100 * (b + 1 - a)) / length}%`,
        }),
        playhead,
      );
    }
    if (open) setClipMode("single");
    updatePlayState();
  }

  function updatePlayState() {
    setPlaybackState(playButton, clipVideo.paused || clipVideo.userPaused);
  }
  for (const type of ["play", "pause"]) clipVideo.addEventListener(type, updatePlayState);

  function togglePlay() {
    clipVideo.userPaused = !clipVideo.paused;
    if (clipVideo.userPaused) clipVideo.pause();
    else if (clipVideo.wanted && !document.hidden) clipVideo.play().catch(noteBlocked);
    else revealResult(clipStage, true);
    updatePlayState();
  }
  playButton.addEventListener("click", togglePlay);
  clipVideo.addEventListener("click", togglePlay);

  // Update the playhead only when the frame changes.
  let shownFrame = null,
    followRequest = null;
  const videoFrames = typeof clipVideo.requestVideoFrameCallback === "function";
  function follow() {
    const clip = clipState.clip;
    if (!clip || !clipVideo.wanted || clipVideo.readyState < 2) return;
    const current = frameNow(clip);
    if (shownFrame === `${clip.id}:${current}`) return;
    shownFrame = `${clip.id}:${current}`;
    const live = clip.intervals.some(([a, b]) => a <= current && current <= b);
    playhead.style.left = place(clip, current);
    timeline.setAttribute("aria-valuenow", String(current));
    timeline.setAttribute("aria-valuetext", `Frame ${current}${live ? ", selected" : ""}`);
  }
  function queueFollow() {
    if (followRequest !== null || clipVideo.paused || !clipVideo.wanted || document.hidden) return;
    const callback = () => {
      followRequest = null;
      follow();
      queueFollow();
    };
    followRequest = videoFrames
      ? clipVideo.requestVideoFrameCallback(callback)
      : requestAnimationFrame(callback);
  }
  clipVideo.addEventListener("play", queueFollow);
  clipVideo.addEventListener("pause", () => {
    if (followRequest !== null) {
      if (videoFrames) clipVideo.cancelVideoFrameCallback(followRequest);
      else cancelAnimationFrame(followRequest);
      followRequest = null;
    }
    follow();
  });
  for (const event of ["loadeddata", "seeked", "timeupdate"]) clipVideo.addEventListener(event, follow);

  function seekClip(time) {
    const clip = clipState.clip;
    const seek = () => {
      if (clipState.clip === clip)
        clipVideo.currentTime = Math.max(0, Math.min(time, (clip.end - clip.first - 1) / clip.fps));
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
  let scrubPointer = null,
    scrubRAF = null,
    scrubX = 0;
  function scrub() {
    scrubRAF = null;
    const clip = clipState.clip,
      box = timeline.getBoundingClientRect();
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
    if (scrubRAF !== null) {
      cancelAnimationFrame(scrubRAF);
      scrub();
    }
  };
  timeline.addEventListener("pointerup", endScrub);
  timeline.addEventListener("pointercancel", endScrub);
  timeline.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (step || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const clip = clipState.clip;
      seekFrame(
        event.key === "Home" ? clip.first : event.key === "End" ? clip.end - 1 : frameNow(clip) + step,
      );
    }
  });
  showClip(D.clips4d[0], false);

  for (const button of document.querySelectorAll(".hook-try")) {
    button.addEventListener("click", () => {
      if (button.dataset.subject) {
        const index = D.viewer3d.findIndex((item) => item.id === button.dataset.subject);
        if (index < 0) return;
        if (index === ex.index && explorer.item && !explorer.loading) {
          choose(
            explorer.item.prompts.find((prompt) => prompt.id === button.dataset.prompt) || null,
            button.dataset.prompt,
          );
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

  /* Teaser */
  // Muted autoplay; pause offscreen and resume unless the visitor paused.
  const hero = $("#hero");
  setPoster(hero, D.hero.poster);
  hero.userPaused = false;
  playWhileVisible(hero, hero);
  hero.src = D.hero.full;

  /* Comparison */
  const comparison = $("#comparison");
  comparison.userPaused = false;
  playWhileVisible(comparison, comparison);
  const compareTabs = D.comparisons.map((item) => {
    const tab = el("button", {
      class: "chip",
      type: "button",
      role: "tab",
      title: item.query,
      text: `${item.task.startsWith("4D") ? "4D" : "3D"} · ${item.subtype}`,
    });
    tab.addEventListener("click", () => showComparison(item, tab));
    $("#compare-tabs").append(tab);
    return tab;
  });
  function showComparison(item, tab) {
    compareTabs.forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    $("#comparison-full").href = item.video;
    comparison.setAttribute("aria-label", `Method comparison: ${item.query}`);
    setPoster(comparison, item.poster);
    setSource(comparison, item.video);
  }
  showComparison(D.comparisons[0], compareTabs[0]);

  /* How it works */
  // A step highlights its panels (data-box: left, top, width, height in %).
  // Steps advance while the section is visible; hover, focus or any control
  // hands over to the visitor.
  const pipeline = $("#pipeline");
  const pipelineObserver = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    pipeline.src = D.pipeline;
    pipelineObserver.disconnect();
  });
  pipelineObserver.observe(pipeline);
  const steps = [...document.querySelectorAll(".step")];
  const spotlightBox = $("#spotlight");
  const stepCard = $("#step-card");
  const stepPrev = $("#step-prev");
  const stepNext = $("#step-next");
  const methodOverview = $("#method-overview");
  const stepSeconds = 6;
  let stepIndex = -1;
  let stepAuto = true,
    stepTimer = null,
    methodShown = false,
    methodHeld = false;
  function svg(tag, attrs, ...children) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    node.append(...children);
    return node;
  }
  function scheduleStep() {
    clearTimeout(stepTimer);
    if (stepAuto && methodShown && !methodHeld && !document.hidden) {
      stepTimer = setTimeout(() => {
        spotlight(stepIndex === steps.length - 1 ? -1 : stepIndex + 1, "from-right");
        scheduleStep();
      }, stepSeconds * 1000);
    }
  }
  function takeControl(index) {
    stepAuto = false;
    clearTimeout(stepTimer);
    spotlight(index);
  }
  function cardBody(index, direction = "") {
    const step = steps[index];
    if (!step) return el("p", { class: `step-cue ${direction}`, text: "Full diagram" });
    const phase = step.parentElement.classList.contains("online") ? "online" : "offline";
    return el(
      "div",
      { class: `step-body ${direction} ${phase}` },
      el("p", { class: "step-phase", text: step.dataset.phase }),
      el(
        "p",
        { class: "step-line" },
        el("span", { class: "step-number", text: String(index + 1) }),
        el(
          "span",
          {},
          ...[...step.querySelector(".step-text").childNodes].map((node) => node.cloneNode(true)),
        ),
      ),
    );
  }
  // Reserve the tallest card to avoid layout shift; mute the live region while measuring.
  let fittedWidth = 0;
  function fitStepCard() {
    fittedWidth = stepCard.clientWidth;
    stepCard.setAttribute("aria-live", "off");
    stepCard.style.minHeight = "";
    let tallest = 0;
    for (let i = -1; i < steps.length; i++) {
      stepCard.replaceChildren(cardBody(i));
      tallest = Math.max(tallest, stepCard.offsetHeight);
    }
    stepCard.replaceChildren(cardBody(stepIndex));
    stepCard.style.minHeight = `${tallest}px`;
    stepCard.setAttribute("aria-live", "polite");
  }
  function spotlight(index, direction = index > stepIndex ? "from-right" : "from-left") {
    stepIndex = index;
    const step = steps[index];
    steps.forEach((s, i) => {
      s.setAttribute("aria-pressed", String(i === index));
      s.parentElement.classList.toggle("reached", i <= index);
    });
    methodOverview.disabled = !step;
    stepPrev.disabled = index < 0;
    stepNext.disabled = index === steps.length - 1;
    spotlightBox.hidden = !step;
    stepCard.replaceChildren(cardBody(index, direction));
    if (!step) return spotlightBox.replaceChildren();
    const boxes = step.dataset.box.split(" ").map((box) => box.split(",").map(Number));
    const rect = ([x, y, width, height], attrs) => svg("rect", { x, y, width, height, rx: 0.6, ...attrs });
    spotlightBox.replaceChildren(
      svg(
        "svg",
        { viewBox: "0 0 100 100", preserveAspectRatio: "none", "aria-hidden": "true" },
        svg(
          "mask",
          { id: "spotlight-holes" },
          rect([0, 0, 100, 100], { rx: 0, fill: "white" }),
          ...boxes.map((box) => rect(box, { fill: "black" })),
        ),
        rect([0, 0, 100, 100], { rx: 0, class: "dim", mask: "url(#spotlight-holes)" }),
        ...boxes.map((box) => rect(box, { class: "ring", "vector-effect": "non-scaling-stroke" })),
      ),
    );
  }
  steps.forEach((step, i) => {
    step.setAttribute("aria-controls", "pipeline-card");
    step.addEventListener("click", () => takeControl(i));
  });
  stepPrev.addEventListener("click", () => takeControl(stepIndex - 1));
  stepNext.addEventListener("click", () => takeControl(stepIndex + 1));
  const walk = $("#method .walk");
  walk.addEventListener("keydown", (event) => {
    const move = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (move && stepIndex + move >= -1 && stepIndex + move < steps.length) {
      event.preventDefault();
      takeControl(stepIndex + move);
    }
  });
  methodOverview.addEventListener("click", () => takeControl(-1));
  for (const [type, held] of [
    ["mouseenter", true],
    ["mouseleave", false],
    ["focusin", true],
    ["focusout", false],
  ]) {
    walk.addEventListener(type, () => {
      methodHeld = held;
      scheduleStep();
    });
  }
  whileVisible(
    walk,
    () => {
      methodShown = true;
      scheduleStep();
    },
    () => {
      methodShown = false;
      scheduleStep();
    },
  );
  document.addEventListener("visibilitychange", scheduleStep);
  spotlight(0);
  fitStepCard();
  document.fonts.ready.then(fitStepCard);
  let fitFrame = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => stepCard.clientWidth !== fittedWidth && fitStepCard());
  });
})();
