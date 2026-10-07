// 仕様: https://developer.kingoftime.jp/ （実際のTOT接続は別途確認）
const API = 'https://api.kingtime.jp/v1.0';

export function validateDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error('取得日が正しくありません。');
  }
}

export function assertAllowedTime(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('現在時刻が正しくありません。');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const minute = Number(parts.find(p => p.type === 'hour').value) * 60
    + Number(parts.find(p => p.type === 'minute').value);
  if ((minute >= 510 && minute < 600) || (minute >= 1050 && minute < 1110)) {
    throw new Error('TOT APIの利用禁止時間帯です。時間をおいて確認してください。');
  }
}

function validateRows(rows, key) {
  if (!Array.isArray(rows)) throw new Error('TOTの応答形式を確認してください。');
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row[key] !== 'string' || !row[key].trim()
        || seen.has(row[key])) throw new Error('TOTのデータに不備または重複があります。');
    seen.add(row[key]);
  }
}

export function createTotClient({ token, fetchImpl = fetch, now = () => new Date(),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (typeof token !== 'string' || !token.trim() || /\s/.test(token)) {
    throw new Error('TOTアクセストークンをローカルの環境設定に保存してください。');
  }
  let queue = Promise.resolve();
  let hasRequested = false;
  async function get(path) {
    if (hasRequested) await wait(1000);
    assertAllowedTime(now());
    hasRequested = true;
    try {
      const response = await fetchImpl(`${API}${path}`, {
        method: 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('request-failed');
      return await response.json();
    } catch {
      // 外部の例外・応答本文には秘密情報や個人情報が含まれる可能性がある。
      throw new Error('TOTから取得できませんでした。トークン・権限・通信状態を確認してください。');
    }
  }
  async function read(date) {
    validateDate(date);
    const employees = await get(`/employees?date=${date}&includeResigner=false`);
    validateRows(employees, 'key');
    validateRows(employees, 'code');
    const punches = await get(`/daily-workings/timerecord/${date}`);
    const schedules = await get(`/daily-schedules/${date}`);
    for (const [data, field] of [[punches, 'dailyWorkings'], [schedules, 'dailySchedules']]) {
      if (!data || data.date !== date) throw new Error('TOTの取得日が一致しません。');
      validateRows(data[field], 'employeeKey');
      const employeeKeys = new Set(employees.map(e => e.key));
      if (data[field].some(row => row.date !== date || !employeeKeys.has(row.employeeKey))) {
        throw new Error('TOTの従業員または勤務日の対応を確認してください。');
      }
    }
    // 生データはメモリ内だけで扱い、シート更新や通知判定へまだ接続しない。
    return { date, employees, punches: punches.dailyWorkings, schedules: schedules.dailySchedules };
  }
  return { readDay(date) {
    const result = queue.then(() => read(date));
    queue = result.catch(() => {});
    return result;
  } };
}
