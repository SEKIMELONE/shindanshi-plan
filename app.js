'use strict';
(() => {
  const KEY = 'shindanshi-plan:v1';
  const N = PLAN.weeks.length;            // 45週
  const SUBJ = PLAN.subjects;             // 8列（最後は「過去問・その他」）
  const STUDY_N = 7;                      // 試験科目の数
  const DAYS = '日月火水木金土';
  const DAYMS = 86400000;
  const OTHER = '過去問・その他';

  // ---------- 保存データ ----------
  function blank() {
    return { v: 1, settings: { start: PLAN.start, exam: PLAN.exam, theme: 'auto', pomo: true, dailyAt: '12:45', gcal: { url: '', token: '', lectures: false, color: '9', read: [], hideLect: true, span: 'sem' } },
      weeks: {}, checks: {}, moves: {}, gsync: { hash: {}, last: 0, err: '', clast: 0, cerr: '' }, updatedAt: 0,
      ov: { plan: {}, target: {}, pattern: {}, tt: {}, gantt: {} } };
  }
  function normalize(s) {
    const b = blank();
    if (!s || typeof s !== 'object') return b;
    const ov = s.ov || {};
    return {
      v: 1,
      settings: { ...b.settings, ...(s.settings || {}), gcal: { ...b.settings.gcal, ...((s.settings || {}).gcal || {}) } },
      gsync: { ...b.gsync, ...(s.gsync || {}) },
      updatedAt: Number(s.updatedAt) || 0,
      weeks: s.weeks || {},
      checks: s.checks || {},
      moves: s.moves || {},
      ov: { plan: ov.plan || {}, target: ov.target || {}, pattern: ov.pattern || {}, tt: ov.tt || {}, gantt: ov.gantt || {} },
    };
  }
  function load() {
    try { return normalize(JSON.parse(localStorage.getItem(KEY))); } catch (e) { return blank(); }
  }
  let saveFailed = false;
  // この端末にだけ保存（送信状況など、記録の中身が変わらないとき）
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); saveFailed = false; }
    catch (e) { if (!saveFailed) toast('この端末に保存できませんでした'); saveFailed = true; }
  }
  // 記録が変わったとき：変えた時刻を付けて保存し、ネット側（Apps Script）にも送る
  function save() {
    S.updatedAt = Date.now();
    persist();
    if (typeof cloudPushSoon === 'function') cloudPushSoon();
  }
  let S = load();

  // ---------- 日付 ----------
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = s => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
  const diff = (a, b) => Math.round((b - a) / DAYMS);
  const md = d => `${d.getMonth() + 1}/${d.getDate()}`;
  const mdw = d => `${md(d)}（${DAYS[d.getDay()]}）`;
  const startD = () => parse(S.settings.start);
  const examD = () => parse(S.settings.exam);
  const rawWeek = d => Math.floor(diff(startD(), d) / 7) + 1;
  const weekOf = d => Math.max(1, Math.min(N, rawWeek(d)));
  const weekStart = w => addDays(startD(), 7 * (w - 1));
  const weekEnd = w => addDays(weekStart(w), 6);
  const examWeek = () => rawWeek(examD());

  // ---------- 計画データ（編集があれば上書き） ----------
  const W = w => PLAN.weeks[w - 1];
  const range = (w, i) => { const k = `${w}-${i}`; return k in S.ov.plan ? S.ov.plan[k] : W(w).s[i]; };
  const target = w => (w in S.ov.target ? S.ov.target[w] : W(w).target);
  const pattern = w => S.ov.pattern[w] || W(w).pattern;
  const patIdx = name => Math.max(0, PLAN.patterns.indexOf(name));
  const ttCell = (r, p) => { const k = `${r}-${p}`; return k in S.ov.tt ? S.ov.tt[k] : PLAN.slots[r].c[p]; };
  const ganttRow = i => ({ ...PLAN.gantt[i], ...(S.ov.gantt[i] || {}) });
  const color = name => PLAN.colors[name] || 'var(--border)';

  const SLOTS = PLAN.slots.map((s, i) => {
    const m = /(\d+):(\d+)〜(\d+):(\d+)/.exec(s.time || '');
    const a = m ? +m[1] * 60 + +m[2] : null;
    const b = m ? +m[3] * 60 + +m[4] : null;
    return { ...s, i, a, b, hours: m ? (b - a) / 60 : (s.time === '15分' ? 0.25 : 0) };
  });

  // 時間割の文字列を「科目」と「やること」に分ける（スプレッドシートの判定と同じ考え方）
  function parseTask(text) {
    if (!text) return { type: 'empty', subj: '', task: '' };
    if (text.startsWith('（講義）')) return { type: 'lecture', subj: '講義', task: text.slice(4) };
    if (text.startsWith('休み')) return { type: 'off', subj: '休み', task: text };
    const i = text.indexOf('：');
    if (i >= 0) return { type: 'study', subj: text.slice(0, i), task: text.slice(i + 1) };
    if (text.startsWith('予備')) return { type: 'study', subj: '予備', task: text };
    const s = SUBJ.slice(0, STUDY_N).find(n => text.startsWith(n));
    if (s) return { type: 'study', subj: s, task: text };
    if (/^(振り返り|1週間の|答え合わせ)/.test(text)) return { type: 'study', subj: '振り返り', task: text };
    return { type: 'study', subj: '', task: text };
  }

  // 「今週のメイン科目」「2つ目のメイン科目」を週次計画から決める（△×や維持の列は除く）
  const MAINT = /△|×|^土|^毎日|維持/;
  function mainSubjects(w) {
    const r = [];
    for (let i = 0; i < STUDY_N; i++) { const t = range(w, i); if (t && !MAINT.test(t)) r.push(i); }
    return r;
  }
  function subjectsFor(subj, w) {
    if (!subj) return [];
    if (subj.startsWith('今週のメイン')) return mainSubjects(w).slice(0, 1);
    if (subj.startsWith('2つ目')) { const m = mainSubjects(w); return m.length > 1 ? [m[1]] : m.slice(0, 1); }
    const r = [];
    if (subj.startsWith('過去問')) { for (let i = 0; i < STUDY_N; i++) if (range(w, i)) r.push(i); return r; }
    for (let i = 0; i < STUDY_N; i++) if (subj.includes(SUBJ[i])) r.push(i);
    return r;
  }
  const isMeta = subj => /^(今週のメイン|2つ目|過去問)/.test(subj);

  // ---------- 勉強時間 ----------
  const wk = w => S.weeks[w] || {};
  const setWk = (w, patch) => { S.weeks[w] = { ...wk(w), ...patch }; };
  // 記録のキー：時間割の行 "3"、25分に分けたコマ "3.0"〜"3.2"、追加のコマ "p0"…
  const POMO = 25, BREAK = 5;
  const unitHours = id => (/^p|\./.test(id) ? POMO / 60 : (SLOTS[+id] ? SLOTS[+id].hours : 0));
  function dayHours(key) {
    const c = S.checks[key]; let h = 0;
    if (c) for (const id in c) if (c[id]) h += unitHours(id);
    return h;
  }
  function checkedHours(w) {
    const s0 = weekStart(w), e0 = addDays(s0, 7);
    let h = 0;
    for (const key in S.checks) for (const id in S.checks[key]) {
      if (!S.checks[key][id]) continue;
      const m = S.moves[`${key}|${id}`];
      const d = parse(m && m.carry ? m.d : key);   // 持ち越したコマは、置いた先の週で数える
      if (d >= s0 && d < e0) h += unitHours(id);
    }
    return h;
  }
  const actual = w => Math.max(0, checkedHours(w) + (wk(w).adj || 0));
  const hasRecord = w => actual(w) > 0 || !!wk(w).done;
  const sumTo = (f, w) => { let s = 0; for (let i = 1; i <= w; i++) s += f(i); return s; };
  const fmtH = h => { const r = Math.round(h * 100) / 100; return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0$/, ''); };
  const fmtGain = h => (h < 1 ? `${Math.round(h * 60)}分` : `${fmtH(h)}h`);   // 「終わった（＋25分）」など
  const pct = (a, b) => (b > 0 ? Math.min(100, Math.round(a / b * 100)) : 0);

  // ---------- 画面の状態 ----------
  const ui = { tab: 'cal', calOffset: 0, day: null, scrollNow: false, week: null, pat: null, edit: false, showAll: false };
  const $view = document.getElementById('view');
  const $title = document.getElementById('title');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function render() {
    applyTheme();
    document.querySelectorAll('.tabs button').forEach(b => {
      if (b.dataset.tab === ui.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    const f = { cal: () => (ui.day ? renderDay() : renderCal()), week: renderWeek, timetable: renderTimetable, overview: renderOverview }[ui.tab];
    $view.classList.toggle('wide', ui.tab === 'cal');
    $view.innerHTML = f();
    if (ui.tab === 'cal' && ui.day && ui.scrollNow) {
      // 日ページを開いたら、今の時刻（なければ最初のコマ）が見える位置まで動かす
      ui.scrollNow = false;
      const el = $view.querySelector('.day-main .nowline') || $view.querySelector('.day-main .col .ev');
      scrollTo(0, el ? Math.max(0, el.getBoundingClientRect().top + scrollY - innerHeight * 0.3) : 0);
    }
    gcalSchedule();
    if (typeof placeSheet === 'function' && $sheet.open) placeSheet();
    if (ui.tab === 'overview') {
      const g = $view.querySelector('.gantt-wrap');
      if (g) g.scrollLeft = Math.max(0, (weekOf(today()) - 4) * 18);
    }
  }

  // ---------- カレンダー（メイン画面） ----------
  const SHORT = { '財務・会計': '財務', '経済学': '経済', '企業経営理論': '企業', '運営管理': '運営', '経営情報システム': '情報', '経営法務': '法務', '中小企業経営・政策': '中小' };
  const HOUR_PX = 52;                   // 週表示の1時間の高さ
  const DAY_HPX = 60;                   // 日表示の1時間の高さ
  let hpx = HOUR_PX;                    // いま表示中の画面の1時間の高さ（ドラッグで使う）
  const SNAP = 10;                       // 移動は10分刻み（大学の時限が10分単位なので）
  const TIMED = SLOTS.filter(s => s.a != null);
  const MIN_H = Math.floor(Math.min(...TIMED.map(s => s.a)) / 60);
  const MAX_H = 24;                     // 夜にも動かせるように24時まで表示
  const APP_VER = 'v53';   // sw.js の VERSION と同じにする
  const hm = m => `${Math.floor(m / 60)}:${pad(m % 60)}`;

  // ---------- 25分×3（間に5分休憩）に分けたコマと、休憩で減った分の追加コマ ----------
  const pomoOn = () => S.settings.pomo !== false;
  // 毎日の財務・会計の計算1問（15分）を置く時間。'' なら時間を決めず「終日」の段に出す
  const DAILY_TIMES = [['8:20', '朝 8:20〜'], ['12:45', '昼休み 12:45〜'], ['18:00', '夕方 18:00〜'], ['22:00', '夜 22:00〜'], ['', '時間を決めない']];
  const dailyAt = we => we
    ? (S.settings.dailyAtWE ?? '22:00')   // 土日は昼休みがないので、平日とは別の時間
    : (S.settings.dailyAt === '12:15' ? '12:45' : (S.settings.dailyAt ?? '12:45'));   // 昼休みは 12:45〜 に変更（前の設定・保管分も置き換え）
  const dailyMin = d => {
    const t = dailyAt(d.getDay() % 6 === 0);
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  const pomoCount = s => Math.max(1, Math.floor((s.b - s.a + BREAK) / (POMO + BREAK)));   // 90分→3、70分→2
  const EXTRA_TEXT = '財務・会計：休憩で減った分の演習（すきま時間に置く）';

  // ある日の元の位置のコマ（ユニット）。勉強の時間つきのコマだけ25分に分ける
  function baseUnits(d) {
    const pi = patIdx(pattern(weekOf(d))), dc = DAYS[d.getDay()], out = [];
    SLOTS.forEach(s => {
      if (s.day !== '毎日' && s.day !== dc) return;
      const text = ttCell(s.i, pi);
      if (!text) return;
      if (s.day === '毎日' && dailyMin(d) != null) {   // 毎日の財務1問（15分）は決めた時間に置く
        out.push({ uid: String(s.i), s, a0: dailyMin(d), dur: 15, hours: s.hours });
      } else if (pomoOn() && s.a != null && parseTask(text).type === 'study') {
        const n = pomoCount(s);
        for (let k = 0; k < n; k++) out.push({ uid: `${s.i}.${k}`, s, k, n, a0: s.a + k * (POMO + BREAK), dur: POMO, hours: POMO / 60 });
      } else {
        out.push({ uid: String(s.i), s, a0: s.a, dur: s.a == null ? null : s.b - s.a, hours: s.hours });
      }
    });
    return out;
  }
  // 休憩で減った分を、財務・会計の25分コマとして週に足す（時間は決めず「終日」の段に置く）
  const extraCache = {};
  function weekExtras(w) {
    const ck = `${w}|${pomoOn()}|${JSON.stringify(S.ov.tt)}|${pattern(w)}`;
    if (extraCache[w] && extraCache[w].ck === ck) return extraCache[w].list;
    let lost = 0;
    const days = Array.from({ length: 7 }, (_, k) => addDays(weekStart(w), k));
    if (pomoOn()) days.forEach(d => baseUnits(d).forEach(u => { if (u.k === 0) lost += (u.s.b - u.s.a) - u.n * POMO; }));
    const n = Math.round(lost / POMO), list = [];
    for (let j = 0; j < n; j++) {
      const d = days[j % 7];
      list.push({ date: ymd(d), u: { uid: `p${j}`, extra: true, flex: true, text: EXTRA_TEXT, a0: null, dur: POMO, hours: POMO / 60,
        s: { i: `p${j}`, day: DAYS[d.getDay()], period: '追加', time: '25分', a: null, b: null, hours: POMO / 60 } } });
    }
    extraCache[w] = { ck, list };
    return list;
  }
  const unitsOf = d => baseUnits(d).concat(weekExtras(weekOf(d)).filter(x => x.date === ymd(d)).map(x => x.u));
  const findUnit = (key, uid) => unitsOf(parse(key)).find(u => u.uid === String(uid));

  // 移動したコマ。キーは「元の日付|コマ」。同じ週の中でしか動かせない
  const moveKey = (key, uid) => `${key}|${uid}`;
  function getMove(key, u) {
    let m = S.moves[moveKey(key, u.uid)];
    // 25分に分ける前に90分のコマごと動かしていたら、3つとも同じだけずらす
    if (!m && u.k != null) {
      const old = S.moves[moveKey(key, u.s.i)];
      if (old) m = { d: old.d, a: old.a == null ? null : old.a + u.k * (POMO + BREAK) };
    }
    if (!m) return null;
    const gap = rawWeek(parse(m.d)) - rawWeek(parse(key));
    return gap === 0 || (m.carry && gap > 0 && gap <= CARRY_WEEKS) ? m : null;
  }
  const CARRY_WEEKS = 3;   // 持ち越せるのは3週先まで
  function isDone(key, u) {
    const c = S.checks[key] || {};
    return !!(c[u.uid] || (u.k != null && c[u.s.i]));   // 分ける前に90分ごと「終わった」にしたもの
  }

  // ある日の1コマを表示用にまとめる（date は元の日付）
  function slotInfo(u, date) {
    const s = u.s, w = weekOf(date);
    const text = u.text || ttCell(s.i, patIdx(pattern(w)));
    if (!text) return null;
    const p = parseTask(text);
    const idxs = p.type === 'study' ? subjectsFor(p.subj, w) : [];
    const subjName = isMeta(p.subj) && idxs.length ? idxs.map(i => SUBJ[i]).join('・') : p.subj;
    const short = p.type === 'lecture' ? p.task : idxs.length ? idxs.map(i => SHORT[SUBJ[i]]).join('・') : (p.subj || p.task);
    const task = p.type === 'study' && !p.task.startsWith(subjName) ? p.task : '';
    const c = p.type === 'study' ? (idxs.length ? color(SUBJ[idxs[0]]) : color(OTHER)) : '';
    const key = ymd(date);
    const mv = getMove(key, u);
    const carry = !!(mv && mv.carry), flex = !!u.flex || carry;
    const a = flex ? (mv && mv.a != null ? mv.a : null) : (u.a0 == null ? null : (mv && mv.a != null ? mv.a : u.a0));
    const mark = (u.extra ? '（追加）' : u.k != null ? '①②③④'[u.k] : '') + (carry ? '（持ち越し）' : '');
    return {
      s, u, uid: u.uid, w, date, key, text, p, idxs, subjName, short: short + mark, task, c, flex, carry,
      // 分ける前に90分ごと記録したものは、実際にやった90分のまま数える（3つで1.5h）
      hours: u.k != null && !(S.checks[key] || {})[u.uid] && (S.checks[key] || {})[s.i] ? s.hours / u.n : u.hours,
      done: isDone(key, u),
      shown: mv ? parse(mv.d) : date, a, b: a == null ? null : a + (u.dur || 0), moved: !!mv,
    };
  }

  // 1週間ぶんのコマ（移動後の位置で）
  function weekEvents(days) {
    const evs = [];
    days.forEach(d => unitsOf(d).forEach(u => {
      const x = slotInfo(u, d);
      if (x) { x.col = diff(days[0], x.shown); evs.push(x); }
    }));
    // 前の週（3週前まで）から持ち越してきたコマ
    const hasCarry = Object.values(S.moves).some(m => m && m.carry);
    if (hasCarry) for (let back = 1; back <= CARRY_WEEKS; back++) for (let k = 0; k < 7; k++) {
      const d = addDays(days[0], -7 * back + k), key = ymd(d);
      unitsOf(d).forEach(u => {
        const m = S.moves[moveKey(key, u.uid)];
        if (!m || !m.carry) return;
        const x = slotInfo(u, d);
        if (!x) return;
        const col = diff(days[0], x.shown);
        if (col >= 0 && col < days.length) { x.col = col; evs.push(x); }
      });
    }
    return evs;
  }
  // 持ち越せるコマ：勉強・未完了・毎日の1問や予備／振り返り以外。時間つきは終わる時刻が過ぎたもの、時間未定は日曜から
  function carryable(x, days) {
    if (x.p.type !== 'study' || x.done || x.s.day === '毎日' || x.hours === 0) return false;
    if (x.col < 0 || x.col >= 7) return false;
    if (x.a != null) return atMin(x.shown, x.b) <= Date.now();
    return diff(days[6], today()) >= 0;
  }
  function carryOver(x) {
    S.moves[moveKey(x.key, x.uid)] = { d: ymd(addDays(x.shown, 7)), carry: true };
  }

  // 重なったコマを横に並べる（Googleカレンダーと同じ考え方）
  function layoutLanes(evs) {
    evs.sort((p, q) => p.a - q.a || (q.b - q.a) - (p.b - p.a));
    let group = [], end = -Infinity;
    const flush = () => {
      const lanes = [];
      group.forEach(e => {
        let l = lanes.findIndex(x => x <= e.a);
        if (l < 0) { l = lanes.length; lanes.push(0); }
        lanes[l] = e.b; e.lane = l;
      });
      group.forEach(e => { e.lanes = lanes.length; });
      group = [];
    };
    evs.forEach(e => {
      if (group.length && e.a >= end) { flush(); end = -Infinity; }
      group.push(e); end = Math.max(end, e.b);
    });
    if (group.length) flush();
  }

  const evName = x => (x.p.type === 'lecture' ? x.p.task : (x.subjName || x.p.task));
  const evTask = x => (x.p.type === 'lecture' ? '講義' : (x.task || (x.text !== evName(x) ? x.text : '')));
  const evRange = x => x.idxs.map(j => range(x.w, j)).filter(Boolean).join(' / ');

  // mode: 'chip'（週表示の終日）／'week'（週表示）／'day'（日表示）
  function evHtml(x, style, isNow, mode = 'week') {
    const movable = x.p.type === 'study';
    const cls = ['ev', x.p.type, x.done ? 'done' : '', isNow ? 'is-now' : '', x.moved ? 'moved' : '', x.carry ? 'carry' : ''].join(' ');
    const when = x.a == null ? '' : ` ${hm(x.a)}〜${hm(x.b)}`;
    const label = `${mdw(x.shown)}${when} ${x.short}${x.task ? ` ${x.task}` : ''}${x.done ? '（完了）' : ''}${x.moved ? '（移動済み）' : ''}`;
    let inner = `<b>${esc(x.short)}</b>${x.task && mode === 'week' ? `<span>${esc(x.task)}</span>` : ''}`;
    if (mode === 'day') {
      const tk = evTask(x), rng = x.p.type === 'study' ? evRange(x) : '';
      inner = `${x.a == null ? '' : `<i class="tm num">${hm(x.a)}〜${hm(x.b)}</i>`}<b>${esc(evName(x))}</b>${tk ? `<span>${esc(tk)}</span>` : ''}${rng ? `<small>${esc(rng)}</small>` : ''}`;
    }
    return `<button class="${cls}" style="${style}${x.c ? `;--c:${x.c}` : ''}" data-action="slot" data-u="${x.uid}" data-d="${x.key}"
      ${movable ? `data-movable="1" data-dur="${x.flex ? (x.u.dur || POMO) : x.a == null ? 0 : x.b - x.a}" data-allday="${x.a == null ? 1 : 0}"${x.flex ? ' data-flex="1"' : ''}` : ''} aria-label="${esc(label)}">${inner}</button>`;
  }

  function renderCal() {
    const t = today(), cur = weekOf(t);
    const w = Math.max(1, Math.min(N, cur + ui.calOffset));
    const days = Array.from({ length: 7 }, (_, k) => addDays(weekStart(w), k));
    ui.calDays = days; hpx = HOUR_PX;
    const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
    const todayCol = days.findIndex(d => diff(t, d) === 0);
    $title.textContent = 'カレンダー';

    const left = diff(t, examD());
    const examTxt = left > 0 ? `<span class="num">${left}</span><small>日</small>` : left === 0 ? '今日' : '終了';
    const examSub = left > 0 ? `あと約${Math.round(left / 7)}週` : `${md(examD())}・${md(addDays(examD(), 1))}`;
    const tgt = target(w), act = actual(w);
    const cumA = sumTo(actual, cur), cumT = sumTo(target, cur);

    let banners = '';
    if (examWeek() === w) banners += `<div class="banner exam"><b>今週は1次試験</b>　${mdw(examD())}・${mdw(addDays(examD(), 1))}</div>`;
    const note = range(w, 7);
    if (note) banners += `<div class="banner"><span><b>今週のメモ</b>　${esc(note)}</span></div>`;

    const evs = weekEvents(days).filter(showEv);
    const exts = extEvents(days);
    extEnsure(days);
    const dayH = days.map((_, k) => evs.filter(x => x.col === k && x.done).reduce((h, x) => h + x.hours, 0));

    const head = days.map((d, k) =>
      `<button class="dh${k === todayCol ? ' today' : ''}" data-action="openday" data-d="${ymd(d)}" aria-label="${mdw(d)}の予定を開く"><span class="dw">${DAYS[d.getDay()]}</span><span class="dn num">${d.getDate()}</span><span class="dhrs num">${dayH[k] > 0 ? `${fmtH(dayH[k])}h` : ''}</span></button>`).join('');

    const allday = days.map((d, k) => {
      const mine = evs.filter(x => x.col === k && x.a == null);
      const carried = mine.filter(x => x.carry), rest = mine.filter(x => !x.carry);
      // 持ち越しが多い日は2件だけ出して、残りはまとめる（タップでその日のページ）
      const more = carried.length > 2
        ? `<button class="ev study carry more" data-action="openday" data-d="${ymd(d)}" aria-label="${mdw(d)}の持ち越し ほか${carried.length - 2}件"><b>持ち越し＋${carried.length - 2}</b></button>` : '';
      const dr = ui.draft && ui.draft.allDay && ui.draft.day === ymd(d) ? draftHtml(ui.draft, 'week') : '';
      return `<div class="ad" data-col="${k}">${rest.concat(carried.slice(0, 2)).map(x => evHtml(x, '', false, 'chip')).join('')}${more}${exts.filter(x => x.col === k && x.a == null).map(x => extHtml(x, '', 'chip')).join('')}${dr}</div>`;
    }).join('');

    const hours = [];
    for (let h = MIN_H + 1; h < MAX_H; h++) hours.push(`<span class="hl num" style="top:${(h - MIN_H) * HOUR_PX}px">${h}:00</span>`);
    const cols = days.map((_, k) => {
      const mine = evs.filter(x => x.col === k && x.a != null).concat(exts.filter(x => x.col === k && x.a != null));
      layoutLanes(mine);
      const html = mine.map(x => {
        const top = (x.a - MIN_H * 60) / 60 * HOUR_PX, hgt = (x.b - x.a) / 60 * HOUR_PX;
        const lw = 100 / x.lanes;
        const pos = `top:${top.toFixed(1)}px;height:${(hgt - 2).toFixed(1)}px;left:calc(${(x.lane * lw).toFixed(3)}% + 2px);width:calc(${lw.toFixed(3)}% - 5px)`;
        return x.ext ? extHtml(x, pos, 'week') : evHtml(x, pos, k === todayCol && nowMin >= x.a && nowMin < x.b);
      }).join('');
      const line = k === todayCol && nowMin >= MIN_H * 60 && nowMin <= MAX_H * 60
        ? `<div class="nowline" style="top:${((nowMin - MIN_H * 60) / 60 * HOUR_PX).toFixed(1)}px"></div>` : '';
      const dr = ui.draft && !ui.draft.allDay && ui.draft.day === ymd(days[k]) ? draftHtml(ui.draft, 'week') : '';
      return `<div class="col${k === todayCol ? ' today' : ''}" data-col="${k}">${html}${line}${dr}</div>`;
    }).join('');

    const ranges = SUBJ.slice(0, STUDY_N).map((name, i) => [name, range(w, i)]).filter(([, r]) => r)
      .map(([name, r]) => `<li><span class="dot" style="background:${color(name)}"></span><div><div class="nm">${esc(name)}</div><div class="tx">${esc(r)}</div></div></li>`).join('');
    const movedN = evs.filter(x => x.moved && !x.carry && x.col >= 0 && x.col < 7).length;
    const carryN = w < N ? evs.filter(x => carryable(x, days)).length : 0;

    return `
      <div class="calnav">
        <button class="navbtn" data-action="calweek" data-v="-1" ${w <= 1 ? 'disabled' : ''} aria-label="前の週">‹</button>
        <div class="mid"><b>${md(days[0])}〜${md(days[6])}</b><span class="sub">第${w}週 · ${esc(W(w).phase)} · ${esc(pattern(w))}</span></div>
        <button class="navbtn" data-action="calweek" data-v="1" ${w >= N ? 'disabled' : ''} aria-label="次の週">›</button>
      </div>
      ${w !== cur ? '<button class="btn ghost small back-today" data-action="calweek" data-v="0">今週に戻る</button>' : ''}
      <div class="card">
        <div class="stats">
          <div class="stat"><div class="k">試験まで</div><div class="v">${examTxt}</div><div class="s">${examSub}</div></div>
          <div class="stat"><div class="k">この週の勉強</div><div class="v num">${fmtH(act)}<small>/${fmtH(tgt)}h</small></div><div class="s">目標の ${pct(act, tgt)}%</div></div>
          <div class="stat"><div class="k">累計</div><div class="v num">${fmtH(cumA)}<small>/${fmtH(cumT)}h</small></div><div class="s">今週まで</div></div>
        </div>
        <div class="hours-row"><div class="bar${act >= tgt && tgt > 0 ? ' good' : ''}"><i style="width:${pct(act, tgt)}%"></i></div></div>
      </div>
      ${banners}
      <div class="cal" style="--hpx:${HOUR_PX}px">
        <div class="cal-sticky">
          <div class="cal-weekbar">
            <button class="navbtn" data-action="calweek" data-v="-1" ${w <= 1 ? 'disabled' : ''} aria-label="前の週">‹</button>
            <span class="num">${md(days[0])}〜${md(days[6])}<small>　第${w}週</small></span>
            <button class="navbtn" data-action="calweek" data-v="1" ${w >= N ? 'disabled' : ''} aria-label="次の週">›</button>
          </div>
          <div class="cal-row cal-head"><div class="gutter"></div>${head}</div>
        </div>
        <div class="cal-row cal-allday"><div class="gutter">終日</div>${allday}</div>
        <div class="cal-row cal-body" style="height:${(MAX_H - MIN_H) * HOUR_PX}px"><div class="gutter">${hours.join('')}</div>${cols}</div>
      </div>
      <div class="cal-foot">
        <p class="small faint">日付をタップでその日のページ。コマをタップで詳細と「終わった」。${matchMedia('(pointer: coarse)').matches ? '長押しして' : ''}ドラッグで、この週の中で動かせます（講義は固定）。${extOn() ? '空いているところをタップで予定を追加。' : ''}</p>
        ${movedN ? `<button class="btn ghost small" data-action="unmove-week">移動を元に戻す（${movedN}件）</button>` : ''}
        ${carryN ? `<button class="btn small" data-action="carry-week">終わっていないコマを次の週へ（${carryN}件）</button>` : ''}
        ${gcalOn() ? `<p class="small faint gsync${S.gsync.err || S.gsync.cerr || S.gsync.xerr ? ' warn' : ''}" data-gsync>${esc(syncNoteText())}</p>` : ''}
      </div>
      <div class="section-h"><h2>この週の範囲</h2><button class="btn ghost small" data-action="openweek" data-w="${w}">週の詳細 ›</button></div>
      <div class="card flush">${ranges ? `<ul class="ranges">${ranges}</ul>` : '<div class="empty-note">この週の範囲はありません。</div>'}</div>${extOn() ? `<button class="fab" data-action="newev" aria-label="予定を追加"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>` : ''}`;
  }

  function toggleCheck(key, uid) {
    const c = S.checks[key] || (S.checks[key] = {});
    const m = /^(\d+)\.\d+$/.exec(uid);
    if (m && c[m[1]]) {   // 分ける前に90分ごと記録していたら、25分のコマ単位に置き直してから付け外す
      delete c[m[1]];
      for (let k = 0; k < pomoCount(SLOTS[+m[1]]); k++) c[`${m[1]}.${k}`] = 1;
    }
    if (c[uid]) delete c[uid]; else c[uid] = 1;
    const on = !!c[uid];
    if (!Object.keys(c).length) delete S.checks[key];
    // 手入力でマイナスしていた分が、チェックを外したあとに残らないようにする
    const w = weekOf(parse(key)), ch = checkedHours(w);
    if ((wk(w).adj || 0) < -ch) setWk(w, { adj: -ch });
    save();
    if (on && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    return on;
  }

  function openSlot(uid, key) {
    const u = findUnit(key, uid);
    const x = u && slotInfo(u, parse(key));
    if (!x) return;
    const s = x.s, study = x.p.type === 'study';
    const rng = x.idxs.map(j => [j, range(x.w, j)]).filter(([, r]) => r);
    const title = x.p.type === 'lecture' ? x.p.task : (x.subjName || x.p.task);
    const when = x.a == null ? (s.day === '毎日' ? '毎日' : x.flex ? '時間未定（25分）' : esc(s.time)) : `${hm(x.a)}〜${hm(x.b)}`;
    const orig = x.flex ? `${mdw(x.date)}（時間未定）` : `${mdw(x.date)} ${s.day === '毎日' ? '' : esc(s.period)}${u.a0 == null ? '' : `（${hm(u.a0)}〜${hm(u.a0 + u.dur)}）`}`;
    openDlg(`<h2>${esc(title)}</h2>
      <p class="small muted">${mdw(x.shown)} · ${when}${x.done ? ' · <span class="pill good">✓ 完了</span>' : ''}</p>
      ${x.moved ? `<p class="small faint">${x.carry ? '前の週から持ち越し' : '移動済み'}。元は ${orig}</p>` : ''}
      <p>${x.p.type === 'lecture' ? '<span class="muted">講義（参考として表示）</span>' : esc(x.text)}${u.k != null ? `<br><span class="small faint">90分のコマの ${u.k + 1}/${u.n} つ目（25分。終わったら5分休憩）</span>` : ''}${x.flex && x.a == null ? '<br><span class="small faint">空いている時間にドラッグして置いてください</span>' : ''}</p>
      ${rng.length ? `<div class="field"><span>この週の範囲</span>${rng.map(([j, r]) => `<div class="rg"><span class="dot" style="background:${color(SUBJ[j])}"></span><span>${rng.length > 1 ? `<b>${esc(SUBJ[j])}</b>　` : ''}${esc(r)}</span></div>`).join('')}</div>` : ''}
      <div class="dlg-actions">
        ${x.moved ? `<button class="btn ghost" data-dlg="unmove" type="button">${x.carry ? '持ち越しをやめる' : '元の時間に戻す'}</button>` : ''}
        ${study && !x.done && s.day !== '毎日' && x.hours && weekOf(x.shown) < N ? '<button class="btn ghost" data-dlg="carry" type="button">次の週へ持ち越す</button>' : ''}<span class="spacer"></span>
        <button class="btn" data-dlg="cancel" type="button">閉じる</button>
        ${study ? `<button class="btn${x.done ? '' : ' primary'}" data-dlg="toggle" type="button">${x.done ? '未完了に戻す' : `終わった${x.hours ? `（＋${fmtGain(x.hours)}）` : ''}`}</button>` : ''}
      </div>`, act => {
      if (act === 'carry') { carryOver(x); save(); render(); toast(`${mdw(addDays(x.shown, 7))}の「終日」の段へ持ち越しました`); return; }
      if (act === 'unmove') {
        delete S.moves[moveKey(key, uid)];
        if (u.k != null) delete S.moves[moveKey(key, s.i)];   // 分ける前の動かし方も消す
        save(); render(); toast('元の時間に戻しました'); return;
      }
      if (act !== 'toggle') return;
      const on = toggleCheck(key, uid);
      render();
      toast(on ? `記録しました${x.hours ? `（＋${fmtGain(x.hours)}）` : ''}` : '未完了に戻しました');
    });
  }


  // ---------- 日ごとのページ ----------
  const atMin = (d, m) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, m).getTime();
  const fmtLeft = ms => {
    const t = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), x = t % 60;
    return h ? `${h}:${pad(m)}:${pad(x)}` : `${m}:${pad(x)}`;
  };
  const clock = () => { const n = new Date(); return `${n.getHours()}:${pad(n.getMinutes())}`; };
  const weekDaysOf = d => { const s0 = addDays(startD(), 7 * (rawWeek(d) - 1)); return Array.from({ length: 7 }, (_, k) => addDays(s0, k)); };
  function ring(p) {
    const r = 33, c = 2 * Math.PI * r;
    return `<svg class="ring" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="${r}" class="ring-bg"/>${p > 0 ? `<circle cx="40" cy="40" r="${r}" class="ring-fg" stroke-dasharray="${(c * Math.min(1, p)).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 40 40)"/>` : ''}</svg>`;
  }

  function renderDay() {
    const t = today(), d = parse(ui.day);
    const isT = diff(t, d) === 0;
    const w = weekOf(d);
    const days = weekDaysOf(d), col = diff(days[0], d);
    ui.calDays = [d]; hpx = DAY_HPX;
    const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
    $title.textContent = isT ? '今日' : mdw(d);

    const all = weekEvents(days).filter(showEv);
    const evs = all.filter(x => x.col === col);
    const extD = extEvents(days).filter(x => x.col === col);
    extEnsure(days);
    const timed = evs.filter(x => x.a != null), allday = evs.filter(x => x.a == null);
    const study = evs.filter(x => x.p.type === 'study');
    const planH = study.reduce((h, x) => h + x.hours, 0);
    const doneH = study.filter(x => x.done).reduce((h, x) => h + x.hours, 0);
    const doneN = study.filter(x => x.done).length;

    const strip = days.map((x, k) => {
      const h = all.filter(e => e.col === k && e.done).reduce((n, e) => n + e.hours, 0);
      return `<button class="ds${k === col ? ' sel' : ''}${diff(t, x) === 0 ? ' today' : ''}" data-action="dayjump" data-d="${ymd(x)}" aria-label="${mdw(x)}"${k === col ? ' aria-current="date"' : ''}>
        <span>${DAYS[x.getDay()]}</span><b class="num">${x.getDate()}</b><i>${h > 0 ? '●' : ''}</i></button>`;
    }).join('');

    const lay = timed.concat(extD.filter(x => x.a != null));
    layoutLanes(lay);
    const hours = [];
    for (let h = MIN_H + 1; h < MAX_H; h++) hours.push(`<span class="hl num" style="top:${(h - MIN_H) * DAY_HPX}px">${h}:00</span>`);
    const blocks = lay.map(x => {
      const top = (x.a - MIN_H * 60) / 60 * DAY_HPX, hgt = (x.b - x.a) / 60 * DAY_HPX, lw = 100 / x.lanes;
      const pos = `top:${top.toFixed(1)}px;height:${(hgt - 2).toFixed(1)}px;left:calc(${(x.lane * lw).toFixed(3)}% + 3px);width:calc(${lw.toFixed(3)}% - 7px)`;
      return x.ext ? extHtml(x, pos, 'day') : evHtml(x, pos, isT && nowMin >= x.a && nowMin < x.b, 'day');
    }).join('');
    const line = isT && nowMin >= MIN_H * 60 && nowMin <= MAX_H * 60
      ? `<div class="nowline" style="top:${((nowMin - MIN_H * 60) / 60 * DAY_HPX).toFixed(1)}px"></div>` : '';
    const dHere = ui.draft && ui.draft.day === ymd(d) ? ui.draft : null;
    const draftAd = dHere && dHere.allDay ? draftHtml(dHere, 'day') : '', draftTm = dHere && !dHere.allDay ? draftHtml(dHere, 'day') : '';

    // 右側：今のコマ
    let nowCard;
    const rangeBox = x => { const r = x.p.type === 'study' ? evRange(x) : ''; return r ? `<div class="rg2"><b>今週の範囲</b>${esc(r)}</div>` : ''; };
    if (isT) {
      const cur = timed.filter(x => nowMin >= x.a && nowMin < x.b).sort((p, q) => (q.p.type === 'study') - (p.p.type === 'study'))[0];
      const next = timed.filter(x => x.a > nowMin).sort((p, q) => p.a - q.a)[0];
      // 休憩中は、一つ前の勉強のコマをその場で「終わった」にできるようにする
      const prev = timed.filter(x => x.p.type === 'study' && x.b <= nowMin).sort((p, q) => q.b - p.b)[0];
      const prevBox = !prev ? '' : `<div class="prev">
          <div class="pk">前のコマ</div>
          <div class="pn"><span class="dot" style="background:${prev.c}"></span><span>${esc(evName(prev))}</span><span class="faint num">${hm(prev.a)}〜${hm(prev.b)}</span></div>
          ${prev.done ? '<div class="pill good">✓ 記録済み</div>'
            : `<button class="btn primary small" data-action="quickdone" data-u="${prev.uid}" data-d="${prev.key}">終わった（＋${fmtGain(prev.hours)}）</button>`}
        </div>`;
      if (cur) {
        const s0 = atMin(d, cur.a), e0 = atMin(d, cur.b);
        const btn = cur.p.type !== 'study' ? ''
          : cur.done ? '<div class="pill good">✓ 終わった</div>'
            : `<button class="btn primary small" data-action="quickdone" data-u="${cur.uid}" data-d="${cur.key}">終わった（＋${fmtGain(cur.hours)}）</button>`;
        nowCard = `<div class="card side now-card" style="--c:${cur.c || 'var(--faint)'}">
          <div class="k"><span><span class="live"></span>${cur.p.type === 'lecture' ? '講義中' : 'いまのコマ'}</span><span class="clock num" data-clock>${clock()}</span></div>
          <div class="nm">${esc(evName(cur))}</div><div class="tk">${esc(evTask(cur))}</div>
          <div class="big num"><small>残り</small><span data-cd="${e0}">${fmtLeft(e0 - Date.now())}</span></div>
          <div class="bar thin"><i data-left="${s0},${e0}" style="width:${Math.max(0, (e0 - Date.now()) / (e0 - s0) * 100).toFixed(1)}%"></i></div>
          <div class="s num">${hm(cur.a)}〜${hm(cur.b)}</div>${rangeBox(cur)}${btn}</div>`;
      } else if (next) {
        const s0 = atMin(d, next.a);
        nowCard = `<div class="card side now-card idle" style="--c:${next.c || 'var(--faint)'}">
          <div class="k"><span>休憩中</span><span class="clock num" data-clock>${clock()}</span></div>
          <div class="pk" style="margin-top:6px">次のコマ</div>
          <div class="nm" style="margin-top:0">${esc(evName(next))}</div><div class="tk">${esc(evTask(next))}</div>
          <div class="big num"><small>始まるまで</small><span data-cd="${s0}">${fmtLeft(s0 - Date.now())}</span></div>
          <div class="s num">${hm(next.a)}〜${hm(next.b)}</div>${rangeBox(next)}${prevBox}</div>`;
      } else {
        nowCard = `<div class="card side now-card idle">
          <div class="k"><span>今日のコマ</span><span class="clock num" data-clock>${clock()}</span></div>
          <div class="nm">おしまい</div><div class="s">${study.length ? `${doneN} / ${study.length} コマ終わりました` : '今日は勉強のコマがありません'}</div>${prevBox}</div>`;
      }
    } else {
      nowCard = `<div class="card side now-card idle">
        <div class="k"><span>${diff(t, d) > 0 ? 'この日の予定' : 'この日の結果'}</span></div>
        <div class="nm num">${study.length} コマ</div><div class="s">予定 ${fmtH(planH)}h · 講義 ${evs.filter(x => x.p.type === 'lecture').length}コマ</div></div>`;
    }

    const tgt = target(w), act = actual(w), left = diff(t, examD());
    const note = range(w, 7);
    const side = `
      <div class="card side exam">
        <div class="k"><span>1次試験まで</span></div>
        <div class="mid num"><b>${left > 0 ? left : left === 0 ? '今日' : '終了'}</b>${left > 0 ? '<small> 日</small>' : ''}</div>
        <div class="s">${mdw(examD())}${left > 0 ? ` · あと約${Math.round(left / 7)}週` : ''}</div>
      </div>
      ${nowCard}
      <div class="card side">
        <div class="k"><span>${isT ? '今日' : 'この日'}の勉強</span></div>
        <div class="ringwrap">${ring(planH ? doneH / planH : 0)}<div class="ring-txt"><b class="num">${fmtH(doneH)}</b><small>/ ${fmtH(planH)}h</small></div></div>
        <div class="s c">${doneN} / ${study.length} コマ完了</div>
      </div>
      <div class="card side">
        <div class="k"><span>第${w}週</span><span class="faint">${pct(act, tgt)}%</span></div>
        <div class="mid num"><b>${fmtH(act)}</b><small> / ${fmtH(tgt)}h</small></div>
        <div class="bar thin${act >= tgt && tgt > 0 ? ' good' : ''}"><i style="width:${pct(act, tgt)}%"></i></div>
        <div class="s">${act >= tgt ? '目標達成' : `あと ${fmtH(tgt - act)}h`}</div>
      </div>
      ${note ? `<div class="card side note"><div class="k"><span>今週のメモ</span></div><div class="s">${esc(note)}</div></div>` : ''}`;

    return `
      <div class="dayhead">
        <button class="btn ghost small" data-action="dayback">‹ 週</button>
        <div class="mid"><b>${mdw(d)}</b><span class="sub">第${w}週 · ${esc(W(w).phase)}</span></div>
        ${isT ? '<span class="pill accent">今日</span>' : '<button class="btn ghost small" data-action="daytoday">今日</button>'}
      </div>
      <div class="daystrip">
        <button class="navbtn" data-action="dayshift" data-v="-1" aria-label="前の日">‹</button>${strip}<button class="navbtn" data-action="dayshift" data-v="1" aria-label="次の日">›</button>
      </div>
      <div class="dayview">
        <div class="day-main">
          <div class="cal day" style="--hpx:${DAY_HPX}px">
            ${allday.length || extD.some(x => x.a == null) || draftAd ? `<div class="cal-row1 cal-allday"><div class="gutter">終日</div><div class="ad" data-col="0">${allday.map(x => evHtml(x, '', false, 'day')).join('')}${extD.filter(x => x.a == null).map(x => extHtml(x, '', 'day')).join('')}${draftAd}</div></div>` : ''}
            <div class="cal-row1 cal-body" style="height:${(MAX_H - MIN_H) * DAY_HPX}px"><div class="gutter">${hours.join('')}</div><div class="col${isT ? ' today' : ''}" data-col="0">${blocks}${line}${draftTm}</div></div>
          </div>
        </div>
        <aside class="day-side" aria-label="この日のまとめ">${side}</aside>
      </div>${extOn() ? `<button class="fab" data-action="newev" aria-label="予定を追加"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>` : ''}`;
  }

  // 残り時間と時計を1秒ごとに進める（画面全体は描き直さない）
  setInterval(() => {
    if (document.hidden || ui.tab !== 'cal' || !ui.day) return;
    const now = Date.now();
    let expired = false;
    $view.querySelectorAll('[data-cd]').forEach(el => {
      const left = +el.dataset.cd - now;
      if (left <= 0) expired = true; else el.textContent = fmtLeft(left);
    });
    $view.querySelectorAll('[data-left]').forEach(el => {   // 残り時間の割合（だんだん減る）
      const [a, b] = el.dataset.left.split(',').map(Number);
      el.style.width = `${Math.min(100, Math.max(0, (b - now) / (b - a) * 100)).toFixed(2)}%`;
    });
    $view.querySelectorAll('[data-clock]').forEach(el => { el.textContent = clock(); });
    if (expired && !drag && !$dlg.open) render();   // コマが終わった／始まったら切り替える
  }, 1000);

  function backToWeek() {
    const d = parse(ui.day);
    ui.day = null;
    ui.calOffset = weekOf(d) - weekOf(today());
  }


  // ---------- Googleカレンダー連携（Apps Script 経由。アプリ → カレンダーの一方向） ----------
  // 今週・来週・表示中の週について、中身が前回送ったときから変わっていたら1週間分まるごと送る
  // Googleカレンダーの予定の色（番号は Google の決まり。8 グラファイトは「終わった」用）
  const GCAL_COLORS = [['9', 'ブルーベリー'], ['7', 'ピーコック'], ['10', 'バジル'], ['2', 'セージ'], ['3', 'ブドウ'], ['1', 'ラベンダー'], ['4', 'フラミンゴ'], ['11', 'トマト'], ['6', 'ミカン'], ['5', 'バナナ'], ['subject', '科目ごと']];
  const GCOLOR = { '財務・会計': '9', '経済学': '10', '企業経営理論': '6', '運営管理': '3', '経営情報システム': '7', '経営法務': '5', '中小企業経営・政策': '4' };
  const gcalOn = () => !!(S.settings.gcal.url && S.settings.gcal.token);
  const hashStr = str => { let h = 5381; for (let i = 0; i < str.length; i++) h = (h * 33 + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

  function gcalPayload(w) {
    const days = Array.from({ length: 7 }, (_, k) => addDays(weekStart(w), k));
    const lect = S.settings.gcal.lectures;
    const events = weekEvents(days)
      .filter(x => x.a != null && x.col >= 0 && x.col < 7 && (x.p.type === 'study' || (lect && x.p.type === 'lecture')))
      .map(x => {
        const study = x.p.type === 'study', tk = evTask(x), rng = study ? evRange(x) : '';
        return {
          id: `${x.key}_${x.uid}`,
          title: study ? `${x.done ? '✓ ' : ''}${evName(x)}${tk ? `：${tk}` : ''}` : `${evName(x)}（講義）`,
          start: atMin(x.shown, x.a), end: atMin(x.shown, x.b),
          desc: [rng && `今週の範囲：${rng}`, `第${w}週・${W(w).phase}`, '診断士プランから自動で作成（アプリで動かすと、ここも動きます）'].filter(Boolean).join('\n'),
          color: !study ? '1' : x.done ? '8' : S.settings.gcal.color === 'subject' ? (GCOLOR[SUBJ[x.idxs[0]]] || '8') : S.settings.gcal.color,
        };
      });
    return { from: atMin(days[0], 0), to: atMin(addDays(days[6], 1), 0), events };
  }

  async function gcalPost(body) {
    let res;
    try {
      res = await fetch(S.settings.gcal.url, { method: 'POST', body: JSON.stringify({ token: S.settings.gcal.token, ...body }) });
    } catch (e) {
      // 届かない：URL違い、デプロイの「アクセスできるユーザー」が「全員」でない（大学アカウントなど）、圏外
      throw new Error('届きませんでした。URLと、デプロイの「アクセスできるユーザー：全員」を確認してください');
    }
    let j;
    try { j = await res.json(); } catch (e) { throw new Error('返事が読めません（URLを確認してください）'); }
    if (!j.ok) throw new Error(j.error || 'エラー');
    return j;
  }

  let gTimer = 0, gBusy = false, gAgain = false;
  function gcalSchedule() {
    if (!gcalOn()) return;
    clearTimeout(gTimer);
    gTimer = setTimeout(() => gcalFlush(false), 1500);
  }
  // 反映する期間。2セメ（後期）は学年暦で授業が 2/3（水）まで → その週（月〜日）の終わりまで
  const SEM_END = '2027-02-03';
  const GCAL_SPANS = [['near', '今週と来週だけ'], ['sem', '2セメの終わりまで（2/7）'], ['all', '計画の最後まで（試験まで）']];
  const PER_RUN = 2;                     // 1回に送るのは2週まで（Google の作成回数の制限を避ける。25分コマで1週40件ほど）
  let gMore = 0, gLeft = 0;

  function gcalWeeks() {
    const cur = weekOf(today()), span = S.settings.gcal.span || 'sem';
    const end = span === 'all' ? N : span === 'near' ? Math.min(N, cur + 1) : Math.max(Math.min(N, cur + 1), weekOf(parse(SEM_END)));
    const ws = [];
    if (ui.tab === 'cal' && ui.calDays) ws.push(weekOf(ui.calDays[0]));   // 見ている週を先に
    for (let w = cur; w <= end; w++) if (!ws.includes(w)) ws.push(w);
    return ws;
  }

  async function gcalFlush(force) {
    if (!gcalOn() || !cloudReady) return;
    if (gBusy) { gAgain = true; return; }
    if (!navigator.onLine) { S.gsync.err = 'オフライン（つながったら送ります）'; updateSyncNote(); return; }
    gBusy = true;
    clearTimeout(gMore);
    if (force) S.gsync.hash = {};
    let sent = 0;
    try {
      const todo = gcalWeeks().map(w => { const body = gcalPayload(w); return { w, body, h: hashStr(JSON.stringify(body)) }; })
        .filter(x => S.gsync.hash[x.w] !== x.h);
      for (const x of todo.slice(0, PER_RUN)) {
        await gcalPost(x.body);
        S.gsync.hash[x.w] = x.h; sent++;
      }
      gLeft = Math.max(0, todo.length - sent);
      S.gsync.err = '';
      if (sent || force) S.gsync.last = Date.now();
      if (gLeft) gMore = setTimeout(() => gcalFlush(false), 20000);   // 残りは少し間をあけて送る
    } catch (e) {
      S.gsync.err = String(e.message || e);
    }
    gBusy = false;
    persist(); updateSyncNote();
    if (gAgain) { gAgain = false; gcalSchedule(); }
  }
  function syncNoteText() {
    const g = S.gsync;
    if (g.xerr) return `カレンダーの予定：読めていません（${g.xerr}）`;
    if (g.cerr) return `記録の保管：うまくいっていません（${g.cerr}）`;
    if (g.err) return `Googleカレンダー：送れていません（${g.err}）`;
    if (gLeft) return `Googleカレンダー：反映しています（あと${gLeft}週）`;
    if (!g.last) return 'Googleカレンダー：まだ送っていません';
    const t = new Date(g.last);
    return `Googleカレンダー：${diff(parse(ymd(t)), today()) === 0 ? '' : `${md(t)} `}${hm(t.getHours() * 60 + t.getMinutes())} に反映`;
  }
  function updateSyncNote() {
    document.querySelectorAll('[data-gsync]').forEach(el => { el.textContent = syncNoteText(); el.classList.toggle('warn', !!(S.gsync.err || S.gsync.cerr || S.gsync.xerr)); });
  }

  // ---------- 記録のネット保管（同じ Apps Script に保存。スマホとPCで共有、端末のデータが消えても戻せる） ----------
  // 「最後に変えた時刻」が新しい方を正とする。合言葉と送信状況は端末ごとなので送らない
  let cloudReady = !gcalOn(), cTimer = 0, cBusy = false, cAgain = false;
  const cloudData = () => {
    const { gsync, updatedAt, ...rest } = S;
    return { ...rest, settings: { ...S.settings, gcal: undefined } };
  };
  function applyCloud(data, updatedAt) {
    const keep = { gcal: S.settings.gcal, gsync: S.gsync };
    S = normalize({ ...data, settings: { ...(data.settings || {}), gcal: keep.gcal }, gsync: keep.gsync, updatedAt });
    persist(); render();
  }
  async function cloudLoad() {
    if (!gcalOn()) { cloudReady = true; return; }
    try {
      const j = await gcalPost({ op: 'load' });
      cloudReady = true;
      if (j.data && (j.updatedAt || 0) > (S.updatedAt || 0)) {
        applyCloud(j.data, j.updatedAt);
        toast('保管してある記録を読み込みました');
      } else if (!j.data || (S.updatedAt || 0) > (j.updatedAt || 0)) {
        if (!S.updatedAt) S.updatedAt = Date.now();
        cloudReady = true; cloudPush();
      }
      S.gsync.cerr = ''; S.gsync.clast = Date.now();
      if (extOn() && !$dlg.open && !drag) render();   // 自分のカレンダーの予定を読みに行く
    } catch (e) {
      // 古いスクリプトのままだと読み込めない。カレンダーへの送信も止めておく（空の記録で上書きしないため）
      S.gsync.cerr = `${e.message || e}。スクリプトを最新にしてください`;
    }
    persist(); updateSyncNote();
    gcalSchedule();
  }
  function cloudPushSoon() {
    if (!gcalOn() || !cloudReady) return;
    clearTimeout(cTimer);
    cTimer = setTimeout(cloudPush, 2000);
  }
  async function cloudPush() {
    if (!gcalOn() || !cloudReady) return;
    if (cBusy) { cAgain = true; return; }
    if (!navigator.onLine) return;
    cBusy = true;
    try {
      const j = await gcalPost({ op: 'save', updatedAt: S.updatedAt || Date.now(), data: cloudData() });
      if (j.stale && j.data) { applyCloud(j.data, j.updatedAt); toast('ほかの端末の新しい記録に合わせました'); }
      S.gsync.cerr = ''; S.gsync.clast = Date.now();
    } catch (e) {
      S.gsync.cerr = String(e.message || e);
    }
    cBusy = false;
    persist(); updateSyncNote();
    if (cAgain) { cAgain = false; cloudPushSoon(); }
  }
  addEventListener('online', () => { if (cloudReady) { cloudPush(); gcalSchedule(); } else cloudLoad(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && gcalOn()) cloudLoad(); });


  // ---------- 自分のカレンダーの予定（Apps Script 経由で読むだけ） ----------
  // 1週間（月〜日）ごとに読んで、この端末に少しだけ取っておく。5分たったら読み直す
  const EXT_KEY = 'shindanshi-plan:ext';
  let extCache = {};
  try { extCache = JSON.parse(localStorage.getItem(EXT_KEY)) || {}; } catch (e) { extCache = {}; }
  const extOn = () => gcalOn() && (S.settings.gcal.read || []).length > 0;
  const showEv = x => !(x.p.type === 'lecture' && extOn() && S.settings.gcal.hideLect);   // 講義はカレンダー側の予定で見る
  const extBusy = new Set();
  // 読みに行っている間は、画面の上に「読み込み中」を出す（Apps Script は起きるまで数秒〜十数秒かかる）
  const $extLoad = document.createElement('div');
  $extLoad.className = 'ext-load'; $extLoad.hidden = true; $extLoad.setAttribute('role', 'status');
  $extLoad.innerHTML = '<i></i>カレンダーの予定を読み込み中…';
  document.body.appendChild($extLoad);
  const extLoadShow = () => { $extLoad.hidden = extBusy.size === 0; };
  const msHm = ms => { const d = new Date(ms); return hm(d.getHours() * 60 + d.getMinutes()); };

  function extEnsure(days) {
    if (!extOn()) return;   // 読むだけなので、記録の読み込みを待たなくてよい
    const key = ymd(days[0]), c = extCache[key];
    const sel = S.settings.gcal.read.map(x => x.id).join(',');
    if (c && c.sel === sel && c.labels && Date.now() - c.at < 5 * 60000) return;   // 色の名前を持っていない古い分はすぐ読み直す
    if (extBusy.has(key) || !navigator.onLine) return;
    extBusy.add(key); extLoadShow();
    gcalPost({ op: 'read', ids: S.settings.gcal.read.map(x => x.id), from: atMin(days[0], 0), to: atMin(addDays(days[6], 1), 0) })
      .then(j => {
        const before = c && c.sel === sel ? JSON.stringify(c.events) : '';
        extCache[key] = { at: Date.now(), sel, events: j.events || [], labels: j.labels || {} };
        // 取っておくのは6週分まで。読んだのが古い週から捨てる（今読んだ週は捨てない）
        const old = Object.keys(extCache).filter(k => k !== key).sort((p, q) => extCache[p].at - extCache[q].at);
        while (old.length > 5) delete extCache[old.shift()];
        try { localStorage.setItem(EXT_KEY, JSON.stringify(extCache)); } catch (e) { /* 入らなければ取っておかないだけ */ }
        if (before !== JSON.stringify(extCache[key].events) && !drag && !$dlg.open) render();
      })
      .then(() => { if (S.gsync.xerr) { S.gsync.xerr = ''; persist(); updateSyncNote(); } })
      .catch(e => {   // 読めないときは前回の分を出しておき、理由を表示する
        S.gsync.xerr = String(e.message || e); persist(); updateSyncNote();
      })
      .finally(() => { extBusy.delete(key); extLoadShow(); });
  }

  // 表示用に、日ごと・時刻（分）に切り分ける。8時より前に終わる予定などは出さない
  function extEvents(days) {
    if (!extOn()) return [];
    const key = ymd(days[0]), c = extCache[key];
    if (!c) return [];
    const out = [];
    c.events.forEach((e, n) => days.forEach((d, k) => {
      if (e._gone) return;
      const d0 = atMin(d, 0), d1 = atMin(addDays(d, 1), 0);
      if (e.end <= d0 || e.start >= d1) return;
      if (e.allDay) { out.push({ ext: true, e, key, n, col: k, a: null, b: null }); return; }
      const a = Math.max(MIN_H * 60, Math.round((Math.max(e.start, d0) - d0) / 60000));
      let b = Math.min(MAX_H * 60, Math.round((Math.min(e.end, d1) - d0) / 60000));
      if (b <= MIN_H * 60 || a >= MAX_H * 60) return;
      if (b - a < 15) b = a + 15;
      out.push({ ext: true, e, key, n, col: k, a, b });
    }));
    return out;
  }

  // Googleカレンダーの予定の色（番号 → 色）。番号がなければカレンダーの色
  const GCAL_HEX = { 1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26', 6: '#f4511e', 7: '#039be5', 8: '#616161', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000' };
  // カレンダーに決めてある色の名前（ラベル）。いちばん新しく読んだ週のものを使う
  const labelsOf = cid => {
    let best = null;
    Object.values(extCache).forEach(c => { if (c.labels && c.labels[cid] && (!best || c.at > best.at)) best = c; });
    return best ? best.labels[cid] : [];
  };
  const labelOf = e => (e.label && labelsOf(e.cid).find(l => l.id === e.label)) || null;
  const extColor = e => {
    const l = labelOf(e);
    if (l && /^#[0-9a-f]{6}$/i.test(l.color)) return l.color;
    return GCAL_HEX[e.color] || (/^#[0-9a-f]{6}$/i.test(e.ccol || '') ? e.ccol : '');
  };
  // 下の端を引っぱって長さを変えられる予定：時間つきで、同じ日のうちに終わるもの
  const resizable = x => x.a != null && x.e.eid && !x.e.allDay && new Date(x.e.start).toDateString() === new Date(x.e.end - 1).toDateString();
  function extHtml(x, style, mode) {
    const col = extColor(x.e);
    if (col) style = `${style};--c:${col}`;
    const e = x.e, when = e.allDay ? '終日' : `${msHm(e.start)}〜${msHm(e.end)}`;
    const shown = ymd(addDays(parse(x.key), x.col));
    const move = e.eid ? `data-movable="1" data-ext="1" data-day="${shown}" data-a="${x.a ?? ''}" data-dur="${x.a == null ? 0 : x.b - x.a}" data-allday="${x.a == null ? 1 : 0}"` : '';
    const editing = ui.draft && ui.draft.mode === 'edit' && ui.draft.key === x.key && ui.draft.n === x.n;
    return `<button class="ev ext${col ? ' tint' : ''}${editing ? ' editing' : ''}" style="${style}" data-action="ext" data-k="${x.key}" data-n="${x.n}" ${move} aria-label="${esc(`${e.title} ${when}（${e.cal}）`)}">
      ${mode === 'day' && !e.allDay ? `<i class="tm num">${when}</i>` : ''}<b>${esc(e.title)}</b>${mode === 'day' ? `<span>${esc(e.cal)}</span>` : ''}${resizable(x) && !editing ? '<i class="rz up" data-rz="ext" data-edge="top"></i><i class="rz" data-rz="ext"></i>' : ''}</button>`;
  }

  // ---------- 自分のカレンダーの予定を書き換える（動かす・名前・削除・追加） ----------
  const hhmm = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const toMin = str => { const [h, m] = String(str).split(':').map(Number); return h * 60 + m; };
  const monday = d => addDays(d, -((d.getDay() + 6) % 7));

  // 先に画面を変えてから送り、終わったら Google カレンダーから読み直して合わせる
  async function extOps(ops, optimistic, okMsg) {
    if (optimistic) { optimistic(); render(); }
    try {
      for (const body of ops) await gcalPost(body);
      if (okMsg) toast(okMsg);
    } catch (e) {
      toast(`うまくいきませんでした：${e.message || e}`);
    }
    Object.values(extCache).forEach(c => { c.at = 0; });
    if (!$dlg.open && !drag) render();
  }

  // 予定の色を選ぶ欄（Googleカレンダーの11色）。cur は今の色の番号（カレンダーの色のままなら空）
  // Apps Script では「カレンダーの色」に戻せないので、その選択肢は今カレンダーの色のときだけ出す
  const colorPick = (cur, base) => `<div class="field"><span>色</span><div class="swatches" role="radiogroup" aria-label="予定の色">
    ${cur ? '' : `<label class="sw-opt" title="カレンダーの色のまま"><input type="radio" name="xcol" value="" checked><i style="--c:${base || 'var(--border)'}"></i></label>`}
    ${GCAL_COLORS.filter(([v]) => GCAL_HEX[v]).map(([v, nm]) => `<label class="sw-opt" title="${nm}"><input type="radio" name="xcol" value="${v}" ${cur === v ? 'checked' : ''}><i style="--c:${GCAL_HEX[v]}"></i></label>`).join('')}
    </div></div>`;
  const pickedColor = () => { const r = $form.querySelector('[name=xcol]:checked'); return r ? r.value : ''; };
  // 色に名前を付けてあるカレンダーは、名前つきの色から選ぶ（名前のある色を先に、ない色は丸だけ）
  const labelPick = (cid, cur) => {
    const ls = labelsOf(cid);
    if (!ls.length) return '';
    const named = ls.filter(l => l.name), plain = ls.filter(l => !l.name);
    const opt = l => `<label class="${l.name ? 'lb-opt' : 'sw-opt'}" title="${esc(l.name || l.color)}"><input type="radio" name="xlab" value="${esc(l.id)}" ${cur === l.id ? 'checked' : ''}><i style="--c:${esc(l.color)}"></i>${l.name ? `<span>${esc(l.name)}</span>` : ''}</label>`;
    return `<div class="field"><span>色</span>
      ${named.length ? `<div class="labels" role="radiogroup" aria-label="名前つきの色">${named.map(opt).join('')}</div>` : ''}
      <div class="swatches" role="radiogroup" aria-label="ほかの色">${plain.map(opt).join('')}</div></div>`;
  };
  const pickedLabel = () => { const r = $form.querySelector('[name=xlab]:checked'); return r ? r.value : ''; };
  const pickFor = (cid, e) => labelsOf(cid).length ? labelPick(cid, e ? e.label || '' : '') : colorPick(e ? e.color || '' : '', e && /^#/.test(e.ccol || '') ? e.ccol : '');

  function openExt(key, n) {
    const e = ((extCache[key] || {}).events || [])[n];
    if (!e) return;
    if (e.eid) { openEdit(key, n); return; }   // 書き換えられる予定は、追加と同じシートで直す
    const s0 = new Date(e.start), canEdit = !!e.eid;
    const sMin = s0.getHours() * 60 + s0.getMinutes(), len = Math.round((e.end - e.start) / 60000);
    openDlg(`<h2>予定</h2>
      <label class="field"><span>名前</span><input name="xt" value="${esc(e.title)}" ${canEdit ? '' : 'disabled'}></label>
      <div class="row2">
        <label class="field"><span>日付</span><input name="xd" type="date" value="${ymd(s0)}" ${canEdit ? '' : 'disabled'}></label>
        <label class="field"><span>カレンダー</span><input value="${esc(e.cal)}" disabled></label>
      </div>
      ${e.allDay ? '<p class="small muted">終日の予定</p>' : `<div class="row2">
        <label class="field"><span>開始</span><input name="xs" type="time" step="300" value="${hhmm(sMin)}" ${canEdit ? '' : 'disabled'}></label>
        <label class="field"><span>終了</span><input name="xe" type="time" step="300" value="${hhmm(Math.min(24 * 60 - 1, sMin + len))}" ${canEdit ? '' : 'disabled'}></label></div>`}
      ${canEdit ? pickFor(e.cid, e) : ''}
      ${e.rec ? '<p class="small faint">くり返しの予定です。変更・削除はこの回だけに反映されます。</p>' : ''}
      ${canEdit ? '<p class="small faint">カレンダー上でドラッグしても動かせます。</p>' : '<p class="small warn">編集するには Apps Script を最新にしてください。</p>'}
      <div class="dlg-actions">${canEdit ? '<button class="btn ghost danger" data-dlg="xdel" type="button">削除</button>' : ''}<span class="spacer"></span>
        <button class="btn" data-dlg="cancel" type="button">閉じる</button>${canEdit ? '<button class="btn primary" type="submit">保存</button>' : ''}</div>`, act => {
      if (act === 'xdel') {
        if (!confirm(`「${e.title}」を Google カレンダーから削除します。`)) return false;
        extOps([{ op: 'xdel', cid: e.cid, eid: e.eid, start: e.start }], () => { e._gone = true; }, '削除しました');
        return;
      }
      if (act !== 'save' || !canEdit) return;
      const title = fval('xt').trim() || e.title, d = parse(fval('xd'));
      if (isNaN(d)) { toast('日付を入れてください'); return false; }
      let ns, ne;
      if (e.allDay) { ns = atMin(d, 0); ne = ns + (e.end - e.start); }
      else {
        const a = toMin(fval('xs')), b = toMin(fval('xe'));
        if (!(b > a)) { toast('終了は開始より後にしてください'); return false; }
        ns = atMin(d, a); ne = atMin(d, b);
      }
      const ops = [];
      if (title !== e.title) ops.push({ op: 'xedit', cid: e.cid, eid: e.eid, start: e.start, title });
      const color = pickedColor(), label = pickedLabel();
      // 「カレンダーの色」に戻すことは Apps Script ではできないので、色を選んだときだけ送る
      if (label && label !== (e.label || '')) ops.push({ op: 'xlabel', cid: e.cid, eid: e.eid, start: e.start, label });
      else if (color && color !== (e.color || '')) ops.push({ op: 'xcolor', cid: e.cid, eid: e.eid, start: e.start, color });
      if (ns !== e.start || ne !== e.end) ops.push({ op: 'xmove', cid: e.cid, eid: e.eid, start: e.start, newStart: ns, newEnd: ne });
      if (!ops.length) return;
      extOps(ops, () => { e.title = title; e.start = ns; e.end = ne; if (label) e.label = label; else if (color) e.color = color; }, '変更しました');
    });
  }

  // ---------- 予定を入れる・直す画面（予定の横に出す吹き出し） ----------
  // カレンダーには「下書き」のブロックを出し、時間や色を変えるとその場で動く。
  // 吹き出しを開いたまま空いているところをタップすると、下書きがそこへ動く。下の端を引っぱると長さが変わる
  const $sheet = document.createElement('dialog');
  $sheet.className = 'evsheet';
  $sheet.setAttribute('aria-label', '予定');
  document.body.appendChild($sheet);
  const $arrow = document.createElement('div');
  $arrow.className = 'es-pointer'; $arrow.hidden = true; $arrow.setAttribute('aria-hidden', 'true');
  document.body.appendChild($arrow);
  const sheetOpen = () => $sheet.open;
  const DUR_CHIPS = [[30, '30分'], [60, '1時間'], [90, '1時間半']];
  const ICON = {
    clock: '<path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="8.5"/>',
    cal: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    color: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.4-1.2-1.6-1.2-2.9 0-1 .8-1.6 1.9-1.6h2.2c2.3 0 3.8-1.6 3.8-3.6C20.5 6.8 16.7 3.5 12 3.5Z"/><circle cx="7.8" cy="11" r="1"/><circle cx="10.5" cy="7.6" r="1"/><circle cx="14.8" cy="7.6" r="1"/>',
    pin: '<path d="M12 21s6.5-5.6 6.5-11a6.5 6.5 0 1 0-13 0c0 5.4 6.5 11 6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>',
    note: '<path d="M5 6.5h14M5 11.5h14M5 16.5h9"/>',
    warn: '<path d="M12 4 2.8 19.5h18.4L12 4Z"/><path d="M12 10v4.2M12 17.2v.1"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
  };
  const icon = n => `<svg class="es-ic" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;
  const calColor = cid => {
    for (const c of Object.values(extCache)) for (const e of c.events || []) if (e.cid === cid && /^#[0-9a-f]{6}$/i.test(e.ccol || '')) return e.ccol;
    return '';
  };
  const draftColor = d => {
    const l = d.label && labelsOf(d.cid).find(x => x.id === d.label);
    return (l && l.color) || GCAL_HEX[d.color] || calColor(d.cid) || 'var(--accent)';
  };
  const hmLabel = (a, b) => `${hm(a)}〜${hm(b)}`;
  // 色の上に乗せる文字の色（明るい色には黒、暗い色には白）
  const inkOn = c => {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c || '');
    if (!m) return '#fff';
    const [r, g, b] = m.slice(1).map(h => parseInt(h, 16) / 255).map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#1b1f24' : '#fff';
  };
  const nextHalf = () => { const n = new Date(); return Math.ceil((n.getHours() * 60 + n.getMinutes() + 1) / 30) * 30; };
  const clampDay = (a, b) => {   // 1日の中におさめる（time 入力は 24:00 を持てないので 23:55 まで）
    const len = Math.max(15, b - a);
    a = Math.max(0, Math.min(24 * 60 - 20, a));
    return [a, Math.min(24 * 60 - 5, a + len)];
  };

  // 今までの予定から、よく使う名前を候補にする（色・カレンダー・長さもいっしょに）
  function suggestions(q) {
    const by = new Map();
    Object.values(extCache).forEach(c => (c.events || []).forEach(e => {
      const t = String(e.title || '').trim();
      if (!t || e._gone || /祝日|holiday/i.test(e.cal || '')) return;
      const s = by.get(t) || { title: t, n: 0, durs: {}, last: 0 };
      s.n++;
      const len = Math.round((e.end - e.start) / 60000);
      if (!e.allDay) s.durs[len] = (s.durs[len] || 0) + 1;
      if (e.start > s.last) Object.assign(s, { last: e.start, cid: e.cid, label: e.label || '', color: e.color || '', allDay: e.allDay });
      by.set(t, s);
    }));
    let list = [...by.values()];
    const k = q.trim();
    if (k) list = list.filter(s => s.title !== k && s.title.toLowerCase().includes(k.toLowerCase()));
    list.sort((p, q2) => q2.n - p.n || q2.last - p.last);
    return list.slice(0, k ? 6 : 8).map(s => {
      const top = Object.entries(s.durs).sort((p, q2) => q2[1] - p[1])[0];
      return { ...s, dur: top ? +top[0] : 60 };
    });
  }

  // その時間に重なっている予定・勉強のコマ
  function overlaps(d) {
    if (d.allDay) return [];
    const day = parse(d.day), s0 = atMin(day, d.a), e0 = atMin(day, d.b), out = [];
    const c = extCache[ymd(monday(day))];
    ((c && c.events) || []).forEach((e, n) => {
      if (e.allDay || e._gone || (d.mode === 'edit' && d.key === ymd(monday(day)) && d.n === n)) return;
      if (e.start < e0 && e.end > s0) out.push(`「${e.title}」（${msHm(e.start)}〜${msHm(e.end)}）`);
    });
    const days = weekDaysOf(day), col = diff(days[0], day);
    weekEvents(days).forEach(x => {
      if (x.col !== col || x.a == null || x.p.type !== 'study' || x.done) return;
      if (x.a < d.b && x.b > d.a) out.push(`勉強のコマ「${evName(x)}」（${hmLabel(x.a, x.b)}）`);
    });
    return out;
  }

  function colorRow(d) {
    const ls = labelsOf(d.cid);
    if (ls.length) {
      const named = ls.filter(l => l.name), plain = ls.filter(l => !l.name);
      const cur = d.label || '';
      const chip = l => `<button type="button" class="es-chip${cur === l.id ? ' on' : ''}" data-es="label" data-v="${esc(l.id)}" style="--c:${esc(l.color)}"><i></i>${esc(l.name)}</button>`;
      const dot = l => `<button type="button" class="es-dot${cur === l.id ? ' on' : ''}" data-es="label" data-v="${esc(l.id)}" style="--c:${esc(l.color)}" aria-label="${esc(l.color)}"></button>`;
      // 名前のない色は選ばせない（すでにその色の予定だけ、今の色として丸を1つ出す）
      const curPlain = plain.find(l => l.id === cur);
      return `<div class="es-chips">${!cur ? `<button type="button" class="es-chip on" style="--c:${calColor(d.cid) || 'var(--border)'}"><i></i>カレンダーの色</button>` : ''}${curPlain ? dot(curPlain) : ''}${named.map(chip).join('')}</div>`;
    }
    const cur = d.color || '';
    return `<div class="es-dots">${!cur ? `<button type="button" class="es-dot on" style="--c:${calColor(d.cid) || 'var(--border)'}" aria-label="カレンダーの色"></button>` : ''}${GCAL_COLORS.filter(([v]) => GCAL_HEX[v]).map(([v, nm]) => `<button type="button" class="es-dot${cur === v ? ' on' : ''}" data-es="color" data-v="${v}" style="--c:${GCAL_HEX[v]}" aria-label="${nm}"></button>`).join('')}</div>`;
  }

  function sheetHtml() {
    const d = ui.draft, cals = (S.settings.gcal.read || []).filter(c => !/祝日|holiday/i.test(c.name));
    const day = parse(d.day), edit = d.mode === 'edit';
    const sug = edit ? [] : suggestions(d.title || '');
    const warn = overlaps(d);
    const len = d.b - d.a;
    return `<div class="es-top">
        <button type="button" class="icon-btn" data-es="close" aria-label="閉じる">${icon('close')}</button>
        <span class="es-h">${edit ? '予定を編集' : '予定を追加'}</span>
        <button type="button" class="btn primary" data-es="save">保存</button>
      </div>
      <div class="es-body">
        <input class="es-title" name="es-title" placeholder="タイトルを追加" value="${esc(d.title || '')}" autocomplete="off" enterkeyhint="done">
        <div class="es-sugg" ${sug.length ? '' : 'hidden'}>${sug.map((s, i) => `<button type="button" class="es-chip sugg" data-es="sugg" data-i="${i}" style="--c:${esc(draftColor(s))}"><i></i>${esc(s.title)}</button>`).join('')}</div>
        <div class="es-sec">
          <label class="es-row es-allday">${icon('clock')}<span class="es-lbl">終日<small>${d.allDay ? '時間を決めない予定' : '時間を決めて入れる'}</small></span>
            <span class="es-switch"><input type="checkbox" role="switch" aria-checked="${d.allDay}" aria-label="終日" data-es="allday" ${d.allDay ? 'checked' : ''}><span class="trk"><span class="knob"></span></span></span></label>
          <div class="es-row es-when">
            <span class="es-ic-sp"></span>
            <label class="es-date"><span>${mdw(day)}</span><input type="date" data-es="date" value="${d.day}" aria-label="日付"></label>
            ${d.allDay ? '' : `<span class="es-times"><input type="time" step="300" data-es="start" value="${hhmm(d.a)}" aria-label="開始"><span class="es-arrow">→</span><input type="time" step="300" data-es="end" value="${hhmm(d.b)}" aria-label="終了"></span>`}
          </div>
          ${d.allDay ? '' : `<div class="es-row es-durs"><span class="es-ic-sp"></span><div class="es-chips">${DUR_CHIPS.map(([m, t]) => `<button type="button" class="es-chip${len === m ? ' on' : ''}" data-es="dur" data-v="${m}">${t}</button>`).join('')}</div></div>`}
          ${warn.length ? `<div class="es-row es-warn">${icon('warn')}<span>${esc(warn.slice(0, 2).join('、'))}${warn.length > 2 ? ` ほか${warn.length - 2}件` : ''}と重なっています</span></div>` : ''}
        </div>
        <div class="es-sec">
          <div class="es-row">${icon('cal')}${edit
            ? `<span class="es-calname"><i style="--c:${calColor(d.cid) || 'var(--border)'}"></i>${esc(d.cal || '')}</span>`
            : `<label class="es-sel"><i style="--c:${calColor(d.cid) || 'var(--border)'}"></i><select data-es="cal" aria-label="カレンダー">${cals.map(c => `<option value="${esc(c.id)}" ${c.id === d.cid ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>`}</div>
          <div class="es-row es-colors">${icon('color')}<div class="es-colorbox">${colorRow(d)}</div></div>
        </div>
        <div class="es-sec">
          <div class="es-row">${icon('pin')}<input class="es-in" data-es="loc" placeholder="場所を追加" value="${esc(d.loc || '')}" autocomplete="off"></div>
          <div class="es-row es-top-al">${icon('note')}<textarea class="es-in" data-es="desc" rows="2" placeholder="説明を追加">${esc(d.desc || '')}</textarea></div>
        </div>
        ${edit ? `<div class="es-foot">${d.rec ? '<p class="small faint">くり返しの予定です。変更・削除はこの回だけに反映されます。</p>' : ''}<button type="button" class="btn ghost danger" data-es="delete">この予定を削除</button></div>` : ''}
      </div>`;
  }

  function drawSheet() {
    const scroll = $sheet.scrollTop;
    $sheet.innerHTML = sheetHtml();
    $sheet.scrollTop = scroll;
    placeSoon(true);
  }

  // カレンダーの上の下書きを、描き直さずに動かす（日や終日が変わったときだけ描き直す）
  function draftHtml(d, mode) {
    const lbl = d.allDay ? '終日' : hmLabel(d.a, d.b);
    const t = `<i class="tm num">${lbl}</i><b>${esc(d.title || '（タイトルなし）')}</b>`;
    const c = draftColor(d), ink = `--ink:${inkOn(c)}`;
    if (d.allDay) return `<div class="ev draft chip" data-action="draft" data-day="${d.day}" data-ad="1" style="--c:${c};${ink}" aria-hidden="true">${t}</div>`;
    const ph = mode === 'day' ? DAY_HPX : HOUR_PX;
    const a = Math.max(MIN_H * 60, d.a), top = (a - MIN_H * 60) / 60 * ph, hgt = Math.max(14, (d.b - a) / 60 * ph - 2);
    return `<div class="ev draft" data-action="draft" data-day="${d.day}" data-ad="0" style="top:${top.toFixed(1)}px;height:${hgt.toFixed(1)}px;left:2px;width:calc(100% - 5px);--c:${c};${ink}" aria-hidden="true">${t}<i class="rz up" data-rz="draft" data-edge="top"></i><i class="rz" data-rz="draft"></i></div>`;
  }
  function updateDraft() {
    const d = ui.draft;
    if (!d || ui.tab !== 'cal') return;
    const shown = (ui.calDays || []).some(x => ymd(x) === d.day);
    if (!shown) {   // 日付を変えて、表示中の週（日）の外に出たら、その週（日）へ移る
      if (ui.day) ui.day = d.day;
      else ui.calOffset = weekOf(parse(d.day)) - weekOf(today());
      render(); return;
    }
    const el = $view.querySelector('.ev.draft');
    // 日や終日が変わって下書きが別の段に移ったら描き直し、画面の外に出ていたら見える所までスクロールする（吹き出しの矢印が指せるように）
    if (!el || el.dataset.day !== d.day || el.dataset.ad !== (d.allDay ? '1' : '0')) { render(); showDraft(); placeSheet(); return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = draftHtml(d, ui.day ? 'day' : 'week');
    const n = tmp.firstElementChild;
    el.style.cssText = n.style.cssText;
    el.innerHTML = n.innerHTML;
    syncTimes();
    placeSheet();
  }
  // 吹き出しの時刻の欄と長さのボタンを、下書きに合わせる（引っぱっている間もその場で変わる）
  function syncTimes() {
    const d = ui.draft;
    if (!d || !sheetOpen() || d.allDay) return;
    const st = $sheet.querySelector('[data-es=start]'), en = $sheet.querySelector('[data-es=end]');
    if (st && document.activeElement !== st) st.value = hhmm(d.a);
    if (en && document.activeElement !== en) en.value = hhmm(d.b);
    $sheet.querySelectorAll('[data-es=dur]').forEach(c => c.classList.toggle('on', +c.dataset.v === d.b - d.a));
  }

  // 吹き出しを、下書き（予定）のとなりに置く。横に入らなければ上か下。矢印で予定を指す
  function placeSheet(glide) {
    if (!sheetOpen()) { $arrow.hidden = true; return; }
    // 中身が変わって位置が変わるときはすべらせて動かす。スクロールについていくときはそのまま
    $sheet.classList.toggle('glide', !!glide); $arrow.classList.toggle('glide', !!glide);
    const anchor = $view.querySelector('.ev.draft');
    const vw = document.documentElement.clientWidth, vh = window.visualViewport ? visualViewport.height : innerHeight;
    const W = Math.min(380, vw - 16), H = $sheet.scrollHeight + 4, gap = 12;
    const topLim = 8, botLim = vh - 8;
    $sheet.style.width = `${W}px`;
    if (!anchor) {   // 予定が画面にないときは真ん中
      const h = Math.min(H, botLim - topLim);
      Object.assign($sheet.style, { left: `${(vw - W) / 2}px`, top: `${Math.max(topLim, (vh - h) / 2)}px`, maxHeight: `${h}px` });
      $arrow.hidden = true; return;
    }
    const r = anchor.getBoundingClientRect();
    let side;
    if (vw - r.right - gap >= W + 8) side = 'right';
    else if (r.left - gap >= W + 8) side = 'left';
    else side = (botLim - r.bottom) >= Math.min(H, 360) || (botLim - r.bottom) >= (r.top - topLim) ? 'below' : 'above';
    let left, top, h, ax, ay;
    if (side === 'right' || side === 'left') {
      h = Math.min(H, botLim - topLim);
      left = side === 'right' ? r.right + gap : r.left - gap - W;
      top = Math.max(topLim, Math.min(botLim - h, r.top - 24));
      ay = Math.max(r.top, Math.min(r.bottom, r.top + 16)); ax = side === 'right' ? left : left + W;
    } else {
      h = Math.min(H, side === 'below' ? botLim - r.bottom - gap : r.top - gap - topLim);
      h = Math.max(h, 160);
      left = Math.max(8, Math.min(vw - W - 8, r.left + r.width / 2 - W / 2));
      top = side === 'below' ? Math.min(r.bottom + gap, botLim - h) : Math.max(topLim, r.top - gap - h);
      ax = Math.max(left + 20, Math.min(left + W - 20, r.left + r.width / 2)); ay = side === 'below' ? top : top + h;
    }
    Object.assign($sheet.style, { left: `${left}px`, top: `${top}px`, maxHeight: `${h}px` });
    $sheet.dataset.side = side;
    $arrow.dataset.side = side;
    $arrow.style.left = `${ax}px`; $arrow.style.top = `${ay}px`;
    $arrow.hidden = false;
  }
  let placeRaf = 0;
  const placeSoon = glide => { cancelAnimationFrame(placeRaf); placeRaf = requestAnimationFrame(() => placeSheet(glide)); };
  addEventListener('scroll', () => { if (sheetOpen()) placeSoon(false); }, { passive: true });
  addEventListener('resize', () => { if (sheetOpen()) placeSoon(false); });
  // 予定が隠れていたら（画面の外・上のヘッダーの下）、見える位置までスクロールする
  // 自前のなめらかなスクロール（ブラウザごとの差をなくす）。始めは速く、終わりはゆっくり止まる
  let glideRaf = 0;
  function glideScroll(dy) {
    cancelAnimationFrame(glideRaf);
    const y0 = scrollY, y1 = Math.max(0, Math.min(document.documentElement.scrollHeight - innerHeight, y0 + dy));
    if (Math.abs(y1 - y0) < 1) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { scrollTo(0, y1); return; }
    const t0 = performance.now(), dur = Math.min(520, 260 + Math.abs(y1 - y0) * 0.25);
    const step = now => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - (1 - k) ** 3;
      scrollTo(0, y0 + (y1 - y0) * e);
      if (k < 1) glideRaf = requestAnimationFrame(step);
    };
    glideRaf = requestAnimationFrame(step);
  }
  addEventListener('wheel', () => cancelAnimationFrame(glideRaf), { passive: true });
  addEventListener('touchstart', () => cancelAnimationFrame(glideRaf), { passive: true });
  function showDraft() {
    const el = $view.querySelector('.ev.draft');
    if (!el) return;
    const r = el.getBoundingClientRect();
    const head = Math.max(60, (document.querySelector('.cal-sticky, .daystrip')?.getBoundingClientRect().bottom || 60));
    const vh = window.visualViewport ? visualViewport.height : innerHeight;
    if (r.top >= head + 8 && r.top <= vh - 160) return;
    // なめらかにスクロールし、その間も吹き出しは予定について動く（scroll のたびに置き直す）
    glideScroll(r.top - head - Math.min(120, vh * 0.15));
    placeSheet();
  }
  // 下書きが、シートに隠れない位置に来るようにスクロールする
  function revealDraft() {
    placeSoon(); return;   // 吹き出しは予定のとなりに出るので、スクロールで避けなくてよい
    requestAnimationFrame(() => {
      const el = $view.querySelector('.ev.draft');
      if (!el || !sheetOpen()) return;
      // シートは出てくる途中で動いているので、置き終わった位置で計算する
      const r = el.getBoundingClientRect(), top = (window.visualViewport ? visualViewport.height : innerHeight) - $sheet.offsetHeight;
      const headH = 64 + (document.querySelector('.cal-sticky')?.getBoundingClientRect().height || 0);
      if (r.bottom > top - 12) scrollBy({ top: Math.min(r.bottom - top + 40, r.top - headH - 10), behavior: 'smooth' });
      else if (r.top < headH) scrollBy({ top: r.top - headH - 20, behavior: 'smooth' });
    });
  }

  function openSheet(d) {
    ui.draft = d;
    document.body.classList.add('sheet-open');
    drawSheet();
    if (!sheetOpen()) $sheet.show();
    render();
    showDraft(); placeSheet();
    if (matchMedia('(pointer: fine)').matches && d.mode === 'add') $sheet.querySelector('.es-title')?.focus();
  }
  function closeSheet(force) {
    if (!sheetOpen()) return true;
    const d = ui.draft;
    if (!force && d && d.mode === 'add' && (d.title || d.loc || d.desc) && !confirm('この予定は保存されていません。破棄しますか？')) return false;
    ui.draft = null;
    $sheet.close();
    $arrow.hidden = true;
    document.body.classList.remove('sheet-open');
    render();
    return true;
  }

  function newDraft(day, a, b, allDay) {
    const cals = (S.settings.gcal.read || []).filter(c => !/祝日|holiday/i.test(c.name));
    if (!cals.length) return null;
    const pick = cals.find(c => c.id === S.settings.gcal.addCal) || cals[0];
    [a, b] = clampDay(a, b);
    return { mode: 'add', day: ymd(day), a, b, allDay: !!allDay, title: '', cid: pick.id, label: '', color: '', loc: '', desc: '' };
  }
  function openAdd(day, a, allDay, b) {
    // シートを開いたまま別の場所をタップしたら、長さはそのままで下書きを動かす
    if (sheetOpen() && ui.draft && ui.draft.mode === 'add') {
      const d = ui.draft, len = d.b - d.a;
      d.day = ymd(day); d.allDay = !!allDay;
      if (!allDay) [d.a, d.b] = clampDay(a, a + (b != null ? b - a : len));
      drawSheet(); updateDraft(); revealDraft();
      return;
    }
    if (sheetOpen() && !closeSheet()) return;
    const d = newDraft(day, a, b != null ? b : a + 60, allDay);
    if (d) openSheet(d);
  }
  function openEdit(key, n) {
    const e = ((extCache[key] || {}).events || [])[n];
    if (!e) return;
    if (sheetOpen() && !closeSheet()) return;
    const s0 = new Date(e.start);
    const a = s0.getHours() * 60 + s0.getMinutes();
    openSheet({
      mode: 'edit', key, n, day: ymd(s0), a, b: Math.min(24 * 60 - 5, a + Math.round((e.end - e.start) / 60000)), allDay: !!e.allDay,
      title: e.title, cid: e.cid, cal: e.cal, label: e.label || '', color: e.color || '', loc: e.loc || '', desc: e.desc || '', rec: e.rec,
      orig: { title: e.title, loc: e.loc || '', desc: e.desc || '', label: e.label || '', color: e.color || '' },
    });
  }

  function saveSheet() {
    const d = ui.draft;
    if (!d) return;
    const title = (d.title || '').trim();
    if (d.mode === 'add' && !title) { toast('タイトルを入れてください'); $sheet.querySelector('.es-title')?.focus(); return; }
    if (!d.allDay && !(d.b > d.a)) { toast('終わりは始まりより後にしてください'); return; }
    const day = parse(d.day);
    let start, end;
    if (d.allDay) { start = atMin(day, 0); end = atMin(addDays(day, 1), 0); }
    else { start = atMin(day, d.a); end = atMin(day, d.b); }
    if (d.mode === 'add') {
      S.settings.gcal.addCal = d.cid; persist();
      const cal = (S.settings.gcal.read || []).find(c => c.id === d.cid);
      const ev = { title, start, end, allDay: d.allDay, cal: cal ? cal.name : '', cid: d.cid, color: d.color, label: d.label, loc: d.loc, desc: d.desc, ccol: calColor(d.cid) };
      closeSheet(true);
      extOps([{ op: 'xadd', cid: d.cid, title, start, end, allDay: d.allDay, color: d.color, label: d.label, loc: d.loc, desc: d.desc }], () => {
        const key = ymd(monday(day));
        if (extCache[key]) extCache[key].events.push(ev);
      }, `「${title}」を追加しました`);
      return;
    }
    const e = ((extCache[d.key] || {}).events || [])[d.n];
    if (!e) { closeSheet(true); return; }
    const o = d.orig, ops = [], edit = { cid: e.cid, eid: e.eid, start: e.start };
    const tt = title || e.title, ch = {};
    if (tt !== o.title) ch.title = tt;
    if ((d.loc || '') !== o.loc) ch.loc = d.loc || '';
    if ((d.desc || '') !== o.desc) ch.desc = d.desc || '';
    if (Object.keys(ch).length) ops.push({ op: 'xedit', ...edit, ...ch });
    if (d.label && d.label !== o.label) ops.push({ op: 'xlabel', ...edit, label: d.label });
    else if (d.color && d.color !== o.color) ops.push({ op: 'xcolor', ...edit, color: d.color });
    if (start !== e.start || end !== e.end) ops.push({ op: 'xmove', ...edit, newStart: start, newEnd: end });
    closeSheet(true);
    if (!ops.length) return;
    extOps(ops, () => {
      Object.assign(e, { title: tt, start, end, allDay: d.allDay, loc: d.loc, desc: d.desc });
      if (d.label) e.label = d.label; else if (d.color) e.color = d.color;
    }, '変更しました');
  }

  $sheet.addEventListener('click', ev => {
    const b = ev.target.closest('[data-es]');
    if (!b) return;
    const d = ui.draft, k = b.dataset.es;
    if (!d) return;
    if (k === 'close') { closeSheet(); return; }
    if (k === 'save') { saveSheet(); return; }
    if (k === 'delete') {
      const e = ((extCache[d.key] || {}).events || [])[d.n];
      if (!e || !confirm(`「${e.title}」を Google カレンダーから削除します。`)) return;
      closeSheet(true);
      extOps([{ op: 'xdel', cid: e.cid, eid: e.eid, start: e.start }], () => { e._gone = true; }, '削除しました');
      return;
    }
    if (k === 'dur') { [d.a, d.b] = clampDay(d.a, d.a + +b.dataset.v); }
    else if (k === 'label') { d.label = b.dataset.v; d.color = ''; }
    else if (k === 'color') { d.color = b.dataset.v; d.label = ''; }
    else if (k === 'morecolors') { d.moreColors = !d.moreColors; }
    else if (k === 'sugg') {
      const s = suggestions(d.title || '')[+b.dataset.i];
      if (!s) return;
      d.title = s.title;
      if ((S.settings.gcal.read || []).some(c => c.id === s.cid)) d.cid = s.cid;
      d.label = s.cid === d.cid ? s.label : ''; d.color = s.cid === d.cid ? s.color : '';
      d.allDay = !!s.allDay;
      if (!d.allDay) [d.a, d.b] = clampDay(d.a, d.a + s.dur);
    } else return;
    drawSheet(); updateDraft(); revealDraft();
  });
  $sheet.addEventListener('input', ev => {
    const t = ev.target, d = ui.draft;
    if (!d) return;
    if (t.classList.contains('es-title')) {
      d.title = t.value;
      if (d.mode === 'add') {   // 候補だけ入れ替える（入力中の欄は描き直さない）
        const sug = suggestions(d.title), box = $sheet.querySelector('.es-sugg');
        box.hidden = !sug.length;
        box.innerHTML = sug.map((s, i) => `<button type="button" class="es-chip sugg" data-es="sugg" data-i="${i}" style="--c:${esc(draftColor(s))}"><i></i>${esc(s.title)}</button>`).join('');
      }
      updateDraft();
    } else if (t.dataset.es === 'loc') d.loc = t.value;
    else if (t.dataset.es === 'desc') d.desc = t.value;
  });
  $sheet.addEventListener('change', ev => {
    const t = ev.target, d = ui.draft, k = t.dataset.es;
    if (!d || !k) return;
    if (k === 'allday') {   // つまみが動き終わってから描き直す（すぐ描き直すと動きが見えない）
      d.allDay = t.checked; t.setAttribute('aria-checked', String(t.checked));
      updateDraft();
      setTimeout(() => { if (ui.draft === d) { drawSheet(); updateDraft(); } }, 300);
      return;
    }
    if (k === 'date') { if (!t.value) return; d.day = t.value; }
    else if (k === 'start') { if (!t.value) return; [d.a, d.b] = clampDay(toMin(t.value), toMin(t.value) + (d.b - d.a)); }   // 長さはそのまま
    else if (k === 'end') { if (!t.value) return; const e1 = toMin(t.value); d.b = e1 > d.a ? e1 : Math.min(24 * 60 - 5, d.a + 30); }
    else if (k === 'cal') { d.cid = t.value; d.label = ''; d.color = ''; }
    else return;
    drawSheet(); updateDraft(); revealDraft();
  });
  $sheet.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); closeSheet(); }
    if (ev.key === 'Enter' && ev.target.classList.contains('es-title') && !ev.isComposing) { ev.preventDefault(); ev.target.blur(); }
  });
  $sheet.addEventListener('cancel', ev => { ev.preventDefault(); closeSheet(); });
  // 吹き出しの外をタップしたら閉じる（カレンダーの中のタップは、下書きを動かす・別の予定を開く側で扱う）
  document.addEventListener('pointerdown', ev => {
    if (!sheetOpen() || $sheet.contains(ev.target)) return;
    if (ev.target.closest('#view .cal-body .col, #view .cal-allday .ad, #view .ev, .tabs, [data-action="settings"]')) return;
    closeSheet();
  }, true);
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && sheetOpen() && !$sheet.contains(ev.target)) closeSheet(); });
  // キーボードが出たら、その上にシートを持ち上げる
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const fit = () => {
      document.documentElement.style.setProperty('--kb', `${Math.max(0, innerHeight - vv.height - vv.offsetTop)}px`);
      document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
    };
    vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit();
  }

  // 空いているところを長押し（マウスは押したまま）して上下に動かすと、その長さで予定を作る
  let mk = null;
  function mkStart() {
    if (!mk || mk.active) return;
    clearTimeout(mk.timer);
    mk.active = true;
    if (navigator.vibrate) navigator.vibrate(10);
    if (sheetOpen() && ui.draft && ui.draft.mode !== 'add' && !closeSheet()) { mk = null; return; }
    const day = ui.calDays[mk.col];
    if (sheetOpen() && ui.draft) {
      Object.assign(ui.draft, { day: ymd(day), allDay: false, a: mk.a0, b: mk.a0 + 30 });
      updateDraft();
    } else {
      ui.draft = newDraft(day, mk.a0, mk.a0 + 30, false);
      if (!ui.draft) { mk = null; return; }
      render();
    }
  }
  function mkMinute(y) {
    const cell = $view.querySelectorAll('.cal-body .col')[ui.day ? 0 : mk.col];
    if (!cell) return mk.a0;
    return MIN_H * 60 + (y - cell.getBoundingClientRect().top) / hpx * 60;
  }


  // ---------- コマが終わったら、音なしで目立たせる（画面全体のお知らせ・振動・タブ名の点滅） ----------
  const finishShown = new Set();
  let lastFinishCheck = Date.now(), titleBlink = 0;

  // 今日の勉強のコマ（時間つき・今日に置いてあるもの）
  function todayStudy() {
    const t = today(), days = weekDaysOf(t);
    return weekEvents(days).filter(x => x.p.type === 'study' && x.a != null && diff(t, x.shown) === 0)
      .sort((p, q) => p.a - q.a);
  }

  function checkFinished(lookbackMs) {
    if (document.hidden) return;
    if ($dlg.open || sheetOpen() || drag || document.querySelector('.finish')) return;   // 閉じたあとに知らせる（時刻は進めない）
    const now = Date.now(), since = lookbackMs ? now - lookbackMs : lastFinishCheck;
    lastFinishCheck = now;
    const t = today();
    const ended = todayStudy().filter(x => {
      const end = atMin(t, x.b);
      return end > since && end <= now && !x.done && !finishShown.has(`${x.key}|${x.uid}`);
    });
    if (ended.length) showFinish(ended[ended.length - 1]);   // 一番最近終わったもの
  }

  const POP_CONFETTI = ['accent', 'sun', 'lavender', 'lime', 'orange', 'sky'];
  function showFinish(x) {
    finishShown.add(`${x.key}|${x.uid}`);
    const t = today(), nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const next = todayStudy().find(y => y.a >= nowMin && y.uid !== x.uid);
    const mins = Math.round(x.hours * 60);
    const confetti = Array.from({ length: 28 }, (_, i) =>
      `<i style="left:${(i * 37) % 100}%;animation-delay:${(i % 7) * 0.12}s;--r:${(i * 53) % 360}deg;--h:${(i * 47) % 360};--pc:var(--${POP_CONFETTI[i % POP_CONFETTI.length]})"></i>`).join('');
    const wrap = document.createElement('div');
    wrap.className = 'finish';
    wrap.style.setProperty('--c', x.c || 'var(--accent)');
    wrap.setAttribute('role', 'alertdialog');
    wrap.setAttribute('aria-label', 'コマが終わりました');
    wrap.innerHTML = `<div class="fin-flash"></div><div class="fin-confetti" aria-hidden="true">${confetti}</div>
      <div class="fin-card">
        <div class="fin-big">✓</div>
        <h2>${mins}分おつかれさま！</h2>
        <p class="fin-what">${esc(evName(x))}${x.u && x.u.k != null ? ` ${'①②③④'[x.u.k]}` : ''}　<span class="num">${hm(x.a)}〜${hm(x.b)}</span></p>
        ${next ? `<p class="fin-next">${next.a - nowMin <= 5 ? '5分休憩' : '休憩'} → 次は <b>${esc(evName(next))}</b>（<span class="num">${hm(next.a)}〜</span>）<br>あと <b class="num" data-cd="${atMin(t, next.a)}">${fmtLeft(atMin(t, next.a) - Date.now())}</b></p>` : '<p class="fin-next">今日のコマはこれで最後です</p>'}
        <div class="fin-btns">
          <button class="btn fin-later" type="button" data-fin="close">まだ途中</button>
          <button class="btn primary" type="button" data-fin="done">終わった（＋${fmtGain(x.hours)}）</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('[data-fin="done"]').focus();
    if (navigator.vibrate) navigator.vibrate([250, 120, 250, 120, 500]);
    const base = document.title;
    let on = false;
    clearInterval(titleBlink);
    titleBlink = setInterval(() => { on = !on; document.title = on ? '⏰ コマ終了' : base; }, 1000);
    const tick = setInterval(() => {
      wrap.querySelectorAll('[data-cd]').forEach(el => { el.textContent = fmtLeft(+el.dataset.cd - Date.now()); });
    }, 1000);
    const close = () => {
      clearInterval(titleBlink); clearInterval(tick); document.title = base;
      wrap.classList.add('out');
      setTimeout(() => wrap.remove(), 250);
    };
    wrap.addEventListener('click', e => {
      const b = e.target.closest('[data-fin]');
      if (!b) return;
      if (b.dataset.fin === 'done') {
        if (!isDone(x.key, x.u)) toggleCheck(x.key, x.uid);
        render(); toast(`記録しました（＋${fmtGain(x.hours)}）`);
      }
      close();
    });
  }

  setInterval(() => checkFinished(0), 1000);
  // アプリを閉じている間に終わったコマも、30分以内なら開いたときに知らせる
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(() => checkFinished(30 * 60000), 300); });
  setTimeout(() => checkFinished(30 * 60000), 1500);

  // ---------- 左右のスワイプで週・日を切り替える（Googleカレンダーと同じ） ----------
  let swipe = null;
  $view.addEventListener('touchstart', e => {
    if (ui.tab !== 'cal' || e.touches.length !== 1 || !e.target.closest('.cal, .dayview')) { swipe = null; return; }
    const t = e.touches[0];
    swipe = { x: t.clientX, y: t.clientY, at: Date.now() };
  }, { passive: true });
  $view.addEventListener('touchend', e => {
    if (!swipe || (drag && drag.active) || (mk && mk.active) || rz || $dlg.open || sheetOpen()) { swipe = null; return; }
    const t = e.changedTouches[0], dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
    const quick = Date.now() - swipe.at < 700;
    swipe = null;
    if (!quick || Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 2) return;   // 縦のスクロールは無視
    const v = dx < 0 ? 1 : -1;   // 左へスワイプ → 次
    if (ui.day) { ui.day = ymd(addDays(parse(ui.day), v)); render(); return; }
    const w = weekOf(ui.calDays ? ui.calDays[0] : today());
    if ((v < 0 && w <= 1) || (v > 0 && w >= N)) return;
    ui.calOffset += v; render();
    toast(v > 0 ? '次の週' : '前の週');
  }, { passive: true });

  // ---------- ドラッグで移動（同じ週の中だけ） ----------
  // マウスは押して動かすとすぐ、タッチは長押ししてから動かす（普通のスクロールと区別するため）
  let drag = null;
  let dragEndedAt = 0;
  const LONG_PRESS = 350;

  // ---------- 下の端を引っぱって長さを変える（Googleカレンダーと同じ） ----------
  let rz = null;
  const RZ_SNAP = 5;   // 長さを変えるのは5分刻み
  $view.addEventListener('pointerdown', e => {
    const h = e.target.closest('.rz');
    if (!h || e.button > 0) return;
    const el = h.closest('.ev'), cell = el && el.closest('.col');
    if (!el || !cell) return;
    e.stopImmediatePropagation(); e.preventDefault();
    let a, b, ev2 = null;
    if (h.dataset.rz === 'draft') { if (!ui.draft) return; a = ui.draft.a; b = ui.draft.b; }
    else {
      ev2 = ((extCache[el.dataset.k] || {}).events || [])[+el.dataset.n];
      if (!ev2) return;
      const s0 = new Date(ev2.start); a = s0.getHours() * 60 + s0.getMinutes(); b = a + Math.round((ev2.end - ev2.start) / 60000);
    }
    rz = { id: e.pointerId, el, cell, kind: h.dataset.rz, top: h.dataset.edge === 'top', ev: ev2, a0: a, a, b0: b, b, moved: false };
    el.classList.add('resizing');
    try { h.setPointerCapture(e.pointerId); } catch (err) { /* 古いブラウザ */ }
  });
  addEventListener('pointermove', e => {
    if (!rz || e.pointerId !== rz.id) return;
    e.preventDefault();
    const m = Math.round((MIN_H * 60 + (e.clientY - rz.cell.getBoundingClientRect().top) / hpx * 60) / RZ_SNAP) * RZ_SNAP;
    // 上の端は始まり、下の端は終わりを動かす（5分刻み、5分より短くはしない）
    const a = rz.top ? Math.max(MIN_H * 60, Math.min(rz.b - RZ_SNAP, m)) : rz.a;
    const b = rz.top ? rz.b : Math.max(rz.a + RZ_SNAP, Math.min(24 * 60 - 5, m));
    if (a === rz.a && b === rz.b) return;
    rz.a = a; rz.b = b; rz.moved = true;
    if (rz.kind === 'draft') { ui.draft.a = a; ui.draft.b = b; updateDraft(); return; }
    const top = Math.max(MIN_H * 60, a);
    rz.el.style.top = `${((top - MIN_H * 60) / 60 * hpx).toFixed(1)}px`;
    rz.el.style.height = `${((b - top) / 60 * hpx - 2).toFixed(1)}px`;
    let tip = rz.el.querySelector('.gt');
    if (!tip) { tip = document.createElement('i'); tip.className = 'gt'; rz.el.prepend(tip); }
    tip.textContent = `${hm(a)}〜${hm(b)}`;
  }, { passive: false });
  const endResize = (e, ok) => {
    if (!rz || e.pointerId !== rz.id) return;
    const r = rz; rz = null;
    r.el.classList.remove('resizing');
    if (!r.moved) return;
    dragEndedAt = Date.now();
    if (r.kind === 'draft') { if (ok) drawSheet(); return; }
    if (!ok || (r.a === r.a0 && r.b === r.b0)) { render(); return; }
    const e2 = r.ev, ns = e2.start + (r.a - r.a0) * 60000, ne = e2.start + (r.b - r.a0) * 60000;
    extOps([{ op: 'xmove', cid: e2.cid, eid: e2.eid, start: e2.start, newStart: ns, newEnd: ne }], () => { e2.start = ns; e2.end = ne; }, `「${e2.title}」を ${hm(r.a)}〜${hm(r.b)} にしました`);
  };
  addEventListener('pointerup', e => endResize(e, true));
  addEventListener('pointercancel', e => endResize(e, false));

  $view.addEventListener('pointerdown', e => {
    if (!e.target.closest('.ev') && e.button <= 0 && ui.tab === 'cal' && ui.calDays && extOn()) {
      const cell = e.target.closest('.cal-body .col');
      if (cell) {
        const m = MIN_H * 60 + (e.clientY - cell.getBoundingClientRect().top) / hpx * 60;
        mk = { id: e.pointerId, mouse: e.pointerType === 'mouse', x0: e.clientX, y0: e.clientY, col: +cell.dataset.col, a0: Math.floor(m / 15) * 15, active: false };
        if (!mk.mouse) mk.timer = setTimeout(mkStart, LONG_PRESS);
        return;
      }
    }
    const el = e.target.closest('.ev[data-movable]');
    if (!el || e.button > 0 || ui.tab !== 'cal') return;
    drag = { el, id: e.pointerId, mouse: e.pointerType === 'mouse', x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, active: false };
    if (!drag.mouse) drag.timer = setTimeout(startDrag, LONG_PRESS);
  });
  addEventListener('pointermove', e => {
    if (mk && e.pointerId === mk.id) {
      if (!mk.active) {
        const dist = Math.hypot(e.clientX - mk.x0, e.clientY - mk.y0);
        if (mk.mouse && dist > 4) mkStart();
        else if (!mk.mouse && dist > 8) { clearTimeout(mk.timer); mk = null; }   // 長押し前に動いた＝スクロール
        if (!mk || !mk.active) return;
      }
      e.preventDefault();
      const s5 = Math.max(0, Math.min(24 * 60 - 5, Math.round(mkMinute(e.clientY) / 5) * 5));
      const [a, b] = s5 >= mk.a0 ? [mk.a0, Math.max(mk.a0 + 15, s5)] : [s5, mk.a0 + 15];
      if (ui.draft && (ui.draft.a !== a || ui.draft.b !== b)) { ui.draft.a = a; ui.draft.b = b; updateDraft(); }
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    drag.x = e.clientX; drag.y = e.clientY;
    if (!drag.active) {
      const dist = Math.hypot(drag.x - drag.x0, drag.y - drag.y0);
      if (drag.mouse && dist > 4) startDrag();
      else if (!drag.mouse && dist > 8) cancelPress();   // 長押し前に指が動いた＝スクロール
      return;
    }
    e.preventDefault();
    placeGhost();
  }, { passive: false });
  addEventListener('pointerup', e => {
    if (mk && e.pointerId === mk.id) {
      clearTimeout(mk.timer);
      const was = mk.active; mk = null;
      if (!was || !ui.draft) return;
      dragEndedAt = Date.now();
      if (sheetOpen()) { drawSheet(); revealDraft(); } else openSheet(ui.draft);
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.active) endDrag(true); else cancelPress();
  });
  addEventListener('pointercancel', e => {
    if (mk && e.pointerId === mk.id) {
      clearTimeout(mk.timer);
      if (mk.active && !sheetOpen()) { ui.draft = null; render(); }
      mk = null; return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.active) endDrag(false); else cancelPress();
  });
  // ドラッグ中は画面がスクロールしないように
  addEventListener('touchmove', e => { if ((drag && drag.active) || (mk && mk.active) || rz) e.preventDefault(); }, { passive: false });
  $view.addEventListener('contextmenu', e => { if (e.target.closest('.ev')) e.preventDefault(); });

  function cancelPress() {
    if (drag) clearTimeout(drag.timer);
    drag = null;
  }

  function startDrag() {
    if (!drag || drag.active) return;
    clearTimeout(drag.timer);
    const el = drag.el, r = el.getBoundingClientRect();
    drag.active = true;
    drag.allDay = el.dataset.allday === '1';
    drag.flex = el.dataset.flex === '1';
    drag.dur = +el.dataset.dur;
    drag.grabY = drag.flex && drag.allDay ? 8 : drag.y0 - r.top;
    drag.cvar = el.style.getPropertyValue('--c');
    const g = el.cloneNode(true);
    g.classList.add('ghost');
    g.removeAttribute('data-action');
    g.setAttribute('aria-hidden', 'true');
    g.insertAdjacentHTML('afterbegin', '<i class="gt"></i>');
    drag.ghost = g;
    el.classList.add('drag-src');
    document.body.classList.add('dragging');
    try { el.setPointerCapture(drag.id); } catch (err) { /* 古いブラウザ */ }
    if (navigator.vibrate) navigator.vibrate(10);
    placeGhost();
    drag.raf = requestAnimationFrame(autoScroll);
  }

  // 指（マウス）の位置から、置き先の曜日と時刻を決める
  function placeGhost() {
    let allDay = drag.allDay;
    if (drag.flex) {   // 時間の欄の上に来たら時間つき、それより上なら「終日」
      const body = $view.querySelector('.cal-body');
      allDay = !body || drag.y < body.getBoundingClientRect().top;
    }
    if (drag.flex && drag.ghost.dataset.zone !== String(allDay)) {
      drag.ghost.dataset.zone = String(allDay);
      drag.ghost.style.cssText = drag.cvar ? `--c:${drag.cvar}` : '';
    }
    const sel = allDay ? '.cal-allday .ad' : '.cal-body .col';
    const cells = [...$view.querySelectorAll(sel)];
    if (!cells.length) return;
    let k = cells.findIndex(c => { const r = c.getBoundingClientRect(); return drag.x >= r.left && drag.x < r.right; });
    if (k < 0) k = drag.x < cells[0].getBoundingClientRect().left ? 0 : cells.length - 1;
    const cell = cells[k], g = drag.ghost;
    if (allDay) {
      drag.target = { col: k, a: null };
      g.querySelector('.gt').textContent = '';
      if (g.parentNode !== cell) cell.appendChild(g);
      return;
    }
    const r = cell.getBoundingClientRect();
    let a = MIN_H * 60 + (drag.y - drag.grabY - r.top) / hpx * 60;
    a = Math.round(a / SNAP) * SNAP;
    a = Math.max(MIN_H * 60, Math.min(MAX_H * 60 - drag.dur, a));
    drag.target = { col: k, a };
    g.style.top = `${((a - MIN_H * 60) / 60 * hpx).toFixed(1)}px`;
    g.style.height = `${(drag.dur / 60 * hpx - 2).toFixed(1)}px`;
    g.style.left = '2px'; g.style.width = 'calc(100% - 5px)';
    g.querySelector('.gt').textContent = `${hm(a)}〜${hm(a + drag.dur)}`;
    if (g.parentNode !== cell) cell.appendChild(g);
  }

  // 画面の上下の端に近づいたら自動でスクロール
  function autoScroll() {
    if (!drag || !drag.active) return;
    const topEdge = 110, bottomEdge = innerHeight - 90;
    let dy = 0;
    if (drag.y < topEdge) dy = -Math.min(14, (topEdge - drag.y) / 4);
    else if (drag.y > bottomEdge) dy = Math.min(14, (drag.y - bottomEdge) / 4);
    if (dy) { scrollBy(0, dy); placeGhost(); }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function endDrag(commit) {
    const { el, ghost, target } = drag;
    cancelAnimationFrame(drag.raf);
    ghost.remove();
    el.classList.remove('drag-src');
    document.body.classList.remove('dragging');
    dragEndedAt = Date.now();
    drag = null;
    if (!commit || !target || !ui.calDays) return;
    if (el.dataset.ext) {
      const e = ((extCache[el.dataset.k] || {}).events || [])[+el.dataset.n];
      if (!e) return;
      const day = ui.calDays[target.col], from = parse(el.dataset.day);
      const delta = atMin(day, target.a ?? 0) - atMin(from, el.dataset.a === '' ? 0 : +el.dataset.a);
      if (!delta) return;
      const ns = e.start + delta, ne = e.end + delta;
      const when = e.allDay ? mdw(new Date(ns)) : `${mdw(new Date(ns))} ${msHm(ns)}`;
      extOps([{ op: 'xmove', cid: e.cid, eid: e.eid, start: e.start, newStart: ns, newEnd: ne }], () => { e.start = ns; e.end = ne; }, `「${e.title}」を ${when} に動かしました`);
      return;
    }
    const key = el.dataset.d, uid = el.dataset.u, u = findUnit(key, uid);
    if (!u) return;
    const day = ui.calDays[target.col], nk = ymd(day);
    const k = moveKey(key, uid), before = S.moves[k];
    if (u.k != null && !before && S.moves[moveKey(key, u.s.i)]) {
      // 分ける前に90分ごと動かしていたら、残りの2つの位置を固定してから、このコマだけ動かす
      unitsOf(parse(key)).filter(v => v.k != null && v.s.i === u.s.i && v.uid !== uid).forEach(v => {
        const m = getMove(key, v); if (m) S.moves[moveKey(key, v.uid)] = m;
      });
      delete S.moves[moveKey(key, u.s.i)];
    }
    const same = u.flex ? target.a == null : (u.a0 == null || target.a === u.a0);
    if (before && before.carry) S.moves[k] = target.a == null ? { d: nk, carry: true } : { d: nk, a: target.a, carry: true };
    else if (nk === key && same) delete S.moves[k];
    else S.moves[k] = (u.a0 == null && !u.flex) || target.a == null ? { d: nk } : { d: nk, a: target.a };
    if (JSON.stringify(before) === JSON.stringify(S.moves[k])) return;
    save(); render();
    toast(S.moves[k] ? `${mdw(day)}${target.a == null ? '' : ` ${hm(target.a)}`} に移動しました` : '元の時間に戻しました');
  }

  // ---------- 週 ----------
  function renderWeek() {
    const cur = weekOf(today());
    const w = ui.week || cur;
    const x = wk(w);
    const tgt = target(w), act = actual(w), ch = checkedHours(w), adj = x.adj || 0;
    $title.textContent = '週次計画';
    const pills = [
      `<span class="pill">${esc(W(w).phase)}</span>`,
      `<span class="pill">時間割：${esc(pattern(w))}</span>`,
      w === cur ? '<span class="pill accent">今週</span>' : '',
      examWeek() === w ? '<span class="pill now">試験週</span>' : '',
      x.done ? '<span class="pill good">✓ 完了</span>' : '',
    ].join('');

    const ranges = SUBJ.map((name, i) => {
      const t = range(w, i);
      const nx = w < N ? range(w + 1, i) : '';
      const edited = `${w}-${i}` in S.ov.plan;
      const dim = !t && !ui.edit;
      return `<li class="${dim ? 'dim' : ''}${ui.edit ? ' editable' : ''}" ${ui.edit ? `data-action="edit-range" data-i="${i}" role="button" tabindex="0"` : ''}>
        <span class="dot" style="background:${color(name)}"></span>
        <div><div class="nm">${esc(name)}${edited ? ' <span class="faint">（編集済み）</span>' : ''}</div>
          <div class="tx${t ? '' : ' none'}">${t ? esc(t) : '—'}</div>
          ${nx ? `<div class="nx">来週：${esc(nx)}</div>` : ''}</div></li>`;
    }).join('');
    const emptyCount = SUBJ.filter((_, i) => !range(w, i)).length;

    let lastPhase = '';
    const list = PLAN.weeks.map(({ w: n }) => {
      const a = actual(n), t = target(n), d = wk(n).done;
      const cls = [n === cur ? 'cur' : '', n === w ? 'sel' : '', n < cur ? 'past' : ''].join(' ');
      const ph = W(n).phase;
      const head = ph !== lastPhase ? `<li class="phase">${esc(ph)}</li>` : '';
      lastPhase = ph;
      const subj = SUBJ.slice(0, STUDY_N).filter((_, i) => range(n, i)).map(x => x.replace('・会計', '').replace('・政策', '').replace('システム', ''));
      return `${head}<li class="${cls}"><button data-action="goweek" data-w="${n}">
        <span class="wn num">${n}</span>
        <span style="min-width:0"><span class="ph">${md(weekStart(n))}〜${md(weekEnd(n))}${n === cur ? ' <span class="pill accent">今週</span>' : ''}${examWeek() === n ? ' <span class="pill now">試験</span>' : ''}</span><span class="dt">${subj.length ? esc(subj.join('・')) : esc(range(n, 7) || '—')}</span></span>
        <span class="hr num">${d ? '<span class="ok">✓</span> ' : ''}${a > 0 ? fmtH(a) : '–'} / ${fmtH(t)}h</span></button></li>`;
    }).join('');

    return `
      <div class="weekhead">
        <button class="navbtn" data-action="week" data-v="-1" ${w <= 1 ? 'disabled' : ''} aria-label="前の週">‹</button>
        <div class="mid"><b>第<span class="num">${w}</span>週</b><span class="sub">${mdw(weekStart(w))}〜${mdw(weekEnd(w))}</span></div>
        <button class="navbtn" data-action="week" data-v="1" ${w >= N ? 'disabled' : ''} aria-label="次の週">›</button>
      </div>
      <div class="weekmeta">${pills}</div>
      ${w !== cur ? '<button class="btn ghost small back-today" data-action="goweek" data-w="0">今週に戻る</button>' : ''}

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <div><div class="small muted" style="font-weight:600">勉強時間</div>
            <div class="big-hours num"><b>${fmtH(act)}</b><span>/ ${fmtH(tgt)} 時間</span></div></div>
          <span class="pill ${act >= tgt && tgt > 0 ? 'good' : ''}">${pct(act, tgt)}%</span>
        </div>
        <div class="bar${act >= tgt && tgt > 0 ? ' good' : ''}" style="margin-top:10px"><i style="width:${pct(act, tgt)}%"></i></div>
        <div class="small faint" style="margin-top:6px">チェックしたコマ ${fmtH(ch)}h ${adj >= 0 ? '＋' : '−'} 手入力 ${fmtH(Math.abs(adj))}h</div>
        <div class="adj">
          <button class="btn small" data-action="adj" data-v="-1.5">−1.5</button>
          <button class="btn small" data-action="adj" data-v="-0.5">−0.5</button>
          <button class="btn small" data-action="adj" data-v="0.5">＋0.5</button>
          <button class="btn small" data-action="adj" data-v="1.5">＋1.5</button>
        </div>
        <div style="border-top:1px solid var(--border);margin:14px -16px 0;padding:12px 16px 0">
          <button class="donebtn" data-action="done" aria-pressed="${!!x.done}"><span class="check"><i></i></span>この週の範囲を終えた</button>
        </div>
      </div>

      <div class="section-h"><h2>科目別の範囲</h2>
        <span style="display:flex;gap:6px">
          ${emptyCount && !ui.edit ? `<button class="btn ghost small" data-action="showall">${ui.showAll ? '空欄を隠す' : `空欄も表示（${emptyCount}）`}</button>` : ''}
          <button class="btn small edit-toggle" data-action="edit" aria-pressed="${ui.edit}">${ui.edit ? '編集を終える' : '編集'}</button>
        </span></div>
      <div class="card flush"><ul class="ranges${ui.showAll ? ' showall' : ''}">${ranges}</ul></div>
      ${ui.edit ? `<button class="btn small" data-action="edit-week" style="width:100%">目標時間・時間割パターンを変える</button>` : ''}

      <div class="section-h"><h2>メモ</h2></div>
      <textarea class="memo" data-w="${w}" placeholder="気づいたこと、遅れ、次にやることなど">${esc(x.memo || '')}</textarea>

      <div class="section-h"><h2>全${N}週</h2><span class="aside">タップで切り替え</span></div>
      <div class="card flush"><ul class="weeklist">${list}</ul></div>`;
  }

  // ---------- 時間割 ----------
  function renderTimetable() {
    const t = today();
    const curPat = patIdx(pattern(weekOf(t)));
    const p = ui.pat ?? curPat;
    const todayChar = DAYS[t.getDay()];
    $title.textContent = '時間割';
    const chips = PLAN.patterns.map((name, i) =>
      `<button class="chip" data-action="pat" data-p="${i}" aria-pressed="${i === p}">${esc(name)}${i === curPat ? '<span class="cur">●今週</span>' : ''}</button>`).join('');
    const order = ['毎日', '月', '火', '水', '木', '金', '土', '日'];
    const groups = order.map(day => {
      const rows = SLOTS.filter(s => s.day === day).map(s => {
        const text = ttCell(s.i, p);
        const pt = parseTask(text);
        const idxs = pt.type === 'study' && !isMeta(pt.subj) ? subjectsFor(pt.subj, 1) : [];
        const c = pt.type === 'study' ? (idxs.length ? color(SUBJ[idxs[0]]) : color(OTHER)) : 'transparent';
        const edited = `${s.i}-${p}` in S.ov.tt;
        return `<div class="tt-row ${pt.type}${ui.edit ? ' editable' : ''}" style="--c:${c}" ${ui.edit ? `data-action="edit-tt" data-i="${s.i}" role="button" tabindex="0"` : ''}>
          <span class="stripe"></span>
          <span class="pd">${esc(s.period || '毎日')}<small>${esc(s.time)}</small></span>
          <span class="tx">${text ? esc(text) : '空き'}${edited ? ' <span class="faint small">（編集済み）</span>' : ''}</span></div>`;
      }).join('');
      const isToday = day === todayChar;
      return `<div class="tt-day${isToday ? ' is-today' : ''}"><h3>${day === '毎日' ? '毎日' : `${day}曜日`}${isToday ? '<span class="pill accent">今日</span>' : ''}</h3>
        <div class="card flush" style="margin:0">${rows}</div></div>`;
    }).join('');
    return `
      <div class="chips" role="group" aria-label="時間割パターン">${chips}</div>
      <div class="section-h" style="margin-top:8px"><span class="small muted">「週次計画」の時間割パターンで、どの週にどれを使うか決まります。</span>
        <button class="btn small edit-toggle" data-action="edit" aria-pressed="${ui.edit}">${ui.edit ? '編集を終える' : '編集'}</button></div>
      ${groups}`;
  }

  // ---------- 全体 ----------
  function renderOverview() {
    const t = today(), cur = weekOf(t);
    $title.textContent = '全体の進み具合';
    const left = diff(t, examD());
    const cumA = sumTo(actual, cur), cumT = sumTo(target, cur), total = sumTo(target, N);
    const doneN = PLAN.weeks.filter(({ w }) => wk(w).done).length;
    const kpis = `
      <div class="kpis">
        <div class="card"><div class="k">試験まで</div><div class="v num">${left > 0 ? `${left}<small>日</small>` : left === 0 ? '今日' : '終了'}</div><div class="s">${mdw(examD())} 1日目</div></div>
        <div class="card"><div class="k">累計（今週まで）</div><div class="v num">${fmtH(cumA)}<small>/${fmtH(cumT)}h</small></div><div class="s">目標の ${pct(cumA, cumT)}%</div></div>
        <div class="card"><div class="k">計画全体</div><div class="v num">${fmtH(sumTo(actual, N))}<small>/${fmtH(total)}h</small></div><div class="s">第${cur}週 / 全${N}週</div></div>
        <div class="card"><div class="k">終えた週</div><div class="v num">${doneN}<small>/${N}週</small></div><div class="s">「週」で完了にした数</div></div>
      </div>`;
    return `${kpis}
      <div class="section-h"><h2>累計の勉強時間</h2></div>
      <div class="card chart">${chartSvg(cur)}</div>
      <div class="section-h"><h2>科目別ガントチャート</h2><span class="aside">行をタップで期間を変更</span></div>
      <div class="card flush">${ganttHtml(cur)}</div>`;
  }

  function chartSvg(cur) {
    const Wd = 340, H = 150, pl = 34, pr = 8, pt = 8, pb = 20;
    const cumT = [0], cumA = [0];
    for (let w = 1; w <= N; w++) { cumT.push(cumT[w - 1] + target(w)); cumA.push(cumA[w - 1] + actual(w)); }
    const maxV = Math.max(cumT[N], cumA[N], 1);
    const top = Math.ceil(maxV / 250) * 250;
    const x = w => pl + (w / N) * (Wd - pl - pr);
    const y = v => pt + (1 - v / top) * (H - pt - pb);
    const grid = [];
    for (let v = 0; v <= top; v += top / 4) {
      grid.push(`<line x1="${pl}" x2="${Wd - pr}" y1="${y(v)}" y2="${y(v)}" style="stroke:var(--border);stroke-width:1"/>`);
      grid.push(`<text x="${pl - 6}" y="${y(v) + 3.5}" text-anchor="end" style="fill:var(--faint);font-size:9.5px">${v}</text>`);
    }
    const months = [];
    let last = -1;
    for (let w = 1; w <= N; w++) {
      const m = weekStart(w).getMonth();
      if (m !== last) { months.push(`<text x="${x(w - 1)}" y="${H - 5}" style="fill:var(--faint);font-size:9.5px">${m + 1}月</text>`); last = m; }
    }
    const lt = cumT.map((v, w) => `${x(w).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const la = cumA.slice(0, cur + 1).map((v, w) => `${x(w).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const ew = examWeek();
    return `<div class="legend"><span><i></i>実績</span><span><i class="t"></i>目標</span></div>
      <svg viewBox="0 0 ${Wd} ${H}" role="img" aria-label="累計の勉強時間。今週まで実績 ${fmtH(cumA[cur])} 時間、目標 ${fmtH(cumT[cur])} 時間">
        ${grid.join('')}${months.slice(0, 12).join('')}
        <line x1="${x(cur - 0.5)}" x2="${x(cur - 0.5)}" y1="${pt}" y2="${H - pb}" style="stroke:var(--accent);stroke-width:1;stroke-dasharray:2 3;opacity:.6"/>
        ${ew >= 1 && ew <= N ? `<line x1="${x(ew - 0.5)}" x2="${x(ew - 0.5)}" y1="${pt}" y2="${H - pb}" style="stroke:var(--now);stroke-width:1.5;opacity:.7"/>` : ''}
        <polyline points="${lt}" style="fill:none;stroke:var(--faint);stroke-width:1.75;stroke-dasharray:4 3"/>
        <polyline points="${la}" style="fill:none;stroke:var(--accent);stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round"/>
        <circle cx="${x(cur)}" cy="${y(cumA[cur])}" r="3.5" style="fill:var(--accent)"/>
      </svg>`;
  }

  function ganttHtml(cur) {
    const ew = examWeek();
    const cats = [];
    PLAN.gantt.forEach((g, i) => {
      let c = cats.find(x => x.name === g.cat);
      if (!c) cats.push(c = { name: g.cat, rows: [] });
      c.rows.push(i);
    });
    const monthStart = new Set();
    let last = -1;
    const mrow = [];
    for (let w = 1; w <= N; w++) {
      const m = weekStart(w).getMonth();
      if (m !== last) { monthStart.add(w); last = m; mrow.push(`<div class="hd m">${m + 1}月</div>`); }
      else mrow.push('<div class="hd"></div>');
    }
    const cellCls = w => `cell${w === cur ? ' cur' : ''}${monthStart.has(w) ? ' month' : ''}`;
    let html = `<div class="lbl hdl"></div>${mrow.join('')}<div class="lbl hdl" style="color:var(--faint)">週</div>`;
    for (let w = 1; w <= N; w++) html += `<div class="hd num" style="${w === cur ? 'color:var(--accent);font-weight:700;background:var(--today-col)' : w === ew ? 'color:var(--now);font-weight:700' : ''}">${w}</div>`;
    cats.forEach(c => {
      html += `<div class="lbl cat"><span class="dot" style="background:${color(c.name)}"></span><span>${esc(c.name)}</span></div>`;
      for (let w = 1; w <= N; w++) html += `<div class="${cellCls(w)} cat"></div>`;
      c.rows.forEach(i => {
        const g = ganttRow(i);
        html += `<div class="lbl row-btn" data-action="edit-gantt" data-i="${i}" role="button" tabindex="0" title="${esc(g.cat)}：${esc(g.label)}（${g.start}〜${g.end}週）"><span>${esc(g.label)}</span></div>`;
        for (let w = 1; w <= N; w++) {
          const on = w >= g.start && w <= g.end;
          html += `<div class="${cellCls(w)} row-btn" data-action="edit-gantt" data-i="${i}">${on ? `<i class="bar-seg${w === g.start ? ' s' : ''}${w === g.end ? ' e' : ''}" style="--c:${color(g.cat)}"></i>` : ''}${g.cat === '大学・試験' && w === ew && /1次/.test(g.label) ? '<i class="exam-mark"></i>' : ''}</div>`;
        }
      });
    });
    const legend = Object.keys(PLAN.colors).map(n => `<span><i class="dot" style="background:${color(n)}"></i>${esc(n)}</span>`).join('');
    return `<div class="gantt-wrap"><div class="gantt">${html}</div></div>
      <div class="legend-grid"><span><i class="dot" style="background:var(--today-col);box-shadow:inset 0 0 0 1px var(--border)"></i>今週</span>${ew >= 1 && ew <= N ? `<span><i class="dot" style="background:transparent;box-shadow:inset 0 0 0 2px var(--now)"></i>設定の試験日（第${ew}週）</span>` : ''}</div>
      <div class="legend-grid" style="border-top:0;padding-top:0">${legend}</div>`;
  }

  // ---------- ダイアログ ----------
  const $dlg = document.getElementById('dlg');
  const $form = document.getElementById('dlg-form');
  let dlgHandler = null;
  function openDlg(html, handler) {
    $form.innerHTML = html;
    dlgHandler = handler;
    $dlg.showModal();
  }
  $form.addEventListener('submit', e => {
    e.preventDefault();
    if (!dlgHandler || dlgHandler('save') !== false) $dlg.close();
  });
  $form.addEventListener('click', e => {
    const b = e.target.closest('[data-dlg]');
    if (!b) return;
    e.preventDefault();
    const act = b.dataset.dlg;
    if (act === 'cancel') { $dlg.close(); return; }
    if (!dlgHandler || dlgHandler(act) !== false) $dlg.close();
  });
  $dlg.addEventListener('click', e => { if (e.target === $dlg) $dlg.close(); });
  const fval = name => $form.elements[name]?.value ?? '';
  const actions = (canReset) => `<div class="dlg-actions">${canReset ? '<button class="btn ghost" data-dlg="reset" type="button">元に戻す</button>' : ''}<span class="spacer"></span>
    <button class="btn" data-dlg="cancel" type="button">キャンセル</button><button class="btn primary" type="submit">保存</button></div>`;

  function setOv(map, key, value, original) {
    if (value === original) delete map[key]; else map[key] = value;
  }

  function editRange(w, i) {
    const k = `${w}-${i}`, orig = W(w).s[i], edited = k in S.ov.plan;
    openDlg(`<h2>第${w}週・${esc(SUBJ[i])}</h2>
      <label class="field"><span>範囲</span><textarea name="v" autofocus>${esc(range(w, i))}</textarea>
      ${edited ? `<span class="hint">元の内容：${esc(orig || '（空欄）')}</span>` : ''}</label>${actions(edited)}`, act => {
      if (act === 'reset') delete S.ov.plan[k];
      else setOv(S.ov.plan, k, fval('v').trim(), orig);
      save(); render(); toast('保存しました');
    });
  }

  function editWeek(w) {
    const opts = PLAN.patterns.map(p => `<option ${p === pattern(w) ? 'selected' : ''}>${esc(p)}</option>`).join('');
    const edited = (w in S.ov.target) || (w in S.ov.pattern);
    openDlg(`<h2>第${w}週の設定</h2>
      <div class="row2">
        <label class="field"><span>目標時間</span><input name="t" type="number" inputmode="decimal" min="0" step="0.5" value="${target(w)}"></label>
        <label class="field"><span>時間割パターン</span><select name="p">${opts}</select></label>
      </div>
      ${edited ? `<span class="field"><span class="hint">元の設定：${W(w).target}時間・${esc(W(w).pattern)}</span></span>` : ''}${actions(edited)}`, act => {
      if (act === 'reset') { delete S.ov.target[w]; delete S.ov.pattern[w]; }
      else {
        const t = parseFloat(fval('t'));
        if (!(t >= 0)) { toast('目標時間を数字で入れてください'); return false; }
        setOv(S.ov.target, w, t, W(w).target);
        setOv(S.ov.pattern, w, fval('p'), W(w).pattern);
      }
      save(); render(); toast('保存しました');
    });
  }

  function editTT(r, p) {
    const s = PLAN.slots[r], k = `${r}-${p}`, orig = s.c[p], edited = k in S.ov.tt;
    openDlg(`<h2>${esc(PLAN.patterns[p])}・${s.day === '毎日' ? '毎日' : `${esc(s.day)} ${esc(s.period)}`}</h2>
      <label class="field"><span>${esc(s.time)}</span><textarea name="v" autofocus>${esc(ttCell(r, p))}</textarea>
      <span class="hint">「科目名：やること」と書くと科目の色と今週の範囲が出ます。「（講義）」で始めると講義として表示。空欄なら空き。</span>
      ${edited ? `<span class="hint">元の内容：${esc(orig || '（空き）')}</span>` : ''}</label>${actions(edited)}`, act => {
      if (act === 'reset') delete S.ov.tt[k];
      else setOv(S.ov.tt, k, fval('v').trim(), orig);
      save(); render(); toast('保存しました');
    });
  }

  function editGantt(i) {
    const g = ganttRow(i), o = PLAN.gantt[i], edited = i in S.ov.gantt;
    openDlg(`<h2>${esc(g.cat)}・${esc(g.label)}</h2>
      <div class="row2">
        <label class="field"><span>開始週</span><input name="s" type="number" inputmode="numeric" min="1" max="${N}" value="${g.start}"></label>
        <label class="field"><span>終了週</span><input name="e" type="number" inputmode="numeric" min="1" max="${N}" value="${g.end}"></label>
      </div>
      <span class="hint faint small">ガントチャートの表示だけが変わります。週ごとの範囲は「週」の画面で編集してください。${edited ? `<br>元の期間：第${o.start}〜${o.end}週` : ''}</span>${actions(edited)}`, act => {
      if (act === 'reset') delete S.ov.gantt[i];
      else {
        const s = parseInt(fval('s'), 10), e = parseInt(fval('e'), 10);
        if (!(s >= 1 && e <= N && s <= e)) { toast(`1〜${N}の範囲で、開始 ≦ 終了にしてください`); return false; }
        if (s === o.start && e === o.end) delete S.ov.gantt[i]; else S.ov.gantt[i] = { start: s, end: e };
      }
      save(); render(); toast('保存しました');
    });
  }

  function openSettings() {
    const st = S.settings;
    const editedN = Object.values(S.ov).reduce((n, m) => n + Object.keys(m).length, 0);
    const movesN = Object.keys(S.moves).length;
    openDlg(`<h2 class="sticky-head">設定<button class="btn ghost small" data-dlg="cancel" type="button" aria-label="閉じる">✕</button></h2>
      <div class="row2">
        <label class="field"><span>学習開始日</span><input name="start" type="date" value="${esc(st.start)}" required></label>
        <label class="field"><span>試験日（1日目）</span><input name="exam" type="date" value="${esc(st.exam)}" required></label>
      </div>
      <span class="hint small faint" id="start-hint">開始日は月曜にする（週は月〜日で区切る）。試験日は例年8月の第1土日なので、正式な日程が出たら直す。</span>
      <label class="check-row"><input name="pomo" type="checkbox" ${st.pomo !== false ? 'checked' : ''}> 90分のコマを25分×3（間に5分休憩）に分け、休憩で減った分を財務・会計の追加コマにする</label>
      <div class="row2">
        <label class="field"><span>財務1問（15分）平日</span><select name="daily">${DAILY_TIMES.map(([v, n]) => `<option value="${v}" ${dailyAt(false) === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="field"><span>財務1問（15分）土日</span><select name="dailyWE">${DAILY_TIMES.map(([v, n]) => `<option value="${v}" ${dailyAt(true) === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      </div>
      <div class="row2">
        <label class="field"><span>デザイン</span><select name="design">
          <option value="pop" ${st.design !== 'std' ? 'selected' : ''}>ポップ</option>
          <option value="std" ${st.design === 'std' ? 'selected' : ''}>シンプル</option></select></label>
        <label class="field"><span>表示</span><select name="theme">
          <option value="auto" ${st.theme === 'auto' ? 'selected' : ''}>端末に合わせる</option>
          <option value="light" ${st.theme === 'light' ? 'selected' : ''}>ライト</option>
          <option value="dark" ${st.theme === 'dark' ? 'selected' : ''}>ダーク</option></select></label>
      </div>
      <div class="settings-group"><h3>Googleカレンダー連携</h3>
        <p class="small muted">勉強のコマを、Googleカレンダーの専用カレンダー「診断士プラン」に自動で反映します（下の「反映する期間」の分。最初はまとめて送らず、20秒おきに2週ずつ送ります）。動かす・「終わった」にすると、カレンダー側も変わります。勉強の記録もここに保管されるので、スマホとPCの両方で設定すると記録を共有でき、端末のデータが消えても入れ直せば戻ります。</p>
        <label class="field"><span>ウェブアプリのURL</span><input name="gurl" type="url" inputmode="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(st.gcal.url)}"></label>
        <label class="field"><span>合言葉</span><input name="gtoken" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(st.gcal.token)}"></label>
        <label class="field"><span>反映する期間</span><select name="gspan">${GCAL_SPANS.map(([v, n]) => `<option value="${v}" ${(st.gcal.span || 'sem') === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="field"><span>予定の色（「終わった」はグレー）</span><select name="gcolor">${GCAL_COLORS.map(([v, n]) => `<option value="${v}" ${st.gcal.color === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="check-row"><input name="glect" type="checkbox" ${st.gcal.lectures ? 'checked' : ''}> 講義も入れる</label>
        <div class="field"><span>アプリに表示する自分のカレンダー（読むだけ）</span>
          <div id="calpick" class="calpick">${(st.gcal.read || []).map(c => `<label class="check-row"><input type="checkbox" name="rcal" value="${esc(c.id)}" data-name="${esc(c.name)}" checked> ${esc(c.name)}</label>`).join('') || '<span class="small faint">まだ選んでいません</span>'}</div>
          <div class="btns"><button class="btn small" type="button" data-dlg="gcals">カレンダーの一覧を読み込む</button></div>
        </div>
        <label class="check-row"><input name="ghide" type="checkbox" ${st.gcal.hideLect ? 'checked' : ''}> カレンダーを表示するときは、時間割の講義を出さない</label>
        <div class="btns">
          <button class="btn small" type="button" data-dlg="gtest">接続テスト</button>
          ${gcalOn() ? '<button class="btn small" type="button" data-dlg="gsync">今すぐ反映</button>' : ''}
        </div>
        <p class="small faint${S.gsync.err ? ' warn' : ''}" data-gsync>${gcalOn() ? esc(syncNoteText()) : ''}</p>
        <details class="small muted"><summary>最初の準備（パソコンで5分くらい）</summary>
          <ol class="steps">
            <li>連携用スクリプトをコピーする <button class="btn small" type="button" data-dlg="gcopy">スクリプトをコピー</button></li>
            <li><a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">script.google.com</a> で新しいプロジェクトを作り、最初からあるコードを消して貼り付け、保存する</li>
            <li>上の「実行する関数」で <b>setup</b> を選んで「実行」→ 権限を許可する（「確認されていません」と出たら「詳細」→「移動」）。実行ログの<b>合言葉</b>を控える。カレンダー「診断士プラン」もここで作られる</li>
            <li>「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」、実行ユーザー「自分」、アクセス「全員」でデプロイし、<b>URL</b>を控える</li>
            <li>このページに URL と合言葉を入れて「接続テスト」→「保存」</li>
          </ol>
        </details>
      </div>
      <div class="settings-group"><h3>データ</h3>
        <p class="small faint">アプリの版：${APP_VER}</p>
        <p class="small muted">記録はこの端末のブラウザの中だけに保存されます。機種変更やブラウザのデータ削除に備えて、ときどき書き出してください。</p>
        <div class="btns">
          <button class="btn small" type="button" data-dlg="export">書き出す</button>
          <button class="btn small" type="button" data-dlg="import">読み込む</button>
          ${editedN ? `<button class="btn small" type="button" data-dlg="reset-ov">計画の編集を元に戻す（${editedN}件）</button>` : ''}
          ${movesN ? `<button class="btn small" type="button" data-dlg="reset-moves">カレンダーの移動を元に戻す（${movesN}件）</button>` : ''}
          <button class="btn small danger" type="button" data-dlg="wipe">記録をすべて消す</button>
        </div>
      </div>
      <div class="dlg-actions sticky-actions"><span class="spacer"></span><button class="btn" data-dlg="cancel" type="button">キャンセル</button><button class="btn primary" type="submit">保存</button></div>`, act => {
      if (act === 'export') { exportData(); return false; }
      if (act === 'gcopy') {
        fetch('gas/Code.gs', { cache: 'no-cache' }).then(r => r.text())
          .then(t => navigator.clipboard.writeText(t)).then(() => toast('スクリプトをコピーしました'))
          .catch(() => toast('コピーできませんでした'));
        return false;
      }
      if (act === 'gcals') {
        const url = fval('gurl').trim(), token = fval('gtoken').trim();
        if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url) || !token) { toast('URL（https://script.google.com/…）と合言葉を入れてください'); return false; }
        const prev = S.settings.gcal;
        const checked = new Set([...$form.querySelectorAll('[name=rcal]:checked')].map(i => i.value));
        S.settings.gcal = { ...prev, url, token };
        toast('読み込んでいます…');
        gcalPost({ op: 'cals' })
          .then(j => {
            if (!j.cals) throw new Error('スクリプトを最新にしてください');
            $form.querySelector('#calpick').innerHTML = j.cals.map(c => `<label class="check-row"><input type="checkbox" name="rcal" value="${esc(c.id)}" data-name="${esc(c.name)}" ${checked.has(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('') || '<span class="small faint">カレンダーが見つかりません</span>';
            toast('表示したいカレンダーにチェックして「保存」');
          })
          .catch(e => toast(`読み込めません：${e.message || e}`))
          .finally(() => { S.settings.gcal = prev; });
        return false;
      }
      if (act === 'gtest' || act === 'gsync') {
        const url = fval('gurl').trim(), token = fval('gtoken').trim();
        if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url) || !token) { toast('URL（https://script.google.com/…）と合言葉を入れてください'); return false; }
        const prev = S.settings.gcal;
        S.settings.gcal = { ...prev, url, token, lectures: !!$form.elements.glect.checked, color: fval('gcolor'), span: fval('gspan') || 'sem' };
        if (act === 'gtest') {
          gcalPost({ ping: true })
            .then(j => toast(`つながりました（カレンダー「${j.calendar}」）`))
            .catch(e => toast(`つながりません：${e.message || e}`))
            .finally(() => { S.settings.gcal = prev; });
        } else {
          persist(); toast('反映しています…');
          cloudLoad().then(() => gcalFlush(true)).then(() => {
            const err = S.gsync.cerr || S.gsync.err;
            toast(err ? `うまくいきませんでした：${err}` : 'Googleカレンダーに反映しました');
          });
        }
        return false;
      }
      if (act === 'import') { importData(); return false; }
      if (act === 'reset-ov') {
        if (!confirm('計画・時間割・ガントチャートの編集を、スプレッドシートの内容に戻します。勉強時間の記録とメモは残ります。')) return false;
        S.ov = blank().ov; save(); render(); toast('元に戻しました'); return;
      }
      if (act === 'reset-moves') {
        if (!confirm('カレンダーで動かしたコマを、すべて時間割どおりの位置に戻します。')) return false;
        S.moves = {}; save(); render(); toast('元に戻しました'); return;
      }
      if (act === 'wipe') {
        if (!confirm(`勉強時間、チェック、メモ、編集、カレンダーの移動をすべて消します。${gcalOn() ? 'Googleに保管している記録も消えます。' : ''}元に戻せません。先に書き出しておくと安全です。`)) return false;
        const gcal = S.settings.gcal;
        S = blank(); S.settings.gcal = gcal; save(); render(); toast('消しました'); return;
      }
      const start = fval('start'), exam = fval('exam');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(exam)) { toast('日付を入れてください'); return false; }
      const gcal = {
        url: fval('gurl').trim(), token: fval('gtoken').trim(), lectures: !!$form.elements.glect.checked, color: fval('gcolor'),
        read: [...$form.querySelectorAll('[name=rcal]:checked')].map(i => ({ id: i.value, name: i.dataset.name })),
        hideLect: !!$form.elements.ghide.checked,
        addCal: st.gcal.addCal,
        span: fval('gspan') || 'sem',
      };
      const reconnect = gcal.url !== st.gcal.url || gcal.token !== st.gcal.token;
      S.settings = { ...st, start, exam, theme: fval('theme'), design: fval('design'), pomo: !!$form.elements.pomo.checked, dailyAt: fval('daily'), dailyAtWE: fval('dailyWE'), gcal };
      if (reconnect) {
        // つなぎ先が変わったら、まず保管してある記録を読み込む（空の記録で上書きしないため）。カレンダーは全部送り直す
        S.gsync = { hash: {}, last: 0, err: '', clast: 0, cerr: '' };
        cloudReady = false;
        persist(); render(); cloudLoad();
      } else {
        save(); render();
      }
      toast(parse(start).getDay() === 1 ? '保存しました' : '保存しました（開始日が月曜ではありません）');
    });
    const $s = $form.elements.start, $h = $form.querySelector('#start-hint');
    const chk = () => { const bad = $s.value && parse($s.value).getDay() !== 1; $h.classList.toggle('warn', !!bad); };
    $s.addEventListener('input', chk); chk();
  }

  async function exportData() {
    const name = `shindanshi-plan-${ymd(today()).replace(/-/g, '')}.json`;
    const out = { ...S, gsync: undefined, settings: { ...S.settings, gcal: { ...S.settings.gcal, token: '' } } };
    const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
    try {
      const file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|Android/.test(navigator.userAgent)) {
        await navigator.share({ files: [file], title: name });
        return;
      }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('書き出しました');
  }

  function importData() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/json,.json';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (!data || data.v !== 1 || !data.settings) throw new Error('format');
        if (!confirm('今の記録を、読み込んだファイルの内容で置き換えます。')) return;
        S = normalize(data); save(); $dlg.close(); render(); toast('読み込みました');
      } catch (e) { toast('このファイルは読み込めませんでした'); }
    };
    inp.click();
  }

  // ---------- 操作 ----------
  let toastTimer = 0;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  function applyTheme() {
    const th = S.settings.theme;
    if (th === 'light' || th === 'dark') document.documentElement.dataset.theme = th;
    else delete document.documentElement.dataset.theme;
    document.documentElement.dataset.design = S.settings.design === 'std' ? 'std' : 'pop';   // 見た目：ポップ（標準）／シンプル
  }

  function switchTab(tab) {
    if (ui.tab === tab) {
      if (tab === 'cal' && ui.day) { backToWeek(); render(); window.scrollTo(0, 0); return; }
      window.scrollTo({ top: 0, behavior: 'smooth' }); return;
    }
    ui.tab = tab; ui.edit = false;
    render(); window.scrollTo(0, 0);
  }

  document.querySelector('.tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (b && closeSheet()) switchTab(b.dataset.tab);
  });
  document.querySelector('[data-action="settings"]').addEventListener('click', () => { if (closeSheet()) openSettings(); });

  function onAction(el) {
    const a = el.dataset.action;
    const curW = () => ui.week || weekOf(today());
    if (a === 'draft') { $sheet.querySelector('.es-title')?.focus(); return; }
    if (sheetOpen() && a !== 'newev' && !closeSheet()) return;   // ほかの操作をしたら、シートは閉じる
    switch (a) {
      case 'newev': {   // 右下の＋：今日なら次の30分から、それ以外の日は9時から
        const t = today(), days = ui.calDays || [t];
        const day = ui.day ? parse(ui.day) : (days.find(x => diff(t, x) === 0) || days[0]);
        openAdd(day, diff(t, day) === 0 ? Math.min(nextHalf(), 22 * 60) : 9 * 60, false);
        break;
      }
      case 'calweek': {
        const v = +el.dataset.v; ui.calOffset = v === 0 ? 0 : ui.calOffset + v; render(); break;
      }
      case 'slot': openSlot(el.dataset.u, el.dataset.d); break;
      case 'ext': openExt(el.dataset.k, +el.dataset.n); break;
      case 'openday': case 'dayjump': ui.day = el.dataset.d; ui.scrollNow = true; render(); break;
      case 'dayshift': ui.day = ymd(addDays(parse(ui.day), +el.dataset.v)); ui.scrollNow = true; render(); break;
      case 'daytoday': ui.day = ymd(today()); ui.scrollNow = true; render(); break;
      case 'dayback': backToWeek(); render(); window.scrollTo(0, 0); break;
      case 'quickdone': {
        const uid = el.dataset.u, on = toggleCheck(el.dataset.d, uid);
        render(); toast(on ? `記録しました（＋${fmtGain(unitHours(uid))}）` : '未完了に戻しました'); break;
      }
      case 'carry-week': {
        const days = ui.calDays || [];
        const list = weekEvents(days).filter(x => carryable(x, days));
        if (!list.length) break;
        list.forEach(carryOver);
        save(); render();
        toast(`${list.length}件を次の週の「終日」の段へ持ち越しました`); break;
      }
      case 'unmove-week': {
        const keys = new Set((ui.calDays || []).map(ymd));
        Object.keys(S.moves).forEach(k => { if (keys.has(k.split('|')[0])) delete S.moves[k]; });
        save(); render(); toast('この週の移動を元に戻しました'); break;
      }
      case 'openweek': ui.week = +el.dataset.w || null; ui.tab = 'week'; ui.edit = false; render(); window.scrollTo(0, 0); break;
      case 'week': ui.week = Math.max(1, Math.min(N, curW() + +el.dataset.v)); render(); break;
      case 'goweek': {
        const w = +el.dataset.w; ui.week = w || null; render();
        window.scrollTo({ top: 0, behavior: 'smooth' }); break;
      }
      case 'adj': {
        const w = curW(), v = +el.dataset.v;
        const ch = checkedHours(w), adj = wk(w).adj || 0;
        const next = Math.max(-ch, adj + v);
        setWk(w, { adj: Math.round(next * 100) / 100 }); save(); render(); break;
      }
      case 'done': { const w = curW(); setWk(w, { done: !wk(w).done }); save(); render(); break; }
      case 'edit': ui.edit = !ui.edit; render(); break;
      case 'showall': ui.showAll = !ui.showAll; render(); break;
      case 'edit-range': editRange(curW(), +el.dataset.i); break;
      case 'edit-week': editWeek(curW()); break;
      case 'pat': ui.pat = +el.dataset.p; render(); break;
      case 'edit-tt': editTT(+el.dataset.i, ui.pat ?? patIdx(pattern(weekOf(today())))); break;
      case 'edit-gantt': editGantt(+el.dataset.i); break;
    }
  }
  $view.addEventListener('click', e => {
    if (Date.now() - dragEndedAt < 400) return;   // ドラッグを離したときのクリックは無視
    const el = e.target.closest('[data-action]');
    if (el && $view.contains(el)) { onAction(el); return; }
    const cell = e.target.closest('.cal-body .col, .cal-allday .ad');
    if (cell && ui.tab === 'cal' && ui.calDays && extOn()) {
      const day = ui.calDays[+cell.dataset.col];
      if (!day) return;
      if (cell.classList.contains('ad')) { openAdd(day, 9 * 60, true); return; }
      const m = MIN_H * 60 + (e.clientY - cell.getBoundingClientRect().top) / hpx * 60;
      openAdd(day, Math.floor(m / 30) * 30, false);   // タップした30分の枠から1時間
    }
  });
  $view.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"][data-action]')) { e.preventDefault(); onAction(e.target); }
  });

  let memoTimer = 0;
  $view.addEventListener('input', e => {
    if (!e.target.matches('textarea.memo')) return;
    const w = +e.target.dataset.w, v = e.target.value;
    clearTimeout(memoTimer);
    memoTimer = setTimeout(() => { setWk(w, { memo: v }); save(); }, 400);
  });
  $view.addEventListener('focusout', e => {
    if (!e.target.matches('textarea.memo')) return;
    clearTimeout(memoTimer); setWk(+e.target.dataset.w, { memo: e.target.value }); save();
  });

  const $top = document.querySelector('.top');
  addEventListener('scroll', () => $top.classList.toggle('scrolled', scrollY > 4), { passive: true });

  // 開きっぱなしでも「今」のコマと日付が進むように
  let lastDay = ymd(today());
  function tick() {
    if (document.hidden || $dlg.open || drag || document.activeElement?.matches('textarea')) return;
    const d = ymd(today());
    if (ui.tab === 'cal' || d !== lastDay) { lastDay = d; render(); }
  }
  setInterval(tick, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  addEventListener('storage', e => { if (e.key === KEY && !drag) { S = load(); render(); } });

  render();
  if (gcalOn()) cloudLoad();

  // 新しい版が出ていたら、開いたとき・アプリに戻ったときに取りに行き、入れ替わったら読み込み直す
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadCtrl = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadCtrl || reloaded || drag || $dlg.open) return;
      reloaded = true; location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then(reg => document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); }))
      .catch(() => {});
  }
})();
