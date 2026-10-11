/**
 * 診断士プラン → Googleカレンダー 連携用スクリプト（Google Apps Script）
 *
 * アプリから送られてきた1週間分のコマを、専用カレンダー「診断士プラン」に反映する。
 * アプリ → カレンダーの一方向。カレンダー側で予定を動かしても、アプリには戻らない。
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

// アプリからの送信：{ token, ping } または { token, from, to, events: [{ id, title, start, end, desc, color }] }
// from〜to の範囲にあるアプリのコマを、送られてきた内容とそっくり同じにする（足す・直す・消す）
function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: '送信内容が読めません' }); }
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!req || !token || req.token !== token) return out_({ ok: false, error: '合言葉が違います' });

  const cal = getCalendar_();
  if (req.ping) return out_({ ok: true, calendar: cal.getName() });

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
