// Zotero PubMed Auto-Tag Addon
// Target: Zotero 7.x

var rootURI;
var notifierID = null;
var addEventHistory = [];

// Custom error to distinguish network/API errors from "not found"
class PubMedNetworkError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PubMedNetworkError';
    }
}

// API Rate Limiting Queue
class RequestQueue {
    constructor() {
        this.queue = [];
        this.running = false;
        this.lastRequestTime = 0;
    }

    get minInterval() {
        const apiKey = Prefs.get('ncbiApiKey');
        return apiKey ? 100 : 350; // APIキーあり: 10req/s, なし: 3req/s
    }

    push(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            this.next();
        });
    }

    async next() {
        if (this.running || this.queue.length === 0) return;
        this.running = true;

        const { task, resolve, reject } = this.queue.shift();
        
        try {
            const now = Date.now();
            const elapsed = now - this.lastRequestTime;
            const waitTime = Math.max(0, this.minInterval - elapsed);
            if (waitTime > 0) {
                await Zotero.Promise.delay(waitTime);
            }
            
            this.lastRequestTime = Date.now();
            const result = await task();
            resolve(result);
        } catch (error) {
            reject(error);
        } finally {
            this.running = false;
            this.next();
        }
    }
}

const apiQueue = new RequestQueue();

// HTTP GET helper using Zotero's API (fetch is not available in the plugin sandbox)
async function httpGet(url, label) {
    let xhr;
    try {
        xhr = await Zotero.HTTP.request('GET', url, { successCodes: false });
    } catch (e) {
        throw new PubMedNetworkError(`Network error from ${label}: ${e.message}`);
    }
    if (xhr.status < 200 || xhr.status >= 300) {
        throw new PubMedNetworkError(`HTTP ${xhr.status} from ${label}`);
    }
    return xhr.responseText;
}

// Preferences Helper
const Prefs = {
    // 第2引数 true (global) がないと extensions.zotero. が前置されてしまう
    get(name) {
        return Zotero.Prefs.get(`extensions.zotero-pubmed-autotag.${name}`, true);
    },
    set(name, value) {
        Zotero.Prefs.set(`extensions.zotero-pubmed-autotag.${name}`, value, true);
    }
};

// Lifecycle Methods
function install() {
    Zotero.debug("PubMed Auto-Tag: Installed");
}

function uninstall() {
    Zotero.debug("PubMed Auto-Tag: Uninstalled");
}

function startup({ id, version, resourceURI, rootURI: rURI }) {
    rootURI = rURI;
    Zotero.debug("PubMed Auto-Tag: Starting up...");
    
    // Register Preferences Pane
    Zotero.PreferencePanes.register({
        pluginID: 'zotero-pubmed-autotag@example.com',
        src: rootURI + 'chrome/content/preferences.xhtml',
        label: 'PubMed Auto-Tag'
    });
    
    // Add menus to existing windows
    let windows = Zotero.getMainWindows();
    for (let win of windows) {
        onMainWindowLoad({ window: win });
    }
    
    // Register Notifier
    registerNotifier();
}

function shutdown() {
    Zotero.debug("PubMed Auto-Tag: Shutting down...");
    
    // Unregister Notifier
    unregisterNotifier();
    
    // Remove menus from windows
    let windows = Zotero.getMainWindows();
    for (let win of windows) {
        onMainWindowUnload({ window: win });
    }
}

// Window Hooks
var menuID = "zotero-pubmed-autotag-menuitem";

function onMainWindowLoad({ window }) {
    let doc = window.document;
    let itemMenu = doc.getElementById("zotero-itemmenu");
    if (itemMenu) {
        if (!doc.getElementById(menuID)) {
            let menuitem = doc.createXULElement("menuitem");
            menuitem.id = menuID;
            menuitem.setAttribute("label", "PubMedタグを取得");
            menuitem.addEventListener("command", function() {
                runManual(window);
            });
            itemMenu.appendChild(menuitem);
        }
    }
}

function onMainWindowUnload({ window }) {
    let doc = window.document;
    let menuitem = doc.getElementById(menuID);
    if (menuitem) {
        menuitem.remove();
    }
}

// Notification Helper
function showNotification(title, text, isError = false, force = false) {
    if (!force && !Prefs.get("notifyOnMissing") && !isError) {
        return;
    }

    let pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PubMed Auto-Tag");
    // Zotero 9 の ItemProgress 第1引数はアイテムタイプ名 (アイコンURLではない)
    let itemProgress = new pw.ItemProgress("journalArticle", title);
    itemProgress.setText(text);
    if (isError) {
        itemProgress.setError();
    } else {
        itemProgress.setProgress(100);
    }
    pw.show();
    pw.startCloseTimer(5000);
}

