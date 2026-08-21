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
const UNLOCKABLE_AVATARS = [
  { emoji: '🐲', minLevel: 3, label: 'Dragon' },
  { emoji: '🥷', minLevel: 4, label: 'Ninja' },
  { emoji: '🧙', minLevel: 5, label: 'Magicien' },
  { emoji: '🦸', minLevel: 6, label: 'Super-héros' },
  { emoji: '👑', minLevel: 8, label: 'Couronne' },
  { emoji: '🌟', minLevel: 10, label: 'Étoile' },
];
const REWARD_ICONS = ['📺','🎮','🎬','🍽️','🍦','🎳','🚲','🏊','🎨','⚽'];
const THEMES = {
  clair: { label: 'Clair', icon: '☀️' },
  ocean: { label: 'Océan', icon: '🌊' },
  corail: { label: 'Corail', icon: '🌺' },
  royaume: { label: 'Royaume', icon: '🏰' },
};

// 3 niveaux de difficulté par jeu de logique : plus de points et plus de choix de réponse
// (donc moins facile à deviner au hasard) sur les niveaux plus difficiles.
const DIFFICULTIES = [
  { id: 'facile', label: 'Facile', points: 1, optionCount: 3 },
  { id: 'moyen', label: 'Moyen', points: 2, optionCount: 4 },
  { id: 'difficile', label: 'Difficile', points: 3, optionCount: 5 },
];
const LOGIC_DAILY_COUNT = 6; // défis proposés chaque jour par jeu (au lieu de 10)

function difficultyConfig(difficultyId){
  return DIFFICULTIES.find(d => d.id === difficultyId) || DIFFICULTIES[0];
}

// Banque de mots "neutres" pour compléter les choix de réponse des jeux de mots/énigmes
// quand il faut plus d'options que de distracteurs déjà choisis à la main.
const GENERIC_DECOY_WORDS = [
  'pomme','chaise','stylo','nuage','vélo','table','ballon','lampe','crayon','arbre',
  'chat','chien','maison','fenêtre','porte','livre','montagne','rivière','étoile','soleil',
  'lune','fleur','oiseau','poisson','voiture','bateau','avion','chapeau','montre','bouteille',
  'gâteau','fromage','tomate','carotte','valise','tapis','miroir','coussin','parapluie','panier',
];

/* Complète une liste d'options jusqu'à targetCount, en ajoutant des distracteurs numériques
   proches de la réponse (numeric=true) ou des mots neutres de GENERIC_DECOY_WORDS, de façon
   déterministe (même index = mêmes distracteurs ajoutés à chaque appel). */
function extendOptions(baseOptions, answer, targetCount, index, numeric){
  const curated = [...new Set(baseOptions.filter(o => o !== answer))];
  let needed = targetCount - 1 - curated.length;
  if (numeric){
    const answerNum = Number(answer);
    let i = 0;
    while (needed > 0 && i < 40){
      let delta = ((index + i) % 7) + 1;
      if ((index + i) % 2 === 0) delta = -delta;
      const candidate = String(answerNum + delta);
      if (candidate !== answer && !curated.includes(candidate)){ curated.push(candidate); needed--; }
      i++;
    }
  } else {
    const bank = GENERIC_DECOY_WORDS.filter(w => w !== answer && !curated.includes(w));
    for (let i = 0; i < needed && bank.length; i++){
      curated.push(bank[(index + i * 7) % bank.length]);
    }
  }
  return [answer, ...curated.slice(0, targetCount - 1)];
}

function buildSeriesPool(difficultyId){
  const optionCount = difficultyConfig(difficultyId).optionCount;
  const cfg = { facile: { startBase: 2, stepBase: 2, stepMod: 3 }, moyen: { startBase: 10, stepBase: 4, stepMod: 6 }, difficile: { startBase: 20, stepBase: 6, stepMod: 9 } }[difficultyId];
  return Array.from({ length: 60 }, (_, index) => {
    const start = index + cfg.startBase;
    const step = (index % cfg.stepMod) + cfg.stepBase;
    const answer = start + step * 3;
    const options = extendOptions([String(answer), String(answer - 1), String(answer + 2)], String(answer), optionCount, index, true);
    return { text: `${start}, ${start + step}, ${start + step * 2}, ?`, answer: String(answer), options };
  });
}

function buildCalculPool(difficultyId){
  const optionCount = difficultyConfig(difficultyId).optionCount;
  const cfg = { facile: { aBase: 2, aMod: 9, bBase: 2, bMod: 4 }, moyen: { aBase: 11, aMod: 20, bBase: 3, bMod: 7 }, difficile: { aBase: 12, aMod: 18, bBase: 11, bMod: 12 } }[difficultyId];
  return Array.from({ length: 60 }, (_, index) => {
    const a = cfg.aBase + (index % cfg.aMod);
    const b = cfg.bBase + (index % cfg.bMod);
    const answer = a * b;
    const options = extendOptions([String(answer), String(answer + b), String(answer - a)], String(answer), optionCount, index, true);
    return { text: `${a} × ${b} = ?`, answer: String(answer), options };
  });
}

function buildIntrusPool(difficultyId){
  const optionCount = difficultyConfig(difficultyId).optionCount;
  const cfg = { facile: { base: 3, mult: [2, 4, 6] }, moyen: { base: 8, mult: [3, 6, 9] }, difficile: { base: 15, mult: [4, 7, 11] } }[difficultyId];
  return Array.from({ length: 60 }, (_, index) => {
    const answer = index + cfg.base;
    const values = [answer * cfg.mult[0], answer * cfg.mult[1], answer * cfg.mult[2], answer * cfg.mult[2] + 1];
    const options = extendOptions([String(values[3]), String(values[0]), String(values[1])], String(values[3]), optionCount, index, true);
    return { text: `Quel nombre est différent : ${values.join(' - ')} ?`, answer: String(values[3]), options };
  });
}

function buildWordPool(entries, difficultyId){
  const optionCount = difficultyConfig(difficultyId).optionCount;
  return entries.map(([text, answer, options], index) => ({ text, answer, options: extendOptions(options, answer, optionCount, index, false) }));
}

const LOGIC_GAMES = [
  {
    id: 'series', title: 'Les suites malignes', icon: '🔢', description: 'Trouve le nombre qui vient ensuite.',
    questionsByDifficulty: { facile: buildSeriesPool('facile'), moyen: buildSeriesPool('moyen'), difficile: buildSeriesPool('difficile') },
  },
  {
    id: 'calcul', title: 'Calcul express', icon: '🧮', description: 'Résous de petits calculs de tête.',
    questionsByDifficulty: { facile: buildCalculPool('facile'), moyen: buildCalculPool('moyen'), difficile: buildCalculPool('difficile') },
  },
  {
    id: 'intrus', title: 'Trouve l’intrus', icon: '🕵️', description: 'Repère le nombre qui ne suit pas la règle.',
    questionsByDifficulty: { facile: buildIntrusPool('facile'), moyen: buildIntrusPool('moyen'), difficile: buildIntrusPool('difficile') },
  },
  {
    id: 'mots', title: 'Mots et catégories', icon: '🧩', description: 'Choisis le mot qui appartient à la catégorie.',
    questionsByDifficulty: (() => {
      const entries = [
      ['Quel mot est un fruit ?', 'pomme', ['pomme', 'chaise', 'stylo']], ['Quel mot est un animal ?', 'lapin', ['lapin', 'nuage', 'fourchette']],
      ['Quel mot est une couleur ?', 'vert', ['vert', 'table', 'vélo']], ['Quel mot sert à écrire ?', 'crayon', ['crayon', 'ballon', 'pomme']],
      ['Quel mot est un moyen de transport ?', 'train', ['train', 'gâteau', 'oreiller']], ['Quel mot se mange ?', 'banane', ['banane', 'cahier', 'lampe']],
      ['Quel mot est un vêtement ?', 'pull', ['pull', 'fourchette', 'jardin']], ['Quel mot est dans la nature ?', 'rivière', ['rivière', 'téléphone', 'chaussure']],
      ['Quel mot est une forme ?', 'triangle', ['triangle', 'orange', 'bouteille']], ['Quel mot indique une saison ?', 'hiver', ['hiver', 'mouton', 'cartable']],
      ['Quel mot est un légume ?', 'carotte', ['carotte', 'ballon', 'stylo']], ['Quel mot est un instrument de musique ?', 'guitare', ['guitare', 'valise', 'nuage']],
      ['Quel mot est un oiseau ?', 'moineau', ['moineau', 'chat', 'poisson']], ['Quel mot est un sport ?', 'tennis', ['tennis', 'chaise', 'pomme']],
      ['Quel mot est un métier ?', 'pompier', ['pompier', 'table', 'arbre']], ['Quel mot est un jour de la semaine ?', 'mardi', ['mardi', 'avril', 'rouge']],
      ['Quel mot est un mois de l’année ?', 'juin', ['juin', 'lundi', 'bleu']], ['Quel mot est un pays ?', 'France', ['France', 'Lyon', 'stylo']],
      ['Quel mot est une partie du corps ?', 'genou', ['genou', 'table', 'nuage']], ['Quel mot est un meuble ?', 'armoire', ['armoire', 'chat', 'pomme']],
      ['Quel mot est un insecte ?', 'fourmi', ['fourmi', 'chien', 'table']], ['Quel mot est un arbre ?', 'chêne', ['chêne', 'chaise', 'ballon']],
      ['Quel mot est une boisson ?', 'jus', ['jus', 'crayon', 'lit']], ['Quel mot est un jouet ?', 'poupée', ['poupée', 'casserole', 'chaise']],
      ['Quel mot décrit un sentiment ?', 'joie', ['joie', 'table', 'pomme']], ['Quel mot est un outil ?', 'marteau', ['marteau', 'chat', 'nuage']],
      ['Quel mot est un moyen de communication ?', 'téléphone', ['téléphone', 'arbre', 'chaise']], ['Quel mot est une pièce de la maison ?', 'cuisine', ['cuisine', 'vélo', 'pomme']],
      ['Quel mot est une matière à l’école ?', 'mathématiques', ['mathématiques', 'chaise', 'pomme']], ['Quel mot est un fruit exotique ?', 'ananas', ['ananas', 'carotte', 'chaise']],
      ['Quel mot est un élément de la nature ?', 'montagne', ['montagne', 'stylo', 'chaise']], ['Quel mot est un véhicule ?', 'camion', ['camion', 'pomme', 'lit']],
      ['Quel mot est un animal marin ?', 'dauphin', ['dauphin', 'chat', 'arbre']], ['Quel mot est un accessoire ?', 'chapeau', ['chapeau', 'pomme', 'arbre']],
      ['Quel mot est une fête ?', 'Noël', ['Noël', 'table', 'pomme']], ['Quel mot est un chiffre en lettres ?', 'sept', ['sept', 'chaise', 'vélo']],
      ['Quel mot est un point cardinal ?', 'nord', ['nord', 'table', 'chat']], ['Quel mot est une saison ?', 'été', ['été', 'table', 'chat']],
      ['Quel mot est une forme géométrique ?', 'cercle', ['cercle', 'pomme', 'chaise']], ['Quel mot est un métal ?', 'fer', ['fer', 'pomme', 'chaise']],
      ];
      return { facile: buildWordPool(entries, 'facile'), moyen: buildWordPool(entries, 'moyen'), difficile: buildWordPool(entries, 'difficile') };
    })(),
  },
  {
    id: 'enigmes', title: 'Petites énigmes', icon: '💡', description: 'Réfléchis bien avant de répondre.',
    questionsByDifficulty: (() => {
      const entries = [
      ['J’ai 4 pattes mais je ne marche pas. Qui suis-je ?', 'table', ['table', 'chat', 'oiseau']], ['Je brille dans le ciel la nuit. Qui suis-je ?', 'lune', ['lune', 'chaise', 'pluie']],
      ['Je grandis quand on me nourrit et je meurs avec de l’eau. Qui suis-je ?', 'feu', ['feu', 'arbre', 'poisson']], ['J’ai des pages mais je ne suis pas un arbre. Qui suis-je ?', 'livre', ['livre', 'nuage', 'vélo']],
      ['Je tombe sans me faire mal et je mouille. Qui suis-je ?', 'pluie', ['pluie', 'pierre', 'soleil']], ['Je donne l’heure sans parler. Qui suis-je ?', 'horloge', ['horloge', 'fourchette', 'ballon']],
      ['Plus je sèche, plus je deviens mouillé. Qui suis-je ?', 'serviette', ['serviette', 'parapluie', 'sable']], ['J’ai des dents mais je ne mords pas. Qui suis-je ?', 'peigne', ['peigne', 'lion', 'nuage']],
      ['Je suis rond et je roule. Qui suis-je ?', 'ballon', ['ballon', 'livre', 'pantalon']], ['J’ai un cou mais pas de tête. Qui suis-je ?', 'bouteille', ['bouteille', 'poule', 'table']],
      ['J’ai des feuilles mais je ne suis pas un livre. Qui suis-je ?', 'arbre', ['arbre', 'cahier', 'chat']], ['Je vole sans ailes et je pleure sans yeux. Qui suis-je ?', 'nuage', ['nuage', 'oiseau', 'avion']],
      ['Plus on me creuse, plus je deviens grand. Qui suis-je ?', 'trou', ['trou', 'arbre', 'ballon']], ['J’ai un visage et deux aiguilles mais je ne couds pas. Qui suis-je ?', 'horloge', ['horloge', 'poupée', 'robot']],
      ['Je suis noir quand je suis propre et blanc quand je suis sale. Qui suis-je ?', 'tableau', ['tableau', 'chat', 'nuage']], ['On me lance et je reviens toujours tout seul. Qui suis-je ?', 'boomerang', ['boomerang', 'ballon', 'cerf-volant']],
      ['Je n’ai pas de bouche mais je raconte des histoires. Qui suis-je ?', 'livre', ['livre', 'radio', 'télévision']], ['Plus il fait chaud, plus vite je fonds. Qui suis-je ?', 'glaçon', ['glaçon', 'chocolat', 'beurre']],
      ['J’ai une couronne mais je ne suis pas roi. Qui suis-je ?', 'dent', ['dent', 'arbre', 'roi']], ['Je grandis en hiver et je fonds au printemps. Qui suis-je ?', 'bonhomme de neige', ['bonhomme de neige', 'sapin', 'ours']],
      ['J’ai un long cou mais je ne suis pas une girafe. Qui suis-je ?', 'bouteille', ['bouteille', 'pull', 'chaussette']], ['Je suis plein de trous mais je retiens l’eau. Qui suis-je ?', 'éponge', ['éponge', 'panier', 'passoire']],
      ['On me casse pour m’utiliser. Qui suis-je ?', 'œuf', ['œuf', 'verre', 'ballon']], ['Je monte quand la pluie descend. Qui suis-je ?', 'parapluie', ['parapluie', 'arc-en-ciel', 'cerf-volant']],
      ['Je claque quand je suis content mais je n’ai pas de mains. Qui suis-je ?', 'drapeau', ['drapeau', 'chien', 'porte']], ['Je vis dans une coquille dure mais je ne rampe pas. Qui suis-je ?', 'noix', ['noix', 'escargot', 'tortue']],
      ['Je fais du bruit quand on m’ouvre et quand on me ferme. Qui suis-je ?', 'porte', ['porte', 'livre', 'boîte']], ['Je suis rempli d’histoires mais je ne parle jamais. Qui suis-je ?', 'bibliothèque', ['bibliothèque', 'radio', 'télévision']],
      ['Je change de couleur avec les saisons mais je ne bouge pas. Qui suis-je ?', 'feuille', ['feuille', 'arbre', 'fleur']], ['Je porte plein de vêtements mais je n’ai pas de corps. Qui suis-je ?', 'armoire', ['armoire', 'valise', 'cintre']],
      ['Je tourne toute la journée sans jamais me fatiguer. Qui suis-je ?', 'ventilateur', ['ventilateur', 'horloge', 'roue']], ['Je suis plein au début et vide à la fin, mais je ne suis pas un verre. Qui suis-je ?', 'sablier', ['sablier', 'bouteille', 'verre']],
      ['J’ai un toit et des roues mais je ne suis pas une maison. Qui suis-je ?', 'voiture', ['voiture', 'vélo', 'tente']], ['Je suis fait de sucre et je fonds sur la langue. Qui suis-je ?', 'bonbon', ['bonbon', 'gâteau', 'glaçon']],
      ['Je brille de mille lumières la nuit mais je suis invisible le jour. Qui suis-je ?', 'étoile', ['étoile', 'lune', 'lampe']], ['J’ai quatre roues mais je ne suis pas une voiture, on me pousse dans les magasins. Qui suis-je ?', 'chariot', ['chariot', 'voiture', 'vélo']],
      ['Je suis rond, orange, et je pousse sur un arbre. Qui suis-je ?', 'orange', ['orange', 'citron', 'pomme']], ['On me met sur la tête pour se protéger du soleil. Qui suis-je ?', 'chapeau', ['chapeau', 'écharpe', 'gant']],
      ['Je suis fait de bois et je sers à écrire quand on me taille. Qui suis-je ?', 'crayon', ['crayon', 'stylo', 'gomme']], ['Je change de forme selon le vase qui me contient. Qui suis-je ?', 'eau', ['eau', 'air', 'sable']],
      ];
      return { facile: buildWordPool(entries, 'facile'), moyen: buildWordPool(entries, 'moyen'), difficile: buildWordPool(entries, 'difficile') };
    })(),
  },
];

