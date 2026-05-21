// app.js — главный контроллер приложения

(function () {
  // -------- helpers --------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const fmtDate = (iso) => {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', weekday: 'short' });
  };
  const sum = (arr, fn) => arr.reduce((a, b) => a + (fn(b) || 0), 0);
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // -------- state --------
  const state = {
    pendingPhoto: null,    // { blob, base64, mime, name }
    pendingParse: null,    // распарсенные данные до сохранения
    selectedPhotoIds: [],  // для compare
    charts: {},
    chat: {
      history: [],         // массив сообщений из БД
      pendingAttachments: [], // для отправки на следующий шаг
    },
    settings: {
      goal: 'fitness',
      goalText: '',
      targetKcal: 0,
      targetProtein: 0,
    },
    statsRange: '30',
    profile: {
      sex: 'm',
      age: 0,
      height_cm: 0,
      weight_kg: 0,
      activity: 'moderate',
      tdee_kcal: 0,
    },
  };

  // Mifflin-St Jeor + коэффициенты активности
  function calcBMR(p) {
    if (!p || !p.age || !p.height_cm || !p.weight_kg) return 0;
    const base = 10 * p.weight_kg + 6.25 * p.height_cm - 5 * p.age;
    return Math.round(base + (p.sex === 'f' ? -161 : 5));
  }
  // БАЗОВЫЙ РАСХОД БЕЗ ФИЗАКТИВНОСТИ.
  // Семантика: то что пользователь тратит за день БЕЗ Apple-Watch-активности
  // (BMR + бытовой NEAT, измеренный калориметром или взятый из BMR-формулы).
  // К этому значению добавляется active_kcal с часов чтобы получить ПОЛНЫЙ расход.
  // Приоритет: пользовательский замер (p.tdee_kcal как override) → формула Mifflin-St Jeor.
  function calcBaseBurn(p) {
    if (!p) return 0;
    if (p.tdee_kcal && p.tdee_kcal > 0) return Math.round(p.tdee_kcal);
    return calcBMR(p);
  }
  function calcTDEE(p) {
    if (!p) return 0;
    // Если пользователь вписал свой замер — берём его как базовый расход.
    // ВАЖНО: это RMR-подобный показатель (без физактивности), а не классический
    // TDEE с множителем активности. Активность с часов добавляется ОТДЕЛЬНО.
    if (p.tdee_kcal && p.tdee_kcal > 0) return Math.round(p.tdee_kcal);
    const bmr = calcBMR(p);
    if (!bmr) return 0;
    const factor = ({ sedentary: 1.2, light: 1.375, moderate: 1.55, high: 1.725, very_high: 1.9 })[p.activity] || 1.55;
    return Math.round(bmr * factor);
  }
  // Достраивает профиль вычисляемыми полями для отправки в Gemini.
  // В поле `bmr` передаём ИМЕННО базовый расход (override или формула) —
  // это то с чем складывается active_kcal чтобы получить полный расход дня.
  function profileForAI() {
    const p = state.profile;
    if (!p || !p.age || !p.weight_kg) return null;
    return { ...p, bmr: calcBaseBurn(p), tdee: calcTDEE(p) };
  }

  // Сколько ккал «сжёг» в этот день. Apple Watch active_kcal уже включает все
  // workouts — поэтому если он есть, используем только его (иначе двойной счёт).
  // Если active_kcal нет — берём сумму kcal от тренировок.
  function dayBurnKcal(day) {
    if (!day) return 0;
    const active = (day.body && day.body.active_kcal) || 0;
    if (active > 0) return active;
    return sum(day.workouts || [], w => w.kcal || 0);
  }

  // Возвращает дневные цели для отправки в Gemini.
  // Если ручные цели заданы — берём их. Если пусто — считаем автоматом из профиля + типа цели.
  function targetsForAI() {
    if (state.settings.targetKcal || state.settings.targetProtein) {
      return { kcal: state.settings.targetKcal, protein: state.settings.targetProtein };
    }
    const tdee = calcTDEE(state.profile);
    if (!tdee) return { kcal: 0, protein: 0 };
    return {
      kcal: Math.round(tdee + goalKcalAdj(state.settings.goal)),
      protein: Math.round((state.profile.weight_kg || 0) * goalProteinMult(state.settings.goal)),
    };
  }

  // -------- TABS --------
  function setTab(name) {
    $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.view').forEach(v => v.hidden = v.dataset.view !== name);
    if (name === 'history') renderHistory();
    if (name === 'stats') renderStats();
    if (name === 'photos') renderPhotos();
    if (name === 'today') renderTodayLog();
    if (name === 'chat') renderChat();
    // Заголовок страницы
    const titles = { chat: 'Тренер', today: 'Сегодня', history: 'История', stats: 'Статистика', photos: 'Прогресс', settings: 'Настройки' };
    $('#dateTitle').textContent = titles[name] || 'Tracker';
  }
  $$('.tab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

  // -------- DAY STATUS BAR (всегда видим) --------
  async function refreshDayStatus() {
    const day = await Storage.getDay(Storage.todayDate());
    const bar = $('#dayStatus');
    bar.hidden = false;

    const meals = (day && day.meals) || [];
    const workouts = (day && day.workouts) || [];
    const kcalIn = sum(meals, m => m.kcal);
    const protein = sum(meals, m => m.protein_g);
    // Активность сверх покоя (Apple Watch active или ккал тренировок).
    const activity = dayBurnKcal(day);
    // Полный дневной расход = базовый_расход + активность.
    // Базовый расход — это пользовательский замер (если есть) либо BMR-формула.
    // Если профиля нет — fallback на одну только активность.
    const userBmr = calcBaseBurn(state.profile);
    const kcalOut = userBmr ? userBmr + activity : activity;
    const mood = day && day.mood && day.mood.score != null ? day.mood.score : null;

    const kcalGoal = state.settings.targetKcal || 0;
    const proteinGoal = state.settings.targetProtein || 0;

    tweenNumber($('#dsKcalIn'), Math.round(kcalIn));
    tweenNumber($('#dsKcalOut'), Math.round(kcalOut));
    tweenNumber($('#dsProtein'), Math.round(protein));
    $('#dsProteinGoal').textContent = proteinGoal ? '/ ' + proteinGoal + 'г' : 'г';
    tweenNumber($('#dsWorkouts'), workouts.length);
    $('#dsMood').textContent = mood != null ? mood : '—';

    // === Реальный энергобаланс: съел − полный расход (BMR + активность) ===
    // userBmr и kcalOut (полный расход) уже посчитаны выше.
    const dsBalanceEl = $('#dsBalance');
    const balItem = dsBalanceEl.closest('.ds-item');
    balItem.classList.remove('over', 'met', 'warn');
    let currentBalance = null;
    if (!userBmr || !kcalIn) {
      dsBalanceEl.textContent = '—';
    } else {
      const balance = Math.round(kcalIn - kcalOut);
      currentBalance = balance;
      const sign = balance > 0 ? '+' : '';
      dsBalanceEl.textContent = sign + balance;
      // Трёхзонная цветовая индикация:
      // Для loss/recomp:
      //   профицит >+200    → красный (нет дефицита, цель не выполняется)
      //   −1000 .. +200     → зелёный (дефицит в норме)
      //   меньше −1000      → жёлтый (слишком жёсткий дефицит, риск потери мышц)
      // Для muscle/endurance — зеркально.
      const goal = state.settings.goal;
      const isCutting = goal === 'loss' || goal === 'recomp';
      const isBulking = goal === 'muscle' || goal === 'endurance';
      if (isCutting) {
        if (balance > 200) balItem.classList.add('over');
        else if (balance < -1000) balItem.classList.add('warn');
        else if (balance < 0) balItem.classList.add('met');
      } else if (isBulking) {
        if (balance < -200) balItem.classList.add('over');
        else if (balance > 1000) balItem.classList.add('warn');
        else if (balance > 0) balItem.classList.add('met');
      }
    }

    // === Осталось до планового баланса ===
    // Сколько ещё можешь съесть, чтобы попасть в плановый дефицит/профицит.
    // Формула: осталось = плановый_баланс − текущий_баланс
    // Плановый баланс = targetKcal − TDEE (например, для loss: 1500 − 1900 = −400).
    const dsRemainEl = $('#dsRemain');
    const remainItem = dsRemainEl.closest('.ds-item');
    remainItem.classList.remove('over', 'met', 'warn');
    const tdee = calcTDEE(state.profile);
    if (!userBmr || !tdee) {
      dsRemainEl.textContent = '—';
    } else {
      const plannedBalance = state.settings.targetKcal
        ? (state.settings.targetKcal - tdee)
        : goalKcalAdj(state.settings.goal);
      // Если ещё ничего не ел — текущий баланс = −kcalOut (только тело тратит)
      const curBal = currentBalance != null ? currentBalance : -kcalOut;
      const remain = Math.round(plannedBalance - curBal);
      const sign = remain > 0 ? '+' : '';
      dsRemainEl.textContent = sign + remain;
      // Цвет: по модулю отклонения от плана. Близко к 0 = на плане (хорошо),
      // большие отклонения в любую сторону = плохо. Так согласуется с цветом «Баланса».
      const absRemain = Math.abs(remain);
      if (absRemain <= 200) remainItem.classList.add('met');
      else if (absRemain > 1000) remainItem.classList.add('over');
      else if (absRemain > 500) remainItem.classList.add('warn');
    }

    // Плитка «Съел» теперь без цвета — это просто факт.
    // Цвет даём только производным метрикам (Баланс, Осталось, Белок).
    const proteinEl = $('#dsProtein').closest('.ds-item');
    proteinEl.classList.remove('over', 'met');
    if (proteinGoal && protein >= proteinGoal * 0.95) proteinEl.classList.add('met');
  }

  // Плавно тикает число от текущего значения к новому. ease-out cubic, ~280мс.
  function tweenNumber(el, to, duration = 280) {
    if (!el) return;
    const from = parseFloat(el.textContent) || 0;
    if (from === to) { el.textContent = to; return; }
    const start = performance.now();
    const delta = to - from;
    function step(t) {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(from + delta * eased);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // -------- SETTINGS --------
  async function loadSettings() {
    const apiKey = await Storage.getMeta('apiKey', '');
    const model = await Storage.getMeta('model', 'gemini-2.5-flash');
    const goal = await Storage.getMeta('goal', 'fitness');
    const goalText = await Storage.getMeta('goalText', '');
    const targetKcal = await Storage.getMeta('targetKcal', 0);
    const targetProtein = await Storage.getMeta('targetProtein', 0);
    const profile = await Storage.getMeta('profile', null);
    const statsRange = await Storage.getMeta('statsRange', '30');
    state.settings = { goal, goalText, targetKcal, targetProtein };
    state.statsRange = statsRange;
    if (profile) state.profile = { ...state.profile, ...profile };
    $('#apiKeyInput').value = apiKey || '';
    if ($('#modelSelect')) $('#modelSelect').value = model;
    $('#goalSelect').value = goal;
    $('#goalText').value = goalText || '';
    $('#targetKcal').value = targetKcal || '';
    $('#targetProtein').value = targetProtein || '';
    $('#statsRange').value = statsRange;
    $('#profileSex').value = state.profile.sex || 'm';
    $('#profileAge').value = state.profile.age || '';
    $('#profileHeight').value = state.profile.height_cm || '';
    $('#profileWeight').value = state.profile.weight_kg || '';
    $('#profileActivity').value = state.profile.activity || 'moderate';
    $('#profileTdeeOverride').value = state.profile.tdee_kcal || '';
    updateGoalPill();
    renderProfileCalc();
    autofillTargetsIfEmpty();
  }

  // Возвращает snapshot настроек, релевантных для контекста periodDays.
  // Включает: snapshot активный на начало периода + все snapshot'ы внутри периода.
  // Это даёт ИИ понимание «какие настройки были активны какой день».
  async function settingsHistoryForPeriod(periodDays) {
    if (!periodDays || !periodDays.length) return [];
    const all = await Storage.getAllSettingsSnapshots();
    if (!all.length) return [];
    const startDate = periodDays[0].date;
    const endDate = periodDays[periodDays.length - 1].date;
    // Snapshot активный на startDate (последний с date <= startDate)
    let baseline = null;
    for (const s of all) {
      if (s.date <= startDate) baseline = s;
      else break;
    }
    // Snapshot'ы которые попали внутрь периода (после startDate)
    const inside = all.filter(s => s.date > startDate && s.date <= endDate);
    return baseline ? [baseline, ...inside] : inside;
  }

  // Сохраняет snapshot текущих настроек на сегодняшнюю дату.
  // Вызывается после любого явного сохранения профиля или цели.
  async function snapshotCurrentSettings() {
    await Storage.saveSettingsSnapshot({
      date: Storage.todayDate(),
      goal: state.settings.goal,
      goalText: state.settings.goalText,
      targetKcal: state.settings.targetKcal,
      targetProtein: state.settings.targetProtein,
      profile: { ...state.profile },
    });
  }

  // На первом запуске после введения snapshot-системы создаём baseline:
  // если snapshot'ов нет, но в БД есть дни — записываем текущие настройки
  // на дату самого раннего дня. Это даёт ИИ ретроспективу.
  async function ensureInitialSnapshot() {
    const snaps = await Storage.getAllSettingsSnapshots();
    if (snaps.length > 0) return;
    const days = await Storage.getAllDays();
    const earliestDate = days.length
      ? days.sort((a, b) => a.date.localeCompare(b.date))[0].date
      : Storage.todayDate();
    await Storage.saveSettingsSnapshot({
      date: earliestDate,
      goal: state.settings.goal,
      goalText: state.settings.goalText,
      targetKcal: state.settings.targetKcal,
      targetProtein: state.settings.targetProtein,
      profile: { ...state.profile },
    });
  }

  function updateGoalPill() {
    const txt = (state.settings.goalText || '').trim();
    const label = goalLabel(state.settings.goal);
    if (txt) {
      const short = txt.length > 28 ? txt.slice(0, 27) + '…' : txt;
      $('#goalPill').textContent = short;
      $('#goalPill').title = txt;
    } else {
      $('#goalPill').textContent = label;
      $('#goalPill').title = label;
    }
  }

  function renderProfileCalc() {
    const p = state.profile;
    const bmr = calcBMR(p);
    const tdee = calcTDEE(p);
    const el = $('#profileCalc');
    if (!el) return;
    if (!bmr) {
      el.textContent = 'Заполни поля выше — посчитаю BMR и TDEE.';
      return;
    }
    const usingOverride = p.tdee_kcal && p.tdee_kcal > 0;
    if (usingOverride) {
      el.innerHTML = `Базовый расход (твой замер) = <b>${tdee}</b> ккал/день — это что ты тратишь БЕЗ физактивности. К нему приложение добавляет active_kcal с часов чтобы получить полный расход. BMR по формуле для сравнения: ${bmr} ккал.`;
    } else {
      el.innerHTML = `BMR ≈ <b>${bmr}</b> ккал · базовый расход ≈ <b>${tdee}</b> ккал/день (формула с учётом повседневной активности). К этому приложение добавляет active_kcal с часов чтобы получить полный расход.`;
    }
  }
  function goalLabel(g) {
    return ({ muscle: 'Мышцы', recomp: 'Рекомпа', loss: 'Похудение', fitness: 'Форма', endurance: 'Выносл.' })[g] || '—';
  }

  // Поправка ккал по типу цели (относительно TDEE)
  function goalKcalAdj(g) {
    return ({ loss: -400, recomp: -100, muscle: 300, fitness: 0, endurance: 100 })[g] || 0;
  }
  // Множитель белка (г / кг веса)
  function goalProteinMult(g) {
    return ({ muscle: 1.8, recomp: 2.0, loss: 1.8, endurance: 1.6, fitness: 1.6 })[g] || 1.6;
  }

  $('#saveKeyBtn').addEventListener('click', async () => {
    const v = $('#apiKeyInput').value.trim();
    const m = $('#modelSelect')?.value || 'gemini-2.5-flash';
    await Storage.setMeta('apiKey', v);
    await Storage.setMeta('model', m);
    flashStatus('Ключ и модель сохранены', 'ok');
  });

  $('#testKeyBtn').addEventListener('click', async () => {
    const key = $('#apiKeyInput').value.trim();
    if (!key) return flashStatus('Введи ключ сначала', 'err');
    const btn = $('#testKeyBtn');
    btn.disabled = true; btn.textContent = 'Проверяю…';
    try {
      const model = $('#modelSelect')?.value || (await Gemini.getModel());
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 5 } }),
      });
      if (res.ok) flashStatus(`Ключ валиден для ${model}`, 'ok');
      else {
        const j = await res.json().catch(() => ({}));
        flashStatus('Ключ не работает: ' + (j.error?.message || `HTTP ${res.status}`), 'err');
      }
    } catch (err) {
      flashStatus('Сеть недоступна: ' + err.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Проверить';
    }
  });
  // Live-обновление расчёта при правке полей профиля
  ['#profileSex', '#profileAge', '#profileHeight', '#profileWeight', '#profileActivity', '#profileTdeeOverride'].forEach(sel => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener('input', () => {
      state.profile = {
        sex: $('#profileSex').value,
        age: parseInt($('#profileAge').value, 10) || 0,
        height_cm: parseInt($('#profileHeight').value, 10) || 0,
        weight_kg: parseFloat($('#profileWeight').value) || 0,
        activity: $('#profileActivity').value,
        tdee_kcal: parseInt($('#profileTdeeOverride').value, 10) || 0,
      };
      renderProfileCalc();
      autofillTargetsIfEmpty();
    });
  });

  // Пересчёт целей по профилю + типу цели.
  // По умолчанию (force=false) — только заполняет пустые поля.
  // С force=true — перезаписывает существующие значения (используется при
  // явном изменении профиля или типа цели — пользователь сам это инициировал).
  function autofillTargetsIfEmpty(force = false) {
    const tdee = calcTDEE(state.profile);
    if (!tdee) return;
    const goal = $('#goalSelect').value;
    const kcal = Math.round(tdee + goalKcalAdj(goal));
    const protein = Math.round((state.profile.weight_kg || 0) * goalProteinMult(goal));
    const tk = $('#targetKcal');
    const tp = $('#targetProtein');
    tk.placeholder = `авто: ${kcal}`;
    tp.placeholder = `авто: ${protein}`;
    if (force || !tk.value) tk.value = kcal;
    if (force || !tp.value) tp.value = protein;
  }
  // При смене типа цели — всегда пересчитываем (это явное действие пользователя)
  $('#goalSelect').addEventListener('change', () => autofillTargetsIfEmpty(true));

  $('#saveProfileBtn').addEventListener('click', async () => {
    await Storage.setMeta('profile', state.profile);
    // Пересчитываем цели по новому профилю (TDEE override → новый таргет ккал)
    autofillTargetsIfEmpty(true);
    // И сохраняем эти пересчитанные цели тоже
    const tk = parseInt($('#targetKcal').value, 10) || 0;
    const tp = parseInt($('#targetProtein').value, 10) || 0;
    await Storage.setMeta('targetKcal', tk);
    await Storage.setMeta('targetProtein', tp);
    state.settings.targetKcal = tk;
    state.settings.targetProtein = tp;
    // Snapshot для ретроспективного анализа
    await snapshotCurrentSettings();
    flashStatus(`Профиль сохранён · цели пересчитаны: ${tk} ккал, ${tp} г белка`, 'ok');
    refreshDayStatus();
  });

  $('#autoTargetsBtn').addEventListener('click', () => {
    const tdee = calcTDEE(state.profile);
    if (!tdee) return flashStatus('Сначала заполни профиль', 'err');
    const goal = $('#goalSelect').value;
    const kcal = Math.round(tdee + goalKcalAdj(goal));
    const protein = Math.round((state.profile.weight_kg || 70) * goalProteinMult(goal));
    $('#targetKcal').value = kcal;
    $('#targetProtein').value = protein;
    flashStatus(`Авто: ${kcal} ккал, ${protein} г белка`, 'ok');
  });

  $('#saveGoalBtn').addEventListener('click', async () => {
    const goal = $('#goalSelect').value;
    const goalText = $('#goalText').value.trim();
    const tk = parseInt($('#targetKcal').value, 10) || 0;
    const tp = parseInt($('#targetProtein').value, 10) || 0;
    await Storage.setMeta('goal', goal);
    await Storage.setMeta('goalText', goalText);
    await Storage.setMeta('targetKcal', tk);
    await Storage.setMeta('targetProtein', tp);
    state.settings = { goal, goalText, targetKcal: tk, targetProtein: tp };
    updateGoalPill();
    // Snapshot для ретроспективного анализа
    await snapshotCurrentSettings();
    flashStatus('Цель сохранена', 'ok');
  });

  $('#exportBtn').addEventListener('click', async () => {
    const data = await Storage.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tracker-backup-${Storage.todayDate()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
  $('#importInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await Storage.importAll(data);
      // Обновляем UI после импорта — иначе профиль и цели не подхватятся
      await loadSettings();
      state.chat.history = await Storage.getChatMessages();
      await refreshDayStatus();
      await renderTodayLog();
      flashStatus('Импорт завершён', 'ok');
    } catch (err) {
      flashStatus('Ошибка импорта: ' + err.message, 'err');
    }
  });
  $('#wipeBtn').addEventListener('click', async () => {
    if (!confirm('Точно удалить ВСЕ данные? Это необратимо.')) return;
    if (!confirm('Серьёзно? Финальное подтверждение.')) return;
    await Storage.wipe();
    location.reload();
  });

  // -------- TODAY: прогресс-фото (без парсинга, просто сохранение) --------
  const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 МБ — выше IndexedDB OOM рискует
  $('#photoInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      flashStatus(`Фото слишком большое (${Math.round(file.size/1048576)} МБ). Максимум 25 МБ.`, 'err');
      e.target.value = '';
      return;
    }
    try {
      const compressed = await compressImage(file, 1600);
      await Storage.savePhoto(compressed, Storage.todayDate());
      flashStatus('Прогресс-фото сохранено', 'ok');
      e.target.value = '';
      renderTodayLog();
    } catch (err) {
      flashStatus('Ошибка: ' + err.message, 'err');
    }
  });

  // -------- TODAY LOG --------
  async function renderTodayLog() {
    const day = await Storage.getDay(Storage.todayDate());
    const el = $('#todayLog');
    if (!day || (!day.workouts.length && !day.meals.length && !day.mood && !day.body)) {
      el.innerHTML = '<p class="muted small">Пока пусто. Открой «Чат» и напиши что было.</p>';
      return;
    }
    el.innerHTML = renderDayContent(day, { date: day.date, editable: true });
    bindDayLogDeletes(el, day.date);
  }

  function renderDayContent(day, opts = {}) {
    const items = [];
    const editable = !!opts.editable;
    const date = opts.date || day.date;
    (day.workouts || []).forEach((w, i) => {
      const sets = (w.sets || []).map(s => `${s.weight ?? ''}${s.unit && s.unit !== 'kg' ? s.unit : ''}×${s.reps ?? ''}`).join(', ');
      const cardio = w.duration_min ? ` ${w.duration_min}мин` + (w.distance_km ? ` / ${w.distance_km}км` : '') : '';
      const kcal = w.kcal ? ` · 🔥 ${w.kcal}` : '';
      items.push(itemRow(`<span class="tag workout">тр</span>${escapeHtml(w.exercise || '')} ${sets ? '— ' + escapeHtml(sets) : ''}${cardio}${kcal}`, editable, date, 'workouts', i));
    });
    (day.meals || []).forEach((m, i) => {
      items.push(itemRow(`<span class="tag meal">еда</span>${escapeHtml(m.name || '')} · ${m.kcal || 0} ккал · Б${m.protein_g || 0} Ж${m.fat_g || 0} У${m.carbs_g || 0}`, editable, date, 'meals', i));
    });
    if (day.mood && day.mood.score != null) {
      items.push(itemRow(`<span class="tag mood">наст</span>${day.mood.score}/10 ${day.mood.notes ? '· ' + escapeHtml(day.mood.notes) : ''}`, editable, date, 'mood', 0));
    }
    if (day.body) {
      const b = day.body;
      const bits = [];
      if (b.weight_kg) bits.push(`вес ${b.weight_kg}`);
      if (b.sleep_hours) bits.push(`сон ${b.sleep_hours}ч`);
      if (b.steps) bits.push(`${b.steps} шагов`);
      if (b.water_ml) bits.push(`${b.water_ml} мл`);
      if (b.active_kcal) bits.push(`🔥 ${b.active_kcal} ккал`);
      if (bits.length) items.push(itemRow(`<span class="tag body">тело</span>${bits.join(' · ')}`, editable, date, 'body', 0));
    }
    return items.join('') || '<p class="muted small">Пусто.</p>';
  }

  function itemRow(inner, editable, date, kind, index) {
    if (!editable) {
      return `<div class="item">${inner}</div>`;
    }
    return `<div class="item"><div class="item-row"><span>${inner}</span><button class="item-del" data-date="${date}" data-kind="${kind}" data-index="${index}" title="Удалить">×</button></div></div>`;
  }

  function bindDayLogDeletes(root, date) {
    root.querySelectorAll('.item-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const kind = btn.dataset.kind;
        const index = parseInt(btn.dataset.index, 10);
        await Storage.removeFromDay(date, kind, index);
        await renderTodayLog();
        await refreshDayStatus();
      });
    });
  }

  // -------- HISTORY --------
  async function renderHistory() {
    const all = (await Storage.getAllDays()).sort((a, b) => b.date.localeCompare(a.date));
    const root = $('#historyList');
    if (!all.length) {
      root.innerHTML = '<div class="card muted small">Пока нет записей.</div>';
      return;
    }
    root.innerHTML = all.map(d => `
      <div class="day-card">
        <div class="day-head"><span>${fmtDate(d.date)}</span><span class="muted small">${(d.workouts || []).length} тр · ${(d.meals || []).length} приёмов</span></div>
        ${renderDayContent(d)}
      </div>
    `).join('');
  }

  // -------- STATS --------
  async function renderStats() {
    const all = (await Storage.getAllDays()).sort((a, b) => a.date.localeCompare(b.date));
    if (!all.length) {
      ['sumWeight','sumCalories','sumMacros','sumBalance','sumVolume','sumActivity','sumMood'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = 'Пока нет данных.';
      });
      return;
    }

    // Период берём из state.statsRange (синхронизирован с #statsRange selector)
    const range = state.statsRange || '30';
    const slice = range === 'all' ? all : all.slice(-parseInt(range, 10));
    const labels = slice.map(d => d.date.slice(5));

    // Если за период настройки менялись — добавим маркер в карточку периода
    const history = await settingsHistoryForPeriod(slice);
    const noteEl = $('#statsRangeNote');
    const changesInside = Math.max(0, history.length - 1);
    state._settingsChangedInPeriod = changesInside > 0;
    if (noteEl) {
      if (changesInside > 0) {
        noteEl.innerHTML = `Период применяется ко всем графикам ниже и к кнопке «Получить разбор». <b>За период настройки менялись ${changesInside} раз.</b> Цифры в маленькой строке под каждым графиком (типа «119% от цели») сравниваются с <b>текущими</b> настройками. Чтобы получить честную ретроспективу с учётом старых целей — жми «Получить разбор» внизу: ИИ увидит всю историю изменений и оценит каждый день с правильным контекстом.`;
      } else {
        noteEl.textContent = 'Период применяется ко всем графикам ниже и к кнопке «Получить разбор».';
      }
    }

    // === 1) Вес ===
    const weights = slice.map(d => d.body && d.body.weight_kg != null ? d.body.weight_kg : null);
    drawLineChart('chartWeight', labels, [{ label: 'Вес, кг', data: weights, color: '#2563eb' }]);
    setSummary('sumWeight', summaryDelta(weights, 'кг', 1));

    // === 2) Калории ===
    const kcalData = slice.map(d => sum(d.meals || [], m => m.kcal));
    drawLineChart('chartCalories', labels, [
      { label: 'Ккал', data: kcalData.map(v => v || null), color: '#2563eb' },
      ...(state.settings.targetKcal ? [{ label: 'Цель', data: slice.map(() => state.settings.targetKcal), color: '#a8a29e', dashed: true }] : []),
    ]);
    setSummary('sumCalories', summaryAvg(kcalData, 'ккал/день', 0, state.settings.targetKcal));

    // === 3) БЖУ — стек по дням ===
    const proteins = slice.map(d => sum(d.meals || [], m => m.protein_g));
    const fats     = slice.map(d => sum(d.meals || [], m => m.fat_g));
    const carbs    = slice.map(d => sum(d.meals || [], m => m.carbs_g));
    drawStackedBar('chartMacros', labels, [
      { label: 'Белок (г)',    data: proteins, color: '#2563eb' },
      { label: 'Жир (г)',       data: fats,     color: '#d97706' },
      { label: 'Углеводы (г)', data: carbs,    color: '#16a34a' },
    ]);
    setSummary('sumMacros', summaryMacros(proteins, fats, carbs, state.settings.targetProtein));

    // === 4) Тоннаж (с поддержкой bw) ===
    const allDaysAsc = all;
    const volumes = slice.map(d => {
      const bw = latestKnownWeight(allDaysAsc, d.date) || state.profile.weight_kg || 0;
      return sum(d.workouts || [], w => sum(w.sets || [], s => {
        const isBw = s.unit === 'bw' || (!s.weight && s.reps);
        const eff = isBw ? bw : (s.weight || 0);
        return eff * (s.reps || 0);
      }));
    });
    drawLineChart('chartVolume', labels, [{ label: 'Тоннаж, кг', data: volumes.map(v => v || null), color: '#2563eb' }]);
    setSummary('sumVolume', summaryWorkoutDays(volumes, 'кг'));

    // === 5) Настроение ===
    const moods = slice.map(d => d.mood ? d.mood.score : null);
    drawLineChart('chartMood', labels, [{
      label: 'Настроение (1–10)',
      data: moods,
      color: '#d97706',
      yMin: 0, yMax: 10,
    }]);
    setSummary('sumMood', summaryAvg(moods, '/10', 1));

    // === 6) Баланс калорий — ПОЛНЫЙ: kcalIn − (базовый_расход + активность) ===
    // Вычитаем базовый расход (замер пользователя или BMR-формула) — без него
    // «баланс» это просто (съел − активные ккал), что не отражает реальный
    // энергобаланс. См. также плитку «Баланс» в статус-баре — там та же формула.
    const userBmrForChart = calcBaseBurn(state.profile);
    const balance = slice.map(d => {
      const inK = sum(d.meals || [], m => m.kcal);
      const activity = dayBurnKcal(d);
      if (!inK && !activity) return null;
      // Если профиля нет (BMR=0) — возвращаемся к старой формуле, чтобы не показывать
      // фантомный «огромный дефицит». Лучше неточно, чем сбивать новых юзеров.
      if (!userBmrForChart) return inK - activity;
      return inK - (userBmrForChart + activity);
    });
    drawLineChart('chartBalance', labels, [
      { label: 'Баланс, ккал', data: balance, color: '#2563eb' },
      { label: '0 (поддержание)', data: slice.map(() => 0), color: '#a8a29e', dashed: true },
    ]);
    setSummary('sumBalance', summaryBalance(balance));

    // === 7) Активность в минутах ===
    const activeMin = slice.map(d => sum(d.workouts || [], w => w.duration_min || 0));
    drawBarChart('chartActivity', labels, [
      { label: 'Минуты активности', data: activeMin, color: '#2563eb' },
    ]);
    setSummary('sumActivity', summaryWorkoutDays(activeMin, 'мин'));
  }

  // ---- Summary helpers ----
  function setSummary(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html || '';
  }
  function num(v, dec = 0) {
    return `<span class="num">${(v || 0).toFixed(dec)}</span>`;
  }
  // Среднее (исключая нули/null), опционально с целью для сравнения
  function summaryAvg(data, unit, dec = 0, goal = 0) {
    const valid = data.filter(v => v != null && !isNaN(v) && v !== 0);
    if (!valid.length) return '<span class="muted">нет данных</span>';
    const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
    let out = `ср. ${num(avg, dec)} ${unit} · ${valid.length} дн с данными`;
    if (goal) {
      const pct = Math.round((avg / goal) * 100);
      const lbl = state._settingsChangedInPeriod ? 'от текущей цели' : 'от цели';
      out += ` · ${num(pct)}% ${lbl}`;
    }
    return out;
  }
  // Дельта (последнее - первое) + среднее
  function summaryDelta(data, unit, dec = 1) {
    const valid = data.filter(v => v != null && !isNaN(v));
    if (!valid.length) return '<span class="muted">нет данных</span>';
    const first = valid[0], last = valid[valid.length - 1];
    const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
    const delta = last - first;
    const sign = delta >= 0 ? '+' : '';
    const cls = delta > 0 ? 'up' : delta < 0 ? 'down' : '';
    return `сейчас ${num(last, dec)} ${unit} · ср. ${num(avg, dec)} · <span class="hm-delta ${cls}">${sign}${delta.toFixed(dec)} за период</span>`;
  }
  // Сколько было дней с тренировкой + средний показатель в эти дни
  function summaryWorkoutDays(data, unit) {
    const valid = data.filter(v => v != null && v > 0);
    if (!valid.length) return '<span class="muted">нет тренировок</span>';
    const total = valid.reduce((a, b) => a + b, 0);
    const avg = total / valid.length;
    return `${num(valid.length)} дн с тренировкой · ср. ${num(avg, 0)} ${unit} · всего ${num(total, 0)} ${unit}`;
  }
  // Баланс — средний + сколько дней в дефиците/профиците.
  // Цвет среднего значения зависит от цели: для loss/recomp дефицит = зелёный (up),
  // для muscle/endurance профицит = зелёный.
  function summaryBalance(data) {
    const valid = data.filter(v => v != null && !isNaN(v));
    if (!valid.length) return '<span class="muted">нет данных</span>';
    const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
    const def = valid.filter(v => v < 0).length;
    const sur = valid.filter(v => v > 0).length;
    const sign = avg >= 0 ? '+' : '';
    const goal = state.settings.goal;
    const isCutting = goal === 'loss' || goal === 'recomp';
    const isBulking = goal === 'muscle' || goal === 'endurance';
    let cls = '';
    if (isCutting) cls = avg < 0 ? 'up' : avg > 100 ? 'down' : '';
    else if (isBulking) cls = avg > 0 ? 'up' : avg < -100 ? 'down' : '';
    return `<span class="hm-delta ${cls}">${sign}${num(avg, 0)} ккал/день в среднем</span> · ${num(def)} дн дефицит · ${num(sur)} дн профицит`;
  }
  // БЖУ — средние + цель по белку
  function summaryMacros(p, f, c, proteinGoal) {
    const validP = p.filter(v => v > 0);
    if (!validP.length) return '<span class="muted">нет данных</span>';
    const avg = arr => arr.filter(v => v > 0).reduce((a, b) => a + b, 0) / Math.max(1, arr.filter(v => v > 0).length);
    const ap = avg(p), af = avg(f), ac = avg(c);
    let out = `ср. Б ${num(ap, 0)} · Ж ${num(af, 0)} · У ${num(ac, 0)} г/день`;
    if (proteinGoal) {
      const pct = Math.round((ap / proteinGoal) * 100);
      const lbl = state._settingsChangedInPeriod ? 'от текущей цели' : 'от цели';
      out += ` · белок ${num(pct)}% ${lbl}`;
    }
    return out;
  }

  // Последний известный вес тела на дату (включительно)
  function latestKnownWeight(allDaysAsc, dateStr) {
    for (let i = allDaysAsc.length - 1; i >= 0; i--) {
      const d = allDaysAsc[i];
      if (d.date <= dateStr && d.body && d.body.weight_kg) return d.body.weight_kg;
    }
    return null;
  }

  function drawBarChart(canvasId, labels, datasets) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    if (state.charts[canvasId]) state.charts[canvasId].destroy();
    state.charts[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: datasets.map(d => ({ label: d.label, data: d.data, backgroundColor: d.color })) },
      options: chartOpts(),
    });
  }

  function drawLineChart(canvasId, labels, datasets) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    if (state.charts[canvasId]) state.charts[canvasId].destroy();
    state.charts[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: datasets.map(d => ({
          label: d.label,
          data: d.data,
          borderColor: d.color,
          backgroundColor: d.color + '33',
          borderDash: d.dashed ? [4, 4] : [],
          tension: 0.3,
          spanGaps: true,
          pointRadius: 2,
        })),
      },
      options: chartOpts(datasets[0].yMin, datasets[0].yMax),
    });
  }

  function drawStackedBar(canvasId, labels, datasets) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    if (state.charts[canvasId]) state.charts[canvasId].destroy();
    const base = chartOpts();
    state.charts[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: datasets.map(d => ({
          label: d.label, data: d.data, backgroundColor: d.color,
        })),
      },
      options: {
        ...base,
        scales: {
          x: { stacked: true, ticks: { color: '#78716c', font: { size: 10 } }, grid: { color: '#e7e5e4' } },
          y: { stacked: true, ticks: { color: '#78716c', font: { size: 10 } }, grid: { color: '#e7e5e4' } },
        },
      },
    });
  }

  function chartOpts(yMin, yMax) {
    return {
      responsive: true,
      // ВАЖНО: aspectRatio фиксирует высоту = ширина / N. Иначе maintainAspectRatio:false
      // без фиксированной высоты родителя вызывает infinite resize loop (графики «раздуваются»).
      maintainAspectRatio: true,
      aspectRatio: 2,
      plugins: { legend: { labels: { color: '#57534e', font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: '#78716c', maxRotation: 0, autoSkip: true, font: { size: 10 } }, grid: { color: '#e7e5e4' } },
        y: { min: yMin, max: yMax, ticks: { color: '#78716c', font: { size: 10 } }, grid: { color: '#e7e5e4' } },
      },
    };
  }

  // Селектор периода Статы — переключение перерисовывает все графики
  $('#statsRange').addEventListener('change', async () => {
    state.statsRange = $('#statsRange').value;
    await Storage.setMeta('statsRange', state.statsRange);
    await renderStats();
  });

  $('#analyzeBtn').addEventListener('click', async () => {
    const all = (await Storage.getAllDays()).sort((a, b) => a.date.localeCompare(b.date));
    const range = state.statsRange || '30';
    const slice = range === 'all' ? all : all.slice(-parseInt(range, 10));
    if (!slice.length) {
      $('#analysisOutput').textContent = 'Нет данных для разбора.';
      return;
    }
    $('#analysisOutput').textContent = 'Думаю…';
    try {
      const settingsHistory = await settingsHistoryForPeriod(slice);
      const out = await Gemini.weeklyAnalysis(
        slice,
        state.settings.goal,
        targetsForAI(),
        profileForAI(),
        state.settings.goalText,
        settingsHistory
      );
      $('#analysisOutput').innerHTML = formatMultiline(out);
    } catch (err) {
      $('#analysisOutput').textContent = err.message;
    }
  });

  // -------- PHOTOS --------
  async function renderPhotos() {
    const photos = await Storage.getAllPhotos();
    const grid = $('#photoGrid');
    if (!photos.length) {
      grid.innerHTML = '<p class="muted small">Пока нет фото.</p>';
      $('#photoCompareCard').hidden = true;
      return;
    }
    grid.innerHTML = '';
    photos.forEach(p => {
      const url = URL.createObjectURL(p.blob);
      const div = document.createElement('div');
      div.className = 'ph';
      div.dataset.photoId = p.id;
      div.innerHTML = `<img src="${url}" alt=""/><div class="ph-date">${p.date.slice(5)}</div>`;
      div.addEventListener('click', () => togglePhotoSelection(p.id));
      grid.appendChild(div);
    });
  }

  function togglePhotoSelection(id) {
    const idx = state.selectedPhotoIds.indexOf(id);
    if (idx >= 0) state.selectedPhotoIds.splice(idx, 1);
    else state.selectedPhotoIds.push(id);
    if (state.selectedPhotoIds.length > 2) state.selectedPhotoIds = state.selectedPhotoIds.slice(-2);
    document.querySelectorAll('.ph').forEach(el => {
      el.style.outline = state.selectedPhotoIds.includes(el.dataset.photoId) ? '2px solid var(--accent)' : 'none';
    });
    if (state.selectedPhotoIds.length === 2) showCompareCard();
    else $('#photoCompareCard').hidden = true;
  }

  async function showCompareCard() {
    const [a, b] = await Promise.all(state.selectedPhotoIds.map(id => Storage.getPhoto(id)));
    const ordered = a.ts < b.ts ? [a, b] : [b, a];
    const cont = $('#photoCompareImages');
    cont.innerHTML = '';
    ordered.forEach((p, i) => {
      const url = URL.createObjectURL(p.blob);
      const div = document.createElement('div');
      div.className = 'compare-img';
      div.innerHTML = `<img src="${url}"/><div class="cap">${i === 0 ? 'было' : 'стало'} · ${p.date}</div>`;
      cont.appendChild(div);
    });
    $('#photoCompareCard').hidden = false;
    $('#photoCompareOutput').textContent = ordered[1].observations || '';
    $('#runCompareBtn').onclick = async () => {
      $('#photoCompareOutput').textContent = 'Думаю…';
      try {
        const out = await Gemini.comparePhotos(ordered[0], ordered[1]);
        await Storage.updatePhoto(ordered[1].id, { observations: out, comparedTo: ordered[0].id });
        $('#photoCompareOutput').innerHTML = formatMultiline(out);
      } catch (err) {
        $('#photoCompareOutput').textContent = err.message;
      }
    };
  }

  // -------- CHAT --------
  async function renderChat() {
    if (!state.chat.history.length) {
      state.chat.history = await Storage.getChatMessages();
    }
    const scroll = $('#chatScroll');
    if (!state.chat.history.length) {
      scroll.innerHTML = '<div class="empty-chat">Спроси у тренера что-нибудь или просто напиши что было сегодня. Он видит твои последние записи.</div>';
    } else {
      scroll.innerHTML = state.chat.history.map(m => renderChatMsg(m)).join('');
      scroll.scrollTop = scroll.scrollHeight;
    }
    await updateRangeCounts();
  }

  // Обновляет подписи в селекторе диапазона "(N с данными)" — чтобы было видно
  // сколько реально дней с записями попадёт в контекст
  async function updateRangeCounts() {
    const sel = $('#chatRange');
    if (!sel) return;
    const all = (await Storage.getAllDays()).sort((a, b) => a.date.localeCompare(b.date));
    const total = all.length;
    for (const opt of sel.options) {
      const v = opt.value;
      const baseLabel = opt.dataset.base || opt.textContent.replace(/\s*\(.+\)$/, '');
      opt.dataset.base = baseLabel;
      // «авто» — счётчик не показываем (период динамический)
      if (v === 'auto') { opt.textContent = baseLabel; continue; }
      let n;
      if (v === 'all') n = total;
      else n = all.slice(-parseInt(v, 10)).length;
      opt.textContent = `${baseLabel} (${n})`;
    }
  }

  // Распознаёт период из текста сообщения. Используется когда селектор = «авто».
  // Возвращает либо число дней, либо 'all'. По умолчанию — 1 (только сегодня).
  // Порядок проверки от более длинных к коротким — чтобы «полгода» не схватил «месяц».
  function detectPeriodFromMessage(text) {
    const t = (text || '').toLowerCase();
    if (/(всё врем|вс[её] историю|весь период|за всё)/i.test(t)) return 'all';
    if (/(полгода|180 дней|6 месяц|шесть месяц)/i.test(t)) return 180;
    if (/(квартал|3 месяц|три месяц|90 дней)/i.test(t)) return 90;
    if (/(2 месяц|два месяц|60 дней)/i.test(t)) return 60;
    if (/(месяц|30 дней)/i.test(t)) return 30;
    if (/(2 недел|две недел|14 дней)/i.test(t)) return 14;
    if (/(недел|7 дней|последние 7)/i.test(t)) return 7;
    if (/(вчер|позавчер|3 дня|три дня)/i.test(t)) return 3;
    return 1; // по умолчанию — только сегодня
  }

  function renderChatMsg(m) {
    const klass = m.role === 'user' ? 'user' : 'assistant';
    const atts = (m.attachments || []).map(a => {
      if (!a || !a.data) return '';
      return `<img src="data:${a.mime || 'image/jpeg'};base64,${a.data}" alt="" />`;
    }).join('');
    const editable = m.role === 'user' ? ` data-msg-id="${m.id}" title="Тап → редактировать"` : '';
    let html = `<div class="chat-msg ${klass}"${editable}>${atts ? '<div class="att-row">' + atts + '</div>' : ''}${escapeHtml(m.content || '')}</div>`;
    if (m.role === 'user' && m.extracted && hasExtracted(m.extracted)) {
      html += renderExtractChip(m.extracted, m.id);
    }
    return html;
  }

  function hasExtracted(ex) {
    if (!ex) return false;
    return (ex.workouts && ex.workouts.length) ||
           (ex.meals && ex.meals.length) ||
           (ex.mood && (ex.mood.score != null || ex.mood.notes)) ||
           (ex.body && Object.keys(ex.body).some(k => ex.body[k] != null));
  }

  function summarizeExtracted(ex) {
    const tags = [];
    if (ex.meals && ex.meals.length) tags.push(`${ex.meals.length} 🍽`);
    if (ex.workouts && ex.workouts.length) tags.push(`${ex.workouts.length} 💪`);
    const workoutKcal = (ex.workouts || []).reduce((a, w) => a + (w.kcal || 0), 0);
    const burn = workoutKcal + ((ex.body && ex.body.active_kcal) || 0);
    if (burn) tags.push(`🔥 ${burn}`);
    if (ex.body && ex.body.weight_kg) tags.push(`⚖ ${ex.body.weight_kg}`);
    if (ex.body && ex.body.sleep_hours) tags.push(`😴 ${ex.body.sleep_hours}ч`);
    if (ex.mood && ex.mood.score != null) tags.push(`😐 ${ex.mood.score}/10`);
    return tags.map(t => `<span class="chip-tag">${escapeHtml(t)}</span>`).join(' ');
  }

  // Найти индекс элемента в массиве дня. Сначала по уникальному _id (если есть),
  // иначе fallback на сравнение по содержимому (для старых сообщений до введения _id).
  function matchIndex(arr, item, kind) {
    if (item && item._id) {
      const byId = arr.findIndex(x => x && x._id === item._id);
      if (byId >= 0) return byId;
    }
    if (kind === 'meals') {
      return arr.findIndex(m => m.name === item.name && (m.kcal || 0) === (item.kcal || 0));
    }
    if (kind === 'workouts') {
      return arr.findIndex(w => w.exercise === item.exercise && JSON.stringify(w.sets || []) === JSON.stringify(item.sets || []));
    }
    return -1;
  }

  function renderExtractChip(ex, msgId) {
    return `<div class="extract-chip" data-msg-id="${msgId}">
      <div class="chip-summary"><span>📥 записал</span> ${summarizeExtracted(ex)}</div>
    </div>`;
  }

  // Делегированный клик: разворачивание чипа с возможностью удалить элементы,
  // плюс edit/retry по тапу на user-сообщение
  function bindChatChipHandlers() {
    $('#chatScroll').addEventListener('click', async (e) => {
      // Edit user message (тап по самому пузырю)
      const userMsg = e.target.closest('.chat-msg.user');
      if (userMsg && !e.target.closest('.extract-chip')) {
        const msgId = userMsg.dataset.msgId;
        if (!msgId) return;
        const idx = state.chat.history.findIndex(m => m.id === msgId);
        if (idx < 0) return;
        if (!confirm('Редактировать это сообщение? Оно и ответ ассистента будут удалены.')) return;
        const msg = state.chat.history[idx];
        // Откат логированного из этого сообщения
        if (msg.extracted) {
          const date = msg.ts ? new Date(msg.ts).toISOString().slice(0, 10) : Storage.todayDate();
          const day = await Storage.getDay(date);
          if (day) {
            for (const kind of ['meals', 'workouts']) {
              if (Array.isArray(msg.extracted[kind]) && Array.isArray(day[kind])) {
                for (const item of msg.extracted[kind]) {
                  const di = matchIndex(day[kind], item, kind);
                  if (di >= 0) await Storage.removeFromDay(date, kind, di);
                }
              }
            }
          }
        }
        // Удаляем user-сообщение и (если есть) следующий ассистентский ответ
        await Storage.deleteChatMessage(msg.id);
        const next = state.chat.history[idx + 1];
        if (next && next.role === 'assistant') {
          await Storage.deleteChatMessage(next.id);
        }
        // Перезагружаем историю и кладём текст обратно в input
        state.chat.history = await Storage.getChatMessages();
        $('#chatInput').value = msg.content || '';
        $('#chatInput').focus();
        autoResizeChatInput();
        await renderChat();
        await refreshDayStatus();
        flashStatus('Сообщение возвращено в редактирование', 'ok');
        return;
      }

      const chip = e.target.closest('.extract-chip');
      if (!chip) return;
      // Если кликнули по кнопке удаления — отдельная ветка
      const delBtn = e.target.closest('.ed-del');
      if (delBtn) {
        e.stopPropagation();
        const kind = delBtn.dataset.kind;
        const chipIdx = parseInt(delBtn.dataset.index, 10);
        const date = delBtn.dataset.date;
        const msgId = chip.dataset.msgId;
        const msg = state.chat.history.find(m => m.id === msgId);
        if (msg && msg.extracted) {
          // Находим соответствующий элемент в дне по контенту (а не по индексу — он мог сдвинуться)
          const day = await Storage.getDay(date);
          if (kind === 'mood' || kind === 'body') {
            if (day) await Storage.removeFromDay(date, kind, 0);
            msg.extracted[kind] = null;
          } else if (Array.isArray(msg.extracted[kind]) && msg.extracted[kind][chipIdx]) {
            const item = msg.extracted[kind][chipIdx];
            if (day && Array.isArray(day[kind])) {
              const dayIdx = matchIndex(day[kind], item, kind);
              if (dayIdx >= 0) await Storage.removeFromDay(date, kind, dayIdx);
            }
            msg.extracted[kind].splice(chipIdx, 1);
          }
          await Storage.updateChatExtracted(msgId, msg.extracted);
        }
        await renderChat();
        await refreshDayStatus();
        flashStatus('Удалено', 'ok');
        return;
      }
      // Иначе — toggle деталей
      const open = chip.classList.toggle('open');
      let details = chip.querySelector('.chip-details');
      if (open) {
        if (!details) {
          const msgId = chip.dataset.msgId;
          const msg = state.chat.history.find(m => m.id === msgId);
          if (msg && msg.extracted) {
            const msgDate = msg.ts ? new Date(msg.ts).toISOString().slice(0, 10) : Storage.todayDate();
            details = document.createElement('div');
            details.className = 'chip-details';
            details.innerHTML = renderChipDetails(msg.extracted, msgDate);
            chip.appendChild(details);
          }
        } else {
          details.style.display = '';
        }
      } else if (details) {
        details.style.display = 'none';
      }
    });
  }

  function renderChipDetails(ex, date) {
    const rows = [];
    (ex.meals || []).forEach((m, i) => {
      rows.push(`<div class="ed-item"><span>🍽 ${escapeHtml(m.name || 'Приём')} · ${m.kcal || 0} ккал · Б${m.protein_g || 0}</span><button class="ed-del" data-kind="meals" data-index="${i}" data-date="${date}">×</button></div>`);
    });
    (ex.workouts || []).forEach((w, i) => {
      const sets = (w.sets || []).map(s => `${s.weight ?? ''}×${s.reps ?? ''}`).join(',');
      const cardio = w.duration_min ? ` ${w.duration_min}мин` : '';
      const kcal = w.kcal ? ` · ${w.kcal}ккал` : '';
      rows.push(`<div class="ed-item"><span>💪 ${escapeHtml(w.exercise || '')} ${sets}${cardio}${kcal}</span><button class="ed-del" data-kind="workouts" data-index="${i}" data-date="${date}">×</button></div>`);
    });
    if (ex.body && Object.keys(ex.body).some(k => ex.body[k] != null)) {
      const b = ex.body;
      const bits = [];
      if (b.weight_kg) bits.push(`вес ${b.weight_kg}`);
      if (b.sleep_hours) bits.push(`сон ${b.sleep_hours}ч`);
      if (b.active_kcal) bits.push(`🔥 ${b.active_kcal} ккал`);
      if (b.steps) bits.push(`${b.steps} шагов`);
      if (b.water_ml) bits.push(`${b.water_ml}мл`);
      rows.push(`<div class="ed-item"><span>📊 ${bits.join(' · ')}</span><button class="ed-del" data-kind="body" data-index="0" data-date="${date}">×</button></div>`);
    }
    if (ex.mood && ex.mood.score != null) {
      rows.push(`<div class="ed-item"><span>😐 настр. ${ex.mood.score}/10</span><button class="ed-del" data-kind="mood" data-index="0" data-date="${date}">×</button></div>`);
    }
    return rows.join('') || '<p class="muted small" style="margin:0">Пусто.</p>';
  }

  function appendTransientChatMsg(role, html, klass = '') {
    const scroll = $('#chatScroll');
    const div = document.createElement('div');
    div.className = 'chat-msg ' + role + (klass ? ' ' + klass : '');
    div.innerHTML = html;
    scroll.appendChild(div);
    scroll.scrollTop = scroll.scrollHeight;
    return div;
  }

  $('#chatAttach').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const status = $('#chatAttachStatus');
    if (file.size > MAX_UPLOAD_BYTES) {
      status.textContent = '';
      flashStatus(`Файл слишком большой (${Math.round(file.size/1048576)} МБ). Максимум 25 МБ.`, 'err');
      e.target.value = '';
      return;
    }
    if (file.type.startsWith('image/')) {
      const compressed = await compressImage(file, 1280);
      const base64 = await Storage.blobToBase64(compressed);
      state.chat.pendingAttachments = [{ blob: compressed, base64, mime: 'image/jpeg', kind: 'image' }];
      status.textContent = `1 фото · ${Math.round(compressed.size / 1024)} КБ`;
    } else if (file.type.startsWith('video/')) {
      status.textContent = 'Извлекаю кадры…';
      try {
        const frames = await extractVideoFrames(file, 4, 30);
        state.chat.pendingAttachments = frames;
        status.textContent = `${frames.length} кадра из видео`;
      } catch (err) {
        status.textContent = 'Ошибка видео: ' + err.message;
      }
    } else {
      status.textContent = 'Неподдерживаемый тип';
    }
    e.target.value = '';
  });

  $('#chatClearBtn').addEventListener('click', async () => {
    if (!confirm('Очистить всю переписку с тренером?')) return;
    await Storage.clearChat();
    state.chat.history = [];
    renderChat();
  });

  $('#chatInput').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      $('#chatSendBtn').click();
    }
  });

  // Auto-grow textarea: высота подстраивается под контент до max-height (заданного в CSS).
  // После этого включается внутренний скролл.
  function autoResizeChatInput() {
    const el = $('#chatInput');
    if (!el) return;
    el.style.height = 'auto';
    // Берём scrollHeight (естественная высота) + клампим в [min, max] из CSS
    const minH = parseInt(getComputedStyle(el).minHeight, 10) || 64;
    const maxH = parseInt(getComputedStyle(el).maxHeight, 10) || 180;
    el.style.height = Math.max(minH, Math.min(el.scrollHeight, maxH)) + 'px';
  }
  $('#chatInput').addEventListener('input', autoResizeChatInput);
  // На старте — на случай если в textarea подгружается какой-то предзаполненный текст
  autoResizeChatInput();

  $('#chatSendBtn').addEventListener('click', async () => {
    const input = $('#chatInput');
    const text = input.value.trim();
    const atts = state.chat.pendingAttachments;
    if (!text && !atts.length) return;
    if (navigator.onLine === false) {
      return flashStatus('Нет интернета — Gemini недоступен', 'err');
    }

    // 1) Сохраняем сообщение пользователя (extracted дозапишем после парсинга)
    const userMsg = await Storage.saveChatMessage({
      role: 'user',
      content: text,
      attachments: atts,
    });
    state.chat.history.push(userMsg);
    input.value = '';
    input.style.height = '';  // сброс высоты после auto-grow
    state.chat.pendingAttachments = [];
    $('#chatAttachStatus').textContent = '';
    await renderChat();

    // 2) Готовим контекст: либо явно выбранный период, либо распознанный из текста
    const selValue = $('#chatRange').value;
    const range = selValue === 'auto' ? detectPeriodFromMessage(text) : selValue;
    const allDays = await Storage.getAllDays();
    const sortedDays = allDays.sort((a, b) => a.date.localeCompare(b.date));
    const contextDays = range === 'all' ? sortedDays : sortedDays.slice(-parseInt(range, 10));

    // 3) Показываем «печатает»
    const typing = appendTransientChatMsg('assistant', '<span></span><span></span><span></span>', 'typing');

    // 4) Один объединённый вызов: парсер + тренер
    try {
      const settingsHistory = await settingsHistoryForPeriod(contextDays);
      const result = await Gemini.parseAndChat({
        userMessage: text,
        attachments: atts,
        // Берём только последние 10 предыдущих сообщений как «ниточку разговора».
        // Раньше было 29 — оказалось избыточно: ИИ всё равно видит факты в contextDays и snapshots.
        history: state.chat.history.slice(-11, -1).map(m => ({
          role: m.role, content: m.content,
        })),
        contextDays,
        goal: state.settings.goal,
        goalText: state.settings.goalText,
        targets: targetsForAI(),
        userProfile: profileForAI(),
        settingsHistory,
      });
      typing.remove();

      // Если что-то извлёк — мерджим в день и обновляем сообщение
      if (hasExtracted(result.extracted)) {
        await Storage.mergeIntoDay(Storage.todayDate(), result.extracted, text);
        await Storage.updateChatExtracted(userMsg.id, result.extracted);
        // Обновляем локально, чтобы не перечитывать всё
        const local = state.chat.history.find(m => m.id === userMsg.id);
        if (local) local.extracted = result.extracted;
      }

      // Сохраняем ответ ассистента
      let replyText = result.reply || '';
      if (!replyText.trim() && !hasExtracted(result.extracted)) {
        replyText = 'Не понял, что записать. Уточни деталями.';
      } else if (!replyText.trim()) {
        replyText = 'Записал.';
      }
      const assistantMsg = await Storage.saveChatMessage({
        role: 'assistant',
        content: replyText,
      });
      state.chat.history.push(assistantMsg);

      await renderChat();
      await refreshDayStatus();
    } catch (err) {
      typing.remove();
      appendTransientChatMsg('assistant', escapeHtml(err.message), 'error');
    }
  });

  // -------- ГОЛОСОВОЙ ВВОД --------
  (function initVoice() {
    const btn = $('#chatVoiceBtn');
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      btn.disabled = true;
      btn.title = 'Голосовой ввод не поддерживается в этом браузере';
      btn.style.opacity = 0.4;
      return;
    }
    let recog = null;
    let active = false;
    btn.addEventListener('click', () => {
      if (active) {
        recog && recog.stop();
        return;
      }
      recog = new SR();
      recog.lang = 'ru-RU';
      recog.interimResults = true;
      recog.continuous = true;
      let finalText = $('#chatInput').value;
      const startLen = finalText.length;
      recog.onresult = (e) => {
        let interim = '';
        let appended = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const txt = e.results[i][0].transcript;
          if (e.results[i].isFinal) appended += txt;
          else interim += txt;
        }
        if (appended) finalText = (finalText + ' ' + appended).trim();
        $('#chatInput').value = (finalText + (interim ? ' ' + interim : '')).trim();
      };
      recog.onerror = (e) => {
        flashStatus('Голос: ' + e.error, 'err');
      };
      recog.onend = () => {
        active = false;
        btn.classList.remove('recording');
        btn.textContent = '🎙';
      };
      recog.start();
      active = true;
      btn.classList.add('recording');
      btn.textContent = '⏺';
    });
  })();

  // Видео → массив кадров (frames кадров, длительность видео клампим до maxSec)
  async function extractVideoFrames(file, frames = 4, maxSec = 30) {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('не могу прочитать видео'));
    });
    const dur = Math.min(video.duration || 0, maxSec);
    if (!dur || !isFinite(dur)) throw new Error('видео без длительности');
    const points = [];
    for (let i = 0; i < frames; i++) {
      points.push((dur * (i + 0.5)) / frames);
    }
    const out = [];
    for (const t of points) {
      await new Promise((resolve) => {
        const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
        video.addEventListener('seeked', onSeeked);
        video.currentTime = t;
      });
      const w = Math.min(video.videoWidth || 720, 1280);
      const h = Math.round((video.videoHeight || 1280) * (w / (video.videoWidth || 1)));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(video, 0, 0, w, h);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.82));
      const base64 = await Storage.blobToBase64(blob);
      out.push({ blob, base64, mime: 'image/jpeg', kind: 'video_frame' });
    }
    URL.revokeObjectURL(url);
    return out;
  }

  // -------- UTILS --------
  // Универсальный toast — работает на любой вкладке. Создаёт элемент при первом вызове.
  function flashStatus(msg, kind = 'info', autoHide = true) {
    let toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.className = 'toast ' + (kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : '');
    toast.textContent = msg;
    toast.classList.add('show');
    if (autoHide) {
      clearTimeout(state._statusTimer);
      state._statusTimer = setTimeout(() => { toast.classList.remove('show'); }, 2500);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function formatMultiline(s) {
    return escapeHtml(s).split('\n').map(l => `<p>${l}</p>`).join('');
  }

  // Сжатие изображения через canvas
  async function compressImage(file, maxDim = 1600, quality = 0.85) {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = URL.createObjectURL(file);
    });
    let { width, height } = img;
    if (Math.max(width, height) > maxDim) {
      const ratio = maxDim / Math.max(width, height);
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  }

  // -------- INIT --------
  (async function init() {
    await loadSettings();
    await ensureInitialSnapshot();
    bindChatChipHandlers();
    setTab('chat');
    await refreshDayStatus();

    // iOS Safari: подталкиваем скролл чата при появлении клавиатуры,
    // чтобы input не уезжал под клавиатуру
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => {
        if (document.activeElement === $('#chatInput')) {
          const scroll = $('#chatScroll');
          if (scroll) scroll.scrollTop = scroll.scrollHeight;
          // Прокручиваем сам input в видимую часть
          setTimeout(() => $('#chatInput').scrollIntoView({ block: 'end' }), 50);
        }
      });
    }

    // Регистрация Service Worker (вынесена из inline-скрипта в HTML — для CSP)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  })();
})();
