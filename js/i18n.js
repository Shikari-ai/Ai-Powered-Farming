/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║         AgriTech OS — i18n Localization Engine          ║
 * ║  Realtime multilingual support for all app pages        ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   import { t, setLanguage, getCurrentLang, initI18n } from './i18n.js';
 *
 *   await initI18n();                      // call once per page
 *   t('home.greeting_morning')             // get translation
 *   setLanguage('hi')                      // change language live
 */

const STORAGE_KEY = 'agri_lang';
const FALLBACK_LANG = 'en';

const SUPPORTED_LANGS = [
  { code: 'en',  name: 'English',        nativeName: 'English',       flag: '🇬🇧' },
  { code: 'hi',  name: 'Hindi',          nativeName: 'हिन्दी',         flag: '🇮🇳' },
  { code: 'cht', name: 'Chhattisgarhi',  nativeName: 'छत्तीसगढ़ी',     flag: '🪔' },
  { code: 'mr',  name: 'Marathi',        nativeName: 'मराठी',          flag: '🇮🇳' },
  { code: 'pa',  name: 'Punjabi',        nativeName: 'ਪੰਜਾਬੀ',         flag: '🇮🇳' },
  { code: 'bn',  name: 'Bengali',        nativeName: 'বাংলা',          flag: '🇧🇩' },
  { code: 'ta',  name: 'Tamil',          nativeName: 'தமிழ்',          flag: '🇮🇳' },
  { code: 'te',  name: 'Telugu',         nativeName: 'తెలుగు',         flag: '🇮🇳' },
];

let _currentLang = FALLBACK_LANG;
let _translations = {};
let _fallback     = {};

function _jsonPath(code) {
  const base = document.querySelector('base')?.href || '/';
  return base + 'js/i18n/' + code + '.json?v=1';
}

const _cache = {};
async function _load(code) {
  if (_cache[code]) return _cache[code];
  try {
    const res  = await fetch(_jsonPath(code));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    _cache[code] = data;
    return data;
  } catch (e) {
    console.warn('[i18n] Failed to load "' + code + '", falling back.', e);
    return _cache[FALLBACK_LANG] || {};
  }
}

export function t(key, vars) {
  vars = vars || {};
  const parts = key.split('.');
  let val = parts.reduce(function(o, k) { return (o && o[k] !== undefined) ? o[k] : undefined; }, _translations);
  if (val === undefined) {
    val = parts.reduce(function(o, k) { return (o && o[k] !== undefined) ? o[k] : undefined; }, _fallback);
  }
  if (val === undefined) return key;
  return String(val).replace(/\{\{(\w+)\}\}/g, function(_, k) { return vars[k] !== undefined ? vars[k] : '{{' + k + '}}'; });
}

export function getCurrentLang() { return _currentLang; }
export function getSupportedLangs() { return SUPPORTED_LANGS; }

function _applyToDom() {
  document.querySelectorAll('[data-i18n]').forEach(function(el) {
    const key = el.getAttribute('data-i18n');
    const translated = t(key);
    if (el.childElementCount === 0) {
      el.textContent = translated;
    }
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
  });
  document.querySelectorAll('[data-i18n-title]').forEach(function(el) {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  });
  document.documentElement.lang = _currentLang;
  window.dispatchEvent(new CustomEvent('i18n:updated', { detail: { lang: _currentLang, t: t } }));
}

export async function setLanguage(code, persist) {
  if (persist === undefined) persist = true;
  const supported = SUPPORTED_LANGS.find(function(l) { return l.code === code; });
  if (!supported) {
    console.warn('[i18n] Language "' + code + '" not supported.');
    return false;
  }
  try {
    if (!_fallback || Object.keys(_fallback).length === 0) {
      _fallback = await _load(FALLBACK_LANG);
    }
    _translations = await _load(code);
    _currentLang  = code;
    if (persist) {
      localStorage.setItem(STORAGE_KEY, code);
      _syncToFirestore(code);
    }
    _applyToDom();
    return true;
  } catch (err) {
    console.error('[i18n] setLanguage error:', err);
    return false;
  }
}

async function _syncToFirestore(code) {
  try {
    const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
    const { getFirestore, doc, updateDoc } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const { getApps } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js');
    if (!getApps().length) return;
    const user = getAuth().currentUser;
    if (!user) return;
    await updateDoc(doc(getFirestore(), 'users', user.uid), { language: code });
  } catch (e) { /* silent */ }
}

export async function initI18n() {
  let savedCode = localStorage.getItem(STORAGE_KEY);
  if (!savedCode) {
    const browserLang = (navigator.language || 'en').split('-')[0].toLowerCase();
    const match = SUPPORTED_LANGS.find(function(l) { return l.code === browserLang; });
    savedCode = match ? match.code : FALLBACK_LANG;
  }
  _fallback = await _load(FALLBACK_LANG);
  await setLanguage(savedCode, false);
  _restoreFromFirestore();
}

async function _restoreFromFirestore() {
  try {
    const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
    const { getFirestore, doc, getDoc } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const { getApps } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js');
    if (!getApps().length) return;
    const user = getAuth().currentUser;
    if (!user) return;
    const snap = await getDoc(doc(getFirestore(), 'users', user.uid));
    if (!snap.exists()) return;
    const firestoreLang = snap.data().language;
    if (firestoreLang && firestoreLang !== _currentLang) {
      await setLanguage(firestoreLang, true);
    }
  } catch (e) { /* silent */ }
}

let _observer = null;
export function startI18nObserver() {
  if (_observer) return;
  _observer = new MutationObserver(function(mutations) {
    let needsUpdate = false;
    for (let i = 0; i < mutations.length; i++) {
      if (mutations[i].addedNodes.length) { needsUpdate = true; break; }
    }
    if (needsUpdate) _applyToDom();
  });
  _observer.observe(document.body, { childList: true, subtree: true });
}

// Expose to window for non-module scripts
window.t = t;
window.setLanguage = setLanguage;
window.startI18nObserver = startI18nObserver;

export default { t: t, setLanguage: setLanguage, getCurrentLang: getCurrentLang, getSupportedLangs: getSupportedLangs, initI18n: initI18n, startI18nObserver: startI18nObserver };
