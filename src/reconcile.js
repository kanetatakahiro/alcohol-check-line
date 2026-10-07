// 接続先ごとのデータ形式は、確認後にこの共通形式へ変換する。
// この段階ではシートの更新もLINE送信も行わない。
const schedules = new Set(['work', 'publicHoliday', 'paidLeave', 'partialLeave', 'unknown']);
const attendanceLabels = {
  work: '出勤予定・未打刻', publicHoliday: '公休', paidLeave: '有給',
  partialLeave: '一部休暇・要確認', unknown: '要確認'
};

function requireValue(condition) {
  // 不正な元データや個人情報を例外メッセージに含めない。
  if (!condition) throw new Error('必須データに不備があります。処理を中止しました。');
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

function validCode(code) {
  return typeof code === 'string' && code.length > 0 && code === code.trim();
}

export function japanDate(instant = new Date()) {
  requireValue(instant instanceof Date && !Number.isNaN(instant.getTime()));
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(instant);
}

/**
 * date: 日本時間の業務日 YYYY-MM-DD（夜勤等の業務日ルールは接続前に確認）
 * attendance: [{ employeeCode: 文字列, date, schedule, clockedIn: boolean }]
 * checks: [{ employeeCode, date, checkType, completed: boolean }]
 * completed は実際のシートの実施済み条件を確認して変換する。
 * 対象は出勤打刻済みの人。出勤予定だけでは通知候補にしない。
 */
export function reconcile({ date, checkType, attendance, checks }) {
  requireValue(validDate(date) && typeof checkType === 'string' && checkType.trim().length > 0);
  requireValue(Array.isArray(attendance) && Array.isArray(checks));
  const seen = new Set();
  for (const row of attendance) {
    requireValue(row && validCode(row.employeeCode) && validDate(row.date)
      && schedules.has(row.schedule) && typeof row.clockedIn === 'boolean');
    const key = JSON.stringify([row.employeeCode, row.date]);
    requireValue(!seen.has(key));
    seen.add(key);
  }
  for (const row of checks) {
    requireValue(row && validCode(row.employeeCode) && validDate(row.date)
      && typeof row.checkType === 'string' && row.checkType.trim().length > 0
      && typeof row.completed === 'boolean');
  }
  const completedCodes = new Set(checks.filter(row => row.date === date
    && row.checkType === checkType && row.completed).map(row => row.employeeCode));
  return attendance.filter(row => row.date === date).map(row => {
    const conflict = row.clockedIn && ['publicHoliday', 'paidLeave'].includes(row.schedule);
    const review = conflict || (!row.clockedIn && ['unknown', 'partialLeave'].includes(row.schedule));
    const attendanceStatus = conflict ? '打刻と休暇が不一致・要確認'
      : row.clockedIn ? '出勤' : attendanceLabels[row.schedule];
    const target = row.clockedIn && !conflict;
    const completed = completedCodes.has(row.employeeCode);
    return {
      employeeCode: row.employeeCode, date, attendanceStatus,
      reviewRequired: review, target,
      checkStatus: review ? '要確認' : !target ? '対象外' : completed ? '実施済み' : '未実施',
      // あくまで確認用候補。宛先・重複履歴の確認と本番有効化は別途必要。
      notificationCandidate: target && !completed
    };
  });
}
