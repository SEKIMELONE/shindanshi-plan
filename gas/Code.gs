/**
 * 診断士プラン → Googleカレンダー 連携用スクリプト（Google Apps Script）
 *
 * 1. アプリから送られてきた1週間分のコマを、専用カレンダー「診断士プラン」に反映する。
 *    アプリ → カレンダーの一方向。カレンダー側で予定を動かしても、アプリには戻らない。
 * 2. アプリの記録（勉強時間・チェック・メモ・移動・計画の編集）を保管する。
 *    端末のデータが消えても、URLと合言葉を入れ直せば戻る。スマホとPCで記録を共有できる。
 * 3. 自分のカレンダー（共有されている大学のカレンダーなども）の予定を読んで、アプリに渡す。
 *    アプリからの「動かす・追加・名前変更・削除」も反映する（書き込みの権限があるカレンダーだけ）。
 *
 * 準備（最初の1回だけ）
 *  1. https://script.google.com で「新しいプロジェクト」を作り、このファイルの中身を全部貼り付けて保存
 *  2. 上の関数の選択で「setup」を選んで「実行」→ 権限を許可する
 *     （「このアプリは Google で確認されていません」と出たら「詳細」→「（安全ではないページ）に移動」）
 *     実行ログに出る「合言葉」を控える。カレンダー「診断士プラン」もここで作られる
 *  3. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *     次のユーザーとして実行：自分 / アクセスできるユーザー：全員 → デプロイ
 *     表示された「ウェブアプリのURL」を控える
 *  4. アプリの「設定 → Googleカレンダー連携」に URL と合言葉を入れて「接続テスト」
 *
 * 色の名前（ラベル）を使うときは、左の「サービス」＋ から「Google Calendar API」を追加する（なくても動く）
 *
 * このスクリプトを書き換えたときは「デプロイを管理」→ 編集 →「新しいバージョン」で更新する（URLは変わらない）
 */

const CAL_NAME = '診断士プラン';
const TAG = 'shindanshiPlanId';   // アプリのコマを見分けるための印

function setup() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    props.setProperty('TOKEN', token);
  }
  const cal = getCalendar_();
  Logger.log('合言葉: ' + token);
  Logger.log('カレンダー: ' + cal.getName());
}

function getCalendar_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('CAL_ID');
  let cal = id ? CalendarApp.getCalendarById(id) : null;
  if (!cal) {
    cal = CalendarApp.createCalendar(CAL_NAME, { color: CalendarApp.Color.BLUE, timeZone: 'Asia/Tokyo' });
    props.setProperty('CAL_ID', cal.getId());
  }
  return cal;
}

// ---------- 記録の保管 ----------
// スクリプト プロパティに、JSON を小分けにして入れる（1つの値は 9KB まで、全体で 500KB まで）
const CHUNK = 2500;   // 日本語は1文字3バイトなので、2500文字ずつ

function loadState_() {
  const props = PropertiesService.getScriptProperties();
  const n = Number(props.getProperty('STATE_N') || 0);
  if (!n) return { updatedAt: 0, data: null };
  let str = '';
  for (let i = 0; i < n; i++) str += props.getProperty('STATE_' + i) || '';
  try { return JSON.parse(str); } catch (err) { return { updatedAt: 0, data: null }; }
}

function saveState_(updatedAt, data) {
  const props = PropertiesService.getScriptProperties();
  const str = JSON.stringify({ updatedAt: updatedAt, data: data });
  const oldN = Number(props.getProperty('STATE_N') || 0);
  const parts = {};
  let n = 0;
  for (let i = 0; i < str.length; i += CHUNK) parts['STATE_' + n++] = str.slice(i, i + CHUNK);
  parts.STATE_N = String(n);
  props.setProperties(parts);
  for (let i = n; i < oldN; i++) props.deleteProperty('STATE_' + i);
}

