"use strict";

(() => {
  const FORMAT = "trpg-data-file";
  const VERSION = 1;
  const LINK_DATABASE = "trpg-json-file-link";
  const LINK_STORE = "handles";
  const STORAGE_KEYS = [
    "trpg-scenarios",
    "trpg-npc-scenarios",
    "trpg-deleted-scenarios",
    "trpg-pc-character-register",
    "trpg-creator-profiles",
    "trpg-npc-creators",
    "trpg-my-profile",
    "trpg-chat-memories",
    "trpg-profession-options",
    "trpg-audience-view-mode",
    "trpg-character-scenarios-updated",
    "trpg-npc-library",
    "trpg-npc-library-updated",
  ];
  const DATABASES = [
    { name: "trpg-character-library", version: 1, store: "characters" },
    { name: "trpg-npc-library", version: 2, store: "npcs" },
  ];
  const nativeStorage = {
    getItem: Storage.prototype.getItem,
    setItem: Storage.prototype.setItem,
    removeItem: Storage.prototype.removeItem,
  };
  let fileHandle = null;
  let fileName = "";
  let syncing = false;
  let writeTimer = 0;
  let writeQueue = Promise.resolve();
  let panel;
  let status;

  function setStatus(message, error = false) {
    if (!status) return;
    status.textContent = message;
    status.dataset.error = String(error);
    status.hidden = false;
  }

  function openLinkDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(LINK_DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(LINK_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("JSONファイルの接続情報を開けませんでした"));
      request.onblocked = () => reject(new Error("JSONファイルの接続情報が別の画面で使用中です"));
    });
  }

  async function getRememberedHandle() {
    const database = await openLinkDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const request = database.transaction(LINK_STORE, "readonly").objectStore(LINK_STORE).get("active");
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error("JSONファイルの接続情報を読み込めませんでした"));
      });
    } finally {
      database.close();
    }
  }

  async function rememberHandle(handle) {
    const database = await openLinkDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(LINK_STORE, "readwrite");
        transaction.objectStore(LINK_STORE).put(handle, "active");
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("JSONファイルの接続情報を保存できませんでした"));
        transaction.onabort = () => reject(transaction.error || new Error("JSONファイルの接続情報を保存できませんでした"));
      });
    } finally {
      database.close();
    }
  }

  function readLocalStorage() {
    const values = {};
    STORAGE_KEYS.forEach(key => {
      const value = nativeStorage.getItem.call(localStorage, key);
      if (value !== null) values[key] = value;
    });
    return values;
  }

  async function readDatabase(databaseConfig) {
    if (typeof indexedDB.databases === "function") {
      const databases = await indexedDB.databases();
      if (!databases.some(database => database.name === databaseConfig.name)) return [];
    }
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseConfig.name);
      request.onupgradeneeded = () => {
        request.transaction.abort();
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => request.error?.name === "AbortError"
        ? resolve(null)
        : reject(request.error || new Error(`${databaseConfig.name}を読み込めませんでした`));
      request.onblocked = () => reject(new Error(`${databaseConfig.name}が別の画面で使用中です`));
    });
    if (!database) return [];
    try {
      if (!database.objectStoreNames.contains(databaseConfig.store)) return [];
      return await new Promise((resolve, reject) => {
        const request = database.transaction(databaseConfig.store, "readonly").objectStore(databaseConfig.store).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error(`${databaseConfig.name}のデータを読み込めませんでした`));
      });
    } finally {
      database.close();
    }
  }

  async function readBrowserData() {
    const databases = {};
    for (const config of DATABASES) {
      databases[config.name] = await readDatabase(config);
    }
    return { localStorage: readLocalStorage(), indexedDB: databases };
  }

  function readFileData(text) {
    if (!text.trim()) return { format: FORMAT, version: VERSION, localStorage: {}, indexedDB: {} };
    const data = JSON.parse(text);
    if (!data || data.format !== FORMAT || data.version !== VERSION
      || !data.localStorage || typeof data.localStorage !== "object" || Array.isArray(data.localStorage)
      || !data.indexedDB || typeof data.indexedDB !== "object" || Array.isArray(data.indexedDB)) {
      throw new Error("選択したファイルは対応しているTRPGデータJSONではありません");
    }
    if (Object.values(data.localStorage).some(value => typeof value !== "string")
      || Object.values(data.indexedDB).some(records => !Array.isArray(records))) {
      throw new Error("JSON内のデータ形式が正しくありません");
    }
    return data;
  }

  async function applyLocalStorage(values) {
    STORAGE_KEYS.forEach(key => {
      if (Object.prototype.hasOwnProperty.call(values, key) && typeof values[key] === "string") {
        nativeStorage.setItem.call(localStorage, key, values[key]);
      } else {
        nativeStorage.removeItem.call(localStorage, key);
      }
    });
  }

  function replaceDatabase(config, records) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(config.name, config.version);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(config.store)) {
          request.result.createObjectStore(config.store, { keyPath: "id" });
        }
      };
      request.onerror = () => reject(request.error || new Error(`${config.name}を開けませんでした`));
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(config.store)) {
          database.close();
          reject(new Error(`${config.name}/${config.store}が見つかりません`));
          return;
        }
        const transaction = database.transaction(config.store, "readwrite");
        const store = transaction.objectStore(config.store);
        store.clear();
        records.forEach(record => {
          if (record && typeof record.id === "string") store.put(record);
        });
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => {
          database.close();
          reject(transaction.error || new Error(`${config.name}のデータを書き込めませんでした`));
        };
        transaction.onabort = () => {
          database.close();
          reject(transaction.error || new Error(`${config.name}のデータ書き込みが中断されました`));
        };
      };
    });
  }

  async function applyBrowserData(data) {
    syncing = true;
    try {
      await applyLocalStorage(data.localStorage || {});
      for (const config of DATABASES) {
        await replaceDatabase(config, Array.isArray(data.indexedDB?.[config.name]) ? data.indexedDB[config.name] : []);
      }
    } finally {
      syncing = false;
    }
  }

  function mergeRecords(existing, incoming) {
    if (!Array.isArray(existing) || !Array.isArray(incoming)) return incoming;
    if (existing.every(value => typeof value === "string") && incoming.every(value => typeof value === "string")) {
      return [...new Set([...existing, ...incoming])];
    }
    const records = new Map();
    [...existing, ...incoming].forEach((item, index) => {
      const key = item && typeof item === "object"
        ? item.id || item.title || item.name || `__record_${index}`
        : `__value_${String(item)}`;
      const previous = records.get(key);
      if (!previous || (Number(item?.updatedAt) || 0) >= (Number(previous.updatedAt) || 0)) records.set(key, item);
    });
    return [...records.values()];
  }

  function mergeBrowserData(fileData, browserData) {
    const merged = {
      format: FORMAT,
      version: VERSION,
      localStorage: { ...fileData.localStorage },
      indexedDB: { ...fileData.indexedDB },
    };
    Object.entries(browserData.localStorage).forEach(([key, value]) => {
      const existingValue = merged.localStorage[key];
      if (existingValue === undefined) {
        merged.localStorage[key] = value;
        return;
      }
      try {
        merged.localStorage[key] = JSON.stringify(mergeRecords(JSON.parse(existingValue), JSON.parse(value)));
      } catch {
        merged.localStorage[key] = value;
      }
    });
    Object.entries(browserData.indexedDB).forEach(([databaseName, records]) => {
      merged.indexedDB[databaseName] = mergeRecords(merged.indexedDB[databaseName] || [], records);
    });
    return merged;
  }

  async function writeFileData(data) {
    if (!fileHandle) throw new Error("JSONファイルが選択されていません");
    let permission = await fileHandle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") permission = await fileHandle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") throw new Error("JSONファイルへの書き込みが許可されませんでした");
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(`${JSON.stringify(data, null, 2)}\n`);
      await writable.close();
    } catch (error) {
      await writable.abort();
      throw error;
    }
  }

  function scheduleWrite() {
    if (!fileHandle || syncing) return;
    setStatus("変更をJSONへ保存中…");
    window.clearTimeout(writeTimer);
    writeTimer = window.setTimeout(() => {
      writeQueue = writeQueue.then(async () => {
        const snapshot = await readBrowserData();
        const data = { format: FORMAT, version: VERSION, ...snapshot };
        await writeFileData(data);
        setStatus(`JSONへ保存しました: ${fileName}`);
      }).catch(error => setStatus(`JSONへの保存に失敗しました: ${error.message}`, true));
    }, 250);
  }

  function installStorageHooks() {
    Storage.prototype.setItem = function (key, value) {
      nativeStorage.setItem.call(this, key, value);
      if (this === localStorage && STORAGE_KEYS.includes(String(key))) scheduleWrite();
    };
    Storage.prototype.removeItem = function (key) {
      nativeStorage.removeItem.call(this, key);
      if (this === localStorage && STORAGE_KEYS.includes(String(key))) scheduleWrite();
    };
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const result = transaction.apply(this, args);
      if (args[1] === "readwrite" && DATABASES.some(database => database.name === this.name)) {
        result.addEventListener("complete", scheduleWrite, { once: true });
      }
      return result;
    };
  }

  function setConnectedUi() {
    document.getElementById("trpg-json-storage-toggle").textContent = "JSON接続中: 切替";
    document.getElementById("trpg-json-status").textContent = `JSON同期中: ${fileName}`;
    setStatus(`接続しました: ${fileName}`);
  }

  function installPanel() {
    if (document.getElementById("trpg-json-storage-panel")) return;
    const style = document.createElement("style");
    style.textContent = `
      #trpg-json-storage-panel{position:fixed;right:12px;bottom:12px;z-index:99999;font:12px/1.5 "Yu Gothic UI",Meiryo,sans-serif;color:#242a26}
      #trpg-json-storage-panel button{font:inherit;cursor:pointer}
      #trpg-json-storage-toggle{padding:8px 12px;border:1px solid #28634e;border-radius:4px;background:#fffefa;color:#1c493a;box-shadow:0 3px 12px #0002}
      #trpg-json-storage-dialog{position:fixed;inset:0;z-index:100000;display:none;place-items:center;padding:20px;background:#242a2680}
      #trpg-json-storage-dialog[data-open="true"]{display:grid}
      #trpg-json-storage-card{width:min(100%,480px);padding:22px;border:1px solid #deded3;border-radius:5px;background:#fffefa;box-shadow:0 12px 40px #0003}
      #trpg-json-storage-card h2{margin:0 0 10px;font-size:19px}
      #trpg-json-storage-card p{margin:8px 0;color:#555e56;line-height:1.8}
      #trpg-json-storage-card .actions{display:grid;gap:8px;margin-top:16px}
      #trpg-json-storage-card button{min-height:38px;padding:7px 10px;border:1px solid #deded3;border-radius:3px;background:#fff;color:#242a26;text-align:left}
      #trpg-json-storage-card button:hover{background:#f4f6f0}
      #trpg-json-storage-card [data-action="close"]{float:right;min-height:30px}
      #trpg-json-status{max-width:min(90vw,420px);margin-top:5px;padding:6px 9px;border-radius:3px;background:#fffefa;box-shadow:0 2px 8px #0002;font-size:11px}
      #trpg-json-status[data-error="true"]{color:#a54234}
      #trpg-json-startup{position:fixed;inset:0;z-index:100001;display:none;place-items:center;background:#f2efe7;color:#242a26;font:14px "Yu Gothic UI",Meiryo,sans-serif}
      #trpg-json-startup[data-open="true"]{display:grid}
      #trpg-json-startup div{max-width:420px;padding:24px;text-align:center}
    `;
    document.head.append(style);
    const wrapper = document.createElement("aside");
    wrapper.id = "trpg-json-storage-panel";
    wrapper.innerHTML = `
      <button id="trpg-json-storage-toggle" type="button">JSONデータを接続</button>
      <div id="trpg-json-status" role="status" aria-live="polite" hidden></div>
      <div id="trpg-json-storage-dialog" role="dialog" aria-modal="true" aria-labelledby="trpg-json-dialog-title" data-open="false">
        <section id="trpg-json-storage-card">
          <button type="button" data-action="close" aria-label="閉じる">閉じる</button>
          <h2 id="trpg-json-dialog-title">JSONデータファイル</h2>
          <p>同じJSONファイルを各ページで選択すると、ページ間でデータを共有できます。初回はブラウザーの許可が必要です。</p>
          <p>OneDrive等でJSONを同期する場合、複数のページ・PCで同時に編集すると更新が競合することがあります。保存完了を確認してから別の画面で編集してください。</p>
          <div class="actions">
            <button type="button" data-action="load">JSONを選択して読み込む</button>
            <button type="button" data-action="merge">現在のブラウザーデータを既存JSONへ統合</button>
            <button type="button" data-action="create">新しいJSONを作成して現在のデータを移行</button>
          </div>
        </section>
      </div>
      <div id="trpg-json-startup" data-open="false"><div>JSONデータを確認しています…<br>この間はページを操作しないでください。</div></div>
    `;
    document.body.append(wrapper);
    panel = wrapper.querySelector("#trpg-json-storage-dialog");
    status = wrapper.querySelector("#trpg-json-status");
    wrapper.querySelector("#trpg-json-storage-toggle").addEventListener("click", () => {
      panel.dataset.open = "true";
    });
    wrapper.querySelector('[data-action="close"]').addEventListener("click", () => {
      panel.dataset.open = "false";
    });
    wrapper.querySelector('[data-action="load"]').addEventListener("click", loadSelectedFile);
    wrapper.querySelector('[data-action="merge"]').addEventListener("click", mergeIntoSelectedFile);
    wrapper.querySelector('[data-action="create"]').addEventListener("click", createFromBrowser);
  }

  async function readSelectedFile(handle) {
    const file = await handle.getFile();
    const text = await file.text();
    return readFileData(text);
  }

  async function setHandle(handle) {
    await rememberHandle(handle);
    fileHandle = handle;
    fileName = handle.name;
    setConnectedUi();
  }

  async function loadSelectedFile() {
    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [{ description: "TRPGデータJSON", accept: { "application/json": [".json"] } }],
      });
      await setHandle(handle);
      const data = await readSelectedFile(handle);
      await applyBrowserData(data);
      window.location.reload();
    } catch (error) {
      if (error.name !== "AbortError") setStatus(`JSONを読み込めませんでした: ${error.message}`, true);
    }
  }

  async function mergeIntoSelectedFile() {
    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [{ description: "TRPGデータJSON", accept: { "application/json": [".json"] } }],
      });
      await setHandle(handle);
      const fileData = await readSelectedFile(handle);
      const browserData = await readBrowserData();
      const merged = mergeBrowserData(fileData, browserData);
      await writeFileData(merged);
      await applyBrowserData(merged);
      setStatus(`現在のブラウザーデータを統合しました: ${fileName}`);
      window.location.reload();
    } catch (error) {
      if (error.name !== "AbortError") setStatus(`データを統合できませんでした: ${error.message}`, true);
    }
  }

  async function createFromBrowser() {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: "TRPGデータ.json",
        types: [{ description: "TRPGデータJSON", accept: { "application/json": [".json"] } }],
      });
      await setHandle(handle);
      const snapshot = await readBrowserData();
      await writeFileData({ format: FORMAT, version: VERSION, ...snapshot });
      setStatus(`ブラウザーデータをJSONへ移行しました: ${fileName}`);
      window.location.reload();
    } catch (error) {
      if (error.name !== "AbortError") setStatus(`JSONを作成できませんでした: ${error.message}`, true);
    }
  }

  async function restoreRememberedFile() {
    const startup = document.getElementById("trpg-json-startup");
    if (!startup) return;
    try {
      const handle = await getRememberedHandle();
      if (!handle) return;
      let permission = await handle.queryPermission({ mode: "readwrite" });
      if (permission !== "granted") {
        setStatus("JSONファイルへのアクセス許可が必要です。ボタンから再接続してください", true);
        return;
      }
      startup.dataset.open = "true";
      syncing = true;
      window.clearTimeout(writeTimer);
      fileHandle = handle;
      fileName = handle.name;
      const fileData = await readSelectedFile(handle);
      try {
        await applyBrowserData(fileData);
      } finally {
        syncing = false;
      }
      setConnectedUi();
    } catch (error) {
      setStatus(`JSONファイルを確認できませんでした: ${error.message}`, true);
    } finally {
      syncing = false;
      startup.dataset.open = "false";
    }
  }

  installStorageHooks();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      installPanel();
      restoreRememberedFile();
    }, { once: true });
  } else {
    installPanel();
    restoreRememberedFile();
  }
})();
