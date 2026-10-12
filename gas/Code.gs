/**
 * 診断士プラン → Googleカレンダー 連携用スクリプト（Google Apps Script）
 *
 * 1. アプリから送られてきた1週間分のコマを、専用カレンダー「診断士プラン」に反映する。
 *    アプリ → カレンダーの一方向。カレンダー側で予定を動かしても、アプリには戻らない。
 * 2. アプリの記録（勉強時間・チェック・メモ・移動・計画の編集）を保管する。
 *    端末のデータが消えても、URLと合言葉を入れ直せば戻る。スマホとPCで記録を共有できる。
 * 3. 自分のカレンダー（共有されている大学のカレンダーなども）の予定を読んで、アプリに渡す（読むだけ）。
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
  if (req.ping) return out_({ ok: true, calendar: cal.getName(), version: 3 });

  if (req.op === 'cals') {
    const cals = CalendarApp.getAllCalendars()
      .filter(c => c.getId() !== cal.getId())
      .map(c => ({ id: c.getId(), name: c.getName() }));
    return out_({ ok: true, cals: cals });
  }
  if (req.op === 'read') {
    const from = new Date(req.from), to = new Date(req.to), events = [];
    (req.ids || []).forEach(id => {
      if (id === cal.getId()) return;
      const c = CalendarApp.getCalendarById(id);
      if (!c) return;
      c.getEvents(from, to).forEach(ev => {
        const allDay = ev.isAllDayEvent();
        events.push({
          title: ev.getTitle() || '予定あり',
          start: (allDay ? ev.getAllDayStartDate() : ev.getStartTime()).getTime(),
          end: (allDay ? ev.getAllDayEndDate() : ev.getEndTime()).getTime(),
          allDay: allDay,
          cal: c.getName(),
        });
      });
    });
    return out_({ ok: true, events: events });
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

function doGet() {
  return out_({ ok: true, app: 'shindanshi-plan' });
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