// アプリからの送信
//  { token, ping }                                  … 接続テスト
//  { token, op: 'load' }                            … 保管している記録を返す
//  { token, op: 'save', updatedAt, data }           … 記録を保管（こちらの方が新しいときだけ）
//  { token, op: 'cals' }                            … 読めるカレンダーの一覧
//  { token, op: 'read', ids, from, to }             … 選んだカレンダーの予定を読む
//  { token, op: 'xmove', cid, eid, start, newStart, newEnd }   … 予定を動かす（start は元の開始時刻）
//  { token, op: 'xedit', cid, eid, start, title, loc, desc }   … 予定の名前・場所・メモを変える（送ったものだけ）
//  { token, op: 'xdel',  cid, eid, start }                     … 予定を消す（くり返し予定はその回だけ）
//  { token, op: 'xadd',  cid, title, start, end, allDay, color, label, loc, desc, repeat } … 予定を追加する
//      repeat: { freq: 'daily'|'weekly'|'biweekly'|'weekdays'|'monthly'|'yearly', until: ミリ秒（なければずっと） } … くり返しの予定にする
//  { token, op: 'xcolor', cid, eid, start, color }             … 予定の色を変える（'1'〜'11'）
//  { token, op: 'xlabel', cid, eid, start, label }             … 予定に名前つきの色（ラベル）を付ける
//  { token, from, to, events: [{ id, title, start, end, desc, color }] }
//      … from〜to の範囲にあるアプリのコマを、送られてきた内容とそっくり同じにする（足す・直す・消す）
function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: '送信内容が読めません' }); }
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!req || !token || req.token !== token) return out_({ ok: false, error: '合言葉が違います' });

  if (req.op === 'load') return out_(Object.assign({ ok: true }, loadState_()));
  if (req.op === 'save') {
    const lk = LockService.getScriptLock();
    lk.waitLock(25000);
    try {
      const cur = loadState_();
      // ほかの端末がもっと新しい記録を保管していたら、上書きせずにそちらを返す
      if (cur.data && Number(req.updatedAt) < Number(cur.updatedAt)) return out_(Object.assign({ ok: true, stale: true }, cur));
      saveState_(Number(req.updatedAt), req.data);
      return out_({ ok: true, updatedAt: Number(req.updatedAt) });
    } finally {
      lk.releaseLock();
    }
  }

  const cal = getCalendar_();
  if (req.ping) return out_({ ok: true, calendar: cal.getName(), version: 8 });

  if (req.op === 'cals') {
    const cals = CalendarApp.getAllCalendars()
      .filter(c => c.getId() !== cal.getId())
      .map(c => ({ id: c.getId(), name: c.getName() }));
    return out_({ ok: true, cals: cals });
  }
  if (req.op === 'read') {
    const from = new Date(req.from), to = new Date(req.to), events = [], labels = {};
    (req.ids || []).forEach(id => {
      if (id === cal.getId()) return;
      const c = CalendarApp.getCalendarById(id);
      if (!c) return;
      const ls = labels_(id);
      if (ls.length) labels[id] = ls;
      const lmap = ls.length ? eventLabels_(id, from, to) : {};
      c.getEvents(from, to).forEach(ev => {
        const allDay = ev.isAllDayEvent();
        const start = (allDay ? ev.getAllDayStartDate() : ev.getStartTime()).getTime();
        events.push({
          title: ev.getTitle() || '予定あり',
          start: start,
          end: (allDay ? ev.getAllDayEndDate() : ev.getEndTime()).getTime(),
          allDay: allDay,
          cal: c.getName(),
          cid: id,
          eid: ev.getId(),
          rec: ev.isRecurringEvent(),
          color: ev.getColor() || '',   // 予定ごとの色（'1'〜'11'）。カレンダーの色のままなら空
          ccol: c.getColor(),           // カレンダーの色（#rrggbb）
          label: lmap[ev.getId() + '|' + start] || '',   // 名前つきの色（ラベル）の id
          loc: ev.getLocation() || '',
          desc: String(ev.getDescription() || '').slice(0, 1000),
        });
      });
    });
    return out_({ ok: true, events: events, labels: labels });
  }

  if (/^x(move|edit|del|add|color|label)$/.test(req.op || '')) {
    if (req.cid === cal.getId()) return out_({ ok: false, error: '診断士プランのカレンダーはアプリのコマで動かしてください' });
    const c = CalendarApp.getCalendarById(req.cid);
    if (!c) return out_({ ok: false, error: 'カレンダーが見つかりません' });
    try {
      if (req.op === 'xadd') {
        const title = String(req.title || '').trim() || '予定';
        const opt = {};
        if (req.loc) opt.location = String(req.loc);
        if (req.desc) opt.description = String(req.desc);
        const series = !!(req.repeat && req.repeat.freq);
        let ev;
        if (series) {
          const rr = recurrence_(req.repeat, new Date(req.start));
          ev = req.allDay
            ? c.createAllDayEventSeries(title, new Date(req.start), rr, opt)
            : c.createEventSeries(title, new Date(req.start), new Date(req.end), rr, opt);
        } else {
          ev = req.allDay
            ? c.createAllDayEvent(title, new Date(req.start), new Date(req.end), opt)
            : c.createEvent(title, new Date(req.start), new Date(req.end), opt);
        }
        if (req.color) ev.setColor(String(req.color));
        if (req.label) {
          if (series) setSeriesLabel_(req.cid, ev.getId(), req.label);
          else setLabel_(req.cid, ev.getId(), (req.allDay ? ev.getAllDayStartDate() : ev.getStartTime()).getTime(), req.label);
        }
        return out_({ ok: true, eid: ev.getId() });
      }
      if (req.op === 'xlabel') {
        if (!setLabel_(req.cid, req.eid, Number(req.start), req.label)) return out_({ ok: false, error: '色の名前を付けられませんでした（スクリプトに「Google Calendar API」のサービスを追加してください）' });
        return out_({ ok: true });
      }
      const ev = findEvent_(c, req.eid, Number(req.start));
      if (!ev) return out_({ ok: false, error: '予定が見つかりません（Googleカレンダー側で変わったかもしれません）' });
      if (req.op === 'xmove') {
        if (ev.isAllDayEvent()) ev.setAllDayDates(new Date(req.newStart), new Date(req.newEnd));
        else ev.setTime(new Date(req.newStart), new Date(req.newEnd));
      } else if (req.op === 'xcolor') {
        ev.setColor(String(req.color));
      } else if (req.op === 'xedit') {
        if (req.title != null) ev.setTitle(String(req.title).trim() || '予定');
        if (req.loc != null) ev.setLocation(String(req.loc));
        if (req.desc != null) ev.setDescription(String(req.desc));
      } else {
        ev.deleteEvent();
      }
      return out_({ ok: true });
    } catch (err) {
      return out_({ ok: false, error: 'このカレンダーは書き換えられません（共有の権限を「予定の変更」にしてください）' });
    }
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const existing = cal.getEvents(new Date(req.from), new Date(req.to)).filter(ev => ev.getTag(TAG));
    const byId = {};
    existing.forEach(ev => { byId[ev.getTag(TAG)] = ev; });
    const keep = {};
    let created = 0, updated = 0, removed = 0;
    (req.events || []).forEach(x => {
      const st = new Date(x.start), en = new Date(x.end), desc = x.desc || '';
      let ev = byId[x.id];
      if (!ev) {
        ev = cal.createEvent(x.title, st, en, { description: desc });
        ev.setTag(TAG, x.id);
        created++;
      } else {
        let changed = false;
        if (ev.getTitle() !== x.title) { ev.setTitle(x.title); changed = true; }
        if (ev.getStartTime().getTime() !== st.getTime() || ev.getEndTime().getTime() !== en.getTime()) { ev.setTime(st, en); changed = true; }
        if (ev.getDescription() !== desc) { ev.setDescription(desc); changed = true; }
        if (changed) updated++;
      }
      if (x.color && ev.getColor() !== x.color) ev.setColor(x.color);
      keep[x.id] = true;
    });
    existing.forEach(ev => {
      if (!keep[ev.getTag(TAG)]) { ev.deleteEvent(); removed++; }
    });
    return out_({ ok: true, created, updated, removed });
  } finally {
    lock.releaseLock();
  }
}

