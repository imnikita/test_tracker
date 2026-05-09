// gemini.js — клиент к Gemini API: парсер записей, аналитик трендов, тренер, наблюдатель за фото.
// Все вызовы идут с устройства напрямую к Google.

const Gemini = (() => {
  // Дефолт: gemini-2.5-flash — текущая free-tier модель Google (gemini-2.0-flash была
  // переведена на платный тариф в начале 2026, на free-tier у неё limit: 0).
  // Пользователь может переопределить через настройки (Storage.meta 'model').
  const DEFAULT_MODEL = 'gemini-2.5-flash';
  const ENDPOINT = (model, key) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

  async function getModel() {
    return (await Storage.getMeta('model', DEFAULT_MODEL)) || DEFAULT_MODEL;
  }

  // Schema для парсера. Без required — модель может вернуть пустые поля, если в тексте их нет.
  const PARSE_SCHEMA = {
    type: 'object',
    properties: {
      workouts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            exercise: { type: 'string', description: 'Название упражнения, нормализованное' },
            sets: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  weight: { type: 'number' },
                  reps: { type: 'number' },
                  unit: { type: 'string', enum: ['kg', 'lb', 'bw'] },
                },
              },
            },
            duration_min: { type: 'number', description: 'Для кардио / игр — длительность в минутах' },
            distance_km: { type: 'number', description: 'Для кардио — дистанция в км' },
            kcal: { type: 'number', description: 'Калории, сожжённые именно за эту тренировку (если пользователь упомянул)' },
            notes: { type: 'string' },
          },
        },
      },
      meals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Краткое название приёма пищи' },
            time_of_day: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] },
            kcal: { type: 'number' },
            protein_g: { type: 'number' },
            fat_g: { type: 'number' },
            carbs_g: { type: 'number' },
            notes: { type: 'string' },
          },
        },
      },
      mood: {
        type: 'object',
        properties: {
          score: { type: 'number', description: 'От 1 (плохо) до 10 (отлично)' },
          notes: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          weight_kg: { type: 'number' },
          sleep_hours: { type: 'number' },
          steps: { type: 'number' },
          water_ml: { type: 'number' },
          active_kcal: { type: 'number', description: 'Активные калории, сожжённые за день (Apple Watch / фитнес-трекер)' },
        },
      },
      summary_ru: { type: 'string', description: 'Очень короткое резюме записи на русском' },
    },
  };

  async function callApi(body) {
    const apiKey = await Storage.getMeta('apiKey');
    if (!apiKey) throw new Error('Сначала добавь Gemini API key в настройках.');
    const model = await getModel();
    const res = await fetch(ENDPOINT(model, apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      let parsed;
      try { parsed = JSON.parse(errText); } catch (_) {}
      const msg = (parsed && parsed.error && parsed.error.message) || errText || `HTTP ${res.status}`;
      throw new Error('Ошибка Gemini: ' + msg);
    }
    return res.json();
  }

  // Превращает массив snapshot настроек в читаемый список изменений.
  // Каждая строка: «с DATE: цель X, kcal Y, белок Z г».
  function formatSettingsHistory(snapshots) {
    if (!snapshots || !snapshots.length) return '';
    const labelMap = {
      muscle: 'рост мышц', recomp: 'рекомпозиция',
      loss: 'снижение жира', fitness: 'поддержание', endurance: 'выносливость',
    };
    return snapshots.map(s => {
      const lbl = labelMap[s.goal] || s.goal || '?';
      const text = s.goalText ? ` ("${s.goalText.slice(0, 80)}")` : '';
      const k = s.targetKcal ? `${s.targetKcal} ккал` : '?';
      const p = s.targetProtein ? `${s.targetProtein} г белка` : '?';
      return `  с ${s.date}: цель «${lbl}»${text}, ${k}/день, ${p}`;
    }).join('\n');
  }

  // Превращает профиль (sex, age, height_cm, weight_kg, activity, BMR, TDEE)
  // в читаемую строку для системного промпта. Возвращает '' если профиля нет.
  function profileLine(p) {
    if (!p) return '';
    const bits = [];
    if (p.sex) bits.push(p.sex === 'm' ? 'мужчина' : 'женщина');
    if (p.age) bits.push(p.age + ' лет');
    if (p.height_cm) bits.push(p.height_cm + ' см');
    if (p.weight_kg) bits.push(p.weight_kg + ' кг');
    if (p.activity) {
      const lvl = ({
        sedentary: 'малоподв.', light: 'лёгкая', moderate: 'умеренная',
        high: 'высокая', very_high: 'очень высокая',
      })[p.activity];
      if (lvl) bits.push('активность ' + lvl);
    }
    const head = bits.length ? 'Профиль: ' + bits.join(', ') + '.' : '';
    const energy = (p.bmr || p.tdee)
      ? `Энергозатраты: BMR ≈ ${p.bmr || '?'} ккал, TDEE ≈ ${p.tdee || '?'} ккал/день (без учёта тренировок). Используй TDEE как базовый расход.`
      : '';
    return [head, energy].filter(Boolean).join(' ');
  }

  function extractText(resp) {
    try {
      return resp.candidates[0].content.parts.map(p => p.text || '').join('');
    } catch (_) {
      return '';
    }
  }

  // --- Аналитик трендов: смотрит на N дней и пишет короткий разбор ---
  async function weeklyAnalysis(days, goal, targets, userProfile, goalText, settingsHistory = []) {
    // Используем единую compactDays (как в чате) — она включает BMR + полный расход + баланс,
    // чтобы ИИ не путал «активные калории» с «полным дневным расходом».
    const userBmr = (userProfile && userProfile.bmr) ? userProfile.bmr : 0;
    const compact = compactDays(days, userBmr);

    const goalLabel = ({
      muscle: 'рост мышц и силы',
      recomp: 'рекомпозиция (держать вес, наращивать мышцы, снижать жир)',
      loss: 'снижение жира',
      fitness: 'общая форма',
      endurance: 'выносливость',
    })[goal] || 'общая форма';

    const sys = [
      // Тот же тренер, что в чате — единая личность.
      'Ты — тот же личный тренер пользователя из его чата в трекере. Жёсткий по фактам, мягкий по форме. Без морали, без «помни», без эмодзи, без приторных фраз. На «ты», на русском.',
      '',
      goalText
        ? `ЦЕЛЬ ПОЛЬЗОВАТЕЛЯ (его слова): "${goalText}". Категория: ${goalLabel}.`
        : `ЦЕЛЬ ПОЛЬЗОВАТЕЛЯ: ${goalLabel}.`,
      profileLine(userProfile),
      targets ? `ЦЕЛИ ПО ДНЮ: ${targets.kcal || '-'} ккал, ${targets.protein || '-'} г белка.` : '',
      '',
      'ПОЛУЧАЕШЬ массив дней за выбранный пользователем период. Дай разбор в 4 коротких блока (общий лимит ~250 слов):',
      '',
      '1. ЦИФРЫ ЗА ПЕРИОД (1-2 фразы): главные средние и дельта по весу / калориям / белку / тренировкам. Только важное.',
      '',
      '2. ЧТО ЧИТАЕТСЯ (2-3 фразы): 2-3 паттерна с конкретикой. Называй дни недели или числа: «3 из 7 дней калории выше 2500», «вес стоит 12 дней — 78.4 → 78.5 → 78.4», «белок ниже 100г в среду и пятницу».',
      '',
      '3. ГДЕ РАЗРЫВ С ЦЕЛЬЮ (1-2 фразы): где главный затык относительно цели пользователя. Честно, без обтекаемых формулировок.',
      '',
      '4. ЧТО ДЕЛАТЬ НА СЛЕДУЮЩУЮ НЕДЕЛЮ (2-3 пункта списком): конкретные действия с числами. НЕ «больше белка», А «добей до 130-150г каждый день — это +50г к среднему: 200г грудки или 1 банка тунца + 200г творога».',
      '',
      'Если данных мало (<7 дней с записями) — прямо скажи и дай только то что видно, не выдумывай тренды.',
      '',
      'СТРУКТУРА ДАННЫХ ДНЯ:',
      '  • kcal_in — съел; activity_kcal — активность сверх покоя;',
      '  • bmr — базовый метаболизм; total_burn = bmr + activity_kcal — ПОЛНЫЙ расход;',
      '  • net_balance = kcal_in − total_burn (отрицательный = дефицит, положительный = профицит).',
      'Когда говоришь о дефиците/профиците — используй ТОЛЬКО net_balance, НИКОГДА не activity_kcal в одиночку. Иначе получишь фундаментальную ошибку про «профицит» когда на самом деле большой дефицит.',
      'target_kcal — это плановый таргет для обычного дня. На очень активных днях реальный расход выше — там net_balance может быть в большем дефиците чем планировалось.',
      '',
      'НИКАКИХ медицинских диагнозов, никаких добавок/препаратов.',
      '',
      settingsHistory.length > 1 ? 'ИСТОРИЯ ИЗМЕНЕНИЙ ЦЕЛЕЙ ПОЛЬЗОВАТЕЛЯ ЗА ПЕРИОД (важно: каждый день оценивай с теми настройками, что были активны на ту дату — не с текущими):' : '',
      settingsHistory.length > 1 ? formatSettingsHistory(settingsHistory) : '',
    ].filter(Boolean).join('\n');

    const body = {
      contents: [{ role: 'user', parts: [{ text: sys + '\n\nДАННЫЕ:\n' + JSON.stringify(compact, null, 2) }] }],
      generationConfig: { temperature: 0.5 },
    };

    const resp = await callApi(body);
    return extractText(resp).trim();
  }

  // --- Сравнение фото: два фото + даты → нейтральные наблюдения ---
  async function comparePhotos(oldPhoto, newPhoto) {
    const sys = [
      'Ты помогаешь сравнить два фото прогресса физической формы одного человека.',
      'Опиши нейтрально, без оценочных слов «лучше/хуже», что заметно изменилось визуально между фото.',
      'Сосредоточься на наблюдаемых вещах: осанка, объёмы плеч/талии/бёдер, очертания мышц, общий тонус кожи. Не делай медицинских или психологических выводов.',
      'Не упоминай вес, % жира — этого по фото знать нельзя. Не давай советов о диете.',
      'Пиши коротко (3–6 предложений) на русском.',
    ].join(' ');

    const body = {
      contents: [{
        role: 'user',
        parts: [
          { text: sys + `\n\nФото 1 — дата ${oldPhoto.date}. Фото 2 — дата ${newPhoto.date}.` },
          { inlineData: { mimeType: oldPhoto.mime, data: await Storage.blobToBase64(oldPhoto.blob) } },
          { inlineData: { mimeType: newPhoto.mime, data: await Storage.blobToBase64(newPhoto.blob) } },
        ],
      }],
      generationConfig: { temperature: 0.4 },
    };

    const resp = await callApi(body);
    return extractText(resp).trim();
  }

  // Сжатое представление дней — экономит токены.
  // userBmr нужен чтобы посчитать ПОЛНЫЙ расход дня (BMR + активность) и реальный баланс.
  // Без BMR ИИ путает «активные калории» с «полным расходом» и неправильно судит о дефиците/профиците.
  function compactDays(days, userBmr = 0) {
    return days.map(d => {
      const meals = d.meals || [];
      const workouts = d.workouts || [];
      const workoutKcal = workouts.reduce((a, w) => a + (w.kcal || 0), 0);
      const activeKcal = (d.body && d.body.active_kcal) || 0;
      // active_kcal с Apple Watch уже включает workouts. Если он есть — используем
      // только его, иначе берём сумму kcal тренировок. Иначе двойной счёт.
      const activity = activeKcal > 0 ? activeKcal : workoutKcal;
      const kcalIn = meals.reduce((a, m) => a + (m.kcal || 0), 0);
      // Полный дневной расход = BMR (базовый) + активность сверх покоя
      const totalBurn = userBmr ? userBmr + activity : null;
      // Реальный баланс = съел − полный расход (отрицательный = дефицит)
      const netBalance = (kcalIn && totalBurn) ? kcalIn - totalBurn : null;
      const out = {
        date: d.date,
        kcal_in: kcalIn || null,
        p_g: meals.reduce((a, m) => a + (m.protein_g || 0), 0) || null,
        f_g: meals.reduce((a, m) => a + (m.fat_g || 0), 0) || null,
        c_g: meals.reduce((a, m) => a + (m.carbs_g || 0), 0) || null,
        activity_kcal: activity || null,
        bmr: userBmr || null,
        total_burn: totalBurn,
        net_balance: netBalance,
        meals: meals.length ? meals.map(m => `${m.name || ''} (${m.kcal || 0}ккал)`).join('; ') : null,
        workouts: workouts.length
          ? workouts.map(w => {
              const sets = (w.sets || []).map(s => `${s.weight ?? '-'}×${s.reps ?? '-'}`).join(',');
              const cardio = w.duration_min ? `${w.duration_min}мин${w.distance_km ? '/' + w.distance_km + 'км' : ''}` : '';
              const wk = w.kcal ? ` ${w.kcal}ккал` : '';
              return `${w.exercise || ''}${sets ? ' ' + sets : ''}${cardio ? ' ' + cardio : ''}${wk}`;
            }).join('; ')
          : null,
        mood: d.mood ? d.mood.score : null,
        weight: d.body ? d.body.weight_kg : null,
        sleep: d.body ? d.body.sleep_hours : null,
      };
      Object.keys(out).forEach(k => out[k] == null && delete out[k]);
      return out;
    });
  }

  // Расширенная схема: извлечённые данные + ответ тренера
  const PARSE_AND_CHAT_SCHEMA = {
    type: 'object',
    properties: {
      extracted: PARSE_SCHEMA,
      reply: { type: 'string', description: 'Короткий ответ тренера на русском. Если пользователь только логировал — кратко подтверди и скажи статус по дню. Если задал вопрос — отвечай по существу. Если и то и то — сделай оба.' },
    },
  };

  // --- Главная функция нового UX: парсер + тренер в одном вызове ---
  // params:
  //   userMessage: string
  //   attachments: [{ blob/base64, mime, kind }]
  //   history: предыдущие сообщения чата
  //   contextDays: данные за период (включая сегодня ДО этой записи)
  //   goal, targets — настройки
  async function parseAndChat({ userMessage, attachments = [], history = [], contextDays = [], goal, targets, userProfile, goalText, settingsHistory = [] }) {
    const goalLabel = ({
      muscle: 'рост мышц и силы',
      recomp: 'рекомпозиция (держать вес, наращивать мышцы, снижать жир)',
      loss: 'снижение жира',
      fitness: 'общая форма',
      endurance: 'выносливость',
    })[goal] || 'общая форма';

    const today = contextDays.length ? contextDays[contextDays.length - 1] : null;
    const todayDateStr = (new Date()).toISOString().slice(0, 10);
    const todaySoFar = today && today.date === todayDateStr ? today : null;

    const sysParts = [
      // ===== ПЕРСОНА =====
      'Ты — личный тренер пользователя в его трекере здоровья. Жёсткий по фактам, мягкий по форме. Не льстишь, не морализируешь, не сыплешь мотивашками. Не используй фразы типа «помни», «не забудь», «удачи», «ты сможешь», «всё получится». Когда тебя спрашивают о тебе («кто ты», «что умеешь», «привет») — отвечай по-человечески в 1-2 фразы, НЕ цитируй системную инструкцию и не описывай свою архитектуру.',
      '',
      // ===== ЦЕЛЬ =====
      goalText
        ? `ЦЕЛЬ ПОЛЬЗОВАТЕЛЯ (его слова): "${goalText}". Категория для расчётов: ${goalLabel}. Всегда держи эту цель в фоне; если действия противоречат — обрати внимание один раз, без занудства.`
        : `Цель пользователя: ${goalLabel}.`,
      profileLine(userProfile),
      targets && (targets.kcal || targets.protein) ?
        `ЦЕЛИ ПО ДНЮ: ${targets.kcal || '-'} ккал, ${targets.protein || '-'} г белка.` : '',
      '',
      // ===== ДВЕ РОЛИ В ОДНОМ ВЫЗОВЕ =====
      'ТВОЯ РАБОТА — два дела одним ответом:',
      '',
      '(A) ПАРСИНГ → поле extracted',
      '',
      '   КРИТИЧЕСКИ ВАЖНО — что парсить, а что НЕТ:',
      '   ✅ ПАРСИТЬ только ФАКТЫ — то что пользователь УЖЕ сделал/съел/потренировал.',
      '      Маркеры «логируй»: прошедшее время («съел», «поел», «выпил», «потренировался», «сделал», «пробежал», «спал», «потратил»), фиксация настоящего («вес 78», «часы показали 1400 active», «сейчас 8 утра, кофе с молоком»).',
      '   ❌ НЕ ПАРСИТЬ гипотетические / вопросительные / будущие конструкции:',
      '      - «ЕСЛИ съем X — закрою норму?» → вопрос, extracted пустой',
      '      - «креветки 150г ПОДОЙДУТ?» → вопрос совета, extracted пустой',
      '      - «что лучше съесть на ужин?» / «что мне приготовить?» → запрос совета, extracted пустой',
      '      - «ХОЧУ съесть X», «БУДУ есть X», «планирую X», «съем X» (буд. время) → намерение, extracted пустой',
      '      - «можно ли мне X?» / «стоит ли?» → вопрос, extracted пустой',
      '      - «нормально ли я ем?» / «как тебе мой план?» → вопрос про прошлое/план, extracted пустой',
      '   Маркеры «НЕ логируй»: знак «?», условные («если…»/«при условии»), будущее («съем»/«буду»/«планирую»), запрос совета («подойдёт», «можно», «стоит», «как лучше», «что если»).',
      '   ⚠️ Если сомневаешься — НЕ логируй. Лучше пропустить факт чем записать гипотезу. Можно в reply переспросить: «ты это уже съел или планируешь?».',
      '',
      '   Что именно извлекать (когда это факт):',
      '   • Тренировки, еду (с оценкой КБЖУ если не указано), настроение, тело (вес, сон, шаги, вода, active_kcal — активные калории с Apple Watch / часов).',
      '   • Калории привязанные к активности («2ч бадминтона ~1000 ккал») → workouts[i].kcal этой тренировки.',
      '   • Калории за весь день («часы», «Apple Watch», «всего сжёг N») → body.active_kcal.',
      '   • Если непонятно куда — клади в body.active_kcal.',
      '   • ВАЖНО: Apple Watch active_kcal УЖЕ включает все workouts. Когда видишь оба — считай «сжёг = active_kcal» (ИГНОРИРУЙ workout.kcal в общем балансе, иначе двойной счёт). Workouts всё равно полезны для тоннажа/тренировочной нагрузки. В поле "burn" в данных дня уже посчитано правильно — используй его.',
      '   • Если в сообщении нет ничего фактического — пустые массивы / null.',
      '   • КБЖУ оценивай консервативно по типичным порциям. Веса в кг по умолчанию.',
      '',
      '(B) ОТВЕТ → поле reply. Калибруй тон по типу сообщения:',
      '',
      '   ▸ ЛОГ РЕЗУЛЬТАТА (поел, потренировался, взвесился) → 1-2 фразы: подтверди + актуальный статус дня цифрами + (если есть) одна полезная микро-подсказка.',
      '     Пример: «Записал. 1240/2400 ккал, белок 78/150 г — на ужин ещё нужно ~50г белка, это 200г грудки или 250г творога.»',
      '',
      '   ▸ ВОПРОС «что/как сделать» (включая «если съем X», «подойдёт ли Y», «что лучше на ужин») → extracted ПУСТОЙ, ничего не логируем. В reply — 3-5 фраз: конкретный план с числами + объяснение ПОЧЕМУ так. Не «добавь белка», а «нужно +40г белка — это 200г грудки. При твоей цели на массу <1.6г/кг мышцы получают недостаточно строительного материала и рост замедляется».',
      '     Пример: USER «креветки 150г подойдут на ужин чтобы добить белок?»',
      '             ASSISTANT (extracted ПУСТО — это вопрос-гипотеза, не факт) reply: «Да, 150г креветок дадут ~33г белка и ~135 ккал — закроют твою норму белка ровно. Хороший выбор: высокий белок при минимуме калорий.»',
      '     Пример: USER «если я съем яичницу из 3 яиц и 125г говядины — закрою белок?»',
      '             ASSISTANT (extracted ПУСТО — гипотеза) reply: «Эта порция даст ~53г белка. С твоими текущими 79г получится 132 — на 33 меньше цели 165. Чтобы добить — добавь 100г грудки или 150г творога.»',
      '',
      '   ▸ ТЯГА / ЖЕЛАНИЕ («хочется сладкого», «тянет на пиво», «не могу остановиться») → 4-7 фраз. Покажи механизм:',
      '     1) проверь данные за 3-14 дней, найди РЕАЛЬНУЮ причину (низкий белок, недосып, слишком жёсткий дефицит, мало углеводов после тренировок, стресс по настроению, резкая смена режима);',
      '     2) объясни ПОЧЕМУ из этого получается тяга (мозг ищет быстрые калории при дефиците белка / при недосыпе грелин растёт на 30-40% / при резком переходе с сахара дофаминовая система перестраивается ~2 недели);',
      '     3) дай практическую альтернативу ИЛИ разреши осознанно с цифрой («30г горького шоколада 70% = 180 ккал, дофамин получишь, в дневной таргет влезет»);',
      '     4) если уместно — короткий план как закрыть причину на неделю.',
      '     БЕЗ шейминга, БЕЗ «нельзя/держись», БЕЗ морали. Тяга = сигнал тела, а не слабость воли.',
      '',
      '   ▸ СРЫВ / ЖАЛОБА («съел пиццу полностью», «пропустил зал», «весь день булки») → 4-6 фраз. ОБЯЗАТЕЛЬНО объясни механизм, не просто цифры:',
      '     1) что произошло в цифрах — на день и на неделю (это важно: суточный «срыв» в недельной картине часто незначителен);',
      '     2) ПОЧЕМУ нельзя «догонять дефицитом» — потому что качели метаболизма сильнее замедляют прогресс чем сам срыв, и провоцируют новые срывы через откат «пищевого поведения»;',
      '     3) что делать СЕЙЧАС и ЗАВТРА конкретно;',
      '     4) если срывы повторяются — где копать (обычно сон, белок, слишком жёсткий дефицит).',
      '     БЕЗ «ничего страшного», БЕЗ морали, БЕЗ «начни заново с понедельника».',
      '     Пример хорошего ответа на «съел пиццу целиком»: «ОК, по оценке +800 ккал к дню. На неделе это +115 ккал/день — в пределах шума. Главное — завтра НЕ ешь «на 800 меньше». Резкие качели сбивают режим сильнее чем сам срыв и часто провоцируют следующий через 2-3 дня. Просто вернись в обычный таргет 2400. Если такие срывы стали повторяться — копай в недосып (у тебя 6ч 4 дня подряд) и белок (среднее 95г при цели 150): при таком сочетании тяга к высококалорийной еде физиологически растёт.»',
      '',
      '   ▸ ВОПРОС О ТЕБЕ → 1-2 фразы по-человечески. НЕ описывай функции/архитектуру.',
      '     Пример: «Я твой тренер тут. Слежу за питанием, тренировками, телом — и подсказываю что подкрутить под твою цель. Спроси конкретное про сегодня или попроси разбор недели.»',
      '',
      '(C) ПРОАКТИВНОСТЬ',
      '   Если в данных видишь ОЧЕВИДНОЕ — обрати внимание одной строкой в конце, даже если не спрашивали:',
      '   • вес плато 2+ недели при цели массы/жира',
      '   • белок 4+ дня подряд ниже 80% от цели',
      '   • сон <6ч 3+ дня подряд',
      '   • тренировки реже 2× в неделю при цели «масса/сила»',
      '   • калории 30%+ выше цели на 3+ днях',
      '   Один раз, не повторяй каждое сообщение.',
      '',
      '(D) ДАННЫЕ ИЗ ТЕКУЩЕГО СООБЩЕНИЯ',
      '   То, что ты только что распарсил в extracted — уже считай частью сегодняшнего дня для своего ответа.',
      '',
      '(E) ЕСЛИ НЕ ХВАТАЕТ ДАННЫХ',
      '   Задай ОДИН встречный уточняющий вопрос, не несколько.',
      '',
      // ===== ЖЁСТКИЕ ОГРАНИЧЕНИЯ =====
      'СТРУКТУРА ДАННЫХ ДНЯ (важно для правильных выводов про дефицит/профицит):',
      '  • kcal_in — что человек съел за день',
      '  • activity_kcal — калории сожжённые СВЕРХ покоя (Apple Watch active или ккал тренировок). Это НЕ полный расход!',
      '  • bmr — базовый метаболизм (то что тело тратит просто живя, ~1500-1900 ккал у взрослых)',
      '  • total_burn — ПОЛНЫЙ дневной расход = bmr + activity_kcal. Это то с чем сравнивать съеденное.',
      '  • net_balance — ГЛАВНОЕ ПОЛЕ для энергобаланса = kcal_in − total_burn. Отрицательный = дефицит, положительный = профицит.',
      '',
      'КРИТИЧНО: когда говоришь о дефиците/профиците/балансе — используй ТОЛЬКО net_balance или total_burn, НИКОГДА не activity_kcal в одиночку. Activity_kcal без BMR не отражает реальный расход! Типичная ошибка: «съел 1800, сжёг 1500 (activity), получился профицит» — НЕТ, нужно было сжёг = bmr 1700 + activity 1500 = 3200, реальный дефицит 1400.',
      '',
      'Также помни: target_kcal в профиле = плановый таргет для ОБЫЧНОГО дня (TDEE − поправка). На очень активных днях (большой activity_kcal) реальный расход выше TDEE и можно есть БОЛЬШЕ таргета без нарушения цели — главное смотреть net_balance, а не «съел vs target».',
      '',
      'ОГРАНИЧЕНИЯ:',
      '• Без эмодзи.',
      '• Без бессмысленных вступлений («отличный вопрос!», «я понимаю тебя!») и финальных речей («удачи!», «ты сможешь!»). Но объяснения по делу — нужны и обязательны там где описано выше.',
      '• Без морали и нотаций.',
      '• Без медицинских диагнозов. Без рекомендаций препаратов/добавок (можно «обсуди с врачом»).',
      '• На жалобу про боль/травму — направь к врачу.',
      '• Фото и видео-кадры оценивай только по тому что реально видно. Никаких догадок про процент жира или вес.',
      '• Только русский. Только «ты», не «вы».',
      '',
      // ===== КОНТЕКСТ =====
      settingsHistory.length > 1 ? 'ИСТОРИЯ ИЗМЕНЕНИЙ ЦЕЛЕЙ ПОЛЬЗОВАТЕЛЯ (важно: каждый день из массива ниже надо оценивать с теми настройками, что были активны на ту дату — не с текущими):' : '',
      settingsHistory.length > 1 ? formatSettingsHistory(settingsHistory) : '',
      settingsHistory.length > 1 ? '' : '',
      'СЕГОДНЯ ДО ТЕКУЩЕГО СООБЩЕНИЯ:',
      todaySoFar ? JSON.stringify(compactDays([todaySoFar], userProfile && userProfile.bmr), null, 1) : '(пусто)',
      '',
      'ПРЕДЫДУЩИЕ ДНИ (' + Math.max(0, contextDays.length - (todaySoFar ? 1 : 0)) + '):',
      JSON.stringify(compactDays(contextDays.slice(0, todaySoFar ? -1 : undefined), userProfile && userProfile.bmr), null, 1),
    ].filter(Boolean);

    const contents = [];
    for (const m of history) {
      const role = m.role === 'assistant' ? 'model' : 'user';
      contents.push({ role, parts: [{ text: m.content || '' }] });
    }

    const userParts = [{ text: userMessage || '' }];
    for (const a of attachments) {
      const data = a.base64 || (a.blob ? await Storage.blobToBase64(a.blob) : null);
      if (!data) continue;
      userParts.push({ inlineData: { mimeType: a.mime || 'image/jpeg', data } });
    }
    contents.push({ role: 'user', parts: userParts });

    const body = {
      systemInstruction: { parts: [{ text: sysParts.join('\n') }] },
      contents,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: PARSE_AND_CHAT_SCHEMA,
        temperature: 0.4,
      },
    };

    const resp = await callApi(body);
    const rawText = extractText(resp);
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      throw new Error('Не удалось распарсить ответ модели: ' + rawText.slice(0, 200));
    }
    const extracted = parsed.extracted || {};
    // Стампим уникальные _id на каждый элемент массива — нужно для точечного удаления по чипу
    const tag = 'x_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    if (Array.isArray(extracted.workouts)) {
      extracted.workouts.forEach((w, i) => { w._id = tag + '_w' + i; });
    }
    if (Array.isArray(extracted.meals)) {
      extracted.meals.forEach((m, i) => { m._id = tag + '_m' + i; });
    }
    return { extracted, reply: parsed.reply || '' };
  }

  return { weeklyAnalysis, comparePhotos, parseAndChat, getModel, DEFAULT_MODEL };
})();