function notifyImportSkipped() {
    if (!Prefs.get("notifyOnMissing")) return;
    
    let pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PubMed Auto-Tag");
    let itemProgress = new pw.ItemProgress(
        null,
        "大量のアイテム追加を検知しました"
    );
    itemProgress.setText("自動タグ付けをスキップしました。手動で実行してください。");
    itemProgress.setProgress(100);
    pw.show();
    pw.startCloseTimer(8000);
}

// Notifier Event Handling
function registerNotifier() {
    if (notifierID) return;
    
    notifierID = Zotero.Notifier.registerObserver({
        notify: async function(event, type, ids, extraData) {
            if (event === 'add' && type === 'item') {
                if (!Prefs.get("autoRunOnAdd")) return;
                
                // Skip if sync is running
                let syncRunning = false;
                try {
                    if (Zotero.Sync && Zotero.Sync.Runner) {
                        syncRunning = !!Zotero.Sync.Runner.syncInProgress;
                    }
                } catch (e) { /* ignore */ }
                if (syncRunning) {
                    Zotero.debug("PubMed Auto-Tag: Skipped auto-run because Sync is running.");
                    return;
                }
                
                // Burst detection (Sync/Import prevention)
                if (checkBurstAndImport(ids)) {
                    Zotero.debug("PubMed Auto-Tag: Skipped auto-run due to burst detection.");
                    notifyImportSkipped();
                    return;
                }
                
                // Process eligible items
                for (let id of ids) {
                    let item = await Zotero.Items.getAsync(id);
                    if (item && shouldProcessItem(item)) {
                        await processItemAuto(item);
                    }
                }
            }
        }
    }, ['item'], "zotero-pubmed-autotag");
}

function unregisterNotifier() {
    if (notifierID) {
        Zotero.Notifier.unregisterObserver(notifierID);
        notifierID = null;
    }
}

// Burst (Import) Detection
function checkBurstAndImport(ids) {
    if (ids.length > 3) {
        return true;
    }
    
    const now = Date.now();
    addEventHistory = addEventHistory.filter(t => now - t < 1000);
    
    for (let i = 0; i < ids.length; i++) {
        addEventHistory.push(now);
    }
    
    if (addEventHistory.length > 5) {
        return true;
    }
    
    return false;
}

// Item Eligibility Check
function shouldProcessItem(item) {
    // attachment/note は isRegularItem() === false なので弾かれる
    if (!item.isRegularItem()) {
        return false;
    }

    if (item.library && item.library.libraryType === 'feed') {
        return false;
    }

    const itemType = Zotero.ItemTypes.getName(item.itemTypeID);
    
    // preprint: PMID/DOI がある場合のみ対象
    if (itemType === 'preprint') {
        let hasDOI = !!item.getField('DOI');
        let extra = item.getField('extra') || '';
        let hasPMID = /(?:PMID|pmid)\s*:\s*(\d+)/.test(extra);
        return hasDOI || hasPMID;
    }
    
    // journalArticle およびその他の regularItem は対象
    return true;
}

// PMID Location Logic
async function locatePMID(item) {
    // 1. Check Extra field for PMID
    let extra = item.getField('extra') || '';
    let m = extra.match(/(?:PMID|pmid)\s*:\s*(\d+)/);
    if (m) {
        return m[1];
    }
    
    const apiKey = Prefs.get('ncbiApiKey');
    const apiKeyParam = apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : '';
    
    // 2. Search by DOI
    let doi = item.getField('DOI');
    if (doi) {
        const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(doi)}[doi]&retmode=json${apiKeyParam}`;
        // ネットワークエラーは握りつぶさず throw する (NFR-2)
        const resText = await apiQueue.push(() => httpGet(url, "esearch (DOI)"));
        const data = JSON.parse(resText);
        if (data.esearchresult && data.esearchresult.idlist && data.esearchresult.idlist.length > 0) {
            return data.esearchresult.idlist[0];
        }
        // DOI でヒットしなかった場合のみタイトル検索にフォールバック
    }
    
    // 3. Search by Title + Author + Year
    let title = item.getField('title');
    if (title) {
        let creators = item.getCreators();
        let author = '';
        if (creators && creators.length > 0) {
            author = creators[0].lastName || creators[0].firstName || '';
        }
        let date = item.getField('date') || '';
        let yearM = date.match(/\b\d{4}\b/);
        let year = yearM ? yearM[0] : '';
        
        let sanitizedTitle = title.replace(/"/g, '');
        let term = `"${sanitizedTitle}"[title]`;
        if (author) {
            term += ` AND ${author}[author]`;
        }
        if (year) {
            term += ` AND ${year}[pdat]`;
        }
        
        const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(term)}&retmode=json${apiKeyParam}`;
        // ネットワークエラーは throw する (NFR-2)
        const resText = await apiQueue.push(() => httpGet(url, "esearch (title)"));
        const data = JSON.parse(resText);
        if (data.esearchresult && data.esearchresult.idlist && data.esearchresult.idlist.length === 1) {
            return data.esearchresult.idlist[0];
        }
    }
    
    return null;
}

