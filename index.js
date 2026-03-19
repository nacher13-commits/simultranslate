/**
 * SimulTranslate — Servidor
 * Usa Socket.io con transporte HTTP polling además de WebSocket,
 * lo que evita el límite de 5 minutos de WebSocket en Render free tier.
 * Socket.io cambia automáticamente a polling cuando el WebSocket se corta.
 */
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // Permitir polling Y websocket — si el WS se corta, cae a polling
  transports: ['polling', 'websocket'],
  // Ping frecuente para mantener la conexión viva en Render
  pingInterval: 10000,
  pingTimeout:  25000,
});

app.use(express.json());
app.get('/', (_, res) => res.send('SimulTranslate OK ✓'));
app.get('/health', (_, res) => res.json({ ok: true, sessions: sessions.size }));

// ── Sesiones ─────────────────────────────────────────────────────────
const sessions  = new Map(); // sessionId → { roomCode, presenterId, listeners, createdAt }
const codeIndex = new Map(); // roomCode  → sessionId
const cache     = new Map(); // 'lang|texto' → traducción

// ── Traducción con MyMemory ───────────────────────────────────────────
async function translate(text, lang) {
  if (!text?.trim() || lang === 'es') return text;
  const k = `${lang}|${text}`;
  if (cache.has(k)) return cache.get(k);
  try {
    const params = new URLSearchParams({ q: text, langpair: `es|${lang}` });
    const r = await fetch(`https://api.mymemory.translated.net/get?${params}`,
      { signal: AbortSignal.timeout(7000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (d.responseStatus !== 200) throw new Error(d.responseDetails);
    const t = d.responseData?.translatedText;
    if (!t || t.toLowerCase().trim() === text.toLowerCase().trim()) throw new Error('sin traducción');
    if (cache.size > 800) cache.delete(cache.keys().next().value);
    cache.set(k, t);
    return t;
  } catch (e) {
    console.warn(`[Translate] ${lang}: ${e.message}`);
    return text;
  }
}

// ── Socket.io ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // Ponente: crear sesión
  socket.on('presenter:create', (_, cb) => {
    let code;
    do { code = Math.random().toString(36).substring(2, 8).toUpperCase(); }
    while (codeIndex.has(code));
    const id = uuidv4();
    sessions.set(id, { id, code, presenterId: socket.id, listeners: new Map(), createdAt: Date.now() });
    codeIndex.set(code, id);
    socket.join(id);
    socket.data = { id, role: 'presenter' };
    console.log(`[Sesión] Creada: ${code}`);
    cb?.({ sessionId: id, roomCode: code });
  });

  // Ponente: texto reconocido
  socket.on('presenter:transcript', async ({ text, isFinal }) => {
    const sess = sessions.get(socket.data?.id);
    if (!sess || sess.presenterId !== socket.id || !text?.trim()) return;

    if (!isFinal) {
      // Parcial: reenviar sin traducir (rápido)
      io.to(sess.id).emit('transcript:partial', { original: text });
      return;
    }

    // Final: traducir a todos los idiomas activos en paralelo
    const langSet = new Set([...sess.listeners.values()].map(l => l.language));
    if (!langSet.size) {
      io.to(sess.presenterId).emit('transcript:confirmed', {});
      return;
    }

    const pairs = await Promise.all([...langSet].map(async l => [l, await translate(text, l)]));
    const tr = Object.fromEntries(pairs);

    sess.listeners.forEach(({ language }, lid) => {
      io.to(lid).emit('transcript:final', {
        original:   text,
        translated: tr[language] ?? text,
        language,
      });
    });
    io.to(sess.presenterId).emit('transcript:confirmed', {});
    console.log(`[${sess.code}] Traducido a: ${[...langSet].join(', ')} — "${text.substring(0, 40)}"`);
  });

  // Ponente: terminar sesión
  socket.on('presenter:end', () => {
    const sess = sessions.get(socket.data?.id);
    if (!sess) return;
    io.to(sess.id).emit('session:ended');
    codeIndex.delete(sess.code);
    sessions.delete(sess.id);
    console.log(`[Sesión] Terminada: ${sess.code}`);
  });

  // Oyente: unirse
  socket.on('listener:join', ({ roomCode, language }, cb) => {
    const id   = codeIndex.get(roomCode?.toUpperCase());
    const sess = id ? sessions.get(id) : null;
    if (!sess) return cb?.({ error: 'Sala no encontrada. Comprueba el código.' });
    sess.listeners.set(socket.id, { language: language || 'en' });
    socket.join(sess.id);
    socket.data = { id: sess.id, role: 'listener' };
    io.to(sess.presenterId).emit('session:listenerJoined', { count: sess.listeners.size, language });
    console.log(`[${sess.code}] Oyente conectado: ${language}`);
    cb?.({ success: true });
  });

  // Oyente: cambiar idioma
  socket.on('listener:changeLanguage', ({ language }) => {
    const sess = sessions.get(socket.data?.id);
    const l    = sess?.listeners.get(socket.id);
    if (l) l.language = language;
  });

  // Desconexión
  socket.on('disconnect', () => {
    const { id, role } = socket.data || {};
    if (!id) return;
    const sess = sessions.get(id);
    if (!sess) return;
    if (role === 'presenter') {
      io.to(id).emit('session:ended');
      codeIndex.delete(sess.code);
      sessions.delete(id);
    } else {
      sess.listeners.delete(socket.id);
      io.to(sess.presenterId).emit('session:listenerLeft', { count: sess.listeners.size });
    }
  });
});

// Limpiar sesiones >4h
setInterval(() => {
  const cutoff = Date.now() - 4 * 3600000;
  sessions.forEach((s, id) => {
    if (s.createdAt < cutoff) { io.to(id).emit('session:ended'); codeIndex.delete(s.code); sessions.delete(id); }
  });
}, 15 * 60000);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`✅ SimulTranslate servidor en puerto ${PORT}`));
