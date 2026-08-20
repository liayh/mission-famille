/* ==========================================================================
   Mission Famille — logique de l'application
   Stockage: localStorage par défaut (100% local, aucune donnée envoyée).
   Synchronisation cloud optionnelle (Firebase) : activable dans Réglages →
   Sécurité, protège l'accès par un code famille à usage unique, voir la
   section "synchronisation cloud" plus bas.
   Le code PIN parent est haché en SHA-256 avant stockage.
   ========================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";

const STORAGE_KEY = 'missionFamilleData_v1';
const SESSION_KEY = 'missionFamilleAdminUnlocked';

const EMOJIS = ['👦','👧','🧒','👶','🐱','🐶','🦁','🐻','🦊','🐼','🐵','🐸','🦄','🐧','🐢','🦖'];
const REWARD_ICONS = ['📺','🎮','🎬','🍽️','🍦','🎳','🚲','🏊','🎨','⚽'];
const WEEKDAYS_SHORT = ['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'];
const THEMES = {
  clair: { label: 'Clair', icon: '☀️' },
  ocean: { label: 'Océan', icon: '🌊' },
  corail: { label: 'Corail', icon: '🌺' },
};

const LOGIC_GAMES = [
  {
    id: 'series', title: 'Les suites malignes', icon: '🔢', description: 'Trouve le nombre qui vient ensuite.',
    questions: Array.from({ length: 10 }, (_, index) => {
      const start = index + 2;
      const step = (index % 3) + 2;
      const answer = start + step * 3;
      return { text: `${start}, ${start + step}, ${start + step * 2}, ?`, answer: String(answer), options: [String(answer), String(answer - 1), String(answer + 2)] };
    }),
  },
  {
    id: 'calcul', title: 'Calcul express', icon: '🧮', description: 'Résous de petits calculs de tête.',
    questions: Array.from({ length: 10 }, (_, index) => {
      const a = index + 4;
      const b = (index % 4) + 2;
      const answer = a * b;
      return { text: `${a} × ${b} = ?`, answer: String(answer), options: [String(answer), String(answer + b), String(answer - a)] };
    }),
  },
  {
    id: 'intrus', title: 'Trouve l’intrus', icon: '🕵️', description: 'Repère le nombre qui ne suit pas la règle.',
    questions: Array.from({ length: 10 }, (_, index) => {
      const answer = index + 3;
      const values = [answer * 2, answer * 4, answer * 6, answer * 6 + 1];
      return { text: `Quel nombre est différent : ${values.join(' - ')} ?`, answer: String(values[3]), options: [String(values[3]), String(values[0]), String(values[1])] };
    }),
  },
  {
    id: 'mots', title: 'Mots et catégories', icon: '🧩', description: 'Choisis le mot qui appartient à la catégorie.',
    questions: [
      ['Quel mot est un fruit ?', 'pomme', ['pomme', 'chaise', 'stylo']], ['Quel mot est un animal ?', 'lapin', ['lapin', 'nuage', 'fourchette']],
      ['Quel mot est une couleur ?', 'vert', ['vert', 'table', 'vélo']], ['Quel mot sert à écrire ?', 'crayon', ['crayon', 'ballon', 'pomme']],
      ['Quel mot est un moyen de transport ?', 'train', ['train', 'gâteau', 'oreiller']], ['Quel mot se mange ?', 'banane', ['banane', 'cahier', 'lampe']],
      ['Quel mot est un vêtement ?', 'pull', ['pull', 'fourchette', 'jardin']], ['Quel mot est dans la nature ?', 'rivière', ['rivière', 'téléphone', 'chaussure']],
      ['Quel mot est une forme ?', 'triangle', ['triangle', 'orange', 'bouteille']], ['Quel mot indique une saison ?', 'hiver', ['hiver', 'mouton', 'cartable']],
    ].map(([text, answer, options]) => ({ text, answer, options })),
  },
  {
    id: 'enigmes', title: 'Petites énigmes', icon: '💡', description: 'Réfléchis bien avant de répondre.',
    questions: [
      ['J’ai 4 pattes mais je ne marche pas. Qui suis-je ?', 'table', ['table', 'chat', 'oiseau']], ['Je brille dans le ciel la nuit. Qui suis-je ?', 'lune', ['lune', 'chaise', 'pluie']],
      ['Je grandis quand on me nourrit et je meurs avec de l’eau. Qui suis-je ?', 'feu', ['feu', 'arbre', 'poisson']], ['J’ai des pages mais je ne suis pas un arbre. Qui suis-je ?', 'livre', ['livre', 'nuage', 'vélo']],
      ['Je tombe sans me faire mal et je mouille. Qui suis-je ?', 'pluie', ['pluie', 'pierre', 'soleil']], ['Je donne l’heure sans parler. Qui suis-je ?', 'horloge', ['horloge', 'fourchette', 'ballon']],
      ['Plus je sèche, plus je deviens mouillé. Qui suis-je ?', 'serviette', ['serviette', 'parapluie', 'sable']], ['J’ai des dents mais je ne mords pas. Qui suis-je ?', 'peigne', ['peigne', 'lion', 'nuage']],
      ['Je suis rond et je roule. Qui suis-je ?', 'ballon', ['ballon', 'livre', 'pantalon']], ['J’ai un cou mais pas de tête. Qui suis-je ?', 'bouteille', ['bouteille', 'poule', 'table']],
    ].map(([text, answer, options]) => ({ text, answer, options })),
  },
];

let state = null;          // data loaded from localStorage
let activeChildId = null;  // currently selected child tab
let failedPinAttempts = 0;
let pinLockUntil = 0;
let calendarMonth = monthKey();
let backupReminderDismissed = false; // rappel de sauvegarde masqué pour cette session

/* ---------------------------- utilitaires ---------------------------- */

function uid(prefix){ return prefix + '_' + Math.random().toString(36).slice(2, 9); }

