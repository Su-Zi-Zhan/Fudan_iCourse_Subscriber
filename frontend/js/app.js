/**
 * Alpine.js app — all state, routing, and view logic for the iCourse frontend.
 * References ICS.crypto, ICS.github, ICS.db, ICS.render globals.
 */

/* ── Credential helpers (localStorage) ── */
const _LS = "ics_";
const _loadCreds = () => { try { return JSON.parse(localStorage.getItem(_LS + "creds")); } catch { return null; } };
const _saveCreds = (c) => localStorage.setItem(_LS + "creds", JSON.stringify(c));
const _loadSettings = () => { try { return JSON.parse(localStorage.getItem(_LS + "settings")) || {}; } catch { return {}; } };
const _saveSettings = (s) => localStorage.setItem(_LS + "settings", JSON.stringify(s));

function _relativeTime(iso) {
  if (!iso) return "";
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const days = Math.floor(h / 24);
  if (days < 30) return days + "d ago";
  return new Date(iso).toLocaleDateString();
}

function _highlightSnippet(text, query, radius) {
  radius = radius || 60;
  if (!text || !query) return "";
  const plain = ICS.render.plainSnippet(text, 99999);
  const idx = plain.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return plain.slice(0, 120) + "...";
  const s = Math.max(0, idx - radius);
  const e = Math.min(plain.length, idx + query.length + radius);
  let snip = (s > 0 ? "..." : "") + plain.slice(s, e) + (e < plain.length ? "..." : "");
  const re = new RegExp("(" + query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
  return snip.replace(re, "<mark>$1</mark>");
}

/* ── Alpine app ── */
document.addEventListener("alpine:init", () => {
  Alpine.data("app", () => ({
    view: "loading", error: null, loadingMsg: "",
    toast: null, toastType: "success",
    courses: [], lectures: [],
    currentCourse: null, currentLecture: null,
    searchQuery: "", searchResults: [],
    editText: "", editPreview: false, saving: false,
    commitSha: null,
    setup: { token: "", stuid: "", uispsw: "", dashscope: "", smtp: "" },
    setupError: "", setupTesting: false,
    settingsForm: {}, showSecrets: {},
    iterations: 10000, repoOwner: "", repoName: "", dataBranch: "data",
    _history: [],

    async init() {
      const detected = ICS.github.detectRepo();
      const s = _loadSettings();
      this.repoOwner = s.owner || (detected?.owner ?? "");
      this.repoName = s.repo || (detected?.repo ?? "");
      this.dataBranch = s.branch || "data";
      this.iterations = s.iterations || 10000;
      const creds = _loadCreds();
      if (!creds) { this.view = "setup"; return; }
      await this._loadDB(creds);
    },

    async _loadDB(creds) {
      this.view = "loading"; this.error = null;
      try {
        this.loadingMsg = "Connecting to GitHub...";
        const { data, commitSha } = await ICS.github.fetchEncryptedDB(
          this.repoOwner, this.repoName, this.dataBranch, creds.token
        );
        this.commitSha = commitSha;
        this.loadingMsg = "Decrypting database...";
        const pw = ICS.crypto.buildPassword(creds);
        const dbBytes = await ICS.crypto.decrypt(data, pw, this.iterations);
        this.loadingMsg = "Loading data...";
        await ICS.db.initDB(dbBytes);
        ICS.db.ensureSchema();
        this.courses = ICS.db.getCourses();
        this.view = "courses";
      } catch (e) {
        this.error = e.message;
        this.view = "error";
      }
    },

    navigate(view, params) {
      params = params || {};
      this._history.push({ view: this.view, courseId: this.currentCourse?.course_id, lectureId: this.currentLecture?.sub_id });
      this._go(view, params);
    },
    _go(view, params) {
      params = params || {};
      this.error = null;
      if (view === "courses") { this.courses = ICS.db.getCourses(); }
      else if (view === "lectures" && params.courseId) {
        this.currentCourse = this.courses.find(x => x.course_id === params.courseId) || { course_id: params.courseId, title: "...", teacher: "" };
        this.lectures = ICS.db.getLectures(params.courseId);
      }
      else if (view === "detail" && params.subId) { this.currentLecture = ICS.db.getLecture(params.subId); }
      else if (view === "edit") { this.editText = this.currentLecture?.summary || ""; this.editPreview = false; }
      this.view = view;
    },
    goBack() {
      const p = this._history.pop();
      if (p) this._go(p.view, { courseId: p.courseId, subId: p.lectureId });
      else this._go("courses");
    },

    openCourse(id) { this.navigate("lectures", { courseId: id }); },
    openLecture(id) { this.navigate("detail", { subId: id }); },
    startEdit() { this.navigate("edit"); },
    cancelEdit() { this.goBack(); },

    async saveEdit() {
      if (this.saving) return;
      this.saving = true;
      try {
        const creds = _loadCreds();
        if (!creds) throw new Error("Not authenticated");
        ICS.db.updateSummary(this.currentLecture.sub_id, this.editText);
        const dbBytes = ICS.db.exportDB();
        const pw = ICS.crypto.buildPassword(creds);
        const enc = await ICS.crypto.encrypt(dbBytes, pw, this.iterations);
        const sha = await ICS.github.getLatestCommitSha(this.repoOwner, this.repoName, this.dataBranch, creds.token);
        this.commitSha = await ICS.github.pushEncryptedDB(
          this.repoOwner, this.repoName, this.dataBranch, creds.token, enc, sha
        );
        this.currentLecture = ICS.db.getLecture(this.currentLecture.sub_id);
        this.goBack();
        this._toast("Saved successfully", "success");
      } catch (e) { this._toast(e.message, "error"); }
      finally { this.saving = false; }
    },

    _searchTimeout: null,
    doSearch() {
      clearTimeout(this._searchTimeout);
      this._searchTimeout = setTimeout(() => {
        this.searchResults = this.searchQuery.trim() ? ICS.db.searchSummaries(this.searchQuery) : [];
      }, 300);
    },

    async refresh() {
      const c = _loadCreds();
      if (c) { await this._loadDB(c); this._toast("Refreshed", "success"); }
    },

    async testAndSave() {
      this.setupTesting = true; this.setupError = "";
      try {
        const { data, commitSha } = await ICS.github.fetchEncryptedDB(
          this.repoOwner, this.repoName, this.dataBranch, this.setup.token
        );
        await ICS.crypto.decrypt(data, ICS.crypto.buildPassword(this.setup), this.iterations);
        _saveCreds({ ...this.setup });
        _saveSettings({ owner: this.repoOwner, repo: this.repoName, branch: this.dataBranch, iterations: this.iterations });
        this.commitSha = commitSha;
        await this._loadDB({ ...this.setup });
      } catch (e) { this.setupError = e.message; }
      finally { this.setupTesting = false; }
    },

    openSettings() {
      this.settingsForm = { ...(_loadCreds() || {}) };
      this.showSecrets = {};
      this.navigate("settings");
    },
    async saveSettingsAndReload() {
      _saveCreds({ ...this.settingsForm });
      _saveSettings({ owner: this.repoOwner, repo: this.repoName, branch: this.dataBranch, iterations: this.iterations });
      this._toast("Saved. Reloading...", "success");
      const c = _loadCreds();
      if (c) await this._loadDB(c);
    },
    clearAllData() {
      if (!confirm("Clear all saved credentials?")) return;
      localStorage.removeItem(_LS + "creds");
      localStorage.removeItem(_LS + "settings");
      this.view = "setup";
      this.setup = { token: "", stuid: "", uispsw: "", dashscope: "", smtp: "" };
    },

    _toast(msg, type) {
      this.toast = msg; this.toastType = type || "success";
      setTimeout(() => { this.toast = null; }, 3000);
    },

    // Template helpers
    renderMd(s) { return ICS.render.renderMarkdown(s); },
    activateKaTeX(el) { ICS.render.activateKaTeX(el); },
    snippet(s, n) { return ICS.render.plainSnippet(s, n); },
    highlight(text, q) { return _highlightSnippet(text, q); },
    relTime(s) { return _relativeTime(s); },
  }));
});
