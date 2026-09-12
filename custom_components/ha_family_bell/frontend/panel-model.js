/** Pure display helpers shared by the panel and its behavior tests. */
export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function wallTime(value, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return { date: parts.year + "-" + parts.month + "-" + parts.day, time: parts.hour + ":" + parts.minute };
}

export function tomorrow(timezone, value = Date.now()) {
  const date = new Date(wallTime(value, timezone).date + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function eventDatetime(original, date, time, timezone) {
  if (original) {
    const previous = wallTime(original, timezone);
    if (date === previous.date && time === previous.time) return original;
  }
  // The backend interprets unzoned editor values in Home Assistant's zone.
  return date + "T" + time;
}

export function oneTimeSections(bells, now = Date.now()) {
  const events = bells.filter(bell => bell.type === "one_time");
  const upcoming = events.filter(bell => bell.status === "pending"
    && new Date(bell.datetime).getTime() >= now)
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
  const previous = events.filter(bell => bell.status !== "pending"
    || new Date(bell.datetime).getTime() < now)
    .sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
  return {
    upcoming,
    previous,
    finishedCount: previous.filter(bell => ["completed", "missed"].includes(bell.status)).length,
  };
}

export function friendlyTemplate(value) {
  return String(value || "").replace(/{{\s*now\(\)\.strftime\((['"])%H:%M\1\)\s*}}/g, "%time%")
    .replace(/{{\s*random_message\s*}}/g, "%randomset%");
}

export function previewEntries(data, now = Date.now()) {
  const entries = data.bells.filter(bell => bell.type === "weekly").map(bell => ({
    ...bell, key: "bell:" + bell.id, owner: "weekly", source: "weekly", sourceKey: "weekly",
    message: friendlyTemplate(bell.message_source.template),
  }));
  for (const row of data.routine_occurrences) {
    entries.push({ ...row, key: "routine:" + row.routine_id + ":" + row.step_id + ":" + row.weekday,
      id: row.routine_id, owner: "routine", source: row.routine_name, sourceKey: row.routine_id,
      message: friendlyTemplate(row.message_source.template),
    });
  }
  const events = data.bells.filter(bell => bell.type === "one_time" && bell.status === "pending"
    && new Date(bell.datetime).getTime() >= now).map(bell => ({
      ...bell, ...wallTime(bell.datetime, data.timezone), key: "bell:" + bell.id,
      owner: "one_time", source: "one_time", sourceKey: "one_time",
      message: friendlyTemplate(bell.message_source.template),
    }));
  if (data.global_enabled) {
    const local = wallTime(now, data.timezone);
    const start = new Date(local.date + "T12:00:00Z");
    const slots = new Map();
    const add = (at, row) => {
      if (!row.enabled) return;
      for (const speaker of row.speakers) {
        const key = at + ":" + speaker;
        const previous = slots.get(key) || [];
        if (previous.length) {
          row.conflict = true;
          previous.forEach(other => { other.conflict = true; });
        }
        slots.set(key, [...previous, row]);
      }
    };
    // Recurring collisions are structural. They remain useful even when the
    // next occurrence is in the past for the current browser clock.
    for (const row of entries) {
      delete row.conflict;
      add("weekly:" + row.weekday + ":" + row.time.slice(0, 5), row);
    }
    slots.clear();
    for (let offset = 0; offset < 7; offset++) {
      const day = new Date(start);
      day.setUTCDate(day.getUTCDate() + offset);
      const weekday = (day.getUTCDay() + 6) % 7;
      const date = day.toISOString().slice(0, 10);
      for (const row of entries.filter(entry => entry.weekday === weekday)) add(date + "T" + row.time.slice(0, 5), row);
      for (const row of events.filter(entry => entry.date === date)) add(date + "T" + row.time, row);
    }
  }
  return { recurring: entries.sort((a, b) => a.weekday - b.weekday || a.time.localeCompare(b.time)),
    events: events.sort((a, b) => new Date(a.datetime) - new Date(b.datetime)) };
}

const TEXT = {
  preview: ["Week preview", "주간 미리보기"], weekly: ["Weekly schedule", "주간 일정"],
  routines: ["Routines", "루틴"], one_time: ["One-time events", "일회성 알림"],
  message_sets: ["Message sets", "메시지 모음"], activity: ["Recent activity", "최근 실행"],
  settings: ["Announcement settings", "알림 설정"], active: ["Schedule active", "일정 사용 중"],
  paused: ["Schedule paused", "일정 일시 중지"], pauseRoutine: ["Pausing a routine keeps its individual bell selections.", "루틴을 일시 중지해도 개별 알림의 사용 설정은 유지됩니다."],
  today: ["Today", "오늘"], next: ["Next bell", "다음 알림"], noNext: ["No upcoming bell", "예정된 알림 없음"],
  timezone: ["Time zone", "시간대"], enabledOnly: ["Enabled only", "사용 중인 알림만"],
  hideEmpty: ["Hide empty days", "빈 요일 숨기기"], search: ["Search messages or routines", "메시지·루틴 검색"],
  allSpeakers: ["All speakers", "모든 스피커"], speakers: ["Speakers", "스피커"],
  time: ["Time", "시간"], date: ["Date", "날짜"], days: ["Days", "요일"],
  message: ["Message", "메시지"], source: ["Source", "종류"], state: ["State", "상태"],
  on: ["On", "사용"], off: ["Off", "중지"], enabled: ["Enabled", "사용"],
  add: ["Add bell", "알림 추가"], addEvent: ["Add event", "일회성 알림 추가"],
  addRoutine: ["Add routine", "루틴 추가"], addSet: ["Add message set", "메시지 모음 추가"],
  edit: ["Edit", "수정"], remove: ["Delete", "삭제"], copy: ["Copy to days", "요일에 복사"],
  duplicate: ["Duplicate", "복제"], test: ["Play saved bell", "저장된 알림 재생"],
  reschedule: ["Reschedule", "다시 예약"], allOn: ["All on", "모두 사용"], allOff: ["All off", "모두 중지"],
  upcoming: ["Upcoming", "예정된 알림"], previousEvents: ["Previous", "지난 알림"],
  noUpcoming: ["No upcoming one-time events", "예정된 일회성 알림 없음"],
  deleteFinished: ["Delete finished events", "끝난 알림 삭제"],
  deleteFinishedQuestion: ["Delete {count} completed or missed one-time events?", "완료되었거나 실행되지 않은 일회성 알림 {count}개를 삭제할까요?"],
  deletedFinished: ["Deleted {deleted} finished events", "끝난 알림 {deleted}개를 삭제했습니다"],
  convert: ["Convert weekly bells to a routine", "주간 알림을 루틴으로 묶기"],
  noBells: ["No bells", "알림 없음"], noRoutines: ["Add a routine to group related bells.", "관련 알림을 묶을 루틴을 추가하세요."],
  noSets: ["Add a message set to rotate messages.", "메시지 모음을 만들어 여러 문구를 번갈아 사용하세요."],
  noActivity: ["No recent activity", "최근 실행 내역 없음"],
  queue: ["Shared speaker", "스피커 겹침"],
  queueHelp: ["Active bells at the same time will wait for a shared speaker.", "같은 시간에 같은 스피커를 쓰는 알림은 순서대로 재생됩니다."],
  unavailable: ["Unavailable", "사용 불가"], missing: ["Missing", "찾을 수 없음"],
  sent: ["Sent", "전송됨"], partial: ["Partially sent", "일부 전송됨"], failed: ["Failed", "실패"],
  cancelled: ["Cancelled", "취소됨"], queued: ["Queued", "대기 중"], sending: ["Sending", "전송 중"],
  pending: ["Pending", "예정"], completed: ["Completed", "완료"], missed: ["Missed", "실행되지 않음"],
  requestOnly: ["Sent means the player accepted the request; audible playback is not independently verified.", "전송됨은 재생 요청이 전달되었다는 뜻이며, 실제 소리가 났는지는 별도로 확인되지 않습니다."],
  manual: ["Manual test", "수동 테스트"], scheduled: ["Scheduled", "예약 실행"],
  save: ["Save", "저장"], saving: ["Saving…", "저장 중…"], saved: ["Saved", "저장됨"],
  create: ["Create", "추가"], cancel: ["Cancel", "취소"],
  close: ["Close", "닫기"], discard: ["Discard changes", "변경 취소"],
  unsaved: ["Unsaved changes", "저장하지 않은 변경 사항"],
  discardQuestion: ["Discard the unsaved changes in this editor?", "저장하지 않은 변경 사항을 버릴까요?"],
  changedElsewhere: ["This item changed elsewhere. Your draft is preserved; reload the saved version before saving.", "다른 곳에서 항목이 변경되었습니다. 초안은 유지됩니다. 저장된 내용을 다시 불러온 뒤 수정하세요."],
  reloadSaved: ["Reload saved version", "저장된 내용 다시 불러오기"],
  playQuestion: ["Play this saved bell now? This does not advance its message-set sequence.", "저장된 알림을 지금 재생할까요? 메시지 모음의 순서는 바뀌지 않습니다."],
  deleteQuestion: ["Delete this item?", "이 항목을 삭제할까요?"],
  deleteStale: ["Reload the current item before deleting it.", "최신 항목을 다시 불러온 뒤 삭제하세요."],
  name: ["Name", "이름"], routineName: ["Routine name", "루틴 이름"],
  direct: ["Direct message", "직접 입력"], random: ["Message set", "메시지 모음"],
  chooseSet: ["Choose a message set", "메시지 모음 선택"], insertTime: ["Insert time", "시간 넣기"],
  insertRandom: ["Insert random message", "모음 문구 넣기"],
  placeholders: ["Use %time% and %randomset%. Advanced Jinja templates are supported.", "%time%와 %randomset%를 사용할 수 있으며 Jinja 템플릿도 지원합니다."],
  addMessage: ["Add message", "문구 추가"], variant: ["Message variation", "문구"],
  provider: ["TTS provider", "음성 제공자"], legacy: ["Legacy TTS service", "기존 TTS 서비스"],
  chooseProvider: ["Choose a provider", "음성 제공자 선택"], language: ["Speech language", "음성 언어"],
  cache: ["Cache recurring speech", "반복 알림 음성 캐시"],
  chimes: ["Chime media IDs or URLs (one per line)", "알림음 미디어 ID 또는 URL (한 줄에 하나)"],
  introDelay: ["Chime-to-speech delay (seconds)", "알림음 이후 대기 시간(초)"],
  hold: ["Minimum speaker hold (seconds)", "스피커 최소 대기 시간(초)"],
  timeout: ["Playback wait limit (seconds)", "재생 대기 상한(초)"],
  grace: ["One-time recovery window (seconds)", "일회성 알림 복구 허용 시간(초)"],
  export: ["Download backup", "백업 다운로드"], restore: ["Restore backup", "백업 복원"],
  backupInfo: ["Backups include bells, routines, message sets and announcement settings.", "백업에는 알림, 루틴, 메시지 모음, 알림 설정이 포함됩니다."],
  file: ["JSON backup file", "JSON 백업 파일"], merge: ["Add to current schedule", "기존 일정에 추가"],
  replace: ["Replace current schedule", "기존 일정 교체"], includeSettings: ["Restore announcement settings", "알림 설정도 복원"],
  previewRestore: ["Preview restore", "복원 미리보기"], confirmRestore: ["Restore disabled", "중지 상태로 복원"],
  restoreWarning: ["Imported bells and routines start disabled. Replacing also pauses the master schedule.", "가져온 알림과 루틴은 중지 상태로 시작합니다. 교체 시 전체 일정도 일시 중지됩니다."],
  restoreQuestion: ["Apply this restore? Replace mode removes the current schedule. Download a backup first.", "복원을 적용할까요? 교체 모드는 기존 일정을 제거합니다. 먼저 백업을 다운로드하세요."],
  restored: ["Backup restored disabled", "중지 상태로 백업을 복원했습니다"],
  selectRows: ["Select weekly bells", "주간 알림 선택"], previewConvert: ["Preview conversion", "변환 미리보기"],
  commitConvert: ["Replace selected weekly bells", "선택한 주간 알림을 교체"],
  convertQuestion: ["Replace the selected weekly bells with this routine?", "선택한 주간 알림을 이 루틴으로 교체할까요?"],
  routineCount: ["{count} routine bells", "루틴 알림 {count}개"],
  counts: ["{bells} standalone bells · {routines} routines · {message_sets} message sets", "개별 알림 {bells}개 · 루틴 {routines}개 · 메시지 모음 {message_sets}개"],
  loading: ["Loading…", "불러오는 중…"], retry: ["Retry", "다시 시도"],
  noSpeaker: ["Select at least one speaker.", "스피커를 하나 이상 선택하세요."],
  noDay: ["Select at least one weekday.", "요일을 하나 이상 선택하세요."],
  tooLarge: ["Choose a JSON file smaller than 5 MB.", "5MB 미만의 JSON 파일을 선택하세요."],
  unavailableError: ["No selected speaker is available", "선택한 스피커를 사용할 수 없습니다"],
  more: ["More", "더 보기"], speakerCount: ["{count} speakers", "스피커 {count}개"],
  unavailableCount: ["{count} unavailable", "사용 불가 {count}개"], routinePaused: ["Routine paused", "루틴 일시 중지"],
  bellPaused: ["Paused", "일시 중지"],
};
DAYS.forEach((day, index) => { TEXT[day] = [day, ["월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일"][index]]; });

export function translate(key, language = "en", values = {}) {
  let text = TEXT[key]?.[language.startsWith("ko") ? 1 : 0] || key;
  for (const [name, value] of Object.entries(values)) text = text.replaceAll("{" + name + "}", String(value));
  return text;
}