// ---------- 色の名前（ラベル）：Google Calendar API のサービスを追加したときだけ使える ----------
const hasApi_ = () => typeof Calendar !== 'undefined';
// カレンダーに決めてある色の名前 [{ id, name, color }]
function labels_(cid) {
  if (!hasApi_()) return [];
  try {
    const lp = Calendar.Calendars.get(cid).labelProperties;
    return ((lp && lp.eventLabels) || []).map(l => ({ id: l.id, name: l.name || '', color: l.backgroundColor || '' }));
  } catch (err) { return []; }
}
// 期間内の予定のラベル { 'iCalUID|開始ms': ラベルid }
function eventLabels_(cid, from, to) {
  const map = {};
  try {
    let token;
    do {
      const r = Calendar.Events.list(cid, { timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: true, maxResults: 2500, pageToken: token, eventLabelVersion: 1 });
      (r.items || []).forEach(it => {
        if (!it.eventLabelId || !it.start) return;
        const st = it.start.dateTime ? new Date(it.start.dateTime) : allDayStart_(it.start.date);
        map[it.iCalUID + '|' + st.getTime()] = it.eventLabelId;
      });
      token = r.nextPageToken;
    } while (token);
  } catch (err) { /* 読めなければラベルなし */ }
  return map;
}
const allDayStart_ = ymd => { const p = ymd.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
// くり返しのきまり（アプリの選択肢 → Apps Script のきまり）
function recurrence_(rep, start) {
  const W = [CalendarApp.Weekday.SUNDAY, CalendarApp.Weekday.MONDAY, CalendarApp.Weekday.TUESDAY, CalendarApp.Weekday.WEDNESDAY,
    CalendarApp.Weekday.THURSDAY, CalendarApp.Weekday.FRIDAY, CalendarApp.Weekday.SATURDAY];
  const r = CalendarApp.newRecurrence();
  let rule;
  if (rep.freq === 'daily') rule = r.addDailyRule();
  else if (rep.freq === 'weekly') rule = r.addWeeklyRule().onlyOnWeekday(W[start.getDay()]);
  else if (rep.freq === 'biweekly') rule = r.addWeeklyRule().interval(2).onlyOnWeekday(W[start.getDay()]);
  else if (rep.freq === 'weekdays') rule = r.addWeeklyRule().onlyOnWeekdays([W[1], W[2], W[3], W[4], W[5]]);
  else if (rep.freq === 'monthly') rule = r.addMonthlyRule();
  else rule = r.addYearlyRule();
  if (rep.until) rule.until(new Date(Number(rep.until)));
  return r;
}
// くり返しの予定ぜんぶにラベルを付ける（元の予定に付ける）
function setSeriesLabel_(cid, eid, label) {
  if (!hasApi_()) return false;
  try {
    const it = (Calendar.Events.list(cid, { iCalUID: eid }).items || [])[0];
    if (!it) return false;
    Calendar.Events.patch({ eventLabelId: label }, cid, it.id, { eventLabelVersion: 1 });
    return true;
  } catch (err) { return false; }
}

// 予定（くり返しはその回）にラベルを付ける
function setLabel_(cid, eid, start, label) {
  if (!hasApi_()) return false;
  try {
    const r = Calendar.Events.list(cid, { iCalUID: eid, timeMin: new Date(start - 86400000).toISOString(), timeMax: new Date(start + 86400000).toISOString(), singleEvents: true });
    const it = (r.items || []).find(x => (x.start.dateTime ? new Date(x.start.dateTime) : allDayStart_(x.start.date)).getTime() === start);
    if (!it) return false;
    Calendar.Events.patch({ eventLabelId: label }, cid, it.id, { eventLabelVersion: 1 });
    return true;
  } catch (err) { return false; }
}

// 予定を探す。くり返し予定は同じIDが並ぶので、開始時刻でその回を選ぶ
function findEvent_(c, eid, start) {
  const t = new Date(start);
  const hits = c.getEvents(new Date(start - 60000), new Date(start + 60000)).filter(ev => {
    if (ev.getId() !== eid) return false;
    const s = (ev.isAllDayEvent() ? ev.getAllDayStartDate() : ev.getStartTime()).getTime();
    return s === t.getTime();
  });
  if (hits.length) return hits[0];
  const ev = c.getEventById(eid);
  return ev && !ev.isRecurringEvent() ? ev : null;
}

function doGet() {
  return out_({ ok: true, app: 'shindanshi-plan' });
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
