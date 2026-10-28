// Browser-local appearance, hand-sorting and alert preferences. Never sent to Render.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CrossmeldPreferences = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const KEY = 'crossmeldPreferences.v2';
  const LEGACY_KEY = 'crossmeldPreferences.v1';
  const DEFAULTS = Object.freeze({autoSortNewTiles:true, showNewTileTags:true, tileNumbers:'pips', colorLabels:false, turnVolume:75, chatVolume:75});
  function clean(value) {
    const obj = value && typeof value==='object' && !Array.isArray(value) ? value : {};
    const volume = (n, fallback) => typeof n==='number' && Number.isFinite(n) ? Math.max(0,Math.min(100,Math.round(n))) : fallback;
    return {
      autoSortNewTiles: typeof obj.autoSortNewTiles==='boolean'?obj.autoSortNewTiles:DEFAULTS.autoSortNewTiles,
      showNewTileTags: typeof obj.showNewTileTags==='boolean'?obj.showNewTileTags:DEFAULTS.showNewTileTags,
      tileNumbers: ['pips','numerals'].includes(obj.tileNumbers)?obj.tileNumbers:DEFAULTS.tileNumbers,
      colorLabels: typeof obj.colorLabels==='boolean'?obj.colorLabels:DEFAULTS.colorLabels,
      turnVolume:volume(obj.turnVolume,DEFAULTS.turnVolume),
      chatVolume:volume(obj.chatVolume,DEFAULTS.chatVolume),
    };
  }
  // The previous slider went from 0–200 and applied linear gain (100 = original).
  // This version uses a 0–100 audio taper, with gain = 4 * (position/100)^2.
  // Convert saved values so existing users retain approximately the same volume.
  function migrateLegacy(saved) {
    const old = saved && typeof saved==='object' && !Array.isArray(saved) ? saved : {};
    const converted = {...old};
    for (const key of ['turnVolume','chatVolume']) {
      if (typeof old[key] === 'number' && Number.isFinite(old[key])) {
        const oldGain = Math.max(0,Math.min(200,old[key]))/100;
        converted[key] = Math.round(100 * Math.sqrt(oldGain/4));
      }
    }
    return clean(converted);
  }
  function load(storage) {
    try {
      const current = storage?.getItem(KEY);
      if (current !== null && current !== undefined) return clean(JSON.parse(current));
      const previous = storage?.getItem(LEGACY_KEY);
      if (previous !== null && previous !== undefined) {
        const migrated = migrateLegacy(JSON.parse(previous));
        try { storage.setItem(KEY,JSON.stringify(migrated)); } catch { /* blocked storage */ }
        return migrated;
      }
    } catch { /* private browsing, invalid JSON, or blocked storage */ }
    return clean(null);
  }
  function save(storage, prefs) {
    const valid = clean(prefs);
    try { storage.setItem(KEY, JSON.stringify(valid)); } catch { /* private mode / storage disabled */ }
    return valid;
  }
  return {KEY,LEGACY_KEY,DEFAULTS,clean,load,save,migrateLegacy};
});
