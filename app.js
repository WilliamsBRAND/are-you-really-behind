/* ============================================================
   Are You Really Behind? — application flow, analytics, redirect
   ============================================================ */
(function () {
  "use strict";

  var CFG = window.SITE_CONFIG || {};
  var API = CFG.apiEndpoint || "/api/register";
  var WHATSAPP = CFG.whatsappGroupUrl || "";
  var AUTO_REDIRECT_MS = CFG.whatsappAutoRedirectMs || 3000;

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ---------------- analytics ---------------- */
  var TRACK = [];
  function track(name, props) {
    var payload = Object.assign({ event: name }, props || {});
    TRACK.push(payload);
    if (typeof window.gtag === "function") window.gtag("event", name, props || {});
    if (Array.isArray(window.dataLayer)) window.dataLayer.push(payload);
    document.dispatchEvent(new CustomEvent("site:track", { detail: payload }));
    if (window.console && window.localStorage && window.localStorage.getItem("ayrb_debug") === "1") {
      console.log("[track]", payload);
    }
  }
  window.SITE_TRACK = TRACK;

  /* ---------------- source / UTM ---------------- */
  var UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref"];
  function readSource() {
    var params = new URLSearchParams(window.location.search);
    var out = {};
    UTM_KEYS.forEach(function (k) {
      var v = params.get(k);
      if (v) out[k] = v;
    });
    if (out.utm_source) {
      try { localStorage.setItem("ayrb_source", JSON.stringify(out)); } catch (e) {}
      return out;
    }
    try {
      var saved = localStorage.getItem("ayrb_source");
      return saved ? JSON.parse(saved) : {};
    } catch (e) { return {}; }
  }

  function resolveSource() {
    var s = readSource();
    var raw = (s.utm_source || s.ref || "direct").toLowerCase();
    if (/instagram|ig/.test(raw)) return "Instagram";
    if (/whatsapp|wa\.me/.test(raw)) return "WhatsApp";
    if (/linkedin|li/.test(raw)) return "LinkedIn";
    if (/(^|_)x$|twitter/.test(raw)) return "X";
    if (/direct/.test(raw)) return "Direct";
    return "Other";
  }

  /* ---------------- reveal on scroll ---------------- */
  function initReveal() {
    var items = $$("[data-reveal]");
    if (!("IntersectionObserver" in window)) {
      items.forEach(function (el) { el.classList.add("is-in"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-in");
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    items.forEach(function (el) { io.observe(el); });
  }

  /* ---------------- sticky header shadow ---------------- */
  function initHeader() {
    var head = $(".site-head");
    if (!head) return;
    var onScroll = function () {
      head.classList.toggle("is-stuck", window.scrollY > 8);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* ---------------- country codes ---------------- */
  var CODES = [
    { code: "+234", label: "Nigeria" },
    { code: "+233", label: "Ghana" },
    { code: "+254", label: "Kenya" },
    { code: "+255", label: "Tanzania" },
    { code: "+256", label: "Uganda" },
    { code: "+260", label: "Zambia" },
    { code: "+263", label: "Zimbabwe" },
    { code: "+27", label: "South Africa" },
    { code: "+1", label: "United States / Canada" },
    { code: "+44", label: "United Kingdom" },
    { code: "+61", label: "Australia" },
    { code: "+234", label: "Nigeria" }
  ];

  function initPhone() {
    var btn = $("#phone-flag");
    var label = $("#phone-code");
    var list = $("#phone-list");
    var input = $("#phone");
    if (!btn || !list) return;

    function choose(code) {
      label.textContent = code;
      list.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      input.focus();
    }

    list.innerHTML = "";
    var seen = {};
    CODES.forEach(function (c) {
      if (seen[c.code + c.label]) return;
      seen[c.code + c.label] = true;
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", "false");
      b.innerHTML = "<b>" + c.code + "</b><span>" + c.label + "</span>";
      b.addEventListener("click", function () { choose(c.code); });
      list.appendChild(b);
    });

    btn.addEventListener("click", function () {
      var open = list.hidden;
      list.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
    });

    document.addEventListener("click", function (e) {
      if (!list.hidden && !list.contains(e.target) && !btn.contains(e.target)) {
        list.hidden = true;
        btn.setAttribute("aria-expanded", "false");
      }
    });
  }

  function fullPhone() {
    var code = ($("#phone-code") || {}).textContent || "";
    var num = (($("#phone") || {}).value || "").replace(/[^\d]/g, "");
    return code + num;
  }

  /* ---------------- sheet ---------------- */
  var sheet = $("#sheet");
  var form = $("#register-form");
  var successBox = $("#success");
  var progressBox = $("#progress");
  var currentStep = 1;
  var lastFocus = null;
  var submitting = false;
  var redirectTimer = null;

  function show(el) { if (el) el.hidden = false; }
  function hide(el) { if (el) el.hidden = true; }

  function openSheet() {
    if (!sheet) return;
    lastFocus = document.activeElement;
    show(sheet);
    document.body.classList.add("is-locked");
    track("apply_click");
    track("form_started");
    gotoStep(currentStep, true);
    setTimeout(function () {
      var first = $(".step:not([hidden]) input, .step:not([hidden]) textarea, .step:not([hidden]) button");
      if (first) first.focus({ preventScroll: true });
    }, 60);
  }

  function closeSheet() {
    if (!sheet) return;
    hide(sheet);
    document.body.classList.remove("is-locked");
    if (redirectTimer) { clearTimeout(redirectTimer); redirectTimer = null; }
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function setSubmitting(on) {
    var btn = $("#submit-btn");
    if (!btn) return;
    submitting = on;
    btn.disabled = on;
    btn.textContent = on ? "Completing registration..." : "Complete Registration";
  }

  /* ---------------- steps ---------------- */
  function gotoStep(n, silent) {
    currentStep = n;
    $$(".step").forEach(function (s) {
      s.hidden = Number(s.dataset.step) !== n;
    });
    var label = $("#progress-current");
    if (label) label.textContent = String(n);
    var bar = $("#progress-bar");
    if (bar) bar.style.width = (n / 3) * 100 + "%";
    show(progressBox);
    hide(successBox);
    show(form);
    if (!silent) {
      var panel = $(".sheet__panel");
      if (panel) panel.scrollTop = 0;
    }
  }

  function setError(name, message) {
    var slot = $('[data-error-for="' + name + '"]');
    var input = form ? form.querySelector('[name="' + name + '"]') : null;
    if (slot) slot.textContent = message || "";
    if (input) {
      if (message) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
  }

  function clearErrors() {
    $$(".field__error").forEach(function (el) { el.textContent = ""; });
    $$("[aria-invalid]").forEach(function (el) { el.removeAttribute("aria-invalid"); });
    hide($("#form-error"));
  }

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function validateStep(n) {
    clearErrors();
    var ok = true;

    if (n === 1) {
      var name = ($("#fullName") || {}).value || "";
      var email = ($("#email") || {}).value || "";
      var phoneDigits = fullPhone().replace(/\D/g, "");
      var loc = ($("#location") || {}).value || "";

      if (!name.trim()) { setError("fullName", "Please enter your full name."); ok = false; }
      if (!email.trim()) { setError("email", "Please enter your email address."); ok = false; }
      else if (!EMAIL_RE.test(email.trim())) { setError("email", "That email address doesn't look right."); ok = false; }
      if (phoneDigits.length < 7) { setError("phone", "Please enter your phone number with country code."); ok = false; }
      if (!loc.trim()) { setError("location", "Please tell us where you're based."); ok = false; }
    }

    if (n === 2) {
      var ut = form.querySelector('input[name="userType"]:checked');
      if (!ut) { setError("userType", "Please choose the one that fits best."); ok = false; }
    }

    if (n === 3) {
      var fb = form.querySelector('input[name="feelingBehind"]:checked');
      if (!fb) { setError("feelingBehind", "Please choose one."); ok = false; }
    }

    return ok;
  }

  /* ---------------- success ---------------- */
  function showSuccess(duplicate) {
    hide(form);
    hide(progressBox);
    show(successBox);

    var eyebrow = $("#success-eyebrow");
    var title = $("#success-title");
    var copy = $("#success-copy");

    if (duplicate) {
      eyebrow.textContent = "Already registered";
      title.innerHTML = "You&rsquo;re already registered.";
      copy.textContent = "We already have you down for Are You Really Behind?. Head straight to the WhatsApp group for event updates and the YouTube Live link.";
      track("registration_successful", { duplicate: true });
    } else {
      track("registration_successful", { duplicate: false });
    }

    var btn = $("#whatsapp-btn");
    if (btn) {
      btn.href = WHATSAPP;
      btn.addEventListener("click", function () { track("whatsapp_click", { auto: false }); });
    }

    track("whatsapp_auto_redirect", { delay_ms: AUTO_REDIRECT_MS });
    redirectTimer = setTimeout(function () {
      track("whatsapp_click", { auto: true });
      /* Same-tab navigation on purpose: window.open() inside a timeout is
         blocked by most popup blockers, so people would never reach WhatsApp.
         The manual button still opens a new tab. */
      window.location.href = WHATSAPP;
    }, AUTO_REDIRECT_MS);
  }

  /* ---------------- submit ---------------- */
  function payload() {
    var fd = new FormData(form);
    return {
      fullName: (fd.get("fullName") || "").toString().trim(),
      email: (fd.get("email") || "").toString().trim(),
      phone: fullPhone(),
      location: (fd.get("location") || "").toString().trim(),
      userType: (fd.get("userType") || "").toString(),
      currentStage: (fd.get("currentStage") || "").toString().trim(),
      feelingBehind: (fd.get("feelingBehind") || "").toString(),
      expectedOutcome: (fd.get("expectedOutcome") || "").toString().trim(),
      source: resolveSource(),
      utm: readSource(),
      website: (fd.get("website") || "").toString()
    };
  }

  function submit() {
    if (submitting) return;
    if (!validateStep(3)) return;

    setSubmitting(true);
    track("registration_submitted");

    fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload())
    })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (res) {
        if (res.body && res.body.ok) {
          showSuccess(Boolean(res.body.duplicate));
          return;
        }
        var err = $("#form-error");
        if (err) {
          err.textContent =
            (res.body && res.body.error) || "We couldn't save your registration. Please try again.";
          show(err);
        }
        track("registration_failed", { status: res.status });
        setSubmitting(false);
      })
      .catch(function () {
        var err = $("#form-error");
        if (err) {
          err.textContent = "We couldn't reach the server. Check your connection and try again — your answers are still here.";
          show(err);
        }
        track("registration_failed", { status: 0 });
        setSubmitting(false);
      });
  }

  /* ---------------- wire up ---------------- */
  function init() {
    initReveal();
    initHeader();
    initPhone();

    track("page_view", { path: window.location.pathname });

    $$("[data-apply]").forEach(function (b) { b.addEventListener("click", openSheet); });
    $$("[data-close]").forEach(function (b) { b.addEventListener("click", closeSheet); });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && sheet && !sheet.hidden) closeSheet();
    });

    $$("[data-next]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (validateStep(currentStep)) {
          if (currentStep === 1) track("step1_completed");
          if (currentStep === 2) track("step2_completed");
          gotoStep(currentStep + 1);
        }
      });
    });

    $$("[data-back]").forEach(function (b) {
      b.addEventListener("click", function () { gotoStep(Math.max(1, currentStep - 1)); });
    });

    if (form) form.addEventListener("submit", function (e) { e.preventDefault(); submit(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