function todayStr(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function monthKey(date = new Date()){
  return date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0');
}

function dateForMonth(month, day){
  return month + '-' + String(day).padStart(2,'0');
}

function monthLabel(month){
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(year, monthNumber - 1, 1).toLocaleDateString('fr-FR', { month:'long', year:'numeric' });
}

function monthlyTaskStats(childId, month = monthKey()){
  const [year, monthNumber] = month.split('-').map(Number);
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const isCurrentMonth = month === monthKey();
  const lastDay = isCurrentMonth ? new Date().getDate() : daysInMonth;
  let required = 0;
  let completed = 0;

  for (let day = 1; day <= lastDay; day++){
    const date = new Date(year, monthNumber - 1, day);
    state.tasks.forEach(task => {
      if (task.schoolDaysOnly && !isSchoolDay(date)) return;
      required++;
      const dayCompletions = state.completions[dateForMonth(month, day)]?.[childId] || [];
      if (dayCompletions.includes(task.id)) completed++;
    });
  }
  return { required, completed, complete: !isCurrentMonth && required > 0 && completed === required };
}

function hasMonthlyRedemption(childId, month){
  return state.redemptions.some(r => r.kind === 'monthly' && r.childId === childId && r.month === month);
}

/* Total d'argent (en euros) gagné par un enfant via les récompenses mensuelles validées. */
function totalEuros(childId){
  return state.redemptions
    .filter(r => r.kind === 'monthly' && r.childId === childId)
    .reduce((sum, r) => sum + (r.amount || 0), 0);
}

/* Série des points gagnés par semaine (la plus récente en dernier), pour le graphique de stats. */
function weeklyPointsSeries(childId, weeks = 8){
  const buckets = new Array(weeks).fill(0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  Object.entries(state.completions).forEach(([dateStr, byChild]) => {
    const doneIds = byChild[childId];
    if (!doneIds || !doneIds.length) return;
    const daysAgo = Math.round((today - new Date(dateStr + 'T00:00:00')) / 86400000);
    if (daysAgo < 0 || daysAgo >= weeks * 7) return;
    const points = doneIds.reduce((sum, taskId) => {
      const task = state.tasks.find(t => t.id === taskId);
      return sum + (task ? task.points : 0);
    }, 0);
    buckets[weeks - 1 - Math.floor(daysAgo / 7)] += points;
  });
  return buckets;
}

/* Nombre de jours consécutifs (jusqu'à hier ou aujourd'hui) où toutes les missions du jour ont été faites. */
function computeStreak(childId){
  let streak = 0;
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  for (let i = 0; i < 365; i++){
    const dateStr = cursor.getFullYear() + '-' + String(cursor.getMonth()+1).padStart(2,'0') + '-' + String(cursor.getDate()).padStart(2,'0');
    const dayTasks = state.tasks.filter(t => !t.schoolDaysOnly || isSchoolDay(cursor));
    if (dayTasks.length > 0){
      const completed = state.completions[dateStr]?.[childId] || [];
      const allDone = dayTasks.every(t => completed.includes(t.id));
      if (!allDone){
        if (dateStr === todayStr()) { cursor.setDate(cursor.getDate() - 1); continue; }
        break;
      }
      streak++;
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function isSchoolDay(date = new Date()){
  const day = date.getDay(); // 0 = dimanche, 6 = samedi
  return day >= 1 && day <= 5;
}

function formatDateLong(d = new Date()){
  return d.toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long' });
}

async function sha256(text){
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

async function enableNotifications(){
  if (!('Notification' in window)){
    showToast('Notifications non supportées par ce navigateur', '⚠️');
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission === 'granted'){
    state.notificationsEnabled = true;
    saveData();
    showToast('Notifications activées', '🔔');
  } else {
    showToast('Permission refusée par le navigateur', '⚠️');
  }
  renderSettingsContent();
}

function disableNotifications(){
  state.notificationsEnabled = false;
  saveData();
  renderSettingsContent();
}

function notifyParent(title, body){
  if (!state.notificationsEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(title, { body }); } catch (e) { /* navigateur sans support fiable, on ignore */ }
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function shuffled(items){
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--){
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[randomIndex]] = [result[randomIndex], result[index]];
  }
  return result;
}

function showToast(msg, icon = '✅', action){
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span>${escapeHtml(icon)}</span><span>${escapeHtml(msg)}</span>${action ? `<button class="toast-undo" id="toast-undo-btn">${escapeHtml(action.label)}</button>` : ''}`;
  document.body.appendChild(t);
  const timer = setTimeout(() => t.remove(), action ? 6000 : 2400);
  if (action){
    document.getElementById('toast-undo-btn').onclick = () => {
      clearTimeout(timer);
      t.remove();
      action.onClick();
    };
  }
}

/* Exécute une action puis propose de l'annuler via un bouton dans le toast,
   en restaurant un instantané complet de l'état si le parent clique "Annuler". */
function withUndo(actionFn, message, icon = '✅'){
  const snapshot = JSON.stringify(state);
  actionFn();
  showToast(message, icon, {
    label: 'Annuler',
    onClick: () => {
      state = JSON.parse(snapshot);
      saveData();
      render();
      if (document.getElementById('settings-content')) renderSettingsContent();
      showToast('Action annulée', '↩️');
    }
  });
}

/* ---------------------------- synchronisation cloud (optionnelle) ---------------------------- */

// La clé apiKey Firebase n'est pas un secret à cacher : elle identifie seulement le projet.
// L'accès aux données de chaque famille est protégé par le code famille (voir règles Firestore)
// et par les règles de sécurité côté serveur, pas par cette clé.
const firebaseConfig = {
  apiKey: "AIzaSyB_RGvwCZA10XiHONeSwwvh7UikPUOUurU",
  authDomain: "mission-famille.firebaseapp.com",
  projectId: "mission-famille",
  storageBucket: "mission-famille.firebasestorage.app",
  messagingSenderId: "1024156538990",
  appId: "1:1024156538990:web:611026df02fa1325bf2e7f",
};
const FAMILY_CODE_KEY = 'missionFamilleFamilyCode';
const FAMILY_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O/1/I/l (ambigus)

let firebaseApp = null;
let firestoreDb = null;
let familyDocRef = null;
let familyUnsubscribe = null;

function getFamilyCode(){
  return localStorage.getItem(FAMILY_CODE_KEY);
}

function generateFamilyCode(){
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => FAMILY_CODE_CHARSET[b % FAMILY_CODE_CHARSET.length]).join('');
}

function getFirestoreDb(){
  if (!firebaseApp){
    firebaseApp = initializeApp(firebaseConfig);
    firestoreDb = getFirestore(firebaseApp);
  }
  return firestoreDb;
}

function ensureSignedIn(){
  const auth = getAuth(firebaseApp || initializeApp(firebaseConfig));
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  return signInAnonymously(auth).then(() => new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(auth, user => {
      if (user){ unsub(); resolve(user); }
    }, reject);
  }));
}

function subscribeToFamily(code){
  const db = getFirestoreDb();
  familyDocRef = doc(db, 'families', code);
  if (familyUnsubscribe) familyUnsubscribe();
  familyUnsubscribe = onSnapshot(familyDocRef, (snapshot) => {
    if (!snapshot.exists()) return;
    state = Object.assign(defaultData(), snapshot.data());
    applyTheme();
    if (!activeChildId || !getChild(activeChildId)) activeChildId = state.children[0]?.id || null;
    render();
  }, (error) => {
    console.error('Erreur de synchronisation', error);
    showToast('Connexion au cloud impossible, données locales utilisées', '⚠️');
  });
}

/* Active la synchronisation depuis cet appareil : génère un code famille et publie
   les données locales actuelles comme point de départ partagé. */
async function createFamily(){
  try {
    await ensureSignedIn();
    const code = generateFamilyCode();
    const db = getFirestoreDb();
    const ref = doc(db, 'families', code);
    await setDoc(ref, state);
    localStorage.setItem(FAMILY_CODE_KEY, code);
    subscribeToFamily(code);
    return code;
  } catch (err){
    console.error(err);
    return null;
  }
}

/* Rejoint une famille existante à partir d'un code donné par un parent. */
async function joinFamily(code){
  try {
    await ensureSignedIn();
    const db = getFirestoreDb();
    const ref = doc(db, 'families', code);
    const snap = await getDoc(ref);
    if (!snap.exists()) return false;
    localStorage.setItem(FAMILY_CODE_KEY, code);
    subscribeToFamily(code);
    return true;
  } catch (err){
    console.error(err);
    return false;
  }
}

function leaveFamilySync(){
  if (familyUnsubscribe) familyUnsubscribe();
  familyUnsubscribe = null;
  familyDocRef = null;
  localStorage.removeItem(FAMILY_CODE_KEY);
}

/* ---------------------------- stockage ---------------------------- */

function defaultData(){
  return {
    version: 1,
    theme: 'clair',
    pinHash: null,
    notificationsEnabled: false,
    lastExportAt: null,
    children: [],
    tasks: [
      { id: uid('t'), label: 'Ranger sa chambre', type: 'menage', points: 5, schoolDaysOnly: false },
      { id: uid('t'), label: 'Faire son lit', type: 'menage', points: 3, schoolDaysOnly: false },
      { id: uid('t'), label: 'Ranger ses affaires', type: 'menage', points: 4, schoolDaysOnly: false },
      { id: uid('t'), label: 'Mettre la table', type: 'menage', points: 3, schoolDaysOnly: false },
      { id: uid('t'), label: 'Débarrasser / vaisselle', type: 'menage', points: 4, schoolDaysOnly: false },
      { id: uid('t'), label: 'Mettre ou débarrasser la table', type: 'menage', points: 4, schoolDaysOnly: false },
      { id: uid('t'), label: 'Vider le lave-vaisselle', type: 'menage', points: 3, schoolDaysOnly: false },
      { id: uid('t'), label: 'Remplir le lave-vaisselle', type: 'menage', points: 3, schoolDaysOnly: false },
      { id: uid('t'), label: 'Sortir les poubelles', type: 'menage', points: 3, schoolDaysOnly: false },
      { id: uid('t'), label: 'Aider ses parents', type: 'menage', points: 5, schoolDaysOnly: false },
      { id: uid('t'), label: 'Aider à préparer le repas', type: 'menage', points: 5, schoolDaysOnly: false },
      { id: uid('t'), label: 'Nourrir l’animal', type: 'menage', points: 3, schoolDaysOnly: false },
      { id: uid('t'), label: 'Arroser les plantes', type: 'menage', points: 2, schoolDaysOnly: false },
      { id: uid('t'), label: 'Faire les devoirs', type: 'devoir', points: 8, schoolDaysOnly: true },
      { id: uid('t'), label: 'Lire 15 minutes', type: 'devoir', points: 4, schoolDaysOnly: false },
      { id: uid('t'), label: 'Lire 30 minutes', type: 'devoir', points: 8, schoolDaysOnly: false },
    ],
    rewards: [
      { id: uid('r'), label: 'Télévision / écran', icon: '📺', cost: 15 },
      { id: uid('r'), label: 'Nintendo Switch', icon: '🎮', cost: 25 },
      { id: uid('r'), label: 'Cinéma', icon: '🎬', cost: 50 },
      { id: uid('r'), label: 'Restaurant', icon: '🍽️', cost: 80 },
    ],
    points: {},          // { childId: totalPointsDisponibles }
    completions: {},      // { 'YYYY-MM-DD': { childId: [taskId, ...] } }
    redemptions: [],      // { id, childId, rewardId, rewardLabel, date, pointsSpent }
    pendingRequests: [],  // { id, childId, rewardId, date }
    logicProgress: {},     // { childId: { gameId: [questionIndex, ...] } }
  };
}

function loadData(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultData();
    const parsed = JSON.parse(raw);
    // fusion douce avec les valeurs par défaut pour compat future
    const data = Object.assign(defaultData(), parsed);
    if (!Array.isArray(data.redemptions)) data.redemptions = [];
    if (!Array.isArray(data.pendingRequests)) data.pendingRequests = [];
    if (!data.logicProgress || typeof data.logicProgress !== 'object') data.logicProgress = {};
    // Migration ponctuelle (une seule fois) : ajoute les missions ménage introduites
    // après la première version, sans les ré-ajouter si le parent les a supprimées ensuite.
    if (!data.extraTasksMigrated_v2){
      if (!data.tasks.some(task => task.label === 'Aider ses parents')){
        data.tasks.push({ id: uid('t'), label: 'Aider ses parents', type: 'menage', points: 5, schoolDaysOnly: false });
      }
      const extraTasks = [
        ['Faire son lit', 3],
        ['Ranger ses affaires', 4],
        ['Aider à préparer le repas', 5],
        ['Nourrir l’animal', 3],
        ['Arroser les plantes', 2],
      ];
      extraTasks.forEach(([label, points]) => {
        if (!data.tasks.some(task => task.label === label)){
          data.tasks.push({ id: uid('t'), label, type: 'menage', points, schoolDaysOnly: false });
        }
      });
      data.extraTasksMigrated_v2 = true;
    }
    // Migration ponctuelle v3 : missions table/lave-vaisselle/lecture ajoutées ensuite.
    if (!data.extraTasksMigrated_v3){
      const extraTasksV3 = [
        ['Mettre ou débarrasser la table', 'menage', 4, false],
        ['Vider le lave-vaisselle', 'menage', 3, false],
        ['Remplir le lave-vaisselle', 'menage', 3, false],
        ['Lire 30 minutes', 'devoir', 8, false],
      ];
      extraTasksV3.forEach(([label, type, points, schoolDaysOnly]) => {
        if (!data.tasks.some(task => task.label === label)){
          data.tasks.push({ id: uid('t'), label, type, points, schoolDaysOnly });
        }
      });
      data.extraTasksMigrated_v3 = true;
    }
    return data;
  } catch (e) {
    console.error('Erreur de lecture des données', e);
    return defaultData();
  }
}

function saveData(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (familyDocRef){
    setDoc(familyDocRef, state).catch(err => console.error('Erreur de sauvegarde cloud', err));
  }
}

function applyTheme(){
  document.body.dataset.theme = THEMES[state?.theme] ? state.theme : 'clair';
}

function setTheme(theme){
  if (!THEMES[theme]) return;
  state.theme = theme;
  applyTheme();
  saveData();
  renderSettingsModal();
  render();
}

function isAdminUnlocked(){
  return sessionStorage.getItem(SESSION_KEY) === '1';
}
function setAdminUnlocked(v){
  if (v) sessionStorage.setItem(SESSION_KEY, '1');
  else sessionStorage.removeItem(SESSION_KEY);
}

/* ---------------------------- logique métier ---------------------------- */

function getChild(id){ return state.children.find(c => c.id === id); }

function getPoints(childId){ return state.points[childId] || 0; }

function addPoints(childId, delta){
  state.points[childId] = Math.max(0, getPoints(childId) + delta);
}

function tasksForChildToday(){
  const schoolDay = isSchoolDay();
  return state.tasks.filter(t => !t.schoolDaysOnly || schoolDay);
}

function getCompletedToday(childId){
  const day = state.completions[todayStr()];
  if (!day || !day[childId]) return [];
  return day[childId];
}

function isTaskDoneToday(childId, taskId){
  return getCompletedToday(childId).includes(taskId);
}

function toggleTask(childId, taskId){
  const day = todayStr();
  if (!state.completions[day]) state.completions[day] = {};
  if (!state.completions[day][childId]) state.completions[day][childId] = [];
  const list = state.completions[day][childId];
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;

  const idx = list.indexOf(taskId);
  if (idx === -1){
    list.push(taskId);
    addPoints(childId, task.points);
  } else {
    list.splice(idx, 1);
    addPoints(childId, -task.points);
  }
  saveData();
  render();
}

function todayProgress(childId){
  const tasks = tasksForChildToday();
  if (tasks.length === 0) return 0;
  const done = getCompletedToday(childId).length;
  return Math.round((done / tasks.length) * 100);
}

/* ---------------------------- rendu : coquille ---------------------------- */

function render(){
  const app = document.getElementById('app');
  if (state.children.length === 0){
    app.innerHTML = renderEmptyState();
    bindEmptyState();
    return;
  }
  if (!activeChildId || !getChild(activeChildId)){
    activeChildId = state.children[0].id;
  }

  app.innerHTML = `
    ${renderTopbar()}
    ${renderBackupReminder()}
    ${renderChildRow()}
    ${renderCalendar()}
    ${renderStats()}
    ${renderLogicGames()}
    ${renderBoard()}
    ${renderHistory()}
    <p class="footer-note">Données stockées uniquement sur cet appareil · Mission Famille</p>
  `;
  bindTopbar();
  bindBackupReminder();
  bindChildRow();
  bindCalendar();
  bindLogicGames();
  bindBoard();
}

function renderTopbar(){
  const requestCount = state.pendingRequests.length;
  return `
  <div class="topbar">
    <div class="brand">
      <div class="compass">🧭</div>
      <div class="brand-text">
        <h1>Mission Famille</h1>
        <p>${escapeHtml(formatDateLong())}</p>
      </div>
    </div>
    <div class="topbar-actions">
      <button class="icon-btn" id="btn-close-app" title="Fermer et supprimer les données (code parent requis)" aria-label="Fermer et supprimer les données, code parent requis">🔒</button>
      <button class="icon-btn parent-account-btn" id="btn-settings" title="Compte parent${requestCount ? ` : ${requestCount} demande(s)` : ''}" aria-label="Compte parent${requestCount ? `, ${requestCount} demande(s) en attente` : ''}">👨‍👩‍👧${requestCount ? `<span class="notification-badge">${requestCount}</span>` : ''}</button>
    </div>
  </div>`;
}

function daysSinceLastExport(){
  if (!state.lastExportAt) return Infinity;
  return Math.floor((Date.now() - new Date(state.lastExportAt).getTime()) / 86400000);
}

function renderBackupReminder(){
  if (backupReminderDismissed || state.children.length === 0) return '';
  const days = daysSinceLastExport();
  if (days < 14) return '';
  const message = state.lastExportAt ? `Dernière sauvegarde il y a ${days} jours.` : `Vous n'avez jamais exporté de sauvegarde.`;
  return `
  <div class="backup-reminder">
    <span>💾 <strong>Pensez à sauvegarder vos données.</strong> ${escapeHtml(message)}</span>
    <div class="row-actions">
      <button class="btn btn-sm btn-gold" id="btn-backup-now">Exporter maintenant</button>
      <button class="icon-mini" id="btn-backup-dismiss" title="Plus tard">✕</button>
    </div>
  </div>`;
}

function bindBackupReminder(){
  const exportBtn = document.getElementById('btn-backup-now');
  if (exportBtn) exportBtn.onclick = () => requireAdmin(() => exportData());
  const dismissBtn = document.getElementById('btn-backup-dismiss');
  if (dismissBtn) dismissBtn.onclick = () => { backupReminderDismissed = true; render(); };
}

function renderEmptyState(){
  return `
  <div class="topbar">
    <div class="brand">
      <div class="compass">🧭</div>
      <div class="brand-text"><h1>Mission Famille</h1><p>Carnet de missions</p></div>
    </div>
  </div>
  <div class="empty-state">
    <div class="glyph">🗺️</div>
    <h2>Créons le carnet de la famille</h2>
    <p>Ajoutez un premier enfant pour commencer à suivre les missions du quotidien (ménage, devoirs) et débloquer des récompenses.</p>
    <button class="btn btn-gold" id="btn-start-setup">Configurer maintenant</button>
    <button class="btn btn-ghost" id="btn-join-family" style="margin-top:10px;">🔗 Rejoindre une famille existante</button>
  </div>`;
}

function bindEmptyState(){
  document.getElementById('btn-start-setup').onclick = () => openSetupWizard();
  const joinBtn = document.getElementById('btn-join-family');
  if (joinBtn) joinBtn.onclick = () => openJoinFamilyModal();
}

function openJoinFamilyModal(){
  openModal(`
    <h3 class="modal-title">🔗 Rejoindre une famille</h3>
    <p class="modal-sub">Entrez le code famille donné par vos parents (visible dans leurs Réglages → Sécurité).</p>
    <div class="field">
      <label for="family-code-input">Code famille</label>
      <input type="text" id="family-code-input" maxlength="10" placeholder="Ex : AB3XQ9KLMP" style="text-transform:uppercase; letter-spacing:2px; font-family:var(--font-mono);">
    </div>
    <div class="pin-error" id="family-code-error"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="btn-cancel">Annuler</button>
      <button class="btn btn-gold" id="btn-join">Rejoindre</button>
    </div>
  `);
  document.getElementById('btn-cancel').onclick = closeModal;
  document.getElementById('btn-join').onclick = async () => {
    const code = document.getElementById('family-code-input').value.trim().toUpperCase();
    if (!code) return;
    const btn = document.getElementById('btn-join');
    btn.disabled = true;
    btn.textContent = 'Connexion...';
    const ok = await joinFamily(code);
    if (ok){
      closeModal();
      showToast('Famille rejointe !', '🔗');
    } else {
      btn.disabled = false;
      btn.textContent = 'Rejoindre';
      document.getElementById('family-code-error').textContent = 'Code introuvable, ou connexion internet impossible.';
    }
  };
}

/* ---------------------------- rendu : onglets enfants ---------------------------- */

function xpRingSvg(percent, avatar){
  const r = 22, c = 2 * Math.PI * r;
  const offset = c - (percent/100) * c;
  return `
  <div class="xp-ring-wrap">
    <svg width="52" height="52" viewBox="0 0 52 52">
      <circle class="xp-ring-bg" cx="26" cy="26" r="${r}"></circle>
      <circle class="xp-ring-fg" cx="26" cy="26" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${offset}"></circle>
    </svg>
    <div class="xp-avatar">${escapeHtml(avatar)}</div>
  </div>`;
}

function renderChildRow(){
  const items = state.children.map(c => {
    const pct = todayProgress(c.id);
    const euros = totalEuros(c.id);
    return `
    <button class="child-tab ${c.id === activeChildId ? 'active' : ''}" data-child="${c.id}">
      ${xpRingSvg(pct, c.avatar)}
      <div class="child-meta">
        <span class="child-name">${escapeHtml(c.name)}</span>
        <span class="child-points">★ ${escapeHtml(getPoints(c.id))} pts</span>
        ${euros > 0 ? `<span class="child-euros">💶 ${escapeHtml(euros)} € récoltés</span>` : ''}
      </div>
    </button>`;
  }).join('');
  return `<div class="child-row">${items}<button class="add-child-tab" id="btn-add-child-tab">＋ Ajouter</button></div>`;
}

function bindChildRow(){
  document.querySelectorAll('.child-tab').forEach(el => {
    el.onclick = () => { activeChildId = el.dataset.child; render(); };
  });
  const addBtn = document.getElementById('btn-add-child-tab');
  if (addBtn) addBtn.onclick = () => requireAdmin(() => openChildForm());
}

function renderCalendar(){
  const child = getChild(activeChildId);
  const [year, monthNumber] = calendarMonth.split('-').map(Number);
  const firstDay = (new Date(year, monthNumber - 1, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const cells = [];
  const weekdays = ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];

  for (let i = 0; i < firstDay; i++) cells.push('<div class="calendar-day calendar-day-empty"></div>');
  for (let day = 1; day <= daysInMonth; day++){
    const date = new Date(year, monthNumber - 1, day);
    const dateKey = dateForMonth(calendarMonth, day);
    const tasks = state.tasks.filter(task => !task.schoolDaysOnly || isSchoolDay(date));
    const completed = state.completions[dateKey]?.[child.id] || [];
    const done = tasks.filter(task => completed.includes(task.id)).length;
    const isFuture = date > new Date();
    const status = isFuture ? 'future' : (tasks.length > 0 && done === tasks.length ? 'complete' : done > 0 ? 'partial' : 'empty');
    cells.push(`<div class="calendar-day ${status}" title="${done} / ${tasks.length} mission(s)"><span>${day}</span>${tasks.length && !isFuture ? `<small>${done}/${tasks.length}</small>` : ''}</div>`);
  }

  return `
  <section class="calendar-panel" aria-labelledby="calendar-title">
    <div class="calendar-head">
      <div><h2 id="calendar-title">📅 Calendrier des missions</h2><span class="calendar-child">${escapeHtml(child.name)}</span></div>
      <div class="calendar-nav"><button class="icon-mini" id="calendar-prev" title="Mois précédent" aria-label="Mois précédent">‹</button><strong>${escapeHtml(monthLabel(calendarMonth))}</strong><button class="icon-mini" id="calendar-next" title="Mois suivant" aria-label="Mois suivant">›</button></div>
    </div>
    <div class="calendar-grid calendar-weekdays">${weekdays.map(day => `<span>${day}</span>`).join('')}</div>
    <div class="calendar-grid">${cells.join('')}</div>
    <div class="calendar-legend"><span><i class="legend-dot complete"></i>Tout fait</span><span><i class="legend-dot partial"></i>En cours</span><span><i class="legend-dot empty"></i>À faire</span></div>
  </section>`;
}

function bindCalendar(){
  document.getElementById('calendar-prev').onclick = () => {
    const [year, monthNumber] = calendarMonth.split('-').map(Number);
    calendarMonth = monthKey(new Date(year, monthNumber - 2, 1));
    render();
  };
  document.getElementById('calendar-next').onclick = () => {
    const [year, monthNumber] = calendarMonth.split('-').map(Number);
    calendarMonth = monthKey(new Date(year, monthNumber, 1));
    render();
  };
}

function renderStats(){
  const child = getChild(activeChildId);
  const streak = computeStreak(child.id);
  const series = weeklyPointsSeries(child.id);
  const euros = totalEuros(child.id);
  const max = Math.max(1, ...series);
  const bars = series.map((value, index) => {
    const pct = Math.max(4, Math.round((value / max) * 100));
    const isCurrent = index === series.length - 1;
    return `<div class="stat-bar-wrap" title="${value} pt(s)"><div class="stat-bar ${isCurrent ? 'current' : ''}" style="height:${pct}%"></div></div>`;
  }).join('');
  return `
  <section class="stats-panel" aria-labelledby="stats-title">
    <div class="stats-head">
      <div><h2 id="stats-title">📈 Statistiques</h2><span class="calendar-child">${escapeHtml(child.name)}</span></div>
      <div class="stats-badges">
        <div class="euro-badge" title="Argent gagné via les récompenses mensuelles validées">💶 ${euros} € récoltés</div>
        <div class="streak-badge" title="Jours consécutifs avec toutes les missions faites">🔥 ${streak} jour${streak > 1 ? 's' : ''}</div>
      </div>
    </div>
    <div class="stats-chart">${bars}</div>
    <div class="stats-caption">Points gagnés par semaine (8 dernières semaines)</div>
  </section>`;
}

function logicDoneCount(childId, gameId){
  return state.logicProgress[childId]?.[gameId]?.length || 0;
}

function renderLogicGames(){
  const child = getChild(activeChildId);
  const totalDone = LOGIC_GAMES.reduce((sum, game) => sum + logicDoneCount(child.id, game.id), 0);
  return `
  <section class="logic-panel" aria-labelledby="logic-title">
    <div class="logic-head"><div><h2 id="logic-title">🧠 Jeux de logique</h2><p>50 exercices pour entraîner sa réflexion</p></div><strong>${totalDone} / 50 réussis</strong></div>
    <div class="logic-games">${LOGIC_GAMES.map(game => `
      <button class="logic-game" data-logic-game="${game.id}">
        <span class="logic-icon">${game.icon}</span><span class="logic-game-text"><strong>${game.title}</strong><small>${game.description}</small></span><span class="logic-score">${logicDoneCount(child.id, game.id)} / 10</span>
      </button>`).join('')}</div>
  </section>`;
}

function bindLogicGames(){
  document.querySelectorAll('[data-logic-game]').forEach(button => {
    button.onclick = () => openLogicGame(button.dataset.logicGame);
  });
}

function openLogicGame(gameId){
  const game = LOGIC_GAMES.find(item => item.id === gameId);
  const child = getChild(activeChildId);
  if (!game || !child) return;
  let questionIndex = game.questions.findIndex((_, index) => !(state.logicProgress[child.id]?.[game.id] || []).includes(index));
  if (questionIndex < 0){
    openModal(`<h3 class="modal-title">${game.icon} ${escapeHtml(game.title)}</h3><p class="modal-sub">Les 10 exercices sont déjà réussis par ${escapeHtml(child.name)}.</p><div class="logic-complete">🏆 Jeu terminé</div><div class="modal-actions"><button class="btn btn-gold" id="btn-close-logic">Fermer</button></div>`);
    document.getElementById('btn-close-logic').onclick = closeModal;
    return;
  }
  let questionOptions = shuffled(game.questions[questionIndex].options);

  const renderQuestion = (message = '') => {
    const question = game.questions[questionIndex];
    openModal(`
      <h3 class="modal-title">${game.icon} ${escapeHtml(game.title)}</h3>
      <p class="modal-sub">Exercice ${questionIndex + 1} sur 10 · ${escapeHtml(child.name)}</p>
      <div class="logic-question">${escapeHtml(question.text)}</div>
      <div class="logic-options">${questionOptions.map(option => `<button class="logic-option" data-answer="${escapeHtml(option)}">${escapeHtml(option)}</button>`).join('')}</div>
      <p class="logic-feedback">${escapeHtml(message)}</p>
      <div class="modal-actions"><button class="btn btn-ghost" id="btn-close-logic">Quitter</button></div>
    `);
    document.getElementById('btn-close-logic').onclick = closeModal;
    document.querySelectorAll('[data-answer]').forEach(button => {
      button.onclick = () => {
        if (button.dataset.answer !== question.answer){
          renderQuestion('Pas encore. Relis la question et essaie une autre réponse.');
          return;
        }
        if (!state.logicProgress[child.id]) state.logicProgress[child.id] = {};
        if (!state.logicProgress[child.id][game.id]) state.logicProgress[child.id][game.id] = [];
        if (!state.logicProgress[child.id][game.id].includes(questionIndex)) state.logicProgress[child.id][game.id].push(questionIndex);
        saveData();
        const nextQuestion = game.questions.findIndex((_, index) => !(state.logicProgress[child.id][game.id] || []).includes(index));
        if (nextQuestion < 0){
          closeModal();
          showToast(`${game.title} terminé !`, '🧠');
          render();
          return;
        }
        questionIndex = nextQuestion;
        questionOptions = shuffled(game.questions[questionIndex].options);
        renderQuestion('Bravo !');
      };
    });
  };
  renderQuestion();
}

/* ---------------------------- rendu : tableau de missions + récompenses ---------------------------- */

function renderBoard(){
  const child = getChild(activeChildId);
  const tasks = tasksForChildToday();
  const menage = tasks.filter(t => t.type === 'menage');
  const devoirs = tasks.filter(t => t.type === 'devoir');

  const renderGroup = (label, list) => {
    if (list.length === 0) return '';
    const rows = list.map(t => {
      const done = isTaskDoneToday(child.id, t.id);
      return `
      <div class="task-item ${done ? 'done' : ''}" data-task="${t.id}">
        <div class="checkbox">${done ? '✓' : ''}</div>
        <span class="task-label">${escapeHtml(t.label)}</span>
        <span class="task-tag ${t.type}">${t.type === 'menage' ? 'Ménage' : 'Devoir'}</span>
        <span class="task-points">+${escapeHtml(t.points)}</span>
      </div>`;
    }).join('');
    return `<div class="section-label">${label}</div><div class="task-list">${rows}</div>`;
  };

  const missionsHtml = tasks.length === 0
    ? `<div class="no-tasks">Pas de mission prévue aujourd'hui 🎉<br>Ajoutez des tâches dans les réglages parent.</div>`
    : renderGroup('🧹 Ménage', menage) + renderGroup('📚 Devoirs', devoirs);

  const rewardsHtml = state.rewards.length === 0
    ? `<div class="no-tasks">Aucune récompense configurée. Ajoutez-en dans les réglages parent.</div>`
    : state.rewards.map(r => {
        const pts = getPoints(child.id);
        const pct = Math.min(100, Math.round((pts / r.cost) * 100));
        const unlocked = pts >= r.cost;
        return `
        <div class="reward-card ${unlocked ? 'unlocked' : ''}">
          <div class="reward-top">
            <div class="reward-icon">${escapeHtml(r.icon)}</div>
            <div class="grow">
              <div class="reward-name">${escapeHtml(r.label)}</div>
              <div class="reward-cost">${escapeHtml(r.cost)} pts</div>
            </div>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
          <div class="reward-bottom">
            <span class="reward-status ${unlocked ? 'unlocked' : ''}">${unlocked ? '🔓 Débloqué' : pts + ' / ' + r.cost + ' pts'}</span>
            <button class="btn btn-sm ${unlocked ? 'btn-gold' : 'btn-ghost'}" data-redeem="${r.id}" ${unlocked && !hasPendingRequest(child.id, r.id) ? '' : 'disabled'}>${hasPendingRequest(child.id, r.id) ? 'Demande envoyée' : 'Demander'}</button>
          </div>
        </div>`;
      }).join('');
  const monthlyStats = monthlyTaskStats(child.id);
  const previousMonth = new Date();
  previousMonth.setDate(1);
  previousMonth.setMonth(previousMonth.getMonth() - 1);
  const previousMonthKey = monthKey(previousMonth);
  const previousStats = monthlyTaskStats(child.id, previousMonthKey);
  const monthlyReward = previousStats.complete && !hasMonthlyRedemption(child.id, previousMonthKey)
    ? `<div class="monthly-reward unlocked">
        <div class="monthly-reward-top"><span class="monthly-reward-icon">💶</span><div><strong>Récompense de ${escapeHtml(monthLabel(previousMonthKey))}</strong><span>20 € pour toutes les missions réalisées</span></div></div>
        <button class="btn btn-sm btn-gold" data-monthly-redeem="${previousMonthKey}">Valider</button>
      </div>`
    : `<div class="monthly-reward">
        <div class="monthly-reward-top"><span class="monthly-reward-icon">💶</span><div><strong>Récompense mensuelle</strong><span>${monthlyStats.completed} / ${monthlyStats.required} missions réalisées ce mois-ci</span></div></div>
        <span class="monthly-reward-status">20 € en fin de mois</span>
      </div>`;

  return `
  <div class="board">
    <div class="panel">
      <div class="panel-head">
        <h2>🗺️ Missions du jour</h2>
        <span class="sub">${escapeHtml(child.name)}</span>
      </div>
      <div class="panel-body">${missionsHtml}</div>
    </div>
    <div class="panel">
      <div class="panel-head">
        <h2>🎁 Récompenses</h2>
        <span class="sub">★ ${getPoints(child.id)} pts</span>
      </div>
      <div class="panel-body"><div class="reward-list">${monthlyReward}${rewardsHtml}</div></div>
    </div>
  </div>`;
}

function bindBoard(){
  document.querySelectorAll('.task-item').forEach(el => {
    el.onclick = () => toggleTask(activeChildId, el.dataset.task);
  });
  document.querySelectorAll('[data-redeem]').forEach(el => {
    el.onclick = () => requestReward(el.dataset.redeem);
  });
  document.querySelectorAll('[data-monthly-redeem]').forEach(el => {
    el.onclick = () => requireAdmin(() => confirmMonthlyRedeem(el.dataset.monthlyRedeem));
  });
}

function hasPendingRequest(childId, rewardId){
  return state.pendingRequests.some(request => request.childId === childId && request.rewardId === rewardId);
}

function requestReward(rewardId){
  const child = getChild(activeChildId);
  const reward = state.rewards.find(item => item.id === rewardId);
  if (!child || !reward || getPoints(child.id) < reward.cost || hasPendingRequest(child.id, reward.id)) return;
  state.pendingRequests.unshift({ id: uid('req'), childId: child.id, rewardId: reward.id, date: new Date().toISOString() });
  saveData();
  notifyParent('🔔 Nouvelle demande', `${child.name} demande « ${reward.label} » (${reward.cost} pts)`);
  showToast(`Demande envoyée aux parents`, '🔔');
  render();
}

function openParentRequests(){
  const rows = state.pendingRequests.map(request => {
    const child = getChild(request.childId);
    const reward = state.rewards.find(item => item.id === request.rewardId);
    if (!child || !reward) return '';
    return `<div class="request-row"><div class="grow"><strong>${escapeHtml(child.avatar)} ${escapeHtml(child.name)}</strong><span>demande ${escapeHtml(reward.icon)} ${escapeHtml(reward.label)} (${escapeHtml(reward.cost)} pts)</span></div><div class="row-actions"><button class="btn btn-sm btn-gold" data-approve-request="${request.id}">Valider</button><button class="icon-mini" data-reject-request="${request.id}" title="Refuser">✕</button></div></div>`;
  }).join('');
  const childNames = [...new Set(state.pendingRequests.map(request => getChild(request.childId)?.name).filter(Boolean))];
  const namesLabel = childNames.length ? childNames.join(' et ') : 'vos enfants';
  openModal(`
    <h3 class="modal-title">🔔 Demandes des enfants</h3>
    <p class="modal-sub">Validez ou refusez les demandes de déblocage de ${escapeHtml(namesLabel)}.</p>
    <div class="request-list">${rows || '<p class="help-text">Aucune demande en attente.</p>'}</div>
    <div class="modal-actions"><button class="btn btn-ghost" id="btn-close-requests">Fermer</button></div>
  `, { wide: true });
  document.getElementById('btn-close-requests').onclick = closeModal;
  document.querySelectorAll('[data-approve-request]').forEach(el => el.onclick = () => approveRequest(el.dataset.approveRequest));
  document.querySelectorAll('[data-reject-request]').forEach(el => el.onclick = () => rejectRequest(el.dataset.rejectRequest));
}

function approveRequest(requestId){
  const request = state.pendingRequests.find(item => item.id === requestId);
  if (!request) return;
  const child = getChild(request.childId);
  const reward = state.rewards.find(item => item.id === request.rewardId);
  if (!child || !reward || getPoints(child.id) < reward.cost){
    rejectRequest(requestId);
    return;
  }
  withUndo(() => {
    addPoints(child.id, -reward.cost);
    state.pendingRequests = state.pendingRequests.filter(item => item.id !== requestId);
    state.redemptions.unshift({ id: uid('red'), childId: child.id, rewardId: reward.id, rewardLabel: reward.label, rewardIcon: reward.icon, date: new Date().toISOString(), pointsSpent: reward.cost });
    saveData();
  }, `Demande de ${child.name} validée`, '✅');
  closeModal();
  render();
}

function rejectRequest(requestId){
  const request = state.pendingRequests.find(item => item.id === requestId);
  const child = request && getChild(request.childId);
  const reward = request && state.rewards.find(item => item.id === request.rewardId);
  withUndo(() => {
    state.pendingRequests = state.pendingRequests.filter(item => item.id !== requestId);
    if (request && child && reward){
      state.redemptions.unshift({
        id: uid('reqlog'), kind: 'request', status: 'refused', childId: child.id,
        rewardId: reward.id, rewardLabel: reward.label, rewardIcon: reward.icon,
        date: new Date().toISOString(), pointsSpent: 0,
      });
    }
    saveData();
  }, 'Demande refusée, points conservés', '↩️');
  closeModal();
  render();
}

function confirmMonthlyRedeem(month){
  const child = getChild(activeChildId);
  if (!child || hasMonthlyRedemption(child.id, month)) return;
  openConfirmModal({
    title: 'Confirmer la récompense mensuelle',
    body: `Valider <strong>20 €</strong> pour <strong>${escapeHtml(child.name)}</strong> : toutes les missions de ${escapeHtml(monthLabel(month))} ont été réalisées ?`,
    confirmLabel: 'Valider les 20 €',
    onConfirm: () => {
      withUndo(() => {
        state.redemptions.unshift({
          id: uid('red'), kind: 'monthly', childId: child.id, month,
          rewardLabel: 'Récompense mensuelle', rewardIcon: '💶', date: new Date().toISOString(), amount: 20,
        });
        saveData();
      }, `Récompense de 20 € validée pour ${child.name}`, '💶');
      render();
    }
  });
}

function confirmRedeem(rewardId){
  const child = getChild(activeChildId);
  const reward = state.rewards.find(r => r.id === rewardId);
  if (!child || !reward) return;
  openConfirmModal({
    title: 'Confirmer la récompense',
    body: `Valider que <strong>${escapeHtml(child.name)}</strong> utilise <strong>${escapeHtml(reward.icon)} ${escapeHtml(reward.label)}</strong> pour <strong>${escapeHtml(reward.cost)} pts</strong> ?`,
    confirmLabel: 'Valider',
    onConfirm: () => {
      addPoints(child.id, -reward.cost);
      state.redemptions.unshift({
        id: uid('red'), childId: child.id, rewardId: reward.id,
        rewardLabel: reward.label, rewardIcon: reward.icon,
        date: new Date().toISOString(), pointsSpent: reward.cost,
      });
      saveData();
      showToast(`${reward.label} débloqué pour ${child.name} !`, reward.icon);
      render();
    }
  });
}

/* ---------------------------- rendu : historique ---------------------------- */

function renderHistory(){
  const pendingRows = state.pendingRequests.map(request => {
    const child = getChild(request.childId);
    const reward = state.rewards.find(item => item.id === request.rewardId);
    if (!child || !reward) return '';
    const dateLabel = new Date(request.date).toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit' });
    return `<div class="history-item history-pending">
      <span class="h-date">${dateLabel}</span>
      <span>🔔 <strong>${escapeHtml(child.name)}</strong> demande « ${escapeHtml(reward.label)} » (${escapeHtml(reward.cost)} pts) - en attente du parent</span>
    </div>`;
  }).join('');
  const recent = state.redemptions.slice(0, 8);
  const rows = !pendingRows && recent.length === 0
    ? `<div class="history-empty">Aucune récompense utilisée pour le moment.</div>`
    : pendingRows + recent.map(r => {
        const c = getChild(r.childId);
        const d = new Date(r.date);
        const dateLabel = d.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit' });
        if (r.kind === 'request' && r.status === 'refused'){
          return `<div class="history-item history-refused">
            <span class="h-date">${dateLabel}</span>
            <span>↩️ <strong>${escapeHtml(c ? c.name : '?')}</strong> : demande refusée pour « ${escapeHtml(r.rewardLabel)} » (points conservés)</span>
          </div>`;
        }
        const rewardValue = r.kind === 'monthly' ? '20 €' : `-${escapeHtml(r.pointsSpent)} pts`;
        return `<div class="history-item">
          <span class="h-date">${dateLabel}</span>
          <span>${escapeHtml(r.rewardIcon)} <strong>${escapeHtml(c ? c.name : '?')}</strong> ${r.kind === 'monthly' ? 'a gagné' : 'a utilisé'} « ${escapeHtml(r.rewardLabel)} » (${rewardValue})</span>
        </div>`;
      }).join('');
  return `<div class="history-strip"><h3>📜 Journal des récompenses</h3>${rows}</div>`;
}

/* ---------------------------- modales génériques ---------------------------- */

function openModal(innerHtml, { wide = false } = {}){
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal-box ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${innerHtml}</div>
    </div>`;
  document.getElementById('modal-overlay').addEventListener('mousedown', (e) => {
    if (e.target.id === 'modal-overlay') closeModal();
  });
  document.addEventListener('keydown', escToClose);
}
function escToClose(e){ if (e.key === 'Escape') closeModal(); }
function closeModal(){
  document.getElementById('modal-root').innerHTML = '';
  document.removeEventListener('keydown', escToClose);
}

function openConfirmModal({ title, body, confirmLabel = 'Confirmer', onConfirm, danger = false }){
  openModal(`
    <h3 class="modal-title">${escapeHtml(title)}</h3>
    <p class="modal-sub">${body}</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="btn-cancel">Annuler</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-gold'}" id="btn-confirm">${escapeHtml(confirmLabel)}</button>
    </div>`);
  document.getElementById('btn-cancel').onclick = closeModal;
  document.getElementById('btn-confirm').onclick = () => { closeModal(); onConfirm(); };
}

/* ---------------------------- sécurité : PIN parent ---------------------------- */

function requireAdmin(callback){
  if (!state.pinHash){
    // Pas encore de PIN défini -> on force sa création avant toute action sensible
    openPinSetupModal(() => callback());
    return;
  }
  if (isAdminUnlocked()){ callback(); return; }
  openPinPromptModal(callback);
}

function openPinSetupModal(onDone){
  let entered = '';
  openModal(`
    <h3 class="modal-title">🔐 Créer le code parent</h3>
    <p class="modal-sub">Ce code protège les réglages et la validation des récompenses. Choisissez 4 chiffres faciles à retenir pour vous, pas pour les enfants.</p>
    <div class="pin-dots" id="pin-dots">${'<span class="pin-dot"></span>'.repeat(4)}</div>
    <div class="pin-keypad" id="pin-keypad"></div>
    <div class="pin-error" id="pin-error"></div>
  `);
  renderKeypad('pin-keypad', async (digit) => {
    if (digit === 'del'){ entered = entered.slice(0,-1); }
    else if (entered.length < 4){ entered += digit; }
    updatePinDots(entered);
    if (entered.length === 4){
      const first = entered;
      entered = '';
      setTimeout(async () => {
        openPinConfirmStep(first, onDone);
      }, 150);
    }
  });
}

function openPinConfirmStep(firstPin, onDone){
  let entered = '';
  openModal(`
    <h3 class="modal-title">🔐 Confirmez le code</h3>
    <p class="modal-sub">Ressaisissez le même code à 4 chiffres.</p>
    <div class="pin-dots" id="pin-dots">${'<span class="pin-dot"></span>'.repeat(4)}</div>
    <div class="pin-keypad" id="pin-keypad"></div>
    <div class="pin-error" id="pin-error"></div>
  `);
  renderKeypad('pin-keypad', async (digit) => {
    if (digit === 'del'){ entered = entered.slice(0,-1); }
    else if (entered.length < 4){ entered += digit; }
    updatePinDots(entered);
    if (entered.length === 4){
      if (entered === firstPin){
        state.pinHash = await sha256(entered);
        saveData();
        setAdminUnlocked(true);
        closeModal();
        showToast('Code parent créé', '🔐');
        onDone();
      } else {
        document.getElementById('pin-error').textContent = 'Les codes ne correspondent pas, réessayez.';
        entered = '';
        setTimeout(() => updatePinDots(''), 400);
      }
    }
  });
}

function openPinPromptModal(onSuccess){
  let entered = '';
  if (Date.now() < pinLockUntil){
    const secs = Math.ceil((pinLockUntil - Date.now())/1000);
    openModal(`
      <h3 class="modal-title">🔐 Code parent</h3>
      <p class="pin-error">Trop d'essais. Réessayez dans ${secs}s.</p>
      <div class="modal-actions"><button class="btn btn-ghost" id="btn-cancel">Fermer</button></div>`);
    document.getElementById('btn-cancel').onclick = closeModal;
    return;
  }
  openModal(`
    <h3 class="modal-title">🔐 Code parent</h3>
    <p class="modal-sub">Entrez le code à 4 chiffres pour continuer.</p>
    <div class="pin-dots" id="pin-dots">${'<span class="pin-dot"></span>'.repeat(4)}</div>
    <div class="pin-keypad" id="pin-keypad"></div>
    <div class="pin-error" id="pin-error"></div>
  `);
  renderKeypad('pin-keypad', async (digit) => {
    if (digit === 'del'){ entered = entered.slice(0,-1); }
    else if (entered.length < 4){ entered += digit; }
    updatePinDots(entered);
    if (entered.length === 4){
      const hash = await sha256(entered);
      if (hash === state.pinHash){
        failedPinAttempts = 0;
        setAdminUnlocked(true);
        closeModal();
        onSuccess();
      } else {
        failedPinAttempts++;
        document.getElementById('pin-error').textContent = 'Code incorrect.';
        entered = '';
        setTimeout(() => updatePinDots(''), 350);
        if (failedPinAttempts >= 5){
          pinLockUntil = Date.now() + 30000;
          failedPinAttempts = 0;
          closeModal();
          showToast('Trop d\'essais, réessayez dans 30s', '⛔');
        }
      }
    }
  });
}

function updatePinDots(entered){
  document.querySelectorAll('#pin-dots .pin-dot').forEach((d, i) => {
    d.classList.toggle('filled', i < entered.length);
  });
}

function renderKeypad(containerId, onKey){
  const container = document.getElementById(containerId);
  const keys = ['1','2','3','4','5','6','7','8','9','','0','del'];
  container.innerHTML = keys.map(k => {
    if (k === '') return '<div></div>';
    if (k === 'del') return `<button class="pin-key" data-key="del" aria-label="Effacer">⌫</button>`;
    return `<button class="pin-key" data-key="${k}">${k}</button>`;
  }).join('');
  container.querySelectorAll('.pin-key').forEach(btn => {
    btn.onclick = () => onKey(btn.dataset.key);
  });
}

/* ---------------------------- assistant de configuration initiale ---------------------------- */

function openSetupWizard(){
  openChildForm({ afterSave: null, isFirstRun: true });
}

/* ---------------------------- formulaire : enfant ---------------------------- */

function openChildForm(existing){
  const editing = existing && existing.id;
  let selectedEmoji = editing ? existing.avatar : EMOJIS[0];
  openModal(`
    <h3 class="modal-title">${editing ? 'Modifier' : 'Ajouter'} un enfant</h3>
    <div class="field">
      <label for="child-name">Prénom</label>
      <input type="text" id="child-name" maxlength="24" value="${editing ? escapeHtml(existing.name) : ''}" placeholder="Ex : Léo">
    </div>
    <div class="field">
      <label>Avatar</label>
      <div class="emoji-picker" id="emoji-picker">
        ${EMOJIS.map(e => `<button type="button" class="emoji-opt ${e === selectedEmoji ? 'selected' : ''}" data-emoji="${e}">${e}</button>`).join('')}
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="btn-cancel">Annuler</button>
      <button class="btn btn-gold" id="btn-save">${editing ? 'Enregistrer' : 'Ajouter'}</button>
    </div>
  `);
  document.querySelectorAll('#emoji-picker .emoji-opt').forEach(el => {
    el.onclick = () => {
      selectedEmoji = el.dataset.emoji;
      document.querySelectorAll('#emoji-picker .emoji-opt').forEach(x => x.classList.remove('selected'));
      el.classList.add('selected');
    };
  });
  document.getElementById('btn-cancel').onclick = closeModal;
  document.getElementById('btn-save').onclick = () => {
    const name = document.getElementById('child-name').value.trim();
    if (!name){ showToast('Merci de saisir un prénom', '⚠️'); return; }
    if (editing){
      existing.name = name;
      existing.avatar = selectedEmoji;
    } else {
      const child = { id: uid('c'), name, avatar: selectedEmoji };
      state.children.push(child);
      state.points[child.id] = 0;
      activeChildId = child.id;
    }
    saveData();
    closeModal();
    render();
  };
}

/* ---------------------------- panneau réglages ---------------------------- */

let settingsTab = 'enfants';

function openSettingsPanel(){
  requireAdmin(() => state.pendingRequests.length ? openParentRequests() : renderSettingsModal());
}

function renderSettingsModal(){
  openModal(`
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
      <h3 class="modal-title" style="margin-bottom:0;">⚙️ Réglages parent</h3>
      <button class="btn btn-ghost btn-sm" id="btn-lock">🔒 Verrouiller</button>
    </div>
    <p class="modal-sub">Compte parent : gérez les enfants, les missions, les récompenses et les demandes.</p>
    <div class="settings-tabs">
      <button class="settings-tab ${settingsTab==='enfants'?'active':''}" data-tab="enfants">👤 Enfants</button>
      <button class="settings-tab ${settingsTab==='taches'?'active':''}" data-tab="taches">🗒️ Missions</button>
      <button class="settings-tab ${settingsTab==='recompenses'?'active':''}" data-tab="recompenses">🎁 Récompenses</button>
      <button class="settings-tab ${settingsTab==='apparence'?'active':''}" data-tab="apparence">🎨 Apparence</button>
      <button class="settings-tab ${settingsTab==='securite'?'active':''}" data-tab="securite">🔐 Sécurité</button>
    </div>
    <div id="settings-content"></div>
    <div class="modal-actions"><button class="btn btn-ghost" id="btn-close-settings">Fermer</button></div>
  `, { wide: true });

  document.getElementById('btn-close-settings').onclick = closeModal;
  document.getElementById('btn-lock').onclick = () => { setAdminUnlocked(false); closeModal(); showToast('Réglages verrouillés', '🔒'); };
  document.querySelectorAll('.settings-tab').forEach(el => {
    el.onclick = () => { settingsTab = el.dataset.tab; renderSettingsModal(); };
  });
  renderSettingsContent();
}

function renderSettingsContent(){
  const container = document.getElementById('settings-content');
  if (settingsTab === 'enfants') container.innerHTML = childrenSettingsHtml();
  else if (settingsTab === 'taches') container.innerHTML = tasksSettingsHtml();
  else if (settingsTab === 'recompenses') container.innerHTML = rewardsSettingsHtml();
  else if (settingsTab === 'apparence') container.innerHTML = appearanceSettingsHtml();
  else container.innerHTML = securitySettingsHtml();
  bindSettingsContent();
}

function childrenSettingsHtml(){
  const rows = state.children.map(c => `
    <div class="list-row">
      <span style="font-size:22px;">${escapeHtml(c.avatar)}</span>
      <div class="grow"><div class="rname">${escapeHtml(c.name)}</div><div class="rmeta">★ ${escapeHtml(getPoints(c.id))} pts</div></div>
      <div class="row-actions">
        <button class="icon-mini" data-edit-child="${c.id}" title="Modifier">✏️</button>
        <button class="icon-mini" data-reset-points="${c.id}" title="Réinitialiser les points">↺</button>
        <button class="icon-mini" data-del-child="${c.id}" title="Supprimer">🗑️</button>
      </div>
    </div>`).join('') || '<p class="help-text">Aucun enfant pour le moment.</p>';
  return `${rows}<button class="btn btn-primary btn-block" id="btn-new-child" style="margin-top:10px;">＋ Ajouter un enfant</button>`;
}

function tasksSettingsHtml(){
  const rows = state.tasks.map(t => `
    <div class="list-row">
      <div class="grow">
        <div class="rname">${escapeHtml(t.label)}</div>
        <div class="rmeta">${t.type === 'menage' ? 'Ménage' : 'Devoir'} · +${escapeHtml(t.points)} pts${t.schoolDaysOnly ? ' · jours d\'école' : ''}</div>
      </div>
      <div class="row-actions">
        <button class="icon-mini" data-edit-task="${t.id}" title="Modifier">✏️</button>
        <button class="icon-mini" data-del-task="${t.id}" title="Supprimer">🗑️</button>
      </div>
    </div>`).join('') || '<p class="help-text">Aucune mission configurée.</p>';
  return `${rows}<button class="btn btn-primary btn-block" id="btn-new-task" style="margin-top:10px;">＋ Ajouter une mission</button>`;
}

function rewardsSettingsHtml(){
  const rows = state.rewards.map(r => `
    <div class="list-row">
      <span style="font-size:22px;">${escapeHtml(r.icon)}</span>
      <div class="grow"><div class="rname">${escapeHtml(r.label)}</div><div class="rmeta">${escapeHtml(r.cost)} pts</div></div>
      <div class="row-actions">
        <button class="icon-mini" data-edit-reward="${r.id}" title="Modifier">✏️</button>
        <button class="icon-mini" data-del-reward="${r.id}" title="Supprimer">🗑️</button>
      </div>
    </div>`).join('') || '<p class="help-text">Aucune récompense configurée.</p>';
  return `${rows}<button class="btn btn-primary btn-block" id="btn-new-reward" style="margin-top:10px;">＋ Ajouter une récompense</button>`;
}

function appearanceSettingsHtml(){
  return `
    <p class="help-text" style="margin-bottom:14px;">Choisissez une ambiance plus lumineuse pour le carnet familial.</p>
    <div class="theme-picker">
      ${Object.entries(THEMES).map(([id, theme]) => `
        <button class="theme-choice ${state.theme === id ? 'selected' : ''}" data-theme-choice="${id}">
          <span class="theme-swatch ${id}"></span><span>${theme.icon} ${theme.label}</span>${state.theme === id ? '<strong>✓</strong>' : ''}
        </button>`).join('')}
    </div>`;
}

function securitySettingsHtml(){
  const notifOn = state.notificationsEnabled && 'Notification' in window && Notification.permission === 'granted';
  const familyCode = getFamilyCode();
  const cloudSection = familyCode
    ? `
    <div class="list-row" style="flex-direction:column; align-items:stretch; gap:8px;">
      <div class="rname">☁️ Synchronisation active</div>
      <div class="rmeta">Code famille : <strong style="font-family:var(--font-mono); letter-spacing:2px;">${escapeHtml(familyCode)}</strong></div>
      <div class="help-text" style="margin:0;">Entrez ce code sur le téléphone de chaque enfant (bouton "Rejoindre une famille existante") pour qu'ils voient les mêmes missions et récompenses en temps réel.</div>
      <button class="btn btn-ghost btn-sm" id="btn-copy-family-code">Copier le code</button>
    </div>
    <button class="btn btn-danger btn-block" id="btn-leave-family" style="margin:10px 0;">Désactiver la synchronisation sur cet appareil</button>
    `
    : `
    <button class="btn btn-ghost btn-block" id="btn-create-family" style="margin-bottom:10px;">☁️ Activer la synchronisation entre appareils</button>
    `;
  return `
    <p class="help-text" style="margin-bottom:14px;">Le code parent protège les réglages et la validation des récompenses. Il est stocké de façon chiffrée (SHA-256) uniquement sur cet appareil.</p>
    <div class="list-row">
      <span style="font-size:22px;">🔔</span>
      <div class="grow"><div class="rname">Notifications</div><div class="rmeta">Être prévenu quand un enfant demande une récompense</div></div>
      <button class="btn btn-sm ${notifOn ? 'btn-gold' : 'btn-ghost'}" id="btn-toggle-notifications">${notifOn ? 'Activées' : 'Activer'}</button>
    </div>
    ${cloudSection}
    <button class="btn btn-ghost btn-block" id="btn-change-pin" style="margin-bottom:10px;">🔐 Changer le code parent</button>
    <button class="btn btn-ghost btn-block" id="btn-export" style="margin-bottom:10px;">⬇️ Exporter les données (sauvegarde)</button>
    <label class="btn btn-ghost btn-block" style="display:block; text-align:center; margin-bottom:10px; cursor:pointer;">
      ⬆️ Importer une sauvegarde
      <input type="file" id="btn-import" accept="application/json" style="display:none;">
    </label>
    <button class="btn btn-danger btn-block" id="btn-reset-all">🗑️ Réinitialiser toute l'application</button>
  `;
}

function bindSettingsContent(){
  document.querySelectorAll('[data-theme-choice]').forEach(el => {
    el.onclick = () => setTheme(el.dataset.themeChoice);
  });

  // Enfants
  const newChildBtn = document.getElementById('btn-new-child');
  if (newChildBtn) newChildBtn.onclick = () => openChildForm();
  document.querySelectorAll('[data-edit-child]').forEach(el => {
    el.onclick = () => openChildForm(getChild(el.dataset.editChild));
  });
  document.querySelectorAll('[data-reset-points]').forEach(el => {
    el.onclick = () => openConfirmModal({
      title: 'Réinitialiser les points',
      body: `Remettre les points de <strong>${escapeHtml(getChild(el.dataset.resetPoints).name)}</strong> à zéro ?`,
      onConfirm: () => {
        withUndo(() => { state.points[el.dataset.resetPoints] = 0; saveData(); }, 'Points réinitialisés', '↺');
        renderSettingsModal(); render();
      }
    });
  });
  document.querySelectorAll('[data-del-child]').forEach(el => {
    el.onclick = () => openConfirmModal({
      title: 'Supprimer cet enfant', danger: true, confirmLabel: 'Supprimer',
      body: `Supprimer <strong>${escapeHtml(getChild(el.dataset.delChild).name)}</strong> et son historique de points ? Vous pouvez annuler juste après si besoin.`,
      onConfirm: () => {
        withUndo(() => {
          state.children = state.children.filter(c => c.id !== el.dataset.delChild);
          delete state.points[el.dataset.delChild];
          if (activeChildId === el.dataset.delChild) activeChildId = state.children[0]?.id || null;
          saveData();
        }, 'Enfant supprimé', '🗑️');
        renderSettingsModal(); render();
      }
    });
  });

  // Missions
  const newTaskBtn = document.getElementById('btn-new-task');
  if (newTaskBtn) newTaskBtn.onclick = () => openTaskForm();
  document.querySelectorAll('[data-edit-task]').forEach(el => {
    el.onclick = () => openTaskForm(state.tasks.find(t => t.id === el.dataset.editTask));
  });
  document.querySelectorAll('[data-del-task]').forEach(el => {
    el.onclick = () => openConfirmModal({
      title: 'Supprimer cette mission', danger: true, confirmLabel: 'Supprimer',
      body: `Supprimer cette mission de la liste ?`,
      onConfirm: () => {
        withUndo(() => { state.tasks = state.tasks.filter(t => t.id !== el.dataset.delTask); saveData(); }, 'Mission supprimée', '🗑️');
        renderSettingsModal(); render();
      }
    });
  });

  // Récompenses
  const newRewardBtn = document.getElementById('btn-new-reward');
  if (newRewardBtn) newRewardBtn.onclick = () => openRewardForm();
  document.querySelectorAll('[data-edit-reward]').forEach(el => {
    el.onclick = () => openRewardForm(state.rewards.find(r => r.id === el.dataset.editReward));
  });
  document.querySelectorAll('[data-del-reward]').forEach(el => {
    el.onclick = () => openConfirmModal({
      title: 'Supprimer cette récompense', danger: true, confirmLabel: 'Supprimer',
      body: `Supprimer cette récompense de la liste ?`,
      onConfirm: () => {
        withUndo(() => { state.rewards = state.rewards.filter(r => r.id !== el.dataset.delReward); saveData(); }, 'Récompense supprimée', '🗑️');
        renderSettingsModal(); render();
      }
    });
  });

  // Sécurité
  const notifBtn = document.getElementById('btn-toggle-notifications');
  if (notifBtn) notifBtn.onclick = () => { state.notificationsEnabled ? disableNotifications() : enableNotifications(); };
  const createFamilyBtn = document.getElementById('btn-create-family');
  if (createFamilyBtn) createFamilyBtn.onclick = async () => {
    createFamilyBtn.disabled = true;
    createFamilyBtn.textContent = 'Activation...';
    const code = await createFamily();
    if (code){
      showToast('Synchronisation activée', '☁️');
      renderSettingsModal();
    } else {
      createFamilyBtn.disabled = false;
      createFamilyBtn.textContent = '☁️ Activer la synchronisation entre appareils';
      showToast('Impossible d\'activer la synchronisation, vérifiez votre connexion internet', '⚠️');
    }
  };
  const copyCodeBtn = document.getElementById('btn-copy-family-code');
  if (copyCodeBtn) copyCodeBtn.onclick = () => {
    navigator.clipboard.writeText(getFamilyCode() || '').then(() => showToast('Code copié', '📋'));
  };
  const leaveFamilyBtn = document.getElementById('btn-leave-family');
  if (leaveFamilyBtn) leaveFamilyBtn.onclick = () => openConfirmModal({
    title: 'Désactiver la synchronisation', danger: true, confirmLabel: 'Désactiver',
    body: `Cet appareil arrêtera de se synchroniser et gardera une copie locale des données actuelles. Les autres appareils connectés avec ce code continueront de se synchroniser entre eux.`,
    onConfirm: () => {
      leaveFamilySync();
      showToast('Synchronisation désactivée sur cet appareil', '☁️');
      renderSettingsModal();
    }
  });
  const changePinBtn = document.getElementById('btn-change-pin');
  if (changePinBtn) changePinBtn.onclick = () => openPinSetupModal(() => { showToast('Code parent modifié', '🔐'); });
  const exportBtn = document.getElementById('btn-export');
  if (exportBtn) exportBtn.onclick = exportData;
  const importInput = document.getElementById('btn-import');
  if (importInput) importInput.onchange = importData;
  const resetAllBtn = document.getElementById('btn-reset-all');
  if (resetAllBtn) resetAllBtn.onclick = () => confirmResetAll();
}

/* Réinitialise entièrement les données de cet appareil, après confirmation.
   Utilisée par Réglages → Sécurité et par le bouton 🔒 de fermeture rapide. */
function confirmResetAll(){
  openConfirmModal({
    title: 'Réinitialiser toute l\'application', danger: true, confirmLabel: 'Tout réinitialiser',
    body: `Cette action supprime <strong>tous les enfants, missions, récompenses et points</strong> sur cet appareil. Un bouton "Annuler" reste disponible juste après si besoin.`,
    onConfirm: () => {
      withUndo(() => {
        setAdminUnlocked(false);
        state = defaultData();
        applyTheme();
        activeChildId = null;
        saveData();
      }, 'Application réinitialisée', '🗑️');
      render();
    }
  });
}

/* Bouton 🔒 de la barre du haut : redemande le code parent même si déjà déverrouillé,
   puis propose de tout supprimer sur cet appareil. */
function openCloseAppFlow(){
  if (!state.pinHash){
    requireAdmin(() => confirmResetAll());
    return;
  }
  openPinPromptModal(() => confirmResetAll());
}

/* ---------------------------- formulaire : mission ---------------------------- */

function openTaskForm(existing){
  const editing = !!existing;
  openModal(`
    <h3 class="modal-title">${editing ? 'Modifier' : 'Ajouter'} une mission</h3>
    <div class="field">
      <label for="task-label">Nom de la mission</label>
      <input type="text" id="task-label" maxlength="60" value="${editing ? escapeHtml(existing.label) : ''}" placeholder="Ex : Ranger sa chambre">
    </div>
    <div class="field-row">
      <div class="field">
        <label for="task-type">Type</label>
        <select id="task-type">
          <option value="menage" ${editing && existing.type==='menage' ? 'selected':''}>🧹 Ménage</option>
          <option value="devoir" ${editing && existing.type==='devoir' ? 'selected':''}>📚 Devoir</option>
        </select>
      </div>
      <div class="field">
        <label for="task-points">Points</label>
        <input type="number" id="task-points" min="1" max="100" value="${editing ? existing.points : 5}">
      </div>
    </div>
    <label class="checkbox-row">
      <input type="checkbox" id="task-school" ${editing && existing.schoolDaysOnly ? 'checked':''}>
      Uniquement les jours d'école (lundi à vendredi)
    </label>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="btn-cancel">Annuler</button>
      <button class="btn btn-gold" id="btn-save">${editing ? 'Enregistrer' : 'Ajouter'}</button>
    </div>
  `);
  document.getElementById('btn-cancel').onclick = closeModal;
  document.getElementById('btn-save').onclick = () => {
    const label = document.getElementById('task-label').value.trim();
    const type = document.getElementById('task-type').value;
    const points = Math.max(1, parseInt(document.getElementById('task-points').value, 10) || 1);
    const schoolDaysOnly = document.getElementById('task-school').checked;
    if (!label){ showToast('Merci de nommer la mission', '⚠️'); return; }
    if (editing){
      Object.assign(existing, { label, type, points, schoolDaysOnly });
    } else {
      state.tasks.push({ id: uid('t'), label, type, points, schoolDaysOnly });
    }
    saveData();
    renderSettingsModal();
    render();
  };
}

/* ---------------------------- formulaire : récompense ---------------------------- */

function openRewardForm(existing){
  const editing = !!existing;
  let selectedIcon = editing ? existing.icon : REWARD_ICONS[0];
  openModal(`
    <h3 class="modal-title">${editing ? 'Modifier' : 'Ajouter'} une récompense</h3>
    <div class="field">
      <label for="reward-label">Nom</label>
      <input type="text" id="reward-label" maxlength="40" value="${editing ? escapeHtml(existing.label) : ''}" placeholder="Ex : Cinéma">
    </div>
    <div class="field">
      <label>Icône</label>
      <div class="emoji-picker" id="reward-icon-picker">
        ${REWARD_ICONS.map(e => `<button type="button" class="emoji-opt ${e === selectedIcon ? 'selected':''}" data-emoji="${e}">${e}</button>`).join('')}
      </div>
    </div>
    <div class="field">
      <label for="reward-cost">Coût en points</label>
      <input type="number" id="reward-cost" min="1" max="1000" value="${editing ? existing.cost : 20}">
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="btn-cancel">Annuler</button>
      <button class="btn btn-gold" id="btn-save">${editing ? 'Enregistrer' : 'Ajouter'}</button>
    </div>
  `);
  document.querySelectorAll('#reward-icon-picker .emoji-opt').forEach(el => {
    el.onclick = () => {
      selectedIcon = el.dataset.emoji;
      document.querySelectorAll('#reward-icon-picker .emoji-opt').forEach(x => x.classList.remove('selected'));
      el.classList.add('selected');
    };
  });
  document.getElementById('btn-cancel').onclick = closeModal;
  document.getElementById('btn-save').onclick = () => {
    const label = document.getElementById('reward-label').value.trim();
    const cost = Math.max(1, parseInt(document.getElementById('reward-cost').value, 10) || 1);
    if (!label){ showToast('Merci de nommer la récompense', '⚠️'); return; }
    if (editing){
      Object.assign(existing, { label, icon: selectedIcon, cost });
    } else {
      state.rewards.push({ id: uid('r'), label, icon: selectedIcon, cost });
    }
    saveData();
    renderSettingsModal();
    render();
  };
}

/* ---------------------------- export / import ---------------------------- */

function exportData(){
  state.lastExportAt = new Date().toISOString();
  saveData();
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mission-famille-sauvegarde-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  backupReminderDismissed = false;
  showToast('Sauvegarde téléchargée', '⬇️');
  render();
}

/* Nettoie un objet de sauvegarde importé : un fichier JSON peut avoir été modifié ou fabriqué
   par un tiers, donc chaque champ affiché ensuite (avatar, icône, libellé, points...) est
   contraint à un type/format sûr avant d'entrer dans l'état de l'application. Les identifiants
   valides sont conservés (pour ne pas casser les liens avec l'historique) ; les autres sont
   régénérés. */
function sanitizeImportedState(parsed){
  const idPattern = /^[A-Za-z0-9_-]{1,40}$/;
  const idOrGen = (id, prefix) => (typeof id === 'string' && idPattern.test(id)) ? id : uid(prefix);
  const safeStr = (v, maxLen, fallback = '') => (typeof v === 'string' ? v.slice(0, maxLen) : fallback);
  const safeNum = (v, min, max, fallback) => (Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : fallback);

  const children = (Array.isArray(parsed.children) ? parsed.children : []).map(c => ({
    id: idOrGen(c?.id, 'c'),
    name: safeStr(c?.name, 24, 'Enfant'),
    avatar: EMOJIS.includes(c?.avatar) ? c.avatar : EMOJIS[0],
  }));

  const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : []).map(t => ({
    id: idOrGen(t?.id, 't'),
    label: safeStr(t?.label, 60, 'Mission'),
    type: t?.type === 'devoir' ? 'devoir' : 'menage',
    points: safeNum(t?.points, 1, 100, 1),
    schoolDaysOnly: !!t?.schoolDaysOnly,
  }));

  const rewards = (Array.isArray(parsed.rewards) ? parsed.rewards : []).map(r => ({
    id: idOrGen(r?.id, 'r'),
    label: safeStr(r?.label, 40, 'Récompense'),
    icon: REWARD_ICONS.includes(r?.icon) ? r.icon : REWARD_ICONS[0],
    cost: safeNum(r?.cost, 1, 1000, 1),
  }));

  const safeIconOrMonthly = (icon) => (icon === '💶' || REWARD_ICONS.includes(icon)) ? icon : REWARD_ICONS[0];

  const redemptions = (Array.isArray(parsed.redemptions) ? parsed.redemptions : []).map(r => ({
    id: idOrGen(r?.id, 'red'),
    ...(r?.kind === 'monthly' || r?.kind === 'request' ? { kind: r.kind } : {}),
    ...(r?.status === 'refused' ? { status: 'refused' } : {}),
    childId: safeStr(r?.childId, 40),
    ...(r?.rewardId !== undefined ? { rewardId: safeStr(r.rewardId, 40) } : {}),
    ...(r?.month !== undefined ? { month: safeStr(r.month, 7) } : {}),
    rewardLabel: safeStr(r?.rewardLabel, 40, 'Récompense'),
    rewardIcon: safeIconOrMonthly(r?.rewardIcon),
    date: safeStr(r?.date, 40, new Date().toISOString()),
    pointsSpent: safeNum(r?.pointsSpent, 0, 1000, 0),
    ...(r?.amount !== undefined ? { amount: safeNum(r.amount, 0, 1000, 0) } : {}),
  }));

  const pendingRequests = (Array.isArray(parsed.pendingRequests) ? parsed.pendingRequests : []).map(req => ({
    id: idOrGen(req?.id, 'req'),
    childId: safeStr(req?.childId, 40),
    rewardId: safeStr(req?.rewardId, 40),
    date: safeStr(req?.date, 40, new Date().toISOString()),
  }));

  const points = {};
  if (parsed.points && typeof parsed.points === 'object'){
    Object.entries(parsed.points).forEach(([childId, value]) => {
      points[childId] = safeNum(value, 0, 1000000, 0);
    });
  }

  return { children, tasks, rewards, redemptions, pendingRequests, points };
}

function importData(e){
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed || !Array.isArray(parsed.children) || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.rewards)){
        showToast('Fichier invalide', '⚠️');
        return;
      }
      const clean = sanitizeImportedState(parsed);
      state = Object.assign(defaultData(), parsed, clean);
      applyTheme();
      saveData();
      activeChildId = state.children[0]?.id || null;
      closeModal();
      render();
      showToast('Sauvegarde importée', '✅');
    } catch (err){
      showToast('Impossible de lire ce fichier', '⚠️');
    }
  };
  reader.readAsText(file);
}

/* ---------------------------- topbar bindings ---------------------------- */

function bindTopbar(){
  const btn = document.getElementById('btn-settings');
  if (btn) btn.onclick = openSettingsPanel;
  const closeBtn = document.getElementById('btn-close-app');
  if (closeBtn) closeBtn.onclick = openCloseAppFlow;
}

/* ---------------------------- démarrage ---------------------------- */

function init(){
  state = loadData();
  applyTheme();
  render();
  if (state.children.length === 0){
    // premier lancement : accueil avec bouton de configuration ou de connexion (voir renderEmptyState)
  }
  const familyCode = getFamilyCode();
  if (familyCode){
    ensureSignedIn()
      .then(() => subscribeToFamily(familyCode))
      .catch(() => showToast('Connexion au cloud impossible, données locales utilisées', '⚠️'));
  }
  if ('serviceWorker' in navigator){
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
}

document.addEventListener('DOMContentLoaded', init);
