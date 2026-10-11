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
    return { v: 1, settings: { start: PLAN.start, exam: PLAN.exam, theme: 'auto' }, weeks: {}, checks: {},
      ov: { plan: {}, target: {}, pattern: {}, tt: {}, gantt: {} } };
  }
  function normalize(s) {
    const b = blank();
    if (!s || typeof s !== 'object') return b;
    const ov = s.ov || {};
    return {
      v: 1,
      settings: { ...b.settings, ...(s.settings || {}) },
      weeks: s.weeks || {},
      checks: s.checks || {},
      ov: { plan: ov.plan || {}, target: ov.target || {}, pattern: ov.pattern || {}, tt: ov.tt || {}, gantt: ov.gantt || {} },
    };
  }
  function load() {
    try { return normalize(JSON.parse(localStorage.getItem(KEY))); } catch (e) { return blank(); }
  }
  let saveFailed = false;
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); saveFailed = false; }
    catch (e) { if (!saveFailed) toast('この端末に保存できませんでした'); saveFailed = true; }
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
  function dayHours(key) {
    const c = S.checks[key]; let h = 0;
    if (c) for (const i in c) if (c[i] && SLOTS[i]) h += SLOTS[i].hours;
    return h;
  }
  function checkedHours(w) {
    let h = 0;
    for (let k = 0; k < 7; k++) h += dayHours(ymd(addDays(weekStart(w), k)));
    return h;
  }
  const actual = w => Math.max(0, checkedHours(w) + (wk(w).adj || 0));
  const hasRecord = w => actual(w) > 0 || !!wk(w).done;
  const sumTo = (f, w) => { let s = 0; for (let i = 1; i <= w; i++) s += f(i); return s; };
  const fmtH = h => { const r = Math.round(h * 4) / 4; return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0$/, ''); };
  const pct = (a, b) => (b > 0 ? Math.min(100, Math.round(a / b * 100)) : 0);

  // ---------- 画面の状態 ----------
  const ui = { tab: 'today', dayOffset: 0, week: null, pat: null, edit: false, showAll: false };
  const $view = document.getElementById('view');
  const $title = document.getElementById('title');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function render() {
    applyTheme();
    document.querySelectorAll('.tabs button').forEach(b => {
      if (b.dataset.tab === ui.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    const f = { today: renderToday, week: renderWeek, timetable: renderTimetable, overview: renderOverview }[ui.tab];
    $view.innerHTML = f();
    if (ui.tab === 'overview') {
      const g = $view.querySelector('.gantt-wrap');
      if (g) g.scrollLeft = Math.max(0, (weekOf(today()) - 4) * 18);
    }
  }

  // ---------- 今日 ----------
  function renderToday() {
    const t = today();
    const d = addDays(t, ui.dayOffset);
    const isToday = ui.dayOffset === 0;
    const w = weekOf(d), raw = rawWeek(d);
    const pi = patIdx(pattern(w));
    const dayChar = DAYS[d.getDay()];
    const key = ymd(d);
    const checks = S.checks[key] || {};
    $title.textContent = isToday ? '今日やること' : `${mdw(d)}のコマ`;

    const left = diff(t, examD());
    const examTxt = left > 0 ? `<span class="num">${left}</span><small>日</small>` : left === 0 ? '今日' : '終了';
    const examSub = left > 0 ? `あと約${Math.round(left / 7)}週` : `${md(examD())}・${md(addDays(examD(), 1))}`;
    const tgt = target(w), act = actual(w);
    const cw = weekOf(t);
    const cumA = sumTo(actual, cw), cumT = sumTo(target, cw);

    let banners = '';
    if (raw < 1) banners += `<div class="banner">学習開始は <b>${mdw(startD())}</b>。第1週の内容を表示しています。</div>`;
    if (raw > N) banners += `<div class="banner">計画の${N}週は終わっています。最後の週の内容を表示しています。</div>`;
    if (diff(d, examD()) === 0 || diff(d, examD()) === -1) {
      banners += `<div class="banner exam"><b>1次試験 ${diff(d, examD()) === 0 ? '1日目' : '2日目'}</b></div>`;
    } else if (examWeek() === raw) {
      banners += `<div class="banner exam"><b>今週は1次試験</b>　${mdw(examD())}・${mdw(addDays(examD(), 1))}</div>`;
    }
    const note = range(w, 7);
    if (note) banners += `<div class="banner"><span><b>今週のメモ</b>　${esc(note)}</span></div>`;

    const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
    const rows = SLOTS.filter(s => s.day === '毎日' || s.day === dayChar)
      .map(s => ({ s, text: ttCell(s.i, pi) }))
      .filter(r => r.text);
    const nextIdx = isToday ? rows.findIndex(r => r.s.a != null && r.s.a > nowMin) : -1;

    const items = rows.map((r, idx) => {
      const p = parseTask(r.text);
      const idxs = subjectsFor(p.subj, w);
      const c = p.type === 'study' ? (idxs.length ? color(SUBJ[idxs[0]]) : color(OTHER)) : 'transparent';
      const subjLabel = isMeta(p.subj) && idxs.length ? idxs.map(i => SUBJ[i]).join('・') : p.subj;
      const isNow = isToday && r.s.a != null && nowMin >= r.s.a && nowMin < r.s.b;
      const done = !!checks[r.s.i];
      const when = `${r.s.day === '毎日' ? '毎日' : `${esc(r.s.period)}`} · ${esc(r.s.time)}`;
      const pills = (isNow ? '<span class="pill now">▶ 今</span>' : '') + (idx === nextIdx ? '<span class="pill accent">次</span>' : '');
      const rng = idxs.map(i => [i, range(w, i)]).filter(([, x]) => x);
      const rangeHtml = p.type === 'study' && rng.length
        ? `<div class="range"><b>今週の範囲</b>　${rng.map(([i, x]) => (rng.length > 1 ? `${esc(SUBJ[i])}：` : '') + esc(x)).join('<br>')}</div>` : '';
      const btn = p.type === 'study'
        ? `<button class="check" data-action="check" data-i="${r.s.i}" aria-pressed="${done}" aria-label="${esc(r.s.period || r.s.day)}を${done ? '未完了に戻す' : '完了にする'}"><i></i></button>`
        : '<span></span>';
      return `<li class="slot ${p.type}${done ? ' done' : ''}${isNow ? ' is-now' : ''}" style="--c:${c}">
        <span class="stripe"></span>
        <div><div class="when">${when}${pills}</div>
          <div class="what">${subjLabel && !p.task.startsWith(subjLabel) ? `<span class="subj">${esc(subjLabel)}</span>` : ''}${esc(p.task)}</div>${rangeHtml}</div>${btn}</li>`;
    }).join('');

    return `
      <div class="daynav">
        <button class="navbtn" data-action="day" data-v="-1" aria-label="前の日">‹</button>
        <div class="date"><b>${mdw(d)}</b><span class="sub">第${w}週 · ${esc(W(w).phase)} · ${esc(pattern(w))}</span></div>
        <button class="navbtn" data-action="day" data-v="1" aria-label="次の日">›</button>
      </div>
      ${isToday ? '' : '<button class="btn ghost small back-today" data-action="day" data-v="0">今日に戻る</button>'}
      <div class="card">
        <div class="stats">
          <div class="stat"><div class="k">試験まで</div><div class="v">${examTxt}</div><div class="s">${examSub}</div></div>
          <div class="stat"><div class="k">今週</div><div class="v">第<span class="num">${w}</span><small>週</small></div><div class="s">${md(weekStart(w))}〜${md(weekEnd(w))}</div></div>
          <div class="stat"><div class="k">今週の勉強</div><div class="v num">${fmtH(act)}<small>/${fmtH(tgt)}h</small></div><div class="s">この日 ${fmtH(dayHours(key))}h</div></div>
        </div>
        <div class="hours-row"><span class="lbl">今週 ${pct(act, tgt)}%</span><div class="bar${act >= tgt && tgt > 0 ? ' good' : ''}"><i style="width:${pct(act, tgt)}%"></i></div></div>
        <div class="hours-row" style="border-top:0;padding-top:0;margin-top:8px"><span class="lbl">累計 <span class="num">${fmtH(cumA)} / ${fmtH(cumT)}</span>h</span><div class="bar"><i style="width:${pct(cumA, cumT)}%"></i></div></div>
      </div>
      ${banners}
      <div class="section-h"><h2>${isToday ? '今日' : 'この日'}のコマ</h2><span class="aside">終わったらチェック → 時間が記録される</span></div>
      <div class="card flush">${items ? `<ul class="slots">${items}</ul>` : '<div class="empty-note">この日の枠はありません。</div>'}</div>`;
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
    openDlg(`<h2>設定</h2>
      <div class="row2">
        <label class="field"><span>学習開始日</span><input name="start" type="date" value="${esc(st.start)}" required></label>
        <label class="field"><span>試験日（1日目）</span><input name="exam" type="date" value="${esc(st.exam)}" required></label>
      </div>
      <span class="hint small faint" id="start-hint">開始日は月曜にする（週は月〜日で区切る）。試験日は例年8月の第1土日なので、正式な日程が出たら直す。</span>
      <label class="field"><span>表示</span><select name="theme">
        <option value="auto" ${st.theme === 'auto' ? 'selected' : ''}>端末の設定に合わせる</option>
        <option value="light" ${st.theme === 'light' ? 'selected' : ''}>ライト</option>
        <option value="dark" ${st.theme === 'dark' ? 'selected' : ''}>ダーク</option></select></label>
      ${actions(false)}
      <div class="settings-group"><h3>データ</h3>
        <p class="small muted">記録はこの端末のブラウザの中だけに保存されます。機種変更やブラウザのデータ削除に備えて、ときどき書き出してください。</p>
        <div class="btns">
          <button class="btn small" type="button" data-dlg="export">書き出す</button>
          <button class="btn small" type="button" data-dlg="import">読み込む</button>
          ${editedN ? `<button class="btn small" type="button" data-dlg="reset-ov">計画の編集を元に戻す（${editedN}件）</button>` : ''}
          <button class="btn small danger" type="button" data-dlg="wipe">記録をすべて消す</button>
        </div>
      </div>`, act => {
      if (act === 'export') { exportData(); return false; }
      if (act === 'import') { importData(); return false; }
      if (act === 'reset-ov') {
        if (!confirm('計画・時間割・ガントチャートの編集を、スプレッドシートの内容に戻します。勉強時間の記録とメモは残ります。')) return false;
        S.ov = blank().ov; save(); render(); toast('元に戻しました'); return;
      }
      if (act === 'wipe') {
        if (!confirm('勉強時間、チェック、メモ、編集をすべて消します。元に戻せません。先に書き出しておくと安全です。')) return false;
        S = blank(); save(); render(); toast('消しました'); return;
      }
      const start = fval('start'), exam = fval('exam');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(exam)) { toast('日付を入れてください'); return false; }
      S.settings = { ...st, start, exam, theme: fval('theme') };
      save(); render();
      toast(parse(start).getDay() === 1 ? '保存しました' : '保存しました（開始日が月曜ではありません）');
    });
    const $s = $form.elements.start, $h = $form.querySelector('#start-hint');
    const chk = () => { const bad = $s.value && parse($s.value).getDay() !== 1; $h.classList.toggle('warn', !!bad); };
    $s.addEventListener('input', chk); chk();
  }

  async function exportData() {
    const name = `shindanshi-plan-${ymd(today()).replace(/-/g, '')}.json`;
    const blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
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
  }

  function switchTab(tab) {
    if (ui.tab === tab) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    ui.tab = tab; ui.edit = false;
    render(); window.scrollTo(0, 0);
  }

  document.querySelector('.tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (b) switchTab(b.dataset.tab);
  });
  document.querySelector('[data-action="settings"]').addEventListener('click', openSettings);

  function onAction(el) {
    const a = el.dataset.action;
    const curW = () => ui.week || weekOf(today());
    switch (a) {
      case 'day': {
        const v = +el.dataset.v; ui.dayOffset = v === 0 ? 0 : ui.dayOffset + v; render(); break;
      }
      case 'check': {
        const d = ymd(addDays(today(), ui.dayOffset)), i = el.dataset.i;
        const c = S.checks[d] || (S.checks[d] = {});
        if (c[i]) delete c[i]; else c[i] = 1;
        if (!Object.keys(c).length) delete S.checks[d];
        // 手入力でマイナスしていた分が、チェックを外したあとに残らないようにする
        const w = weekOf(addDays(today(), ui.dayOffset)), ch = checkedHours(w);
        if ((wk(w).adj || 0) < -ch) setWk(w, { adj: -ch });
        save(); render();
        if (c[i] && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
        break;
      }
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
    const el = e.target.closest('[data-action]');
    if (el && $view.contains(el)) onAction(el);
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
    if (document.hidden || $dlg.open || document.activeElement?.matches('textarea')) return;
    const d = ymd(today());
    if (ui.tab === 'today' || d !== lastDay) { lastDay = d; render(); }
  }
  setInterval(tick, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  addEventListener('storage', e => { if (e.key === KEY) { S = load(); render(); } });

  render();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