// Fetch Keywords from PubMed and Apply to Item
async function fetchAndApplyKeywords(item, pmid) {
    const apiKey = Prefs.get('ncbiApiKey');
    const apiKeyParam = apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : '';
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml${apiKeyParam}`;
    
    const resXmlText = await apiQueue.push(() => httpGet(url, "efetch"));

    // DOMParser はプラグインサンドボックスに存在しないためメインウィンドウから取得する
    const win = Zotero.getMainWindow();
    const parser = new win.DOMParser();
    const doc = parser.parseFromString(resXmlText, "text/xml");
    
    const parserError = doc.querySelector("parsererror");
    if (parserError) {
        throw new Error("XML parsing error");
    }
    
    const keywordSource = Prefs.get("keywordSource");
    const keywords = new Set();
    
    if (keywordSource === "mesh" || keywordSource === "both") {
        const descriptorNames = doc.querySelectorAll("MeshHeading > DescriptorName");
        for (let desc of descriptorNames) {
            let name = desc.textContent.trim();
            if (name) {
                keywords.add(name);
            }
        }
    }
    
    if (keywordSource === "authorKeywords" || keywordSource === "both") {
        const authorKeywords = doc.querySelectorAll("KeywordList > Keyword");
        for (let kw of authorKeywords) {
            let name = kw.textContent.trim();
            if (name) {
                keywords.add(name);
            }
        }
    }
    
    if (keywords.size === 0) {
        return false;
    }
    
    for (let kw of keywords) {
        item.addTag(kw, 1);
    }
    
    await item.saveTx();
    return keywords.size;
}

// Missing Keywords Handler
async function handleMissing(item, reason, isManual) {
    const missingTagName = Prefs.get("missingTagName") || "#no-pubmed-tags";
    item.addTag(missingTagName, 1);
    await item.saveTx();

    showNotification(item.getField('title'), `PubMedタグ付与スキップ: ${reason}`, false, isManual);
}

// Auto Execution Flow
async function processItemAuto(item) {
    try {
        let pmid = await locatePMID(item);
        if (!pmid) {
            await handleMissing(item, "PMIDが見つかりません", false);
        } else {
            let count = await fetchAndApplyKeywords(item, pmid);
            if (count === false) {
                await handleMissing(item, "キーワードが登録されていません", false);
            }
        }
    } catch (e) {
        // NFR-2: ネットワークエラー時は #no-pubmed-tags を付けない。エラー通知のみ。
        Zotero.debug("PubMed Auto-Tag Auto Error: " + e.message);
        showNotification(item.getField('title'), "エラーが発生しました: " + e.message, true);
    }
}

// Manual Execution Flow
async function runManual(window) {
    let items = window.ZoteroPane.getSelectedItems();
    if (!items || items.length === 0) return;
    
    let pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PubMed Auto-Tag (手動実行)");
    pw.show();
    
    let processedCount = 0;
    let successCount = 0;
    let missingCount = 0;
    let errorCount = 0;
    
    for (let item of items) {
        if (!item.isRegularItem()) continue;
        
        let itemProgress = new pw.ItemProgress(
            Zotero.ItemTypes.getName(item.itemTypeID),
            item.getField('title')
        );
        
        try {
            itemProgress.setText("処理中...");
            let pmid = await locatePMID(item);
            if (!pmid) {
                await handleMissing(item, "PMIDが見つかりません", true);
                itemProgress.setText("PubMed非掲載");
                itemProgress.setError();
                missingCount++;
            } else {
                let count = await fetchAndApplyKeywords(item, pmid);
                if (count === false) {
                    await handleMissing(item, "キーワードが登録されていません", true);
                    itemProgress.setText("キーワードなし");
                    itemProgress.setError();
                    missingCount++;
                } else {
                    itemProgress.setText(`${count}個のタグを付与しました`);
                    itemProgress.setProgress(100);
                    successCount++;
                }
            }
        } catch (e) {
            Zotero.debug("PubMed Auto-Tag Error: " + e.message);
            itemProgress.setText("エラーが発生しました: " + e.message);
            itemProgress.setError();
            errorCount++;
        }
        processedCount++;
    }
    
    pw.addDescription(`完了: 成功 ${successCount} 件, 未掲載 ${missingCount} 件, エラー ${errorCount} 件`);
    pw.startCloseTimer(8000);
}
