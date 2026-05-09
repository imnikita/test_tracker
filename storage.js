// storage.js — IndexedDB-обёртка для логов, фото и чата
// Структура:
//   days  — keyPath: "date" (YYYY-MM-DD), { date, workouts[], meals[], mood, body, rawEntries[], photoIds[] }
//   photos — keyPath: "id", { id, date, blob, mime, observations, comparedTo }
//   meta  — keyPath: "key", { key, value }  // settings, apiKey, goal и т.д.
//   chat_messages — keyPath: "id", { id, role, content, attachments[], ts }

const Storage = (() => {
  const DB_NAME = 'tracker-db';
  const DB_VERSION = 3;
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (!db.objectStoreNames.contains('days')) {
          db.createObjectStore('days', { keyPath: 'date' });
        }
        if (!db.objectStoreNames.contains('photos')) {
          const ps = db.createObjectStore('photos', { keyPath: 'id' });
          ps.createIndex('byDate', 'date');
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('chat_messages')) {
          const cs = db.createObjectStore('chat_messages', { keyPath: 'id' });
          cs.createIndex('byTs', 'ts');
        }
        // v3: snapshots настроек по датам (для честного исторического анализа)
        if (!db.objectStoreNames.contains('settings_snapshots')) {
          const ss = db.createObjectStore('settings_snapshots', { keyPath: 'id', autoIncrement: true });
          ss.createIndex('byDate', 'date');
          ss.createIndex('byTs', 'ts');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(storeName, mode = 'readonly') {
    const db = await openDb();
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  function reqAsPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // --- DAYS ---
  async function getDay(date) {
    const store = await tx('days');
    return await reqAsPromise(store.get(date)) || null;
  }

  async function putDay(day) {
    const store = await tx('days', 'readwrite');
    return reqAsPromise(store.put(day));
  }

  async function getAllDays() {
    const store = await tx('days');
    return reqAsPromise(store.getAll());
  }

  async function getDaysRange(fromDate, toDate) {
    const all = await getAllDays();
    return all
      .filter(d => d.date >= fromDate && d.date <= toDate)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  // Слияние: новые workouts/meals добавляются к существующим за день,
  // mood/body перезаписываются (последняя запись побеждает),
  // rawEntries добавляются в массив.
  async function mergeIntoDay(date, parsed, rawText) {
    const existing = (await getDay(date)) || { date };
    // Гарантируем наличие всех полей — старые дни из v1 могли не иметь photoIds/rawEntries
    existing.workouts = existing.workouts || [];
    existing.meals = existing.meals || [];
    existing.mood = existing.mood || null;
    existing.body = existing.body || null;
    existing.rawEntries = existing.rawEntries || [];
    existing.photoIds = existing.photoIds || [];
    if (parsed.workouts && parsed.workouts.length) {
      existing.workouts = existing.workouts.concat(parsed.workouts);
    }
    if (parsed.meals && parsed.meals.length) {
      existing.meals = existing.meals.concat(parsed.meals);
    }
    if (parsed.mood && (parsed.mood.score != null || parsed.mood.notes)) {
      existing.mood = parsed.mood;
    }
    if (parsed.body) {
      // КРИТИЧНО: фильтруем null/undefined перед merge, иначе ИИ вернувший
      // body: {water_ml: 2000, weight_kg: null} (потому что про вес ничего не было)
      // затрёт ранее записанный утром weight_kg. Берём только реально заполненные поля.
      const cleanBody = {};
      for (const k of Object.keys(parsed.body)) {
        const v = parsed.body[k];
        if (v != null && v !== '' && !(typeof v === 'number' && isNaN(v))) {
          cleanBody[k] = v;
        }
      }
      if (Object.keys(cleanBody).length) {
        existing.body = { ...(existing.body || {}), ...cleanBody };
      }
    }
    if (rawText) {
      existing.rawEntries.push({ time: new Date().toISOString(), text: rawText });
    }
    await putDay(existing);
    return existing;
  }

  // Удалить элемент из дня (workouts/meals по индексу) или сбросить mood/body
  async function removeFromDay(date, kind, index) {
    const existing = await getDay(date);
    if (!existing) return;
    if ((kind === 'workouts' || kind === 'meals') && Array.isArray(existing[kind])) {
      existing[kind].splice(index, 1);
    } else if (kind === 'mood') {
      existing.mood = null;
    } else if (kind === 'body') {
      existing.body = null;
    }
    await putDay(existing);
    return existing;
  }

  // Точечное обновление поля внутри meal/workout
  async function updateInDay(date, kind, index, patch) {
    const existing = await getDay(date);
    if (!existing) return;
    if ((kind === 'workouts' || kind === 'meals') && existing[kind] && existing[kind][index]) {
      existing[kind][index] = { ...existing[kind][index], ...patch };
    } else if (kind === 'mood') {
      existing.mood = { ...(existing.mood || {}), ...patch };
    } else if (kind === 'body') {
      existing.body = { ...(existing.body || {}), ...patch };
    }
    await putDay(existing);
    return existing;
  }

  async function attachPhotoToDay(date, photoId) {
    const existing = (await getDay(date)) || { date, workouts: [], meals: [], mood: null, body: null, rawEntries: [], photoIds: [] };
    existing.photoIds = existing.photoIds || [];
    if (!existing.photoIds.includes(photoId)) existing.photoIds.push(photoId);
    await putDay(existing);
  }

  async function deleteDay(date) {
    const store = await tx('days', 'readwrite');
    return reqAsPromise(store.delete(date));
  }

  // --- PHOTOS ---
  async function savePhoto(blob, date) {
    const id = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const rec = { id, date, blob, mime: blob.type, observations: '', comparedTo: null, ts: Date.now() };
    const store = await tx('photos', 'readwrite');
    await reqAsPromise(store.put(rec));
    await attachPhotoToDay(date, id);
    return rec;
  }

  async function getPhoto(id) {
    const store = await tx('photos');
    return reqAsPromise(store.get(id));
  }

  async function getAllPhotos() {
    const store = await tx('photos');
    const all = await reqAsPromise(store.getAll());
    return all.sort((a, b) => a.ts - b.ts);
  }

  async function updatePhoto(id, patch) {
    const store = await tx('photos', 'readwrite');
    const existing = await reqAsPromise(store.get(id));
    if (!existing) return null;
    Object.assign(existing, patch);
    await reqAsPromise(store.put(existing));
    return existing;
  }

  // --- CHAT MESSAGES ---
  async function saveChatMessage({ role, content, attachments = [], extracted = null }) {
    const id = 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    // Если в attachments есть Blob'ы — сериализуем в base64 для хранения
    const attsOut = [];
    for (const a of attachments) {
      if (a && a.blob instanceof Blob) {
        attsOut.push({
          mime: a.mime || a.blob.type,
          data: await blobToBase64(a.blob),
          kind: a.kind || 'image',
        });
      } else {
        attsOut.push(a);
      }
    }
    const rec = { id, role, content, attachments: attsOut, extracted, ts: Date.now() };
    const store = await tx('chat_messages', 'readwrite');
    await reqAsPromise(store.put(rec));
    return rec;
  }

  async function getChatMessages(limit = 200) {
    const store = await tx('chat_messages');
    const all = await reqAsPromise(store.getAll());
    return all.sort((a, b) => a.ts - b.ts).slice(-limit);
  }

  async function updateChatExtracted(id, extracted) {
    const store = await tx('chat_messages', 'readwrite');
    const existing = await reqAsPromise(store.get(id));
    if (!existing) return null;
    existing.extracted = extracted;
    await reqAsPromise(store.put(existing));
    return existing;
  }

  async function deleteChatMessage(id) {
    const store = await tx('chat_messages', 'readwrite');
    return reqAsPromise(store.delete(id));
  }

  async function clearChat() {
    const store = await tx('chat_messages', 'readwrite');
    return reqAsPromise(store.clear());
  }

  // --- SETTINGS SNAPSHOTS ---
  // Snapshot = срез настроек (цель, targets, профиль) на конкретную дату.
  // Нужен для честного ретроспективного анализа: если 2 недели назад была цель
  // «похудение» с targetKcal 1500, а сейчас «масса» с 2200 — старые дни должны
  // сравниваться со СТАРЫМ targetKcal, не текущим.
  async function saveSettingsSnapshot(snapshot) {
    const store = await tx('settings_snapshots', 'readwrite');
    const rec = {
      ts: Date.now(),
      date: snapshot.date || todayDate(),
      goal: snapshot.goal || null,
      goalText: snapshot.goalText || '',
      targetKcal: snapshot.targetKcal || 0,
      targetProtein: snapshot.targetProtein || 0,
      profile: snapshot.profile || null,
    };
    return reqAsPromise(store.put(rec));
  }

  async function getAllSettingsSnapshots() {
    const store = await tx('settings_snapshots');
    const all = await reqAsPromise(store.getAll());
    return all.sort((a, b) => a.ts - b.ts);
  }

  // Возвращает snapshot настроек, актуальный на конкретную дату (YYYY-MM-DD).
  // Берёт последний snapshot чья date <= указанной. Если такого нет — null.
  async function getSettingsAt(dateStr) {
    const all = await getAllSettingsSnapshots();
    let best = null;
    for (const s of all) {
      if (s.date <= dateStr) best = s;
      else break;
    }
    return best;
  }

  // --- META (настройки) ---
  async function getMeta(key, fallback = null) {
    const store = await tx('meta');
    const rec = await reqAsPromise(store.get(key));
    return rec ? rec.value : fallback;
  }

  async function setMeta(key, value) {
    const store = await tx('meta', 'readwrite');
    return reqAsPromise(store.put({ key, value }));
  }

  // --- BACKUP ---
  async function exportAll() {
    const days = await getAllDays();
    const photos = await getAllPhotos();
    // Фото переводим в base64 для удобной выгрузки в JSON
    const photosOut = await Promise.all(photos.map(async p => ({
      id: p.id,
      date: p.date,
      mime: p.mime,
      observations: p.observations,
      comparedTo: p.comparedTo,
      ts: p.ts,
      data: await blobToBase64(p.blob),
    })));
    const metaStore = await tx('meta');
    const metaAll = await reqAsPromise(metaStore.getAll());
    const meta = {};
    metaAll.forEach(r => { if (r.key !== 'apiKey') meta[r.key] = r.value; }); // ключ не выгружаем
    const chatMessages = await getChatMessages(10000);
    const settingsSnapshots = await getAllSettingsSnapshots();
    return {
      version: 3,
      exportedAt: new Date().toISOString(),
      days,
      photos: photosOut,
      meta,
      chat_messages: chatMessages,
      settings_snapshots: settingsSnapshots,
    };
  }

  async function importAll(data) {
    if (!data || ![1, 2, 3].includes(data.version)) {
      throw new Error('Несовместимый формат бэкапа');
    }
    const dayStore = await tx('days', 'readwrite');
    for (const d of (data.days || [])) {
      await reqAsPromise(dayStore.put(d));
    }
    const photoStore = await tx('photos', 'readwrite');
    for (const p of (data.photos || [])) {
      const blob = await base64ToBlob(p.data, p.mime);
      await reqAsPromise(photoStore.put({
        id: p.id, date: p.date, blob, mime: p.mime,
        observations: p.observations, comparedTo: p.comparedTo, ts: p.ts,
      }));
    }
    const metaStore = await tx('meta', 'readwrite');
    for (const [k, v] of Object.entries(data.meta || {})) {
      await reqAsPromise(metaStore.put({ key: k, value: v }));
    }
    if (Array.isArray(data.chat_messages) && data.chat_messages.length) {
      const chatStore = await tx('chat_messages', 'readwrite');
      for (const m of data.chat_messages) {
        await reqAsPromise(chatStore.put(m));
      }
    }
    if (Array.isArray(data.settings_snapshots) && data.settings_snapshots.length) {
      const ss = await tx('settings_snapshots', 'readwrite');
      for (const s of data.settings_snapshots) {
        await reqAsPromise(ss.put(s));
      }
    }
  }

  async function wipe() {
    const db = await openDb();
    db.close();
    dbPromise = null;
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  }

  // --- helpers ---
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result.split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }
  async function base64ToBlob(b64, mime) {
    const res = await fetch(`data:${mime};base64,${b64}`);
    return res.blob();
  }

  function todayDate() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  return {
    getDay, putDay, getAllDays, getDaysRange, mergeIntoDay, deleteDay,
    removeFromDay, updateInDay,
    savePhoto, getPhoto, getAllPhotos, updatePhoto,
    saveChatMessage, getChatMessages, clearChat, updateChatExtracted, deleteChatMessage,
    getMeta, setMeta,
    saveSettingsSnapshot, getAllSettingsSnapshots, getSettingsAt,
    exportAll, importAll, wipe,
    todayDate, blobToBase64,
  };
})();
