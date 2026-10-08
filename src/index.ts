import { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import { GoogleGenAI } from '@google/genai';
import { DatabaseSync } from 'node:sqlite';
import 'dotenv/config';


const botToken = process.env.BOT_TOKEN;
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!botToken || !geminiApiKey) {
  console.error('❌ Помилка: задайте BOT_TOKEN і GEMINI_API_KEY у файлі .env або змінних середовища.');
  process.exit(1);
}

const bot = new Telegraf(botToken);
const ai = new GoogleGenAI({ apiKey: geminiApiKey });
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

// Never let a failed Telegram callback terminate long polling.
bot.catch(async (error, ctx) => {
  console.error(`Помилка під час обробки Telegram update ${ctx.update.update_id}:`, error);
  try {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery('Сталася помилка. Спробуйте ще раз трохи пізніше.');
    } else if (ctx.chat) {
      await ctx.reply('Сталася помилка. Спробуйте ще раз трохи пізніше.');
    }
  } catch (replyError) {
    console.error('Не вдалося повідомити користувача про помилку:', replyError);
  }
});

const database = new DatabaseSync(process.env.DATABASE_PATH ?? 'life-sync.sqlite');
database.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    telegram_id INTEGER PRIMARY KEY,
    first_name TEXT NOT NULL DEFAULT '',
    username TEXT,
    group_name TEXT NOT NULL DEFAULT '',
    timezone TEXT NOT NULL DEFAULT 'Europe/Kyiv',
    wake_time TEXT NOT NULL DEFAULT '07:00',
    reminder_minutes INTEGER NOT NULL DEFAULT 30,
    weekly_schedule TEXT NOT NULL DEFAULT '',
    weekly_schedule_html TEXT NOT NULL DEFAULT '',
    bell_schedule TEXT NOT NULL DEFAULT '',
    today_events TEXT NOT NULL DEFAULT '',
    today_events_date TEXT NOT NULL DEFAULT '',
    today_event_exclusions TEXT NOT NULL DEFAULT '',
    today_event_exclusions_date TEXT NOT NULL DEFAULT '',
    raw_schedule_photo_id TEXT,
    ai_profile_consent INTEGER NOT NULL DEFAULT 1 CHECK (ai_profile_consent IN (0, 1)),
    is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1))
  );
  CREATE TABLE IF NOT EXISTS setup_state (
    telegram_id INTEGER PRIMARY KEY,
    step TEXT NOT NULL,
    field TEXT,
    group_name TEXT,
    prompt_chat_id INTEGER,
    prompt_message_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS scheduled_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    event_date TEXT NOT NULL,
    event_text TEXT NOT NULL,
    UNIQUE (telegram_id, event_date, event_text),
    FOREIGN KEY (telegram_id) REFERENCES profiles(telegram_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS notification_queue (
    notification_id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    event_date TEXT NOT NULL,
    event_key TEXT NOT NULL,
    notify_at INTEGER NOT NULL,
    event_at INTEGER NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'expired')),
    attempts INTEGER NOT NULL DEFAULT 0,
    UNIQUE (telegram_id, event_date, event_key),
    FOREIGN KEY (telegram_id) REFERENCES profiles(telegram_id) ON DELETE CASCADE
  );
`);

// Migrate existing profiles tables without changing their existing data.
const profileColumns = database.prepare('PRAGMA table_info(profiles)').all() as Array<{ name: string }>;
const existingColumns = new Set(profileColumns.map((column) => column.name));
const hadReminderSetting = existingColumns.has('reminder_minutes');
const profileMigrations: Array<[string, string]> = [
  ['first_name', "TEXT NOT NULL DEFAULT ''"],
  ['username', 'TEXT'],
  ['group_name', "TEXT NOT NULL DEFAULT ''"],
  ['timezone', "TEXT NOT NULL DEFAULT 'Europe/Kyiv'"],
  ['wake_time', "TEXT NOT NULL DEFAULT '07:00'"],
  ['reminder_minutes', 'INTEGER NOT NULL DEFAULT 30'],
  ['weekly_schedule', "TEXT NOT NULL DEFAULT ''"],
  ['weekly_schedule_html', "TEXT NOT NULL DEFAULT ''"],
  ['bell_schedule', "TEXT NOT NULL DEFAULT ''"],
  ['today_events', "TEXT NOT NULL DEFAULT ''"],
  ['today_events_date', "TEXT NOT NULL DEFAULT ''"],
  ['today_event_exclusions', "TEXT NOT NULL DEFAULT ''"],
  ['today_event_exclusions_date', "TEXT NOT NULL DEFAULT ''"],
  ['raw_schedule_photo_id', 'TEXT'],
  ['ai_profile_consent', 'INTEGER NOT NULL DEFAULT 1'],
  ['is_active', 'INTEGER NOT NULL DEFAULT 0'],
];
for (const [column, definition] of profileMigrations) {
  if (!existingColumns.has(column)) {
    database.exec(`ALTER TABLE profiles ADD COLUMN ${column} ${definition}`);
  }
}
const setupStateColumns = new Set((database.prepare('PRAGMA table_info(setup_state)').all() as Array<{ name: string }>).map((column) => column.name));
if (!setupStateColumns.has('group_name')) database.exec('ALTER TABLE setup_state ADD COLUMN group_name TEXT');
if (!setupStateColumns.has('prompt_chat_id')) database.exec('ALTER TABLE setup_state ADD COLUMN prompt_chat_id INTEGER');
if (!setupStateColumns.has('prompt_message_id')) database.exec('ALTER TABLE setup_state ADD COLUMN prompt_message_id INTEGER');

const upsertProfile = database.prepare(`
  INSERT INTO profiles (telegram_id, first_name, username)
  VALUES (?, ?, ?)
  ON CONFLICT(telegram_id) DO UPDATE SET
    first_name = excluded.first_name,
    username = excluded.username
