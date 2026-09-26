/* Motion Director review page. Renders only from the embedded JSON; every
   string from the project (layer names, feedback) is inserted as text, never
   as HTML. */
(function () {
  "use strict";

  var data = JSON.parse(document.getElementById("review-data").textContent);
  var SVG = "http://www.w3.org/2000/svg";
  var root = document.querySelector("main");
  var tooltip = el("div", { class: "tooltip", role: "status", "aria-live": "polite" });
  document.body.appendChild(tooltip);

  var SHAPES = {
    linear: "Linear: constant speed",
    "ease-out": "Ease out",
    "ease-in": "Ease in",
    "ease-in-out": "Ease in and out",
    jump: "Jump (a cut)",
    excursion: "Out and back",
    irregular: "Irregular"
  };
  var KINDS = {
    measured: "Measured in After Effects",
    rehearsed: "Measured on a rehearsal copy",
    predicted: "Predicted from keyframes, not yet measured"
  };
  var SEVERITY = { major: "Major", minor: "Minor", note: "Note" };

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    setAttrs(node, attrs);
    append(node, children);
    return node;
  }
  function svg(tag, attrs, children) {
    var node = document.createElementNS(SVG, tag);
    setAttrs(node, attrs);
    append(node, children);
    return node;
  }
  function setAttrs(node, attrs) {
    if (!attrs) return;
    Object.keys(attrs).forEach(function (k) {
      if (attrs[k] !== undefined && attrs[k] !== null) node.setAttribute(k, String(attrs[k]));
    });
  }
  function append(node, children) {
    if (children === undefined || children === null || children === false) return;
    if (Array.isArray(children)) {
      children.forEach(function (c) { append(node, c); });
      return;
    }
    node.appendChild(typeof children === "string" ? document.createTextNode(children) : children);
  }
  function ms(seconds) { return Math.round(seconds * 1000) + " ms"; }
  function secs(seconds) { return seconds.toFixed(2) + " s"; }
  function pct(f) { return Math.round(f * 100) + "%"; }

  // ---------- status icons (colour on the icon only; the label is ink) ----------
  function statusIcon(state) {
    var colour = { ready: "var(--good)", done: "var(--good)", incomplete: "var(--warning)", "not-checked": "var(--muted)", failed: "var(--critical)", major: "var(--serious)", minor: "var(--warning)", note: "var(--muted)" }[state] || "var(--muted)";
    var icon = svg("svg", { width: 16, height: 16, viewBox: "0 0 16 16", "aria-hidden": "true" });
    icon.appendChild(svg("circle", { cx: 8, cy: 8, r: 7, fill: colour }));
    var mark = { ready: "M4.5 8.2l2.3 2.3 4.7-4.9", done: "M4.5 8.2l2.3 2.3 4.7-4.9", failed: "M5.3 5.3l5.4 5.4M10.7 5.3l-5.4 5.4" }[state];
    if (mark) icon.appendChild(svg("path", { d: mark, stroke: "#fff", "stroke-width": 1.8, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" }));
    else icon.appendChild(svg("rect", { x: 7.1, y: 4, width: 1.8, height: 8, rx: 0.9, fill: state === "not-checked" || state === "note" ? "#fff" : "#0b0b0b", transform: state === "not-checked" || state === "note" ? "rotate(90 8 8)" : null }));
    return icon;
  }

  // ---------- header ----------
  var header = el("header", { class: "top" }, [
    el("div", null, [
      el("h1", null, data.title),
      el("p", { class: "sub" }, data.compName + " · " + new Date(data.generatedAt).toLocaleString())
    ]),
    el("div", null, [
      el("div", { class: "state" }, [statusIcon(data.completion.state), data.completion.label]),
      el("div", { class: "state-detail" }, data.completion.detail)
    ])
  ]);
  root.appendChild(header);

  // ---------- brief ----------
  if (data.brief) {
    var b = data.brief;
    root.appendChild(el("section", { class: "card", "aria-labelledby": "brief-h" }, [
      el("h2", { id: "brief-h" }, "The direction"),
      el("p", { class: "sub" }, "Revision " + b.revision + " · " + b.approval),
      el("div", { class: "brief-grid" }, [
        el("div", null, [
          el("div", { class: "label" }, "In your words"),
          b.feedback.length
            ? b.feedback.map(function (f) { return el("blockquote", null, [f.text, el("footer", null, "revision " + f.revision)]); })
            : el("p", { class: "note" }, "No feedback recorded.")
        ]),
        el("div", null, [
          el("div", { class: "label" }, "What we agreed it means"),
          el("p", null, b.interpretation || "Not agreed yet."),
          b.experience ? el("p", { class: "sub" }, b.experience) : null
        ]),
        el("div", null, [
          el("div", { class: "label" }, "Must not change"),
          b.keep.length ? el("ul", null, b.keep.map(function (k) { return el("li", null, k); })) : el("p", { class: "note" }, "Nothing listed.")
        ]),
        el("div", null, [
          el("div", { class: "label" }, "How we'll know it worked"),
          b.acceptance.length ? el("ul", null, b.acceptance.map(function (k) { return el("li", null, k); })) : el("p", { class: "note" }, "Nothing listed.")
        ])
      ])
    ]));
  }

  // ---------- shared time scale ----------
  // Every comparison shares one scale so they line up. It spans the motion,
  // not the whole comp: a 0.7 s reveal in a 3 s comp should fill the width.
  var start = Infinity;
  var end = -Infinity;
  var rangeStart = Infinity;
  var rangeEnd = -Infinity;
  data.comparisons.forEach(function (c) {
    rangeStart = Math.min(rangeStart, c.score.range.start);
    rangeEnd = Math.max(rangeEnd, c.score.range.end);
    c.score.movements.forEach(function (m) {
      start = Math.min(start, m.startTime);
      end = Math.max(end, m.endTime);
    });
  });
  if (!isFinite(start)) { start = isFinite(rangeStart) ? rangeStart : 0; end = isFinite(rangeEnd) ? rangeEnd : 1; }
  var pad = Math.max(0.05, (end - start) * 0.06);
  start = Math.max(isFinite(rangeStart) ? rangeStart : start - pad, start - pad);
  end = Math.min(isFinite(rangeEnd) ? rangeEnd : end + pad, end + pad);
  if (end - start < 0.2) end = start + 0.2;

  function ticks(width) {
    var span = end - start;
    var steps = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    var wanted = Math.max(2, Math.floor(width / 90));
    var step = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) { if (span / steps[i] <= wanted) { step = steps[i]; break; } }
    var out = [];
    for (var t = Math.ceil(start / step - 1e-9) * step; t <= end + 1e-9; t += step) out.push(Math.round(t * 1000) / 1000);
    return out;
  }

  // ---------- players ----------
  var players = [];
  function makePlayer(preview, label) {
    var frames = preview.frames;
    // Until it plays, show where the motion comes to rest: the first frame of
    // an entrance is often empty.
    var last = frames.length - 1;
    var img = el("img", { src: frames[last], alt: label + ": preview frame" });
    var button = el("button", { type: "button", "aria-pressed": "false" }, "Play");
    var range = el("input", { type: "range", min: 0, max: Math.max(0, last), value: last, "aria-label": label + " preview position" });
    var time = el("span", { class: "time" }, secs(preview.start + last / preview.fps) + " / " + secs(preview.start + last / preview.fps));
    var state = { playing: false, index: last, t0: 0, raf: 0 };
    frames.forEach(function (f) { var i = new Image(); i.src = f; });

    function show(index) {
      state.index = index;
      img.src = frames[index];
      range.value = String(index);
      time.textContent = secs(preview.start + index / preview.fps) + " / " + secs(preview.start + (frames.length - 1) / preview.fps);
    }
    function tick(now) {
      if (!state.playing) return;
      // Real time: the frame shown is the one due at this moment, whatever the display rate.
      var index = Math.floor(((now - state.t0) / 1000) * preview.fps) % frames.length;
      if (index !== state.index) show(index);
      state.raf = requestAnimationFrame(tick);
    }
    function play(at) {
      if (state.index === last) show(0);
      state.playing = true;
      state.t0 = (at || performance.now()) - (state.index / preview.fps) * 1000;
      button.textContent = "Pause";
      button.setAttribute("aria-pressed", "true");
      state.raf = requestAnimationFrame(tick);
    }
    function pause() {
      state.playing = false;
      cancelAnimationFrame(state.raf);
      button.textContent = "Play";
      button.setAttribute("aria-pressed", "false");
    }
    button.addEventListener("click", function () { state.playing ? pause() : play(); });
    range.addEventListener("input", function () { pause(); show(Number(range.value)); });
    var node = el("div", { class: "player" }, [
      img,
      el("div", { class: "controls" }, [button, range, time]),
      el("p", { class: "help" }, "Plays at true speed (" + preview.fps + " frames a second). Still frames can't show how motion feels; watch it play.")
    ]);
    var player = { node: node, play: play, pause: pause, show: show };
    players.push(player);
    return node;
  }

  // ---------- Motion Score ----------
  function layerOrder(score) {
    var layers = [];
    score.movements.slice().sort(function (a, b) { return a.startTime - b.startTime || a.layerId - b.layerId; }).forEach(function (m) {
      var layer = layers.find(function (l) { return l.id === m.layerId; });
      if (!layer) { layer = { id: m.layerId, name: m.layerName, props: [] }; layers.push(layer); }
      var prop = layer.props.find(function (p) { return p.name === m.propertyName; });
      if (!prop) { prop = { name: m.propertyName, moves: [] }; layer.props.push(prop); }
      prop.moves.push(m);
    });
    return layers;
  }

  function showTooltip(event, m) {
    tooltip.textContent = "";
    append(tooltip, [
      el("strong", null, (SHAPES[m.shape] || m.shape) + " · " + ms(m.duration)),
      el("div", { class: "t-sub" }, m.layerName + " › " + m.propertyName),
      el("div", { class: "t-sub" }, "Starts " + secs(m.startTime) + (m.overshoot > 0 ? " · overshoots " + pct(m.overshoot) : ""))
    ]);
    var x = event.clientX;
    var y = event.clientY;
    if (x === undefined) {
      var r = event.target.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top;
    }
    tooltip.style.left = Math.min(window.innerWidth - 296, x + 12) + "px";
    tooltip.style.top = Math.max(8, y - 64) + "px";
    tooltip.classList.add("show");
  }
  function hideTooltip() { tooltip.classList.remove("show"); }

  function renderScore(container, score, highlight) {
    container.textContent = "";
    var width = Math.max(120, container.clientWidth - (window.innerWidth <= 640 ? 96 : 150));
    var x = function (t) { return ((t - start) / (end - start)) * width; };
    var tickList = ticks(width);
    var ROW = 30;

    var axis = svg("svg", { height: 22, viewBox: "0 0 " + width + " 22", "aria-hidden": "true" });
    tickList.forEach(function (t) {
      axis.appendChild(svg("text", { x: x(t), y: 14, "text-anchor": t === tickList[0] && x(t) < 12 ? "start" : "middle", class: "tick-label" }, t + " s"));
    });
    container.appendChild(el("div", { class: "score-axis" }, [el("div", null, ""), axis]));

    var layers = layerOrder(score);
    if (layers.length === 0) {
      container.appendChild(el("p", { class: "empty" }, "Nothing moves in this range."));
      return;
    }
    layers.forEach(function (layer) {
      container.appendChild(el("div", { class: "score-row layer-start" }, [el("div", { class: "score-layer", title: layer.name }, layer.name), el("div", null, "")]));
      layer.props.forEach(function (prop) {
        var row = svg("svg", { height: ROW, viewBox: "0 0 " + width + " " + ROW, role: "group", "aria-label": layer.name + " " + prop.name });
        tickList.forEach(function (t) { row.appendChild(svg("line", { x1: x(t), x2: x(t), y1: 0, y2: ROW, class: "gridline" })); });
        var base = ROW - 5;
        row.appendChild(svg("line", { x1: 0, x2: width, y1: base + 0.5, y2: base + 0.5, class: "baseline" }));
        if (highlight && highlight.times.length) {
          highlight.times.forEach(function (t) { row.appendChild(svg("line", { x1: x(t), x2: x(t), y1: 0, y2: ROW, class: "marker" })); });
        }
        prop.moves.forEach(function (m) {
          var x0 = x(m.startTime);
          var x1 = Math.max(x0 + 1, x(m.endTime));
          var quiet = highlight && highlight.movementIds.indexOf(m.id) < 0;
          var g = svg("g", { class: quiet ? "quiet" : null });
          var amp = ROW - 10;
          var profile = m.speedProfile.length ? m.speedProfile : [1, 1];
          var pts = profile.map(function (p, i) {
            return [x0 + (i / (profile.length - 1)) * (x1 - x0), base - p * amp];
          });
          var line = "M" + pts.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join("L");
          g.appendChild(svg("path", { d: line + "L" + x1.toFixed(1) + "," + base + "L" + x0.toFixed(1) + "," + base + "Z", class: "move-wash" }));
          g.appendChild(svg("path", { d: line, class: "move-line" }));
          var hitWidth = Math.max(24, x1 - x0 + 8);
          var hit = svg("rect", {
            x: (x0 + x1) / 2 - hitWidth / 2, y: 0, width: hitWidth, height: ROW, class: "hit", tabindex: 0,
            "aria-label": layer.name + ", " + prop.name + ": " + (SHAPES[m.shape] || m.shape) + ", " + ms(m.duration) + ", starts at " + secs(m.startTime)
          });
          hit.addEventListener("pointermove", function (e) { showTooltip(e, m); });
          hit.addEventListener("pointerleave", hideTooltip);
          hit.addEventListener("focus", function (e) { showTooltip(e, m); });
          hit.addEventListener("blur", hideTooltip);
          g.appendChild(hit);
          row.appendChild(g);
        });
        container.appendChild(el("div", { class: "score-row" }, [el("div", { class: "score-prop", title: prop.name }, prop.name), row]));
      });
    });
  }

  function tableView(score) {
    var rows = score.movements.map(function (m) {
      return el("tr", null, [
        el("td", null, m.layerName),
        el("td", null, m.propertyName),
        el("td", { class: "num" }, m.startTime.toFixed(2)),
        el("td", { class: "num" }, String(Math.round(m.duration * 1000))),
        el("td", null, SHAPES[m.shape] || m.shape),
        el("td", { class: "num" }, m.overshoot > 0 ? pct(m.overshoot) : "—")
      ]);
    });
    return el("details", { class: "table-view" }, [
      el("summary", null, "Show as a table"),
      el("table", null, [
        el("thead", null, el("tr", null, ["Layer", "Property", "Starts (s)", "Duration (ms)", "Ease", "Overshoot"].map(function (h) { return el("th", { scope: "col" }, h); }))),
        el("tbody", null, rows)
      ])
    ]);
  }

  // ---------- comparisons ----------
  data.comparisons.forEach(function (c, index) {
    var headingId = "cmp-" + index;
    var scoreBox = el("div", { class: "score", role: "figure", "aria-label": "Motion Score for " + c.label });
    var state = { highlight: null };
    var findingButtons = c.findings.map(function (f) {
      var button = el("button", { type: "button", class: "finding", "aria-pressed": "false" }, [
        statusIcon(f.severity),
        el("span", { class: "f-title" }, f.title),
        el("span", { class: "f-sev" }, SEVERITY[f.severity] || f.severity),
        el("span", { class: "f-why" }, f.explanation)
      ]);
      button.addEventListener("click", function () {
        var on = button.getAttribute("aria-pressed") !== "true";
        findingButtons.forEach(function (other) { other.setAttribute("aria-pressed", "false"); });
        button.setAttribute("aria-pressed", on ? "true" : "false");
        state.highlight = on ? { movementIds: f.movementIds, times: f.times } : null;
        renderScore(scoreBox, c.score, state.highlight);
      });
      return button;
    });

    var visual = el("div", { class: "two-col" + (c.preview ? " with-preview" : "") }, [
      c.preview ? makePlayer(c.preview, c.label) : null,
      el("div", null, [
        scoreBox,
        el("p", { class: "help" }, "Each curve is one movement's speed. A peak on the left starts fast and settles (ease out); a flat top moves at constant speed (linear). Select a finding to see the movements it is about.")
      ])
    ]);

    var notes = (c.score.notes || []).concat(c.score.truncated ? [c.score.truncated] : []);
    var card = el("section", { class: "card", "aria-labelledby": headingId }, [
      el("div", { class: "comparison-head" }, [el("h2", { id: headingId }, c.label), el("span", { class: "kind" }, KINDS[c.kind] || c.kind)]),
      c.note ? el("p", { class: "note" }, c.note) : null,
      c.summary.length ? el("ul", { class: "summary" }, c.summary.map(function (s) { return el("li", null, s); })) : null,
      visual,
      notes.length ? el("ul", { class: "summary" }, notes.map(function (n) { return el("li", null, n); })) : null,
      findingButtons.length
        ? el("div", { class: "findings", role: "group", "aria-label": "Why it may feel this way" }, [el("h3", null, "Why it may feel this way")].concat(findingButtons))
        : el("p", { class: "note" }, c.kind === "predicted" ? "None of the Critic's tells are predicted." : "None of the Critic's tells were measured."),
      tableView(c.score)
    ]);
    root.appendChild(card);
    renderScore(scoreBox, c.score, null);
    if (window.ResizeObserver) {
      var lastWidth = scoreBox.clientWidth;
      new ResizeObserver(function () {
        if (Math.abs(scoreBox.clientWidth - lastWidth) < 2) return;
        lastWidth = scoreBox.clientWidth;
        renderScore(scoreBox, c.score, state.highlight);
      }).observe(scoreBox);
    }
  });

  if (players.length > 1) {
    var all = el("button", { type: "button" }, "Play all together");
    all.addEventListener("click", function () {
      var now = performance.now();
      players.forEach(function (p) { p.pause(); p.show(0); p.play(now); });
    });
    header.appendChild(all);
  }

  // ---------- checks & judgement ----------
  root.appendChild(el("section", { class: "card", "aria-labelledby": "checks-h" }, [
    el("h2", { id: "checks-h" }, "What was checked"),
    data.checks.length
      ? el("ul", { class: "checks" }, data.checks.map(function (c) {
          var word = { done: "Done", incomplete: "Incomplete", failed: "Failed", "not-checked": "Not checked" }[c.state];
          return el("li", null, [statusIcon(c.state), el("span", null, [el("strong", null, word + ": "), c.label]), el("span", { class: "c-detail" }, c.detail)]);
        }))
      : el("p", { class: "note" }, "No checks ran.")
  ]));
  if (data.needsDesigner.length) {
    root.appendChild(el("section", { class: "card", "aria-labelledby": "eye-h" }, [
      el("h2", { id: "eye-h" }, "What needs your eye"),
      el("ul", null, data.needsDesigner.map(function (n) { return el("li", null, n); }))
    ]));
  }
})();
