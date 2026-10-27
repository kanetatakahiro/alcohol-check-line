// Apps Script の模擬環境（Node.js のテスト用）。スプレッドシートはメモリ上、LINE等の外部通信は記録するだけで送らない。
// セルへの書き込みは本物のシートに近い変換をする：数字だけの文字 → 数値、YYYY-MM-DD → 日付型、先頭の ' → 文字のまま。
// 書式「@」（書式なしテキスト）のセルは文字のまま。
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const jst = (iso) => new Date(`${iso}T00:00:00+09:00`);

function convert(v, fmt) {
  if (typeof v !== 'string') return v;
  if (v.startsWith("'")) return v.slice(1);
  if (fmt === '@') return v;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(v);
  if (m) return jst(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);
  return v;
}

class Range {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  each(fn) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) fn(this.r + i, this.c + j, i, j); }
  getValues() { const out = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(this.sheet.get(this.r + i, this.c + j)); out.push(row); } return out; }
  getValue() { return this.sheet.get(this.r, this.c); }
  setValues(v) {
    if (v.length !== this.nr || v.some((row) => row.length !== this.nc)) throw new Error(`範囲の大きさが違います ${this.nr}x${this.nc}`);
    this.each((r, c, i, j) => this.sheet.set(r, c, convert(v[i][j], this.sheet.fmtOf(r, c))));
    return this;
  }
  setValue(v) { this.sheet.set(this.r, this.c, convert(v, this.sheet.fmtOf(this.r, this.c))); return this; }
  setNumberFormat(f) { this.each((r, c) => { this.sheet.fmt[`${r},${c}`] = f; }); return this; }
  insertCheckboxes() { this.each((r, c) => { if (this.sheet.get(r, c) === '') this.sheet.set(r, c, false); }); return this; }
  setFontWeight() { return this; }
  setDataValidation() { return this; }
}