`);
const getProfile = database.prepare('SELECT telegram_id, is_active, timezone, wake_time, reminder_minutes, weekly_schedule, weekly_schedule_html, bell_schedule, today_events, today_events_date, today_event_exclusions, today_event_exclusions_date, raw_schedule_photo_id, group_name FROM profiles WHERE telegram_id = ?');
const setProfileActive = database.prepare('UPDATE profiles SET is_active = ? WHERE telegram_id = ?');
const updateProfileSetting = database.prepare('UPDATE profiles SET timezone = ?, wake_time = ?, reminder_minutes = ?, group_name = ?, bell_schedule = ? WHERE telegram_id = ?');
const updateReminderMinutes = database.prepare('UPDATE profiles SET reminder_minutes = ? WHERE telegram_id = ?');
const clearSchedule = database.prepare("UPDATE profiles SET weekly_schedule = '', weekly_schedule_html = '', raw_schedule_photo_id = NULL, today_event_exclusions = '', today_event_exclusions_date = '' WHERE telegram_id = ?");
const updateTodayEvents = database.prepare('UPDATE profiles SET today_events = ?, today_events_date = ? WHERE telegram_id = ?');
const updateTodayExclusions = database.prepare('UPDATE profiles SET today_event_exclusions = ?, today_event_exclusions_date = ? WHERE telegram_id = ?');
const saveSchedulePhotoResult = database.prepare('UPDATE profiles SET weekly_schedule = ?, weekly_schedule_html = ?, raw_schedule_photo_id = ?, bell_schedule = ? WHERE telegram_id = ?');
const getSetupGroupName = database.prepare('SELECT group_name FROM setup_state WHERE telegram_id = ?');
const insertScheduledEvent = database.prepare('INSERT OR IGNORE INTO scheduled_events (telegram_id, event_date, event_text) VALUES (?, ?, ?)');
const listScheduledEvents = database.prepare('SELECT event_id, event_date, event_text FROM scheduled_events WHERE telegram_id = ? AND event_date >= ? ORDER BY event_date, event_text');
const listScheduledEventsForDate = database.prepare('SELECT event_id, event_date, event_text FROM scheduled_events WHERE telegram_id = ? AND event_date = ? ORDER BY event_text');
const listScheduledEventsBeforeDate = database.prepare('SELECT event_id, event_date, event_text FROM scheduled_events WHERE telegram_id = ? AND event_date < ?');
const listEventCleanupProfiles = database.prepare('SELECT telegram_id, timezone FROM profiles');
const getScheduledEvent = database.prepare('SELECT event_id, event_date, event_text FROM scheduled_events WHERE telegram_id = ? AND event_id = ?');
const deleteScheduledEvent = database.prepare('DELETE FROM scheduled_events WHERE telegram_id = ? AND event_id = ?');
const editScheduledEvent = database.prepare('UPDATE scheduled_events SET event_date = ?, event_text = ? WHERE telegram_id = ? AND event_id = ?');
const listActiveProfiles = database.prepare('SELECT telegram_id, is_active, timezone, wake_time, reminder_minutes, weekly_schedule, weekly_schedule_html, bell_schedule, today_events, today_events_date, today_event_exclusions, today_event_exclusions_date, raw_schedule_photo_id, group_name FROM profiles WHERE is_active = 1');
const insertNotification = database.prepare('INSERT OR IGNORE INTO notification_queue (telegram_id, event_date, event_key, notify_at, event_at, message) VALUES (?, ?, ?, ?, ?, ?)');
const getDueNotifications = database.prepare("SELECT notification_id, telegram_id, notify_at, event_at, message, attempts FROM notification_queue WHERE status = 'pending' AND notify_at <= ? ORDER BY notify_at LIMIT 100");
const markNotificationSent = database.prepare("UPDATE notification_queue SET status = 'sent', attempts = attempts + 1 WHERE notification_id = ? AND status = 'pending'");
const markNotificationAttempt = database.prepare("UPDATE notification_queue SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= 3 THEN 'expired' ELSE status END WHERE notification_id = ? AND status = 'pending'");
const expireNotification = database.prepare("UPDATE notification_queue SET status = 'expired' WHERE notification_id = ? AND status = 'pending'");
const expireNotificationByKey = database.prepare("UPDATE notification_queue SET status = 'expired' WHERE telegram_id = ? AND event_date = ? AND event_key LIKE ? AND status = 'pending'");
const deletePendingNotifications = database.prepare("DELETE FROM notification_queue WHERE telegram_id = ? AND status = 'pending'");
const deleteUnsentNotifications = database.prepare("DELETE FROM notification_queue WHERE telegram_id = ? AND status != 'sent'");
const getNotificationByKey = database.prepare('SELECT 1 FROM notification_queue WHERE telegram_id = ? AND event_date = ? AND event_key = ?');
const recordMorningSchedule = database.prepare("INSERT OR IGNORE INTO notification_queue (telegram_id, event_date, event_key, notify_at, event_at, message, status) VALUES (?, ?, 'morning_schedule', ?, ?, ?, 'sent')");
if (!hadReminderSetting) database.prepare("DELETE FROM notification_queue WHERE status != 'sent'").run();

// Preserve events saved by older versions in profiles.today_events.
const legacyEvents = database.prepare('SELECT telegram_id, today_events, today_events_date FROM profiles WHERE today_events != \'\' AND today_events_date != \'\'').all() as Array<{ telegram_id: number; today_events: string; today_events_date: string }>;
for (const profile of legacyEvents) {
  for (const event of profile.today_events.split('\n').map((line) => line.trim()).filter(Boolean)) {
    insertScheduledEvent.run(profile.telegram_id, profile.today_events_date, event);
  }
}

type Profile = {
  telegram_id: number;
  is_active: number;
  timezone: string;
  wake_time: string;
  reminder_minutes: number;
  weekly_schedule: string;
  weekly_schedule_html: string;
  bell_schedule: string;
  today_events: string;
  today_events_date: string;
  today_event_exclusions: string;
  today_event_exclusions_date: string;
  raw_schedule_photo_id: string | null;
  group_name: string;
};
type ScheduledEvent = { event_id: number; event_date: string; event_text: string };
type ProfileField = 'timezone' | 'wake_time' | 'reminder_minutes' | 'group_name' | 'bell_schedule';
type EditableTextField = 'group_name';
type PendingInput = { kind: 'profile'; field: ProfileField } | { kind: 'text_edit'; field: EditableTextField } | { kind: 'edit_photo_schedule' } | { kind: 'schedule_photo_review' } | { kind: 'today_event'; date: string; time: string | null } | { kind: 'today_event_date' } | { kind: 'today_event_time'; date: string } | { kind: 'today_event_end'; date: string; startTime: string } | { kind: 'today_event_title'; date: string; startTime: string; endTime: string | null } | { kind: 'today_event_manual_end'; date: string; startTime: string; title: string } | { kind: 'edit_today_event'; eventId: number } | { kind: 'schedule_photo' };
const schedulePhotoDrafts = new Map<number, { schedule: string; bellSchedule: string; fileId: string }>();
const saveSetupState = database.prepare('INSERT INTO setup_state (telegram_id, step, field, group_name, prompt_chat_id, prompt_message_id) VALUES (?, ?, ?, ?, NULL, NULL) ON CONFLICT(telegram_id) DO UPDATE SET step = excluded.step, field = excluded.field, group_name = excluded.group_name, prompt_chat_id = NULL, prompt_message_id = NULL');
const readSetupState = database.prepare('SELECT step, field, prompt_chat_id, prompt_message_id FROM setup_state WHERE telegram_id = ?');
const setSetupPrompt = database.prepare('UPDATE setup_state SET prompt_chat_id = ?, prompt_message_id = ? WHERE telegram_id = ?');
const deleteSetupState = database.prepare('DELETE FROM setup_state WHERE telegram_id = ?');
database.prepare("DELETE FROM setup_state WHERE step IN ('wait_schedule_text', 'wait_edit_schedule', 'wait_edit_schedule_day', 'wait_edit_schedule_day_preview', 'WAITING_FOR_WEEKLY_SCHEDULE_EDIT', 'wait_edit_schedule_ai', 'wait_add_schedule_entry', 'wait_edit_schedule_entry')").run();
database.prepare("DELETE FROM setup_state WHERE step IN ('WAITING_FOR_PROFILE_NOTE_EDIT', 'wait_prep', 'wait_commute')").run();
const stateSteps: Record<PendingInput['kind'], string> = {
  profile: 'wait_profile',
  text_edit: 'text_edit',
  edit_photo_schedule: 'wait_edit_photo_schedule',
  schedule_photo_review: 'wait_schedule_photo_review',
  today_event: 'wait_today_event',
  today_event_date: 'wait_today_event_date',
  today_event_time: 'wait_today_event_time',
  today_event_end: 'wait_today_event_end',
  today_event_title: 'wait_today_event_title',
  today_event_manual_end: 'wait_today_event_manual_end',
  edit_today_event: 'wait_edit_today_event',
  schedule_photo: 'wait_schedule_photo',
};
const pendingInputs = {
  set(userId: number, state: PendingInput) {
    const step = state.kind === 'text_edit'
      ? 'WAITING_FOR_GROUP_NAME'
      : state.kind === 'profile'
      ? ({ timezone: 'wait_timezone', wake_time: 'wait_wake_time', reminder_minutes: 'wait_reminder_minutes', group_name: 'wait_group_name', bell_schedule: 'wait_bell_schedule' } as const)[state.field]
      : stateSteps[state.kind];
    const profile = readProfile(userId);
    const field = state.kind === 'text_edit'
      ? state.field
      : state.kind === 'profile'
      ? state.field
      : state.kind === 'edit_today_event'
        ? `event:${state.eventId}`
        : state.kind === 'today_event'
          ? `event-date:${state.date}`
          : state.kind === 'today_event_time'
            ? `event-date:${state.date}`
            : state.kind === 'today_event_end'
              ? `event-date:${state.date}|start-time:${state.startTime}`
          : state.kind === 'today_event_title'
              ? `event-date:${state.date}|start-time:${state.startTime}|end-time:${state.endTime ?? 'auto'}`
            : state.kind === 'today_event_manual_end'
              ? `event-date:${state.date}|start-time:${state.startTime}|title:${encodeURIComponent(state.title)}`
        : null;
    saveSetupState.run(userId, step, field, profile?.group_name ?? null);
  },
  setPrompt(userId: number, chatId: number, messageId: number) {
    setSetupPrompt.run(chatId, messageId, userId);
  },
  getPrompt(userId: number): { chatId: number; messageId: number } | undefined {
    const row = readSetupState.get(userId) as { prompt_chat_id: number | null; prompt_message_id: number | null } | undefined;
    if (!row || row.prompt_chat_id === null || row.prompt_message_id === null) return undefined;
    return { chatId: row.prompt_chat_id, messageId: row.prompt_message_id };
  },
  get(userId: number): PendingInput | undefined {
    const row = readSetupState.get(userId) as { step: string; field: string | null } | undefined;
    if (!row) return undefined;
    if (row.step === 'WAITING_FOR_GROUP_NAME') return { kind: 'text_edit', field: 'group_name' };
    if (row.step === 'wait_edit_photo_schedule') return { kind: 'edit_photo_schedule' };
    if (row.step === 'wait_schedule_photo_review') return { kind: 'schedule_photo_review' };
    if (row.step === 'wait_today_event_date') return { kind: 'today_event_date' };
    if (row.step === 'wait_today_event') {
      const savedDate = row.field?.startsWith('event-date:') ? row.field.slice('event-date:'.length) : undefined;
      const profile = readProfile(userId);
      return { kind: 'today_event', date: savedDate ?? (profile ? localDate(profile.timezone) : localDate('Europe/Kyiv')), time: null };
    }
    if (row.step === 'wait_today_event_time') {
      const savedDate = row.field?.match(/^event-date:(\d{4}-\d{2}-\d{2})$/)?.[1];
      return savedDate ? { kind: 'today_event_time', date: savedDate } : undefined;
    }
    if (row.step === 'wait_today_event_end') {
      const savedState = row.field?.match(/^event-date:(\d{4}-\d{2}-\d{2})\|start-time:(\d{2}:\d{2})$/);
      return savedState ? { kind: 'today_event_end', date: savedState[1] ?? '', startTime: savedState[2] ?? '' } : undefined;
    }
    if (row.step === 'wait_today_event_title') {
      const savedState = row.field?.match(/^event-date:(\d{4}-\d{2}-\d{2})\|start-time:(\d{2}:\d{2})\|end-time:(\d{2}:\d{2}|auto)$/);
      if (savedState) return { kind: 'today_event_title', date: savedState[1] ?? '', startTime: savedState[2] ?? '', endTime: savedState[3] === 'auto' ? null : savedState[3] ?? null };
      const legacyState = row.field?.match(/^event-date:(\d{4}-\d{2}-\d{2})\|event-time:(\d{2}:\d{2})-(\d{2}:\d{2})$/);
      return legacyState ? { kind: 'today_event_title', date: legacyState[1] ?? '', startTime: legacyState[2] ?? '', endTime: legacyState[3] ?? null } : undefined;
    }
    if (row.step === 'wait_today_event_manual_end') {
      const savedState = row.field?.match(/^event-date:(\d{4}-\d{2}-\d{2})\|start-time:(\d{2}:\d{2})\|title:(.+)$/);
      if (!savedState) return undefined;
      try {
        return { kind: 'today_event_manual_end', date: savedState[1] ?? '', startTime: savedState[2] ?? '', title: decodeURIComponent(savedState[3] ?? '') };
      } catch {
        return undefined;
      }
    }
    if (row.step === 'wait_edit_today_event') {
      const eventId = Number(row.field?.replace('event:', ''));
      return Number.isInteger(eventId) && eventId > 0 ? { kind: 'edit_today_event', eventId } : undefined;
    }
    if (row.step === 'wait_schedule_photo') return { kind: 'schedule_photo' };
    if (row.step === 'wait_timezone' || row.step === 'wait_wake_time' || row.step === 'wait_reminder_minutes' || row.step === 'wait_group_name' || row.step === 'wait_bell_schedule') {
      const fields: Record<string, ProfileField> = { wait_timezone: 'timezone', wait_wake_time: 'wake_time', wait_reminder_minutes: 'reminder_minutes', wait_group_name: 'group_name', wait_bell_schedule: 'bell_schedule' };
      const field = fields[row.step];
      return field ? { kind: 'profile', field } : undefined;
    }
    return undefined;
  },
  delete(userId: number) {
    deleteSetupState.run(userId);
  },
};

function mainMenu(isActive: boolean) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(isActive ? '🛑 Зупинити бота' : '🚀 Запустити бота', 'account:toggle')],
    [Markup.button.callback('⚙️ Налаштування профілю', 'menu:profile')],
    [Markup.button.callback('📅 Регулярний розклад', 'menu:schedule')],
    [Markup.button.callback('📋 Переглянути графік', 'schedule:view')],
  ]);
}

function accountMessage(isActive: boolean) {
  return `Привіт! Я твій особистий менеджер дня.\nСтатус бота: ${isActive ? '🟢 Активний' : '🛑 Вимкнено'}`;
}

function profileMenu(profile: Profile) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🌍 Часовий пояс', 'profile:timezone')],
    [Markup.button.callback('🏫 Назва групи', 'profile:group_name')],
    [Markup.button.callback('⏰ Час підйому', 'profile:wake_time')],
    [Markup.button.callback('🔔 Розклад дзвінків', 'profile:bell_schedule')],
    [Markup.button.callback('⬅️ Назад', 'menu:home')],
  ]);
}

function profileMenuText(profile: Profile) {
  return `⚙️ Налаштування профілю\n\nГрупа: ${profile.group_name || 'не вказана'}\nЧасовий пояс: ${profile.timezone}\nПідйом: ${profile.wake_time}\nДзвінки:\n${profile.bell_schedule || 'не задані'}`;
}

function scheduleMenu(profile: Profile) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📌 Події', 'events:menu')],
    [Markup.button.callback('✏️ Редагувати розклад', 'schedule:edit')],
    [Markup.button.callback('📸 Завантажити фото розкладу', 'schedule:photo')],
    [Markup.button.callback('🗑️ Очистити розклад', 'schedule:clear')],
    [Markup.button.callback('⬅️ Назад до головного меню', 'menu:home')],
  ]);
}

function scheduleOverviewMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📋 Скласти графік на сьогодні', 'schedule:generate')],
    [Markup.button.callback('🔔 Налаштування сповіщень', 'notifications:settings')],
    [Markup.button.callback('🌅 Ранковий графік', 'schedule:morning-info')],
    [Markup.button.callback('⬅️ Назад до меню', 'menu:home')],
  ]);
}

function notificationSettingsMenu(profile: Profile) {
  const options = [5, 15, 30, 60, 80, 120];
  const rows = [
    options.slice(0, 3).map((minutes) => Markup.button.callback(`${profile.reminder_minutes === minutes ? '✅ ' : ''}${minutes} хв`, `notifications:set:${minutes}`)),
    options.slice(3).map((minutes) => Markup.button.callback(`${profile.reminder_minutes === minutes ? '✅ ' : ''}${minutes} хв`, `notifications:set:${minutes}`)),
    [Markup.button.callback('✏️ Свій інтервал', 'notifications:custom')],
    [Markup.button.callback('⬅️ Назад', 'schedule:view')],
  ];
  return Markup.inlineKeyboard(rows);
}

function notificationSettingsText(profile: Profile) {
  return `🔔 Нагадування надходитимуть за ${profile.reminder_minutes} хв до кожної пари та запланованої події.\n\nОберіть інтервал:`;
}

const scheduleDays = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П’ятниця', 'Субота', 'Неділя'];
function scheduleMenuText(profile: Profile) {
  const today = localDate(profile.timezone);
  const events = (listScheduledEventsForDate.all(profile.telegram_id, today) as ScheduledEvent[]).map((event) => event.event_text).join('\n');
  const schedule = profile.weekly_schedule_html || escapeHtml(profile.weekly_schedule.trim());
  return `<b>📅 Регулярний розклад</b>\n\nГрупа: ${escapeHtml(profile.group_name || 'не вказана')}\n\n${schedule || 'Розклад ще не додано.'}\n\nПодії на сьогодні:\n${escapeHtml(events || 'Подій поки немає.')}`;
}

function localDate(timezone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftIsoDate(isoDate: string, days: number) {
  const parts = isoDate.split('-').map(Number);
  const year = parts[0] ?? 0;
  const month = parts[1] ?? 0;
  const day = parts[2] ?? 0;
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

// 2026 fall teaching weeks start Sep 7; configure SEMESTER_START_DATE if your institution differs.
const configuredSemesterStartDate = process.env.SEMESTER_START_DATE || '2026-09-07';
function isValidIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
const semesterStartDate = isValidIsoDate(configuredSemesterStartDate) ? configuredSemesterStartDate : '2026-09-07';
if (semesterStartDate !== configuredSemesterStartDate) {
  console.warn('SEMESTER_START_DATE некоректна; для парності тижня використовується 2026-09-07.');
}

function weekParityForDate(isoDate: string) {
  const startParts = semesterStartDate.split('-').map(Number);
  const dateParts = isoDate.split('-').map(Number);
  const startMonday = new Date(Date.UTC(startParts[0] ?? 2026, (startParts[1] ?? 9) - 1, startParts[2] ?? 1));
  const dateMonday = new Date(Date.UTC(dateParts[0] ?? 2026, (dateParts[1] ?? 9) - 1, dateParts[2] ?? 1));
  startMonday.setUTCDate(startMonday.getUTCDate() - ((startMonday.getUTCDay() + 6) % 7));
  dateMonday.setUTCDate(dateMonday.getUTCDate() - ((dateMonday.getUTCDay() + 6) % 7));
  const weeks = Math.floor((dateMonday.getTime() - startMonday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return ((weeks % 2) + 2) % 2 === 0 ? 'Чисельник' : 'Знаменник';
}

function weeklyScheduleForDate(schedule: string, isoDate: string, timezone: string) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(new Date(`${isoDate}T12:00:00Z`));
  const dayCodes: Record<string, string> = { Monday: 'пн', Tuesday: 'вт', Wednesday: 'ср', Thursday: 'чт', Friday: 'пт', Saturday: 'сб', Sunday: 'нд' };
  const todayCode = dayCodes[weekday];
  const parityMarker = weekParityForDate(isoDate) === 'Чисельник' ? 'ЧБ' : 'ЗН';
  const dayIndex = ({ пн: 0, вт: 1, ср: 2, чт: 3, пт: 4, сб: 5, нд: 6 } as Record<string, number>)[todayCode ?? ''];
  if (dayIndex === undefined) return '';

  let inTodaySection = false;
  const result: string[] = [];
  for (const rawLine of schedule.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const header = parseScheduleDayHeader(line);
    if (header) {
      // OCR stores parity both on the day heading and on individual lessons.
      // A plain "Понеділок:" heading must remain eligible; lesson-level [ЧБ]/[ЗН]
      // markers are filtered below. Requiring parity on every heading dropped
      // the whole day's schedule for the common OCR format.
      inTodaySection = header.dayCode === todayCode && (!header.parity || header.parity === parityMarker);
      if (inTodaySection) result.push(`${scheduleDays[dayIndex]} [${parityMarker}]:`);
      continue;
    }
    if (/^(понеділок|вівторок|середа|четвер|п[’ʼ']?ятниця|субота|неділя|пн|вт|ср|чт|пт|сб|нд)\b/iu.test(line)) {
      inTodaySection = false;
      continue;
    }
    if (!inTodaySection) continue;
    const entryParity = line.match(/\[(ЧБ|ЗН)\]/iu)?.[1]?.toLocaleUpperCase('uk-UA');
    if (entryParity && entryParity !== parityMarker) continue;
    // Accept common OCR/manual forms: "1 пара ...", "1. Назва", "1: 08:30...",
    // and a time-first entry such as "08:30-09:50 Назва".
    if (/^\s*(?:[-•]\s*)?(?:\[(?:ЧБ|ЗН)\]\s*)?(?:\[\d{1,2}\]\s*)?\d{1,2}\s*(?:пара\b|[:.)-]|(?=\s+\p{L}))/iu.test(line)
      || /^\s*(?:[-•]\s*)?\d{1,2}:\d{2}\s*[-–—]\s*\d{1,2}:\d{2}\b/u.test(line)) {
      result.push(line);
    }
  }
  return result.join('\n');
}

function parseScheduleDayHeader(line: string) {
  const match = line.match(/^(понеділок|вівторок|середа|четвер|п[’ʼ']?ятниця|субота|неділя|пн|вт|ср|чт|пт|сб|нд)(?:\s*(?:\[(ЧБ|ЗН)\]|\((ЧБ|ЗН)\)))?\s*:?$/iu);
  if (!match) return undefined;
  const dayCode = dayCodeFromText(match[1] ?? '');
  if (!dayCode) return undefined;
  return { dayCode, parity: (match[2] ?? match[3])?.toLocaleUpperCase('uk-UA') };
}

function pairNumberFromScheduleLine(line: string) {
  const match = line.match(/^\s*(?:[-•]\s*)?(?:\[(?:ЧБ|ЗН)\]\s*)?(?:\[(\d{1,2})\]\s*)?(\d{1,2})\s*(?:пара\b|[:.)-]|(?=\s+\p{L}))/iu);
  const pairNumber = Number(match?.[1] ?? match?.[2]);
  return Number.isInteger(pairNumber) && pairNumber > 0 ? pairNumber : undefined;
}

function bellScheduleTimes(bellSchedule: string) {
  const times = new Map<number, number>();
  for (const line of bellSchedule.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d{1,2})\s*(?:пара\b\s*)?[:.)-]\s*([01]?\d|2[0-3]):([0-5]\d)\s*[-–—]\s*([01]?\d|2[0-3]):([0-5]\d)/iu);
    if (match) times.set(Number(match[1]), Number(match[2]) * 60 + Number(match[3]));
  }
  return times;
}

function parseScheduledEvent(input: string, timezone: string, defaultDate = localDate(timezone)): { eventDate: string; eventText: string } {
  const today = localDate(timezone);
  let remaining = input.trim();
  let eventDate = defaultDate;
  let dateToken = '';
  const dateMatch = remaining.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4})\b/);
  if (dateMatch) {
    dateToken = dateMatch[0];
    if (dateToken.includes('-')) {
      eventDate = dateToken;
    } else {
      const dateParts = dateToken.split('.').map(Number);
      const day = dateParts[0] ?? 0;
      const month = dateParts[1] ?? 0;
      const year = dateParts[2] ?? 0;
      eventDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  } else {
    const relative = remaining.match(/\b(сьогодні|today|завтра|tomorrow)\b/i);
    if (relative) {
      dateToken = relative[0];
      eventDate = /завтра|tomorrow/i.test(dateToken) ? shiftIsoDate(today, 1) : today;
    } else {
      const weekdayPattern = /\b(понеділок|понеділка|пн\.?|вівторок|вівторка|вт\.?|середа|середу|ср\.?|четвер|чт\.?|п['’ʼ]?ятниця|пт\.?|субота|суботу|сб\.?|неділя|неділю|нд\.?)\b/i;
      const weekday = remaining.match(weekdayPattern);
      if (weekday) {
        dateToken = weekday[0];
        const normalized = dateToken.toLocaleLowerCase('uk-UA').replace(/[’ʼ']/g, '');
        const weekdayCodes: Record<string, number> = {
          пн: 1, понеділок: 1, понеділка: 1, вт: 2, вівторок: 2, вівторка: 2,
          ср: 3, середа: 3, середу: 3, чт: 4, четвер: 4, пт: 5, пятниця: 5,
          сб: 6, субота: 6, суботу: 6, нд: 0, неділя: 0, неділю: 0,
        };
        const targetDay = weekdayCodes[normalized.replace('.', '')];
        if (targetDay === undefined) throw new Error('Не вдалося розпізнати день тижня.');
        const currentDay = new Date(`${today}T12:00:00Z`).getUTCDay();
        const offset = (targetDay - currentDay + 7) % 7;
        eventDate = shiftIsoDate(today, offset);
      }
    }
  }

  const dateParts = eventDate.split('-').map(Number);
  const year = dateParts[0] ?? 0;
  const month = dateParts[1] ?? 0;
  const day = dateParts[2] ?? 0;
  const checked = new Date(Date.UTC(year, month - 1, day));
  if (checked.getUTCFullYear() !== year || checked.getUTCMonth() !== month - 1 || checked.getUTCDate() !== day) {
    throw new Error('Некоректна дата події.');
  }
  if (eventDate < today) throw new Error('Дата події вже минула.');

  const timeMatch = remaining.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!timeMatch) throw new Error('Додайте час події у форматі ГГ:ХХ, наприклад 16:00.');
  const time = `${(timeMatch[1] ?? '00').padStart(2, '0')}:${timeMatch[2] ?? '00'}`;
  remaining = remaining.replace(dateToken, ' ').replace(timeMatch[0], ' ').trim().replace(/^[,;\-–\s]+|[,;\-–\s]+$/g, '');
  if (!remaining) throw new Error('Додайте назву події.');
  return { eventDate, eventText: `${time} ${remaining}` };
}

function parseEventDateInput(input: string, timezone: string) {
  const value = input.trim();
  const supportedDate = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4}|сьогодні|today|завтра|tomorrow|понеділок|понеділка|пн\.?|вівторок|вівторка|вт\.?|середа|середу|ср\.?|четвер|чт\.?|п['’ʼ]?ятниця|пт\.?|субота|суботу|сб\.?|неділя|неділю|нд\.?)$/iu;
  if (!supportedDate.test(value)) {
    throw new Error('Введіть дату як РРРР-ММ-ДД або ДД.ММ.РРРР, чи напишіть «сьогодні» або «завтра».');
  }
  return parseScheduledEvent(`${value} 00:00 Подія`, timezone).eventDate;
}

function cancelKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('❌ Скасувати', 'input:cancel')]]);
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const richTextTags: Record<string, string> = {
  b: 'b', strong: 'strong', i: 'i', em: 'em', u: 'u', ins: 'ins',
  s: 's', strike: 'strike', del: 'del', code: 'code', pre: 'pre', 'tg-spoiler': 'tg-spoiler',
};

function sanitizeRichText(input: string): { html: string; plainText: string } {
  const normalized = input.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  const tokens = normalized.split(/(<[^>]*>)/g);
  const stack: string[] = [];
  let html = '';
  for (const token of tokens) {
    if (!token.startsWith('<') || !token.endsWith('>')) {
      html += escapeHtml(token);
      continue;
    }
    const match = token.match(/^<(\/)?([a-z-]+)>$/i);
    const tag = match?.[2]?.toLowerCase();
    if (!match || !tag || !richTextTags[tag]) {
      html += escapeHtml(token);
      continue;
    }
    if (match[1]) {
      if (stack.pop() !== tag) throw new Error('Теги форматування мають бути правильно закриті.');
      html += `</${richTextTags[tag]}>`;
    } else {
      if ((tag === 'code' || tag === 'pre' || stack.includes('code') || stack.includes('pre')) && stack.length) {
        throw new Error('Фрагмент коду або блоку коду не можна вкладати в інше форматування.');
      }
      stack.push(tag);
      html += `<${richTextTags[tag]}>`;
    }
  }
  if (stack.length) throw new Error('Закрийте всі теги форматування, наприклад <b>текст</b>.');
  const plainText = html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  return { html, plainText };
}

function messageTextAsHtml(text: string, entities: Array<{ type: string; offset: number; length: number }> = []) {
  const entityTags: Record<string, string> = {
    bold: 'b', italic: 'i', underline: 'u', strikethrough: 's', code: 'code', pre: 'pre', spoiler: 'tg-spoiler',
  };
  const events = entities.flatMap((entity) => {
    const tag = entityTags[entity.type];
    return tag && entity.offset >= 0 && entity.length > 0 && entity.offset + entity.length <= text.length
      ? [{ position: entity.offset, tag, length: entity.length, closing: false }, { position: entity.offset + entity.length, tag, length: entity.length, closing: true }]
      : [];
  }).sort((left, right) => left.position - right.position || Number(right.closing) - Number(left.closing) || (left.closing ? left.length - right.length : right.length - left.length));
  let html = '';
  let cursor = 0;
  for (const event of events) {
    html += escapeHtml(text.slice(cursor, event.position));
    html += event.closing ? `</${event.tag}>` : `<${event.tag}>`;
    cursor = event.position;
  }
  html += escapeHtml(text.slice(cursor));
  return html;
}

function textEditPrompt(field: EditableTextField) {
  void field;
  return 'Надішліть нову назву групи у відповідь на це повідомлення.';
}

function textEditResultKeyboard(field: EditableTextField) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('👁 Переглянути оновлений текст', `text-edit:view:${field}`)],
    [Markup.button.callback('🔙 До меню', 'menu:profile')],
  ]);
}

function textEditBackKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('🔙 До меню', 'menu:profile')]]);
}

async function editStoredPrompt(ctx: any, prompt: { chatId: number; messageId: number } | undefined, text: string, markup: any, mode: 'HTML' | 'plain' = 'HTML') {
  const options = mode === 'HTML' ? { ...markup, parse_mode: 'HTML' as const } : markup;
  if (prompt) {
    await ctx.telegram.editMessageText(prompt.chatId, prompt.messageId, undefined, text, options);
    return;
  }
  await ctx.reply(text, options);
}

async function deleteInputMessage(ctx: any) {
  try {
    await ctx.deleteMessage(ctx.message.message_id);
  } catch {
    // The user may have deleted the message or Telegram may reject deletion permissions.
  }
}

function readProfile(userId: number): Profile | undefined {
  return getProfile.get(userId) as Profile | undefined;
}

async function showProfileMenu(ctx: any, edit = true) {
  const profile = readProfile(ctx.from.id);
  if (!profile) return ctx.answerCbQuery('Спершу надішліть /start.');
  const text = profileMenuText(profile);
  return edit ? ctx.editMessageText(text, profileMenu(profile)) : ctx.reply(text, profileMenu(profile));
}

async function showScheduleMenu(ctx: any, edit = true) {
  const profile = readProfile(ctx.from.id);
  if (!profile) return ctx.answerCbQuery('Спершу надішліть /start.');
  const text = scheduleMenuText(profile);
  const markup = { ...scheduleMenu(profile), parse_mode: 'HTML' as const };
  return edit ? ctx.editMessageText(text, markup) : ctx.reply(text, markup);
}

function getOneOffEvents(userId: number, timezone: string): ScheduledEvent[] {
  return listScheduledEvents.all(userId, localDate(timezone)) as ScheduledEvent[];
}

function syncTodayEventsProfile(userId: number, timezone: string) {
  const today = localDate(timezone);
  const events = listScheduledEventsForDate.all(userId, today) as ScheduledEvent[];
  updateTodayEvents.run(events.map((event) => event.event_text).join('\n'), today, userId);
}

function createScheduledEvent(userId: number, timezone: string, eventDate: string, eventText: string) {
  insertScheduledEvent.run(userId, eventDate, eventText);
  syncTodayEventsProfile(userId, timezone);
}

function eventsMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➕ Додати подію', 'events:add')],
    [Markup.button.callback('❌ Видалити подію', 'events:delete-list')],
    [Markup.button.callback('✏️ Змінити подію', 'events:edit-list')],
    [Markup.button.callback('⬅️ Назад', 'events:home')],
  ]);
}

function eventDateMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Сьогодні', 'events:add-date:today'), Markup.button.callback('Завтра', 'events:add-date:tomorrow')],
    [Markup.button.callback('📆 Вибрати дату', 'events:add-date:custom')],
    [Markup.button.callback('⬅️ Назад', 'events:menu')],
  ]);
}

async function promptEventTime(ctx: any, date: string) {
  pendingInputs.set(ctx.from.id, { kind: 'today_event_time', date });
  await ctx.reply(`На ${date} о котрій починається подія?`, Markup.forceReply().placeholder('16:00 або 16:00-17:30'));
}

async function promptEventInput(ctx: any, date: string, time?: string) {
  pendingInputs.set(ctx.from.id, { kind: 'today_event', date, time: time ?? null });
  if (time) {
    await ctx.reply(`Напишіть назву події на ${date} о ${time}.`, Markup.forceReply().placeholder('Наприклад: Зустріч з викладачем'));
    return;
  }
  await ctx.reply(`Введіть час і назву події на ${date}. Якщо дату не вкажете, використаю цей день. Наприклад: «16:00 Зал».`, Markup.forceReply().placeholder('16:00 Зал'));
}

async function safeEditMessageText(ctx: any, text: string, markup: any) {
  try {
    await ctx.editMessageText(text, markup);
  } catch (error) {
    const description = (error as { response?: { description?: string } })?.response?.description ?? '';
    if (!description.includes('message is not modified')) throw error;
  }
}

async function showEventsMenu(ctx: any, edit = true) {
  const profile = readProfile(ctx.from.id);
  if (!profile) return ctx.answerCbQuery('Спершу надішліть /start.');
  const events = getOneOffEvents(ctx.from.id, profile.timezone);
  const message = `📌 Події\n\n${events.length ? events.map((event) => `${event.event_date} — ${event.event_text}`).join('\n') : 'Майбутніх подій поки немає.'}`;
  return edit ? safeEditMessageText(ctx, message, eventsMenu()) : ctx.reply(message, eventsMenu());
}

async function showOneOffChoices(ctx: any, operation: 'delete' | 'edit') {
  const profile = readProfile(ctx.from.id);
  if (!profile) return ctx.answerCbQuery('Спершу надішліть /start.');
  const events = getOneOffEvents(ctx.from.id, profile.timezone);
  const rows = events.map((event) => [
    Markup.button.callback(`${operation === 'delete' ? '❌ Видалити' : '✏️ Змінити'}: ${event.event_date} ${event.event_text}`.slice(0, 64), `events:${operation}:${event.event_id}`),
  ]);
  rows.push([Markup.button.callback('⬅️ Назад до подій', 'events:menu')]);
  await safeEditMessageText(
    ctx,
    events.length ? `Оберіть подію:\n\n${events.map((event) => `${event.event_date} — ${event.event_text}`).join('\n')}` : 'Майбутніх подій немає.',
    Markup.inlineKeyboard(rows),
  );
}

type CancellableTodayItem = { kind: 'event'; index: number; text: string } | { kind: 'class'; index: number; text: string; startMinute: number };

function normalizeDayAlias(value: string) {
  return value.toLocaleLowerCase('uk-UA').normalize('NFC').replace(/[’ʼ']/g, "'");
}

function dayCodeFromText(line: string): string | undefined {
  const aliases: Record<string, string> = {
    понеділок: 'пн', 'пн': 'пн', вівторок: 'вт', 'вт': 'вт', середа: 'ср', 'ср': 'ср', четвер: 'чт', 'чт': 'чт',
    "п'ятниця": 'пт', 'пятниця': 'пт', 'пт': 'пт', субота: 'сб', 'сб': 'сб', неділя: 'нд', 'нд': 'нд',
  };
  const matches = [...line.matchAll(/(?:^|[\s,|])((?:понеділок|вівторок|середа|четвер|п[’ʼ']?ятниця|субота|неділя|пн|вт|ср|чт|пт|сб|нд))(?=$|[\s,:|])/giu)];
  for (const match of matches) {
    const normalized = normalizeDayAlias(match[1] ?? '');
    const code = aliases[normalized];
    if (code) return code;
  }
  return undefined;
}

function readCurrentTodayItems(profile: Profile, date = localDate(profile.timezone)): CancellableTodayItem[] {
  const oneOffs = (listScheduledEventsForDate.all(profile.telegram_id, date) as ScheduledEvent[])
    .map((event) => ({ kind: 'event' as const, index: event.event_id, text: event.event_text }));
  const excluded = profile.today_event_exclusions_date === date
    ? new Set(profile.today_event_exclusions.split('\n').map((line) => line.trim()).filter(Boolean))
    : new Set<string>();
  const todaysSchedule = weeklyScheduleForDate(profile.weekly_schedule, date, profile.timezone);
  const bellTimes = bellScheduleTimes(profile.bell_schedule);
  const classes = todaysSchedule.split(/\r?\n/).slice(1).flatMap((line, index): CancellableTodayItem[] => {
    if (!line || excluded.has(line)) return [];
    const pairNumber = pairNumberFromScheduleLine(line);
    const startMinute = timeStringToMinutes(line) ?? (pairNumber === undefined ? undefined : bellTimes.get(pairNumber));
    if (startMinute === undefined) return [];
    return [{ kind: 'class', index: pairNumber ?? index + 1, text: line, startMinute }];
  });

  return [...oneOffs, ...classes];
}

function localDateTimeToEpoch(date: string, minuteOfDay: number, timezone: string) {
  const dayOffset = Math.floor(minuteOfDay / 1440);
  const minute = ((minuteOfDay % 1440) + 1440) % 1440;
  const eventDate = shiftIsoDate(date, dayOffset);
  const [year = 2026, month = 1, day = 1] = eventDate.split('-').map(Number);
  const hour = Math.floor(minute / 60);
  const minutePart = minute % 60;
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minutePart);
  let estimate = targetAsUtc;

  // Iteratively correct the UTC guess until it represents the requested wall-clock time.
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(estimate));
    const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
    const representedAsUtc = Date.UTC(values.year ?? year, (values.month ?? month) - 1, values.day ?? day, values.hour ?? hour, values.minute ?? minutePart);
    estimate += targetAsUtc - representedAsUtc;
  }
  return estimate;
}

function timeStringToMinutes(value: string) {
  const match = value.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

function reminderTextHash(value: string) {
  let hash = 5381;
  for (const char of value) hash = ((hash << 5) + hash + char.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}

function enqueueReminder(profile: Profile, date: string, key: string, minute: number, title: string) {
  const eventAt = localDateTimeToEpoch(date, minute, profile.timezone);
  if (eventAt <= Date.now()) return;
  const requestedReminderAt = eventAt - profile.reminder_minutes * 60_000;
  const reminderAt = Math.max(requestedReminderAt, Date.now());
  const actualMinutesUntilEvent = Math.max(0, Math.ceil((eventAt - reminderAt) / 60_000));
  insertNotification.run(
    profile.telegram_id,
    date,
    key,
    reminderAt,
    eventAt,
    `⏰ Нагадування: через ${actualMinutesUntilEvent} хвилин ${title}`,
  );
}

function localTime(timezone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
}

let notificationSchedulerBusy = false;

function cleanupExpiredScheduledEvents(now: number) {
  const profiles = listEventCleanupProfiles.all() as Array<{ telegram_id: number; timezone: string }>;
  for (const profile of profiles) {
    const today = localDate(profile.timezone);
    const expiredEvents = listScheduledEventsBeforeDate.all(profile.telegram_id, today) as ScheduledEvent[];
    const todayEvents = listScheduledEventsForDate.all(profile.telegram_id, today) as ScheduledEvent[];

    for (const event of todayEvents) {
      const endMatch = event.event_text.match(/^([01]?\d|2[0-3]):[0-5]\d\s*[-–—]\s*([01]?\d|2[0-3]):([0-5]\d)(?:\s|$)/);
      if (!endMatch) continue;
      const endMinute = Number(endMatch[2]) * 60 + Number(endMatch[3]);
      if (localDateTimeToEpoch(today, endMinute, profile.timezone) <= now) expiredEvents.push(event);
    }

    let removedTodayEvent = false;
    for (const event of expiredEvents) {
      expireNotificationByKey.run(profile.telegram_id, event.event_date, `event:${event.event_id}:%`);
      deleteScheduledEvent.run(profile.telegram_id, event.event_id);
      if (event.event_date === today) removedTodayEvent = true;
    }
    if (removedTodayEvent) syncTodayEventsProfile(profile.telegram_id, profile.timezone);
  }
}

async function runNotificationScheduler() {
  if (notificationSchedulerBusy) return;
  notificationSchedulerBusy = true;
  try {
    const now = Date.now();
    cleanupExpiredScheduledEvents(now);
    const profiles = listActiveProfiles.all() as Profile[];
    for (const profile of profiles) {
      const today = localDate(profile.timezone);
      for (const date of [today, shiftIsoDate(today, 1)]) {
        const items = readCurrentTodayItems(profile, date);
        const classes = items.filter((item) => item.kind === 'class');
        for (const item of classes) {
          enqueueReminder(profile, date, `class:${item.index}:${reminderTextHash(item.text)}`, item.startMinute, `пара: ${item.text}`);
        }

        const events = listScheduledEventsForDate.all(profile.telegram_id, date) as ScheduledEvent[];
        for (const event of events) {
          const startMinute = timeStringToMinutes(event.event_text);
          if (startMinute === undefined) continue;
          enqueueReminder(profile, date, `event:${event.event_id}:${reminderTextHash(event.event_text)}`, startMinute, event.event_text);
        }
      }

      const localNow = localTime(profile.timezone, new Date(now));
      if (localNow === profile.wake_time && !getNotificationByKey.get(profile.telegram_id, today, 'morning_schedule')) {
        try {
          const schedule = await generateTodaySchedule(profile, new Date(now));
          await bot.telegram.sendMessage(profile.telegram_id, schedule);
          recordMorningSchedule.run(profile.telegram_id, today, now, now, schedule);
        } catch (error) {
          console.error(`Не вдалося надіслати ранковий графік користувачу ${profile.telegram_id}:`, error);
        }
      }
    }

    const due = getDueNotifications.all(now) as Array<{ notification_id: number; telegram_id: number; event_at: number; notify_at: number; message: string; attempts: number }>;
    for (const notification of due) {
      const recipient = readProfile(notification.telegram_id);
      if (!recipient || recipient.is_active !== 1) {
        expireNotification.run(notification.notification_id);
        continue;
      }
      if (notification.event_at <= now || now - notification.notify_at > 2 * 60_000) {
        expireNotification.run(notification.notification_id);
        continue;
      }
      try {
        await bot.telegram.sendMessage(notification.telegram_id, notification.message);
        markNotificationSent.run(notification.notification_id);
      } catch (error) {
        markNotificationAttempt.run(notification.notification_id);
        console.error(`Не вдалося надіслати нагадування користувачу ${notification.telegram_id}:`, error);
      }
    }
  } catch (error) {
    console.error('Помилка планувальника нагадувань:', error);
  } finally {
    notificationSchedulerBusy = false;
  }
}

const SYSTEM_INSTRUCTION = `
Ти — планувальник дня. Складай відповідь українською тільки з профілю, переданого розкладу саме на сьогодні і today_events. Переданий блок розкладу вже відфільтрований кодом за днем і парністю: не додавай заняття з інших днів і не змінюй [ЧБ]/[ЗН]. Не вигадуй подій, часу, назв, аудиторій чи тривалості.