let state = null;          // data loaded from localStorage
let activeChildId = null;  // currently selected child tab
let mainTab = 'accueil';   // onglet principal affiché : accueil / jeux / historique
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

/* Générateur pseudo-aléatoire déterministe (même seed = mêmes valeurs à chaque appel),
   utilisé pour tirer "les défis du jour" : identiques pour tout le monde ce jour-là,
   différents chaque jour, sans avoir besoin de stocker quoi que ce soit côté serveur. */
function seededRandom(seed){
  let value = seed >>> 0;
  return function(){
    value |= 0; value = (value + 0x6D2B79F5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dailySeed(str){
  let hash = 0;
  for (let i = 0; i < str.length; i++){
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function shuffledSeeded(items, rng){
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--){
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/* ---------------------------- sudoku du jour ---------------------------- */

const SUDOKU_DIFFICULTY_CONFIG = {
  facile: { clues: 40, points: 5 },
  moyen: { clues: 32, points: 8 },
  difficile: { clues: 26, points: 12 },
};

function sudokuEmptyGrid(){
  return Array.from({ length: 9 }, () => Array(9).fill(0));
}

function sudokuIsValid(grid, row, col, num){
  for (let i = 0; i < 9; i++){
    if (i !== col && grid[row][i] === num) return false;
    if (i !== row && grid[i][col] === num) return false;
  }
  const boxRow = Math.floor(row / 3) * 3, boxCol = Math.floor(col / 3) * 3;
  for (let r = 0; r < 3; r++){
    for (let c = 0; c < 3; c++){
      if ((boxRow + r !== row || boxCol + c !== col) && grid[boxRow + r][boxCol + c] === num) return false;
    }
  }
  return true;
}

function sudokuFillGrid(grid, rng){
  for (let pos = 0; pos < 81; pos++){
    const row = Math.floor(pos / 9), col = pos % 9;
    if (grid[row][col] !== 0) continue;
    for (const num of shuffledSeeded([1,2,3,4,5,6,7,8,9], rng)){
      if (sudokuIsValid(grid, row, col, num)){
        grid[row][col] = num;
        if (sudokuFillGrid(grid, rng)) return true;
        grid[row][col] = 0;
      }
    }
    return false;
  }
  return true;
}

/* Compte les solutions d'une grille (s'arrête dès que `limit` est atteint) — sert à vérifier
   qu'un indice retiré ne casse pas l'unicité de la solution du sudoku généré. */
function sudokuCountSolutions(grid, limit){
  let count = 0;
  function solve(){
    if (count >= limit) return;
    let row = -1, col = -1;
    outer: for (let r = 0; r < 9; r++){
      for (let c = 0; c < 9; c++){
        if (grid[r][c] === 0){ row = r; col = c; break outer; }
      }
    }
    if (row === -1){ count++; return; }
    for (let num = 1; num <= 9; num++){
      if (sudokuIsValid(grid, row, col, num)){
        grid[row][col] = num;
        solve();
        grid[row][col] = 0;
        if (count >= limit) return;
      }
    }
  }
  solve();
  return count;
}

const sudokuPuzzleCache = {};

/* Génère (et met en cache) le sudoku du jour pour une difficulté donnée : une grille pleine
   valide tirée au sort de façon déterministe (même sudoku pour tout le monde ce jour-là),
   puis des indices retirés un par un tant que la solution reste unique. */
function getSudokuPuzzle(dateStr, difficultyId){
  const key = dateStr + ':' + difficultyId;
  if (!sudokuPuzzleCache[key]){
    const rng = seededRandom(dailySeed('sudoku:' + key));
    const solution = sudokuEmptyGrid();
    sudokuFillGrid(solution, rng);
    const puzzle = solution.map(row => [...row]);
    const cellOrder = shuffledSeeded(Array.from({ length: 81 }, (_, i) => i), rng);
    const targetRemoved = 81 - SUDOKU_DIFFICULTY_CONFIG[difficultyId].clues;
    let removed = 0;
    for (const pos of cellOrder){
      if (removed >= targetRemoved) break;
      const row = Math.floor(pos / 9), col = pos % 9;
      const backup = puzzle[row][col];
      puzzle[row][col] = 0;
      const solCount = sudokuCountSolutions(puzzle.map(r => [...r]), 2);
      if (solCount === 1) removed++;
      else puzzle[row][col] = backup;
    }
    sudokuPuzzleCache[key] = { puzzle, solution };
  }
  return sudokuPuzzleCache[key];
}

function getSudokuState(childId, difficultyId){
  const dateStr = todayStr();
  const { puzzle } = getSudokuPuzzle(dateStr, difficultyId);
  const stored = state.sudokuProgress?.[childId]?.[difficultyId]?.[dateStr];
  if (stored && stored.grid) return stored;
  return { grid: puzzle.map(row => [...row]), completed: false };
}

function saveSudokuState(childId, difficultyId, sudokuState){
  if (!state.sudokuProgress) state.sudokuProgress = {};
  if (!state.sudokuProgress[childId]) state.sudokuProgress[childId] = {};
  if (!state.sudokuProgress[childId][difficultyId]) state.sudokuProgress[childId][difficultyId] = {};
  state.sudokuProgress[childId][difficultyId][todayStr()] = sudokuState;
}

function sudokuHasConflict(grid, row, col){
  const val = grid[row][col];
  return val ? !sudokuIsValid(grid, row, col, val) : false;
}

function sudokuIsComplete(grid){
  for (let r = 0; r < 9; r++){
    for (let c = 0; c < 9; c++){
      if (!grid[r][c] || sudokuHasConflict(grid, r, c)) return false;
    }
  }
  return true;
}

/* ---------------------------- 2048 ---------------------------- */

// Pas de "défi du jour" ici : contrairement aux autres jeux, 2048 se joue librement, sans
// limite quotidienne. Les points sont attribués une seule fois par palier de tuile atteint.
const GAME2048_MILESTONES = [
  { value: 128, points: 3 },
  { value: 256, points: 5 },
  { value: 512, points: 8 },
  { value: 1024, points: 12 },
  { value: 2048, points: 20 },
];

function empty2048Grid(){
  return Array.from({ length: 4 }, () => Array(4).fill(0));
}

function spawn2048Tile(grid){
  const empties = [];
  for (let r = 0; r < 4; r++){
    for (let c = 0; c < 4; c++){
      if (grid[r][c] === 0) empties.push([r, c]);
    }
  }
  if (!empties.length) return grid;
  const [r, c] = empties[Math.floor(Math.random() * empties.length)];
  grid[r][c] = Math.random() < 0.9 ? 2 : 4;
  return grid;
}

function new2048Grid(){
  const grid = empty2048Grid();
  spawn2048Tile(grid);
  spawn2048Tile(grid);
  return grid;
}

/* Compacte et fusionne une ligne vers l'index 0 (gauche/haut) — les 4 directions
   réutilisent cette même fonction en inversant la ligne au besoin avant/après. */
function compactAndMergeLine(line){
  const nums = line.filter(v => v !== 0);
  const merged = [];
  let scoreGained = 0;
  let i = 0;
  while (i < nums.length){
    if (i < nums.length - 1 && nums[i] === nums[i + 1]){
      const val = nums[i] * 2;
      merged.push(val);
      scoreGained += val;
      i += 2;
    } else {
      merged.push(nums[i]);
      i += 1;
    }
  }
  while (merged.length < line.length) merged.push(0);
  return { line: merged, scoreGained };
}

function move2048(grid, direction){
  const size = grid.length;
  const newGrid = Array.from({ length: size }, () => Array(size).fill(0));
  let scoreGained = 0, moved = false;
  if (direction === 'left' || direction === 'right'){
    for (let r = 0; r < size; r++){
      let line = grid[r].slice();
      if (direction === 'right') line = line.reverse();
      const { line: merged, scoreGained: gained } = compactAndMergeLine(line);
      scoreGained += gained;
      const finalLine = direction === 'right' ? merged.slice().reverse() : merged;
      newGrid[r] = finalLine;
      if (finalLine.some((v, i) => v !== grid[r][i])) moved = true;
    }
  } else {
    for (let c = 0; c < size; c++){
      let line = grid.map(row => row[c]);
      if (direction === 'down') line = line.reverse();
      const { line: merged, scoreGained: gained } = compactAndMergeLine(line);
      scoreGained += gained;
      const finalLine = direction === 'down' ? merged.slice().reverse() : merged;
      for (let r = 0; r < size; r++){
        newGrid[r][c] = finalLine[r];
        if (finalLine[r] !== grid[r][c]) moved = true;
      }
    }
  }
  return { grid: newGrid, scoreGained, moved };
}

function is2048GameOver(grid){
  for (let r = 0; r < 4; r++){
    for (let c = 0; c < 4; c++){
      if (grid[r][c] === 0) return false;
      if (c < 3 && grid[r][c] === grid[r][c + 1]) return false;
      if (r < 3 && grid[r][c] === grid[r + 1][c]) return false;
    }
  }
  return true;
}

/* Attribue les points des paliers de tuile fraîchement atteints (une seule fois chacun,
   à vie) et renvoie ce qui vient d'être débloqué pour l'affichage. */
function check2048Milestones(childId, grid){
  const maxTile = Math.max(...grid.flat());
  if (!state.game2048Milestones) state.game2048Milestones = {};
  if (!state.game2048Milestones[childId]) state.game2048Milestones[childId] = [];
  const already = state.game2048Milestones[childId];
  let totalPoints = 0;
  const newMilestones = [];
  for (const m of GAME2048_MILESTONES){
    if (maxTile >= m.value && !already.includes(m.value)){
      already.push(m.value);
      totalPoints += m.points;
      newMilestones.push(m);
    }
  }
  return { totalPoints, newMilestones };
}

function get2048State(childId){
  const stored = state.game2048?.[childId];
  if (stored && stored.grid) return stored;
  return { grid: new2048Grid(), score: 0, over: false };
}

function save2048State(childId, gameState){
  if (!state.game2048) state.game2048 = {};
  state.game2048[childId] = gameState;
}

/* Tire les 10 questions du jour pour un jeu donné, dans un ordre stable pour la journée
   (même famille ou pas), à partir d'un bassin de questions bien plus large. */
function dailyQuestionIndices(gameId, poolSize, count = LOGIC_DAILY_COUNT, dateStr = todayStr()){
  const rng = seededRandom(dailySeed(dateStr + ':' + gameId));
  const indices = Array.from({ length: poolSize }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--){
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, Math.min(count, poolSize));
}

function childLogicDifficulty(childId, gameId){
  return state.logicDifficulty?.[childId]?.[gameId] || 'facile';
}

function setChildLogicDifficulty(childId, gameId, difficultyId){
  if (!state.logicDifficulty) state.logicDifficulty = {};
  if (!state.logicDifficulty[childId]) state.logicDifficulty[childId] = {};
  state.logicDifficulty[childId][gameId] = difficultyId;
}

function getTodaysQuestions(game, difficultyId){
  const pool = game.questionsByDifficulty[difficultyId];
  return dailyQuestionIndices(game.id + ':' + difficultyId, pool.length).map(i => pool[i]);
}

/* Petite pluie de confettis pour célébrer une réussite (mission validée, bonne réponse,
   récompense débloquée...). Purement visuel, respecte prefers-reduced-motion. */
function launchConfetti(){
  const colors = ['var(--gold)', 'var(--coral)', 'var(--sky)', 'var(--green-ok)'];
  const wrap = document.createElement('div');
  wrap.className = 'confetti';
  for (let i = 0; i < 24; i++){
    const piece = document.createElement('span');
    piece.style.left = (Math.random() * 100) + 'vw';
    piece.style.background = colors[i % colors.length];
    piece.style.animationDuration = (1 + Math.random() * 0.8) + 's';
    piece.style.animationDelay = (Math.random() * 0.2) + 's';
    piece.style.borderRadius = Math.random() > 0.5 ? '50%' : '3px';
    wrap.appendChild(piece);
  }
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 2200);
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
    const data = Object.assign(defaultData(), snapshot.data());
    const migrated = migrateData(data);
    state = data;
    applyTheme();
    if (!activeChildId || !getChild(activeChildId)) activeChildId = state.children[0]?.id || null;
    render();
    if (migrated) saveData();
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
    theme: 'royaume',
    pinHash: null,
    notificationsEnabled: false,
    lastExportAt: null,
    children: [],
    tasks: [
      { id: uid('t'), label: 'Ranger sa chambre', type: 'menage', points: 4, schoolDaysOnly: false },
      { id: uid('t'), label: 'Faire son lit', type: 'menage', points: 2, schoolDaysOnly: false },
      { id: uid('t'), label: 'Ranger ses affaires', type: 'menage', points: 3, schoolDaysOnly: false },
      { id: uid('t'), label: 'Mettre ou débarrasser la table', type: 'menage', points: 2, schoolDaysOnly: false },
      { id: uid('t'), label: 'Vider le lave-vaisselle', type: 'menage', points: 2, schoolDaysOnly: false },
      { id: uid('t'), label: 'Remplir le lave-vaisselle', type: 'menage', points: 2, schoolDaysOnly: false },
      { id: uid('t'), label: 'Sortir les poubelles', type: 'menage', points: 1, schoolDaysOnly: false },
      { id: uid('t'), label: 'Aider ses parents', type: 'menage', points: 3, schoolDaysOnly: false },
      { id: uid('t'), label: 'Aider à préparer le repas', type: 'menage', points: 4, schoolDaysOnly: false },
      { id: uid('t'), label: 'Nourrir l’animal', type: 'menage', points: 1, schoolDaysOnly: false },
      { id: uid('t'), label: 'Arroser les plantes', type: 'menage', points: 1, schoolDaysOnly: false },
      { id: uid('t'), label: 'Faire les devoirs', type: 'devoir', points: 6, schoolDaysOnly: true },
      { id: uid('t'), label: 'Lire 15 minutes', type: 'devoir', points: 2, schoolDaysOnly: false },
      { id: uid('t'), label: 'Lire 30 minutes', type: 'devoir', points: 4, schoolDaysOnly: false },
    ],
    rewards: [
      { id: uid('r'), label: 'Télévision / écran', icon: '📺', cost: 15 },
      { id: uid('r'), label: 'Nintendo Switch', icon: '🎮', cost: 30 },
      { id: uid('r'), label: 'Cinéma', icon: '🎬', cost: 70 },
      { id: uid('r'), label: 'Restaurant', icon: '🍽️', cost: 120 },
    ],
    monthlyRewardEnabled: true,  // récompense en argent pour un mois de missions complet
    monthlyRewardAmount: 20,     // montant en euros de cette récompense
    points: {},          // { childId: totalPointsDisponibles }
    completions: {},      // { 'YYYY-MM-DD': { childId: [taskId, ...] } }
    redemptions: [],      // { id, childId, rewardId, rewardLabel, date, pointsSpent }
    pendingRequests: [],  // { id, childId, rewardId, date }
    logicProgress: {},     // { childId: { gameId: { difficultyId: { 'YYYY-MM-DD': [questionIndex du jour, ...] } } } }
    logicTotalSolved: {},  // { childId: nombre total de défis réussis (toutes dates confondues) }
    logicDifficulty: {},    // { childId: { gameId: 'facile' | 'moyen' | 'difficile' } }
    sudokuProgress: {},      // { childId: { difficultyId: { 'YYYY-MM-DD': { grid, completed } } } }
    game2048: {},            // { childId: { grid, score, over } }
    game2048Milestones: {},  // { childId: [128, 256, ...] paliers de tuile déjà récompensés }
    wheelSpins: {},         // { childId: { week: 'YYYY-Www', prize: { label, points } } }
    pets: {},                // { childId: { species, totalFeeds, lastFedAt } }
    teamGoalEnabled: false,
    teamGoalThreshold: 60,   // points cumulés (tous enfants) à atteindre chaque semaine
    teamGoalLabel: 'Une sortie en famille',
    teamGoalClaims: {},      // { 'YYYY-Www': true } semaines déjà célébrées
    lootChestsOpened: {},    // { childId: nombre total de coffres ouverts }
  };
}

/* Normalise et migre un objet de données (locale ou reçue du cloud) vers l'état le plus
   récent, en une seule fois par étape de migration (marquée par un indicateur dans les
   données elles-mêmes). Retourne true si quelque chose a changé (donc à re-sauvegarder). */
function migrateData(data){
  let changed = false;
  if (!Array.isArray(data.redemptions)) data.redemptions = [];
  if (!Array.isArray(data.pendingRequests)) data.pendingRequests = [];
  if (!data.logicProgress || typeof data.logicProgress !== 'object') data.logicProgress = {};
  if (!data.wheelSpins || typeof data.wheelSpins !== 'object') data.wheelSpins = {};
  if (!data.sudokuProgress || typeof data.sudokuProgress !== 'object') data.sudokuProgress = {};
  if (!data.game2048 || typeof data.game2048 !== 'object') data.game2048 = {};
  if (!data.game2048Milestones || typeof data.game2048Milestones !== 'object') data.game2048Milestones = {};
  if (!data.pets || typeof data.pets !== 'object') data.pets = {};
  Object.values(data.pets).forEach(pet => {
    if (typeof pet.happiness !== 'number') pet.happiness = 100;
    if (!pet.lastHappinessCheckAt) pet.lastHappinessCheckAt = Date.now();
    if (pet.lastPettedAt === undefined) pet.lastPettedAt = null;
  });
  (data.children || []).forEach(child => {
    if (child.age === undefined) child.age = null;
    if (typeof child.vacationMode !== 'boolean') child.vacationMode = false;
    if (child.vacationSince === undefined) child.vacationSince = null;
    if (!Array.isArray(child.vacationRanges)) child.vacationRanges = [];
  });
  if (typeof data.teamGoalEnabled !== 'boolean') data.teamGoalEnabled = false;
  if (typeof data.teamGoalThreshold !== 'number' || data.teamGoalThreshold <= 0) data.teamGoalThreshold = 60;
  if (typeof data.teamGoalLabel !== 'string' || !data.teamGoalLabel) data.teamGoalLabel = 'Une sortie en famille';
  if (!data.teamGoalClaims || typeof data.teamGoalClaims !== 'object') data.teamGoalClaims = {};
  if (!data.lootChestsOpened || typeof data.lootChestsOpened !== 'object') data.lootChestsOpened = {};

  // Migration ponctuelle (une seule fois) : ajoute les missions ménage introduites
  // après la première version, sans les ré-ajouter si le parent les a supprimées ensuite.
  if (!data.extraTasksMigrated_v2){
    if (!data.tasks.some(task => task.label === 'Aider ses parents')){
      data.tasks.push({ id: uid('t'), label: 'Aider ses parents', type: 'menage', points: 3, schoolDaysOnly: false });
    }
    const extraTasks = [
      ['Faire son lit', 2],
      ['Ranger ses affaires', 3],
      ['Aider à préparer le repas', 4],
      ['Nourrir l’animal', 1],
      ['Arroser les plantes', 1],
    ];
    extraTasks.forEach(([label, points]) => {
      if (!data.tasks.some(task => task.label === label)){
        data.tasks.push({ id: uid('t'), label, type: 'menage', points, schoolDaysOnly: false });
      }
    });
    data.extraTasksMigrated_v2 = true;
    changed = true;
  }
  // Migration ponctuelle v3 : missions table/lave-vaisselle/lecture ajoutées ensuite.
  if (!data.extraTasksMigrated_v3){
    const extraTasksV3 = [
      ['Mettre ou débarrasser la table', 'menage', 2, false],
      ['Vider le lave-vaisselle', 'menage', 2, false],
      ['Remplir le lave-vaisselle', 'menage', 2, false],
      ['Lire 30 minutes', 'devoir', 4, false],
    ];
    extraTasksV3.forEach(([label, type, points, schoolDaysOnly]) => {
      if (!data.tasks.some(task => task.label === label)){
        data.tasks.push({ id: uid('t'), label, type, points, schoolDaysOnly });
      }
    });
    data.extraTasksMigrated_v3 = true;
    changed = true;
  }
  // Migration ponctuelle v4 : rééquilibrage des points (les récompenses étaient atteintes
  // trop vite) + fusion des missions "table" redondantes. Ne touche pas aux valeurs déjà
  // personnalisées manuellement par le parent (seules les valeurs par défaut d'origine sont mises à jour).
  if (!data.pointsRebalanced_v4){
    const oldTaskPoints = {
      'Ranger sa chambre': 5, 'Faire son lit': 3, 'Ranger ses affaires': 4,
      'Mettre ou débarrasser la table': 4, 'Vider le lave-vaisselle': 3, 'Remplir le lave-vaisselle': 3,
      'Sortir les poubelles': 3, 'Aider ses parents': 5, 'Aider à préparer le repas': 5,
      'Nourrir l’animal': 3, 'Arroser les plantes': 2, 'Faire les devoirs': 8,
      'Lire 15 minutes': 4, 'Lire 30 minutes': 8,
    };
    const newTaskPoints = {
      'Ranger sa chambre': 4, 'Faire son lit': 2, 'Ranger ses affaires': 3,
      'Mettre ou débarrasser la table': 2, 'Vider le lave-vaisselle': 2, 'Remplir le lave-vaisselle': 2,
      'Sortir les poubelles': 1, 'Aider ses parents': 3, 'Aider à préparer le repas': 4,
      'Nourrir l’animal': 1, 'Arroser les plantes': 1, 'Faire les devoirs': 6,
      'Lire 15 minutes': 2, 'Lire 30 minutes': 4,
    };
    data.tasks.forEach(task => {
      if (oldTaskPoints[task.label] !== undefined && task.points === oldTaskPoints[task.label]){
        task.points = newTaskPoints[task.label];
      }
    });
    // Supprime "Mettre la table" / "Débarrasser / vaisselle" si la version fusionnée existe déjà
    if (data.tasks.some(t => t.label === 'Mettre ou débarrasser la table')){
      data.tasks = data.tasks.filter(t => t.label !== 'Mettre la table' && t.label !== 'Débarrasser / vaisselle');
    }
    const oldRewardCosts = { 'Télévision / écran': 15, 'Nintendo Switch': 25, 'Cinéma': 50, 'Restaurant': 80 };
    const newRewardCosts = { 'Télévision / écran': 15, 'Nintendo Switch': 30, 'Cinéma': 70, 'Restaurant': 120 };
    data.rewards.forEach(reward => {
      if (oldRewardCosts[reward.label] !== undefined && reward.cost === oldRewardCosts[reward.label]){
        reward.cost = newRewardCosts[reward.label];
      }
    });
    data.pointsRebalanced_v4 = true;
    changed = true;
  }
  // Migration ponctuelle v5 : le thème Royaume devient l'apparence par défaut.
  // Ne touche pas au thème si le parent l'a déjà changé pour autre chose que "clair"
  // (l'ancien défaut) — dans ce cas, son choix est respecté.
  if (!data.themeMigrated_v5){
    if (data.theme === 'clair'){
      data.theme = 'royaume';
    }
    data.themeMigrated_v5 = true;
    changed = true;
  }
  // Migration ponctuelle v6 : les jeux de logique passent d'un jeu unique (50 défis au
  // total, vite épuisés) à 10 défis renouvelés chaque jour par catégorie. L'ancien
  // format ({ gameId: [index, ...] }) est converti en format par date ({ gameId: { date:
  // [index, ...] } }), et le nombre déjà réussi est crédité dans le compteur à vie plutôt
  // que perdu.
  if (!data.logicDailyMigrated_v6){
    if (!data.logicTotalSolved) data.logicTotalSolved = {};
    Object.entries(data.logicProgress || {}).forEach(([childId, byGame]) => {
      Object.entries(byGame || {}).forEach(([gameId, value]) => {
        if (Array.isArray(value)){
          data.logicTotalSolved[childId] = (data.logicTotalSolved[childId] || 0) + value.length;
          data.logicProgress[childId][gameId] = {};
        }
      });
    });
    data.logicDailyMigrated_v6 = true;
    changed = true;
  }
  // Migration ponctuelle v7 : ajout de niveaux de difficulté (facile/moyen/difficile) par
  // jeu de logique. L'ancien format ({ gameId: { date: [index, ...] } }) est converti en
  // format par difficulté ({ gameId: { difficulté: { date: [index, ...] } } }) — les
  // progrès déjà faits sont conservés sous "facile" (seul niveau qui existait avant).
  if (!data.logicDifficultyMigrated_v7){
    if (!data.logicDifficulty) data.logicDifficulty = {};
    Object.entries(data.logicProgress || {}).forEach(([childId, byGame]) => {
      Object.entries(byGame || {}).forEach(([gameId, byDateOrDifficulty]) => {
        const keys = Object.keys(byDateOrDifficulty || {});
        const looksLikeDates = keys.some(k => /^\d{4}-\d{2}-\d{2}$/.test(k));
        if (looksLikeDates){
          data.logicProgress[childId][gameId] = { facile: byDateOrDifficulty };
        }
      });
    });
    data.logicDifficultyMigrated_v7 = true;
    changed = true;
  }
  return changed;
}

function loadData(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultData();
    const parsed = JSON.parse(raw);
    // fusion douce avec les valeurs par défaut pour compat future
    const data = Object.assign(defaultData(), parsed);
    migrateData(data);
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

/* Points gagnés à vie (jamais décroissant), reconstitués à partir du solde actuel + tout ce
   qui a été dépensé en récompenses ou retiré en pénalité. Sert de base au niveau : dépenser
   ou se faire retirer des points ne fait donc jamais redescendre de niveau. */
function lifetimePoints(childId){
  const spentOrRemoved = state.redemptions
    .filter(r => r.childId === childId)
    .reduce((sum, r) => sum + (r.pointsSpent || 0) + (r.pointsRemoved || 0), 0);
  return getPoints(childId) + spentOrRemoved;
}

const XP_PER_LEVEL = 50;
const LEVEL_TITLES = ['Apprenti', 'Aide précieux', 'Champion du quotidien', 'Héros de la maison', 'Champion de la maison', 'Légende du Royaume'];

/* Économie de points allégée pour les tout-petits : moins de points nécessaires pour monter
   de niveau, récompenses moins chères. Les valeurs de base (missions, coûts des récompenses)
   ne changent pas — seul l'effet pour un enfant concerné est recalculé à l'affichage. */
const YOUNG_CHILD_MAX_AGE = 6; // en dessous de cet âge (non inclus)
const YOUNG_XP_PER_LEVEL = 25;
const YOUNG_REWARD_COST_MULTIPLIER = 0.5;

function isYoungChild(child){
  return typeof child?.age === 'number' && child.age < YOUNG_CHILD_MAX_AGE;
}

function effectiveXpPerLevel(child){
  return isYoungChild(child) ? YOUNG_XP_PER_LEVEL : XP_PER_LEVEL;
}

function effectiveRewardCost(child, reward){
  return isYoungChild(child) ? Math.max(1, Math.round(reward.cost * YOUNG_REWARD_COST_MULTIPLIER)) : reward.cost;
}

function levelInfo(points, xpPerLevel = XP_PER_LEVEL){
  const level = 1 + Math.floor(points / xpPerLevel);
  const into = points % xpPerLevel;
  return { level, into, pct: Math.round((into / xpPerLevel) * 100), title: LEVEL_TITLES[Math.min(level - 1, LEVEL_TITLES.length - 1)] };
}

function childLevelInfo(child){
  return levelInfo(lifetimePoints(child.id), effectiveXpPerLevel(child));
}

/* Nombre de jours consécutifs (jusqu'à hier ou aujourd'hui) où toutes les missions du jour
   ont été faites. */
function computeStreak(childId){
  let streak = 0;
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  for (let i = 0; i < 365; i++){
    const dateStr = cursor.getFullYear() + '-' + String(cursor.getMonth()+1).padStart(2,'0') + '-' + String(cursor.getDate()).padStart(2,'0');
    if (isDateInVacation(childId, dateStr)){ cursor.setDate(cursor.getDate() - 1); continue; }
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

/* Nombre de missions d'un type donné (ou tous types) accomplies à vie par un enfant,
   d'après l'historique des complétions journalières. */
function lifetimeMissionsCount(childId, type){
  let count = 0;
  Object.values(state.completions).forEach(byChild => {
    const doneIds = byChild[childId];
    if (!doneIds) return;
    doneIds.forEach(taskId => {
      if (!type) { count++; return; }
      const task = state.tasks.find(t => t.id === taskId);
      if (task && task.type === type) count++;
    });
  });
  return count;
}

const BADGES = [
  { id: 'first_mission', icon: '🥇', label: 'Première mission', check: cid => lifetimeMissionsCount(cid) >= 1 },
  { id: 'streak_7', icon: '🔥', label: '7 jours d\'affilée', check: cid => computeStreak(cid) >= 7 },
  { id: 'streak_30', icon: '🌟', label: '30 jours d\'affilée', check: cid => computeStreak(cid) >= 30 },
  { id: 'menage_50', icon: '🧹', label: '50 missions ménage', check: cid => lifetimeMissionsCount(cid, 'menage') >= 50 },
  { id: 'devoir_30', icon: '📚', label: '30 missions devoirs', check: cid => lifetimeMissionsCount(cid, 'devoir') >= 30 },
  { id: 'logic_50', icon: '🧠', label: '50 défis de logique', check: cid => logicTotalSolved(cid) >= 50 },
  { id: 'first_reward', icon: '🎁', label: 'Première récompense', check: cid => state.redemptions.some(r => r.childId === cid && r.pointsSpent > 0) },
  { id: 'level_5', icon: '👑', label: 'Niveau 5 atteint', check: cid => childLevelInfo(getChild(cid)).level >= 5 },
  { id: 'loot_chest', icon: '📦', label: 'Premier coffre ouvert', check: cid => (state.lootChestsOpened[cid] || 0) >= 1 },
];

/* Points gagnés par semaine sur les `weeks` dernières semaines (la plus récente en dernier),
   recalculés à partir de l'historique des complétions et des points actuels des missions. */
function weeklyPointsSeries(childId, weeks = 8){
  const days = weeks * 7;
  const daily = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - (days - 1));
  for (let i = 0; i < days; i++){
    const dateStr = cursor.getFullYear() + '-' + String(cursor.getMonth()+1).padStart(2,'0') + '-' + String(cursor.getDate()).padStart(2,'0');
    const doneIds = state.completions[dateStr]?.[childId] || [];
    const pts = doneIds.reduce((sum, taskId) => {
      const task = state.tasks.find(t => t.id === taskId);
      return sum + (task ? task.points : 0);
    }, 0);
    daily.push(pts);
    cursor.setDate(cursor.getDate() + 1);
  }
  const weekly = [];
  for (let w = 0; w < weeks; w++){
    weekly.push(daily.slice(w*7, w*7+7).reduce((s,v)=>s+v,0));
  }
  return weekly;
}

/* Clé de semaine ISO (ex. "2026-W34"), utilisée pour la roue de la chance (une fois par
   semaine) et le défi frère/sœur (comparaison sur la semaine calendaire en cours). */
function weekKey(date = new Date()){
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNo = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return d.getFullYear() + '-W' + String(weekNo).padStart(2, '0');
}

/* Points gagnés depuis le lundi de la semaine calendaire en cours (pas une fenêtre
   glissante de 7 jours, pour que tous les enfants soient comparés sur la même période). */
function pointsThisWeek(childId){
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  let sum = 0;
  for (let i = 0; i < 7; i++){
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    if (d > now) break;
    const dateStr = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    const doneIds = state.completions[dateStr]?.[childId] || [];
    sum += doneIds.reduce((s, taskId) => {
      const task = state.tasks.find(t => t.id === taskId);
      return s + (task ? task.points : 0);
    }, 0);
  }
  return sum;
}

const WHEEL_PRIZES = [
  { label: '+1 point bonus', points: 1, weight: 30 },
  { label: '+2 points bonus', points: 2, weight: 25 },
  { label: '+3 points bonus', points: 3, weight: 20 },
  { label: '+5 points bonus', points: 5, weight: 15 },
  { label: '🎉 Jackpot ! +10 points', points: 10, weight: 7 },
  { label: '👑 Méga jackpot ! +15 points', points: 15, weight: 3 },
];

const LOOT_CHEST_COST = 5;
const LOOT_CHEST_PRIZES = [
  { label: '+2 points', points: 2, weight: 30 },
  { label: '+4 points', points: 4, weight: 25 },
  { label: '+6 points', points: 6, weight: 20 },
  { label: '+8 points', points: 8, weight: 15 },
  { label: '🎉 +15 points', points: 15, weight: 7 },
  { label: '👑 +25 points', points: 25, weight: 3 },
];

function pickWeightedPrize(prizes){
  const total = prizes.reduce((sum, p) => sum + p.weight, 0);
  let r = Math.random() * total;
  for (const prize of prizes){
    if (r < prize.weight) return prize;
    r -= prize.weight;
  }
  return prizes[0];
}

// Chaque étape doit rester visuellement la même créature en train de grandir (pas un
// animal générique sans rapport, ex. un poussin qui "deviendrait" un dragon) : quand il
// n'existe pas d'emoji "bébé X" cohérent, on garde l'animal final dès l'éclosion et on
// réserve l'étape ultime (25 fois nourri) à une version "✨" plus majestueuse.
const PET_SPECIES = {
  dragon: { label: 'Dragon', stages: ['🥚', '🦎', '🐲', '🐉'] },
  licorne: { label: 'Licorne', stages: ['🥚', '🦄', '🦄', '🦄✨'] },
  renard: { label: 'Renard', stages: ['🥚', '🦊', '🦊', '🦊✨'] },
  papillon: { label: 'Papillon', stages: ['🥚', '🐛', '🦋', '🦋✨'] },
  chat: { label: 'Chat', stages: ['🥚', '🐱', '🐈', '🐈✨'] },
  hibou: { label: 'Hibou', stages: ['🥚', '🦉', '🦉', '🦉✨'] },
};
const PET_FEED_COST = 2;
const PET_STAGE_THRESHOLDS = [0, 1, 10, 25]; // nombre de fois nourri pour atteindre chaque stade
const PET_HUNGER_DECAY_HOURS = 48; // temps pour retomber de 100 à 0 sans être nourri
const PET_HAPPINESS_DECAY_HOURS = 72; // temps pour retomber de 100 à 0 sans être caressé
const PET_PAT_COOLDOWN_MS = 60 * 1000; // délai minimum entre deux caresses
const PET_PAT_GAIN = 20; // bonheur gagné par caresse

function petStageIndex(totalFeeds){
  let idx = 0;
  PET_STAGE_THRESHOLDS.forEach((threshold, i) => { if (totalFeeds >= threshold) idx = i; });
  return idx;
}

/* "Maintenant" utilisé pour la décroissance faim/bonheur : figé au moment où les vacances
   ont commencé tant que le mode est actif, pour que le compagnon ne perde rien pendant
   l'absence. Au retour, setVacationMode() décale les horodatages pour effacer la pause. */
function petEffectiveNow(childId){
  const child = getChild(childId);
  if (child && child.vacationMode && child.vacationSince) return child.vacationSince;
  return Date.now();
}

function petHunger(pet, childId){
  if (!pet.lastFedAt) return 0;
  const hoursSince = (petEffectiveNow(childId) - pet.lastFedAt) / 3600000;
  return Math.max(0, Math.min(100, Math.round(100 - hoursSince * (100 / PET_HUNGER_DECAY_HOURS))));
}

/* Le bonheur est stocké comme une valeur (pas seulement un horodatage comme la faim) car
   une caresse doit AJOUTER à la valeur déjà décayée, pas la remplacer par un plein — la
   lecture applique la décroissance depuis le dernier "checkpoint" sans le modifier. */
function petHappiness(pet, childId){
  if (typeof pet.happiness !== 'number') return 100;
  if (!pet.lastHappinessCheckAt) return pet.happiness;
  const hoursSince = (petEffectiveNow(childId) - pet.lastHappinessCheckAt) / 3600000;
  return Math.max(0, Math.min(100, Math.round(pet.happiness - hoursSince * (100 / PET_HAPPINESS_DECAY_HOURS))));
}

/* Fige la valeur de bonheur décayée dans pet.happiness avant de la modifier (ex. caresse),
   pour ne pas perdre la décroissance déjà écoulée. */
function checkpointHappiness(pet, childId){
  pet.happiness = petHappiness(pet, childId);
  pet.lastHappinessCheckAt = Date.now();
}

function petPatOnCooldown(pet){
  return !!(pet.lastPettedAt && (Date.now() - pet.lastPettedAt) < PET_PAT_COOLDOWN_MS);
}

function petNeedsAttention(childId){
  const pet = state.pets[childId];
  const child = getChild(childId);
  if (!pet || (child && child.vacationMode)) return false;
  return petHunger(pet, childId) < 30 || petHappiness(pet, childId) < 30;
}

/* Bascule le mode vacances d'un enfant. À la désactivation, décale les horodatages du
   compagnon de la durée de la pause pour que faim/bonheur reprennent exactement où ils en
   étaient (aucune pénalité pour l'absence). */
function setVacationMode(child, on){
  if (on){
    child.vacationMode = true;
    child.vacationSince = Date.now();
    if (!Array.isArray(child.vacationRanges)) child.vacationRanges = [];
    child.vacationRanges.push({ start: todayStr(), end: null });
  } else {
    if (child.vacationMode && child.vacationSince){
      const pauseDurationMs = Date.now() - child.vacationSince;
      const pet = state.pets[child.id];
      if (pet){
        if (pet.lastFedAt) pet.lastFedAt += pauseDurationMs;
        checkpointHappiness(pet, child.id);
        pet.lastHappinessCheckAt += pauseDurationMs;
        if (pet.lastPettedAt) pet.lastPettedAt += pauseDurationMs;
      }
    }
    child.vacationMode = false;
    child.vacationSince = null;
    if (Array.isArray(child.vacationRanges) && child.vacationRanges.length){
      const last = child.vacationRanges[child.vacationRanges.length - 1];
      if (last.end === null) last.end = todayStr();
    }
  }
}

function isDateInVacation(childId, dateStr){
  const child = getChild(childId);
  if (!child || !Array.isArray(child.vacationRanges)) return false;
  return child.vacationRanges.some(r => dateStr >= r.start && (!r.end || dateStr <= r.end));
}

function petMoodLabel(hunger, happiness){
  if (hunger < 30) return 'a très faim, nourris-le vite !';
  if (happiness < 30) return 'se sent un peu seul, caresse-le !';
  if (hunger >= 70 && happiness >= 70) return 'est aux anges !';
  return 'va bien.';
}

/* Somme des points gagnés cette semaine par tous les enfants, pour l'objectif d'équipe. */
function teamGoalProgress(){
  return state.children.reduce((sum, c) => sum + pointsThisWeek(c.id), 0);
}

/* À appeler après tout changement de missions accomplies : célèbre (une seule fois par
   semaine) le franchissement de l'objectif d'équipe. */
function checkTeamGoal(){
  if (!state.teamGoalEnabled) return;
  const wk = weekKey();
  if (state.teamGoalClaims[wk]) return;
  if (teamGoalProgress() >= state.teamGoalThreshold){
    state.teamGoalClaims[wk] = true;
    saveData();
    launchConfetti();
    showToast(`Objectif d'équipe atteint : ${state.teamGoalLabel} !`, '🤝');
  }
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
    launchConfetti();
  } else {
    list.splice(idx, 1);
    addPoints(childId, -task.points);
  }
  saveData();
  checkTeamGoal();
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

  const tabContent = mainTab === 'jeux' ? `
      ${renderLogicGames()}
      ${renderSudoku()}
      ${render2048()}
      ${renderBadges()}
      ${renderWheel()}
      ${renderLootChest()}
    ` : mainTab === 'compagnon' ? `
      ${renderCompagnonTab()}
    ` : mainTab === 'historique' ? `
      ${renderCalendar()}
      ${renderHistory()}
    ` : `
      ${renderBackupReminder()}
      ${renderTeamGoal()}
      ${renderSiblingChallenge()}
      ${renderBoard()}
    `;

  app.innerHTML = `
    ${renderTopbar()}
    ${renderChildRow()}
    ${tabContent}
    <p class="footer-note">Données stockées uniquement sur cet appareil · Mission Famille</p>
    ${renderBottomNav()}
  `;
  bindTopbar();
  bindChildRow();
  bindBottomNav();
  if (mainTab === 'jeux'){
    bindLogicGames();
    bindSudoku();
    bind2048();
    bindBadges();
    bindWheel();
    bindLootChest();
  } else if (mainTab === 'compagnon'){
    bindCompagnonTab();
  } else if (mainTab === 'historique'){
    bindCalendar();
  } else {
    bindBackupReminder();
    bindBoard();
  }
}

function renderBottomNav(){
  const tabs = [
    { id: 'accueil', icon: '🏠', label: 'Accueil' },
    { id: 'jeux', icon: '🎮', label: 'Jeux' },
    { id: 'compagnon', icon: '🐾', label: 'Compagnon' },
    { id: 'historique', icon: '📅', label: 'Historique' },
  ];
  const needsAttention = petNeedsAttention(activeChildId);
  return `
  <nav class="bottom-nav">
    ${tabs.map(t => `
      <button class="bottom-nav-btn ${mainTab === t.id ? 'active' : ''}" data-main-tab="${t.id}">
        <span class="bottom-nav-icon-wrap">
          <span class="bottom-nav-icon">${t.icon}</span>
          ${t.id === 'compagnon' && needsAttention ? '<span class="bottom-nav-dot"></span>' : ''}
        </span>
        <span class="bottom-nav-label">${t.label}</span>
      </button>`).join('')}
  </nav>`;
}

function bindBottomNav(){
  document.querySelectorAll('[data-main-tab]').forEach(el => {
    el.onclick = () => { mainTab = el.dataset.mainTab; render(); };
  });
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

function xpRingSvg(percent, avatar, level){
  const r = 22, c = 2 * Math.PI * r;
  const offset = c - (percent/100) * c;
  return `
  <div class="xp-ring-wrap">
    <svg width="52" height="52" viewBox="0 0 52 52">
      <circle class="xp-ring-bg" cx="26" cy="26" r="${r}"></circle>
      <circle class="xp-ring-fg" cx="26" cy="26" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${offset}"></circle>
    </svg>
    <div class="xp-avatar">${escapeHtml(avatar)}</div>
    <div class="lvl-badge">${escapeHtml(level)}</div>
  </div>`;
}

function renderChildRow(){
  const items = state.children.map(c => {
    const pct = todayProgress(c.id);
    const euros = totalEuros(c.id);
    const li = childLevelInfo(c);
    const streak = computeStreak(c.id);
    return `
    <button class="child-tab ${c.id === activeChildId ? 'active' : ''}" data-child="${c.id}">
      ${xpRingSvg(pct, c.avatar, li.level)}
      <div class="child-meta">
        <span class="child-name">${escapeHtml(c.name)}${streak > 0 ? ` <span class="streak-flame" title="${streak} jours d'affilée">🔥${escapeHtml(streak)}</span>` : ''}</span>
        <span class="child-points">★ ${escapeHtml(getPoints(c.id))} pts · Niv. ${li.level} ${escapeHtml(li.title)}</span>
        <div class="xp-bar-mini" title="${li.into} / ${effectiveXpPerLevel(c)} pts vers le niveau ${li.level + 1}"><div class="xp-bar-mini-fill" style="width:${li.pct}%;"></div></div>
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
    const canOpen = tasks.length > 0 && !isFuture;
    cells.push(`<div class="calendar-day ${status}${canOpen ? ' clickable' : ''}" ${canOpen ? `data-day="${dateKey}"` : ''} title="${done} / ${tasks.length} mission(s)${canOpen ? ' · code parent requis' : ''}"><span>${day}</span>${tasks.length && !isFuture ? `<small>${done}/${tasks.length}</small>` : ''}</div>`);
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
  document.querySelectorAll('.calendar-day[data-day]').forEach(el => {
    el.onclick = () => requireAdmin(() => openDayDetailModal(el.dataset.day));
  });
}

/* Détail jour par jour des missions faites/non faites, réservé aux parents (code PIN). */
function openDayDetailModal(dateKey){
  const child = getChild(activeChildId);
  if (!child) return;
  const date = new Date(dateKey + 'T00:00:00');
  const tasks = state.tasks.filter(t => !t.schoolDaysOnly || isSchoolDay(date));
  const completed = state.completions[dateKey]?.[child.id] || [];
  const rows = tasks.map(t => `
    <div class="list-row">
      <span style="font-size:20px;">${completed.includes(t.id) ? '✅' : '⬜'}</span>
      <div class="grow"><div class="rname">${escapeHtml(t.label)}</div><div class="rmeta">${t.type === 'menage' ? 'Ménage' : 'Devoir'} · +${escapeHtml(t.points)} pts</div></div>
    </div>`).join('') || '<p class="help-text">Aucune mission ce jour-là.</p>';
  openModal(`
    <h3 class="modal-title">📅 ${escapeHtml(formatDateLong(date))}</h3>
    <p class="modal-sub">${escapeHtml(child.name)}</p>
    ${rows}
    <div class="modal-actions"><button class="btn btn-ghost" id="btn-close-day-detail">Fermer</button></div>
  `, { wide: true });
  document.getElementById('btn-close-day-detail').onclick = closeModal;
}

function logicDoneCount(childId, gameId, difficultyId){
  return state.logicProgress[childId]?.[gameId]?.[difficultyId]?.[todayStr()]?.length || 0;
}

function logicTotalSolved(childId){
  return state.logicTotalSolved?.[childId] || 0;
}

function renderLogicGames(){
  const child = getChild(activeChildId);
  const totalToday = LOGIC_GAMES.reduce((sum, game) => sum + logicDoneCount(child.id, game.id, childLogicDifficulty(child.id, game.id)), 0);
  const maxToday = LOGIC_GAMES.length * LOGIC_DAILY_COUNT;
  return `
  <section class="logic-panel logic-teaser" aria-labelledby="logic-title">
    <div>
      <h2 id="logic-title">🗺️ Défis du Royaume</h2>
      <p>${totalToday} / ${maxToday} défis réussis aujourd'hui · ${logicTotalSolved(child.id)} au total</p>
    </div>
    <button class="btn btn-gold" id="btn-open-logic-menu">Jouer</button>
  </section>`;
}

function openLogicGamesMenu(){
  const child = getChild(activeChildId);
  if (!child) return;
  const rows = LOGIC_GAMES.map(game => {
    const difficultyId = childLogicDifficulty(child.id, game.id);
    const points = difficultyConfig(difficultyId).points;
    return `
    <div class="list-row logic-menu-row">
      <span style="font-size:22px;">${game.icon}</span>
      <div class="grow">
        <div class="rname">${escapeHtml(game.title)}</div>
        <div class="rmeta">${escapeHtml(game.description)} · +${points} pt${points > 1 ? 's' : ''}/bonne réponse</div>
        <div class="difficulty-picker" data-difficulty-for="${game.id}">
          ${DIFFICULTIES.map(d => `<button class="difficulty-pill ${d.id === difficultyId ? 'active' : ''}" data-difficulty="${d.id}" data-game="${game.id}">${d.label}</button>`).join('')}
        </div>
      </div>
      <button class="btn btn-sm btn-gold" data-logic-game="${game.id}">${logicDoneCount(child.id, game.id, difficultyId)} / ${LOGIC_DAILY_COUNT}</button>
    </div>`;
  }).join('');
  openModal(`
    <h3 class="modal-title">🗺️ Défis du Royaume</h3>
    <p class="modal-sub">${escapeHtml(child.name)} · choisis un jeu et un niveau de difficulté</p>
    ${rows}
    <div class="modal-actions"><button class="btn btn-ghost" id="btn-close-logic-menu">Fermer</button></div>
  `, { wide: true });
  document.getElementById('btn-close-logic-menu').onclick = closeModal;
  document.querySelectorAll('[data-difficulty]').forEach(button => {
    button.onclick = (e) => {
      e.stopPropagation();
      setChildLogicDifficulty(child.id, button.dataset.game, button.dataset.difficulty);
      saveData();
      openLogicGamesMenu();
    };
  });
  document.querySelectorAll('[data-logic-game]').forEach(button => {
    button.onclick = () => openLogicGame(button.dataset.logicGame);
  });
}

function bindLogicGames(){
  const openBtn = document.getElementById('btn-open-logic-menu');
  if (openBtn) openBtn.onclick = () => openLogicGamesMenu();
}

function renderSudoku(){
  const child = getChild(activeChildId);
  const difficultyId = childLogicDifficulty(child.id, 'sudoku');
  const sudokuState = getSudokuState(child.id, difficultyId);
  const points = SUDOKU_DIFFICULTY_CONFIG[difficultyId].points;
  return `
  <section class="logic-panel logic-teaser" aria-labelledby="sudoku-title">
    <div>
      <h2 id="sudoku-title">🔢 Sudoku du jour</h2>
      <p>${sudokuState.completed ? "Terminé aujourd'hui — reviens demain pour un nouveau sudoku !" : `${difficultyConfig(difficultyId).label} · +${points} pts en le terminant`}</p>
      <div class="difficulty-picker">
        ${DIFFICULTIES.map(d => `<button class="difficulty-pill ${d.id === difficultyId ? 'active' : ''}" data-sudoku-difficulty="${d.id}">${d.label}</button>`).join('')}
      </div>
    </div>
    <button class="btn btn-gold" id="btn-open-sudoku">${sudokuState.completed ? 'Revoir' : 'Jouer'}</button>
  </section>`;
}

function bindSudoku(){
  document.querySelectorAll('[data-sudoku-difficulty]').forEach(btn => {
    btn.onclick = () => {
      const child = getChild(activeChildId);
      setChildLogicDifficulty(child.id, 'sudoku', btn.dataset.sudokuDifficulty);
      saveData();
      render();
    };
  });
  const openBtn = document.getElementById('btn-open-sudoku');
  if (openBtn) openBtn.onclick = () => openSudokuModal();
}

let sudokuSelectedCell = null; // [row, col] actuellement sélectionnée dans la grille ouverte

function openSudokuModal(){
  sudokuSelectedCell = null;
  renderSudokuModal();
}

function renderSudokuModal(){
  const child = getChild(activeChildId);
  const difficultyId = childLogicDifficulty(child.id, 'sudoku');
  const { puzzle } = getSudokuPuzzle(todayStr(), difficultyId);
  const sudokuState = getSudokuState(child.id, difficultyId);
  const grid = sudokuState.grid;

  const cellsHtml = grid.map((row, r) => row.map((val, c) => {
    const isClue = puzzle[r][c] !== 0;
    const conflict = sudokuHasConflict(grid, r, c);
    const selected = sudokuSelectedCell && sudokuSelectedCell[0] === r && sudokuSelectedCell[1] === c;
    const classes = ['sudoku-cell'];
    if (isClue) classes.push('clue');
    if (conflict) classes.push('conflict');
    if (selected) classes.push('selected');
    if (c % 3 === 0) classes.push('border-left');
    if (r % 3 === 0) classes.push('border-top');
    return `<button type="button" class="${classes.join(' ')}" ${isClue || sudokuState.completed ? 'disabled' : `data-cell="${r},${c}"`}>${val || ''}</button>`;
  }).join('')).join('');

  openModal(`
    <h3 class="modal-title">🔢 Sudoku du jour</h3>
    <p class="modal-sub">${escapeHtml(child.name)} · ${difficultyConfig(difficultyId).label}</p>
    ${sudokuState.completed ? '<div class="logic-complete">🏆 Sudoku terminé aujourd\'hui !</div>' : ''}
    <div class="sudoku-grid">${cellsHtml}</div>
    ${!sudokuState.completed ? `
    <div class="sudoku-palette">
      ${[1,2,3,4,5,6,7,8,9].map(n => `<button type="button" class="sudoku-num" data-num="${n}">${n}</button>`).join('')}
      <button type="button" class="sudoku-num sudoku-erase" data-num="0">✕</button>
    </div>` : ''}
    <div class="modal-actions"><button class="btn btn-ghost" id="btn-close-sudoku">Fermer</button></div>
  `, { wide: true });

  document.getElementById('btn-close-sudoku').onclick = closeModal;
  document.querySelectorAll('[data-cell]').forEach(btn => {
    btn.onclick = () => {
      const [r, c] = btn.dataset.cell.split(',').map(Number);
      sudokuSelectedCell = [r, c];
      renderSudokuModal();
    };
  });
  document.querySelectorAll('[data-num]').forEach(btn => {
    btn.onclick = () => {
      if (!sudokuSelectedCell) return;
      const [r, c] = sudokuSelectedCell;
      const num = parseInt(btn.dataset.num, 10);
      grid[r][c] = num;
      saveSudokuState(child.id, difficultyId, { grid, completed: false });
      saveData();
      if (sudokuIsComplete(grid)){
        const points = SUDOKU_DIFFICULTY_CONFIG[difficultyId].points;
        addPoints(child.id, points);
        saveSudokuState(child.id, difficultyId, { grid, completed: true });
        saveData();
        launchConfetti();
        showToast(`Sudoku terminé ! +${points} pts`, '🏆');
        render();
      }
      renderSudokuModal();
    };
  });
}

function render2048(){
  const child = getChild(activeChildId);
  const g = get2048State(child.id);
  const best = Math.max(...g.grid.flat(), 0);
  const nextMilestone = GAME2048_MILESTONES.find(m => m.value > best);
  return `
  <section class="logic-panel logic-teaser" aria-labelledby="g2048-title">
    <div>
      <h2 id="g2048-title">🎯 2048</h2>
      <p>Meilleure tuile : ${best || '—'}${nextMilestone ? ` · prochain palier ${nextMilestone.value} (+${nextMilestone.points} pts)` : ' · tous les paliers débloqués !'}</p>
    </div>
    <button class="btn btn-gold" id="btn-open-2048">Jouer</button>
  </section>`;
}

function bind2048(){
  const openBtn = document.getElementById('btn-open-2048');
  if (openBtn) openBtn.onclick = () => render2048Modal();
}

let touch2048Start = null;

function render2048Modal(){
  const child = getChild(activeChildId);
  const g = get2048State(child.id);
  const cellsHtml = g.grid.flat().map(val => `<div class="g2048-cell ${val ? 'g2048-v' + val : ''}">${val || ''}</div>`).join('');
  openModal(`
    <h3 class="modal-title">🎯 2048</h3>
    <p class="modal-sub">${escapeHtml(child.name)} · Score : ${g.score}</p>
    ${g.over ? '<div class="logic-complete">Partie terminée ! Plus de mouvement possible.</div>' : ''}
    <div class="g2048-grid" id="g2048-grid">${cellsHtml}</div>
    <div class="g2048-controls">
      <div></div><button type="button" class="g2048-arrow" data-dir="up">⬆️</button><div></div>
      <button type="button" class="g2048-arrow" data-dir="left">⬅️</button><button type="button" class="g2048-arrow" data-dir="down">⬇️</button><button type="button" class="g2048-arrow" data-dir="right">➡️</button>
    </div>
    <p class="help-text" style="text-align:center;">Glisse sur la grille ou utilise les flèches.</p>
    <div class="modal-actions" style="justify-content:space-between;">
      <button class="btn btn-ghost" id="btn-2048-new">Nouvelle partie</button>
      <button class="btn btn-ghost" id="btn-close-2048">Fermer</button>
    </div>
  `, { wide: true });

  document.getElementById('btn-close-2048').onclick = closeModal;
  document.getElementById('btn-2048-new').onclick = () => {
    save2048State(child.id, { grid: new2048Grid(), score: 0, over: false });
    saveData();
    render2048Modal();
  };
  document.querySelectorAll('.g2048-arrow').forEach(btn => {
    btn.onclick = () => play2048Move(child.id, btn.dataset.dir);
  });
  const gridEl = document.getElementById('g2048-grid');
  gridEl.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    touch2048Start = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  // Sans ce blocage, le navigateur interprète souvent un glissement vertical comme un
  // défilement de page (la modale est scrollable) et « avale » le geste avant qu'on ait pu
  // calculer la direction dans touchend — le glissement semblait alors ne rien faire.
  gridEl.addEventListener('touchmove', (e) => {
    if (touch2048Start) e.preventDefault();
  }, { passive: false });
  gridEl.addEventListener('touchend', (e) => {
    if (!touch2048Start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch2048Start.x, dy = t.clientY - touch2048Start.y;
    touch2048Start = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    play2048Move(child.id, dir);
  }, { passive: true });
  gridEl.addEventListener('touchcancel', () => { touch2048Start = null; }, { passive: true });
}

function play2048Move(childId, direction){
  const g = get2048State(childId);
  if (g.over) return;
  const { grid, scoreGained, moved } = move2048(g.grid, direction);
  if (!moved) return;
  spawn2048Tile(grid);
  const score = g.score + scoreGained;
  const { totalPoints, newMilestones } = check2048Milestones(childId, grid);
  const over = is2048GameOver(grid);
  save2048State(childId, { grid, score, over });
  if (totalPoints > 0) addPoints(childId, totalPoints);
  saveData();
  if (newMilestones.length){
    launchConfetti();
    showToast(`Tuile ${newMilestones[newMilestones.length - 1].value} ! +${totalPoints} pts`, '🎉');
    render();
  } else if (over){
    showToast('Partie terminée !', '🏁');
  }
  render2048Modal();
}

function renderBadges(){
  const child = getChild(activeChildId);
  const unlocked = BADGES.filter(b => b.check(child.id)).length;
  return `
  <section class="logic-panel logic-teaser" aria-labelledby="badges-title">
    <div>
      <h2 id="badges-title">🏅 Trophées</h2>
      <p>${unlocked} / ${BADGES.length} trophées débloqués</p>
    </div>
    <button class="btn btn-gold" id="btn-open-badges">Voir</button>
  </section>`;
}

function bindBadges(){
  const openBtn = document.getElementById('btn-open-badges');
  if (openBtn) openBtn.onclick = () => openBadgesModal();
}

function openBadgesModal(){
  const child = getChild(activeChildId);
  if (!child) return;
  const items = BADGES.map(b => {
    const unlocked = b.check(child.id);
    return `
    <div class="badge-item ${unlocked ? 'unlocked' : 'locked'}">
      <div class="badge-icon">${unlocked ? b.icon : '🔒'}</div>
      <div class="badge-label">${escapeHtml(b.label)}</div>
    </div>`;
  }).join('');
  openModal(`
    <h3 class="modal-title">🏅 Trophées</h3>
    <p class="modal-sub">${escapeHtml(child.name)}</p>
    <div class="badge-grid">${items}</div>
    <div class="modal-actions"><button class="btn btn-ghost" id="btn-close-badges">Fermer</button></div>
  `, { wide: true });
  document.getElementById('btn-close-badges').onclick = closeModal;
}

function renderWheel(){
  const child = getChild(activeChildId);
  const spin = state.wheelSpins[child.id];
  const alreadySpun = spin && spin.week === weekKey();
  return `
  <section class="logic-panel logic-teaser" aria-labelledby="wheel-title">
    <div>
      <h2 id="wheel-title">🎡 Roue de la Chance</h2>
      <p>${alreadySpun ? `Déjà tournée cette semaine : ${escapeHtml(spin.prize.label)}` : 'Un tour gratuit chaque semaine, tente ta chance !'}</p>
    </div>
    <button class="btn btn-gold" id="btn-open-wheel">${alreadySpun ? 'Revoir' : 'Tourner'}</button>
  </section>`;
}

function bindWheel(){
  const openBtn = document.getElementById('btn-open-wheel');
  if (openBtn) openBtn.onclick = () => openWheelModal();
}

function openWheelModal(){
  const child = getChild(activeChildId);
  if (!child) return;
  const spin = state.wheelSpins[child.id];
  const alreadySpun = spin && spin.week === weekKey();

  if (alreadySpun){
    openModal(`
      <h3 class="modal-title">🎡 Roue de la Chance</h3>
      <p class="modal-sub">${escapeHtml(child.name)}</p>
      <div class="logic-complete">${escapeHtml(spin.prize.label)}<br><span style="font-size:12px; font-weight:400;">Reviens la semaine prochaine pour un nouveau tour !</span></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="btn-close-wheel">Fermer</button></div>
    `);
    document.getElementById('btn-close-wheel').onclick = closeModal;
    return;
  }

  openModal(`
    <h3 class="modal-title">🎡 Roue de la Chance</h3>
    <p class="modal-sub">${escapeHtml(child.name)} · un tour gratuit par semaine</p>
    <div class="wheel-emoji" id="wheel-emoji">🎡</div>
    <p class="logic-feedback" id="wheel-feedback"></p>
    <div class="modal-actions"><button class="btn btn-gold" id="btn-spin-wheel">Lancer la roue !</button></div>
  `);
  const spinBtn = document.getElementById('btn-spin-wheel');
  spinBtn.onclick = () => {
    spinBtn.disabled = true;
    const wheelEl = document.getElementById('wheel-emoji');
    wheelEl.classList.add('spinning');
    document.getElementById('wheel-feedback').textContent = 'La roue tourne...';
    setTimeout(() => {
      const prize = pickWeightedPrize(WHEEL_PRIZES);
      state.wheelSpins[child.id] = { week: weekKey(), prize };
      addPoints(child.id, prize.points);
      saveData();
      launchConfetti();
      showToast(prize.label, '🎡');
      renderWheel();
      openWheelModal();
      render();
    }, 1100);
  };
}

function renderLootChest(){
  const child = getChild(activeChildId);
  const canOpen = getPoints(child.id) >= LOOT_CHEST_COST;
  return `
  <section class="logic-panel logic-teaser" aria-labelledby="chest-title">
    <div>
      <h2 id="chest-title">📦 Coffre à Butin</h2>
      <p>Tente ta chance autant de fois que tu veux !</p>
    </div>
    <button class="btn btn-gold" id="btn-open-chest" ${canOpen ? '' : 'disabled'}>Ouvrir (-${LOOT_CHEST_COST} pts)</button>
  </section>`;
}

function bindLootChest(){
  const openBtn = document.getElementById('btn-open-chest');
  if (openBtn) openBtn.onclick = () => openLootChestModal();
}

function openLootChestModal(){
  const child = getChild(activeChildId);
  if (!child || getPoints(child.id) < LOOT_CHEST_COST) return;
  openModal(`
    <h3 class="modal-title">📦 Coffre à Butin</h3>
    <p class="modal-sub">${escapeHtml(child.name)} · ${LOOT_CHEST_COST} pts pour tenter ta chance</p>
    <div class="wheel-emoji" id="chest-emoji">📦</div>
    <p class="logic-feedback" id="chest-feedback"></p>
    <div class="modal-actions"><button class="btn btn-gold" id="btn-open-chest-confirm">Ouvrir pour ${LOOT_CHEST_COST} pts</button></div>
  `);
  const confirmBtn = document.getElementById('btn-open-chest-confirm');
  confirmBtn.onclick = () => {
    confirmBtn.disabled = true;
    addPoints(child.id, -LOOT_CHEST_COST);
    document.getElementById('chest-emoji').classList.add('spinning');
    document.getElementById('chest-feedback').textContent = 'Ouverture du coffre...';
    setTimeout(() => {
      const prize = pickWeightedPrize(LOOT_CHEST_PRIZES);
      addPoints(child.id, prize.points);
      state.lootChestsOpened[child.id] = (state.lootChestsOpened[child.id] || 0) + 1;
      saveData();
      launchConfetti();
      showToast(prize.label, '📦');
      render();
      openLootChestPrizeReveal(child, prize);
    }, 1100);
  };
}

function openLootChestPrizeReveal(child, prize){
  const canReplay = getPoints(child.id) >= LOOT_CHEST_COST;
  openModal(`
    <h3 class="modal-title">📦 Coffre à Butin</h3>
    <p class="modal-sub">${escapeHtml(child.name)}</p>
    <div class="logic-complete">${escapeHtml(prize.label)}</div>
    ${!canReplay ? `<p class="help-text" style="text-align:center;">Plus assez de points pour rejouer.</p>` : ''}
    <div class="modal-actions">
      <button class="btn btn-ghost" id="btn-close-chest">Fermer</button>
      ${canReplay ? `<button class="btn btn-gold" id="btn-open-chest-again">Rejouer</button>` : ''}
    </div>
  `);
  document.getElementById('btn-close-chest').onclick = closeModal;
  const againBtn = document.getElementById('btn-open-chest-again');
  if (againBtn) againBtn.onclick = () => openLootChestModal();
}

function renderSiblingChallenge(){
  if (state.children.length < 2) return '';
  const ranked = [...state.children]
    .map(c => ({ child: c, pts: pointsThisWeek(c.id) }))
    .sort((a, b) => b.pts - a.pts);
  const max = Math.max(1, ...ranked.map(r => r.pts));
  const rows = ranked.map((r, i) => `
    <div class="sibling-row">
      <span class="sibling-name">${i === 0 && r.pts > 0 ? '👑 ' : ''}${escapeHtml(r.child.avatar)} ${escapeHtml(r.child.name)}</span>
      <div class="sibling-bar-track"><div class="sibling-bar-fill" style="width:${Math.round((r.pts/max)*100)}%;"></div></div>
      <span class="sibling-pts">${r.pts} pts</span>
    </div>`).join('');
  return `
  <section class="logic-panel" aria-labelledby="sibling-title">
    <h2 id="sibling-title" style="margin-bottom:10px;">⚔️ Défi de la semaine</h2>
    ${rows}
  </section>`;
}

function renderTeamGoal(){
  if (!state.teamGoalEnabled) return '';
  const progress = teamGoalProgress();
  const pct = Math.min(100, Math.round((progress / state.teamGoalThreshold) * 100));
  const claimed = state.teamGoalClaims[weekKey()] === true;
  return `
  <section class="logic-panel team-goal-panel" aria-labelledby="team-goal-title">
    <h2 id="team-goal-title" class="team-goal-title">🤝 Mission d'équipe</h2>
    <p class="team-goal-sub">${claimed ? `Objectif atteint : ${escapeHtml(state.teamGoalLabel)} 🎉` : `${escapeHtml(state.teamGoalLabel)} — ${escapeHtml(state.teamGoalThreshold)} pts cumulés cette semaine`}</p>
    <div class="xp-bar-mini team-goal-bar"><div class="xp-bar-mini-fill" style="width:${pct}%;"></div></div>
    <p class="team-goal-count">${progress} / ${escapeHtml(state.teamGoalThreshold)} pts</p>
  </section>`;
}

function renderCompagnonTab(){
  const child = getChild(activeChildId);
  const pet = state.pets[child.id];
  if (!pet){
    return `
    <section class="logic-panel pet-page pet-page-empty">
      <h2>🐾 Choisis le compagnon de ${escapeHtml(child.name)}</h2>
      <p class="help-text">Adopte-le et prends-en soin en le nourrissant et en le caressant !</p>
      <div class="pet-species-picker pet-species-picker-big">
        ${Object.entries(PET_SPECIES).map(([id, sp]) => `
          <button class="pet-species-btn pet-species-btn-big" data-pick-pet="${id}">
            <span class="pet-species-emoji">${sp.stages[0]}</span><span>${escapeHtml(sp.label)}</span>
          </button>`).join('')}
      </div>
    </section>`;
  }
  const species = PET_SPECIES[pet.species];
  const stage = petStageIndex(pet.totalFeeds);
  const hunger = petHunger(pet, child.id);
  const happiness = petHappiness(pet, child.id);
  const hungerFull = hunger >= 100;
  const canFeed = !hungerFull && getPoints(child.id) >= PET_FEED_COST;
  const onCooldown = petPatOnCooldown(pet);
  const hints = [
    hungerFull ? "Il n'a plus faim, inutile de dépenser des points pour l'instant." : '',
    onCooldown ? 'Attends un peu avant de le caresser à nouveau.' : '',
  ].filter(Boolean);
  return `
  <section class="logic-panel pet-page">
    <p class="pet-page-sub">${escapeHtml(species.label)} de ${escapeHtml(child.name)}</p>
    <div class="pet-big-emoji">${species.stages[stage]}</div>
    <p class="pet-mood">Il ${escapeHtml(petMoodLabel(hunger, happiness))}</p>
    <div class="pet-gauges">
      <div class="pet-gauge-row">
        <span class="pet-gauge-label">🍖 Faim</span>
        <div class="pet-hunger-track"><div class="pet-hunger-fill" style="width:${hunger}%;"></div></div>
      </div>
      <div class="pet-gauge-row">
        <span class="pet-gauge-label">💛 Bonheur</span>
        <div class="pet-happiness-track"><div class="pet-happiness-fill" style="width:${happiness}%;"></div></div>
      </div>
    </div>
    <div class="pet-actions">
      <button class="btn btn-gold" id="btn-feed-pet" ${canFeed ? '' : 'disabled'}>Nourrir (-${PET_FEED_COST} pts)</button>
      <button class="btn btn-ghost" id="btn-pat-pet" ${onCooldown ? 'disabled' : ''}>Caresser 💛</button>
    </div>
    ${hints.map(h => `<p class="help-text" style="text-align:center; margin-top:6px;">${escapeHtml(h)}</p>`).join('')}
  </section>`;
}

function bindCompagnonTab(){
  document.querySelectorAll('[data-pick-pet]').forEach(el => {
    el.onclick = () => {
      const child = getChild(activeChildId);
      state.pets[child.id] = {
        species: el.dataset.pickPet, totalFeeds: 0, lastFedAt: null,
        happiness: 100, lastHappinessCheckAt: Date.now(), lastPettedAt: null,
      };
      saveData();
      render();
    };
  });
  const feedBtn = document.getElementById('btn-feed-pet');
  if (feedBtn) feedBtn.onclick = () => {
    const child = getChild(activeChildId);
    const pet = state.pets[child.id];
    if (!pet || getPoints(child.id) < PET_FEED_COST || petHunger(pet, child.id) >= 100) return;
    const prevStage = petStageIndex(pet.totalFeeds);
    addPoints(child.id, -PET_FEED_COST);
    pet.totalFeeds++;
    pet.lastFedAt = Date.now();
    saveData();
    const newStage = petStageIndex(pet.totalFeeds);
    if (newStage > prevStage){
      launchConfetti();
      showToast('Ton compagnon a évolué !', '✨');
    } else {
      showToast('Compagnon nourri !', '🍖');
    }
    render();
  };
  const patBtn = document.getElementById('btn-pat-pet');
  if (patBtn) patBtn.onclick = () => {
    const child = getChild(activeChildId);
    const pet = state.pets[child.id];
    if (!pet || petPatOnCooldown(pet)) return;
    checkpointHappiness(pet, child.id);
    pet.happiness = Math.min(100, pet.happiness + PET_PAT_GAIN);
    pet.lastPettedAt = Date.now();
    saveData();
    showToast('Il adore ça !', '💛');
    render();
  };
}

function openLogicGame(gameId){
  renderLogicNodeMap(gameId);
}

/* Carte des défis du jour : un noeud par exercice (réussi / débloqué / verrouillé), dans
   l'ordre. Les questions changent chaque jour (tirées d'un bassin bien plus large), pour
   le niveau de difficulté choisi par l'enfant dans le menu des jeux. */
function renderLogicNodeMap(gameId){
  const game = LOGIC_GAMES.find(item => item.id === gameId);
  const child = getChild(activeChildId);
  if (!game || !child) return;
  const difficultyId = childLogicDifficulty(child.id, game.id);
  const todaysQuestions = getTodaysQuestions(game, difficultyId);
  const done = state.logicProgress[child.id]?.[game.id]?.[difficultyId]?.[todayStr()] || [];
  const firstUnsolved = todaysQuestions.findIndex((_, index) => !done.includes(index));
  const allDone = firstUnsolved < 0;
  const nodesHtml = todaysQuestions.map((_, index) => {
    const isDone = done.includes(index);
    const isUnlocked = index === firstUnsolved;
    const nodeState = isDone ? 'done' : (isUnlocked ? 'unlocked' : 'locked');
    const label = isDone ? '✓' : (nodeState === 'locked' ? '🔒' : String(index + 1));
    return `<button class="node ${nodeState}" ${nodeState === 'locked' ? 'data-locked="1"' : `data-play-index="${index}"`}>${label}</button>`;
  }).join('');
  openModal(`
    <h3 class="modal-title">${game.icon} ${escapeHtml(game.title)}</h3>
    <p class="modal-sub">${escapeHtml(child.name)} · ${difficultyConfig(difficultyId).label} · ${done.length} / ${LOGIC_DAILY_COUNT} réussis aujourd'hui</p>
    ${allDone ? '<div class="logic-complete">🏆 Défis du jour terminés ! Reviens demain pour de nouveaux défis.</div>' : ''}
    <div class="node-grid">${nodesHtml}</div>
    <div class="modal-actions"><button class="btn btn-ghost" id="btn-close-logic">Fermer</button></div>
  `, { wide: true });
  document.getElementById('btn-close-logic').onclick = closeModal;
  document.querySelectorAll('[data-play-index]').forEach(button => {
    button.onclick = () => openLogicQuestion(gameId, parseInt(button.dataset.playIndex, 10));
  });
  document.querySelectorAll('[data-locked]').forEach(button => {
    button.onclick = () => showToast('Termine d\'abord le défi précédent !', '🔒');
  });
}

function openLogicQuestion(gameId, questionIndex){
  const game = LOGIC_GAMES.find(item => item.id === gameId);
  const child = getChild(activeChildId);
  if (!game || !child) return;
  const difficultyId = childLogicDifficulty(child.id, game.id);
  const points = difficultyConfig(difficultyId).points;
  const todaysQuestions = getTodaysQuestions(game, difficultyId);
  let questionOptions = shuffled(todaysQuestions[questionIndex].options);

  const renderQuestion = (message = '') => {
    const question = todaysQuestions[questionIndex];
    openModal(`
      <h3 class="modal-title">${game.icon} ${escapeHtml(game.title)}</h3>
      <p class="modal-sub">Défi ${questionIndex + 1} sur ${LOGIC_DAILY_COUNT} · ${difficultyConfig(difficultyId).label} · ${escapeHtml(child.name)}</p>
      <div class="logic-question">${escapeHtml(question.text)}</div>
      <div class="logic-options">${questionOptions.map(option => `<button class="logic-option" data-answer="${escapeHtml(option)}">${escapeHtml(option)}</button>`).join('')}</div>
      <p class="logic-feedback">${escapeHtml(message)}</p>
      <div class="modal-actions"><button class="btn btn-ghost" id="btn-back-map">Carte des défis</button></div>
    `);
    document.getElementById('btn-back-map').onclick = () => renderLogicNodeMap(gameId);
    document.querySelectorAll('[data-answer]').forEach(button => {
      button.onclick = () => {
        if (button.dataset.answer !== question.answer){
          renderQuestion('Pas encore. Relis la question et essaie une autre réponse.');
          return;
        }
        const day = todayStr();
        if (!state.logicProgress[child.id]) state.logicProgress[child.id] = {};
        if (!state.logicProgress[child.id][game.id]) state.logicProgress[child.id][game.id] = {};
        if (!state.logicProgress[child.id][game.id][difficultyId]) state.logicProgress[child.id][game.id][difficultyId] = {};
        if (!state.logicProgress[child.id][game.id][difficultyId][day]) state.logicProgress[child.id][game.id][difficultyId][day] = [];
        if (!state.logicProgress[child.id][game.id][difficultyId][day].includes(questionIndex)){
          state.logicProgress[child.id][game.id][difficultyId][day].push(questionIndex);
          if (!state.logicTotalSolved) state.logicTotalSolved = {};
          state.logicTotalSolved[child.id] = (state.logicTotalSolved[child.id] || 0) + 1;
          addPoints(child.id, points);
        }
        saveData();
        launchConfetti();
        showToast(`Bravo ! +${points} pt${points > 1 ? 's' : ''}`, '🎉');
        render();
        renderLogicNodeMap(gameId);
      };
    });
  };
  renderQuestion();
}

/* ---------------------------- rendu : tableau de missions + récompenses ---------------------------- */

function renderBoard(){
  const child = getChild(activeChildId);
  if (child.vacationMode){
    return `
    <div class="board">
      <div class="panel vacation-panel">
        <div class="panel-head"><h2>🏖️ En vacances</h2><span class="sub">${escapeHtml(child.name)}</span></div>
        <div class="panel-body">
          <p class="help-text">Les missions de ${escapeHtml(child.name)} sont en pause pendant les vacances — rien à faire ici, et le compagnon comme la série de jours n'y perdent rien. Un parent peut désactiver la pause dans Réglages → Enfants.</p>
        </div>
      </div>
    </div>`;
  }
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
        const cost = effectiveRewardCost(child, r);
        const pct = Math.min(100, Math.round((pts / cost) * 100));
        const unlocked = pts >= cost;
        return `
        <div class="reward-card ${unlocked ? 'unlocked' : ''}">
          <div class="reward-top">
            <div class="reward-icon">${escapeHtml(r.icon)}</div>
            <div class="grow">
              <div class="reward-name">${escapeHtml(r.label)}</div>
              <div class="reward-cost">${escapeHtml(cost)} pts</div>
            </div>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
          <div class="reward-bottom">
            <span class="reward-status ${unlocked ? 'unlocked' : ''}">${unlocked ? '🔓 Débloqué' : pts + ' / ' + cost + ' pts'}</span>
            <button class="btn btn-sm ${unlocked ? 'btn-gold' : 'btn-ghost'}" data-redeem="${r.id}" ${unlocked && !hasPendingRequest(child.id, r.id) ? '' : 'disabled'}>${hasPendingRequest(child.id, r.id) ? 'Demande envoyée' : 'Demander'}</button>
          </div>
        </div>`;
      }).join('');
  let monthlyReward = '';
  if (state.monthlyRewardEnabled){
    const amount = state.monthlyRewardAmount;
    const monthlyStats = monthlyTaskStats(child.id);
    const previousMonth = new Date();
    previousMonth.setDate(1);
    previousMonth.setMonth(previousMonth.getMonth() - 1);
    const previousMonthKey = monthKey(previousMonth);
    const previousStats = monthlyTaskStats(child.id, previousMonthKey);
    monthlyReward = previousStats.complete && !hasMonthlyRedemption(child.id, previousMonthKey)
      ? `<div class="monthly-reward unlocked">
          <div class="monthly-reward-top"><span class="monthly-reward-icon">💶</span><div><strong>Récompense de ${escapeHtml(monthLabel(previousMonthKey))}</strong><span>${escapeHtml(amount)} € pour toutes les missions réalisées</span></div></div>
          <button class="btn btn-sm btn-gold" data-monthly-redeem="${previousMonthKey}">Valider</button>
        </div>`
      : `<div class="monthly-reward">
          <div class="monthly-reward-top"><span class="monthly-reward-icon">💶</span><div><strong>Récompense mensuelle</strong><span>${monthlyStats.completed} / ${monthlyStats.required} missions réalisées ce mois-ci</span></div></div>
          <span class="monthly-reward-status">${escapeHtml(amount)} € en fin de mois</span>
        </div>`;
  }

  return `
  <div class="board">
    <div class="panel">
      <div class="panel-head">
        <h2>⚔️ Quêtes du jour</h2>
        <span class="sub">${escapeHtml(child.name)}</span>
      </div>
      <div class="panel-body">${missionsHtml}</div>
    </div>
    <div class="panel">
      <div class="panel-head">
        <h2>💰 Coffre à récompenses</h2>
        <span class="sub">★ ${getPoints(child.id)} pts</span>
      </div>
      <div class="panel-body">
        ${monthlyReward}
        <div class="reward-grid">${rewardsHtml}</div>
      </div>
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
  if (!child || !reward || getPoints(child.id) < effectiveRewardCost(child, reward) || hasPendingRequest(child.id, reward.id)) return;
  state.pendingRequests.unshift({ id: uid('req'), childId: child.id, rewardId: reward.id, date: new Date().toISOString() });
  saveData();
  notifyParent('🔔 Nouvelle demande', `${child.name} demande « ${reward.label} » (${effectiveRewardCost(child, reward)} pts)`);
  showToast(`Demande envoyée aux parents`, '🔔');
  render();
}

function openParentRequests(){
  const rows = state.pendingRequests.map(request => {
    const child = getChild(request.childId);
    const reward = state.rewards.find(item => item.id === request.rewardId);
    if (!child || !reward) return '';
    return `<div class="request-row"><div class="grow"><strong>${escapeHtml(child.avatar)} ${escapeHtml(child.name)}</strong><span>demande ${escapeHtml(reward.icon)} ${escapeHtml(reward.label)} (${escapeHtml(effectiveRewardCost(child, reward))} pts)</span></div><div class="row-actions"><button class="btn btn-sm btn-gold" data-approve-request="${request.id}">Valider</button><button class="icon-mini" data-reject-request="${request.id}" title="Refuser">✕</button></div></div>`;
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
  const cost = child && reward ? effectiveRewardCost(child, reward) : 0;
  if (!child || !reward || getPoints(child.id) < cost){
    rejectRequest(requestId);
    return;
  }
  withUndo(() => {
    addPoints(child.id, -cost);
    state.pendingRequests = state.pendingRequests.filter(item => item.id !== requestId);
    state.redemptions.unshift({ id: uid('red'), childId: child.id, rewardId: reward.id, rewardLabel: reward.label, rewardIcon: reward.icon, date: new Date().toISOString(), pointsSpent: cost });
    saveData();
  }, `Demande de ${child.name} validée`, '✅');
  launchConfetti();
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
  if (!child || !state.monthlyRewardEnabled || hasMonthlyRedemption(child.id, month)) return;
  const amount = state.monthlyRewardAmount;
  openConfirmModal({
    title: 'Confirmer la récompense mensuelle',
    body: `Valider <strong>${escapeHtml(amount)} €</strong> pour <strong>${escapeHtml(child.name)}</strong> : toutes les missions de ${escapeHtml(monthLabel(month))} ont été réalisées ?`,
    confirmLabel: `Valider les ${amount} €`,
    onConfirm: () => {
      withUndo(() => {
        state.redemptions.unshift({
          id: uid('red'), kind: 'monthly', childId: child.id, month,
          rewardLabel: 'Récompense mensuelle', rewardIcon: '💶', date: new Date().toISOString(), amount,
        });
        saveData();
      }, `Récompense de ${amount} € validée pour ${child.name}`, '💶');
      launchConfetti();
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
        if (r.kind === 'penalty'){
          return `<div class="history-item history-penalty">
            <span class="h-date">${dateLabel}</span>
            <span>➖ <strong>${escapeHtml(c ? c.name : '?')}</strong> : -${escapeHtml(r.pointsRemoved)} pts${r.reason ? ` (${escapeHtml(r.reason)})` : ''}</span>
          </div>`;
        }
        const rewardValue = r.kind === 'monthly' ? `${escapeHtml(r.amount)} €` : `-${escapeHtml(r.pointsSpent)} pts`;
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

/* ---------------------------- tutoriel de première connexion ---------------------------- */

const TUTORIAL_STEPS = [
  {
    icon: '👋',
    title: 'Bienvenue dans Mission Famille',
    body: "Un carnet de missions du quotidien (ménage, devoirs) : les enfants gagnent des points en cochant leurs missions, puis les échangent contre des récompenses. Un petit tour rapide de l'essentiel avant de commencer.",
  },
  {
    icon: '🏠',
    title: 'Onglet Accueil',
    body: "Les missions du jour et le coffre à récompenses de l'enfant sélectionné en haut de l'écran. Cocher une mission ajoute ses points ; valider une récompense demandera votre code parent.",
  },
  {
    icon: '🎮',
    title: 'Jeux, Compagnon, Historique',
    body: '🎮 Jeux : défis de logique, trophées, roue de la chance, coffre à butin. 🐾 Compagnon : un animal virtuel à nourrir et à caresser. 📅 Historique : calendrier des missions et journal des récompenses.',
  },
  {
    icon: '🔐',
    title: 'Le code parent',
    body: 'Un code à 4 chiffres protège les réglages et la validation des récompenses — à ne pas donner aux enfants. Vous pouvez le créer et le changer à tout moment dans Réglages → Sécurité.',
  },
  {
    icon: '☁️',
    title: 'Plusieurs téléphones ?',
    body: 'Si chaque enfant a son propre appareil, activez la synchronisation dans Réglages → Sécurité pour que tout le monde voie les mêmes missions en temps réel.',
  },
];

let tutorialStepIndex = 0;

function openTutorial(){
  tutorialStepIndex = 0;
  renderTutorialStep();
}

function renderTutorialStep(){
  const step = TUTORIAL_STEPS[tutorialStepIndex];
  const isFirst = tutorialStepIndex === 0;
  const isLast = tutorialStepIndex === TUTORIAL_STEPS.length - 1;
  openModal(`
    <div class="tutorial-icon">${step.icon}</div>
    <h3 class="modal-title tutorial-title">${escapeHtml(step.title)}</h3>
    <p class="modal-sub tutorial-body">${escapeHtml(step.body)}</p>
    <div class="tutorial-dots">
      ${TUTORIAL_STEPS.map((_, i) => `<span class="tutorial-dot ${i === tutorialStepIndex ? 'active' : ''}"></span>`).join('')}
    </div>
    <div class="modal-actions" style="justify-content:space-between;">
      ${isFirst ? `<button class="btn btn-ghost" id="btn-tutorial-skip">Passer</button>` : `<button class="btn btn-ghost" id="btn-tutorial-prev">Précédent</button>`}
      <button class="btn btn-gold" id="btn-tutorial-next">${isLast ? "C'est parti !" : 'Suivant'}</button>
    </div>
  `);
  const prevBtn = document.getElementById('btn-tutorial-prev');
  if (prevBtn) prevBtn.onclick = () => { tutorialStepIndex--; renderTutorialStep(); };
  const skipBtn = document.getElementById('btn-tutorial-skip');
  if (skipBtn) skipBtn.onclick = closeModal;
  document.getElementById('btn-tutorial-next').onclick = () => {
    if (isLast){ closeModal(); return; }
    tutorialStepIndex++;
    renderTutorialStep();
  };
}

/* Retire manuellement des points à un enfant (dispute, comportement...), avec une raison
   optionnelle conservée dans le journal des récompenses pour rester transparent. */
function openDeductPointsModal(childId){
  const child = getChild(childId);
  if (!child) return;
  openModal(`
    <h3 class="modal-title">➖ Retirer des points</h3>
    <p class="modal-sub">Pour <strong>${escapeHtml(child.name)}</strong> (★ ${escapeHtml(getPoints(child.id))} pts actuellement).</p>
    <div class="field">
      <label for="deduct-amount">Nombre de points à retirer</label>
      <input type="number" id="deduct-amount" min="1" max="1000" value="5">
    </div>
    <div class="field">
      <label for="deduct-reason">Raison (optionnel, visible dans le journal)</label>
      <input type="text" id="deduct-reason" maxlength="60" placeholder="Ex : Dispute avec son frère">
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="btn-cancel">Annuler</button>
      <button class="btn btn-danger" id="btn-confirm-deduct">Retirer les points</button>
    </div>
  `);
  document.getElementById('btn-cancel').onclick = closeModal;
  document.getElementById('btn-confirm-deduct').onclick = () => {
    const amount = Math.max(1, parseInt(document.getElementById('deduct-amount').value, 10) || 1);
    const reason = document.getElementById('deduct-reason').value.trim();
    withUndo(() => {
      addPoints(child.id, -amount);
      state.redemptions.unshift({
        id: uid('pen'), kind: 'penalty', childId: child.id,
        reason: reason || null, date: new Date().toISOString(), pointsRemoved: amount,
      });
      saveData();
    }, `${amount} pt${amount > 1 ? 's' : ''} retiré${amount > 1 ? 's' : ''} à ${child.name}`, '➖');
    closeModal();
    renderSettingsModal();
    render();
  };
}

/* ---------------------------- formulaire : enfant ---------------------------- */

function openChildForm(existing){
  const editing = existing && existing.id;
  let selectedEmoji = editing ? existing.avatar : EMOJIS[0];
  const childLevel = editing ? childLevelInfo(existing).level : 1;
  const unlockedAvatars = UNLOCKABLE_AVATARS.filter(a => childLevel >= a.minLevel);
  const lockedAvatars = UNLOCKABLE_AVATARS.filter(a => childLevel < a.minLevel);
  openModal(`
    <h3 class="modal-title">${editing ? 'Modifier' : 'Ajouter'} un enfant</h3>
    <div class="field">
      <label for="child-name">Prénom</label>
      <input type="text" id="child-name" maxlength="24" value="${editing ? escapeHtml(existing.name) : ''}" placeholder="Ex : Léo">
    </div>
    <div class="field">
      <label for="child-age">Âge</label>
      <input type="number" id="child-age" min="0" max="18" value="${editing && typeof existing.age === 'number' ? existing.age : ''}" placeholder="Ex : 8">
      <p class="help-text" style="margin-top:4px;">En dessous de ${YOUNG_CHILD_MAX_AGE} ans : moins de points nécessaires pour monter de niveau et récompenses moins chères.</p>
    </div>
    <div class="field">
      <label>Avatar</label>
      <div class="emoji-picker" id="emoji-picker">
        ${EMOJIS.map(e => `<button type="button" class="emoji-opt ${e === selectedEmoji ? 'selected' : ''}" data-emoji="${e}">${e}</button>`).join('')}
        ${unlockedAvatars.map(a => `<button type="button" class="emoji-opt ${a.emoji === selectedEmoji ? 'selected' : ''}" data-emoji="${a.emoji}" title="${escapeHtml(a.label)}">${a.emoji}</button>`).join('')}
      </div>
      ${lockedAvatars.length ? `
      <div class="emoji-picker locked-avatars">
        ${lockedAvatars.map(a => `<span class="emoji-opt locked" title="${escapeHtml(a.label)} — débloqué au niveau ${a.minLevel}">🔒</span>`).join('')}
      </div>
      <p class="help-text" style="margin-top:6px;">Avatars à débloquer en montant de niveau : ${lockedAvatars.map(a => `niv. ${a.minLevel}`).join(', ')}</p>` : ''}
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
    const ageRaw = document.getElementById('child-age').value;
    const age = ageRaw === '' ? null : Math.max(0, Math.min(18, parseInt(ageRaw, 10) || 0));
    const isFirstRun = !editing && existing && existing.isFirstRun;
    if (editing){
      existing.name = name;
      existing.avatar = selectedEmoji;
      existing.age = age;
    } else {
      const child = { id: uid('c'), name, avatar: selectedEmoji, age };
      state.children.push(child);
      state.points[child.id] = 0;
      activeChildId = child.id;
    }
    saveData();
    render();
    if (isFirstRun) openTutorial(); else closeModal();
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
      <button class="settings-tab ${settingsTab==='stats'?'active':''}" data-tab="stats">📊 Stats</button>
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
  else if (settingsTab === 'stats') container.innerHTML = statsSettingsHtml();
  else container.innerHTML = securitySettingsHtml();
  bindSettingsContent();
}

function childrenSettingsHtml(){
  const rows = state.children.map(c => `
    <div class="list-row">
      <span style="font-size:22px;">${escapeHtml(c.avatar)}</span>
      <div class="grow">
        <div class="rname">${escapeHtml(c.name)}</div>
        <div class="rmeta">★ ${escapeHtml(getPoints(c.id))} pts${typeof c.age === 'number' ? ` · ${escapeHtml(c.age)} ans` : ''}${c.vacationMode ? ' · 🏖️ en vacances' : ''}</div>
      </div>
      <div class="row-actions">
        <button class="icon-mini" data-edit-child="${c.id}" title="Modifier">✏️</button>
        <button class="icon-mini" data-toggle-vacation="${c.id}" title="${c.vacationMode ? 'Désactiver le mode vacances' : 'Mettre en pause (vacances, colonie...)'}">${c.vacationMode ? '☀️' : '🏖️'}</button>
        <button class="icon-mini" data-deduct-points="${c.id}" title="Retirer des points (dispute, comportement...)">➖</button>
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
  return `
    <div class="list-row" style="flex-direction:column; align-items:stretch; gap:8px;">
      <div style="display:flex; align-items:center; gap:10px;">
        <span style="font-size:22px;">💶</span>
        <div class="grow"><div class="rname">Récompense mensuelle en argent</div><div class="rmeta">Versée quand toutes les missions du mois sont faites</div></div>
        <button class="btn btn-sm ${state.monthlyRewardEnabled ? 'btn-gold' : 'btn-ghost'}" id="btn-toggle-monthly-reward">${state.monthlyRewardEnabled ? 'Activée' : 'Désactivée'}</button>
      </div>
      ${state.monthlyRewardEnabled ? `
      <div class="field" style="margin:0;">
        <label for="monthly-reward-amount">Montant (€)</label>
        <input type="number" id="monthly-reward-amount" min="1" max="1000" value="${escapeHtml(state.monthlyRewardAmount)}">
      </div>` : ''}
    </div>
    ${rows}<button class="btn btn-primary btn-block" id="btn-new-reward" style="margin-top:10px;">＋ Ajouter une récompense</button>
    <div class="list-row" style="flex-direction:column; align-items:stretch; gap:8px; margin-top:14px;">
      <div style="display:flex; align-items:center; gap:10px;">
        <span style="font-size:22px;">🤝</span>
        <div class="grow"><div class="rname">Mission d'équipe</div><div class="rmeta">Objectif commun hebdomadaire (points cumulés de tous les enfants)</div></div>
        <button class="btn btn-sm ${state.teamGoalEnabled ? 'btn-gold' : 'btn-ghost'}" id="btn-toggle-team-goal">${state.teamGoalEnabled ? 'Activée' : 'Désactivée'}</button>
      </div>
      ${state.teamGoalEnabled ? `
      <div class="field" style="margin:0;">
        <label for="team-goal-threshold">Points à atteindre ensemble chaque semaine</label>
        <input type="number" id="team-goal-threshold" min="1" max="2000" value="${escapeHtml(state.teamGoalThreshold)}">
      </div>
      <div class="field" style="margin:0;">
        <label for="team-goal-label">Récompense en cas de réussite</label>
        <input type="text" id="team-goal-label" maxlength="60" value="${escapeHtml(state.teamGoalLabel)}">
      </div>` : ''}
    </div>`;
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

function statsSettingsHtml(){
  if (!state.children.length) return '<p class="help-text">Aucun enfant pour le moment.</p>';
  return state.children.map(c => {
    const streak = computeStreak(c.id);
    const li = childLevelInfo(c);
    const weekly = weeklyPointsSeries(c.id, 8);
    const max = Math.max(1, ...weekly);
    const bars = weekly.map((v, i) => `<div class="stat-bar" style="height:${Math.max(3, Math.round((v/max)*100))}%;" title="${i === weekly.length-1 ? 'Cette semaine' : 'Il y a ' + (weekly.length-1-i) + ' semaine(s)'} : ${v} pts"></div>`).join('');
    const badgesUnlocked = BADGES.filter(b => b.check(c.id)).length;
    return `
    <div class="stat-card">
      <div class="stat-head">
        <span style="font-size:26px;">${escapeHtml(c.avatar)}</span>
        <div class="grow">
          <div class="rname">${escapeHtml(c.name)}</div>
          <div class="rmeta">Niveau ${li.level} · ${escapeHtml(li.title)}${streak > 0 ? ` · 🔥 ${streak} j.` : ''}</div>
        </div>
      </div>
      <div class="stat-nums">
        <div><strong>${lifetimeMissionsCount(c.id, 'menage')}</strong><span>ménage</span></div>
        <div><strong>${lifetimeMissionsCount(c.id, 'devoir')}</strong><span>devoirs</span></div>
        <div><strong>${logicTotalSolved(c.id)}</strong><span>défis</span></div>
        <div><strong>${badgesUnlocked}/${BADGES.length}</strong><span>trophées</span></div>
      </div>
      <div class="rmeta" style="margin:12px 0 4px;">Points gagnés par semaine (8 dernières semaines)</div>
      <div class="stat-chart">${bars}</div>
    </div>`;
  }).join('');
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
    <button class="btn btn-ghost btn-block" id="btn-join-family-settings" style="margin-bottom:10px;">🔗 Rejoindre une famille existante avec un code</button>
    `;
  return `
    <p class="help-text" style="margin-bottom:14px;">Le code parent protège les réglages et la validation des récompenses. Il est stocké de façon chiffrée (SHA-256) uniquement sur cet appareil.</p>
    <div class="list-row">
      <span style="font-size:22px;">🔔</span>
      <div class="grow"><div class="rname">Notifications</div><div class="rmeta">Être prévenu quand un enfant demande une récompense</div></div>
      <button class="btn btn-sm ${notifOn ? 'btn-gold' : 'btn-ghost'}" id="btn-toggle-notifications">${notifOn ? 'Activées' : 'Activer'}</button>
    </div>
    ${cloudSection}
    <button class="btn btn-ghost btn-block" id="btn-replay-tutorial" style="margin-bottom:10px;">👋 Revoir le tutoriel</button>
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
  document.querySelectorAll('[data-toggle-vacation]').forEach(el => {
    el.onclick = () => {
      const child = getChild(el.dataset.toggleVacation);
      if (!child) return;
      setVacationMode(child, !child.vacationMode);
      saveData();
      showToast(child.vacationMode ? `${child.name} est en vacances` : `${child.name} n'est plus en vacances`, '🏖️');
      renderSettingsModal();
      render();
    };
  });
  document.querySelectorAll('[data-deduct-points]').forEach(el => {
    el.onclick = () => openDeductPointsModal(el.dataset.deductPoints);
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
  const toggleMonthlyBtn = document.getElementById('btn-toggle-monthly-reward');
  if (toggleMonthlyBtn) toggleMonthlyBtn.onclick = () => {
    state.monthlyRewardEnabled = !state.monthlyRewardEnabled;
    saveData();
    renderSettingsModal();
    render();
  };
  const monthlyAmountInput = document.getElementById('monthly-reward-amount');
  if (monthlyAmountInput) monthlyAmountInput.onchange = () => {
    const amount = Math.max(1, parseInt(monthlyAmountInput.value, 10) || 1);
    state.monthlyRewardAmount = amount;
    saveData();
    render();
  };
  const toggleTeamGoalBtn = document.getElementById('btn-toggle-team-goal');
  if (toggleTeamGoalBtn) toggleTeamGoalBtn.onclick = () => {
    state.teamGoalEnabled = !state.teamGoalEnabled;
    saveData();
    renderSettingsModal();
    render();
  };
  const teamGoalThresholdInput = document.getElementById('team-goal-threshold');
  if (teamGoalThresholdInput) teamGoalThresholdInput.onchange = () => {
    state.teamGoalThreshold = Math.max(1, parseInt(teamGoalThresholdInput.value, 10) || 1);
    saveData();
    render();
  };
  const teamGoalLabelInput = document.getElementById('team-goal-label');
  if (teamGoalLabelInput) teamGoalLabelInput.onchange = () => {
    state.teamGoalLabel = teamGoalLabelInput.value.trim() || 'Une sortie en famille';
    saveData();
    render();
  };
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
  const joinFamilySettingsBtn = document.getElementById('btn-join-family-settings');
  if (joinFamilySettingsBtn) joinFamilySettingsBtn.onclick = () => {
    if (state.children.length === 0){ closeModal(); openJoinFamilyModal(); return; }
    openConfirmModal({
      title: 'Rejoindre une famille existante', danger: true, confirmLabel: 'Continuer',
      body: `Les données actuelles de <strong>cet appareil</strong> seront remplacées par celles de la famille rejointe. Pensez à les exporter avant si besoin.`,
      onConfirm: () => openJoinFamilyModal()
    });
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
  const replayTutorialBtn = document.getElementById('btn-replay-tutorial');
  if (replayTutorialBtn) replayTutorialBtn.onclick = () => openTutorial();
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