class Sheet {
  static seq = 0;
  constructor(ss, name) { this.sid = ++Sheet.seq; this.ss = ss; this.name = name; this.rows = []; this.fmt = {}; this.colFmt = {}; }
  fmtOf(r, c) { return this.fmt[`${r},${c}`] || this.colFmt[c]; }
  clear() { this.rows = []; this.fmt = {}; this.colFmt = {}; return this; }
  getName() { return this.name; }
  setName(n) { this.name = n; }
  getSheetId() { return this.sid; }
  getParent() { return this.ss; }
  get(r, c) { const row = this.rows[r - 1]; const v = row ? row[c - 1] : undefined; return v === undefined || v === null ? '' : v; }
  set(r, c, v) { while (this.rows.length < r) this.rows.push([]); this.rows[r - 1][c - 1] = v; }
  getLastRow() { let n = 0; this.rows.forEach((row, i) => { if (row && row.some((v) => v !== '' && v !== undefined && v !== null)) n = i + 1; }); return n; }
  getLastColumn() { let n = 0; this.rows.forEach((row) => (row || []).forEach((v, j) => { if (v !== '' && v !== undefined && v !== null) n = Math.max(n, j + 1); })); return n; }
  getRange(r, c, nr = 1, nc = 1) {
    if (typeof r === 'string') {   // 'A:A' 'D2:D' 等（列全体の書式設定だけに対応）
      const col = r.charCodeAt(0) - 64, sheet = this;
      return { setNumberFormat(f) { sheet.colFmt[col] = f; return this; }, setDataValidation() { return this; } };
    }
    if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error('範囲の指定が不正です');
    return new Range(this, r, c, nr, nc);
  }
  getDataRange() { return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  appendRow(row) { const r = this.getLastRow() + 1; row.forEach((v, j) => this.set(r, j + 1, convert(v, this.fmtOf(r, j + 1)))); return this; }
  deleteRow(r) {
    this.rows.splice(r - 1, 1);
    const f = {};
    Object.entries(this.fmt).forEach(([k, v]) => { const [rr, cc] = k.split(',').map(Number); if (rr < r) f[k] = v; else if (rr > r) f[`${rr - 1},${cc}`] = v; });
    this.fmt = f;
  }
  setFrozenRows() { return this; }
  /** テスト用：値を2次元配列で（空は''） */
  dump() { return this.getDataRange().getValues(); }
}

class Spreadsheet {
  constructor(id, name) { this.id = id; this.name = name; this.sheets = []; }
  getId() { return this.id; }
  getName() { return this.name; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(this, n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets.map((x) => new Proxy(x, {})); }   // 本物と同じく毎回別の物（中身は同じシート）
  deleteSheet(s) {
    if (this.sheets.length === 1) throw new Error('ドキュメント内のシートをすべて削除することはできません。');
    this.sheets = this.sheets.filter((x) => x.getSheetId() !== s.getSheetId());
  }
  getUrl() { return `https://docs.google.com/spreadsheets/d/${this.id}/edit`; }
}

class Store {
  constructor() { this.m = {}; }
  getProperty(k) { return Object.hasOwn(this.m, k) ? this.m[k] : null; }
  setProperty(k, v) { this.m[k] = String(v); return this; }
  deleteProperty(k) { delete this.m[k]; return this; }
  getProperties() { return { ...this.m }; }
  setProperties(o) { Object.assign(this.m, o); return this; }
}

/**
 * Apps Script のファイルを読み込んだ模擬環境を作る。
 * files：gas/ 以下のファイル名。clock.now を変えると「今」が変わる。
 * line.members：グループID → {userId: 表示名}（メンバーのプロフィール取得の応答）
 */
export function createGas({ files, now, shared }) {
  const clock = shared ? shared.clock : { now: new Date(now).getTime() };
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(clock.now); else super(...a); }
    static now() { return clock.now; }
  }
  const sheets = shared ? shared.sheets : {};
  const scriptProps = new Store(), userProps = new Store();
  const cache = {};
  const fetches = [];
  const line = { members: {}, profiles: {} };
  const logs = [];
  const fmtDate = (d, tz, f) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
    return f.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
  };
  // ドライブ（「TOT取り込み」フォルダ1つだけの模擬）：drive.files[ファイル名] = { content, updated(ミリ秒) }
  const drive = { files: {} };
  const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
  const fileObj = (name) => ({
    getName: () => name, getId: () => 'file-' + name,
    getLastUpdated: () => new FakeDate(drive.files[name].updated),
    getBlob: () => ({ getDataAsString: () => drive.files[name].content }),
    setContent: (t) => { drive.files[name] = { content: t, updated: clock.now }; },
  });
  const folder = {
    getId: () => 'folder-tot',
    getFiles: () => iter(Object.keys(drive.files).map(fileObj)),
    getFilesByName: (n) => iter(Object.hasOwn(drive.files, n) ? [fileObj(n)] : []),
    createFile: (n, t) => { drive.files[n] = { content: t, updated: clock.now }; return fileObj(n); },
  };
  const ctx = {
    Date: FakeDate,
    DriveApp: { getFolderById: () => folder, getFoldersByName: () => iter([folder]), createFolder: () => folder },
    MimeType: { PLAIN_TEXT: 'text/plain' },
    console,
    Logger: { log: (...a) => { logs.push(a.join(' ')); } },
    SpreadsheetApp: {
      openById: (id) => { if (!sheets[id]) throw new Error('ファイルがありません'); return sheets[id]; },
      create: (name) => { const id = `ss${Object.keys(sheets).length + 1}`; sheets[id] = new Spreadsheet(id, name); sheets[id].insertSheet('シート1'); return sheets[id]; },
      newDataValidation: () => ({ requireValueInList() { return this; }, build() { return {}; } }),
    },
    PropertiesService: { getScriptProperties: () => scriptProps, getUserProperties: () => userProps },
    CacheService: { getScriptCache: () => ({ get: (k) => (Object.hasOwn(cache, k) ? cache[k] : null), put: (k, v) => { cache[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock() { return true; }, releaseLock() {} }) },
    ContentService: { createTextOutput: (t) => ({ text: t, getContent: () => t }) },
    Utilities: {
      formatDate: fmtDate,
      parseDate: (s, tz, f) => { if (f !== 'yyyy-MM-dd') throw new Error('未対応の形式'); return new FakeDate(jst(s).getTime()); },
      computeHmacSha256Signature: (text, key) => [...createHmac('sha256', key).update(text, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
      getUuid: () => randomUUID(),
      Charset: { UTF_8: 'UTF-8' },
    },
    UrlFetchApp: {
      fetch: (url, opt = {}) => {
        const rec = { url, opt, body: opt.payload ? JSON.parse(opt.payload) : null };
        fetches.push(rec);
        let code = 200, text = '{}';
        const mem = /\/v2\/bot\/group\/([^/]+)\/member\/([^/?]+)$/.exec(url);
        const prof = /\/v2\/bot\/profile\/([^/?]+)$/.exec(url);
        if (mem) {
          const g = decodeURIComponent(mem[1]), u = decodeURIComponent(mem[2]);
          if (line.members[g] && Object.hasOwn(line.members[g], u)) text = JSON.stringify({ displayName: line.members[g][u], userId: u });
          else code = 404;
        } else if (prof) {
          text = JSON.stringify({ displayName: line.profiles[decodeURIComponent(prof[1])] || '試験ユーザー' });
        } else if (/\/message\/reply$/.test(url) && rec.body && /^forged/.test(String(rec.body.replyToken))) {
          code = 400; text = '{"message":"Invalid reply token"}';   // LINEが発行していない返信トークン
        } else if (!/api\.line\.me\/v2\/bot\/message\/(reply|push)$/.test(url)) {
          throw new Error(`想定外の通信先: ${url}`);
        }
        return { getResponseCode: () => code, getContentText: () => text };
      },
    },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    module: { exports: {} },
  };
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(readFileSync(new URL(`../../gas/${f}`, import.meta.url), 'utf8'), ctx, { filename: f });
  return { ctx, clock, sheets, drive, shared: { clock, sheets }, scriptProps, userProps, cache, fetches, line, logs, FakeDate,
    newSpreadsheet: (name) => ctx.SpreadsheetApp.create(name) };
}

export function signForward(secret, payloadObj, nowSec, nonce = randomUUID()) {
  const payload = JSON.stringify(payloadObj);
  const sig = createHmac('sha256', secret).update(`${nowSec}.${nonce}.${payload}`, 'utf8').digest('hex');
  return { type: 'line-verified', ts: nowSec, nonce, payload, sig };
}