Правила:
- Використовуй лише переданий список занять на сьогодні; пари впорядкуй за точним часом початку.
- Використовуй wake_time як час підйому.
- Обов'язково включи кожну передану пару і кожну передану today_event рівно один раз. Не пропускай події, не перейменовуй їх і не вигадуй нових.
- Розташуй заняття та події у часовому порядку. Збережи точний час і назву кожного запису. Події без часу познач як гнучкі.
- Записи weekly_schedule без часу також збережи як гнучкі, без вигаданого часу.
- Сон: пораду «💡 Щоб виспатися, рекомендуємо лягти до XX:XX» (за 8 годин до підйому) додавай лише для підйому до 07:00, якщо немає справ після опівночі.

Формат:
Ось ваш розклад на сьогодні ([Дата], [День тижня]):
⏰ [HH:MM] — Підйом
🎓 [HH:MM] – [HH:MM] — [пара та відомі деталі]
🏋️‍♂️ / 💻 — [лише наявні події]
Виводь тільки потрібні рядки й обґрунтовану пораду про сон; без пояснень і зайвих секцій.
`;

function scheduleImagePrompt(groupName: string) {
  return `Зчитай фото лише для групи «${groupName}». Витягни номери пар, назви предметів, аудиторії та позначки [ЧБ]/[ЗН]; не вигадуй нерозбірливе. Якщо видно час дзвінків, поверни його окремо. Лише JSON: {"schedule":"Понеділок:\\n1 пара Назва [ЧБ]","bell_schedule":"1: 08:30-09:50\\n2: 10:05-11:25"}. Якщо дзвінків на фото немає, bell_schedule має бути порожнім рядком.`;
}
const DAILY_SCHEDULE_PROMPT = 'Склади короткий таймлайн лише на вказаний день українською. Переданий розклад містить тільки заняття цього дня й цієї парності. Використовуй час підйому з профілю. Не перенось заняття з інших днів і не вигадуй даних. Виведи лише потрібні часові рядки.';

async function generateGemini(
  contents: any,
  systemInstruction: string,
  generationOptions: { responseMimeType?: 'application/json'; maxOutputTokens?: number } = {},
) {
  const models = [DEFAULT_GEMINI_MODEL];
  let lastError: unknown;

  for (const model of models) {
    try {
      const result = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          ...generationOptions,
          httpOptions: {
            // Fail over quickly; long sequential timeouts make the bot appear frozen.
            timeout: 12_000,
            retryOptions: { attempts: 1 },
          },
        },
      });
      return result;
    } catch (error) {
      lastError = error;
      const status = (error as { status?: number }).status;
      const retryable = status === undefined || status === 408 || status === 429 || (status >= 500 && status <= 599);
      if (!retryable) {
        if (status === 404) {
          console.warn(`Gemini model ${model} is unavailable for this API key.`);
          throw error;
        }
        throw error;
      }
      console.warn(`Gemini model ${model} returned${status ? ` HTTP ${status}` : ' a network error'}. No fallback model is configured.`);
    }
  }

  throw lastError ?? new Error('No Gemini models are configured.');
}

async function estimateEventEndTime(date: string, startTime: string, title: string, timezone: string) {
  const result = await generateGemini(
    `Дата: ${date}\nЧасовий пояс: ${timezone}\nПочаток події: ${startTime}\nНазва події: ${title}`,
    'Оціни реалістичну тривалість події за її назвою. Поверни лише час завершення у форматі HH:mm. Завершення має бути пізніше початку й того самого дня. Не додавай пояснень.',
    { maxOutputTokens: 20 },
  );
  const match = (result.text ?? '').trim().match(/(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?:$|\D)/);
  if (!match) throw new Error('Gemini повернув некоректний час завершення.');
  const endTime = `${(match[1] ?? '00').padStart(2, '0')}:${match[2] ?? '00'}`;
  if (endTime <= startTime) throw new Error('Gemini оцінив час завершення раніше за початок.');
  return endTime;
}

async function generateTodaySchedule(profile: Profile, now = new Date()): Promise<string> {
    const today = localDate(profile.timezone, now);
    const localNow = new Intl.DateTimeFormat('uk-UA', {
      timeZone: profile.timezone,
      weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).format(now);
    const parity = weekParityForDate(today);
    const dayContext = `Поточний місцевий час: ${localNow}. Дата: ${today}. Парність тижня: ${parity}.`;
    const todaysWeeklySchedule = weeklyScheduleForDate(profile.weekly_schedule, today, profile.timezone);
    const dayLabel = new Intl.DateTimeFormat('uk-UA', { timeZone: profile.timezone, weekday: 'long' }).format(new Date(`${today}T12:00:00Z`));
    const events = (listScheduledEventsForDate.all(profile.telegram_id, today) as ScheduledEvent[]).map((event) => event.event_text).join('\n');
    const exclusions = profile.today_event_exclusions_date === today ? profile.today_event_exclusions : '';
    const result = await generateGemini(
      `${DAILY_SCHEDULE_PROMPT}\n\n${dayContext}\nДень: ${dayLabel}. Часовий пояс: ${profile.timezone}\nГрупа: ${profile.group_name || 'не вказана'}\nЧас підйому з профілю: ${profile.wake_time}\n\nbell_schedule для відповідності номера пари часу:\n${profile.bell_schedule || 'не заданий'}\n\nЄдиний дозволений блок розкладу на цей день і парність:\n${todaysWeeklySchedule || 'занять немає'}\n\ntoday_events ${today}:\n${events || 'немає'}\n\nСкасовані заняття:\n${exclusions || 'немає'}`,
      `${SYSTEM_INSTRUCTION}\n\nКонтекст на сьогодні (враховуй як істину): ${dayContext}`,
      { maxOutputTokens: 1200 },
    );
    const generated = result.text?.trim();
    if (!generated) throw new Error('Gemini повернув порожній графік.');
    return generated;
}

async function sendTodaySchedule(ctx: any) {
  if (ctx.chat?.type !== 'private') return;
  const profile = readProfile(ctx.from.id);
  if (!profile) {
    await ctx.reply('Спершу надішліть /start.');
    return;
  }

  try {
    await ctx.reply('📋 Складаю графік на сьогодні…');
    await ctx.reply(await generateTodaySchedule(profile));
  } catch (error) {
    console.error('Не вдалося скласти графік:', error);
    await ctx.reply('❌ Не вдалося скласти графік. Перевірте доступ до Gemini API або спробуйте пізніше.');
  }
}

bot.start(async (ctx) => {
  if (ctx.chat.type !== 'private') return;

  try {
    pendingInputs.delete(ctx.from.id);
    schedulePhotoDrafts.delete(ctx.from.id);
    upsertProfile.run(ctx.from.id, ctx.from.first_name, ctx.from.username ?? null);
    const profile = getProfile.get(ctx.from.id) as { is_active: number } | undefined;
    await ctx.reply(accountMessage(profile?.is_active === 1), mainMenu(profile?.is_active === 1));
  } catch (error) {
    console.error('Не вдалося створити або оновити профіль:', error);
    await ctx.reply('❌ Не вдалося завантажити профіль. Спробуйте ще раз пізніше.');
  }
});

bot.command('today', sendTodaySchedule);
bot.command('cancel', async (ctx) => {
  const pending = pendingInputs.get(ctx.from.id);
  pendingInputs.delete(ctx.from.id);
  schedulePhotoDrafts.delete(ctx.from.id);
  await ctx.reply('Введення скасовано.');
  if (pending?.kind === 'profile' && pending.field === 'reminder_minutes') {
    const profile = readProfile(ctx.from.id);
    if (profile) await ctx.reply(notificationSettingsText(profile), notificationSettingsMenu(profile));
  }
  else if (pending?.kind === 'profile' || pending?.kind === 'text_edit') await showProfileMenu(ctx, false);
  else if (pending?.kind === 'schedule_photo' || pending?.kind === 'edit_photo_schedule' || pending?.kind === 'schedule_photo_review') await showScheduleMenu(ctx, false);
  else if (pending) await showEventsMenu(ctx, false);
});

bot.action('account:toggle', async (ctx) => {
  try {
    const current = getProfile.get(ctx.from.id) as { is_active: number } | undefined;
    if (!current) {
      await ctx.answerCbQuery('Спершу надішліть /start.');
      return;
    }

    const isActive = current.is_active !== 1;
    setProfileActive.run(isActive ? 1 : 0, ctx.from.id);
    if (!isActive) deletePendingNotifications.run(ctx.from.id);
    await ctx.answerCbQuery(isActive ? 'Бота запущено.' : 'Бота зупинено.');
    await ctx.editMessageText(accountMessage(isActive), mainMenu(isActive));
  } catch (error) {
    console.error('Не вдалося змінити статус бота:', error);
    await ctx.answerCbQuery('Не вдалося змінити статус. Спробуйте ще раз.');
  }
});

bot.action('menu:profile', async (ctx) => {
  await ctx.answerCbQuery();
  try { await showProfileMenu(ctx); } catch (error) { console.error('Не вдалося відкрити налаштування:', error); }
});

bot.action('menu:schedule', async (ctx) => {
  await ctx.answerCbQuery();
  try { await showScheduleMenu(ctx); } catch (error) { console.error('Не вдалося відкрити розклад:', error); }
});

bot.action('menu:home', async (ctx) => {
  pendingInputs.delete(ctx.from.id);
  schedulePhotoDrafts.delete(ctx.from.id);
  await ctx.answerCbQuery();
  const profile = readProfile(ctx.from.id);
  if (profile) await ctx.editMessageText(accountMessage(profile.is_active === 1), mainMenu(profile.is_active === 1));
});

const profilePrompts: Record<ProfileField, string> = {
  timezone: '',
  wake_time: 'Надішліть час підйому у форматі ГГ:ХХ, наприклад 07:00.',
  reminder_minutes: 'Введіть інтервал нагадування в хвилинах — ціле число від 1 до 1440.',
  group_name: 'Вкажіть назву своєї групи точно як у розкладі, наприклад КНК-43.',
  bell_schedule: 'Надішліть розклад дзвінків текстом, наприклад:\n1: 08:30-09:50\n2: 10:05-11:25\n3: 11:40-13:00',
};

bot.action('profile:timezone', async (ctx) => {
  const profile = readProfile(ctx.from.id);
  if (!profile) return ctx.answerCbQuery('Спершу надішліть /start.');
  await ctx.answerCbQuery();
  await ctx.editMessageText(`🌍 Часовий пояс\n\nПоточний: ${profile.timezone}`, Markup.inlineKeyboard([
    [Markup.button.callback('🇺🇦 Europe/Kyiv', 'timezone:kyiv')],
    [Markup.button.callback('🇬🇧 Europe/London', 'timezone:london')],
    [Markup.button.callback('⬅️ Назад', 'menu:profile')],
  ]));
});

for (const [action, timezone] of [['timezone:kyiv', 'Europe/Kyiv'], ['timezone:london', 'Europe/London']] as const) {
  bot.action(action, async (ctx) => {
    try {
      const profile = readProfile(ctx.from.id);
      if (!profile) return ctx.answerCbQuery('Спершу надішліть /start.');
      updateProfileSetting.run(timezone, profile.wake_time, profile.reminder_minutes, profile.group_name, profile.bell_schedule, ctx.from.id);
      deletePendingNotifications.run(ctx.from.id);
      await ctx.answerCbQuery(`Часовий пояс: ${timezone}`);
      await showProfileMenu(ctx);
    } catch (error) {
      console.error('Не вдалося змінити часовий пояс:', error);
      await ctx.answerCbQuery('Не вдалося змінити часовий пояс.');
    }
  });
}

for (const field of ['wake_time', 'bell_schedule'] as const) {
  bot.action(`profile:${field}`, async (ctx) => {
    pendingInputs.set(ctx.from.id, { kind: 'profile', field });
    await ctx.answerCbQuery();
    await ctx.editMessageText(profilePrompts[field], cancelKeyboard());
    const callbackMessage = ctx.callbackQuery.message;
    if (callbackMessage) pendingInputs.setPrompt(ctx.from.id, callbackMessage.chat.id, callbackMessage.message_id);
  });
}

for (const field of ['group_name'] as const) {
  bot.action(`text-edit:${field}`, async (ctx) => {
    const profile = readProfile(ctx.from.id);
    if (!profile) return ctx.answerCbQuery('Спершу надішліть /start.');
    pendingInputs.set(ctx.from.id, { kind: 'text_edit', field });
    await ctx.answerCbQuery();
    await ctx.editMessageText(textEditPrompt(field), { ...cancelKeyboard(), parse_mode: 'HTML' });
    const callbackMessage = ctx.callbackQuery.message;
    if (callbackMessage) pendingInputs.setPrompt(ctx.from.id, callbackMessage.chat.id, callbackMessage.message_id);
  });
}

bot.action('text-edit:view:group_name', async (ctx) => {
  const profile = readProfile(ctx.from.id);
  if (!profile) return ctx.answerCbQuery('Спершу надішліть /start.');
  const content = escapeHtml(profile.group_name) || '<i>Текст поки не задано.</i>';
  await ctx.answerCbQuery();
  await ctx.editMessageText(`<b>Назва групи</b>\n\n${content}`, { ...textEditBackKeyboard(), parse_mode: 'HTML' });
});

bot.action('schedule:add_today', async (ctx) => {
  const profile = readProfile(ctx.from.id);
  if (!profile) return ctx.answerCbQuery('Спершу надішліть /start.');
  await ctx.answerCbQuery();
  await promptEventTime(ctx, localDate(profile.timezone));
});

bot.action('profile:group_name', async (ctx) => {
  const profile = readProfile(ctx.from.id);
  if (!profile) return ctx.answerCbQuery('Спершу надішліть /start.');
  pendingInputs.set(ctx.from.id, { kind: 'text_edit', field: 'group_name' });
  await ctx.answerCbQuery();
  await ctx.editMessageText(textEditPrompt('group_name'), { ...cancelKeyboard(), parse_mode: 'HTML' });
  const callbackMessage = ctx.callbackQuery.message;
  if (callbackMessage) pendingInputs.setPrompt(ctx.from.id, callbackMessage.chat.id, callbackMessage.message_id);
});

bot.action('schedule:edit', async (ctx) => {
  await ctx.answerCbQuery('Функція редагування розкладу тимчасово недоступна.');
});

bot.action('schedule:clear', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('🗑️ Ви впевнені, що хочете повністю очистити регулярний розклад?', Markup.inlineKeyboard([
    [Markup.button.callback('✅ Так, очистити', 'schedule:clear-confirm')],
    [Markup.button.callback('❌ Скасувати', 'schedule:clear-cancel')],
  ]));
});

bot.action('schedule:clear-cancel', async (ctx) => {
  await ctx.answerCbQuery('Очищення скасовано.');
  await showScheduleMenu(ctx);
});

bot.action('schedule:clear-confirm', async (ctx) => {
  try {
    clearSchedule.run(ctx.from.id);
    deletePendingNotifications.run(ctx.from.id);
    await ctx.answerCbQuery();
    const profile = readProfile(ctx.from.id);
    if (profile) await ctx.editMessageText('Розклад успішно видалено.\n\n' + scheduleMenuText(profile), { ...scheduleMenu(profile), parse_mode: 'HTML' });
  } catch (error) {
    console.error('Не вдалося видалити розклад:', error);
    await ctx.answerCbQuery('Не вдалося видалити розклад.');
  }
});

bot.action('schedule:photo', async (ctx) => {
  pendingInputs.set(ctx.from.id, { kind: 'schedule_photo' });
  await ctx.answerCbQuery();
  await ctx.editMessageText('Надішліть фото розкладу як зображення або image-документ.', cancelKeyboard());
});

bot.action('schedule:photo-save', async (ctx) => {
  const draft = schedulePhotoDrafts.get(ctx.from.id);
  const profile = readProfile(ctx.from.id);
  if (!draft || !profile) {
    await ctx.answerCbQuery('Чернетку вже втрачено. Надішліть фото ще раз.');
    return;
  }
  try {
    saveSchedulePhotoResult.run(draft.schedule, escapeHtml(draft.schedule), draft.fileId, draft.bellSchedule || profile.bell_schedule, ctx.from.id);
    schedulePhotoDrafts.delete(ctx.from.id);
    pendingInputs.delete(ctx.from.id);
    deletePendingNotifications.run(ctx.from.id);
    await ctx.answerCbQuery('Розклад збережено.');
    await showScheduleMenu(ctx);
  } catch (error) {
    console.error('Не вдалося зберегти розклад із фото:', error);
    await ctx.answerCbQuery('Не вдалося зберегти розклад.');
  }
});

bot.action('schedule:photo-correct', async (ctx) => {
  const draft = schedulePhotoDrafts.get(ctx.from.id);
  if (!draft) {
    await ctx.answerCbQuery('Чернетку вже втрачено. Надішліть фото ще раз.');
    return;
  }
  pendingInputs.set(ctx.from.id, { kind: 'edit_photo_schedule' });
  await ctx.answerCbQuery();
  await ctx.reply(draft.schedule);
  await ctx.reply('Виправ текст вище й надішли його у відповідь. Збережу саме цей текст без AI.', Markup.forceReply().placeholder('Понеділок: ...'));
});

bot.action('schedule:view', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('📅 Графік і сповіщення', scheduleOverviewMenu());
});

bot.action('schedule:generate', async (ctx) => {
  await ctx.answerCbQuery();
  await sendTodaySchedule(ctx);
});

bot.action('schedule:morning-info', async (ctx) => {
  const profile = readProfile(ctx.from.id);
  if (!profile) return ctx.answerCbQuery('Спершу надішліть /start.');
  await ctx.answerCbQuery();
  const status = profile.is_active === 1 ? 'увімкнені' : 'вимкнені';
  await ctx.editMessageText(`🌅 Ранковий графік надсилається о ${profile.wake_time} за часовим поясом ${profile.timezone}, коли бот активний. Зараз сповіщення бота ${status}.`, Markup.inlineKeyboard([
    [Markup.button.callback('⚙️ Змінити час підйому', 'profile:wake_time')],
    [Markup.button.callback('⬅️ Назад', 'schedule:view')],
  ]));
});

bot.action('notifications:settings', async (ctx) => {
  const profile = readProfile(ctx.from.id);
  if (!profile) return ctx.answerCbQuery('Спершу надішліть /start.');
  await ctx.answerCbQuery();
  await ctx.editMessageText(notificationSettingsText(profile), notificationSettingsMenu(profile));
});

bot.action(/^notifications:set:(5|15|30|60|80|120)$/, async (ctx) => {
  const minutes = Number(ctx.match[1]);
  const profile = readProfile(ctx.from.id);
  if (!profile) return ctx.answerCbQuery('Спершу надішліть /start.');
  updateReminderMinutes.run(minutes, ctx.from.id);
  deleteUnsentNotifications.run(ctx.from.id);
  const updated = readProfile(ctx.from.id);
  await ctx.answerCbQuery(`Нагадування за ${minutes} хвилин.`);
  if (updated) await ctx.editMessageText(notificationSettingsText(updated), notificationSettingsMenu(updated));
});

bot.action('notifications:custom', async (ctx) => {
  if (!readProfile(ctx.from.id)) return ctx.answerCbQuery('Спершу надішліть /start.');
  pendingInputs.set(ctx.from.id, { kind: 'profile', field: 'reminder_minutes' });
  await ctx.answerCbQuery();
  await ctx.editMessageText('Введіть свій інтервал нагадування у хвилинах (від 1 до 1440).', cancelKeyboard());
  const callbackMessage = ctx.callbackQuery.message;
  if (callbackMessage) pendingInputs.setPrompt(ctx.from.id, callbackMessage.chat.id, callbackMessage.message_id);
});

bot.action('events:menu', async (ctx) => {
  await ctx.answerCbQuery();
  await showEventsMenu(ctx);
});

bot.action('events:home', async (ctx) => {
  pendingInputs.delete(ctx.from.id);
  await ctx.answerCbQuery();
  const profile = readProfile(ctx.from.id);
  if (profile) await ctx.editMessageText(accountMessage(profile.is_active === 1), mainMenu(profile.is_active === 1));
});

bot.action('events:add', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('На який день запланувати подію?', eventDateMenu());
});

bot.action(/^events:add-date:(today|tomorrow|custom)$/, async (ctx) => {
  const choice = ctx.match[1];
  const profile = readProfile(ctx.from.id);
  if (!profile) return ctx.answerCbQuery('Спершу надішліть /start.');
  await ctx.answerCbQuery();
  const today = localDate(profile.timezone);
  if (choice === 'custom') {
    pendingInputs.set(ctx.from.id, { kind: 'today_event_date' });
    await ctx.editMessageText('Напишіть дату події: РРРР-ММ-ДД або ДД.ММ.РРРР. Можна також «сьогодні» чи «завтра».', cancelKeyboard());
    return;
  }
  const date = choice === 'tomorrow' ? shiftIsoDate(today, 1) : today;
  await ctx.editMessageText(`Дата: ${date}`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Змінити дату', 'events:add')]]));
  await promptEventTime(ctx, date);
});

bot.action('events:delete-list', async (ctx) => {
  await ctx.answerCbQuery();
  await showOneOffChoices(ctx, 'delete');
});

bot.action('events:edit-list', async (ctx) => {
  await ctx.answerCbQuery();
  await showOneOffChoices(ctx, 'edit');
});

bot.action(/^events:delete:(\d+)$/, async (ctx) => {
  try {
    const profile = readProfile(ctx.from.id);
    if (!profile) return ctx.answerCbQuery('Спершу надішліть /start.');
    const eventId = Number(ctx.match[1]);
    const event = getScheduledEvent.get(ctx.from.id, eventId) as ScheduledEvent | undefined;
    if (!event) {
      await ctx.answerCbQuery('Ця подія вже відсутня.');
      await showEventsMenu(ctx);
      return;
    }
    expireNotificationByKey.run(ctx.from.id, event.event_date, `event:${eventId}:%`);
    deleteScheduledEvent.run(ctx.from.id, eventId);
    syncTodayEventsProfile(ctx.from.id, profile.timezone);
    pendingInputs.delete(ctx.from.id);
    await ctx.answerCbQuery('Подію видалено.');
    await showEventsMenu(ctx);
  } catch (error) {
    console.error('Не вдалося видалити подію:', error);
    await ctx.answerCbQuery('Не вдалося видалити подію.');
  }
});

bot.action(/^events:edit:(\d+)$/, async (ctx) => {
  const eventId = Number(ctx.match[1]);
  const profile = readProfile(ctx.from.id);
  if (!profile) return ctx.answerCbQuery('Спершу надішліть /start.');
  const event = getScheduledEvent.get(ctx.from.id, eventId) as ScheduledEvent | undefined;
  if (!event) {
    await ctx.answerCbQuery('Ця подія вже відсутня.');
    await showEventsMenu(ctx);
    return;
  }
  pendingInputs.set(ctx.from.id, { kind: 'edit_today_event', eventId });
  await ctx.answerCbQuery();
  await ctx.reply(`Поточна подія: ${event.event_date} — ${event.event_text}\nВідповідайте новою датою, часом та назвою.`, Markup.forceReply().placeholder('Завтра 18:30 Зустріч'));
});

bot.action('input:cancel', async (ctx) => {
  const pending = pendingInputs.get(ctx.from.id);
  pendingInputs.delete(ctx.from.id);
  schedulePhotoDrafts.delete(ctx.from.id);
  await ctx.answerCbQuery('Введення скасовано.');
  if (pending?.kind === 'profile' && pending.field === 'reminder_minutes') {
    const profile = readProfile(ctx.from.id);
    if (profile) await ctx.editMessageText(notificationSettingsText(profile), notificationSettingsMenu(profile));
  }
  else if (pending?.kind === 'profile' || pending?.kind === 'text_edit') await showProfileMenu(ctx);
  else if (pending?.kind === 'edit_photo_schedule' || pending?.kind === 'schedule_photo' || pending?.kind === 'schedule_photo_review') await showScheduleMenu(ctx);
  else if (pending?.kind === 'today_event' || pending?.kind === 'today_event_date' || pending?.kind === 'today_event_time' || pending?.kind === 'today_event_end' || pending?.kind === 'today_event_title' || pending?.kind === 'today_event_manual_end' || pending?.kind === 'edit_today_event') await showEventsMenu(ctx);
  else {
    const profile = readProfile(ctx.from.id);
    if (profile) await ctx.editMessageText(accountMessage(profile.is_active === 1), mainMenu(profile.is_active === 1));
  }
});

bot.on('text', async (ctx) => {
  const userText = ctx.message.text;

  const pending = pendingInputs.get(ctx.from.id);
  if (pending) {
    const value = userText.trim();
    if (pending.kind === 'text_edit') {
      const prompt = pendingInputs.getPrompt(ctx.from.id);
      let richText: { html: string; plainText: string };
      try {
        const entities = ctx.message.entities ?? [];
        const input = entities.length ? messageTextAsHtml(userText, entities) : userText;
        richText = sanitizeRichText(input);
        if (!richText.plainText.trim()) throw new Error('Текст не може бути порожнім. Надішліть нове значення.');
      const maximumLength = 40;
      const textLength = [...richText.plainText].length;
        if (textLength > maximumLength) {
          throw new Error(`Текст має містити не більше ${maximumLength} символів.`);
        }
        if (pending.field === 'group_name' && /[\r\n]/.test(richText.plainText)) {
          throw new Error('Назва групи має бути в одному рядку.');
        }
        const profile = readProfile(ctx.from.id);
        if (!profile) throw new Error('Спершу надішліть /start.');
        updateProfileSetting.run(profile.timezone, profile.wake_time, profile.reminder_minutes, richText.plainText, profile.bell_schedule, ctx.from.id);
        deletePendingNotifications.run(ctx.from.id);
      } catch (error) {
        await deleteInputMessage(ctx);
        const message = error instanceof Error ? error.message : 'Перевірте текст і спробуйте ще раз.';
        await editStoredPrompt(ctx, prompt, `❌ ${escapeHtml(message)}\n\n${textEditPrompt(pending.field)}`, cancelKeyboard());
        return;
      }
      pendingInputs.delete(ctx.from.id);
      await deleteInputMessage(ctx);
      await editStoredPrompt(ctx, prompt, '✅ Назву групи оновлено.', textEditResultKeyboard(pending.field));
      return;
    }
    if (!value) {
      await ctx.reply('Значення не може бути порожнім. Спробуйте ще раз.', cancelKeyboard());
      return;
    }

    if (pending.kind === 'edit_photo_schedule') {
      const draft = schedulePhotoDrafts.get(ctx.from.id);
      if (!draft) {
        pendingInputs.delete(ctx.from.id);
        await ctx.reply('Чернетку фото не знайдено. Завантаж фото розкладу ще раз.');
        return;
      }
      saveSchedulePhotoResult.run(value, escapeHtml(value), draft.fileId, draft.bellSchedule || readProfile(ctx.from.id)?.bell_schedule || '', ctx.from.id);
      schedulePhotoDrafts.delete(ctx.from.id);
      deletePendingNotifications.run(ctx.from.id);
      pendingInputs.delete(ctx.from.id);
      await ctx.reply('✅ Виправлений розклад збережено.');
      await showScheduleMenu(ctx, false);
      return;
    }

    if (pending.kind === 'schedule_photo_review') {
      await ctx.reply('Перевір попередній розклад і натисни «✅ Зберегти» або «✏️ Скопіювати і виправити».', cancelKeyboard());
      return;
    }

    if (pending.kind === 'today_event_date') {
      const profile = readProfile(ctx.from.id);
      if (!profile) {
        pendingInputs.delete(ctx.from.id);
        await ctx.reply('Спершу надішліть /start.');
        return;
      }
      try {
        const date = parseEventDateInput(value, profile.timezone);
        await promptEventTime(ctx, date);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Не вдалося розпізнати дату.';
        await ctx.reply(`❌ ${message}`, Markup.forceReply().placeholder('2026-10-05 або сьогодні'));
      }
      return;
    }

    if (pending.kind === 'today_event') {
      try {
        const profile = readProfile(ctx.from.id);
        if (!profile) throw new Error('Profile not found');
        if (pending.time) {
          const trimmed = value.trim();
          if (!trimmed) throw new Error('Введіть назву події.');
          createScheduledEvent(ctx.from.id, profile.timezone, pending.date, `${pending.time} ${trimmed}`);
          pendingInputs.delete(ctx.from.id);
          await ctx.reply(`✅ Подію додано на ${pending.date}: ${pending.time} ${trimmed}`);
          await showEventsMenu(ctx, false);
          return;
        }
        const parsed = parseScheduledEvent(value, profile.timezone, pending.date);
        createScheduledEvent(ctx.from.id, profile.timezone, parsed.eventDate, parsed.eventText);
        pendingInputs.delete(ctx.from.id);
        await ctx.reply(`Подію додано на ${parsed.eventDate}: ${parsed.eventText}`);
        await showEventsMenu(ctx, false);
      } catch (error) {
        console.error('Не вдалося зберегти подію:', error);
        const message = error instanceof Error ? error.message : 'Спробуйте ще раз.';
        await ctx.reply(`❌ ${message}`, Markup.forceReply().placeholder('Зустріч з викладачем'));
      }
      return;
    }

    if (pending.kind === 'today_event_time') {
      const timeMatch = value.match(/^([01]?\d|2[0-3]):([0-5]\d)(?:\s*(?:-|–|—|до)\s*([01]?\d|2[0-3]):([0-5]\d))?$/iu);
      if (!timeMatch) {
        await ctx.reply('Введіть час початку, наприклад 16:00. Можна одразу вказати інтервал: 16:00-17:30.', Markup.forceReply().placeholder('16:00 або 16:00-17:30'));
        return;
      }
      const startTime = `${(timeMatch[1] ?? '00').padStart(2, '0')}:${timeMatch[2] ?? '00'}`;
      const endTime = timeMatch[3] ? `${timeMatch[3].padStart(2, '0')}:${timeMatch[4] ?? '00'}` : null;
      if (endTime && endTime <= startTime) {
        await ctx.reply('Час завершення має бути пізніше за час початку.', Markup.forceReply().placeholder('16:00 або 16:00-17:30'));
        return;
      }
      if (endTime) {
        pendingInputs.set(ctx.from.id, { kind: 'today_event_title', date: pending.date, startTime, endTime });
        await ctx.reply(`Початок: ${startTime}, завершення: ${endTime}. Тепер напишіть назву події.`, Markup.forceReply().placeholder('Тренування'));
      } else {
        pendingInputs.set(ctx.from.id, { kind: 'today_event_end', date: pending.date, startTime });
        await ctx.reply('О котрій подія закінчується? Введіть час або напишіть «не знаю», тоді я оціню його за назвою.', Markup.forceReply().placeholder('17:30 або не знаю'));
      }
      return;
    }

    if (pending.kind === 'today_event_end') {
      const unknownEndTime = /^(?:не знаю|невідомо|без часу|авто|пропустити|немає|не пам['’ʼ]?ятаю|-)$/iu.test(value);
      const endMatch = value.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
      if (!unknownEndTime && !endMatch) {
        await ctx.reply('Введіть час завершення у форматі ГГ:ХХ або напишіть «не знаю».', Markup.forceReply().placeholder('17:30 або не знаю'));
        return;
      }
      const endTime = endMatch ? `${(endMatch[1] ?? '00').padStart(2, '0')}:${endMatch[2] ?? '00'}` : null;
      if (endTime && endTime <= pending.startTime) {
        await ctx.reply('Час завершення має бути пізніше за початок. Спробуйте ще раз.', Markup.forceReply().placeholder('17:30 або не знаю'));
        return;
      }
      pendingInputs.set(ctx.from.id, { kind: 'today_event_title', date: pending.date, startTime: pending.startTime, endTime });
      await ctx.reply('Тепер напишіть назву події.', Markup.forceReply().placeholder('Тренування'));
      return;
    }

    if (pending.kind === 'today_event_title') {
      const profile = readProfile(ctx.from.id);
      if (!profile) {
        pendingInputs.delete(ctx.from.id);
        await ctx.reply('Спершу надішліть /start.');
        return;
      }
      let endTime = pending.endTime;
      if (!endTime) {
        try {
          endTime = await estimateEventEndTime(pending.date, pending.startTime, value, profile.timezone);
        } catch (error) {
          console.error('Не вдалося оцінити час завершення події:', error);
          pendingInputs.set(ctx.from.id, { kind: 'today_event_manual_end', date: pending.date, startTime: pending.startTime, title: value });
          await ctx.reply('Не вдалося оцінити завершення через Gemini. Введіть час завершення вручну, і я збережу цю назву.', Markup.forceReply().placeholder('17:30'));
          return;
        }
      }
      try {
        const eventText = `${pending.startTime}-${endTime} ${value}`;
        createScheduledEvent(ctx.from.id, profile.timezone, pending.date, eventText);
        pendingInputs.delete(ctx.from.id);
        await ctx.reply(`✅ Подію додано на ${pending.date}: ${eventText}${pending.endTime ? '' : ' (час завершення оцінив Gemini)'}`);
        await showEventsMenu(ctx, false);
      } catch (error) {
        console.error('Не вдалося зберегти подію:', error);
        await ctx.reply('❌ Не вдалося зберегти подію. Спробуйте надіслати її ще раз.', Markup.forceReply().placeholder(value));
      }
      return;
    }

    if (pending.kind === 'today_event_manual_end') {
      const endMatch = value.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
      if (!endMatch) {
        await ctx.reply('Введіть час завершення у форматі ГГ:ХХ.', Markup.forceReply().placeholder('17:30'));
        return;
      }
      const endTime = `${(endMatch[1] ?? '00').padStart(2, '0')}:${endMatch[2] ?? '00'}`;
      if (endTime <= pending.startTime) {
        await ctx.reply('Час завершення має бути пізніше за початок.', Markup.forceReply().placeholder('17:30'));
        return;
      }
      const profile = readProfile(ctx.from.id);
      if (!profile) {
        pendingInputs.delete(ctx.from.id);
        await ctx.reply('Спершу надішліть /start.');
        return;
      }
      const eventText = `${pending.startTime}-${endTime} ${pending.title}`;
      createScheduledEvent(ctx.from.id, profile.timezone, pending.date, eventText);
      pendingInputs.delete(ctx.from.id);
      await ctx.reply(`✅ Подію додано на ${pending.date}: ${eventText}`);
      await showEventsMenu(ctx, false);
      return;
    }

    if (pending.kind === 'edit_today_event') {
      try {
        const profile = readProfile(ctx.from.id);
        if (!profile) throw new Error('Profile not found');
        const event = getScheduledEvent.get(ctx.from.id, pending.eventId) as ScheduledEvent | undefined;
        if (!event) throw new Error('Подію вже видалено.');
        const parsed = parseScheduledEvent(value, profile.timezone);
        expireNotificationByKey.run(ctx.from.id, event.event_date, `event:${pending.eventId}:%`);
        editScheduledEvent.run(parsed.eventDate, parsed.eventText, ctx.from.id, pending.eventId);
        syncTodayEventsProfile(ctx.from.id, profile.timezone);
        pendingInputs.delete(ctx.from.id);
        await ctx.reply(`Подію оновлено: ${parsed.eventDate} — ${parsed.eventText}`);
        await showEventsMenu(ctx, false);
      } catch (error) {
        console.error('Не вдалося змінити подію:', error);
        const message = error instanceof Error ? error.message : 'Спробуйте ще раз.';
        await ctx.reply(`❌ Не вдалося змінити подію: ${message}`, Markup.forceReply().placeholder('Завтра 18:30 Зустріч'));
      }
      return;
    }

    if (pending.kind === 'schedule_photo') {
      await ctx.reply('Зараз очікую фото. Надішліть зображення або натисніть «Скасувати».', cancelKeyboard());
      return;
    }

    const { field } = pending;
    const prompt = pendingInputs.getPrompt(ctx.from.id);
    let accepted = false;
    if (field === 'wake_time') accepted = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
    else if (field === 'group_name') accepted = value.length <= 40;
    else if (field === 'bell_schedule') accepted = value.length <= 2000;
    else if (field === 'reminder_minutes') accepted = /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 1440;

    if (!accepted) {
      const errorText = field === 'wake_time'
        ? 'Введіть час у форматі ГГ:ХХ, наприклад 07:00.'
        : field === 'group_name'
          ? 'Назва групи має містити не більше 40 символів.'
          : field === 'bell_schedule'
            ? 'Розклад дзвінків має бути не довшим за 2000 символів.'
            : 'Введіть ціле число від 1 до 1440 хвилин.';
      await deleteInputMessage(ctx);
      if (prompt) await editStoredPrompt(ctx, prompt, errorText, cancelKeyboard(), 'plain');
      else await ctx.reply(errorText, cancelKeyboard());
      return;
    }

    try {
      const profile = readProfile(ctx.from.id);
      if (!profile) {
        pendingInputs.delete(ctx.from.id);
        await ctx.reply('Спершу надішліть /start.');
        return;
      }
      const values: Record<ProfileField, string> = {
        timezone: profile.timezone,
        wake_time: profile.wake_time,
        reminder_minutes: String(profile.reminder_minutes),
        group_name: profile.group_name,
        bell_schedule: profile.bell_schedule,
      };
      values[field] = value;
      if (field === 'reminder_minutes') {
        updateReminderMinutes.run(Number(value), ctx.from.id);
        deleteUnsentNotifications.run(ctx.from.id);
      } else {
        updateProfileSetting.run(values.timezone, values.wake_time, profile.reminder_minutes, values.group_name, values.bell_schedule, ctx.from.id);
        deletePendingNotifications.run(ctx.from.id);
      }
      pendingInputs.delete(ctx.from.id);
      await deleteInputMessage(ctx);
      const updatedProfile = readProfile(ctx.from.id);
      if (field === 'reminder_minutes' && prompt && updatedProfile) await editStoredPrompt(ctx, prompt, `✅ Нагадування встановлено за ${updatedProfile.reminder_minutes} хвилин.`, notificationSettingsMenu(updatedProfile), 'plain');
      else if (prompt && updatedProfile) await editStoredPrompt(ctx, prompt, `${profileMenuText(updatedProfile)}\n\n✅ Налаштування оновлено.`, profileMenu(updatedProfile), 'plain');
      else await showProfileMenu(ctx, false);
    } catch (error) {
      console.error('Не вдалося зберегти налаштування:', error);
      await deleteInputMessage(ctx);
      if (prompt) await editStoredPrompt(ctx, prompt, '❌ Не вдалося зберегти налаштування. Спробуйте ще раз.', cancelKeyboard(), 'plain');
      else await ctx.reply('❌ Не вдалося зберегти налаштування. Спробуйте ще раз.', cancelKeyboard());
    }
    return;
  }

  await ctx.reply(
    'Будь ласка, використовуй кнопки меню нижче для навігації.',
    Markup.inlineKeyboard([[Markup.button.callback('⬅️ Головне меню', 'menu:home')]]),
  );
});

async function processScheduleImage(ctx: any, fileId: string, mimeType: string) {
  if (ctx.chat.type !== 'private') return;
  if (pendingInputs.get(ctx.from.id)?.kind !== 'schedule_photo') {
    await ctx.reply('Спершу виберіть «📸 Завантажити фото розкладу» в меню регулярного розкладу.');
    return;
  }
  if (!mimeType.startsWith('image/')) {
    await ctx.reply('Надішліть файл зображення (JPEG, PNG або WEBP).', cancelKeyboard());
    return;
  }

  const profile = readProfile(ctx.from.id);
  const setup = getSetupGroupName.get(ctx.from.id) as { group_name: string | null } | undefined;
  const groupName = setup?.group_name || profile?.group_name;
  if (!groupName) {
    pendingInputs.delete(ctx.from.id);
    await ctx.reply('Спочатку вкажіть назву своєї групи в налаштуваннях профілю, а потім повторно завантажте фото.', Markup.inlineKeyboard([
      [Markup.button.callback('🏫 Вказати групу', 'profile:group_name')],
      [Markup.button.callback('⬅️ До регулярного розкладу', 'menu:schedule')],
    ]));
    return;
  }

  try {
    await ctx.reply('📸 Розпізнаю розклад на фото…');
    const fileUrl = await ctx.telegram.getFileLink(fileId);
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
    const imageBuffer = Buffer.from(await response.arrayBuffer());
    const result = await generateGemini(
      [{ inlineData: { mimeType, data: imageBuffer.toString('base64') } }],
      scheduleImagePrompt(groupName),
      { responseMimeType: 'application/json', maxOutputTokens: 1400 },
    );
    const rawResult = result.text?.trim() ?? '';
    const parsedResult = JSON.parse(rawResult) as { schedule?: unknown; bell_schedule?: unknown };
    const extractedSchedule = typeof parsedResult.schedule === 'string' ? parsedResult.schedule.trim() : '';
    if (!extractedSchedule) throw new Error('Gemini returned an empty schedule');
    const extractedBellSchedule = typeof parsedResult.bell_schedule === 'string' ? parsedResult.bell_schedule.trim() : '';
    schedulePhotoDrafts.set(ctx.from.id, {
      schedule: extractedSchedule,
      bellSchedule: extractedBellSchedule || profile?.bell_schedule || '',
      fileId,
    });
    pendingInputs.delete(ctx.from.id);
    pendingInputs.set(ctx.from.id, { kind: 'schedule_photo_review' });
    await ctx.reply(`🔎 Попередній розклад:\n\n${extractedSchedule}${extractedBellSchedule ? `\n\n🔔 Дзвінки:\n${extractedBellSchedule}` : ''}`, Markup.inlineKeyboard([
      [Markup.button.callback('✅ Зберегти', 'schedule:photo-save')],
      [Markup.button.callback('✏️ Скопіювати і виправити', 'schedule:photo-correct')],
      [Markup.button.callback('❌ Скасувати', 'input:cancel')],
    ]));
  } catch (error) {
    console.error('Не вдалося розпізнати фото розкладу:', error);
    const status = (error as { status?: number }).status;
    const message = status === 503 || status === 429 || (status !== undefined && status >= 500)
      ? '❌ Gemini зараз перевантажений або обмежив запити. Розклад із фото не збережено — фото залишилося доступним, спробуйте ще раз трохи пізніше або введіть розклад текстом.'
      : '❌ Не вдалося розпізнати фото. Розклад не збережено — спробуйте ще раз або введіть його вручну.';
    await ctx.reply(message, cancelKeyboard());
  }
}

bot.on('photo', async (ctx) => {
  const photo = ctx.message.photo.reduce((largest, candidate) => {
    const largestSize = largest.file_size ?? largest.width * largest.height;
    const candidateSize = candidate.file_size ?? candidate.width * candidate.height;
    return candidateSize > largestSize ? candidate : largest;
  });
  if (photo) await processScheduleImage(ctx, photo.file_id, 'image/jpeg');
});

bot.on('document', async (ctx) => {
  const document = ctx.message.document;
  if (document) await processScheduleImage(ctx, document.file_id, document.mime_type ?? 'application/octet-stream');
});

async function launchBot() {
  let retryDelayMs = 2_000;
  while (true) {
    try {
      await bot.launch({}, () => console.log('Бот підключився до Telegram і слухає повідомлення.'));
      console.log('Бот зупинений.');
      return;
    } catch (error) {
      const telegramError = error as { code?: number; response?: { error_code?: number } };
      const errorCode = telegramError.response?.error_code ?? telegramError.code;
      console.error('❌ Помилка Telegram polling:', error);

      // These indicate credentials or another active polling instance, not a transient outage.
      if (errorCode === 401 || errorCode === 409) {
        console.error(errorCode === 401
          ? 'Перевірте BOT_TOKEN.'
          : 'Цей бот уже запущений в іншому процесі. Зупиніть інший екземпляр.');
        process.exitCode = 1;
        return;
      }

      console.log(`Повторна спроба підключення до Telegram через ${retryDelayMs / 1000} с…`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
    }
  }
}

void launchBot();

const notificationScheduler = setInterval(() => {
  void runNotificationScheduler();
}, 15_000);
notificationScheduler.unref();
void runNotificationScheduler();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
